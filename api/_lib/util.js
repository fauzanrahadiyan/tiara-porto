const crypto = require("crypto");
const db = require("./db");
const clean = s => (s || "").replace(/["'\s]/g, "");

// ===== Harga & pengaturan default (bisa diubah dari admin) =====
const DURS = [10, 15, 30, 60];
const DEFAULT_CONFIG = {
  prices: {
    "Iklan & UGC":    { hemat: [150000, 225000, 400000, 750000], premium: [300000, 450000, 825000, 1500000] },
    "Motion Graphic": { hemat: [125000, 200000, 350000, 600000], premium: [275000, 425000, 750000, 1350000] },
    "Cover Lagu":     { hemat: [0, 275000, 500000, 900000],       premium: [0, 500000, 900000, 1650000] },
    "Short Film":     { hemat: [0, 0, 600000, 1100000],           premium: [0, 0, 975000, 1800000] },
    "Lifestyle":      { hemat: [125000, 200000, 350000, 600000], premium: [275000, 425000, 750000, 1350000] },
  },
  revisiFee: { hemat: 50000, premium: 100000 },
  bank: { nama: "Bank BCA", norek: "0182164711", atasNama: "FAUZAN ARISTYO RAHADIYAN", catatan: "Transfer sesuai total, lalu upload bukti di halaman ini." },
  packages: {
    hemat: { name: "Paket Hemat", model: "Gemini Omni 1.1 Flash", res: "Full HD 1080p" },
    premium: { name: "Paket Premium", model: "Seedance 2.5", res: "720p, di-upscale ke Full HD 1080p" },
  },
};
async function getConfig() {
  const c = (await db.get("config")) || {};
  return { ...DEFAULT_CONFIG, ...c, prices: { ...DEFAULT_CONFIG.prices, ...(c.prices || {}) }, bank: { ...DEFAULT_CONFIG.bank, ...(c.bank || {}) }, revisiFee: { ...DEFAULT_CONFIG.revisiFee, ...(c.revisiFee || {}) } };
}

// ===== Gemini =====
const MODELS = () => [...new Set([clean(process.env.GEMINI_MODEL), "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"].filter(Boolean))];
async function gemini(parts, { json = false, timeout = 40000, search = false } = {}) {
  const key = clean(process.env.GEMINI_API_KEY);
  if (!key) throw new Error("GEMINI_API_KEY belum diisi");
  if (typeof parts === "string") parts = [{ text: parts }];
  let last = "", errs = [];
  const tries = search && !json ? [...MODELS().slice(0, 2).map(m => [m, true]), ...MODELS().map(m => [m, false])] : MODELS().map(m => [m, false]);
  for (const [model, useSearch] of tries) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: json ? { responseMimeType: "application/json" } : {}, ...(useSearch ? { tools: [{ google_search: {} }] } : {}) }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
      if (!txt) throw new Error("jawaban kosong");
      return json ? JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim()) : txt;
    } catch (e) { last = `${model}: ${e.name === "AbortError" ? "timeout" : e.message}`.slice(0, 160); errs.push(last); console.error("gemini", last); }
    finally { clearTimeout(tm); }
  }
  throw new Error("Gemini gagal (" + (errs.find(x => !/no longer available/.test(x)) || last) + ")");
}
// Upload video ke Gemini Files API lalu tunggu siap (untuk QC video)
async function geminiFile(url, mime = "video/mp4") {
  const key = clean(process.env.GEMINI_API_KEY);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const st = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`, {
    method: "POST", headers: { "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(buf.length), "X-Goog-Upload-Header-Content-Type": mime, "content-type": "application/json" },
    body: JSON.stringify({ file: { display_name: "qc-" + Date.now() } }),
  });
  const up = st.headers.get("x-goog-upload-url"); if (!up) throw new Error("Gagal mulai upload ke Gemini");
  const fj = await (await fetch(up, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf })).json();
  let f = fj.file; if (!f) throw new Error("Upload Gemini gagal: " + JSON.stringify(fj).slice(0, 150));
  for (let i = 0; i < 20 && f.state === "PROCESSING"; i++) { await new Promise(r => setTimeout(r, 2500)); f = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}?key=${key}`)).json(); }
  if (f.state !== "ACTIVE") throw new Error("Video belum siap diproses Gemini (" + f.state + "), coba lagi sebentar");
  return { file_data: { mime_type: f.mimeType || mime, file_uri: f.uri } };
}

// ===== Instagram Graph =====
const IG = () => {
  const token = clean(process.env.IG_ACCESS_TOKEN), uid = clean(process.env.IG_USER_ID);
  const G = token.startsWith("EAA") ? "https://graph.facebook.com/v23.0" : "https://graph.instagram.com/v23.0";
  return { token, uid, G, ok: !!(token && uid) };
};
async function ig(path, params = {}, method = "GET") {
  const { token, G } = IG();
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${G}/${path}${method === "GET" ? "?" + qs : ""}`, method === "GET" ? {} : { method, body: qs });
  const j = await r.json();
  if (j.error) throw new Error("Instagram: " + j.error.message);
  return j;
}

// ===== Notifikasi Telegram (gratis) =====
async function notifyTG(text) {
  const tok = clean(process.env.TELEGRAM_BOT_TOKEN);
  if (!tok) return null;
  try {
    let chat = clean(process.env.TELEGRAM_CHAT_ID) || await db.get("tg_chat_id");
    if (!chat) {
      const u = await (await fetch(`https://api.telegram.org/bot${tok}/getUpdates`)).json();
      const last = (u.result || []).reverse().find(x => x.message && x.message.chat);
      if (!last) return { ok: false, msg: "Kirim pesan 'halo' dulu ke bot Telegram-mu" };
      chat = String(last.message.chat.id); await db.set("tg_chat_id", chat);
    }
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    return { ok: r.ok, via: "telegram" };
  } catch (e) { console.error("tg", e.message); return { ok: false, msg: e.message }; }
}

// ===== Notifikasi ke Fauzan: Telegram dulu, lalu WA CallMeBot =====
async function notifyWA(text) {
  const tg = await notifyTG(text);
  if (tg && tg.ok) return tg;
  const key = clean(process.env.CALLMEBOT_APIKEY);
  const phone = clean(process.env.ADMIN_WA || "6287702700618");
  if (!key) return tg || { ok: false, msg: "TELEGRAM_BOT_TOKEN / CALLMEBOT_APIKEY belum diisi" };
  try {
    const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`);
    return { ok: r.ok };
  } catch (e) { console.error("wa", e.message); return { ok: false, msg: e.message }; }
}

// ===== Login admin =====
const ADMIN_EMAILS = () => (process.env.ADMIN_EMAILS || "fauzan.rahadiyan@gmail.com").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const secret = () => process.env.SESSION_SECRET || crypto.createHash("sha256").update("tp|" + (process.env.ADMIN_PASSWORD || "") + "|" + (process.env.CRON_SECRET || "") + "|" + clean(process.env.IG_ACCESS_TOKEN).slice(-12)).digest("hex");
const sign = s => crypto.createHmac("sha256", secret()).update(s).digest("base64url");
function makeSession(who) { const p = Buffer.from(JSON.stringify({ who, exp: Date.now() + 7 * 864e5 })).toString("base64url"); return p + "." + sign(p); }
function readSession(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)tp_adm=([^;]+)/); if (!m) return null;
  const [p, s] = m[1].split("."); if (!p || !s) return null;
  const a = Buffer.from(sign(p)), b = Buffer.from(s); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch (e) { return null; }
}
const safeEq = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

// ===== Lain-lain =====
async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch (e) { r({}); } }); });
}
const code = () => "TP-" + crypto.randomBytes(5).toString("base64").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) + crypto.randomInt(10, 99);
const rp = n => "Rp" + Number(n || 0).toLocaleString("id-ID");
const str = (s, n = 2000) => String(s == null ? "" : s).slice(0, n);
const baseUrl = req => (process.env.SITE_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`).replace(/\/$/, "");
const wib = (d = new Date()) => new Date(d.getTime() + 7 * 36e5); // pakai getUTC* untuk jam WIB

async function delBlob(url) {
  if (!url || !process.env.BLOB_READ_WRITE_TOKEN || !/blob\.vercel-storage\.com/.test(url)) return;
  try { const { del } = require("@vercel/blob"); await del(url); } catch (e) { console.error("del blob", e.message); }
}
module.exports = { DURS, DEFAULT_CONFIG, getConfig, gemini, geminiFile, IG, ig, notifyWA, notifyTG, ADMIN_EMAILS, makeSession, readSession, safeEq, body, code, rp, str, baseUrl, wib, clean, delBlob, MODELS };
