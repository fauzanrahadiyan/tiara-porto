// Pemburu Collab — cari akun AI influencer dengan followers mirip Tiara, lalu buat DRAF DM ajakan collab.
// PENTING: DM TIDAK PERNAH dikirim otomatis. Admin menyalin & mengirim sendiri.
// Tidak memakai kuota hashtag IG sendiri: kandidat diambil dari hasil radar (penulis Threads, @mention di caption IG) + daftar akun manual.
const db = require("./db");
const U = require("./util");
const SELF = "tiara_ai_influencer";
const DEF = { enabled: true, perDay: 5, minX: 0.3, maxX: 5, maxLookup: 15, seeds: [] };
async function clSettings() { return { ...DEF, ...((await db.get("cl_settings")) || {}) }; }
async function saveSettings(b) {
  const s = await clSettings();
  if ("enabled" in b) s.enabled = !!b.enabled;
  if (b.minX != null) s.minX = Math.min(1, Math.max(0.05, +b.minX || 0.3));
  if (b.maxX != null) s.maxX = Math.min(50, Math.max(1, +b.maxX || 5));
  if (b.perDay) s.perDay = Math.min(10, Math.max(1, +b.perDay || 5));
  if (b.seeds != null) s.seeds = (Array.isArray(b.seeds) ? b.seeds : String(b.seeds).split(/[\s,]+/)).map(clean).filter(Boolean).slice(0, 40);
  await db.set("cl_settings", s); return s;
}
const clean = u => String(u || "").trim().replace(/^@/, "").replace(/[^\w.]/g, "").toLowerCase().slice(0, 30);
// dipanggil radar: kumpulkan calon username dari hasil pencarian
async function collect(items) {
  const pool = (await db.get("cl_pool")) || [];
  const add = (u, src, lang) => { u = clean(u); if (!u || u === SELF || u.length < 3 || pool.some(p => p.u === u)) return; pool.unshift({ u, src, t: Date.now() }); };
  for (const x of items) {
    if (x.user) add(x.user, x.pf === "th" ? "Threads: " + x.src : x.src);
    for (const m of String(x.text || "").match(/@[\w.]{3,30}/g) || []) add(m, (x.pf === "ig" ? "IG " : "Threads ") + x.src);
  }
  await db.set("cl_pool", pool.filter(p => Date.now() - p.t < 21 * 864e5).slice(0, 300));
}
async function bd(user) {
  const I = U.IG();
  const r = await U.ig(I.uid, { fields: `business_discovery.username(${user}){username,name,biography,followers_count,media_count,profile_picture_url,media.limit(3){caption,permalink,like_count,comments_count}}` });
  return r.business_discovery;
}
const RULES = `Kamu menilai akun Instagram/Threads dan menulis DRAF DM ajakan collab sebagai Tiara (@tiara_ai_influencer), AI influencer cewek dari Indonesia (Surabaya).
Penilaian "ai" (0-100): seberapa yakin akun ini AI influencer / virtual influencer / kreator konten AI (dari bio & caption). Akun manusia biasa tanpa unsur AI → rendah.
"why": alasan singkat kenapa cocok collab dengan Tiara, dalam bahasa Indonesia (maks 120 karakter).
Draf DM:
- Tulis dalam BAHASA AKUN itu (dari bio/caption): Inggris santai, Spanyol, Mandarin (Tradisional jika akunnya Tradisional), Jepang sopan santai, Rusia, bahasa lain→bahasa itu. Akun Indonesia → bahasa Indonesia campur logat Suroboyo (rek, isok, ae) yang sopan.
- Perkenalkan diri sebagai Tiara, AI influencer from Indonesia (terjemahkan). Sebut hook unik: serial anime TIARA ANGEL WOMAN yang karakternya berbahasa Jawa.
- Puji 1 hal spesifik dari kontennya, lalu ajak collab lintas negara yang seru: Reel duet / crossover Story (misal karakter kita ketemu di dunia masing-masing).
- Ramah, singkat (maks 450 karakter), tanpa jualan, tanpa link, maks 1-2 emoji. Halal, sopan, tanpa klaim palsu (jangan mengaku manusia, jangan klaim angka/penghargaan).
Lokasi: perkirakan negara + lat/lng dari bahasa/bio (PERKIRAAN).`;
const jit = () => (Math.random() - 0.5) * 3;
async function judge(list) {
  const r = await U.gemini(`${RULES}\nAkun (JSON): ${JSON.stringify(list.map((a, i) => ({ i, username: a.username, name: a.name, bio: a.bio, followers: a.followers, captions: a.caps })))}\nJawab JSON array: [{"i":0,"ai":0,"lang":"kode ISO 639-1","flag":"emoji bendera","country":"negara (Indonesia)","lat":0,"lng":0,"why":"...","draft":"..."}]`, { json: true, timeout: 45000 });
  return Array.isArray(r) ? r : r.items || [];
}
// jalankan pemburu collab (dipanggil dari langkah radar), budget ms
async function run(budgetMs = 30000) {
  const t0 = Date.now(); const s = await clSettings(); const msgs = [];
  if (!s.enabled) return { found: 0, msgs: ["Pemburu Collab nonaktif"] };
  const I = U.IG(); if (!I.ok) return { found: 0, msgs: ["Collab: IG belum terhubung"] };
  if (!I.token.startsWith("EAA")) return { found: 0, msgs: ["Collab: business_discovery butuh token Facebook Login (EAA…)."] };
  const me = await U.ig(I.uid, { fields: "followers_count,username" });
  const base = Math.max(50, me.followers_count || 0), lo = base * s.minX, hi = base * s.maxX;
  const seen = new Set((await db.get("cl_seen")) || []); const pool = (await db.get("cl_pool")) || [];
  const names = [...new Set([...s.seeds, ...pool.map(p => p.u)])].filter(u => u !== SELF && u !== clean(me.username) && !seen.has(u)).slice(0, s.maxLookup);
  const accs = [];
  for (const u of names) {
    if (Date.now() - t0 > budgetMs - 20000) break;
    seen.add(u); // jangan dicek ulang walau gagal (akun pribadi / tidak ada)
    try {
      const a = await bd(u); if (!a || a.followers_count == null) continue;
      if (a.followers_count < lo || a.followers_count > hi) continue;
      const med = (a.media && a.media.data) || [];
      const eng = med.length ? med.reduce((t, m) => t + (m.like_count || 0) + (m.comments_count || 0) * 3, 0) / med.length / Math.max(1, a.followers_count) : 0;
      accs.push({ id: "cl_" + a.username, username: a.username, name: U.str(a.name, 80), bio: U.str(a.biography, 300), followers: a.followers_count, media: a.media_count || 0, pic: a.profile_picture_url || "", url: "https://www.instagram.com/" + a.username + "/", eng, caps: med.map(m => String(m.caption || "").slice(0, 160)), src: (pool.find(p => p.u === u) || {}).src || "manual" });
    } catch (e) { if (!/not found|Cannot find|does not exist|#110/i.test(e.message)) msgs.push("Collab @" + u + ": " + e.message.slice(0, 100)); }
  }
  await db.set("cl_seen", [...seen].slice(-3000));
  if (!accs.length) return { found: 0, msgs: msgs.concat(names.length ? [] : ["Collab: belum ada calon akun. Tambah username manual di pengaturan Collab, atau tunggu radar mengumpulkan penulis."]) };
  try {
    for (const o of await judge(accs.slice(0, 12))) { const a = accs[o.i]; if (a) Object.assign(a, { ai: +o.ai || 0, lang: o.lang || "?", flag: o.flag || "🌐", country: o.country || "?", lat: (+o.lat || 0) + jit(), lng: (+o.lng || 0) + jit(), why: U.str(o.why, 160), draft: U.str(o.draft, 700) }); }
  } catch (e) { msgs.push("Gemini collab: " + e.message); }
  const sim = f => 1 - Math.min(1, Math.abs(Math.log(f / base)) / Math.log(Math.max(s.maxX, 1 / s.minX)));
  accs.forEach(a => { a.score = Math.round((a.ai || 0) * 0.6 + sim(a.followers) * 25 + Math.min(15, a.eng * 300)); });
  const top = accs.filter(a => (a.ai || 0) >= 40 && a.draft).sort((a, b) => b.score - a.score).slice(0, s.perDay);
  const now = Date.now(); const fresh = top.map(({ caps, ...a }) => ({ ...a, cat: "collab", status: "new", found: now }));
  const old = ((await db.get("cl_items")) || []).filter(x => x.status !== "new" || now - x.found < 14 * 864e5);
  await db.set("cl_items", [...fresh, ...old.filter(o => !fresh.some(f => f.id === o.id))].slice(0, 120));
  await db.set("cl_last", { at: now, found: fresh.length, base, msgs });
  return { found: fresh.length, msgs };
}
async function rewrite(id) {
  const items = (await db.get("cl_items")) || []; const it = items.find(x => x.id === id); if (!it) throw new Error("Akun tidak ada");
  const d = await U.gemini(`${RULES}\nAkun: @${it.username} (${it.name}), bahasa ${it.lang}, followers ${it.followers}. Bio: """${it.bio}"""\nDraf lama: """${it.draft || ""}"""\nTulis SATU draf DM baru yang berbeda gaya. Jawab teks draf saja.`);
  it.draft = U.str(d.trim().replace(/^"|"$/g, ""), 700); await db.set("cl_items", items); return it;
}
const ST = ["new", "dm", "reply", "collab", "skip"];
async function setStatus(id, st) { const items = (await db.get("cl_items")) || []; const it = items.find(x => x.id === id); if (it && ST.includes(st)) { it.status = st; it.at = Date.now(); await db.set("cl_items", items); } return it; }
async function clData() { return { settings: await clSettings(), items: (await db.get("cl_items")) || [], last: await db.get("cl_last"), pool: ((await db.get("cl_pool")) || []).length }; }
module.exports = { clSettings, saveSettings, collect, run, rewrite, setStatus, clData, ST };
