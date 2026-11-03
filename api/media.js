// Tiara Porto - ambil video IG + kategori AI (Gemini)
const DEF_CATS = ["Iklan & UGC","Motion Graphic","Cover Lagu","Short Film","Lifestyle","Lainnya"];
const memo = global.__porto || (global.__porto = { cats: {}, data: null, at: 0 });
const slug = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function demo(cats) {
  const caps = [
    ["Mukbang UGC mie pedas level 8, iklan AI #ugc #iklan", 0],
    ["Iseng gawe Motion Graphic saiki rek #motiongraphic", 1],
    ["Cover lagu galau, AI visual x real voice #cover", 2],
    ["Short film horor 50 detik #aishortfilm", 3],
    ["Malmingan bareng Ferrari kuning #luxury #lifestyle", 4],
    ["Behind the scene bikin video AI #bts", 5],
    ["Iklan produk skincare glowing #iklan", 0],
    ["Before After konten AI #motion", 1],
    ["Liburan nang pantai isuk2 #lifestyle", 4],
  ];
  return caps.map(([c, i], n) => ({
    id: "demo" + n, caption: "[CONTOH] " + c, category: cats[Math.min(i, cats.length - 1)],
    media_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    thumbnail_url: "", permalink: "https://www.instagram.com/tiara_ai_influencer/",
    timestamp: new Date(Date.now() - n * 864e5).toISOString(), demo: true,
  }));
}

// Aturan kata kunci gratis (Jawa/Indonesia/Inggris). Urutan = prioritas.
const RULES = [
  ["Cover Lagu", /\bcover\b|remake mv|music credit|song edit|\bguitar|gitar|ngeband|nyanyi|\bon the decks|mashup|\blagu|\bmv\b/i],
  ["Short Film", /short ?film|aishortfilm|\bepisode\b|\bfilm\b|\bdrama\b|series/i],
  ["Motion Graphic", /motion ?graphic|motiongraphic|before after|\b2d\b|\b3d\b|animasi|animation|\bvfx\b|remake|ai edit/i],
  ["Iklan & UGC", /\bugc\b|iklan|mukbang|endorse|\bbrand\b|produk|product|diskon|klik link|affiliat|grwm|review|promo|launching|demo|aplikasi|\bapp\b|@ninjakitchen|@sharkhome|pempek|@pempek|kuliner/i],
  ["Lifestyle", /luxury|lifestyle|liburan|holiday|vlog|daily|ootd|fashion|olahraga|sport|surfing|skating|flyboard|equestrian|ferrari|mclaren|brabus|bmw|mobil|\bcars?\b|heli|malming|foya|warehouse project|\bdwp|\bbwp|nightlife|halloween|sarapan|masak|skincare|makeup|mall|belanja|pantai|explore|jalan2|traveling|travel|gym|workout|baluran|kebun|dolen|pamer|tuku|birthday|podcast/i],
];
const ALIAS = { iklan: "Iklan & UGC", ugc: "Iklan & UGC", motion: "Motion Graphic", cover: "Cover Lagu", shortfilm: "Short Film", film: "Short Film", lifestyle: "Lifestyle", lainnya: "Lainnya" };
function byKeyword(cap, cats) {
  for (const [c, re] of RULES) if (cats.includes(c) && re.test(cap)) return c;
  return cats.includes("Lainnya") ? "Lainnya" : cats[cats.length - 1];
}
function byHashtag(cap, cats) {
  const m = cap.match(/#porto_([a-z0-9_]+)/i); if (!m) return null;
  const k = slug(m[1]);
  return cats.find(x => slug(x) === k) || (ALIAS[k] && cats.includes(ALIAS[k]) ? ALIAS[k] : null);
}

async function gemini(todo, cats, key) {
  const prompt = `Kamu mengelompokkan video Instagram kreator AI (caption bahasa Jawa/Indonesia/Inggris). ` +
    `Kategori yang boleh: ${cats.join(" | ")}.\nPanduan: iklan produk/UGC/endorse/promo/review/mukbang brand -> Iklan & UGC; ` +
    `motion graphic/animasi/before-after/edit AI -> Motion Graphic; cover/remake lagu/musik/DJ -> Cover Lagu; ` +
    `short film/episode/cerita bersambung -> Short Film; keseharian, jalan-jalan, mobil, kemewahan, olahraga, masak, konser -> Lifestyle; selain itu -> Lainnya.\n` +
    `Jawab HANYA JSON objek {"<id>":"<kategori persis>"} untuk semua id.\n\n` +
    todo.map(t => `${t.id}: ${(t.caption || "").slice(0, 250).replace(/\s+/g, " ")}`).join("\n");
  let lastErr = "";
  for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 25000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, thinkingConfig: model.startsWith("gemini-2.5") ? { thinkingBudget: 0 } : undefined } }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      const map = JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim());
      return { map, err: "" };
    } catch (e) { lastErr = `${model}: ${e.name === "AbortError" ? "timeout" : e.message}`.slice(0, 200); console.error("gemini", lastErr); }
    finally { clearTimeout(tm); }
  }
  return { map: null, err: lastErr };
}

async function categorize(items, cats) {
  let catError = "";
  const todo = [];
  for (const it of items) {
    const cap = it.caption || "";
    const h = byHashtag(cap, cats);
    if (h) { it.category = h; it.catBy = "hashtag"; continue; }
    if (memo.cats[it.id]) { it.category = memo.cats[it.id]; it.catBy = "ai"; continue; }
    it.category = byKeyword(cap, cats); it.catBy = "keyword";
    todo.push(it);
  }
  const key = (process.env.GEMINI_API_KEY || "").replace(/["'\s]/g, "");
  if (!todo.length) return catError;
  if (!key) return "GEMINI_API_KEY kosong, pakai kata kunci";
  const { map, err } = await gemini(todo, cats, key);
  if (!map) return err;
  for (const t of todo) { const c = cats.find(x => x === map[t.id]); if (c) { memo.cats[t.id] = c; t.category = c; t.catBy = "ai"; } }
  return catError;
}

module.exports = async (req, res) => {
  const cats = (process.env.CATEGORIES || "").split(",").map(s => s.trim()).filter(Boolean);
  const C = cats.length ? cats : DEF_CATS;
  const token = (process.env.IG_ACCESS_TOKEN || "").replace(/["'\s]/g, "");
  const isDemo = !token || (req.query && req.query.demo === "1");
  const base = { categories: C, wa: process.env.WA_NUMBER || "6287702700618", ig: "https://www.instagram.com/tiara_ai_influencer/" };
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  const DP = { demo: true, username: "tiara_ai_influencer", name: "Tiara (contoh)", biography: "AI influencer & kreator video iklan AI — Sidoarjo", followers_count: 12345, media_count: 9, profile_picture_url: "" };
  if (isDemo) return res.status(200).json({ ...base, demo: true, profile: DP, items: demo(C) });
  try {
    if (memo.data && Date.now() - memo.at < 6e5) return res.status(200).json({ ...base, demo: false, catError: memo.catError, profile: memo.prof, items: memo.data });
    const uid = (process.env.IG_USER_ID || "").replace(/["'\s]/g, "") || "me";
    const fb = token.startsWith("EAA");
    if (fb && uid === "me") throw new Error("IG_USER_ID wajib diisi untuk token EAA");
    const G = fb ? "https://graph.facebook.com/v23.0" : "https://graph.instagram.com/v23.0";
    let prof = null;
    try { const pj = await (await fetch(`${G}/${uid}?fields=username,name,biography,profile_picture_url,followers_count,media_count&access_token=${token}`)).json(); if (!pj.error) prof = pj; else console.error("profile", pj.error.message); } catch (e) {}
    let url = `${G}/${uid}/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp&limit=50&access_token=${token}`;
    let all = [];
    for (let p = 0; p < 4 && url; p++) {
      const j = await (await fetch(url)).json();
      if (j.error) throw new Error(j.error.message);
      all = all.concat(j.data || []); url = j.paging && j.paging.next;
    }
    const vids = all.filter(m => m.media_type === "VIDEO");
    const catError = await categorize(vids, C);
    memo.data = vids; memo.prof = prof; memo.at = Date.now(); memo.catError = catError;
    res.status(200).json({ ...base, demo: false, catError, profile: prof, items: vids });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ...base, demo: true, error: e.message, profile: DP, items: demo(C) });
  }
};
