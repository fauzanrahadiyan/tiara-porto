// Tiara Porto - ambil video IG + kategori AI (Gemini)
const DEF_CATS = ["Iklan Produk","Fashion","Kuliner","Cinematic","Promo App","Lainnya"];
const memo = global.__porto || (global.__porto = { cats: {}, data: null, at: 0 });
const slug = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function demo(cats) {
  const caps = [
    ["Iklan skincare glowing dibuat 100% AI ✨ #iklan #skincare", 0],
    ["OOTD street style Tiara di Tokyo #fashion #ootd", 1],
    ["Bakso mercon level 5, iklan kuliner AI #kuliner #food", 2],
    ["Cinematic sunset di Bromo, short film AI #cinematic", 3],
    ["Promo aplikasi kasir UMKM #promoapp #app", 4],
    ["Behind the scene bikin video AI #bts", 5],
    ["Iklan parfum mewah versi AI #iklan", 0],
    ["Hijab outfit lebaran #fashion", 1],
    ["Es kopi susu gula aren commercial #kuliner", 2],
  ];
  return caps.map(([c, i], n) => ({
    id: "demo" + n, caption: "[CONTOH] " + c, category: cats[Math.min(i, cats.length - 1)],
    media_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    thumbnail_url: "", permalink: "https://www.instagram.com/tiara_ai_influencer/",
    timestamp: new Date(Date.now() - n * 864e5).toISOString(), demo: true,
  }));
}

async function categorize(items, cats) {
  const todo = [];
  for (const it of items) {
    const m = (it.caption || "").match(/#porto_([a-z0-9_]+)/i);
    if (m) { const c = cats.find(x => slug(x) === slug(m[1])); if (c) { it.category = c; continue; } }
    if (memo.cats[it.id]) { it.category = memo.cats[it.id]; continue; }
    todo.push(it);
  }
  const key = process.env.GEMINI_API_KEY;
  if (todo.length && key) {
    try {
      const prompt = `Kategorikan tiap caption video ke salah satu kategori: ${cats.join(", ")}. Jawab JSON saja: {"id":"kategori"}.\n` +
        todo.map(t => `${t.id}: ${(t.caption || "").slice(0, 300).replace(/\n/g, " ")}`).join("\n");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
      });
      const j = await r.json();
      const map = JSON.parse(j.candidates[0].content.parts[0].text);
      for (const t of todo) { const c = cats.find(x => x === map[t.id]); if (c) memo.cats[t.id] = c; }
    } catch (e) { console.error("gemini", e.message); }
  }
  for (const t of todo) t.category = memo.cats[t.id] || cats[cats.length - 1];
  return items;
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
    if (memo.data && Date.now() - memo.at < 6e5) return res.status(200).json({ ...base, demo: false, profile: memo.prof, items: memo.data });
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
    await categorize(vids, C);
    memo.data = vids; memo.prof = prof; memo.at = Date.now();
    res.status(200).json({ ...base, demo: false, profile: prof, items: vids });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ...base, demo: true, error: e.message, profile: DP, items: demo(C) });
  }
};
