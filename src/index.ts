import { Bot, Context, webhookCallback, InlineKeyboard, Keyboard, InputFile } from "grammy";
import { encode as qrEncode } from "uqr";

// ======================= Types & Interfaces =======================

export interface Env {
    ceevents_db: D1Database;
    DB?: D1Database; // For backwards compatibility with older wrangler.toml
    BOT_TOKEN: string;
    SUPER_ADMIN_ID: string;
    SCAN_SECRET?: string; // password for the /scan page
}

interface UserState {
    step: string;
    data: any;
}

export interface MyContext extends Context {
    env: Env;
    db: D1Database;
    wait: (p: Promise<unknown>) => void; // ctx.waitUntil wrapper (for long jobs such as broadcast)
}

// ======================= Small helpers =======================

const HTML = { parse_mode: "HTML" as const };

/** Escape user-provided text for Telegram HTML parse mode. */
function esc(s: unknown): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Persian / Arabic digits -> English digits. */
function toEnDigits(s: string): string {
    return s
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function csvCell(v: unknown): string {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
}

/**
 * editMessageText that never explodes:
 *  - if the source message is a photo / can't be edited -> delete it and send a new message
 *  - if the text did not change -> ignore
 */
async function editOrReply(ctx: MyContext, text: string, extra: any = {}) {
    try {
        await ctx.editMessageText(text, extra);
    } catch (e: any) {
        const d = String(e?.description || e?.message || "");
        if (d.includes("message is not modified")) return;
        if (ctx.callbackQuery) await ctx.deleteMessage().catch(() => {});
        await ctx.reply(text, extra);
    }
}

// ======================= Database & State Helpers =======================

function getDb(ctx: MyContext): D1Database {
    return ctx.db;
}

async function setUserState(ctx: MyContext, userId: number, step: string, data: any = {}) {
    const state: UserState = { step, data };
    await getDb(ctx)
        .prepare("INSERT OR REPLACE INTO user_states (user_id, state) VALUES (?, ?)")
        .bind(userId, JSON.stringify(state))
        .run();
}

async function getUserState(ctx: MyContext, userId: number): Promise<UserState | null> {
    const result = await getDb(ctx)
        .prepare("SELECT state FROM user_states WHERE user_id = ?")
        .bind(userId)
        .first<{ state: string }>();
    return result ? JSON.parse(result.state) : null;
}

async function clearUserState(ctx: MyContext, userId: number) {
    await getDb(ctx).prepare("DELETE FROM user_states WHERE user_id = ?").bind(userId).run();
}

async function isAdmin(ctx: MyContext, userId: number): Promise<boolean> {
    if (userId.toString() === ctx.env.SUPER_ADMIN_ID) return true;
    const admin = await getDb(ctx)
        .prepare("SELECT role FROM users WHERE telegram_id = ? AND role IN ('admin', 'super_admin')")
        .bind(userId)
        .first();
    return !!admin;
}

async function isSuperAdmin(ctx: MyContext, userId: number): Promise<boolean> {
    return userId.toString() === ctx.env.SUPER_ADMIN_ID;
}

async function getAllAdminIds(ctx: MyContext): Promise<number[]> {
    const { results } = await getDb(ctx)
        .prepare("SELECT telegram_id FROM users WHERE role = 'admin'")
        .all<{ telegram_id: number }>();

    const ids = new Set<number>();
    if (ctx.env.SUPER_ADMIN_ID) ids.add(parseInt(ctx.env.SUPER_ADMIN_ID, 10));
    if (results) {
        for (const r of results) ids.add(r.telegram_id);
    }
    return Array.from(ids);
}

async function getRemainingCapacity(ctx: MyContext, eventId: number | string): Promise<{ remaining: number; capacity: number; approved: number }> {
    const ev = await getDb(ctx)
        .prepare("SELECT capacity FROM events WHERE id = ?")
        .bind(eventId)
        .first<{ capacity: number }>();

    if (!ev) return { remaining: 0, capacity: 0, approved: 0 };

    const regCount = await getDb(ctx)
        .prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'")
        .bind(eventId)
        .first<{ count: number }>();

    const approved = regCount?.count || 0;
    return {
        capacity: ev.capacity,
        approved,
        remaining: Math.max(0, ev.capacity - approved),
    };
}

// ======================= QR code -> PNG (no canvas needed) =======================

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream("deflate"); // zlib-wrapped, as PNG requires
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

async function qrToPng(text: string, scale = 10, margin = 4): Promise<Uint8Array> {
    const qr = qrEncode(text, { ecc: "M" });
    const matrix: boolean[][] = qr.data;
    const n = matrix.length;
    const size = (n + margin * 2) * scale;

    // 8-bit grayscale, filter byte 0 at the start of each row
    const raw = new Uint8Array((size + 1) * size).fill(255);
    for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0;
    for (let my = 0; my < n; my++) {
        for (let mx = 0; mx < n; mx++) {
            if (!matrix[my][mx]) continue;
            for (let dy = 0; dy < scale; dy++) {
                const rowStart = ((my + margin) * scale + dy) * (size + 1) + 1 + (mx + margin) * scale;
                raw.fill(0, rowStart, rowStart + scale);
            }
        }
    }

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, size);
    dv.setUint32(4, size);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 0; // grayscale

    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", await zlibDeflate(raw)),
        pngChunk("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        png.set(p, off);
        off += p.length;
    }
    return png;
}

function newToken(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Creates the ticket token (once) for an approved registration and sends the QR image to the user. */
async function issueAndSendQr(ctx: MyContext, eventId: string | number, userId: number) {
    const db = getDb(ctx);

    // keep the old token if it exists: re-approval must never create a second ticket
    await db
        .prepare("UPDATE registrations SET qr_token = COALESCE(qr_token, ?) WHERE event_id = ? AND telegram_id = ?")
        .bind(newToken(), eventId, userId)
        .run();

    const reg = await db
        .prepare("SELECT qr_token, checked_in_at FROM registrations WHERE event_id = ? AND telegram_id = ?")
        .bind(eventId, userId)
        .first<{ qr_token: string; checked_in_at: string | null }>();
    const ev = await db.prepare("SELECT title, event_date FROM events WHERE id = ?").bind(eventId).first<any>();
    if (!reg?.qr_token) return;

    const png = await qrToPng(reg.qr_token);
    const caption =
        `🎫 <b>بلیت ورود: ${esc(ev?.title)}</b>\n` +
        `🗓 ${esc(ev?.event_date)}\n\n` +
        `این QR را روز رویداد هنگام ورود نشان دهید.\n` +
        `⚠️ هر کد فقط <b>یک‌بار</b> قابل استفاده است؛ آن را برای کسی ارسال نکنید.` +
        (reg.checked_in_at ? `\n\n❗️ این بلیت قبلاً استفاده شده است.` : "");

    await ctx.api.sendPhoto(userId, new InputFile(png, `ticket_${eventId}.png`), { caption, ...HTML });
}

// ======================= User Flow & UI =======================

async function sendMainMenu(ctx: MyContext) {
    const fromId = ctx.from!.id;
    const userIsAdmin = await isAdmin(ctx, fromId);

    const kb = new InlineKeyboard()
        .text("📅 لیست رویدادهای فعال", "list_events").row()
        .text("📝 رویدادهای من", "my_registrations");

    if (userIsAdmin) {
        kb.row().text("⚙️ پنل مدیریت", "admin_panel");
    }

    const text = "سلام! به ربات رویدادهای علمی دانشکده مهندسی کامپیوتر خوش آمدید 🎓\nیکی از گزینه‌های زیر را انتخاب کنید:";

    if (ctx.callbackQuery) {
        await editOrReply(ctx, text, { reply_markup: kb });
    } else {
        await ctx.reply(text, { reply_markup: kb });
    }
}

async function showEventDetails(ctx: MyContext, eventId: string | number) {
    const ev = await getDb(ctx)
        .prepare("SELECT * FROM events WHERE id = ?")
        .bind(eventId)
        .first<any>();

    if (!ev) {
        return ctx.reply("❌ رویداد مورد نظر یافت نشد.");
    }

    const { remaining, capacity } = await getRemainingCapacity(ctx, ev.id);

    let caption = `📌 <b>${esc(ev.title)}</b>\n\n`;
    caption += `${esc(ev.description)}\n\n`;
    caption += `🗓 <b>زمان برگزاری:</b> ${esc(ev.event_date)}\n`;
    caption += `📍 <b>نوع برگزاری:</b> ${ev.format_type === "in_person" ? `حضوری (${esc(ev.location_or_link || "دانشکده")})` : `آنلاین`}\n`;
    caption += `👥 <b>ظرفیت باقی‌مانده:</b> ${remaining > 0 ? `${remaining} از ${capacity}` : "❌ تکمیل ظرفیت"}\n`;
    caption += `💰 <b>هزینه ثبت‌نام:</b> ${ev.event_type === "free" ? "🟢 رایگان" : `💳 ${Number(ev.price).toLocaleString("fa-IR")} تومان`}\n`;

    const kb = new InlineKeyboard();
    if (ev.status === "active" && remaining > 0) {
        kb.text("✍️ ثبت‌نام در این رویداد", `register_${ev.id}`).row();
    } else if (ev.status !== "active") {
        caption += `\n⚠️ <i>این رویداد به پایان رسیده یا متوقف شده است.</i>`;
    }
    kb.text("🔙 بازگشت به لیست", "list_events");

    if (ev.poster_file_id) {
        if (caption.length <= 1024) {
            await ctx.replyWithPhoto(ev.poster_file_id, { caption, ...HTML, reply_markup: kb });
        } else {
            // Telegram photo captions are limited to 1024 chars
            await ctx.replyWithPhoto(ev.poster_file_id);
            await ctx.reply(caption, { ...HTML, reply_markup: kb });
        }
    } else {
        await ctx.reply(caption, { ...HTML, reply_markup: kb });
    }
}

async function proceedToRegistrationOrProfile(ctx: MyContext, eventId: number | string, userId: number) {
    const user = await getDb(ctx)
        .prepare("SELECT full_name, phone, identifier, user_type FROM users WHERE telegram_id = ?")
        .bind(userId)
        .first<any>();

    if (!user || !user.full_name || !user.phone || !user.identifier || !user.user_type) {
        await setUserState(ctx, userId, "reg_choose_type", { eventId });
        const kb = new InlineKeyboard()
            .text("🎓 دانشجوی دانشگاه اصفهان", "type_ui").row()
            .text("🌐 سایر", "type_other");
        return ctx.reply("📝 جهت ادامه ثبت‌نام، لطفاً ابتدا نوع مخاطب خود را انتخاب کنید:", { reply_markup: kb });
    }

    await finalizeRegistration(ctx, eventId, userId);
}

async function finalizeRegistration(ctx: MyContext, eventId: string | number, userId: number) {
    const ev = await getDb(ctx)
        .prepare("SELECT * FROM events WHERE id = ?")
        .bind(eventId)
        .first<any>();

    if (!ev) return ctx.reply("رویداد یافت نشد.");
    if (ev.status !== "active") return ctx.reply("⚠️ ثبت‌نام این رویداد بسته شده است.");

    const { remaining } = await getRemainingCapacity(ctx, eventId);
    if (remaining <= 0) {
        return ctx.reply("❌ متأسفانه ظرفیت این رویداد تکمیل شده است.");
    }

    if (ev.event_type === "free") {
        // Atomic: the row is inserted only if there is still room (no over-booking on races)
        const ins = await getDb(ctx)
            .prepare(`
        INSERT INTO registrations (event_id, telegram_id, status)
        SELECT ?, ?, 'approved'
        WHERE (SELECT COUNT(*) FROM registrations WHERE event_id = ? AND status = 'approved')
              < (SELECT capacity FROM events WHERE id = ?)
        ON CONFLICT(event_id, telegram_id) DO UPDATE SET status = 'approved', created_at = CURRENT_TIMESTAMP
      `)
            .bind(eventId, userId, eventId, eventId)
            .run();

        if (ins.meta.changes === 0) {
            return ctx.reply("❌ متأسفانه ظرفیت این رویداد تکمیل شده است.");
        }

        let successMsg = `🎉 ثبت‌نام شما در رویداد <b>${esc(ev.title)}</b> با موفقیت تأیید شد!\n\n`;
        successMsg += `🗓 <b>تاریخ:</b> ${esc(ev.event_date)}\n`;
        if (ev.format_type === "in_person") {
            successMsg += `📍 <b>مکان:</b> ${esc(ev.location_or_link || "دانشکده کامپیوتر")}\n`;
        } else {
            successMsg += `🔗 <b>لینک ورود به جلسه:</b> ${esc(ev.location_or_link || "قبل از جلسه ارسال می‌شود")}\n`;
        }

        await ctx.reply(successMsg, {
            ...HTML,
            reply_markup: new InlineKeyboard().text("🔙 منوی اصلی", "main_menu"),
        });

        try {
            await issueAndSendQr(ctx, eventId, userId);
        } catch (e) {
            console.error("QR send failed", e);
            await ctx.reply("⚠️ ارسال QR با خطا مواجه شد. از بخش «رویدادهای من» می‌توانید دوباره آن را دریافت کنید.");
        }
    } else {
        const cardSetting = await getDb(ctx)
            .prepare("SELECT value FROM settings WHERE key = 'card_info'")
            .first<{ value: string }>();

        await setUserState(ctx, userId, "reg_wait_receipt", { eventId });

        let msg = `💳 <b>پرداخت هزینه رویداد: ${esc(ev.title)}</b>\n\n`;
        msg += `مبلغ قابل پرداخت: <b>${Number(ev.price).toLocaleString("fa-IR")} تومان</b>\n`;
        msg += `اطلاعات واریز:\n<code>${esc(cardSetting?.value || "شماره کارت تنظیم نشده است.")}</code>\n\n`;
        msg += `⚠️ لطفاً پس از واریز، <b>تصویر رسید / فیش پرداخت</b> خود را در همین قسمت ارسال کنید.`;

        await ctx.reply(msg, HTML);
    }
}

// ======================= Admin: event detail renderer =======================

async function renderAdminEventDetail(ctx: MyContext, eventId: string | number) {
    const ev = await getDb(ctx).prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<any>();
    if (!ev) {
        await ctx.answerCallbackQuery({ text: "یافت نشد!" });
        return;
    }

    const { capacity, approved, remaining } = await getRemainingCapacity(ctx, eventId);
    const checked = await getDb(ctx)
        .prepare("SELECT COUNT(*) as c FROM registrations WHERE event_id = ? AND status = 'approved' AND checked_in_at IS NOT NULL")
        .bind(eventId)
        .first<{ c: number }>();
    const deepLink = `https://t.me/${ctx.me.username}?start=event_${ev.id}`;

    let text = `⚙️ <b>مدیریت رویداد: ${esc(ev.title)}</b>\n\n`;
    text += `🔗 <b>لینک ثبت‌نام مستقیم:</b>\n<code>${deepLink}</code>\n\n`;
    text += `📊 <b>ظرفیت کل:</b> ${capacity}\n`;
    text += `✅ <b>تأیید شده:</b> ${approved}\n`;
    text += `🚪 <b>وارد شده (اسکن QR):</b> ${checked?.c || 0}\n`;
    text += `👥 <b>باقی‌مانده:</b> ${remaining}\n`;
    text += `وضعیت: ${ev.status === "active" ? "🟢 در حال ثبت‌نام" : "🔴 بسته شده"}\n`;

    const kb = new InlineKeyboard()
        .text("📊 دانلود لیست (اکسل/CSV)", `adm_ev_export_${ev.id}`).row()
        .text("📢 ارسال پیام همگانی", `adm_ev_broadcast_${ev.id}`).row()
        .text("🔢 تغییر ظرفیت", `adm_ev_editcap_${ev.id}`)
        .text(ev.status === "active" ? "🔴 بستن رویداد" : "🟢 بازگشایی رویداد", `adm_ev_toggle_${ev.id}`).row()
        .text("🗑 حذف کامل رویداد", `adm_ev_delete_${ev.id}`).row()
        .text("🔙 لیست رویدادها", "adm_manage_events");

    await editOrReply(ctx, text, { reply_markup: kb, ...HTML });
}

// ======================= Bot Setup & Routes =======================

export function createBot(token: string, env: Env, execCtx?: ExecutionContext) {
    const bot = new Bot<MyContext>(token);

    bot.use(async (ctx, next) => {
        ctx.env = env;
        ctx.db = env.ceevents_db || env.DB!;
        ctx.wait = (p: Promise<unknown>) => {
            if (execCtx) execCtx.waitUntil(p);
            else void p;
        };
        await next();
    });

    // Never let a handler error bubble up: otherwise Telegram keeps retrying the same update.
    bot.catch((err) => {
        console.error("Bot error:", err.error);
    });

    // Start & Deep Linking
    bot.command("start", async (ctx) => {
        const fromId = ctx.from!.id;
        const startPayload = ctx.match;

        await getDb(ctx)
            .prepare(`
        INSERT INTO users (telegram_id, username, role) 
        VALUES (?, ?, ?) 
        ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username
      `)
            .bind(
                fromId,
                ctx.from?.username || "",
                fromId.toString() === ctx.env.SUPER_ADMIN_ID ? "super_admin" : "student"
            )
            .run();

        await clearUserState(ctx, fromId);

        const m = /^event_(\d+)$/.exec(startPayload || "");
        if (m) {
            return showEventDetails(ctx, m[1]);
        }

        await sendMainMenu(ctx);
    });

    // Main list
    bot.callbackQuery("list_events", async (ctx) => {
        await ctx.answerCallbackQuery();
        const { results } = await getDb(ctx)
            .prepare("SELECT * FROM events WHERE status = 'active' ORDER BY id DESC")
            .all();

        if (!results || results.length === 0) {
            const kb = new InlineKeyboard().text("🔙 بازگشت", "main_menu");
            return editOrReply(ctx, "در حال حاضر هیچ رویداد فعالی وجود ندارد.", { reply_markup: kb });
        }

        const kb = new InlineKeyboard();
        for (const ev of results as any[]) {
            const typeText = ev.event_type === "free" ? "🟢 رایگان" : `💰 ${Number(ev.price).toLocaleString("fa-IR")} ت`;
            kb.text(`${ev.title} (${typeText})`, `view_ev_${ev.id}`).row();
        }
        kb.text("🔙 بازگشت به منوی اصلی", "main_menu");

        await editOrReply(ctx, "📋 <b>لیست رویدادهای فعال:</b>\nجهت مشاهده اطلاعات کامل و ثبت‌نام، روی رویداد مورد نظر کلیک کنید:", {
            reply_markup: kb,
            ...HTML,
        });
    });

    bot.callbackQuery(/^view_ev_(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await showEventDetails(ctx, ctx.match[1]);
    });

    // Start Register Process
    bot.callbackQuery(/^register_(\d+)$/, async (ctx) => {
        const eventId = ctx.match[1];
        const userId = ctx.from!.id;

        const existing = await getDb(ctx)
            .prepare("SELECT status FROM registrations WHERE event_id = ? AND telegram_id = ?")
            .bind(eventId, userId)
            .first<any>();

        if (existing && existing.status === "approved") {
            return ctx.answerCallbackQuery({ text: "✅ شما قبلاً در این رویداد ثبت‌نام کرده‌اید.", show_alert: true });
        }
        if (existing && existing.status === "pending") {
            return ctx.answerCallbackQuery({ text: "⏳ فیش واریزی شما در انتظار تأیید ادمین است.", show_alert: true });
        }

        await ctx.answerCallbackQuery();
        await proceedToRegistrationOrProfile(ctx, eventId, userId);
    });

    // Profile Type Select
    bot.callbackQuery(/^type_(ui|other)$/, async (ctx) => {
        const type = ctx.match[1] === "ui" ? "ui_student" : "other";
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);

        if (!state || state.step !== "reg_choose_type") {
            return ctx.answerCallbackQuery({ text: "نشست منقضی شد؛ لطفاً دوباره از ابتدا ثبت‌نام کنید.", show_alert: true });
        }

        await getDb(ctx)
            .prepare("UPDATE users SET user_type = ? WHERE telegram_id = ?")
            .bind(type, userId)
            .run();

        await setUserState(ctx, userId, "reg_get_fullname", state.data);
        await editOrReply(ctx, "✏️ لطفاً <b>نام و نام خانوادگی</b> کامل خود را به فارسی ارسال کنید:", HTML);
        await ctx.answerCallbackQuery();
    });

    // User Registrations & Cancellation
    bot.callbackQuery("my_registrations", async (ctx) => {
        await ctx.answerCallbackQuery();
        const userId = ctx.from!.id;
        const { results } = await getDb(ctx)
            .prepare(`
        SELECT e.id as event_id, e.title, e.event_date, r.status, r.checked_in_at
        FROM registrations r 
        JOIN events e ON r.event_id = e.id 
        WHERE r.telegram_id = ? AND r.status != 'canceled'
        ORDER BY r.id DESC
      `)
            .bind(userId)
            .all<any>();

        if (!results || results.length === 0) {
            const kb = new InlineKeyboard().text("🔙 بازگشت", "main_menu");
            return editOrReply(ctx, "شما در حال حاضر در هیچ رویدادی ثبت‌نام فعال ندارید.", { reply_markup: kb });
        }

        const kb = new InlineKeyboard();
        let text = "📋 <b>لیست ثبت‌نام‌های شما:</b>\n\n";

        for (const item of results) {
            let statusText = "⏳ در انتظار بررسی فیش";
            if (item.status === "approved") statusText = item.checked_in_at ? "✅ تأیید شده (ورود ثبت شده)" : "✅ تأیید شده";
            if (item.status === "rejected") statusText = "❌ فیش رد شده";

            text += `🔹 <b>${esc(item.title)}</b>\n🗓 تاریخ: ${esc(item.event_date)}\nوضعیت: ${statusText}\n\n`;

            if (item.status === "approved") {
                kb.text(`🎫 دریافت QR: ${item.title}`, `my_qr_${item.event_id}`).row();
            }
            if (!item.checked_in_at) {
                kb.text(`❌ لغو ثبت‌نام: ${item.title}`, `cancel_reg_${item.event_id}`).row();
            }
        }
        kb.text("🔙 بازگشت به منوی اصلی", "main_menu");

        await editOrReply(ctx, text, { reply_markup: kb, ...HTML });
    });

    // Re-send ticket
    bot.callbackQuery(/^my_qr_(\d+)$/, async (ctx) => {
        const eventId = ctx.match[1];
        const userId = ctx.from!.id;
        const reg = await getDb(ctx)
            .prepare("SELECT status FROM registrations WHERE event_id = ? AND telegram_id = ?")
            .bind(eventId, userId)
            .first<any>();

        if (reg?.status !== "approved") {
            return ctx.answerCallbackQuery({ text: "ثبت‌نام تأییدشده‌ای ندارید.", show_alert: true });
        }
        await ctx.answerCallbackQuery();
        try {
            await issueAndSendQr(ctx, eventId, userId);
        } catch (e) {
            console.error("QR resend failed", e);
            await ctx.reply("⚠️ ارسال QR با خطا مواجه شد. چند لحظه بعد دوباره تلاش کنید.");
        }
    });

    bot.callbackQuery(/^cancel_reg_(\d+)$/, async (ctx) => {
        const eventId = ctx.match[1];
        const kb = new InlineKeyboard()
            .text("بله، لغو شود", `confirm_cancel_${eventId}`)
            .text("انصراف", "my_registrations");

        await editOrReply(ctx, "⚠️ آیا از لغو ثبت‌نام در این رویداد اطمینان دارید؟ (در صورت لغو، ظرفیت برای سایرین آزاد می‌شود و QR شما باطل می‌شود)", { reply_markup: kb });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^confirm_cancel_(\d+)$/, async (ctx) => {
        const eventId = ctx.match[1];
        const userId = ctx.from!.id;

        const res = await getDb(ctx)
            .prepare("UPDATE registrations SET status = 'canceled' WHERE event_id = ? AND telegram_id = ? AND checked_in_at IS NULL")
            .bind(eventId, userId)
            .run();

        if (res.meta.changes === 0) {
            return ctx.answerCallbackQuery({ text: "امکان لغو وجود ندارد (ورود شما قبلاً ثبت شده است).", show_alert: true });
        }

        await editOrReply(ctx, "✅ ثبت‌نام شما با موفقیت لغو گردید.", {
            reply_markup: new InlineKeyboard().text("🔙 بازگشت به رویدادهای من", "my_registrations"),
        });
        await ctx.answerCallbackQuery();
    });

    // ======================= Admin Handlers =======================

    bot.callbackQuery("admin_panel", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const isSuper = await isSuperAdmin(ctx, ctx.from!.id);
        const kb = new InlineKeyboard()
            .text("➕ ایجاد رویداد جدید", "adm_new_event").row()
            .text("📋 مدیریت و آمار رویدادها", "adm_manage_events").row()
            .text("💳 تنظیم اطلاعات شماره کارت", "adm_set_card").row();

        if (isSuper) {
            kb.text("👥 مدیریت مدیران", "adm_manage_admins").row();
        }
        kb.text("🔙 منوی اصلی", "main_menu");

        await editOrReply(ctx, "🛠 <b>پنل مدیریت انجمن علمی</b>\nیک بخش را انتخاب کنید:", {
            reply_markup: kb,
            ...HTML,
        });
        await ctx.answerCallbackQuery();
    });

    // Admin: Set Card
    bot.callbackQuery("adm_set_card", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        await setUserState(ctx, ctx.from!.id, "admin_wait_card");
        await ctx.reply("💳 لطفاً شماره کارت، نام صاحب حساب و نام بانک را به صورت یک پیام ارسال کنید:");
        await ctx.answerCallbackQuery();
    });

    // Admin: Manage Admins (Super Admin only)
    bot.callbackQuery("adm_manage_admins", async (ctx) => {
        if (!(await isSuperAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "فقط Super Admin مجاز است." });

        const { results } = await getDb(ctx)
            .prepare("SELECT telegram_id, full_name, username FROM users WHERE role = 'admin'")
            .all<any>();

        let text = "👥 <b>لیست ادمین‌های ربات:</b>\n\n";
        if (results && results.length > 0) {
            results.forEach((a, i) => {
                text += `${i + 1}. <code>${a.telegram_id}</code> (${esc(a.full_name || a.username || "بدون نام")})\n`;
            });
        } else {
            text += "هنوز ادمین جانبی تعریف نشده است.\n";
        }

        const kb = new InlineKeyboard()
            .text("➕ افزودن ادمین جدید", "adm_add_admin").row()
            .text("🔙 پنل مدیریت", "admin_panel");

        await editOrReply(ctx, text, { reply_markup: kb, ...HTML });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery("adm_add_admin", async (ctx) => {
        if (!(await isSuperAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "فقط Super Admin مجاز است." });
        await setUserState(ctx, ctx.from!.id, "admin_wait_new_admin_id");
        await ctx.reply("لطفاً <b>آیدی عددی (Numeric ID)</b> کاربر مورد نظر را برای ارتقا به مدیر ارسال کنید:", HTML);
        await ctx.answerCallbackQuery();
    });

    // Admin: Event Management List
    bot.callbackQuery("adm_manage_events", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        await ctx.answerCallbackQuery();

        const { results } = await getDb(ctx)
            .prepare("SELECT * FROM events ORDER BY id DESC")
            .all<any>();

        if (!results || results.length === 0) {
            return editOrReply(ctx, "رویدادی یافت نشد.", {
                reply_markup: new InlineKeyboard().text("🔙 بازگشت", "admin_panel"),
            });
        }

        const kb = new InlineKeyboard();
        for (const ev of results) {
            const statusEmoji = ev.status === "active" ? "🟢" : "🔴";
            kb.text(`${statusEmoji} ${ev.title}`, `adm_ev_detail_${ev.id}`).row();
        }
        kb.text("🔙 پنل مدیریت", "admin_panel");

        await editOrReply(ctx, "📋 رویداد مورد نظر را جهت مدیریت، دریافت اکسل یا ارسال پیام همگانی انتخاب کنید:", {
            reply_markup: kb,
        });
    });

    bot.callbackQuery(/^adm_ev_detail_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        await ctx.answerCallbackQuery();
        await renderAdminEventDetail(ctx, ctx.match[1]);
    });

    bot.callbackQuery(/^adm_ev_export_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];
        const ev = await getDb(ctx).prepare("SELECT title FROM events WHERE id = ?").bind(eventId).first<any>();
        const { results } = await getDb(ctx)
            .prepare(`
        SELECT u.full_name, u.phone, u.identifier, u.user_type, r.status, r.created_at, r.checked_in_at
        FROM registrations r
        JOIN users u ON r.telegram_id = u.telegram_id
        WHERE r.event_id = ? AND r.status = 'approved'
        ORDER BY r.id ASC
      `)
            .bind(eventId)
            .all<any>();

        if (!results || results.length === 0) {
            return ctx.answerCallbackQuery({ text: "هنوز شرکت‌کننده تأیید شده‌ای وجود ندارد.", show_alert: true });
        }
        await ctx.answerCallbackQuery();

        let csv = "\uFEFFنام و نام خانوادگی,شماره تماس,شماره دانشجویی / کدملی,نوع مخاطب,وضعیت,تاریخ ثبت‌نام,ورود (UTC)\n";
        for (const r of results) {
            const typeStr = r.user_type === "ui_student" ? "دانشگاه اصفهان" : "آزاد";
            csv += [
                csvCell(r.full_name),
                csvCell(r.phone),
                csvCell(r.identifier),
                csvCell(typeStr),
                csvCell(r.checked_in_at ? "وارد شده" : "تأیید شده"),
                csvCell(r.created_at),
                csvCell(r.checked_in_at || ""),
            ].join(",") + "\n";
        }

        const fileBuffer = new TextEncoder().encode(csv);
        await ctx.replyWithDocument(new InputFile(fileBuffer, `participants_event_${eventId}.csv`), {
            caption: `📊 لیست شرکت‌کنندگان تأییدشده رویداد: <b>${esc(ev?.title)}</b>`,
            ...HTML,
        });
    });

    // Admin: Toggle Event Status
    bot.callbackQuery(/^adm_ev_toggle_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];
        const evBefore = await getDb(ctx).prepare("SELECT status FROM events WHERE id = ?").bind(eventId).first<{ status: string }>();
        if (!evBefore) return ctx.answerCallbackQuery({ text: "رویداد یافت نشد!" });

        const newStatus = evBefore.status === "active" ? "closed" : "active";
        await getDb(ctx).prepare("UPDATE events SET status = ? WHERE id = ?").bind(newStatus, eventId).run();
        await ctx.answerCallbackQuery({ text: `وضعیت رویداد به ${newStatus === "active" ? "🟢 فعال" : "🔴 بسته"} تغییر یافت.` });

        await renderAdminEventDetail(ctx, eventId);
    });

    // Admin: Edit Capacity
    bot.callbackQuery(/^adm_ev_editcap_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const eventId = ctx.match[1];
        await setUserState(ctx, ctx.from!.id, "adm_wait_new_cap", { eventId });
        await ctx.reply("👥 لطفاً عدد ظرفیت کل جدید را وارد کنید:");
        await ctx.answerCallbackQuery();
    });

    // Admin: Delete Event Confirmation
    bot.callbackQuery(/^adm_ev_delete_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];
        const ev = await getDb(ctx).prepare("SELECT title FROM events WHERE id = ?").bind(eventId).first<any>();
        if (!ev) return ctx.answerCallbackQuery({ text: "رویداد یافت نشد!" });

        const kb = new InlineKeyboard()
            .text("⚠️ بله، کاملا حذف شود", `confirm_delete_ev_${eventId}`).row()
            .text("انصراف", `adm_ev_detail_${eventId}`);

        let warning = `⚠️ <b>هشدار مهم!</b>\n\n`;
        warning += `آیا از حذف کامل رویداد <b>${esc(ev.title)}</b> اطمینان دارید؟\n`;
        warning += `با این کار، <b>این رویداد و تمامی رکوردهای ثبت‌نامی و فیش‌های مرتبط با آن</b> برای همیشه از دیتابیس پاک خواهند شد و این عملیات غیرقابل بازگشت است!`;

        await editOrReply(ctx, warning, { reply_markup: kb, ...HTML });
        await ctx.answerCallbackQuery();
    });

    // Admin: Execute Event Deletion
    bot.callbackQuery(/^confirm_delete_ev_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];

        try {
            // single atomic batch: registrations first, then the event
            await getDb(ctx).batch([
                getDb(ctx).prepare("DELETE FROM registrations WHERE event_id = ?").bind(eventId),
                getDb(ctx).prepare("DELETE FROM events WHERE id = ?").bind(eventId),
            ]);

            await editOrReply(ctx, "✅ رویداد و تمامی ثبت‌نام‌های مرتبط با آن با موفقیت از سیستم حذف شدند.", {
                reply_markup: new InlineKeyboard().text("🔙 بازگشت به لیست رویدادها", "adm_manage_events"),
            });
            await ctx.answerCallbackQuery({ text: "رویداد حذف شد." });
        } catch (error) {
            console.error("Error deleting event:", error);
            await ctx.answerCallbackQuery({ text: "خطایی در حذف رویداد رخ داد.", show_alert: true });
        }
    });

    // Admin: Broadcast
    bot.callbackQuery(/^adm_ev_broadcast_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const eventId = ctx.match[1];
        await setUserState(ctx, ctx.from!.id, "adm_wait_broadcast_msg", { eventId });
        await ctx.reply("📢 لطفاً پیام خود را (متن یا عکس با کپشن) ارسال کنید تا برای <b>تمام تأییدشدگان این رویداد</b> ارسال شود:", HTML);
        await ctx.answerCallbackQuery();
    });

    // Admin: Receipt Approval Actions
    bot.callbackQuery(/^approve_pay_(\d+)_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const eventId = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2], 10);

        // Receipt copies go to every admin: make sure it is still pending (prevents double-approve)
        const reg = await getDb(ctx)
            .prepare("SELECT status FROM registrations WHERE event_id = ? AND telegram_id = ?")
            .bind(eventId, targetUserId)
            .first<{ status: string }>();
        if (!reg || reg.status !== "pending") {
            await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
            return ctx.answerCallbackQuery({ text: "این فیش قبلاً بررسی شده است.", show_alert: true });
        }

        const { remaining } = await getRemainingCapacity(ctx, eventId);
        if (remaining <= 0) {
            await ctx.answerCallbackQuery({
                text: "⚠️ ظرفیت رویداد تکمیل شده است! فیش را تأیید نکنید و وجه را عودت دهید.",
                show_alert: true,
            });
            return;
        }

        const upd = await getDb(ctx)
            .prepare("UPDATE registrations SET status = 'approved' WHERE event_id = ? AND telegram_id = ? AND status = 'pending'")
            .bind(eventId, targetUserId)
            .run();
        if (upd.meta.changes === 0) {
            return ctx.answerCallbackQuery({ text: "این فیش قبلاً بررسی شده است.", show_alert: true });
        }

        const ev = await getDb(ctx).prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<any>();

        // Notify user + send QR
        try {
            let msg = `🎉 پرداخت و ثبت‌نام شما در رویداد <b>${esc(ev?.title)}</b> تأیید شد!\n\n`;
            msg += `🗓 <b>تاریخ:</b> ${esc(ev?.event_date)}\n`;
            if (ev?.format_type === "in_person") {
                msg += `📍 <b>مکان:</b> ${esc(ev?.location_or_link || "دانشکده کامپیوتر")}\n`;
            } else {
                msg += `🔗 <b>لینک جلسه:</b> ${esc(ev?.location_or_link || "قبل از شروع برای شما ارسال می‌شود")}\n`;
            }
            await ctx.api.sendMessage(targetUserId, msg, HTML);
        } catch (e) {
            console.error("Could not notify user:", e);
        }
        try {
            await issueAndSendQr(ctx, eventId, targetUserId);
        } catch (e) {
            console.error("Could not send QR:", e);
        }

        await ctx
            .editMessageCaption({
                caption: (ctx.msg?.caption || "") + `\n\n✅ تأیید شد توسط ${ctx.from?.first_name || "ادمین"}`,
            })
            .catch(() => {});
        await ctx.answerCallbackQuery({ text: "ثبت‌نام تأیید شد." });
    });

    bot.callbackQuery(/^reject_pay_(\d+)_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const eventId = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2], 10);

        const upd = await getDb(ctx)
            .prepare("UPDATE registrations SET status = 'rejected' WHERE event_id = ? AND telegram_id = ? AND status = 'pending'")
            .bind(eventId, targetUserId)
            .run();
        if (upd.meta.changes === 0) {
            await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
            return ctx.answerCallbackQuery({ text: "این فیش قبلاً بررسی شده است.", show_alert: true });
        }

        const ev = await getDb(ctx).prepare("SELECT title FROM events WHERE id = ?").bind(eventId).first<any>();

        try {
            await ctx.api.sendMessage(
                targetUserId,
                `❌ رسید ارسالی شما برای رویداد <b>${esc(ev?.title)}</b> توسط مدیریت رد شد. در صورت بروز اشتباه با ادمین تماس بگیرید.`,
                HTML
            );
        } catch (e) {
            console.error("Could not notify user:", e);
        }

        await ctx
            .editMessageCaption({
                caption: (ctx.msg?.caption || "") + `\n\n❌ رد شد توسط ${ctx.from?.first_name || "ادمین"}`,
            })
            .catch(() => {});
        await ctx.answerCallbackQuery({ text: "رسید رد شد." });
    });

    // Admin: Create Event Step-by-Step
    bot.callbackQuery("adm_new_event", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        await setUserState(ctx, ctx.from!.id, "adm_ev_title", {});
        await ctx.reply("✏️ مرحله ۱ از ۸: لطفاً <b>عنوان رویداد</b> را ارسال کنید:", HTML);
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^adm_set_fee_(free|paid)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const feeType = ctx.match[1];
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        if (!state || state.step !== "adm_ev_fee_type") return ctx.answerCallbackQuery({ text: "نشست منقضی شده است." });

        state.data.event_type = feeType;
        if (feeType === "free") {
            state.data.price = 0;
            await setUserState(ctx, userId, "adm_ev_format", state.data);
            const kb = new InlineKeyboard()
                .text("🏢 حضوری", "adm_set_format_in_person")
                .text("🌐 آنلاین", "adm_set_format_online");
            await editOrReply(ctx, "📍 مرحله ۵ از ۸: نحوه برگزاری را انتخاب کنید:", { reply_markup: kb });
        } else {
            await setUserState(ctx, userId, "adm_ev_price", state.data);
            await editOrReply(ctx, "💰 مرحله ۴ (ادامه): مبلغ هزینه را به <b>تومان</b> (فقط عدد) ارسال کنید:", HTML);
        }
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^adm_set_format_(in_person|online)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const format = ctx.match[1];
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        if (!state || state.step !== "adm_ev_format") return ctx.answerCallbackQuery({ text: "نشست منقضی شده است." });

        state.data.format_type = format;
        await setUserState(ctx, userId, "adm_ev_location", state.data);

        const prompt = format === "in_person"
            ? "📍 مرحله ۶ از ۸: <b>محل دقیق برگزاری</b> را بنویسید (مثلاً: تالار آوینی دانشکده کامپیوتر):"
            : "🔗 مرحله ۶ از ۸: <b>لینک بستر آنلاین یا توضیح اتصال</b> را وارد کنید:";

        await editOrReply(ctx, prompt, HTML);
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery("adm_skip_poster", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        if (!state || state.step !== "adm_ev_poster") return ctx.answerCallbackQuery({ text: "نشست منقضی شده است." });

        state.data.poster_file_id = null;
        await setUserState(ctx, userId, "adm_ev_fee_type", state.data);

        const kb = new InlineKeyboard()
            .text("🟢 رایگان", "adm_set_fee_free")
            .text("💳 پولی", "adm_set_fee_paid");

        await editOrReply(ctx, "💰 مرحله ۴ از ۸: نوع هزینه رویداد را مشخص کنید:", { reply_markup: kb });
        await ctx.answerCallbackQuery();
    });

    // Global Back to main menu
    bot.callbackQuery("main_menu", async (ctx) => {
        await ctx.answerCallbackQuery();
        await clearUserState(ctx, ctx.from!.id);
        await sendMainMenu(ctx);
    });

    // ======================= Message Handling (FSM) =======================

    bot.on("message", async (ctx) => {
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        const text = ctx.message.text || "";

        if (!state) return; // Ignore messages if not in a specific state

        // 1. User Profile Setup FSM
        if (state.step === "reg_get_fullname") {
            const name = text.trim();
            if (name.length < 3) return ctx.reply("❌ لطفاً نام و نام خانوادگی را به صورت متن ارسال کنید.");
            await getDb(ctx).prepare("UPDATE users SET full_name = ? WHERE telegram_id = ?").bind(name, userId).run();
            await setUserState(ctx, userId, "reg_get_phone", state.data);

            const phoneKb = new Keyboard().requestContact("📱 ارسال شماره موبایل من").oneTime().resized();
            return ctx.reply("📱 لطفاً شماره همراه خود را وارد کنید یا دکمه زیر را لمس نمایید:", { reply_markup: phoneKb });
        }

        if (state.step === "reg_get_phone") {
            const phone = ctx.message.contact ? ctx.message.contact.phone_number : toEnDigits(text.trim());
            if (!/^\+?\d{10,14}$/.test(phone)) {
                return ctx.reply("❌ شماره معتبر نیست. مثال: 09123456789");
            }
            await getDb(ctx).prepare("UPDATE users SET phone = ? WHERE telegram_id = ?").bind(phone, userId).run();

            const user = await getDb(ctx).prepare("SELECT user_type FROM users WHERE telegram_id = ?").bind(userId).first<any>();
            await setUserState(ctx, userId, "reg_get_identifier", state.data);

            const label = user?.user_type === "ui_student" ? "شماره دانشجویی" : "کد ملی";
            return ctx.reply(`🔢 لطفاً <b>${label}</b> خود را وارد کنید:`, {
                ...HTML,
                reply_markup: { remove_keyboard: true },
            });
        }

        if (state.step === "reg_get_identifier") {
            const identifier = toEnDigits(text.trim());
            if (!/^\d{5,15}$/.test(identifier)) {
                return ctx.reply("❌ لطفاً فقط عدد وارد کنید.");
            }
            await getDb(ctx).prepare("UPDATE users SET identifier = ? WHERE telegram_id = ?").bind(identifier, userId).run();
            const eventId = state.data.eventId;
            await clearUserState(ctx, userId);
            await ctx.reply("✅ اطلاعات حساب کاربری شما با موفقیت ذخیره شد.");
            return finalizeRegistration(ctx, eventId, userId);
        }

        // 2. Receipt Submission
        if (state.step === "reg_wait_receipt") {
            const photo = ctx.message.photo;
            if (!photo || photo.length === 0) {
                return ctx.reply("❌ لطفاً فیش واریزی را به صورت <b>عکس</b> بفرستید.", HTML);
            }
            const fileId = photo[photo.length - 1].file_id;
            const eventId = state.data.eventId;

            // never downgrade an already approved registration
            await getDb(ctx)
                .prepare(`
          INSERT INTO registrations (event_id, telegram_id, status, receipt_file_id) 
          VALUES (?, ?, 'pending', ?)
          ON CONFLICT(event_id, telegram_id) DO UPDATE SET status = 'pending', receipt_file_id = excluded.receipt_file_id
          WHERE registrations.status != 'approved'
        `)
                .bind(eventId, userId, fileId)
                .run();

            await clearUserState(ctx, userId);
            await ctx.reply("✅ فیش شما ثبت شد و برای ادمین ارسال گردید. پس از تأیید به شما اطلاع داده خواهد شد.", {
                reply_markup: new InlineKeyboard().text("🔙 منوی اصلی", "main_menu"),
            });

            // Forward Receipt to Admins
            const ev = await getDb(ctx).prepare("SELECT title FROM events WHERE id = ?").bind(eventId).first<any>();
            const user = await getDb(ctx).prepare("SELECT full_name, phone, identifier FROM users WHERE telegram_id = ?").bind(userId).first<any>();
            const adminIds = await getAllAdminIds(ctx);

            const kb = new InlineKeyboard()
                .text("✅ تأیید فیش", `approve_pay_${eventId}_${userId}`)
                .text("❌ رد فیش", `reject_pay_${eventId}_${userId}`);

            let caption = `💳 <b>فیش واریزی جدید</b>\n\n`;
            caption += `📌 رویداد: <b>${esc(ev?.title)}</b>\n`;
            caption += `👤 کاربر: ${esc(user?.full_name)} (<code>${userId}</code>)\n`;
            caption += `📱 تلفن: ${esc(user?.phone)}\n`;
            caption += `🔢 شناسه: ${esc(user?.identifier)}\n`;

            for (const admId of adminIds) {
                try {
                    await ctx.api.sendPhoto(admId, fileId, { caption, ...HTML, reply_markup: kb });
                } catch (err) {
                    console.error(`Failed to send receipt to admin ${admId}`, err);
                }
            }
            return;
        }

        // 3. Admin: Settings & Manage Actions
        if (state.step === "admin_wait_card") {
            if (!text.trim()) return ctx.reply("❌ لطفاً اطلاعات کارت را به صورت متن ارسال کنید.");
            await getDb(ctx)
                .prepare("INSERT INTO settings (key, value) VALUES ('card_info', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(text)
                .run();
            await clearUserState(ctx, userId);
            return ctx.reply("✅ اطلاعات کارت با موفقیت ذخیره شد.", {
                reply_markup: new InlineKeyboard().text("🔙 پنل مدیریت", "admin_panel"),
            });
        }

        if (state.step === "admin_wait_new_admin_id") {
            const newAdminId = parseInt(toEnDigits(text.trim()), 10);
            if (isNaN(newAdminId)) return ctx.reply("لطفاً یک آیدی عددی معتبر ارسال کنید.");

            await getDb(ctx)
                .prepare(`
          INSERT INTO users (telegram_id, role) VALUES (?, 'admin')
          ON CONFLICT(telegram_id) DO UPDATE SET role = 'admin'
        `)
                .bind(newAdminId)
                .run();

            await clearUserState(ctx, userId);
            return ctx.reply(`✅ کاربر با شناسه <code>${newAdminId}</code> با موفقیت به عنوان مدیر ثبت شد.`, {
                ...HTML,
                reply_markup: new InlineKeyboard().text("🔙 مدیریت مدیران", "adm_manage_admins"),
            });
        }

        if (state.step === "adm_wait_new_cap") {
            const newCap = parseInt(toEnDigits(text.trim()), 10);
            if (isNaN(newCap) || newCap <= 0) return ctx.reply("لطفاً یک عدد مثبت وارد کنید.");

            const { approved } = await getRemainingCapacity(ctx, state.data.eventId);
            if (newCap < approved) {
                return ctx.reply(`❌ ظرفیت نمی‌تواند کمتر از تعداد تأییدشدگان فعلی (${approved}) باشد.`);
            }

            await getDb(ctx).prepare("UPDATE events SET capacity = ? WHERE id = ?").bind(newCap, state.data.eventId).run();
            await clearUserState(ctx, userId);
            return ctx.reply("✅ ظرفیت رویداد با موفقیت تغییر کرد.", {
                reply_markup: new InlineKeyboard().text("🔙 بازگشت به رویداد", `adm_ev_detail_${state.data.eventId}`),
            });
        }

        if (state.step === "adm_wait_broadcast_msg") {
            const eventId = state.data.eventId;
            const photoId = ctx.message.photo && ctx.message.photo.length > 0
                ? ctx.message.photo[ctx.message.photo.length - 1].file_id
                : null;

            if (!photoId && !text) {
                return ctx.reply("❌ فقط متن یا عکس (با کپشن) قابل ارسال است.");
            }

            const { results } = await getDb(ctx)
                .prepare("SELECT telegram_id FROM registrations WHERE event_id = ? AND status = 'approved'")
                .bind(eventId)
                .all<{ telegram_id: number }>();

            await clearUserState(ctx, userId);

            if (!results || results.length === 0) {
                return ctx.reply("❌ هیچ شرکت‌کننده تأییدشده‌ای برای دریافت پیام وجود ندارد.", {
                    reply_markup: new InlineKeyboard().text("🔙 پنل مدیریت", "admin_panel"),
                });
            }

            const caption = ctx.message.caption || "";
            const captionEntities = ctx.message.caption_entities;
            const entities = ctx.message.entities;
            const api = ctx.api;
            const adminChat = userId;

            await ctx.reply(`📢 ارسال برای ${results.length} نفر آغاز شد. پس از پایان، گزارش برایتان ارسال می‌شود.`);

            // Run in the background: a long broadcast must not hit the webhook timeout
            // (a timeout would make Telegram re-deliver the update and duplicate the messages).
            ctx.wait(
                (async () => {
                    let sentCount = 0;
                    let errorCount = 0;
                    for (const r of results) {
                        try {
                            if (photoId) {
                                await api.sendPhoto(r.telegram_id, photoId, { caption, caption_entities: captionEntities });
                            } else {
                                await api.sendMessage(r.telegram_id, text, { entities });
                            }
                            sentCount++;
                        } catch (e) {
                            errorCount++;
                            console.error(`Failed to broadcast to ${r.telegram_id}`, e);
                        }
                        await new Promise((res) => setTimeout(res, 50)); // stay under Telegram's rate limit
                    }
                    await api
                        .sendMessage(adminChat, `📢 پیام به ${sentCount} نفر ارسال شد. (${errorCount} خطا)`, {
                            reply_markup: new InlineKeyboard().text("🔙 پنل مدیریت", "admin_panel"),
                        })
                        .catch(() => {});
                })()
            );
            return;
        }

        // 4. Admin: Event Creation FSM
        if (state.step === "adm_ev_title") {
            if (!text.trim()) return ctx.reply("❌ لطفاً عنوان را به صورت متن ارسال کنید.");
            state.data.title = text.trim();
            await setUserState(ctx, userId, "adm_ev_desc", state.data);
            return ctx.reply("📝 مرحله ۲ از ۸: <b>توضیحات رویداد</b> را ارسال کنید:", HTML);
        }

        if (state.step === "adm_ev_desc") {
            if (!text.trim()) return ctx.reply("❌ لطفاً توضیحات را به صورت متن ارسال کنید.");
            state.data.description = text.trim();
            await setUserState(ctx, userId, "adm_ev_poster", state.data);
            const kb = new InlineKeyboard().text("رد کردن (بدون پوستر)", "adm_skip_poster");
            return ctx.reply("🖼 مرحله ۳ از ۸: <b>عکس پوستر رویداد</b> را ارسال کنید یا دکمه رد کردن را بزنید:", { ...HTML, reply_markup: kb });
        }

        if (state.step === "adm_ev_poster") {
            if (!ctx.message.photo) return ctx.reply("لطفاً یک تصویر ارسال کنید یا دکمه رد کردن را بزنید.");
            state.data.poster_file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            await setUserState(ctx, userId, "adm_ev_fee_type", state.data);

            const kb = new InlineKeyboard()
                .text("🟢 رایگان", "adm_set_fee_free")
                .text("💳 پولی", "adm_set_fee_paid");

            return ctx.reply("💰 مرحله ۴ از ۸: نوع هزینه رویداد را مشخص کنید:", { reply_markup: kb });
        }

        if (state.step === "adm_ev_price") {
            const price = parseInt(toEnDigits(text.replace(/[,،\s]/g, "")), 10);
            if (isNaN(price) || price < 0) return ctx.reply("لطفاً فقط عدد وارد کنید:");
            state.data.price = price;

            await setUserState(ctx, userId, "adm_ev_format", state.data);
            const kb = new InlineKeyboard()
                .text("🏢 حضوری", "adm_set_format_in_person")
                .text("🌐 آنلاین", "adm_set_format_online");
            return ctx.reply("📍 مرحله ۵ از ۸: نحوه برگزاری را انتخاب کنید:", { reply_markup: kb });
        }

        if (state.step === "adm_ev_location") {
            if (!text.trim()) return ctx.reply("❌ لطفاً به صورت متن ارسال کنید.");
            state.data.location_or_link = text.trim();
            await setUserState(ctx, userId, "adm_ev_date", state.data);
            return ctx.reply("🗓 مرحله ۷ از ۸: <b>تاریخ و ساعت برگزاری</b> را وارد کنید (مثال: پنج‌شنبه ۲۵ آبان ساعت ۱۶):", HTML);
        }

        if (state.step === "adm_ev_date") {
            if (!text.trim()) return ctx.reply("❌ لطفاً به صورت متن ارسال کنید.");
            state.data.event_date = text.trim();
            await setUserState(ctx, userId, "adm_ev_cap", state.data);
            return ctx.reply("👥 مرحله ۸ از ۸: <b>ظرفیت کل رویداد</b> را به عدد وارد کنید:", HTML);
        }

        if (state.step === "adm_ev_cap") {
            const cap = parseInt(toEnDigits(text.trim()), 10);
            if (isNaN(cap) || cap <= 0) return ctx.reply("لطفاً یک عدد معتبر بزرگتر از صفر وارد کنید:");
            state.data.capacity = cap;

            const res = await getDb(ctx)
                .prepare(`
                  INSERT INTO events (title, description, poster_file_id, event_type, price, format_type, location_or_link, event_date, capacity, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
                `)
                .bind(
                    state.data.title,
                    state.data.description,
                    state.data.poster_file_id || null,
                    state.data.event_type,
                    state.data.price || 0,
                    state.data.format_type,
                    state.data.location_or_link,
                    state.data.event_date,
                    state.data.capacity
                )
                .run();

            const newId = res.meta?.last_row_id;
            const channelLink = `https://t.me/${ctx.me.username}?start=event_${newId}`;

            await clearUserState(ctx, userId);

            let finalMsg = `🎉 <b>رویداد جدید با موفقیت ایجاد و منتشر شد!</b>\n\n`;
            finalMsg += `📌 عنوان: ${esc(state.data.title)}\n`;
            finalMsg += `🔗 <b>لینک ثبت‌نام جهت درج در کانال:</b>\n<code>${channelLink}</code>`;

            return ctx.reply(finalMsg, {
                ...HTML,
                reply_markup: new InlineKeyboard().text("🔙 پنل مدیریت", "admin_panel"),
            });
        }
    });

    return bot;
}

// ======================= Check-in API + scanner page =======================

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}

function authorized(request: Request, env: Env): boolean {
    const given = request.headers.get("x-scan-secret") || "";
    const expected = env.SCAN_SECRET || "";
    if (!expected || given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

async function handleScannerRoutes(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    const db = env.ceevents_db || env.DB!;

    if (url.pathname === "/scan" && request.method === "GET") {
        return new Response(SCANNER_HTML, {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
        const { results } = await db.prepare("SELECT id, title, event_date FROM events ORDER BY id DESC").all();
        return json({ events: results });
    }

    if (url.pathname === "/api/checkin" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

        let body: { token?: string; event_id?: number | string };
        try {
            body = await request.json();
        } catch {
            return json({ status: "error", message: "درخواست نامعتبر" }, 400);
        }
        const token = (body.token || "").trim();
        const eventId = Number(body.event_id);
        if (!token || !eventId) return json({ status: "error", message: "اطلاعات ناقص است" }, 400);

        // Atomic: only ONE request can ever flip checked_in_at from NULL -> value
        const upd = await db
            .prepare(
                `UPDATE registrations
                 SET checked_in_at = CURRENT_TIMESTAMP
                 WHERE qr_token = ? AND event_id = ? AND status = 'approved' AND checked_in_at IS NULL`
            )
            .bind(token, eventId)
            .run();

        const info = await db
            .prepare(
                `SELECT r.event_id, r.status, r.checked_in_at, u.full_name, u.identifier
                 FROM registrations r JOIN users u ON u.telegram_id = r.telegram_id
                 WHERE r.qr_token = ?`
            )
            .bind(token)
            .first<any>();

        if (upd.meta.changes === 1) {
            return json({ status: "ok", message: "ورود تأیید شد ✅", name: info?.full_name, identifier: info?.identifier });
        }
        if (!info) return json({ status: "invalid", message: "کد نامعتبر است ❌" });
        if (info.event_id !== eventId) return json({ status: "wrong_event", message: "این بلیت برای رویداد دیگری است ❌", name: info.full_name });
        if (info.status !== "approved") return json({ status: "not_approved", message: "ثبت‌نام تأیید نشده/لغو شده است ❌", name: info.full_name });
        return json({
            status: "used",
            message: "این بلیت قبلاً استفاده شده است ⛔",
            name: info.full_name,
            identifier: info.identifier,
            at: info.checked_in_at,
        });
    }

    return null; // not one of our routes
}

// Opens on your phone: https://<your-worker>/scan
const SCANNER_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>اسکنر ورود</title>
<style>
  body{font-family:system-ui,Tahoma,sans-serif;margin:0;padding:12px;background:#111;color:#eee}
  select,input,button{width:100%;padding:12px;margin:6px 0;font-size:16px;border-radius:8px;border:0;box-sizing:border-box}
  button{background:#2a7be4;color:#fff}
  #reader{width:100%;max-width:420px;margin:8px auto}
  #result{margin-top:10px;padding:18px;border-radius:12px;font-size:20px;text-align:center;display:none}
  .ok{background:#1e8e3e}.bad{background:#c5221f}.warn{background:#b06000}
  #count{opacity:.7;text-align:center}
</style>
<script src="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
</head>
<body>
  <div id="setup">
    <input id="secret" type="password" placeholder="رمز اسکنر">
    <button id="load">ورود و دریافت رویدادها</button>
    <select id="event" style="display:none"></select>
    <button id="start" style="display:none">شروع اسکن</button>
  </div>
  <div id="reader"></div>
  <div id="result"></div>
  <p id="count"></p>
<script>
const $ = (id) => document.getElementById(id);
let busy = false, okCount = 0, scanner = null;
$("secret").value = localStorage.getItem("scan_secret") || "";

function headers(){ return { "x-scan-secret": $("secret").value, "content-type": "application/json" }; }

$("load").onclick = async () => {
  const r = await fetch("/api/events", { headers: headers() });
  if (!r.ok) return alert("رمز اشتباه است");
  localStorage.setItem("scan_secret", $("secret").value);
  const { events } = await r.json();
  $("event").innerHTML = "";
  events.forEach(e => { const o = document.createElement("option"); o.value = e.id; o.textContent = e.title; $("event").appendChild(o); });
  $("event").style.display = $("start").style.display = "block";
};

function show(cls, lines){
  const el = $("result");
  el.className = cls; el.style.display = "block";
  el.textContent = "";
  lines.filter(Boolean).forEach(t => { const d = document.createElement("div"); d.textContent = t; el.appendChild(d); });
}

async function onScan(text){
  if (busy) return;
  busy = true;
  try {
    const r = await fetch("/api/checkin", { method: "POST", headers: headers(),
      body: JSON.stringify({ token: text, event_id: Number($("event").value) }) });
    const d = await r.json();
    if (d.status === "ok") { okCount++; $("count").textContent = "تعداد ورود موفق: " + okCount; navigator.vibrate && navigator.vibrate(120); show("ok", [d.message, d.name, d.identifier]); }
    else if (d.status === "used") { navigator.vibrate && navigator.vibrate([200,100,200]); show("warn", [d.message, d.name, d.at ? "زمان ورود قبلی: " + d.at + " (UTC)" : ""]); }
    else { navigator.vibrate && navigator.vibrate([300,100,300]); show("bad", [d.message || "خطا", d.name]); }
  } catch (e) { show("bad", ["خطای شبکه"]); }
  setTimeout(() => { busy = false; }, 2000); // cooldown so the same QR isn't submitted twice
}

$("start").onclick = async () => {
  if (scanner) await scanner.stop().catch(()=>{});
  scanner = new Html5Qrcode("reader");
  scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScan, () => {})
    .catch(err => alert("دسترسی دوربین ممکن نشد: " + err));
};
</script>
</body>
</html>`;

// ======================= Cloudflare Worker Fetch Handler =======================

export default {
    async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
        // scanner page + check-in API
        const routed = await handleScannerRoutes(request, env);
        if (routed) return routed;

        if (request.method === "GET") {
            return new Response("Telegram Events Bot is active!");
        }

        if (!env.BOT_TOKEN) {
            return new Response("BOT_TOKEN is missing", { status: 500 });
        }

        const bot = createBot(env.BOT_TOKEN, env, execCtx);
        const handler = webhookCallback(bot, "cloudflare-mod", {
            onTimeout: "return",
            timeoutMilliseconds: 10_000,
        });

        return handler(request);
    },
};