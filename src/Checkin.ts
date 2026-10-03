/*
 * ============================================================
 *  QR check-in add-on for the events bot
 * ============================================================
 *
 * 0) Install:        npm i uqr
 *    Secret:         npx wrangler secret put SCAN_SECRET     (a password only you know)
 *
 * 1) Migration (run once):
 *      npx wrangler d1 execute <DB_NAME> --remote --command "ALTER TABLE registrations ADD COLUMN qr_token TEXT"
 *      npx wrangler d1 execute <DB_NAME> --remote --command "ALTER TABLE registrations ADD COLUMN checked_in_at DATETIME"
 *      npx wrangler d1 execute <DB_NAME> --remote --command "CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_qr_token ON registrations(qr_token)"
 *
 * 2) In `Env` add:   SCAN_SECRET: string;
 *
 * 3) Keep this as a separate file (e.g. src/checkin.ts) and import it in the bot file:
 *      import { issueAndSendQr, handleScannerRoutes } from "./checkin";
 *    then apply the
 *    "INTEGRATION" edits listed at the bottom of this file.
 */

import { InputFile } from "grammy";
import { encode as qrEncode } from "uqr";
// Types only (erased at build time, so no circular import). Change "./index" to your bot file's name,
// and make sure `MyContext` is exported there: `export interface MyContext ...`
import type { Env, MyContext } from "./index";

const getDb = (ctx: MyContext): D1Database => ctx.db;

// ======================= QR -> PNG (no canvas needed) =======================

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

    // 8-bit grayscale, filter byte 0 at the start of every row
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

// ======================= Issue / send ticket =======================

function newToken(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Creates (once) the token for an approved registration and sends the QR to the user. */
export async function issueAndSendQr(ctx: MyContext, eventId: string | number, userId: number) {
    const db = getDb(ctx);

    // keep the old token if it already exists (re-approval must not create a second ticket)
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
        `🎫 *بلیت ورود: ${ev?.title ?? ""}*\n` +
        `🗓 ${ev?.event_date ?? ""}\n\n` +
        `این QR را روز رویداد هنگام ورود نشان دهید.\n` +
        `⚠️ هر کد فقط *یک‌بار* قابل استفاده است؛ آن را برای کسی ارسال نکنید.` +
        (reg.checked_in_at ? `\n\n❗️ این بلیت قبلاً استفاده شده است.` : "");

    await ctx.api.sendPhoto(userId, new InputFile(png, `ticket_${eventId}.png`), {
        caption,
        parse_mode: "Markdown",
    });
}

// ======================= Check-in API =======================

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

export async function handleScannerRoutes(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    const db = env.ceevents_db || env.DB!;

    if (url.pathname === "/scan" && request.method === "GET") {
        return new Response(SCANNER_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
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

        // Atomic: only one request can ever flip checked_in_at from NULL
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

// ======================= Scanner page (opens on your phone: https://<worker>/scan) =======================

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
  $("event").innerHTML = events.map(e => '<option value="'+e.id+'">'+e.title.replace(/</g,"&lt;")+'</option>').join("");
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

/*
 * ============================================================
 *  INTEGRATION (edits in your existing code)
 * ============================================================
 *
 * A) finalizeRegistration(), free-event branch: after the INSERT ... 'approved' and
 *    after ctx.reply(successMsg, ...), add:
 *
 *        await issueAndSendQr(ctx, eventId, userId);
 *
 * B) bot.callbackQuery(/^approve_pay_(\d+)_(\d+)$/): after the try/catch that notifies the user, add:
 *
 *        try { await issueAndSendQr(ctx, eventId, targetUserId); } catch (e) { console.error("QR send failed", e); }
 *
 *    Also fix a small race there: re-check status first so double-clicks don't re-approve.
 *
 * C) "my_registrations": for approved items add a button to re-send the ticket:
 *
 *        if (item.status === "approved") kb.text(`🎫 دریافت QR: ${item.title}`, `my_qr_${item.event_id}`).row();
 *
 *    and add the handler:
 *
 *        bot.callbackQuery(/^my_qr_(\d+)$/, async (ctx) => {
 *            const reg = await getDb(ctx)
 *                .prepare("SELECT status FROM registrations WHERE event_id = ? AND telegram_id = ?")
 *                .bind(ctx.match[1], ctx.from!.id).first<any>();
 *            if (reg?.status !== "approved") return ctx.answerCallbackQuery({ text: "ثبت‌نام تأیید شده‌ای ندارید.", show_alert: true });
 *            await issueAndSendQr(ctx, ctx.match[1], ctx.from!.id);
 *            await ctx.answerCallbackQuery();
 *        });
 *
 * D) The Worker's fetch handler: replace it with
 *
 *        export default {
 *            async fetch(request: Request, env: Env): Promise<Response> {
 *                const routed = await handleScannerRoutes(request, env);
 *                if (routed) return routed;
 *
 *                if (request.method === "GET") return new Response("Telegram Events Bot is active!");
 *                if (!env.BOT_TOKEN) return new Response("BOT_TOKEN is missing", { status: 500 });
 *
 *                const bot = createBot(env.BOT_TOKEN, env);
 *                return webhookCallback(bot, "cloudflare-mod", { onTimeout: "return", timeoutMilliseconds: 10_000 })(request);
 *            },
 *        };
 *
 * E) Housekeeping: in confirm_delete_ev_* nothing else changes (tokens live in registrations and are deleted with them).
 *    The duplicated "4. Admin: Event Creation FSM" block (adm_ev_title / adm_ev_desc appear twice) can be removed.
 */