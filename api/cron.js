// Penjadwal tunggal: dipanggil cron-job.org tiap 10-15 menit (+ Vercel Cron harian sebagai cadangan).
// Tugas: hitung Jam Emas harian, posting Reels, repost TikTok, tren harian (>=06:00 WIB), laporan Senin (>=07:00 WIB), balas komentar.
const U = require("./_lib/util");
const C = require("./_lib/content");
const T = require("./_lib/tahap2");
const TH = require("./_lib/threads");
module.exports = async (req, res) => {
  const sec = process.env.CRON_SECRET;
  const given = (req.query && req.query.secret) || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!sec || !given || !U.safeEq(given, sec)) return res.status(401).json({ ok: false, error: "CRON_SECRET salah / belum diatur" });
  const out = { at: new Date().toISOString() };
  for (const [k, fn] of [["golden", () => C.computeGolden()], ["publish", () => C.publishDue()], ["tiktok", () => T.tiktokDue()], ["threads", () => TH.cronJobs()], ["daily", () => T.dailyJobs()], ["comments", () => C.processComments()]]) {
    try { const r = await fn(); out[k] = k === "golden" ? r.slots : r; } catch (e) { out[k] = { error: e.message }; }
  }
  res.json({ ok: true, ...out });
};
