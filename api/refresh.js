// Perpanjang token IG (berlaku 60 hari). Dipanggil cron tiap tgl 1 & 15.
// Jika VERCEL_API_TOKEN + VERCEL_PROJECT_ID diisi, token baru otomatis disimpan ke env Vercel.
module.exports = async (req, res) => {
  const t = process.env.IG_ACCESS_TOKEN;
  if (!t) return res.status(200).json({ ok: false, msg: "IG_ACCESS_TOKEN kosong" });
  const j = await (await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${t}`)).json();
  if (j.error) return res.status(200).json({ ok: false, msg: j.error.message });
  const vt = process.env.VERCEL_API_TOKEN, pid = process.env.VERCEL_PROJECT_ID;
  let saved = false;
  if (vt && pid) {
    const h = { Authorization: `Bearer ${vt}`, "content-type": "application/json" };
    const envs = await (await fetch(`https://api.vercel.com/v9/projects/${pid}/env`, { headers: h })).json();
    const e = (envs.envs || []).find(x => x.key === "IG_ACCESS_TOKEN");
    if (e) { const r = await fetch(`https://api.vercel.com/v9/projects/${pid}/env/${e.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ value: j.access_token }) }); saved = r.ok; }
  }
  res.status(200).json({ ok: true, expires_in_days: Math.round(j.expires_in / 86400), saved_to_vercel: saved });
};
