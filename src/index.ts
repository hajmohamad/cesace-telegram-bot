import { Bot, Context, webhookCallback, InlineKeyboard, Keyboard, InputFile } from "grammy";

// ======================= Types & Interfaces =======================

export interface Env {
    ceevents_db: D1Database;
    DB?: D1Database; // For backwards compatibility with older wrangler.toml
    BOT_TOKEN: string;
    SUPER_ADMIN_ID: string;
}

interface UserState {
    step: string;
    data: any;
}

interface MyContext extends Context {
    env: Env;
    db: D1Database;
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
        await ctx.editMessageText(text, { reply_markup: kb });
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

    let caption = `📌 *${ev.title}*\n\n`;
    caption += `${ev.description}\n\n`;
    caption += `🗓 **زمان برگزاری:** ${ev.event_date}\n`;
    caption += `📍 **نوع برگزاری:** ${ev.format_type === "in_person" ? `حضوری (${ev.location_or_link || "دانشکده"})` : `آنلاین`}\n`;
    caption += `👥 **ظرفیت باقی‌مانده:** ${remaining > 0 ? `${remaining} از ${capacity}` : "❌ تکمیل ظرفیت"}\n`;
    caption += `💰 **هزینه ثبت‌نام:** ${ev.event_type === "free" ? "🟢 رایگان" : `💳 ${Number(ev.price).toLocaleString("fa-IR")} تومان`}\n`;

    const kb = new InlineKeyboard();
    if (ev.status === "active" && remaining > 0) {
        kb.text("✍️ ثبت‌نام در این رویداد", `register_${ev.id}`).row();
    } else if (ev.status !== "active") {
        caption += `\n⚠️ *این رویداد به پایان رسیده یا متوقف شده است.*`;
    }
    kb.text("🔙 بازگشت به لیست", "list_events");

    if (ev.poster_file_id) {
        await ctx.replyWithPhoto(ev.poster_file_id, { caption, parse_mode: "Markdown", reply_markup: kb });
    } else {
        await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: kb });
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
            .text("🌐 سایر دانشگاه‌ها / آزاد", "type_other");
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

    const { remaining } = await getRemainingCapacity(ctx, eventId);
    if (remaining <= 0) {
        return ctx.reply("❌ متأسفانه ظرفیت این رویداد تکمیل شده است.");
    }

    if (ev.event_type === "free") {
        await getDb(ctx)
            .prepare(`
        INSERT INTO registrations (event_id, telegram_id, status) 
        VALUES (?, ?, 'approved')
        ON CONFLICT(event_id, telegram_id) DO UPDATE SET status = 'approved', created_at = CURRENT_TIMESTAMP
      `)
            .bind(eventId, userId)
            .run();

        let successMsg = `🎉 ثبت‌نام شما در رویداد *${ev.title}* با موفقیت تأیید شد!\n\n`;
        successMsg += `🗓 **تاریخ:** ${ev.event_date}\n`;
        if (ev.format_type === "in_person") {
            successMsg += `📍 **مکان:** ${ev.location_or_link || "دانشکده کامپیوتر"}\n`;
        } else {
            successMsg += `🔗 **لینک ورود به جلسه:** ${ev.location_or_link || "قبل از جلسه ارسال می‌شود"}\n`;
        }

        await ctx.reply(successMsg, {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("🔙 منوی اصلی", "main_menu"),
        });
    } else {
        const cardSetting = await getDb(ctx)
            .prepare("SELECT value FROM settings WHERE key = 'card_info'")
            .first<{ value: string }>();

        await setUserState(ctx, userId, "reg_wait_receipt", { eventId });

        let msg = `💳 **پرداخت هزینه رویداد: ${ev.title}**\n\n`;
        msg += `مبلغ قابل پرداخت: *${Number(ev.price).toLocaleString("fa-IR")} تومان*\n`;
        msg += `اطلاعات واریز:\n\`${cardSetting?.value || "شماره کارت تنظیم نشده است."}\`\n\n`;
        msg += `⚠️ لطفاً پس از واریز، **تصویر رسید / فیش پرداخت** خود را در همین قسمت ارسال کنید.`;

        await ctx.reply(msg, { parse_mode: "Markdown" });
    }
}

// ======================= Bot Setup & Routes =======================

export function createBot(token: string, env: Env) {
    const bot = new Bot<MyContext>(token);

    bot.use(async (ctx, next) => {
        ctx.env = env;
        ctx.db = env.ceevents_db || env.DB!;
        await next();
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

        if (startPayload && startPayload.startsWith("event_")) {
            const eventId = startPayload.replace("event_", "");
            return showEventDetails(ctx, eventId);
        }

        await sendMainMenu(ctx);
    });

    // Main list
    bot.callbackQuery("list_events", async (ctx) => {
        const { results } = await getDb(ctx)
            .prepare("SELECT * FROM events WHERE status = 'active' ORDER BY id DESC")
            .all();

        if (!results || results.length === 0) {
            const kb = new InlineKeyboard().text("🔙 بازگشت", "main_menu");
            return ctx.editMessageText("در حال حاضر هیچ رویداد فعالی وجود ندارد.", { reply_markup: kb });
        }

        const kb = new InlineKeyboard();
        for (const ev of results as any[]) {
            const typeText = ev.event_type === "free" ? "🟢 رایگان" : `💰 ${Number(ev.price).toLocaleString("fa-IR")} ت`;
            kb.text(`${ev.title} (${typeText})`, `view_ev_${ev.id}`).row();
        }
        kb.text("🔙 بازگشت به منوی اصلی", "main_menu");

        await ctx.editMessageText("📋 **لیست رویدادهای فعال:**\nجهت مشاهده اطلاعات کامل و ثبت‌نام، روی رویداد مورد نظر کلیک کنید:", {
            reply_markup: kb,
            parse_mode: "Markdown",
        });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^view_ev_(\d+)$/, async (ctx) => {
        await showEventDetails(ctx, ctx.match[1]);
        await ctx.answerCallbackQuery();
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

        await proceedToRegistrationOrProfile(ctx, eventId, userId);
        await ctx.answerCallbackQuery();
    });

    // Profile Type Select
    bot.callbackQuery(/^type_(ui|other)$/, async (ctx) => {
        const type = ctx.match[1] === "ui" ? "ui_student" : "other";
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);

        await getDb(ctx)
            .prepare("UPDATE users SET user_type = ? WHERE telegram_id = ?")
            .bind(type, userId)
            .run();

        await setUserState(ctx, userId, "reg_get_fullname", state?.data || {});
        await ctx.editMessageText("✏️ لطفاً **نام و نام خانوادگی** کامل خود را به فارسی ارسال کنید:");
        await ctx.answerCallbackQuery();
    });

    // User Registrations & Cancellation
    bot.callbackQuery("my_registrations", async (ctx) => {
        const userId = ctx.from!.id;
        const { results } = await getDb(ctx)
            .prepare(`
        SELECT e.id as event_id, e.title, e.event_date, r.status 
        FROM registrations r 
        JOIN events e ON r.event_id = e.id 
        WHERE r.telegram_id = ? AND r.status != 'canceled'
        ORDER BY r.id DESC
      `)
            .bind(userId)
            .all<any>();

        if (!results || results.length === 0) {
            const kb = new InlineKeyboard().text("🔙 بازگشت", "main_menu");
            return ctx.editMessageText("شما در حال حاضر در هیچ رویدادی ثبت‌نام فعال ندارید.", { reply_markup: kb });
        }

        const kb = new InlineKeyboard();
        let text = "📋 **لیست ثبت‌نام‌های شما:**\n\n";

        for (const item of results) {
            const statusIcon = item.status === "approved" ? "✅ تأیید شده" : "⏳ در انتظار بررسی فیش";
            text += `🔹 *${item.title}*\n🗓 تاریخ: ${item.event_date}\nوضعیت: ${statusIcon}\n\n`;
            kb.text(`❌ لغو ثبت‌نام: ${item.title}`, `cancel_reg_${item.event_id}`).row();
        }
        kb.text("🔙 بازگشت به منوی اصلی", "main_menu");

        await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^cancel_reg_(\d+)$/, async (ctx) => {
        const eventId = ctx.match[1];
        const kb = new InlineKeyboard()
            .text("بله، لغو شود", `confirm_cancel_${eventId}`)
            .text("انصراف", "my_registrations");

        await ctx.editMessageText("⚠️ آیا از لغو ثبت‌نام در این رویداد اطمینان دارید؟ (در صورت لغو، ظرفیت برای سایرین آزاد می‌شود)", { reply_markup: kb });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^confirm_cancel_(\d+)$/, async (ctx) => {
        const eventId = ctx.match[1];
        const userId = ctx.from!.id;

        await getDb(ctx)
            .prepare("UPDATE registrations SET status = 'canceled' WHERE event_id = ? AND telegram_id = ?")
            .bind(eventId, userId)
            .run();

        await ctx.editMessageText("✅ ثبت‌نام شما با موفقیت لغو گردید.", {
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

        await ctx.editMessageText("🛠 **پنل مدیریت انجمن علمی**\nیک بخش را انتخاب کنید:", {
            reply_markup: kb,
            parse_mode: "Markdown",
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

        let text = "👥 **لیست ادمین‌های ربات:**\n\n";
        if (results && results.length > 0) {
            results.forEach((a, i) => {
                text += `${i + 1}. \`${a.telegram_id}\` (${a.full_name || a.username || "بدون نام"})\n`;
            });
        } else {
            text += "هنوز ادمین جانبی تعریف نشده است.\n";
        }

        const kb = new InlineKeyboard()
            .text("➕ افزودن ادمین جدید", "adm_add_admin").row()
            .text("🔙 پنل مدیریت", "admin_panel");

        await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery("adm_add_admin", async (ctx) => {
        if (!(await isSuperAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "فقط Super Admin مجاز است." });
        await setUserState(ctx, ctx.from!.id, "admin_wait_new_admin_id");
        await ctx.reply("لطفاً **آیدی عددی (Numeric ID)** کاربر مورد نظر را برای ارتقا به مدیر ارسال کنید:");
        await ctx.answerCallbackQuery();
    });

    // Admin: Event Management List
    bot.callbackQuery("adm_manage_events", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const { results } = await getDb(ctx)
            .prepare("SELECT * FROM events ORDER BY id DESC")
            .all<any>();

        if (!results || results.length === 0) {
            return ctx.editMessageText("رویدادی یافت نشد.", {
                reply_markup: new InlineKeyboard().text("🔙 بازگشت", "admin_panel"),
            });
        }

        const kb = new InlineKeyboard();
        for (const ev of results) {
            const statusEmoji = ev.status === "active" ? "🟢" : "🔴";
            kb.text(`${statusEmoji} ${ev.title}`, `adm_ev_detail_${ev.id}`).row();
        }
        kb.text("🔙 پنل مدیریت", "admin_panel");

        await ctx.editMessageText("📋 رویداد مورد نظر را جهت مدیریت، دریافت اکسل یا ارسال پیام همگانی انتخاب کنید:", {
            reply_markup: kb,
        });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^adm_ev_detail_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];
        const ev = await getDb(ctx).prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<any>();
        if (!ev) return ctx.answerCallbackQuery({ text: "یافت نشد!" });

        const { capacity, approved, remaining } = await getRemainingCapacity(ctx, eventId);
        const botInfo = await ctx.api.getMe();
        const deepLink = `https://t.me/${botInfo.username}?start=event_${ev.id}`;

        let text = `⚙️ **مدیریت رویداد: ${ev.title}**\n\n`;
        text += `🔗 **لینک ثبت‌نام مستقیم:**\n\`${deepLink}\`\n\n`;
        text += `📊 **ظرفیت کل:** ${capacity}\n`;
        text += `✅ **تأیید شده:** ${approved}\n`;
        text += `👥 **باقی‌مانده:** ${remaining}\n`;
        text += `وضعیت: ${ev.status === "active" ? "🟢 در حال ثبت‌نام" : "🔴 بسته شده"}\n`;

        const kb = new InlineKeyboard()
            .text("📊 دانلود لیست (اکسل/CSV)", `adm_ev_export_${ev.id}`).row()
            .text("📢 ارسال پیام همگانی", `adm_ev_broadcast_${ev.id}`).row()
            .text("🔢 تغییر ظرفیت", `adm_ev_editcap_${ev.id}`)
            .text(ev.status === "active" ? "🔴 بستن رویداد" : "🟢 بازگشایی رویداد", `adm_ev_toggle_${ev.id}`).row()
            .text("🗑 حذف کامل رویداد", `adm_ev_delete_${ev.id}`).row()
            .text("🔙 لیست رویدادها", "adm_manage_events");

        await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^adm_ev_export_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];
        const ev = await getDb(ctx).prepare("SELECT title FROM events WHERE id = ?").bind(eventId).first<any>();
        const { results } = await getDb(ctx)
            .prepare(`
        SELECT u.full_name, u.phone, u.identifier, u.user_type, r.status, r.created_at
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

        let csv = "\uFEFFنام و نام خانوادگی,شماره تماس,شماره دانشجویی / کدملی,نوع مخاطب,وضعیت,تاریخ ثبت‌نام\n";
        for (const r of results) {
            const typeStr = r.user_type === "ui_student" ? "دانشگاه اصفهان" : "آزاد";
            csv += `"${r.full_name || ""}","${r.phone || ""}","${r.identifier || ""}","${typeStr}","تأیید شده","${r.created_at}"\n`;
        }

        const encoder = new TextEncoder();
        const fileBuffer = encoder.encode(csv);
        await ctx.replyWithDocument(new InputFile(fileBuffer, `participants_event_${eventId}.csv`), {
            caption: `📊 لیست شرکت‌کنندگان تأییدشده رویداد: *${ev?.title}*`,
            parse_mode: "Markdown",
        });
        await ctx.answerCallbackQuery();
    });

    // Admin: Toggle Event Status (Refactored for stability)
    bot.callbackQuery(/^adm_ev_toggle_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];
        const evBefore = await getDb(ctx).prepare("SELECT status FROM events WHERE id = ?").bind(eventId).first<{ status: string }>();
        if (!evBefore) return ctx.answerCallbackQuery({ text: "رویداد یافت نشد!" });

        const newStatus = evBefore.status === "active" ? "closed" : "active";
        await getDb(ctx).prepare("UPDATE events SET status = ? WHERE id = ?").bind(newStatus, eventId).run();
        await ctx.answerCallbackQuery({ text: `وضعیت رویداد به ${newStatus === 'active' ? '🟢 فعال' : '🔴 بسته'} تغییر یافت.` });

        // Explicitly re-render the message instead of using handleUpdate
        const ev = await getDb(ctx).prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<any>();
        if (!ev) return;

        const { capacity, approved, remaining } = await getRemainingCapacity(ctx, eventId);
        const botInfo = await ctx.api.getMe();
        const deepLink = `https://t.me/${botInfo.username}?start=event_${ev.id}`;

        let text = `⚙️ **مدیریت رویداد: ${ev.title}**\n\n`;
        text += `🔗 **لینک ثبت‌نام مستقیم:**\n\`${deepLink}\`\n\n`;
        text += `📊 **ظرفیت کل:** ${capacity}\n`;
        text += `✅ **تأیید شده:** ${approved}\n`;
        text += `👥 **باقی‌مانده:** ${remaining}\n`;
        text += `وضعیت: ${ev.status === "active" ? "🟢 در حال ثبت‌نام" : "🔴 بسته شده"}\n`;

        const kb = new InlineKeyboard()
            .text("📊 دانلود لیست (اکسل/CSV)", `adm_ev_export_${ev.id}`).row()
            .text("📢 ارسال پیام همگانی", `adm_ev_broadcast_${ev.id}`).row()
            .text("🔢 تغییر ظرفیت", `adm_ev_editcap_${ev.id}`)
            .text("🗑 حذف کامل رویداد", `adm_ev_delete_${ev.id}`).row() // <<< این دکمه اینجا هم باید باشد
            .text(ev.status === "active" ? "🔴 بستن رویداد" : "🟢 بازگشایی رویداد", `adm_ev_toggle_${ev.id}`).row()
            .text("🔙 لیست رویدادها", "adm_manage_events");

        await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "Markdown" });
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

        let warning = `⚠️ **هشدار مهم!**\n\n`;
        warning += `آیا از حذف کامل رویداد **${ev.title}** اطمینان دارید؟\n`;
        warning += `با این کار، **این رویداد و تمامی رکوردهای ثبت‌نامی و فیش‌های مرتبط با آن** برای همیشه از دیتابیس پاک خواهند شد و این عملیات غیرقابل بازگشت است!`;

        await ctx.editMessageText(warning, { reply_markup: kb, parse_mode: "Markdown" });
        await ctx.answerCallbackQuery();
    });

    // Admin: Execute Event Deletion
    bot.callbackQuery(/^confirm_delete_ev_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });

        const eventId = ctx.match[1];

        try {
            // ۱. ابتدا تمام ثبت‌نام‌های مربوط به این رویداد را پاک می‌کنیم
            await getDb(ctx).prepare("DELETE FROM registrations WHERE event_id = ?").bind(eventId).run();

            // ۲. سپس خود رویداد را پاک می‌کنیم
            await getDb(ctx).prepare("DELETE FROM events WHERE id = ?").bind(eventId).run();

            await ctx.editMessageText("✅ رویداد و تمامی ثبت‌نام‌های مرتبط با آن با موفقیت از سیستم حذف شدند.", {
                reply_markup: new InlineKeyboard().text("🔙 بازگشت به لیست رویدادها", "adm_manage_events"),
            });
            await ctx.answerCallbackQuery({ text: "رویداد حذف شد.", show_alert: true });
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
        await ctx.reply("📢 لطفاً پیام خود را (متن یا عکس با کپشن) ارسال کنید تا برای **تمام تأییدشدگان این رویداد** ارسال شود:");
        await ctx.answerCallbackQuery();
    });

    // Admin: Receipt Approval Actions
    bot.callbackQuery(/^approve_pay_(\d+)_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const eventId = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2], 10);

        const { remaining } = await getRemainingCapacity(ctx, eventId);
        if (remaining <= 0) {
            await ctx.answerCallbackQuery({
                text: "⚠️ ظرفیت رویداد تکمیل شده است! فیش را تأیید نکنید و وجه را عودت دهید.",
                show_alert: true,
            });
            return;
        }

        await getDb(ctx)
            .prepare("UPDATE registrations SET status = 'approved' WHERE event_id = ? AND telegram_id = ?")
            .bind(eventId, targetUserId)
            .run();

        const ev = await getDb(ctx).prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<any>();

        // Send confirmation to User
        try {
            let msg = `🎉 پرداخت و ثبت‌نام شما در رویداد *${ev.title}* تأیید شد!\n\n`;
            msg += `🗓 **تاریخ:** ${ev.event_date}\n`;
            if (ev.format_type === "in_person") {
                msg += `📍 **مکان:** ${ev.location_or_link || "دانشکده کامپیوتر"}\n`;
            } else {
                msg += `🔗 **لینک جلسه:** ${ev.location_or_link || "قبل از شروع برای شما ارسال می‌شود"}\n`;
            }
            await ctx.api.sendMessage(targetUserId, msg, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Could not notify user:", e);
        }

        await ctx.editMessageCaption({
            caption: (ctx.msg?.caption || "") + "\n\n✅ **تأیید شد توسط ادمین**",
        });
        await ctx.answerCallbackQuery({ text: "ثبت‌نام تأیید شد." });
    });

    bot.callbackQuery(/^reject_pay_(\d+)_(\d+)$/, async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        const eventId = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2], 10);

        await getDb(ctx)
            .prepare("UPDATE registrations SET status = 'rejected' WHERE event_id = ? AND telegram_id = ?")
            .bind(eventId, targetUserId)
            .run();

        const ev = await getDb(ctx).prepare("SELECT title FROM events WHERE id = ?").bind(eventId).first<any>();

        try {
            await ctx.api.sendMessage(
                targetUserId,
                `❌ رسید ارسالی شما برای رویداد *${ev?.title}* توسط مدیریت رد شد. در صورت بروز اشتباه با ادمین تماس بگیرید.`,
                { parse_mode: "Markdown" }
            );
        } catch (e) {
            console.error("Could not notify user:", e);
        }

        await ctx.editMessageCaption({
            caption: (ctx.msg?.caption || "") + "\n\n❌ **رد شد توسط ادمین**",
        });
        await ctx.answerCallbackQuery({ text: "رسید رد شد." });
    });

    // Admin: Create Event Step-by-Step
    bot.callbackQuery("adm_new_event", async (ctx) => {
        if (!(await isAdmin(ctx, ctx.from!.id))) return ctx.answerCallbackQuery({ text: "دسترسی غیرمجاز!" });
        await setUserState(ctx, ctx.from!.id, "adm_ev_title", {});
        await ctx.reply("✏️ مرحله ۱ از ۸: لطفاً **عنوان رویداد** را ارسال کنید:");
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^adm_set_fee_(free|paid)$/, async (ctx) => {
        const feeType = ctx.match[1];
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        if (!state) return;

        state.data.event_type = feeType;
        if (feeType === "free") {
            state.data.price = 0;
            await setUserState(ctx, userId, "adm_ev_format", state.data);
            const kb = new InlineKeyboard()
                .text("🏢 حضوری", "adm_set_format_in_person")
                .text("🌐 آنلاین", "adm_set_format_online");
            await ctx.editMessageText("📍 مرحله ۵ از ۸: نحوه برگزاری را انتخاب کنید:", { reply_markup: kb });
        } else {
            await setUserState(ctx, userId, "adm_ev_price", state.data);
            await ctx.editMessageText("💰 مرحله ۴.۵: مبلغ هزینه را به **تومان** (فقط عدد) ارسال کنید:");
        }
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^adm_set_format_(in_person|online)$/, async (ctx) => {
        const format = ctx.match[1];
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        if (!state) return;

        state.data.format_type = format;
        await setUserState(ctx, userId, "adm_ev_location", state.data);

        const prompt = format === "in_person"
            ? "📍 مرحله ۶ از ۸: **محل دقیق برگزاری** را بنویسید (مثلاً: تالار آوینی دانشکده کامپیوتر):"
            : "🔗 مرحله ۶ از ۸: **لینک بستر آنلاین یا توضیح اتصال** را وارد کنید:";

        await ctx.editMessageText(prompt);
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery("adm_skip_poster", async (ctx) => {
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        if (!state) return;

        state.data.poster_file_id = null;
        await setUserState(ctx, userId, "adm_ev_fee_type", state.data);

        const kb = new InlineKeyboard()
            .text("🟢 رایگان", "adm_set_fee_free")
            .text("💳 پولی", "adm_set_fee_paid");

        await ctx.editMessageText("💰 مرحله ۴ از ۸: نوع هزینه رویداد را مشخص کنید:", { reply_markup: kb });
        await ctx.answerCallbackQuery();
    });

    // Global Back to main menu
    bot.callbackQuery("main_menu", async (ctx) => {
        await clearUserState(ctx, ctx.from!.id);
        await sendMainMenu(ctx);
        await ctx.answerCallbackQuery();
    });

    // ======================= Message Handling (FSM) =======================

    bot.on("message", async (ctx) => {
        const userId = ctx.from!.id;
        const state = await getUserState(ctx, userId);
        const text = ctx.message.text || "";

        if (!state) return; // Ignore messages if not in a specific state

        // 1. User Profile Setup FSM
        if (state.step === "reg_get_fullname") {
            await getDb(ctx).prepare("UPDATE users SET full_name = ? WHERE telegram_id = ?").bind(text, userId).run();
            await setUserState(ctx, userId, "reg_get_phone", state.data);

            const phoneKb = new Keyboard().requestContact("📱 ارسال شماره موبایل من").oneTime().resized();
            return ctx.reply("📱 لطفاً شماره همراه خود را وارد کنید یا دکمه زیر را لمس نمایید:", { reply_markup: phoneKb });
        }

        if (state.step === "reg_get_phone") {
            const phone = ctx.message.contact ? ctx.message.contact.phone_number : text;
            await getDb(ctx).prepare("UPDATE users SET phone = ? WHERE telegram_id = ?").bind(phone, userId).run();

            const user = await getDb(ctx).prepare("SELECT user_type FROM users WHERE telegram_id = ?").bind(userId).first<any>();
            await setUserState(ctx, userId, "reg_get_identifier", state.data);

            const label = user?.user_type === "ui_student" ? "شماره دانشجویی" : "کد ملی";
            return ctx.reply(`🔢 لطفاً **${label}** خود را وارد کنید:`, {
                reply_markup: { remove_keyboard: true },
            });
        }

        if (state.step === "reg_get_identifier") {
            await getDb(ctx).prepare("UPDATE users SET identifier = ? WHERE telegram_id = ?").bind(text, userId).run();
            const eventId = state.data.eventId;
            await clearUserState(ctx, userId);
            await ctx.reply("✅ اطلاعات حساب کاربری شما با موفقیت ذخیره شد.");
            return finalizeRegistration(ctx, eventId, userId);
        }

        // 2. Receipt Submission
        if (state.step === "reg_wait_receipt") {
            const photo = ctx.message.photo;
            if (!photo || photo.length === 0) {
                return ctx.reply("❌ لطفاً فیش واریزی را به صورت **عکس** بفرستید.");
            }
            const fileId = photo[photo.length - 1].file_id;
            const eventId = state.data.eventId;

            await getDb(ctx)
                .prepare(`
          INSERT INTO registrations (event_id, telegram_id, status, receipt_file_id) 
          VALUES (?, ?, 'pending', ?)
          ON CONFLICT(event_id, telegram_id) DO UPDATE SET status = 'pending', receipt_file_id = excluded.receipt_file_id
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

            let caption = `💳 **فیش واریزی جدید**\n\n`;
            caption += `📌 رویداد: *${ev?.title}*\n`;
            caption += `👤 کاربر: ${user?.full_name} (\`${userId}\`)\n`;
            caption += `📱 تلفن: ${user?.phone}\n`;
            caption += `🔢 شناسه: ${user?.identifier}\n`;

            for (const admId of adminIds) {
                try {
                    await ctx.api.sendPhoto(admId, fileId, { caption, parse_mode: "Markdown", reply_markup: kb });
                } catch (err) {
                    console.error(`Failed to send receipt to admin ${admId}`, err);
                }
            }
            return;
        }

        // 3. Admin: Settings & Manage Actions
        if (state.step === "admin_wait_card") {
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
            const newAdminId = parseInt(text.trim(), 10);
            if (isNaN(newAdminId)) return ctx.reply("لطفاً یک آیدی عددی معتبر ارسال کنید.");

            await getDb(ctx)
                .prepare(`
          INSERT INTO users (telegram_id, role) VALUES (?, 'admin')
          ON CONFLICT(telegram_id) DO UPDATE SET role = 'admin'
        `)
                .bind(newAdminId)
                .run();

            await clearUserState(ctx, userId);
            return ctx.reply(`✅ کاربر با شناسه \`${newAdminId}\` با موفقیت به عنوان مدیر ثبت شد.`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("🔙 مدیریت مدیران", "adm_manage_admins"),
            });
        }

        if (state.step === "adm_wait_new_cap") {
            const newCap = parseInt(text, 10);
            if (isNaN(newCap) || newCap <= 0) return ctx.reply("لطفاً یک عدد مثبت وارد کنید.");

            await getDb(ctx).prepare("UPDATE events SET capacity = ? WHERE id = ?").bind(newCap, state.data.eventId).run();
            await clearUserState(ctx, userId);
            return ctx.reply("✅ ظرفیت رویداد با موفقیت تغییر کرد.", {
                reply_markup: new InlineKeyboard().text("🔙 بازگشت به رویداد", `adm_ev_detail_${state.data.eventId}`),
            });
        }

        if (state.step === "adm_wait_broadcast_msg") {
            const eventId = state.data.eventId;
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

            let sentCount = 0;
            let errorCount = 0;
            for (const r of results) {
                try {
                    if (ctx.message.photo && ctx.message.photo.length > 0) {
                        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                        await ctx.api.sendPhoto(r.telegram_id, photoId, { caption: ctx.message.caption || "", caption_entities: ctx.message.caption_entities });
                    } else if (text) {
                        await ctx.api.sendMessage(r.telegram_id, text, { entities: ctx.message.entities });
                    }
                    sentCount++;
                } catch (e) {
                    errorCount++;
                    console.error(`Failed to broadcast to ${r.telegram_id}`, e);
                }
            }

            return ctx.reply(`📢 پیام با موفقیت به ${sentCount} نفر از شرکت‌کنندگان ارسال شد. (${errorCount} خطا)`, {
                reply_markup: new InlineKeyboard().text("🔙 پنل مدیریت", "admin_panel"),
            });
        }

        // 4. Admin: Event Creation FSM
        if (state.step === "adm_ev_title") {
            state.data.title = text;
            await setUserState(ctx, userId, "adm_ev_desc", state.data);
            return ctx.reply("📝 مرحله ۲ از ۸: **توضیحات رویداد** را ارسال کنید:");
        }

        if (state.step === "adm_ev_desc") {
            state.data.description = text;
            await setUserState(ctx, userId, "adm_ev_poster", state.data);
            const kb = new InlineKeyboard().text("رد کردن (بدون پوستر)", "adm_skip_poster");
            return ctx.reply("🖼 مرحله ۳ از ۸: **عکس پوستر رویداد** را ارسال کنید یا دکمه رد کردن را بزنید:", { reply_markup: kb });
        }

        // 4. Admin: Event Creation FSM
        if (state.step === "adm_ev_title") {
            state.data.title = text;
            await setUserState(ctx, userId, "adm_ev_desc", state.data);
            return ctx.reply("📝 مرحله ۲ از ۸: **توضیحات رویداد** را ارسال کنید:");
        }

        if (state.step === "adm_ev_desc") {
            state.data.description = text;
            await setUserState(ctx, userId, "adm_ev_poster", state.data);
            const kb = new InlineKeyboard().text("رد کردن (بدون پوستر)", "adm_skip_poster");
            return ctx.reply("🖼 مرحله ۳ از ۸: **عکس پوستر رویداد** را ارسال کنید یا دکمه رد کردن را بزنید:", { reply_markup: kb });
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
            const price = parseInt(text, 10);
            if (isNaN(price) || price < 0) return ctx.reply("لطفاً فقط عدد انگلیسی وارد کنید:");
            state.data.price = price;

            await setUserState(ctx, userId, "adm_ev_format", state.data);
            const kb = new InlineKeyboard()
                .text("🏢 حضوری", "adm_set_format_in_person")
                .text("🌐 آنلاین", "adm_set_format_online");
            return ctx.reply("📍 مرحله ۵ از ۸: نحوه برگزاری را انتخاب کنید:", { reply_markup: kb });
        }

        if (state.step === "adm_ev_location") {
            state.data.location_or_link = text;
            await setUserState(ctx, userId, "adm_ev_date", state.data);
            return ctx.reply("🗓 مرحله ۷ از ۸: **تاریخ و ساعت برگزاری** را وارد کنید (مثال: پنج‌شنبه ۲۵ آبان ساعت ۱۶):");
        }

        if (state.step === "adm_ev_date") {
            state.data.event_date = text;
            await setUserState(ctx, userId, "adm_ev_cap", state.data);
            return ctx.reply("👥 مرحله ۸ از ۸: **ظرفیت کل رویداد** را به عدد وارد کنید:");
        }

        if (state.step === "adm_ev_cap") {
            const cap = parseInt(text, 10);
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
            const botInfo = await ctx.api.getMe();
            const channelLink = `https://t.me/${botInfo.username}?start=event_${newId}`;

            await clearUserState(ctx, userId);

            let finalMsg = `🎉 **رویداد جدید با موفقیت ایجاد و منتشر شد!**\n\n`;
            finalMsg += `📌 عنوان: ${state.data.title}\n`;
            finalMsg += `🔗 **لینک ثبت‌نام جهت درج در کانال:**\n\`${channelLink}\``;

            return ctx.reply(finalMsg, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("🔙 پنل مدیریت", "admin_panel"),
            });
        }
    });

    return bot;
}

// ======================= Cloudflare Worker Fetch Handler =======================

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "GET") {
            return new Response("Telegram Events Bot is active!");
        }

        if (!env.BOT_TOKEN) {
            return new Response("BOT_TOKEN is missing", { status: 500 });
        }

        const bot = createBot(env.BOT_TOKEN, env);
        const handler = webhookCallback(bot, "cloudflare-mod", {
            onTimeout: "return",
            timeoutMilliseconds: 10_000,
        });

        return handler(request);
    },
};
