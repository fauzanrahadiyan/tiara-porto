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
const dns = require("dns");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const IG_VER = () => clean(process.env.IG_GRAPH_VERSION) || "v23.0";
const IG = () => {
  const token = clean(process.env.IG_ACCESS_TOKEN), uid = clean(process.env.IG_USER_ID);
  const ver = IG_VER();
  const isEAA = token.startsWith("EAA"); // Page/User token Facebook Login → graph.facebook.com
  const primary = isEAA ? `https://graph.facebook.com/${ver}` : `https://graph.instagram.com/${ver}`;
  const alternate = isEAA ? `https://graph.instagram.com/${ver}` : `https://graph.facebook.com/${ver}`;
  return { token, uid, G: primary, primary, alternate, isEAA, ver, ok: !!(token && uid) };
};
function lookup4(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  return dns.lookup(hostname, { ...(typeof options === "object" ? options : {}), family: 4 }, cb);
}
function rawRequest(url, { method = "GET", headers = {}, body, ipv4 = false, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const opts = {
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search, method, headers, timeout,
    };
    if (ipv4) opts.lookup = lookup4;
    const req = lib.request(opts, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json = null; try { json = JSON.parse(text || "{}"); } catch (e) { json = { raw: text.slice(0, 500) }; }
        resolve({ status: res.statusCode || 0, headers: res.headers, json, buf, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function formatIgError(e, extra) {
  const parts = [e.message];
  if (e.error_user_title) parts.push(e.error_user_title);
  if (e.error_user_msg) parts.push(e.error_user_msg);
  parts.push(`[code ${e.code ?? "-"}${e.error_subcode ? "/" + e.error_subcode : ""}${e.type ? " " + e.type : ""}${e.fbtrace_id ? " trace " + e.fbtrace_id : ""}]`);
  if (e.code === 190) parts.push("→ Token IG kedaluwarsa/invalid: buat token baru & isi ulang IG_ACCESS_TOKEN di Vercel.");
  if (e.code === 10 || e.code === 200) parts.push("→ Izin kurang: pastikan instagram_content_publish / instagram_business_content_publish aktif.");
  if (Number(e.error_subcode) === 2207085 || Number(e.code) === -1) {
    parts.push("→ Meta 2207085 (internal). Cek di Meta Developer: App Mode Live, izin content_publish aktif, akun IG Business/Creator terhubung ke Page, token Page (EAA…) masih valid lewat /debug_token. Kalau Image OK tapi Reels gagal, biasanya bug/infra Meta atau jalur IPv6 — sistem sudah coba IPv4 + host alternatif + upload resumable.");
  }
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join(" — ");
}
function throwIg(j, extra) {
  const e = j.error || { message: "unknown" };
  const err = new Error("Instagram: " + formatIgError(e, extra));
  err.ig = e; throw err;
}
async function igAt(base, path, params = {}, method = "GET", { ipv4 = false } = {}) {
  const { token } = IG();
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${base.replace(/\/$/, "")}/${String(path).replace(/^\//, "")}${method === "GET" ? "?" + qs : ""}`;
  const headers = { "user-agent": "TiaraPortoBot/2.0 (+https://tiara.porto)", accept: "application/json" };
  let j;
  if (ipv4) {
    try {
      const body = method === "GET" ? undefined : Buffer.from(qs.toString());
      if (method !== "GET") Object.assign(headers, { "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) });
      const r = await rawRequest(url, { method, headers, body, ipv4: true });
      j = r.json || {};
    } catch (net) {
      // fallback ke fetch biasa kalau lookup IPv4 gagal di runtime
      const r = await fetch(url, method === "GET" ? { headers } : { method, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: qs });
      j = await r.json();
    }
  } else {
    const r = await fetch(url, method === "GET" ? { headers } : { method, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: qs });
    j = await r.json();
  }
  if (j.error) throwIg(j, ipv4 ? "[via IPv4]" : "");
  return j;
}
async function ig(path, params = {}, method = "GET") {
  return igAt(IG().primary, path, params, method, { ipv4: false });
}
function is2207085(err) {
  const g = (err && err.ig) || {};
  return Number(g.error_subcode) === 2207085 || /2207085/.test(String(err && err.message || "")) || (Number(g.code) === -1 && /fatal/i.test(String(g.message || "")));
}
/** media_publish dengan jalur alternatif: host utama → IPv4 → host cadangan IPv4 */
async function igPublish(uid, creationId) {
  const { primary, alternate } = IG();
  const tries = [
    { base: primary, ipv4: false, tag: "host-utama" },
    { base: primary, ipv4: true, tag: "host-utama+IPv4" },
    { base: alternate, ipv4: true, tag: "host-cadangan+IPv4" },
  ];
  let last = null;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    try {
      const j = await igAt(t.base, `${uid}/media_publish`, { creation_id: creationId }, "POST", { ipv4: t.ipv4 });
      j._via = t.tag; return j;
    } catch (e) {
      const wrapped = e; wrapped.message = `[${t.tag}] ` + e.message; last = wrapped;
      const code = Number((e.ig || {}).code);
      // di percobaan pertama: error selain internal/sudah-tayang langsung lempar
      if (i === 0 && !is2207085(e) && code !== 24) throw wrapped;
      // di percobaan berikutnya: host cadangan bisa ditolak token — lanjut saja
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw last || new Error("media_publish gagal tanpa detail");
}
/** Buat container Reels lewat upload resumable (Meta tarik video / binary), khusus token EAA + graph.facebook.com */
async function igResumableReel({ videoUrl, caption, coverUrl }) {
  const { token, uid, primary, isEAA, ver } = IG();
  if (!isEAA) {
    const err = new Error("Upload resumable butuh token Facebook Page (diawali EAA…). Token Instagram Login tidak mendukung rupload.facebook.com — buat ulang token lewat Facebook Login for Business / Graph API Explorer (Page token) lalu isi IG_ACCESS_TOKEN.");
    err.code = "NEED_EAA"; throw err;
  }
  const base = primary.includes("graph.facebook.com") ? primary : `https://graph.facebook.com/${ver}`;
  const body = { media_type: "REELS", upload_type: "resumable", caption: String(caption || "").slice(0, 2200) };
  if (coverUrl) body.cover_url = coverUrl;
  const created = await igAt(base, `${uid}/media`, body, "POST", { ipv4: true }).catch(e => {
    // beberapa app hanya terima di host facebook tanpa ipv4
    return igAt(base, `${uid}/media`, body, "POST", { ipv4: false });
  });
  if (!created.id) throw new Error("Resumable: container kosong — " + JSON.stringify(created).slice(0, 180));
  const uploadUri = created.uri || `https://rupload.facebook.com/ig-api-upload/${ver}/${created.id}`;
  // 1) coba file_url (Meta yang tarik dari Blob)
  let upOk = false, upLast = "";
  try {
    const r = await rawRequest(uploadUri, {
      method: "POST", ipv4: true, timeout: 120000,
      headers: { Authorization: `OAuth ${token}`, file_url: videoUrl, "user-agent": "TiaraPortoBot/2.0", accept: "application/json" },
    });
    if (r.json && r.json.success) upOk = true; else upLast = JSON.stringify(r.json || r.text).slice(0, 220);
  } catch (e) { upLast = e.message; }
  // 2) fallback: unduh video lalu kirim binary (batas ~95MB agar muat memori serverless)
  if (!upOk) {
    const vr = await fetch(videoUrl);
    if (!vr.ok) throw new Error("Resumable: gagal unduh video dari Blob (HTTP " + vr.status + ")");
    const buf = Buffer.from(await vr.arrayBuffer());
    if (buf.length > 95 * 1024 * 1024) throw new Error("Resumable: video " + Math.round(buf.length / 1048576) + "MB terlalu besar untuk upload binary di server (maks ~95MB). Kompres dulu atau pastikan file_url jalan. Detail file_url: " + upLast);
    const r = await rawRequest(uploadUri, {
      method: "POST", ipv4: true, timeout: 180000, body: buf,
      headers: {
        Authorization: `OAuth ${token}`, offset: "0", file_size: String(buf.length),
        "content-type": "application/octet-stream", "user-agent": "TiaraPortoBot/2.0",
        "content-length": String(buf.length),
      },
    });
    if (!(r.json && r.json.success)) throw new Error("Resumable upload gagal: " + JSON.stringify(r.json || r.text).slice(0, 240) + (upLast ? " | file_url: " + upLast : ""));
    upOk = true;
  }
  return { id: created.id, uri: uploadUri, method: "resumable" };
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
/** Upload buffer/stream ke Vercel Blob (URL publik stabil). Dipakai Mirror Reels agar Threads tidak gagal unduh CDN IG. */
async function putBlob(data, pathname, contentType) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN belum diisi di Vercel");
  const { put } = require("@vercel/blob");
  const r = await put(pathname || ("mirror/" + Date.now() + ".mp4"), data, {
    access: "public", contentType: contentType || "video/mp4", addRandomSuffix: true, token: process.env.BLOB_READ_WRITE_TOKEN
  });
  return r.url;
}
module.exports = { DURS, DEFAULT_CONFIG, getConfig, gemini, geminiFile, IG, ig, igAt, igPublish, igResumableReel, is2207085, notifyWA, notifyTG, ADMIN_EMAILS, makeSession, readSession, safeEq, body, code, rp, str, baseUrl, wib, clean, delBlob, putBlob, MODELS };
