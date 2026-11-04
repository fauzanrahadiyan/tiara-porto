// Radar Tiara — cari postingan AI yang ramai di IG & Threads, lalu buat DRAF komentar.
// PENTING: komentar TIDAK PERNAH diposting otomatis ke postingan orang. Admin yang menyalin & menempel manual.
const db = require("./db");
const U = require("./util");
const CL = require("./collab");
const TG = "https://graph.threads.net/v1.0";
const ymd = () => U.wib().toISOString().slice(0, 10);
const DEF = {
  enabled: true, count: 10, hour: 7, tagsPerDay: 5, kwPerDay: 6, thSearch: false,
  hashtags: ["aiinfluencer", "aivideo", "aifilm", "aifilmmaking", "seedance", "kling", "aicommercial", "aidrama", "aiseries", "viralai", "videoai", "kontenai", "kursusai", "videoia", "inteligenciaartificial", "AI視頻", "AI动画", "AI视频", "AI動画", "AIアニメ", "нейросеть", "ИИвидео", "нейросети", "omniflow", "artificialintelligence"],
  keywords: ["AI influencer", "kursus AI", "belajar AI video", "learn AI filmmaking", "AI course", "AI video", "viral AI", "Seedance", "Kling", "Omni Flow", "AI filmmaker", "AI commercial", "AI drama", "AI series", "artificial intelligence", "AI動画", "AI视频", "нейросеть видео", "video con IA"],
};
async function rdSettings() { return { ...DEF, ...((await db.get("rd_settings")) || {}) }; }
async function saveSettings(b) {
  const s = await rdSettings();
  const list = (v, n) => (Array.isArray(v) ? v : String(v || "").split(/[\n,]+/)).map(x => String(x).trim().replace(/^#/, "")).filter(Boolean).slice(0, n);
  if ("enabled" in b) s.enabled = !!b.enabled;
  if ("thSearch" in b) s.thSearch = !!b.thSearch;
  if (b.count) s.count = Math.min(15, Math.max(3, +b.count || 10));
  if (b.hashtags) s.hashtags = list(b.hashtags, 60);
  if (b.keywords) s.keywords = list(b.keywords, 60);
  await db.set("rd_settings", s); return s;
}

// ---------- KATEGORI & SKOR ----------
const RX = {
  murid: /(kursus|belajar|les |kelas|tutorial|ajarin|gimana cara|how (do|to|can) (i|you) (learn|make|start)|learn(ing)? ai|ai course|course|mentor|where to learn|curso|aprender|教程|学习|怎么学|講座|学びたい|勉強|курс|обучени|научиться)/i,
  infl: /(ai ?influencer|virtual influencer|influencer ai|ai model|ai girl|digital human|虚拟人|バーチャル|ии.?блогер|виртуальн)/i,
  viral: /(viral|trending|fyp|blow ?up|爆火|话题|バズ|вирус|тренд)/i,
};
function categorize(text, likes, comments) {
  const t = String(text || "");
  if (RX.murid.test(t) && /\?|？|mau|pengen|want|need|quiero|想|したい|хочу/i.test(t)) return "murid";
  if (RX.infl.test(t)) return "influencer";
  if (RX.viral.test(t) || likes + comments * 3 > 5000) return "viral";
  return "lain";
}
const BONUS = { murid: 100000, influencer: 90000, viral: 10000, lain: 0 };
const score = it => (it.likes || 0) + (it.comments || 0) * 3 + BONUS[it.cat];
const isAI = t => /(\bai\b|a\.i\.|artificial intelligence|seedance|kling|omni ?flow|veo|sora|runway|midjourney|人工智能|ＡＩ|AI|нейросет|ии|inteligencia artificial)/i.test(String(t || ""));

// ---------- INSTAGRAM: Hashtag Search (maks 30 hashtag unik / 7 hari) ----------
async function pickTags(s) {
  const log = ((await db.get("rd_taglog")) || []).filter(x => Date.now() - x.t < 7 * 864e5);
  const used = [...new Set(log.map(x => x.tag.toLowerCase()))];
  const rot = (await db.get("rd_rot")) || 0;
  const all = s.hashtags.map((t, i) => ({ t, p: (i - rot + s.hashtags.length) % s.hashtags.length })).sort((a, b) => a.p - b.p).map(x => x.t);
  const pick = [];
  for (const t of all) { if (pick.length >= s.tagsPerDay) break; if (used.includes(t.toLowerCase()) || used.length + pick.filter(x => !used.includes(x.toLowerCase())).length < 30) pick.push(t); }
  if (!all.length) return { pick, used: used.length };
  // prioritas: hashtag AI influencer & kursus selalu ikut jika kuota ada
  await db.set("rd_rot", (rot + s.tagsPerDay) % all.length);
  return { pick, used: used.length };
}
async function igTag(tag) {
  const I = U.IG(); if (!I.ok) throw new Error("IG belum terhubung");
  if (!I.token.startsWith("EAA")) throw new Error("Hashtag Search IG butuh token Facebook Login (EAA…). Token sekarang tipe Instagram Login, jadi radar IG dilewati.");
  const log = (await db.get("rd_taglog")) || [];
  let hit = log.find(x => x.tag.toLowerCase() === tag.toLowerCase() && Date.now() - x.t < 7 * 864e5);
  let id = hit && hit.id;
  if (!id) {
    const r = await U.ig("ig_hashtag_search", { user_id: I.uid, q: tag });
    id = r.data && r.data[0] && r.data[0].id; if (!id) return [];
    log.push({ tag, id, t: Date.now() }); await db.set("rd_taglog", log.filter(x => Date.now() - x.t < 8 * 864e5).slice(-80));
  }
  const m = await U.ig(id + "/top_media", { user_id: I.uid, fields: "id,caption,permalink,like_count,comments_count,media_type,timestamp", limit: 25 });
  return (m.data || []).map(x => ({ id: "ig_" + x.id, pf: "ig", user: "", text: String(x.caption || "").slice(0, 600), url: x.permalink, likes: x.like_count || 0, comments: x.comments_count || 0, ts: x.timestamp, src: "#" + tag }));
}
// ---------- THREADS: keyword_search (butuh izin threads_keyword_search) ----------
async function thKw(kw) {
  const t = await db.get("th_token"); if (!t) throw new Error("Threads belum dihubungkan");
  const p = new URLSearchParams({ q: kw, search_type: "TOP", fields: "id,text,permalink,username,timestamp,media_type", access_token: t.access_token });
  const j = await (await fetch(TG + "/keyword_search?" + p)).json();
  if (j.error) {
    const msg = j.error.message || "error";
    if (/permission|scope|not authorized|#10|#200/i.test(msg) || j.error.code === 10 || j.error.code === 200)
      throw Object.assign(new Error("Izin threads_keyword_search belum ada. Tambahkan di Meta Developer → Kasus penggunaan → Akses API Threads → Izin → threads_keyword_search, lalu di Radar centang 'Izin pencarian Threads sudah ditambah' dan klik Hubungkan ulang Threads."), { perm: 1 });
    throw new Error("Threads: " + msg);
  }
  return (j.data || []).filter(x => !t.user || x.username !== t.user).map(x => ({ id: "th_" + x.id, pf: "th", user: x.username || "", text: String(x.text || "").slice(0, 600), url: x.permalink, likes: x.like_count || 0, comments: x.replies_count || 0, ts: x.timestamp, src: kw }));
}

// ---------- GEMINI: bahasa, lokasi perkiraan, draf komentar ----------
const RULES = `Kamu menulis DRAF komentar sebagai Tiara (@tiara_ai_influencer), AI influencer cewek dari Indonesia (Surabaya) yang membuat video AI realistis.
Aturan draf:
- Tulis dalam BAHASA YANG SAMA dengan postingan (Inggris→Inggris santai, Spanyol→Spanyol, Mandarin→Mandarin (Tradisional jika postingan Tradisional), Jepang→Jepang santai sopan, Rusia→Rusia, bahasa lain→bahasa itu). Postingan Indonesia → bahasa Indonesia campur logat Suroboyo (rek, isok, ae, cak) yang sopan.
- Untuk postingan non-Indonesia boleh menyebut diri "AI influencer from Indonesia" (diterjemahkan) bila pas.
- Nyambung dengan isi postingan (sebut hal spesifik), 1-3 kalimat, maks 280 karakter, boleh 1 emoji. Promosi diri HALUS saja (misal ajak mampir ke profil), tanpa link, tanpa hashtag spam.
- Kategori "murid" (orang yang cari belajar/kursus AI): jawab pertanyaannya dulu dengan tulus & bermanfaat, baru sebut halus "Kursus Private AI Video Realistis — sudah dibuka, DM aja" (terjemahkan sesuai bahasa). Jangan pakai kata "kelas", jangan bilang "segera dibuka".
- Halal, sopan, tanpa SARA, tanpa kata kasar, tanpa klaim palsu (jangan mengaku manusia, jangan klaim angka/penghargaan).
Lokasi: perkirakan negara + lat/lng dari bahasa, caption, username. Ini PERKIRAAN. Jepang→Jepang, Rusia→Rusia, Mandarin→Taiwan/Hong Kong/Singapura, Inggris→negara yang disebut atau US/UK, Indonesia→kota yang disebut atau Jakarta/Surabaya, Spanyol→Spanyol/Meksiko/negara yang disebut.`;
const jit = () => (Math.random() - 0.5) * 3;
async function enrich(items) {
  const list = items.map((x, i) => ({ i, cat: x.cat, platform: x.pf === "ig" ? "Instagram" : "Threads", user: x.user, text: x.text.slice(0, 400) }));
  const r = await U.gemini(`${RULES}
Postingan (JSON): ${JSON.stringify(list)}
Jawab JSON array: [{"i":0,"lang":"kode ISO 639-1","flag":"emoji bendera bahasa","country":"nama negara (Indonesia)","city":"kota/opsional","lat":0,"lng":0,"draft":"..."}]`, { json: true, timeout: 45000 });
  for (const o of (Array.isArray(r) ? r : r.items || [])) {
    const it = items[o.i]; if (!it) continue;
    Object.assign(it, { lang: o.lang || "?", flag: o.flag || "🌐", country: o.country || "?", city: o.city || "", lat: (+o.lat || 0) + jit(), lng: (+o.lng || 0) + jit(), draft: U.str(o.draft, 400) });
  }
  return items;
}
async function rewrite(id) {
  const items = (await db.get("rd_items")) || []; const it = items.find(x => x.id === id); if (!it) throw new Error("Postingan tidak ada");
  const d = await U.gemini(`${RULES}\nKategori: ${it.cat}. Platform: ${it.pf}. Bahasa: ${it.lang}. Postingan: """${it.text.slice(0, 500)}"""\nDraf lama: """${it.draft || ""}"""\nTulis SATU draf baru yang berbeda gaya. Jawab teks draf saja.`);
  it.draft = U.str(d.trim().replace(/^"|"$/g, ""), 400); await db.set("rd_items", items); return it;
}

// ---------- JOB HARIAN (dipecah per langkah agar muat 60 detik) ----------
async function start(s, force) {
  const job = { date: ymd(), phase: "ig", tags: [], kws: [], cand: [], msgs: [], started: Date.now(), force: !!force };
  const tp = await pickTags(s); job.tags = tp.pick; job.tagsUsed = tp.used;
  const kr = (await db.get("rd_krot")) || 0; const K = s.keywords;
  const pri = K.filter(k => RX.murid.test(k) || RX.infl.test(k));
  job.kws = [...new Set([...pri, ...K.slice(kr).concat(K.slice(0, kr))])].slice(0, s.kwPerDay + pri.length);
  await db.set("rd_krot", K.length ? (kr + s.kwPerDay) % K.length : 0);
  await db.set("rd_job", job); return job;
}
async function step(budgetMs = 35000) {
  const t0 = Date.now(); const s = await rdSettings(); let job = await db.get("rd_job"); if (!job || job.phase === "done") return job;
  const seen = new Set((await db.get("rd_seen")) || []);
  const add = arr => { for (const x of arr) if (!seen.has(x.id) && !job.cand.some(c => c.id === x.id) && isAI(x.text) && x.url) job.cand.push(x); };
  const left = () => budgetMs - (Date.now() - t0);
  while (left() > 6000 && job.phase !== "done") {
    if (job.phase === "ig") {
      const tag = job.tags.shift(); if (!tag) { job.phase = "th"; continue; }
      try { add(await igTag(tag)); } catch (e) { job.msgs.push("IG #" + tag + ": " + e.message); if (/EAA|belum terhubung/.test(e.message)) { job.tags = []; } }
    } else if (job.phase === "th") {
      const kw = job.kws.shift(); if (!kw) { job.phase = "pick"; continue; }
      if (!s.thSearch) { job.msgs.push("Threads: pencarian belum aktif. Tambahkan izin threads_keyword_search di Meta Developer, centang 'Izin pencarian Threads sudah ditambah' di Radar, lalu Hubungkan ulang Threads."); job.kws = []; job.phase = "pick"; continue; }
      try { add(await thKw(kw)); } catch (e) { job.msgs.push(e.message); if (e.perm || /belum dihubungkan/.test(e.message)) job.kws = []; }
    } else if (job.phase === "pick") {
      job.cand.forEach(x => { x.cat = categorize(x.text, x.likes, x.comments); x.score = score(x); });
      // seimbangkan platform: urutkan skor, ambil top N
      job.cand.sort((a, b) => b.score - a.score); job.pool = job.cand.slice(s.count, 150).map(x => ({ pf: x.pf, user: x.user, text: x.text.slice(0, 300), src: x.src })); job.cand = job.cand.slice(0, s.count); job.phase = "ai";
    } else if (job.phase === "ai") {
      const todo = job.cand.filter(x => !x.draft).slice(0, 5);
      if (!todo.length) { job.phase = "save"; continue; }
      if (left() < 20000) break;
      try { await enrich(todo); } catch (e) { job.msgs.push("Gemini: " + e.message); todo.forEach(x => { x.draft = x.draft || ""; x.flag = x.flag || "🌐"; x.country = x.country || "?"; x.lat = x.lat || 0; x.lng = x.lng || 0; x.noDraft = 1; }); }
      todo.forEach(x => { if (!x.draft) x.draft = " "; });
    } else if (job.phase === "save") {
      const now = Date.now(); const fresh = job.cand.map(x => ({ ...x, draft: String(x.draft || "").trim(), status: "new", found: now, day: job.date }));
      const old = ((await db.get("rd_items")) || []).filter(x => now - x.found < 7 * 864e5 && !fresh.some(f => f.id === x.id));
      await db.set("rd_items", [...fresh, ...old].slice(0, 80));
      await db.set("rd_seen", [...fresh.map(x => x.id), ...seen].slice(0, 1500));
      try { await CL.collect(job.cand.concat(job.pool || [])); } catch (e) { job.msgs.push("Collab: " + e.message); }
      job.pool = []; job.found = fresh.length; job.phase = "collab";
    } else if (job.phase === "collab") {
      if (left() < 25000 && !job.collabTry) { job.collabTry = 1; break; }
      let cr = { found: 0, msgs: [] };
      try { cr = await CL.run(Math.max(25000, left() - 3000)); } catch (e) { cr.msgs = ["Collab: " + e.message]; }
      job.msgs.push(...cr.msgs); job.collab = cr.found; job.phase = "done"; job.finished = Date.now();
      const fresh = ((await db.get("rd_items")) || []).filter(x => x.day === job.date && x.found >= job.started);
      try { await summary(fresh, cr.found); } catch (e) { job.msgs.push("Telegram: " + e.message); }
    }
  }
  job.msgs = [...new Set(job.msgs)].slice(-8);
  await db.set("rd_job", job); return job;
}
const CATL = { influencer: "⭐ AI influencer", murid: "🎓 Calon murid", viral: "🔥 Viral AI", lain: "🎬 AI lain" };
async function summary(items, collab = 0) {
  const site = (process.env.SITE_URL || "https://tiara-porto.vercel.app").replace(/\/$/, "");
  if (!items.length && !collab) return null;
  const top = items.slice(0, 3).map((x, i) => `${i + 1}. ${CATL[x.cat]} · ${x.pf === "ig" ? "IG" : "Threads"} ${x.flag || ""}\n${x.url}\n💬 "${String(x.draft || "").slice(0, 120)}"`).join("\n\n");
  return U.notifyTG(`🎯 Radar Tiara: ${items.length} postingan AI ramai hari ini\n\n${top || "(belum ada yang cocok)"}\n\n🤝 Calon collab baru: ${collab} akun AI influencer (draf DM siap, kirim manual)\n\nBuka radar: ${site}/admin#radar\nKomentar diposting manual oleh admin ya, biar aman dari spam/banned.`);
}
async function cronJobs() {
  const s = await rdSettings(); if (!s.enabled) return { off: true };
  let job = await db.get("rd_job");
  if ((!job || job.date !== ymd()) && U.wib().getUTCHours() >= s.hour) job = await start(s);
  if (job && job.phase !== "done") return { phase: (await step(25000)).phase };
  return { phase: job ? job.phase : "waiting" };
}
async function runNow() { const s = await rdSettings(); let job = await db.get("rd_job"); if (!job || job.phase === "done") job = await start(s, true); return step(45000); }
async function rdData() { return { settings: await rdSettings(), items: (await db.get("rd_items")) || [], job: await db.get("rd_job") }; }
async function setStatus(id, st) { const items = (await db.get("rd_items")) || []; const it = items.find(x => x.id === id); if (it) { it.status = st; it.at = Date.now(); await db.set("rd_items", items); } return it; }
module.exports = { rdSettings, saveSettings, cronJobs, runNow, rdData, setStatus, rewrite, summary, categorize };
