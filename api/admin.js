// API admin (khusus Fauzan): order jasa AI video, Konten Tiara, balas komentar, pengaturan.
const crypto = require("crypto");
const db = require("./_lib/db");
const U = require("./_lib/util");
const C = require("./_lib/content");
const T = require("./_lib/tahap2");
const TH = require("./_lib/threads");
const MODELS = { seedance: "Seedance 2.5", grok: "Grok Imagine 1.5", omni: "Gemini Omni 1.1 Flash" };
const ip = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
const cookie = (res, v, age) => res.setHeader("Set-Cookie", `tp_adm=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${process.env.VERCEL ? "; Secure" : ""}`);
const briefText = o => `Kategori: ${o.category}\nPaket: ${o.pkg} (${o.res})\nDurasi: ${o.dur} detik\nRasio: ${o.ratio}\nDeskripsi: ${o.desc}\nReferensi: ${o.refLink || "-"} ${(o.refFiles || []).join(" ")}\nLogo brand: ${o.logoUrl ? "ada (wajib tampil sesuai brief)" : "tidak ada"}\nCatatan: ${o.notes || "-"}` + ((o.revisions || []).length ? `\nPermintaan revisi terakhir: ${o.revisions[o.revisions.length - 1].note}` : "");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  try {
    const b = req.method === "POST" ? await U.body(req) : {};
    const action = q.action || b.action;
    // ---------- LOGIN ----------
    if (action === "me") { const s = U.readSession(req); return res.json({ who: s && s.who, google: process.env.GOOGLE_CLIENT_ID || "", password: !!process.env.ADMIN_PASSWORD, storage: db.ready, blob: !!process.env.BLOB_READ_WRITE_TOKEN }); }
    if (action === "logout") { cookie(res, "", 0); return res.json({ ok: true }); }
    if (action === "login") {
      if (await db.incr("rl:login:" + ip(req), 900) > 10) return res.status(429).json({ error: "Terlalu banyak percobaan. Tunggu 15 menit." });
      let who = null;
      if (b.credential && process.env.GOOGLE_CLIENT_ID) {
        const t = await (await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(b.credential))).json();
        if (t.aud === process.env.GOOGLE_CLIENT_ID && (t.email_verified === true || t.email_verified === "true") && U.ADMIN_EMAILS().includes(String(t.email).toLowerCase())) who = t.email;
        else return res.status(403).json({ error: "Email ini tidak punya akses admin." });
      } else if (b.password && process.env.ADMIN_PASSWORD && U.safeEq(b.password, process.env.ADMIN_PASSWORD)) who = "admin";
      if (!who) return res.status(403).json({ error: process.env.ADMIN_PASSWORD ? "Password salah." : "ADMIN_PASSWORD belum diisi di Vercel." });
      cookie(res, U.makeSession(who), 7 * 86400); return res.json({ ok: true, who });
    }
    if (!U.readSession(req)) return res.status(401).json({ error: "Login dulu" });
    if (req.method === "POST") { const o = req.headers.origin, h = req.headers["x-forwarded-host"] || req.headers.host; if (o && h && new URL(o).host !== h) return res.status(403).json({ error: "Origin ditolak" }); }

    // ---------- ORDER ----------
    if (action === "orders") {
      const idx = (await db.get("orders")) || []; const list = [];
      for (const c of idx.slice(0, 200)) { const o = await db.get("order:" + c); if (o) list.push(o); }
      const paidS = ["paid", "production", "preview", "accepted", "done"];
      const month = new Date().toISOString().slice(0, 7);
      const stats = { total: list.length, baru: list.filter(o => o.status === "brief").length, proof: list.filter(o => o.status === "proof").length,
        jalan: list.filter(o => ["paid", "production", "preview", "accepted"].includes(o.status)).length,
        income: list.filter(o => paidS.includes(o.status)).reduce((a, o) => a + o.price, 0),
        incomeMonth: list.filter(o => paidS.includes(o.status) && new Date(o.paidAt || o.createdAt).toISOString().slice(0, 7) === month).reduce((a, o) => a + o.price, 0) };
      return res.json({ stats, orders: list.map(o => ({ code: o.code, name: o.name, category: o.category, pkg: o.pkg, dur: o.dur, price: o.price, status: o.status, createdAt: o.createdAt })) });
    }
    if (action === "order") { const o = await db.get("order:" + q.c); return o ? res.json(o) : res.status(404).json({ error: "Tidak ada" }); }
    if (action === "orderAct" || action === "prompt" || action === "qc" || action === "fixPrompt") {
      const o = await db.get("order:" + U.str(b.c, 20)); if (!o) return res.status(404).json({ error: "Order tidak ada" });
      const log = s => o.history.push({ t: Date.now(), s });
      let extra = {};
      if (action === "orderAct") {
        const a = b.act;
        if (a === "accept") { o.status = "approved"; o.question = ""; log("Disetujui, menunggu pembayaran"); }
        else if (a === "reject") { o.status = "rejected"; o.rejectReason = U.str(b.text, 500); log("Ditolak"); }
        else if (a === "ask") { o.question = U.str(b.text, 1000); log("Admin bertanya"); }
        else if (a === "paid") { o.status = "paid"; o.paidAt = Date.now(); o.cost = T.orderCost(o, await T.costSettings()); log("Pembayaran lunas (modal " + U.rp(o.cost) + ")"); }
        else if (a === "production") { o.status = "production"; log("Masuk produksi"); }
        else if (a === "preview") { if (!b.url) return res.status(400).json({ error: "Upload video preview dulu" }); o.previewUrl = b.url; o.status = "preview"; log("Preview dikirim ke klien"); }
        else if (a === "final") { if (!b.url) return res.status(400).json({ error: "Upload file final dulu" }); o.finalUrl = b.url; if (o.status === "accepted") o.status = "done"; log("File final diunggah"); }
        else if (a === "done") { o.status = "done"; log("Selesai"); }
        else if (a === "savePrompt") { o.prompt = U.str(b.text, 6000); }
        else if (a === "delete") { await db.del("order:" + o.code); const idx = (await db.get("orders")) || []; await db.set("orders", idx.filter(x => x !== o.code)); return res.json({ ok: true }); }
        else return res.status(400).json({ error: "Aksi?" });
      }
      if (action === "prompt") {
        const m = MODELS[b.model] || MODELS.omni;
        o.promptModel = m;
        o.prompt = await U.gemini(`Kamu prompt engineer video AI profesional. Buat 1 prompt video untuk model ${m} berdasarkan brief klien berikut.
${briefText(o)}
Aturan: rasio ${o.ratio}${o.ratio === "9:16" ? " (vertikal)" : " (horizontal)"}, durasi ${o.dur} detik (jika model hanya bisa klip pendek, pecah jadi beberapa SHOT berurutan dengan durasi tiap shot), tanpa musik/backsound KECUALI brief meminta musik, kulit dan wajah realistis, gerakan kamera dinamis tapi halus, konten sopan & halal, sebut letak logo jika ada.
Format jawaban (bahasa Inggris untuk prompt, catatan singkat bahasa Indonesia):
PROMPT:
<prompt lengkap>
NEGATIVE:
<hal yang dihindari>
CATATAN:
<1-3 tips singkat untuk Fauzan>`);
        log("Prompt dibuat (" + m + ")");
      }
      if (action === "qc") {
        if (!b.url) return res.status(400).json({ error: "Upload video hasil dulu" });
        o.resultUrl = b.url;
        const part = await U.geminiFile(b.url.startsWith("/") ? "http://" + req.headers.host + b.url : b.url, b.mime || "video/mp4");
        o.qc = await U.gemini([part, { text: `Kamu QC video AI yang jujur dan teliti untuk jasa video Tiara Porto. Bandingkan video ini dengan brief klien:
${briefText(o)}
Periksa: kesesuaian brief, rasio, durasi, wajah/tangan/kulit (artefak AI), konsistensi karakter, teks/logo, gerakan, kualitas gambar, kesopanan konten.
Jawab JSON bahasa Indonesia: {"skor":0-100,"ringkasan":"...","checklist":[{"item":"...","ok":true,"catatan":"..."}],"saran":["..."],"siap_kirim":true}` }], { json: true, timeout: 55000 });
        log("QC: skor " + o.qc.skor);
      }
      if (action === "fixPrompt") {
        o.prompt = await U.gemini(`Perbaiki prompt video AI berikut berdasarkan hasil QC. Model: ${o.promptModel || "Gemini Omni 1.1 Flash"}.
Brief:\n${briefText(o)}\nPrompt lama:\n${o.prompt || "-"}\nHasil QC:\n${JSON.stringify(o.qc || {})}
Tulis ulang dengan format sama (PROMPT / NEGATIVE / CATATAN), fokus memperbaiki kekurangan. Tanpa musik kecuali diminta brief. Konten sopan & halal.`);
        log("Prompt perbaikan dibuat");
      }
      await db.set("order:" + o.code, o);
      return res.json({ ok: true, order: o, ...extra });
    }
    // ---------- PENGATURAN ----------
    if (action === "config") {
      if (req.method === "GET") return res.json(await U.getConfig());
      const cur = (await db.get("config")) || {};
      if (b.prices) { for (const k in b.prices) for (const p of ["hemat", "premium"]) b.prices[k][p] = (b.prices[k][p] || []).slice(0, 4).map(n => Math.max(0, Math.round(+n || 0))); cur.prices = b.prices; }
      if (b.bank) cur.bank = { nama: U.str(b.bank.nama, 60), norek: U.str(b.bank.norek, 40), atasNama: U.str(b.bank.atasNama, 80), catatan: U.str(b.bank.catatan, 300) };
      if (b.revisiFee) cur.revisiFee = { hemat: +b.revisiFee.hemat || 0, premium: +b.revisiFee.premium || 0 };
      await db.set("config", cur); return res.json({ ok: true });
    }
    // ---------- KONTEN TIARA ----------
    if (action === "caption") {
      const t = await U.gemini(`Tulis caption Instagram Reels untuk @tiara_ai_influencer (AI influencer cewek Suroboyo, ramah, lucu, sopan, halal).
Isi/ide video: ${U.str(b.idea, 1000) || "(tidak diisi, buat caption umum keseharian Tiara)"}
Format:
1. 1-3 kalimat bahasa Suroboyo campur Indonesia (rek, cak, isok, ae...), 1-2 emoji
2. baris kosong, lalu versi bahasa Inggris singkat
3. baris kosong, CTA: Komen "Tiara" biar tak kirimi link ngobrol bareng aku 💕
4. baris kosong, 8-12 hashtag relevan (campur #aiinfluencer #tiaraai #suroboyo dll)
Tulis captionnya saja tanpa penjelasan.`);
      return res.json({ caption: t.slice(0, 2200) });
    }
    if (action === "queue") {
      let qq = (await db.get("queue")) || [];
      if (req.method === "POST") {
        if (b.op === "add") {
          if (!b.videoUrl) return res.status(400).json({ error: "Upload video dulu" });
          const it = { id: crypto.randomBytes(6).toString("hex"), videoUrl: b.videoUrl, caption: U.str(b.caption, 2200), status: "queued", createdAt: Date.now() };
          if (b.at) { const t = Date.parse(b.at + "+07:00"); if (t > Date.now()) { it.scheduledAt = t; it.status = "scheduled"; } }
          qq.push(it); await db.set("queue", qq); qq = await C.autoSchedule();
        } else if (b.op === "del") {
          const it = qq.find(x => x.id === b.id); if (it && it.status !== "posted") await U.delBlob(it.videoUrl);
          qq = qq.filter(x => x.id !== b.id); await db.set("queue", qq);
        } else if (b.op === "caption") { const it = qq.find(x => x.id === b.id); if (it && it.status !== "posted") { it.caption = U.str(b.caption, 2200); await db.set("queue", qq); } }
        else if (b.op === "now") {
          const it = qq.find(x => x.id === b.id); if (!it) return res.status(404).json({ error: "Tidak ada" });
          if (it.status !== "processing") { it.status = "scheduled"; it.scheduledAt = Date.now(); it.tries = 0; } await db.set("queue", qq);
          const r = await C.publishDue(b.id); qq = (await db.get("queue")) || []; return res.json({ queue: qq, result: r });
        }
      }
      return res.json({ queue: qq.sort((a, b) => (b.scheduledAt || b.createdAt) - (a.scheduledAt || a.createdAt)).slice(0, 100) });
    }
    if (action === "golden") return res.json(await C.computeGolden(q.force === "1" || b.force));
    // ---------- KOMENTAR ----------
    if (action === "comments") {
      if (req.method === "POST") {
        if (b.op === "settings") { const s = await C.commentSettings(); Object.assign(s, { enabled: !!b.enabled, mode: b.mode === "auto" ? "auto" : "review", keywords: U.str(b.keywords, 200), maxPerHour: Math.min(60, Math.max(1, +b.maxPerHour || 50)) }); await db.set("csettings", s); }
        if (b.op === "send") await C.sendReply(b.id, b.text);
        if (b.op === "dismiss") for (const k of ["cpending", "cflagged"]) { const l = (await db.get(k)) || []; await db.set(k, l.filter(x => x.id !== b.id)); }
        if (b.op === "run") { const s = await C.commentSettings(); if (!s.enabled) return res.status(400).json({ error: "Nyalakan dulu fitur balas komentar" }); var run = await C.processComments(4); }
        if (b.op === "run") return res.json({ run, ...(await commentsData()) });
      }
      return res.json(await commentsData());
    }
    // ---------- TIKTOK ----------
    if (action === "tiktok_callback") {
      try { await T.ttCallback(q); res.statusCode = 302; res.setHeader("Location", "/admin?tt=ok"); }
      catch (e) { res.statusCode = 302; res.setHeader("Location", "/admin?tt=" + encodeURIComponent(e.message.slice(0, 150))); }
      return res.end();
    }
    if (action === "tiktok") {
      if (req.method === "POST") {
        if (b.op === "connect") return res.json({ url: await T.ttAuthUrl() });
        if (b.op === "settings") { const s = await T.ttSettings(); s.enabled = !!b.enabled; s.privacy = ["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"].includes(b.privacy) ? b.privacy : "SELF_ONLY"; await db.set("tt_settings", s); }
        if (b.op === "disconnect") await db.del("tt_token");
        if (b.op === "retry") { const qq = (await db.get("queue")) || []; const it = qq.find(x => x.id === b.id); if (!it || it.videoDeleted) return res.status(400).json({ error: "Video sudah tidak tersimpan" }); it.tt = { status: "pending", log: "Dikirim ulang" }; await db.set("queue", qq); return res.json({ result: await T.tiktokDue(b.id) }); }
      }
      return res.json(await T.ttStatus());
    }
    // ---------- THREADS ----------
    if (action === "threads_callback") {
      try { await TH.thCallback(q); res.statusCode = 302; res.setHeader("Location", "/admin?th=ok"); }
      catch (e) { res.statusCode = 302; res.setHeader("Location", "/admin?th=" + encodeURIComponent(e.message.slice(0, 150))); }
      return res.end();
    }
    if (action === "threads") {
      if (req.method === "POST") {
        if (b.op === "connect") return res.json({ url: await TH.thAuthUrl() });
        if (b.op === "disconnect") await db.del("th_token");
        if (b.op === "settings") { const s = await TH.thSettings(); Object.assign(s, { crosspost: !!b.crosspost, replies: !!b.replies, replyMode: b.replyMode === "auto" ? "auto" : "review", daily: !!b.daily, dailyMode: b.dailyMode === "review" ? "review" : "auto" }); await db.set("th_settings", s); }
        if (b.op === "postnow") return res.json({ post: await TH.textNow(!!b.review), ...(await TH.thStatus()) });
        if (b.op === "sendtext") return res.json({ post: await TH.sendText(b.id, b.text), ...(await TH.thStatus()) });
        if (b.op === "deltext") { const l = (await db.get("th_texts")) || []; await db.set("th_texts", l.filter(x => x.id !== b.id)); }
        if (b.op === "retry") { const qq = (await db.get("queue")) || []; const it = qq.find(x => x.id === b.id); if (!it || it.videoDeleted) return res.status(400).json({ error: "Video sudah tidak tersimpan" }); it.th = { status: "pending", log: "Dikirim ulang" }; await db.set("queue", qq); return res.json({ result: await TH.threadsDue() }); }
      }
      return res.json(await TH.thStatus());
    }
    // ---------- UNTUNG-RUGI, TREN, LAPORAN ----------
    if (action === "profit") {
      if (req.method === "POST") {
        if (b.op === "addExp") await T.addExpense(b);
        if (b.op === "delExp") await T.delExpense(b.id);
        if (b.op === "costs") { const c = await T.costSettings(); for (const k of ["premiumPer30", "hematPer10", "fixedMonthly"]) if (b[k] != null) c[k] = Math.max(0, Math.round(+b[k] || 0)); if (b.fixedLabel != null) c.fixedLabel = U.str(b.fixedLabel, 60); await db.set("cost_settings", c); }
      }
      return res.json(await T.profit(q.m || b.month));
    }
    if (action === "reports") {
      if (req.method === "POST" && b.op === "trend") await T.trendNow();
      if (req.method === "POST" && b.op === "weekly") await T.weeklyNow();
      return res.json({ trend: await db.get("trend_latest"), trendHist: ((await db.get("trend_hist")) || []).slice(1, 7), weekly: await db.get("weekly_latest") });
    }
    if (action === "testwa") return res.json(await U.notifyWA("Tes notifikasi dari Tiara Porto ✅"));
    res.status(400).json({ error: "Aksi tidak dikenal" });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};
async function commentsData() {
  return { settings: await C.commentSettings(), pending: (await db.get("cpending")) || [], flagged: (await db.get("cflagged")) || [], history: ((await db.get("chistory")) || []).slice(0, 50) };
}
