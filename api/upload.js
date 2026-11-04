// Upload file langsung dari browser ke Vercel Blob (bisa file besar, tidak lewat batas 4.5MB server).
const U = require("./_lib/util");
const db = require("./_lib/db");
const RULES = {
  ref: { types: ["image/*", "video/*", "application/pdf"], max: 50 }, logo: { types: ["image/*"], max: 10 },
  proof: { types: ["image/*", "application/pdf"], max: 10 },
  admin: { types: ["video/*", "image/*", "application/zip", "application/octet-stream"], max: 500, admin: true },
};
module.exports = async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // MODE LOKAL (testing tanpa Vercel Blob): simpan ke /tmp
    const fs = require("fs"), path = require("path"), dir = "/tmp/tp-files"; fs.mkdirSync(dir, { recursive: true });
    if (req.method === "GET") { const f = path.join(dir, path.basename(String(req.query.f || ""))); if (!fs.existsSync(f)) return res.status(404).end(); res.setHeader("content-type", req.query.t || "application/octet-stream"); return res.end(fs.readFileSync(f)); }
    const kind = req.query.kind; if (RULES[kind] && RULES[kind].admin && !U.readSession(req)) return res.status(401).json({ error: "Login admin dulu" });
    const name = Date.now() + "-" + path.basename(String(req.query.name || "file")).replace(/[^\w.\-]/g, "_");
    const chunks = []; for await (const c of req) chunks.push(c); fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
    return res.json({ url: `/api/upload?f=${encodeURIComponent(name)}&t=${encodeURIComponent(req.query.type || "")}` });
  }
  const { handleUpload } = require("@vercel/blob/client");
  try {
    const body = await U.body(req);
    const json = await handleUpload({
      body, request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const kind = String(clientPayload || "ref"); const r = RULES[kind] || RULES.ref;
        if (r.admin && !U.readSession(req)) throw new Error("Login admin dulu");
        if (!r.admin) { const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0]; if (await db.incr("rl:up:" + ip, 3600) > 30) throw new Error("Terlalu banyak upload, coba lagi nanti"); }
        return { allowedContentTypes: r.types, maximumSizeInBytes: r.max * 1024 * 1024, addRandomSuffix: true };
      },
      onUploadCompleted: async () => {},
    });
    res.json(json);
  } catch (e) { res.status(400).json({ error: e.message }); }
};
