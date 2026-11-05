// Mirror Reels: Fauzan posting Reels LANGSUNG di aplikasi Instagram -> cron mendeteksi -> auto kirim ke Threads + TikTok.
// Reels dimasukkan ke antrean sebagai item "posted" (source:"ig") lalu ditandai th/tt seperti alur lama,
// sehingga pengiriman Threads/TikTok tetap memakai kode yang sudah ada (threadsDue / tiktokDue).
const db = require("./db");
const U = require("./util");
const T = require("./tahap2");
const TH = require("./threads");
const DEF = { enabled: false, since: 0 };
async function mSettings() { return { ...DEF, ...((await db.get("mirror_settings")) || {}) }; }
async function setEnabled(on) {
  const s = await mSettings();
  // saat baru dinyalakan: hanya Reels yang diposting SETELAH ini (Reels lama tidak dikirim ulang)
  if (on && !s.enabled) s.since = Date.now() - 5 * 60000;
  s.enabled = !!on; await db.set("mirror_settings", s); return s;
}
async function mirrorStatus() {
  const s = await mSettings(); const q = (await db.get("queue")) || [];
  const items = q.filter(x => x.source === "ig").sort((a, b) => b.createdAt - a.createdAt).slice(0, 8)
    .map(x => ({ id: x.id, at: x.postedAt, caption: (x.caption || "").split("\n")[0].slice(0, 80), permalink: x.permalink, th: x.th, tt: x.tt, log: x.log }));
  return { settings: s, items, lastRun: (await db.get("mirror_last")) || null };
}
async function cronJobs() {
  const s = await mSettings(); if (!s.enabled) return { msg: "Mirror OFF" };
  const { uid } = U.IG(); if (!uid) return { error: "IG belum diatur" };
  const seen = new Set((await db.get("mirror_seen")) || []);
  const q = (await db.get("queue")) || [];
  const ours = new Set(q.map(x => x.mediaId).filter(Boolean));
  const j = await U.ig(`${uid}/media`, { fields: "id,caption,media_type,media_product_type,media_url,permalink,timestamp", limit: 10 });
  const added = []; let changed = false;
  for (const m of (j.data || []).reverse()) {
    if (seen.has(m.id) || ours.has(m.id)) continue;
    const t = Date.parse(m.timestamp) || 0;
    const isReel = /REELS/i.test(m.media_product_type || "") || m.media_type === "VIDEO";
    if (!isReel || t < s.since || Date.now() - t > 24 * 3600000) { seen.add(m.id); continue; }
    if (!m.media_url) continue; // IG kadang belum siap; coba lagi putaran berikutnya
    const it = { id: require("crypto").randomBytes(6).toString("hex"), source: "ig", mediaId: m.id, videoUrl: m.media_url, urlAt: Date.now(),
      caption: String(m.caption || "").slice(0, 2200), permalink: m.permalink, status: "posted", createdAt: t, scheduledAt: t, postedAt: t,
      log: "Diposting langsung di aplikasi IG 📱 (mirror)" };
    let any = false;
    try { if (await T.ttMark(it)) any = true; } catch (e) { it.tt = { status: "failed", log: e.message }; }
    try { if (await TH.thMark(it)) any = true; } catch (e) { it.th = { status: "failed", log: e.message }; }
    if (!any) it.log += " — Threads/TikTok OFF atau belum terhubung";
    q.push(it); seen.add(m.id); changed = true; added.push({ mediaId: m.id, th: it.th?.status, tt: it.tt?.status });
  }
  // URL video IG (CDN) bisa kedaluwarsa: segarkan untuk item mirror yang masih menunggu
  for (const it of q) {
    if (it.source !== "ig") continue;
    const busy = ["pending", "processing"].includes(it.th?.status) || ["pending", "processing"].includes(it.tt?.status);
    if (busy && Date.now() - (it.urlAt || 0) > 30 * 60000) {
      try { const m = await U.ig(it.mediaId, { fields: "media_url" }); if (m.media_url) { it.videoUrl = m.media_url; it.urlAt = Date.now(); changed = true; } } catch (e) {}
    }
  }
  if (changed) await db.set("queue", q);
  await db.set("mirror_seen", [...seen].slice(-500));
  const r = { at: Date.now(), added: added.length }; await db.set("mirror_last", r);
  return { added };
}
module.exports = { mSettings, setEnabled, mirrorStatus, cronJobs };
