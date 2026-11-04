// API publik klien: daftar harga, buat order (brief), lihat status, bukti transfer, setujui/revisi preview.
const db = require("./_lib/db");
const U = require("./_lib/util");

const PUBLIC = o => ({
  code: o.code, status: o.status, category: o.category, pkg: o.pkg, dur: o.dur, ratio: o.ratio, res: o.res, price: o.price,
  name: o.name, createdAt: o.createdAt, question: o.question || "", rejectReason: o.rejectReason || "",
  proofUrl: o.proofUrl ? true : false, revisions: o.revisions || [], revCount: (o.revisions || []).length,
  previewUrl: ["preview", "accepted", "done"].includes(o.status) ? o.previewUrl : "",
  finalUrl: o.status === "done" ? o.finalUrl : "", history: (o.history || []).map(h => ({ t: h.t, s: h.s })),
});
const ip = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
const isUrl = u => !u || /^https?:\/\/[^\s"'<>]+$/.test(u);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const q = req.query || {};
    const cfg = await U.getConfig();
    if (req.method === "GET" && q.action === "config") {
      return res.json({ prices: cfg.prices, durs: U.DURS, packages: cfg.packages, revisiFee: cfg.revisiFee, blob: !!process.env.BLOB_READ_WRITE_TOKEN, storage: db.ready });
    }
    if (req.method === "GET") {
      const o = await db.get("order:" + U.str(q.c, 20));
      if (!o) return res.status(404).json({ error: "Order tidak ditemukan. Cek lagi link/kode order kamu." });
      const out = PUBLIC(o);
      if (["approved", "proof", "paid", "production", "preview", "accepted", "done"].includes(o.status)) out.bank = cfg.bank;
      out.revisiFee = cfg.revisiFee[o.pkg];
      return res.json(out);
    }
    const b = await U.body(req);
    if (b.action === "create") {
      if (await db.incr("rl:create:" + ip(req), 3600) > 10) return res.status(429).json({ error: "Terlalu banyak order dari perangkat ini. Coba lagi 1 jam lagi." });
      const p = cfg.prices[b.category]; const i = U.DURS.indexOf(+b.dur);
      const price = p && i >= 0 && p[b.pkg] ? p[b.pkg][i] : 0;
      if (!price) return res.status(400).json({ error: "Pilihan paket/durasi tidak tersedia." });
      if (!b.agree) return res.status(400).json({ error: "Centang persetujuan syarat revisi dulu ya." });
      if (!U.str(b.name, 80).trim() || !/^[0-9+\-\s]{8,20}$/.test(b.wa || "")) return res.status(400).json({ error: "Nama dan nomor WhatsApp wajib diisi dengan benar." });
      if (!U.str(b.desc).trim()) return res.status(400).json({ error: "Deskripsi video wajib diisi." });
      const files = [].concat(b.refFiles || []).slice(0, 5).map(String);
      if (![b.refLink, b.logoUrl, ...files].every(isUrl)) return res.status(400).json({ error: "Link tidak valid." });
      const o = {
        code: U.code(), status: "brief", category: b.category, pkg: b.pkg === "premium" ? "premium" : "hemat", dur: +b.dur,
        ratio: b.ratio === "16:9" ? "16:9" : "9:16", res: b.pkg === "premium" ? cfg.packages.premium.res : cfg.packages.hemat.res,
        price, desc: U.str(b.desc, 3000), refLink: U.str(b.refLink, 500), refFiles: files, logoUrl: U.str(b.logoUrl, 500),
        notes: U.str(b.notes, 2000), name: U.str(b.name, 80), wa: U.str(b.wa, 20), createdAt: Date.now(),
        history: [{ t: Date.now(), s: "Brief dikirim" }], revisions: [],
      };
      await db.set("order:" + o.code, o);
      const idx = (await db.get("orders")) || []; idx.unshift(o.code); await db.set("orders", idx.slice(0, 2000));
      await U.notifyWA(`🎬 BRIEF BARU ${o.code}\n${o.name} (${o.wa})\n${o.category} · ${o.pkg} · ${o.dur} dtk · ${U.rp(o.price)}\n${U.baseUrl(req)}/admin.html#${o.code}`);
      return res.json({ ok: true, code: o.code });
    }
    const o = await db.get("order:" + U.str(b.c, 20));
    if (!o) return res.status(404).json({ error: "Order tidak ditemukan." });
    if (await db.incr("rl:act:" + ip(req), 3600) > 60) return res.status(429).json({ error: "Terlalu banyak permintaan, coba lagi nanti." });
    if (b.action === "proof") {
      if (!["approved", "proof"].includes(o.status)) return res.status(400).json({ error: "Order belum disetujui / sudah lunas." });
      if (!b.url || !isUrl(b.url)) return res.status(400).json({ error: "File bukti transfer belum ter-upload." });
      o.proofUrl = b.url; o.status = "proof"; o.history.push({ t: Date.now(), s: "Bukti transfer dikirim" });
      await db.set("order:" + o.code, o);
      await U.notifyWA(`💸 BUKTI TRANSFER ${o.code}\n${o.name} · ${U.rp(o.price)}\nCek & konfirmasi: ${U.baseUrl(req)}/admin.html#${o.code}`);
      return res.json({ ok: true });
    }
    if (b.action === "approve") {
      if (o.status !== "preview") return res.status(400).json({ error: "Belum ada preview untuk disetujui." });
      o.status = o.finalUrl ? "done" : "accepted"; o.history.push({ t: Date.now(), s: "Klien menyetujui preview" });
      await db.set("order:" + o.code, o);
      await U.notifyWA(`✅ ${o.code} DISETUJUI klien ${o.name}.${o.finalUrl ? "" : " Upload file final di admin."}`);
      return res.json({ ok: true });
    }
    if (b.action === "revise") {
      if (o.status !== "preview") return res.status(400).json({ error: "Revisi hanya bisa saat preview." });
      const note = U.str(b.note, 1500).trim(); if (!note) return res.status(400).json({ error: "Tulis dulu bagian yang mau direvisi." });
      o.revisions = o.revisions || []; const n = o.revisions.length + 1;
      o.revisions.push({ t: Date.now(), note, paid: n > 2 }); o.status = "production";
      o.history.push({ t: Date.now(), s: `Revisi ke-${n} diminta` + (n > 2 ? ` (berbayar ${U.rp(cfg.revisiFee[o.pkg])})` : "") });
      await db.set("order:" + o.code, o);
      await U.notifyWA(`✏️ REVISI ke-${n} ${o.code} (${o.name})\n"${note.slice(0, 300)}"${n > 2 ? `\n⚠️ Revisi berbayar ${U.rp(cfg.revisiFee[o.pkg])}` : ""}`);
      return res.json({ ok: true, n });
    }
    res.status(400).json({ error: "Aksi tidak dikenal" });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};
