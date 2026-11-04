// Threads (Meta) — hubungkan akun, crosspost Reels, balas komentar, posting teks harian.
const db = require("./db");
const U = require("./util");
const G = "https://graph.threads.net";
const env = () => ({ id: (process.env.THREADS_APP_ID || "").trim(), secret: (process.env.THREADS_APP_SECRET || "").trim() });
const redirect = () => (process.env.THREADS_REDIRECT_URI || "https://tiara-porto.vercel.app/threads-callback").trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = () => U.wib().toISOString().slice(0, 10);
const DEF = { crosspost: true, replies: false, replyMode: "review", daily: false, dailyMode: "auto", maxPerHour: 30 };
async function thSettings() { return { ...DEF, ...((await db.get("th_settings")) || {}) }; }

// ---------- OAUTH ----------
async function thAuthUrl() {
  const e = env(); if (!e.id || !e.secret) throw new Error("THREADS_APP_ID / THREADS_APP_SECRET belum diisi di Vercel");
  const state = require("crypto").randomBytes(12).toString("hex"); await db.set("th_state", state, 900);
  return "https://threads.net/oauth/authorize?" + new URLSearchParams({ client_id: e.id, redirect_uri: redirect(), scope: "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies", response_type: "code", state });
}
async function jget(url) { const j = await (await fetch(url)).json(); if (j.error) throw new Error("Threads: " + (j.error.message || j.error.type || "error")); return j; }
async function thCallback(q) {
  if (q.error) throw new Error(q.error_description || q.error);
  const st = await db.get("th_state"); if (!q.state || !st || q.state !== st) throw new Error("State Threads tidak cocok, ulangi tombol Hubungkan");
  await db.del("th_state"); const e = env();
  const r = await (await fetch(G + "/oauth/access_token", { method: "POST", body: new URLSearchParams({ client_id: e.id, client_secret: e.secret, grant_type: "authorization_code", redirect_uri: redirect(), code: String(q.code || "").replace(/#_$/, "") }) })).json();
  if (!r.access_token) throw new Error("Threads: " + (r.error_message || r.error?.message || "gagal tukar kode"));
  const l = await jget(G + "/access_token?" + new URLSearchParams({ grant_type: "th_exchange_token", client_secret: e.secret, access_token: r.access_token }));
  const t = { access_token: l.access_token, exp: Date.now() + (l.expires_in || 5184000) * 1000, at: Date.now() };
  try { const me = await jget(G + "/v1.0/me?fields=id,username&access_token=" + t.access_token); t.uid = me.id; t.user = me.username; } catch (x) {}
  await db.set("th_token", t); return t;
}
async function token() {
  let t = await db.get("th_token"); if (!t) throw new Error("Threads belum dihubungkan");
  if (t.exp - Date.now() < 7 * 864e5 && Date.now() - (t.at || 0) > 864e5) { // perpanjang token (berlaku 60 hari)
    try { const r = await jget(G + "/refresh_access_token?grant_type=th_refresh_token&access_token=" + t.access_token); t = { ...t, access_token: r.access_token, exp: Date.now() + (r.expires_in || 5184000) * 1000, at: Date.now() }; await db.set("th_token", t); }
    catch (e) { if (t.exp < Date.now()) throw new Error("Token Threads kedaluwarsa, klik Hubungkan ulang"); }
  }
  return t;
}
async function th(path, params = {}, method = "GET") {
  const t = await token(); const p = new URLSearchParams({ ...params, access_token: t.access_token });
  const r = method === "GET" ? await fetch(`${G}/v1.0/${path}?${p}`) : await fetch(`${G}/v1.0/${path}`, { method, body: p });
  const j = await r.json(); if (j.error) throw new Error("Threads: " + (j.error.message || "error")); return j;
}
async function thStatus() {
  const e = env(), t = await db.get("th_token");
  return { env: !!(e.id && e.secret), connected: !!t, user: t?.user || "", exp: t?.exp || 0, settings: await thSettings(), texts: ((await db.get("th_texts")) || []).slice(0, 10) };
}
// buat container → tunggu FINISHED → publish. Kembalikan {id} atau {pending:containerId}
async function publish(params, waitLoops = 6) {
  const c = params.creation_id ? { id: params.creation_id } : await th("me/threads", params, "POST");
  for (let i = 0; i < waitLoops; i++) {
    const s = await th(c.id, { fields: "status,error_message" });
    if (s.status === "FINISHED") { const p = await th("me/threads_publish", { creation_id: c.id }, "POST"); return { id: p.id }; }
    if (s.status === "ERROR" || s.status === "EXPIRED") throw new Error("Threads menolak: " + (s.error_message || s.status));
    await sleep(params.media_type === "TEXT" ? 1500 : 4000);
  }
  return { pending: c.id };
}

// ---------- CROSSPOST REELS ----------
async function thMark(it) { // dipanggil setelah Reels tayang; true = video jangan dihapus dulu
  const s = await thSettings(); if (!s.crosspost) return false;
  if (!env().id || !(await db.get("th_token"))) return false;
  it.th = { status: "pending", log: "Menunggu kirim ke Threads" }; return true;
}
async function thCaption(cap) {
  try {
    const t = await U.gemini(`Ubah caption Instagram Reels berikut jadi teks Threads untuk Tiara (@tiara_ai_influencer, AI influencer cewek Suroboyo, sopan, halal).
Aturan: maks 400 karakter, 1-3 kalimat santai bahasa Indonesia campur logat Suroboyo (rek, isok, ae, cak), boleh 1-2 emoji, maks 2 hashtag. JANGAN menambah fakta, nomor episode, atau info yang tidak ada di caption asli. Hapus ajakan "komen Tiara"/ManyChat. Tulis teksnya saja.
Caption asli: """${String(cap || "").slice(0, 1500)}"""`);
    return t.trim().slice(0, 500);
  } catch (e) { return String(cap || "").slice(0, 500); }
}
async function threadsDue() {
  const q = (await db.get("queue")) || []; const done = [];
  for (const it of q) {
    if (!it.th || !["pending", "processing"].includes(it.th.status)) continue;
    try {
      if (it.th.status === "pending") {
        if (it.videoDeleted) throw Object.assign(new Error("Video sudah dihapus dari penyimpanan"), { fatal: 1 });
        it.th.caption = it.th.caption || await thCaption(it.caption);
        const c = await th("me/threads", { media_type: "VIDEO", video_url: it.videoUrl, text: it.th.caption }, "POST");
        it.th = { ...it.th, status: "processing", container: c.id, log: "Diproses Threads…" };
      }
      const r = await publish({ creation_id: it.th.container });
      if (r.id) { it.th.status = "posted"; it.th.postId = r.id; it.th.at = Date.now(); it.th.log = "Terposting di Threads ✅"; }
    } catch (e) { it.th.tries = (it.th.tries || 0) + 1; it.th.log = e.message; if (e.fatal || it.th.tries >= 3 || /menolak/.test(e.message)) it.th.status = "failed"; }
    const ttBusy = it.tt && ["pending", "processing"].includes(it.tt.status);
    if (["posted", "failed"].includes(it.th.status) && !ttBusy && !it.videoDeleted) { await U.delBlob(it.videoUrl); it.videoDeleted = true; }
    done.push({ id: it.id, th: it.th.status, log: it.th.log }); break; // 1 per putaran
  }
  if (done.length) await db.set("queue", q);
  return { done };
}

// ---------- BALAS KOMENTAR THREADS ----------
async function processReplies(maxReplies = 5) {
  const s = await thSettings(); if (!s.replies) return { msg: "Balas Threads OFF" };
  const t = await token(); const me = t.user;
  const C = require("./content");
  const seen = new Set((await db.get("th_seen")) || []);
  const pending = (await db.get("cpending")) || [], flagged = (await db.get("cflagged")) || [], hist = (await db.get("chistory")) || [];
  const posts = (await th("me/threads", { fields: "id,text,timestamp", limit: 8 })).data || [];
  const since = Date.now() - 3 * 864e5; let replied = 0, checked = 0;
  for (const m of posts) {
    if (replied >= maxReplies || checked >= 10) break;
    if (Date.parse(m.timestamp) < Date.now() - 14 * 864e5) continue;
    const conv = ((await th(`${m.id}/conversation`, { fields: "id,text,username,timestamp,replied_to", limit: 50 })).data || []).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const x of conv) {
      if (replied >= maxReplies || checked >= 10) break;
      if (seen.has(x.id)) continue; seen.add(x.id);
      if (x.username === me || !x.text || Date.parse(x.timestamp) < since) continue;
      const root = x.replied_to?.id && x.replied_to.id !== m.id ? x.replied_to.id : x.id; // utas = balasan teratas
      const parentMine = !x.replied_to || x.replied_to.id === m.id || conv.some(y => y.id === x.replied_to.id && y.username === me);
      if (!parentMine && !new RegExp("@" + me.replace(/[.]/g, "\\.") + "\\b", "i").test(x.text)) continue; // bukan untuk Tiara
      if (conv.some(y => y.username === me && y.replied_to?.id === x.id)) continue; // sudah dibalas
      const tKey = "ththread:" + root; let n = Number(await db.get(tKey)) || 0; if (n >= 2) continue;
      checked++;
      let r; try { r = await C.classify({ username: x.username, text: x.text }, m.text); } catch (e) { seen.delete(x.id); break; }
      let reply = r.balasan || ""; if (reply && !reply.toLowerCase().includes("@" + x.username.toLowerCase())) reply = `@${x.username} ${reply}`;
      const rec = { id: x.id, platform: "threads", media: m.id, user: x.username, text: x.text, t: Date.now(), reply: reply.slice(0, 500), reason: r.alasan || "", lead: !!r.calon_klien };
      if (r.aman !== "aman" || !rec.reply) { flagged.unshift(rec); continue; }
      n++; await db.set(tKey, n, 30 * 86400);
      if (s.replyMode !== "auto") { pending.unshift(rec); continue; }
      if (await db.incr("rl:threply:" + new Date().toISOString().slice(0, 13), 3700) > (s.maxPerHour || 30)) { pending.unshift(rec); break; }
      try { rec.replyId = (await thReply(x.id, rec.reply)).id; hist.unshift(rec); replied++; } catch (e) { rec.reason = e.message; flagged.unshift(rec); }
      await sleep(2000 + Math.random() * 3000);
    }
  }
  await db.set("th_seen", [...seen].slice(-3000)); await db.set("cpending", pending.slice(0, 200));
  await db.set("cflagged", flagged.slice(0, 200)); await db.set("chistory", hist.slice(0, 300));
  return { replied, checked };
}
async function thReply(replyToId, text) {
  const r = await publish({ media_type: "TEXT", text: String(text).slice(0, 500), reply_to_id: replyToId }, 5);
  if (!r.id) throw new Error("Balasan Threads masih diproses, coba lagi"); return r;
}

// ---------- POSTING TEKS HARIAN ----------
const SLOTS = ["12:00", "20:00"];
const SOFT = "Kursus Private AI Video Realistis — sudah dibuka, DM aja buat daftar";
async function writeText() {
  const recent = (await db.get("th_topics")) || [];
  const soft = Math.random() < 0.25;
  const r = await U.gemini(`Kamu Tiara (@tiara_ai_influencer), AI influencer cewek asal Suroboyo yang ramah, lucu, sopan, halal (tidak vulgar, tidak SARA, tidak politik). Tulis SATU postingan Threads (teks saja).
Tema: pilih salah satu — tips bikin video AI realistis (prompt, pencahayaan, gerakan, konsistensi wajah, suara), behind the scenes jadi AI influencer, atau celetukan lucu seputar dunia video AI.
Gaya: bahasa Indonesia santai campur logat Suroboyo (rek, cak, isok, ae, gak popo, yo), 1-4 kalimat, maks 400 karakter, boleh 1-2 emoji, maks 1 hashtag. Jangan menyebut nomor episode, harga, atau fakta yang dikarang.
${soft ? `Di akhir, selipkan ajakan HALUS (bukan jualan keras) yang bermakna: "${SOFT}". Boleh diparafrase santai, tapi tetap sebut "kursus private", bahwa sudah dibuka, dan DM untuk daftar. JANGAN pakai kata "kelas" dan JANGAN bilang "segera dibuka".` : `JANGAN menyebut kursus, kelas, atau ajakan beli apa pun.`}
Hindari topik yang mirip dengan ini: ${JSON.stringify(recent.slice(0, 20))}
Jawab JSON: {"topik":"2-5 kata","teks":"..."}`, { json: true });
  let text = String(r.teks || "").trim().replace(/\bkelas\b/gi, "kursus").replace(/segera dibuka/gi, "sudah dibuka").slice(0, 500);
  if (!text) throw new Error("Gemini tidak menghasilkan teks");
  await db.set("th_topics", [String(r.topik || text.slice(0, 40)), ...recent].slice(0, 20));
  return { id: require("crypto").randomBytes(5).toString("hex"), text, soft, t: Date.now() };
}
async function saveText(p) { const l = (await db.get("th_texts")) || []; const i = l.findIndex(x => x.id === p.id); if (i >= 0) l[i] = p; else l.unshift(p); await db.set("th_texts", l.slice(0, 60)); }
async function postText(p) {
  try { const r = await publish({ media_type: "TEXT", text: p.text }, 5); if (r.id) { p.status = "posted"; p.postId = r.id; p.log = "Terposting ✅"; } else { p.status = "failed"; p.log = "Masih diproses Threads, coba kirim ulang"; } }
  catch (e) { p.status = "failed"; p.log = e.message; }
  await saveText(p); return p;
}
async function textNow(review) { const p = await writeText(); if (review) { p.status = "review"; p.log = "Menunggu dicek"; await saveText(p); return p; } return postText(p); }
async function sendText(id, text) { const l = (await db.get("th_texts")) || []; const p = l.find(x => x.id === id); if (!p) throw new Error("Postingan tidak ada"); if (text) p.text = U.str(text, 500); return postText(p); }
async function dailyText() {
  const s = await thSettings(); if (!s.daily) return { msg: "Posting teks OFF" };
  const now = U.wib(), hm = now.toISOString().slice(11, 16), today = ymd();
  for (const slot of SLOTS) {
    if (hm < slot || hm > slot.replace(/^(\d\d)/, h => String(+h + 2).padStart(2, "0"))) continue; // jendela 2 jam
    const key = `th_daily:${today}:${slot}`; if (await db.get(key)) continue;
    await db.set(key, 1, 2 * 86400);
    const p = await textNow(s.dailyMode === "review");
    if (p.status === "review") await U.notifyWA("🧵 Ada draft Threads Tiara menunggu dicek di admin:\n" + p.text.slice(0, 200));
    return { slot, status: p.status };
  }
  return { msg: "Belum jamnya" };
}
async function cronJobs() {
  if (!env().id || !(await db.get("th_token"))) return { msg: "Threads belum terhubung" };
  const out = {};
  for (const [k, fn] of [["post", threadsDue], ["text", dailyText], ["replies", processReplies]]) { try { out[k] = await fn(); } catch (e) { out[k] = { error: e.message }; } }
  return out;
}
module.exports = { thSettings, thStatus, thAuthUrl, thCallback, thMark, threadsDue, processReplies, thReply, textNow, sendText, saveText, cronJobs };
