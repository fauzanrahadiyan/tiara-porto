// Konten Tiara: jam emas, antrean posting Reels, balas komentar otomatis.
const db = require("./db");
const U = require("./util");
const T = require("./tahap2");
const DEFAULT_SLOTS = ["12:15", "19:30"]; // 11.30-13.00 & 19.00-21.00 WIB
const DAY = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const ymd = d => U.wib(d).toISOString().slice(0, 10);

// ---------- JAM EMAS ----------
async function computeGolden(force) {
  const today = ymd();
  const cur = await db.get("golden");
  if (!force && cur && cur.date === today) return cur;
  const stats = {}; let online = null, source = "default", note = "";
  if (U.IG().ok) {
    try {
      const j = await U.ig(`${U.IG().uid}/media`, { fields: "id,timestamp,media_product_type,like_count,comments_count", limit: 40 });
      const items = (j.data || []).slice(0, 30);
      for (const m of items) {
        let views = 0;
        try { const ins = await U.ig(`${m.id}/insights`, { metric: "views,reach" }); for (const x of ins.data || []) views = Math.max(views, x.values?.[0]?.value || 0); } catch (e) {}
        const h = U.wib(new Date(m.timestamp)).getUTCHours();
        const s = stats[h] || (stats[h] = { n: 0, views: 0, likes: 0, comments: 0 });
        s.n++; s.views += views; s.likes += m.like_count || 0; s.comments += m.comments_count || 0;
      }
      try { const o = await U.ig(`${U.IG().uid}/insights`, { metric: "online_followers", period: "lifetime" }); online = o.data?.[0]?.values?.[0]?.value || null; } catch (e) {}
      if (items.length) source = "data";
    } catch (e) { note = e.message; }
  }
  let slots = null, reason = "";
  if (source === "data") {
    try {
      const r = await U.gemini(`Kamu analis Instagram Reels untuk akun AI influencer Indonesia @tiara_ai_influencer. Hari ini ${DAY[U.wib().getUTCDay()]} (${today}).
Data performa Reels per JAM POSTING (WIB): ${JSON.stringify(stats)}
Follower online per jam (UTC, bisa null): ${JSON.stringify(online)}
Tentukan 2-3 jam posting terbaik HARI INI (format HH:MM WIB, antara 06:00-23:00, jarak minimal 3 jam). Jika data sedikit, padukan dengan kebiasaan umum audiens Indonesia (11:30-13:00 dan 19:00-21:00).
Jawab JSON: {"slots":["HH:MM",...],"alasan":"1 kalimat bahasa Indonesia"}`, { json: true });
      slots = (r.slots || []).filter(s => /^\d{2}:\d{2}$/.test(s)).sort().slice(0, 3); reason = r.alasan || "";
    } catch (e) { note = e.message; }
  }
  if (!slots || !slots.length) { slots = DEFAULT_SLOTS; source = source === "data" ? "default (Gemini gagal)" : "default"; reason = reason || "Belum cukup data, pakai jam ramai umum Indonesia (11.30–13.00 & 19.00–21.00 WIB)."; }
  const g = { date: today, slots, reason, source, stats, note, at: Date.now() };
  await db.set("golden", g);
  return g;
}
// waktu UTC (ms) dari tanggal WIB 'YYYY-MM-DD' + 'HH:MM'
const slotTime = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);

async function autoSchedule() {
  const q = (await db.get("queue")) || [];
  const g = await computeGolden();
  const taken = new Set(q.filter(x => x.scheduledAt && ["scheduled", "processing"].includes(x.status)).map(x => x.scheduledAt));
  let changed = false;
  for (const it of q) {
    if (it.status !== "queued") continue;
    for (let d = 0; d < 60 && !it.scheduledAt; d++) {
      const date = ymd(new Date(Date.now() + d * 864e5));
      for (const s of g.slots) { const t = slotTime(date, s); if (t > Date.now() + 5 * 6e4 && !taken.has(t)) { it.scheduledAt = t; it.status = "scheduled"; taken.add(t); changed = true; break; } }
    }
  }
  if (changed) await db.set("queue", q);
  return q;
}

// ---------- PUBLISH REELS (bertahap, aman untuk batas waktu serverless) ----------
async function checkVideoUrl(url) {
  if (!url) return "Link video kosong — upload ulang videonya.";
  if (!/^https:\/\//i.test(url)) return "Link video bukan HTTPS publik (" + String(url).slice(0, 60) + ") — Instagram hanya bisa ambil video dari link https publik. Pastikan BLOB_READ_WRITE_TOKEN terisi di Vercel lalu upload ulang.";
  try {
    let r = await fetch(url, { method: "HEAD" });
    if (r.status === 405 || r.status === 403) r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
    if (r.status === 404) return "Video sudah tidak ada di penyimpanan (404) — upload ulang videonya.";
    if (!r.ok && r.status !== 206) return "Link video tidak bisa dibuka Instagram (HTTP " + r.status + ") — upload ulang videonya.";
    const type = String(r.headers.get("content-type") || "").toLowerCase();
    let size = Number(r.headers.get("content-length") || 0);
    const cr = r.headers.get("content-range"); if (cr && /\/(\d+)/.test(cr)) size = Number(cr.match(/\/(\d+)/)[1]);
    if (type && !/^video\/(mp4|quicktime)/.test(type)) return "File bukan video MP4/MOV (tipe: " + type + ") — export ulang jadi MP4 (H.264 + AAC).";
    if (size && size > 300 * 1024 * 1024) return "Ukuran video " + Math.round(size / 1048576) + "MB, batas Reels 300MB — kompres dulu.";
    if (size && size < 50 * 1024) return "File video terlalu kecil/rusak (" + Math.round(size / 1024) + "KB) — upload ulang.";
    return null;
  } catch (e) { return "Link video tidak bisa diakses: " + e.message; }
}
function resetContainer(it, why) { it.containerId = null; it.processingSince = null; it.finishedAt = null; it.metaNote = null; it.log = why; }
const STUCK_MS = 45 * 6e4;
function isMetaInternal(e) {
  const g = (e && e.ig) || {};
  return Number(g.error_subcode) === 2207085 || /2207085/.test(String(e && e.message)) || (Number(g.code) === -1) || /fatal/i.test(String(g.message || ""));
}
async function findPostedMedia(uid, it) {
  try {
    const j = await U.ig(`${uid}/media`, { fields: "id,permalink,timestamp,caption,media_product_type", limit: 5 });
    const since = Math.min(it.finishedAt || Date.now(), it.processingSince || Date.now()) - 2 * 60000;
    const cap = String(it.caption || "").trim().slice(0, 40);
    const recent = (j.data || []).filter(m => { const t = Date.parse(m.timestamp); return t >= since && Date.now() - t < 20 * 60000; });
    if (!recent.length) return null;
    if (cap) { const hit = recent.find(m => String(m.caption || "").trim().startsWith(cap)); if (hit) return hit; }
    const r = recent.filter(m => !m.media_product_type || /REELS/i.test(m.media_product_type));
    return r[0] || null; // Reels terbaru setelah container FINISHED
  } catch (e) { return null; }
}
async function stepItem(it) {
  const { uid } = U.IG();
  if (!it.containerId) {
    const bad = it.videoDeleted ? "Video sudah dihapus dari penyimpanan — upload ulang videonya." : await checkVideoUrl(it.videoUrl);
    if (bad) { it.status = "failed"; it.log = "Gagal sebelum kirim ke IG: " + bad; return it; }
    let c;
    try { c = await U.ig(`${uid}/media`, { media_type: "REELS", video_url: it.videoUrl, caption: String(it.caption || "").slice(0, 2200), share_to_feed: "true" }, "POST"); }
    catch (e) { e.message = "[tahap buat kiriman] " + e.message; throw e; }
    it.containerId = c.id; it.status = "processing"; it.processingSince = Date.now(); it.log = "Video dikirim ke Instagram, sedang diproses…";
  }
  if (!it.processingSince) it.processingSince = Date.now();
  for (let i = 0; i < 6; i++) {
    const s = await U.ig(it.containerId, { fields: "status_code,status" }).catch(e => { e.message = "[tahap cek status] " + e.message; throw e; });
    if (s.status_code === "FINISHED" || (s.status_code === "PUBLISHED" && !it.mediaId)) {
      if (!it.finishedAt) it.finishedAt = Date.now();
      let p = null, lastErr = null, note = "";
      if (s.status_code === "FINISHED") {
        for (let a = 0; a < 3; a++) {
          try { p = await U.ig(`${uid}/media_publish`, { creation_id: it.containerId }, "POST"); break; }
          catch (e) { lastErr = e; if (!isMetaInternal(e)) { e.message = "[tahap tayang] " + e.message; throw e; } await new Promise(r => setTimeout(r, 3000 * (a + 1))); }
        }
      }
      if (!p) {
        const found = await findPostedMedia(uid, it);
        if (found) { p = { id: found.id }; it.permalink = found.permalink; note = "\n(Meta error 2207085 tapi Reels sudah tayang)"; it.metaNote = "Meta error 2207085 tapi Reels sudah tayang"; }
        else {
          it.status = "failed";
          const m = lastErr ? lastErr.message : "status PUBLISHED tapi media tidak ditemukan";
          resetContainer(it, `[tahap tayang] Meta error internal 2207085 (bug server Instagram, bukan salah video/jadwal). Cek dulu aplikasi Instagram apakah Reels sudah tayang. Kalau belum, tunggu 10–15 menit lalu klik "Posting Sekarang" sekali. Detail: ${m}`);
          return it;
        }
      }
      it.mediaId = p.id; it.status = "posted"; it.postedAt = Date.now(); it.log = "Sudah tayang ✅" + (it.metaNote ? " (" + it.metaNote + ")" : "");
      if (!it.permalink) { try { const m = await U.ig(p.id, { fields: "permalink" }); it.permalink = m.permalink; } catch (e) {} }
      let keep = false; try { keep = await T.ttMark(it); } catch (e) { it.tt = { status: "failed", log: e.message }; }
      try { if (await require("./threads").thMark(it)) keep = true; } catch (e) { it.th = { status: "failed", log: e.message }; }
      if (!keep) { await U.delBlob(it.videoUrl); it.videoDeleted = true; } // kalau TikTok ON, video dihapus setelah terkirim ke TikTok
      await U.notifyWA(`✅ Reels sudah tayang di @tiara_ai_influencer\n${it.permalink || ""}${note}`);
      return it;
    }
    const code = String(s.status_code || ""), msg = String(s.status || "");
    if (code === "ERROR" || code === "EXPIRED" || /fatal|error/i.test(msg)) {
      it.status = "failed";
      resetContainer(it, `Instagram menolak video (status_code: ${code || "-"}, pesan: ${msg || "-"}). Klik "Posting Sekarang" untuk coba ulang dengan kiriman baru. Biasanya video tidak cocok: wajib MP4 H.264 + AAC (bukan HEVC/H.265 dari iPhone), 9:16, 3–90 dtk, ≤300MB, 23–60fps. Export ulang lewat CapCut (1080x1920, 30fps) lalu upload lagi.`);
      return it;
    }
    if (code !== "IN_PROGRESS" && code !== "PUBLISHED") break;
    await new Promise(r => setTimeout(r, 4000));
  }
  if (Date.now() - it.processingSince > STUCK_MS) {
    it.stuckRetries = (it.stuckRetries || 0) + 1;
    if (it.stuckRetries > 1) { it.status = "failed"; resetContainer(it, "Instagram terlalu lama memproses video (>45 menit, sudah dicoba ulang). Klik \"Posting Sekarang\" untuk coba lagi."); }
    else resetContainer(it, "Instagram terlalu lama memproses (>45 menit) — dikirim ulang otomatis di cron berikutnya.");
  }
  return it; // masih diproses, lanjut di cron berikutnya
}
async function publishDue(onlyId) {
  if (!U.IG().ok) return { msg: "IG belum diatur" };
  const q = await autoSchedule(); const done = [];
  for (const it of q) {
    const due = onlyId ? it.id === onlyId : (it.status === "scheduled" && it.scheduledAt <= Date.now()) || it.status === "processing";
    if (!due || it.status === "posted") continue;
    if (onlyId && it.status === "failed") { it.tries = 0; it.stuckRetries = 0; resetContainer(it, "Coba ulang manual…"); it.status = "processing"; }
    try { await stepItem(it); } catch (e) {
      it.tries = (it.tries || 0) + 1; it.log = "Error IG: " + e.message;
      if (it.tries >= 3) { it.status = "failed"; it.containerId = null; it.processingSince = null; it.finishedAt = null; it.metaNote = null; }
    }
    done.push({ id: it.id, status: it.status, log: it.log });
    if (done.length >= 2) break;
  }
  await db.set("queue", q);
  return { done };
}

// ---------- BALAS KOMENTAR ----------
const DEF_CSET = { enabled: false, mode: "review", keywords: "tiara", maxPerHour: 50 };
async function commentSettings() { return { ...DEF_CSET, ...((await db.get("csettings")) || {}) }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function classify(c, caption) {
  return U.gemini(`Kamu adalah Tiara (@tiara_ai_influencer), AI influencer cewek asal Sidoarjo/Surabaya yang ramah, lucu, sopan dan halal (tidak genit berlebihan, tidak vulgar, tidak SARA, tidak politik).
Caption Reels: "${(caption || "").slice(0, 300)}"
Komentar dari @${c.username}: "${(c.text || "").slice(0, 500)}"
1) Nilai keamanan: "aman" atau "cek" (cek = kasar/hinaan, SARA, spam/promosi/link, seksual/jorok, politik, penipuan, atau butuh jawaban manusia).
2) Deteksi apakah komentar menanyakan harga/jasa bikin video (calon_klien true/false).
3) Jika aman, tulis balasan singkat (maks 25 kata) sebagai Tiara: WAJIB sebut @${c.username}, logat Suroboyo campur bahasa Indonesia (contoh kata: rek, cak, arek, isok, ae, gak popo, suwun, yo), variasikan gaya, boleh 1 emoji. Jika komentar berbahasa Inggris balas campuran Inggris + sedikit Suroboyo. Jika calon_klien, ajak cek link order di bio. Jangan mengulang kalimat template.
PENTING: JANGAN menyebut nomor episode, judul, tanggal, harga, nama, atau fakta apa pun yang TIDAK tertulis di caption Reels di atas. Jangan menjanjikan episode/konten berikutnya dengan nomor. Kalau perlu, pakai kata umum seperti "konten selanjutnya" atau "video berikutnya".
Jawab JSON: {"aman":"aman|cek","alasan":"singkat","calon_klien":false,"balasan":"..."}`, { json: true });
}
async function processComments(maxReplies = 6) {
  const st = await commentSettings();
  if (!st.enabled) return { msg: "Balas komentar OFF" };
  if (!U.IG().ok) return { msg: "IG belum diatur" };
  const { uid } = U.IG();
  const seen = new Set((await db.get("cseen")) || []);
  const pending = (await db.get("cpending")) || [], flagged = (await db.get("cflagged")) || [], hist = (await db.get("chistory")) || [];
  const kws = String(st.keywords || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const me = (await U.ig(uid, { fields: "username" })).username;
  const media = (await U.ig(`${uid}/media`, { fields: "id,caption,timestamp,media_product_type", limit: 8 })).data || [];
  const since = Date.now() - 3 * 864e5; let replied = 0, checked = 0;
  for (const m of media) {
    if (replied >= maxReplies || checked >= 15) break;
    const cs = (await U.ig(`${m.id}/comments`, { fields: "id,text,username,timestamp,replies.limit(50){id,text,username,timestamp}", limit: 50 })).data || [];
    for (const c of cs) {
      if (replied >= maxReplies || checked >= 15) break;
      // --- balasan di dalam utas ---
      const reps = (c.replies?.data || []).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const myT = reps.filter(x => x.username === me).map(x => Date.parse(x.timestamp));
      const tiaraIn = c.username === me || myT.length > 0;
      const firstMine = c.username === me ? Date.parse(c.timestamp) : (myT[0] || Infinity);
      const tKey = "cthread:" + c.id;
      let tCount = Math.max(myT.length, Number(await db.get(tKey)) || 0, 0);
      for (const x of reps) {
        if (replied >= maxReplies || checked >= 15) break;
        if (seen.has(x.id)) continue;
        const xt = String(x.text || ""), xtime = Date.parse(x.timestamp);
        const mention = new RegExp("@" + me.replace(/[.]/g, "\\.") + "\\b", "i").test(xt);
        const afterTiara = tiaraIn && xtime > firstMine;
        const already = myT.some(t => t > xtime); // Tiara sudah membalas setelah ini
        const xkw = kws.some(k => xt.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim() === k);
        if (x.username === me || xtime < since || xkw || already || !(mention || afterTiara)) { seen.add(x.id); continue; }
        if (tCount >= 2) { seen.add(x.id); continue; } // maks 2 balasan Tiara per utas
        checked++;
        let r; try { r = await classify({ username: x.username, text: xt + (c.username !== x.username ? ` (balasan di utas komentar @${c.username}: "${String(c.text || "").slice(0, 150)}")` : "") }, m.caption); } catch (e) { break; }
        seen.add(x.id);
        let reply = r.balasan || "";
        if (reply && !reply.toLowerCase().includes("@" + x.username.toLowerCase())) reply = `@${x.username} ${reply}`;
        const rec = { id: x.id, parent: c.id, thread: true, media: m.id, user: x.username, text: xt, t: Date.now(), reply, reason: r.alasan || "", lead: !!r.calon_klien };
        if (r.aman !== "aman" || !rec.reply) { flagged.unshift(rec); continue; }
        tCount++; await db.set(tKey, tCount);
        if (st.mode !== "auto") { pending.unshift(rec); continue; }
        if (await db.incr("rl:reply:" + new Date().toISOString().slice(0, 13), 3700) > (st.maxPerHour || 50)) { pending.unshift(rec); break; }
        try { const p = await U.ig(`${c.id}/replies`, { message: rec.reply }, "POST"); rec.replyId = p.id; hist.unshift(rec); replied++; }
        catch (e) { rec.reason = e.message; flagged.unshift(rec); }
        await sleep(2000 + Math.random() * 4000);
      }
      if (seen.has(c.id)) continue;
      const mine = c.username === me || (c.replies?.data || []).some(r => r.username === me);
      const old = Date.parse(c.timestamp) < since;
      const kw = kws.some(k => c.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim() === k);
      if (mine || old || kw) { seen.add(c.id); continue; }
      checked++;
      let r; try { r = await classify(c, m.caption); } catch (e) { break; } // Gemini error: coba lagi nanti
      seen.add(c.id);
      const rec = { id: c.id, media: m.id, user: c.username, text: c.text, t: Date.now(), reply: r.balasan || "", reason: r.alasan || "", lead: !!r.calon_klien };
      if (r.aman !== "aman" || !rec.reply) { flagged.unshift(rec); continue; }
      if (st.mode !== "auto") { pending.unshift(rec); continue; }
      if (await db.incr("rl:reply:" + new Date().toISOString().slice(0, 13), 3700) > (st.maxPerHour || 50)) { pending.unshift(rec); break; }
      try { const p = await U.ig(`${c.id}/replies`, { message: rec.reply }, "POST"); rec.replyId = p.id; hist.unshift(rec); replied++; }
      catch (e) { rec.reason = e.message; flagged.unshift(rec); }
      await sleep(2000 + Math.random() * 4000);
    }
  }
  await db.set("cseen", [...seen].slice(-3000)); await db.set("cpending", pending.slice(0, 200));
  await db.set("cflagged", flagged.slice(0, 200)); await db.set("chistory", hist.slice(0, 300));
  return { replied, checked, pending: pending.length, flagged: flagged.length };
}
async function sendReply(id, text) {
  const pending = (await db.get("cpending")) || [], hist = (await db.get("chistory")) || [], flagged = (await db.get("cflagged")) || [];
  let rec = pending.find(x => x.id === id) || flagged.find(x => x.id === id); if (!rec) throw new Error("Komentar tidak ada di daftar");
  rec.reply = U.str(text || rec.reply, 500);
  const p = rec.platform === "threads" ? await require("./threads").thReply(id, rec.reply) : await U.ig(`${rec.parent || id}/replies`, { message: rec.reply }, "POST"); rec.replyId = p.id; rec.t = Date.now();
  hist.unshift(rec);
  await db.set("cpending", pending.filter(x => x.id !== id)); await db.set("cflagged", flagged.filter(x => x.id !== id)); await db.set("chistory", hist.slice(0, 300));
}
module.exports = { classify, computeGolden, autoSchedule, publishDue, processComments, sendReply, commentSettings, DEFAULT_SLOTS };
