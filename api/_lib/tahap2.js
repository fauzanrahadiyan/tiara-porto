// Tahap 2: repost TikTok, tren harian, laporan Senin, untung-rugi.
const db = require("./db");
const U = require("./util");
const ymd = d => U.wib(d).toISOString().slice(0, 10);
const PAID = ["paid", "production", "preview", "accepted", "done"];

// ================= TIKTOK =================
const TT = "https://open.tiktokapis.com/v2";
const ttEnv = () => ({ key: U.clean(process.env.TIKTOK_CLIENT_KEY), sec: U.clean(process.env.TIKTOK_CLIENT_SECRET) });
const ttRedirect = () => (process.env.TIKTOK_REDIRECT_URI || (process.env.SITE_URL || "https://tiara-porto.vercel.app").replace(/\/$/, "") + "/api/admin?action=tiktok_callback").trim();
const DEF_TT = { enabled: false, privacy: "SELF_ONLY" };
async function ttSettings() { return { ...DEF_TT, ...((await db.get("tt_settings")) || {}) }; }
async function ttStatus() {
  const e = ttEnv(), s = await ttSettings(), t = await db.get("tt_token");
  return { env: !!(e.key && e.sec), connected: !!(t && t.refresh_token && t.refresh_exp > Date.now()), user: t && t.user, settings: s, redirect: ttRedirect() };
}
async function ttAuthUrl() {
  const e = ttEnv(); if (!e.key || !e.sec) throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET belum diisi di Vercel");
  const state = require("crypto").randomBytes(12).toString("hex"); await db.set("tt_state", state, 900);
  return "https://www.tiktok.com/v2/auth/authorize/?" + new URLSearchParams({ client_key: e.key, scope: "user.info.basic,video.publish", response_type: "code", redirect_uri: ttRedirect(), state });
}
async function ttTokenReq(params) {
  const e = ttEnv();
  const r = await fetch(TT + "/oauth/token/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: e.key, client_secret: e.sec, ...params }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("TikTok: " + (j.error_description || j.error || JSON.stringify(j).slice(0, 150)));
  const old = (await db.get("tt_token")) || {};
  const t = { ...old, access_token: j.access_token, refresh_token: j.refresh_token || old.refresh_token, open_id: j.open_id || old.open_id, exp: Date.now() + (j.expires_in || 86400) * 1000 - 6e4, refresh_exp: Date.now() + (j.refresh_expires_in || 365 * 86400) * 1000 };
  await db.set("tt_token", t); return t;
}
async function ttCallback(q) {
  const st = await db.get("tt_state");
  if (!q.state || !st || q.state !== st) throw new Error("State TikTok tidak cocok, ulangi tombol Hubungkan");
  if (q.error) throw new Error("TikTok: " + (q.error_description || q.error));
  await db.del("tt_state");
  const t = await ttTokenReq({ code: String(q.code || ""), grant_type: "authorization_code", redirect_uri: ttRedirect() });
  try { const u = await (await fetch(TT + "/user/info/?fields=display_name,avatar_url", { headers: { Authorization: "Bearer " + t.access_token } })).json(); t.user = u.data?.user?.display_name || ""; await db.set("tt_token", t); } catch (e) {}
  return t;
}
async function ttAccess() {
  let t = await db.get("tt_token"); if (!t || !t.refresh_token) throw new Error("TikTok belum dihubungkan");
  if (t.exp < Date.now()) t = await ttTokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  return t.access_token;
}
async function ttApi(path, body) {
  const r = await fetch(TT + path, { method: "POST", headers: { Authorization: "Bearer " + await ttAccess(), "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (j.error && j.error.code && j.error.code !== "ok") throw new Error("TikTok: " + (j.error.message || j.error.code));
  return j.data || {};
}
async function ttCaption(cap) {
  try {
    const t = await U.gemini(`Ubah caption Instagram Reels berikut jadi caption TikTok untuk @tiara_ai_influencer (AI influencer cewek Suroboyo, sopan, halal).
Aturan: maks 300 karakter, 1-2 kalimat santai logat Suroboyo campur Indonesia, 1-2 emoji, 4-6 hashtag gaya TikTok (#fyp #aiinfluencer #tiaraai #suroboyo dll). JANGAN menambah fakta, nomor episode, atau info yang tidak ada di caption asli. Hapus ajakan "komen Tiara"/ManyChat. Tulis captionnya saja.
Caption asli: """${String(cap || "").slice(0, 1500)}"""`);
    return t.slice(0, 2000);
  } catch (e) { return String(cap || "").slice(0, 2000); }
}
// Panggil setelah Reels IG tayang. Kembalikan true jika video harus disimpan dulu untuk TikTok.
async function ttMark(it) {
  const s = await ttSettings(); if (!s.enabled) return false;
  const st = await ttStatus(); if (!st.env || !st.connected) { it.tt = { status: "skip", log: "TikTok belum terhubung" }; return false; }
  it.tt = { status: "pending", log: "Menunggu kirim ke TikTok" }; return true;
}
async function ttStep(it) {
  const s = await ttSettings();
  if (it.tt.status === "pending") {
    if (it.videoDeleted) { it.tt = { status: "failed", log: "Video sudah dihapus dari penyimpanan" }; return it; }
    const buf = Buffer.from(await (await fetch(it.videoUrl)).arrayBuffer()); const size = buf.length;
    let chunk = size, total = 1;
    if (size > 64 * 1024 * 1024) { chunk = 10 * 1024 * 1024; total = Math.floor(size / chunk); }
    let privacy = s.privacy || "SELF_ONLY";
    try { const ci = await ttApi("/post/publish/creator_info/query/"); if (ci.privacy_level_options && !ci.privacy_level_options.includes(privacy)) privacy = ci.privacy_level_options.includes("SELF_ONLY") ? "SELF_ONLY" : ci.privacy_level_options[0]; } catch (e) {}
    const title = it.tt.caption || await ttCaption(it.caption);
    const d = await ttApi("/post/publish/video/init/", { post_info: { title, privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false, is_aigc: true }, source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: total } });
    for (let i = 0; i < total; i++) {
      const a = i * chunk, b = i === total - 1 ? size : a + chunk;
      const r = await fetch(d.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(b - a), "Content-Range": `bytes ${a}-${b - 1}/${size}` }, body: buf.subarray(a, b) });
      if (!r.ok && r.status !== 206 && r.status !== 201) throw new Error("Upload TikTok gagal (" + r.status + ")");
    }
    it.tt = { status: "processing", publishId: d.publish_id, caption: title, privacy, log: "Diproses TikTok…" };
  }
  if (it.tt.status === "processing") {
    for (let i = 0; i < 4; i++) {
      const r = await ttApi("/post/publish/status/fetch/", { publish_id: it.tt.publishId });
      if (r.status === "PUBLISH_COMPLETE" || r.status === "SEND_TO_USER_INBOX") {
        it.tt.status = "posted"; it.tt.at = Date.now();
        it.tt.log = it.tt.privacy === "SELF_ONLY" ? "Terposting di TikTok (privat/Hanya saya) ✅" : "Terposting di TikTok ✅";
        await U.notifyWA(`🎵 Video juga sudah terkirim ke TikTok${it.tt.privacy === "SELF_ONLY" ? " (masih PRIVAT — buka TikTok, ubah ke Publik)" : ""}\n${(it.caption || "").split("\n")[0].slice(0, 80)}`);
        return it;
      }
      if (r.status === "FAILED") { it.tt.status = "failed"; it.tt.log = "TikTok menolak: " + (r.fail_reason || "-"); return it; }
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  return it;
}
async function tiktokDue(onlyId) {
  const q = (await db.get("queue")) || []; const done = [];
  for (const it of q) {
    if (!it.tt || !["pending", "processing"].includes(it.tt.status)) continue;
    if (onlyId && it.id !== onlyId) continue;
    try { await ttStep(it); } catch (e) { it.tt.tries = (it.tt.tries || 0) + 1; it.tt.log = e.message; if (it.tt.tries >= 3) { it.tt.status = "failed"; await U.notifyWA("⚠️ Gagal kirim ke TikTok: " + e.message.slice(0, 200)); } }
    if (["posted", "failed"].includes(it.tt.status) && !it.videoDeleted) { await U.delBlob(it.videoUrl); it.videoDeleted = true; }
    done.push({ id: it.id, tt: it.tt.status, log: it.tt.log });
    if (done.length >= 1) break; // 1 video per putaran (batas waktu)
  }
  if (done.length) await db.set("queue", q);
  return { done };
}

// ================= UNTUNG-RUGI =================
const DEF_COST = { premiumPer30: 152700, hematPer10: 10040, fixedMonthly: 500000, fixedLabel: "Langganan Grok Imagine" };
async function costSettings() { return { ...DEF_COST, ...((await db.get("cost_settings")) || {}) }; }
const orderCost = (o, c) => Math.round(o.pkg === "premium" ? c.premiumPer30 * (+o.dur || 0) / 30 : c.hematPer10 * (+o.dur || 0) / 10);
async function allOrders() {
  const idx = (await db.get("orders")) || []; const list = [];
  for (const c of idx.slice(0, 300)) { const o = await db.get("order:" + c); if (o) list.push(o); }
  return list;
}
const mon = t => ymd(new Date(t)).slice(0, 7);
async function profit(month) {
  month = /^\d{4}-\d{2}$/.test(month || "") ? month : mon(Date.now());
  const c = await costSettings(), orders = await allOrders(), exp = (await db.get("expenses")) || [];
  const rows = orders.filter(o => PAID.includes(o.status) && o.paidAt && mon(o.paidAt) === month)
    .map(o => ({ code: o.code, name: o.name, pkg: o.pkg, dur: o.dur, t: o.paidAt, income: o.price, cost: o.cost != null ? o.cost : orderCost(o, c) }));
  const manual = exp.filter(e => e.month === month);
  const fixed = month <= mon(Date.now()) ? +c.fixedMonthly || 0 : 0;
  const income = rows.reduce((a, r) => a + r.income, 0), modalOrder = rows.reduce((a, r) => a + r.cost, 0), modalManual = manual.reduce((a, e) => a + e.amount, 0);
  const modal = modalOrder + modalManual + fixed;
  const months = [...new Set([mon(Date.now()), ...orders.filter(o => o.paidAt).map(o => mon(o.paidAt)), ...exp.map(e => e.month)])].sort().reverse();
  return { month, months, settings: c, rows, manual, fixed, income, modalOrder, modalManual, modal, net: income - modal };
}
async function addExpense(b) {
  const amount = Math.round(+b.amount || 0); if (amount <= 0) throw new Error("Jumlah harus lebih dari 0");
  const exp = (await db.get("expenses")) || [];
  const month = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : mon(Date.now());
  exp.unshift({ id: require("crypto").randomBytes(5).toString("hex"), month, t: Date.now(), desc: U.str(b.desc, 120) || "Pengeluaran", amount });
  await db.set("expenses", exp.slice(0, 1000));
}
async function delExpense(id) { const exp = (await db.get("expenses")) || []; await db.set("expenses", exp.filter(e => e.id !== id)); }

// ================= TREN HARIAN & LAPORAN SENIN =================
async function trendNow() {
  const today = ymd();
  const txt = await U.gemini(`Hari ini ${today}. Kamu analis tren konten untuk Tiara (@tiara_ai_influencer), AI influencer cewek asal Suroboyo yang punya serial anime "TIARA ANGEL WOMAN". Konten harus sopan & halal.
Cari tren TERBARU (minggu ini) di Instagram Reels, TikTok, dan konten video AI (tren audio/lagu, format, challenge, topik ramai di Indonesia).
Tulis dalam bahasa Indonesia santai, maks 220 kata, format teks biasa (tanpa markdown tebal):
TREN HARI INI:
- 3-5 poin singkat
3 IDE KONTEN TIARA:
1. ... (judul + 1 kalimat cara eksekusi, logat Suroboyo boleh)
2. ...
3. ...
Jangan mengarang data angka. Jika tidak yakin, sebut "perkiraan".`, { search: true, timeout: 45000 });
  const rec = { date: today, text: txt.slice(0, 3500), at: Date.now() };
  await db.set("trend_latest", rec);
  const h = (await db.get("trend_hist")) || []; await db.set("trend_hist", [rec, ...h.filter(x => x.date !== today)].slice(0, 14));
  await U.notifyWA("📈 TREN HARIAN TIARA (" + today + ")\n\n" + rec.text);
  return rec;
}
async function weeklyNow() {
  const to = Date.now(), from = to - 7 * 864e5, c = await costSettings();
  const q = (await db.get("queue")) || [], hist = (await db.get("chistory")) || [], orders = await allOrders(), exp = (await db.get("expenses")) || [];
  const reels = q.filter(x => x.postedAt >= from).length, tiktok = q.filter(x => x.tt && x.tt.at >= from).length;
  const replied = hist.filter(x => x.t >= from).length;
  const ordersIn = orders.filter(o => o.createdAt >= from).length;
  const paid = orders.filter(o => PAID.includes(o.status) && o.paidAt >= from);
  const revenue = paid.reduce((a, o) => a + o.price, 0), costO = paid.reduce((a, o) => a + (o.cost != null ? o.cost : orderCost(o, c)), 0);
  const costM = exp.filter(e => e.t >= from).reduce((a, e) => a + e.amount, 0), costF = Math.round((+c.fixedMonthly || 0) * 7 / 30);
  const r = { from, to, date: ymd(), reels, tiktok, replied, ordersIn, paidCount: paid.length, revenue, cost: costO + costM + costF, costFixed: costF, profit: revenue - costO - costM - costF, at: Date.now() };
  await db.set("weekly_latest", r);
  const h = (await db.get("weekly_hist")) || []; await db.set("weekly_hist", [r, ...h.filter(x => x.date !== r.date)].slice(0, 12));
  await U.notifyWA(`📊 LAPORAN MINGGUAN TIARA PORTO\n${ymd(new Date(from))} s/d ${ymd(new Date(to))}\n\n🎬 Reels terposting: ${reels}\n🎵 Terkirim ke TikTok: ${tiktok}\n💬 Komentar dibalas: ${replied}\n🛒 Pesanan masuk: ${ordersIn} (lunas ${paid.length})\n💰 Pemasukan: ${U.rp(revenue)}\n🧾 Modal: ${U.rp(r.cost)} (termasuk jatah ${c.fixedLabel} ${U.rp(costF)})\n✅ Untung bersih: ${U.rp(r.profit)}`);
  return r;
}
// Dipanggil cron tiap 15 menit; hanya jalan sekali per hari/minggu.
async function dailyJobs() {
  const w = U.wib(), today = ymd(), out = {};
  if (w.getUTCDay() === 1 && w.getUTCHours() >= 7 && (await db.get("weekly_done")) !== today && await db.incr("lock:weekly:" + today, 600) === 1) {
    try { await weeklyNow(); await db.set("weekly_done", today); out.weekly = "terkirim"; } catch (e) { await db.del("lock:weekly:" + today); out.weekly = { error: e.message }; }
    return out; // satu tugas berat per putaran
  }
  if (w.getUTCHours() >= 6 && (await db.get("trend_done")) !== today && await db.incr("lock:trend:" + today, 600) === 1) {
    try { await trendNow(); await db.set("trend_done", today); out.trend = "terkirim"; } catch (e) { await db.del("lock:trend:" + today); out.trend = { error: e.message }; }
  }
  return out;
}
module.exports = { ttSettings, ttStatus, ttAuthUrl, ttCallback, ttMark, tiktokDue, costSettings, orderCost, profit, addExpense, delExpense, trendNow, weeklyNow, dailyJobs, DEF_COST };
