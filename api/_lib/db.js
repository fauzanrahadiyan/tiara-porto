// Penyimpanan data: Upstash Redis (via Vercel Marketplace) atau file lokal saat testing.
const fs = require("fs");
const URL_ = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const TOK = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const LOCAL = "/tmp/tiara-porto-db.json";
const ready = !!(URL_ && TOK);

async function cmd(...args) {
  if (ready) {
    const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOK}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    const j = await r.json();
    if (j.error) throw new Error("Redis: " + j.error);
    return j.result;
  }
  // mode lokal (hanya untuk testing; di Vercel tanpa Redis data tidak permanen)
  let d = {}; try { d = JSON.parse(fs.readFileSync(LOCAL, "utf8")); } catch (e) {}
  const [c, k, v] = args; const C = c.toUpperCase(); let out = null;
  const now = Date.now(); if (d[k] && d[k].e && d[k].e < now) delete d[k];
  if (C === "GET") out = d[k] ? d[k].v : null;
  else if (C === "SET") { d[k] = { v: String(v) }; if (args[3] && /EX/i.test(args[3])) d[k].e = now + args[4] * 1000; out = "OK"; }
  else if (C === "DEL") { delete d[k]; out = 1; }
  else if (C === "INCR") { const n = (+(d[k] && d[k].v) || 0) + 1; d[k] = { v: String(n), e: d[k] && d[k].e }; out = n; }
  else if (C === "EXPIRE") { if (d[k]) d[k].e = now + v * 1000; out = 1; }
  fs.writeFileSync(LOCAL, JSON.stringify(d));
  return out;
}
const get = async k => { const v = await cmd("GET", "tp:" + k); try { return v == null ? null : JSON.parse(v); } catch (e) { return v; } };
const set = (k, v, ttl) => ttl ? cmd("SET", "tp:" + k, JSON.stringify(v), "EX", ttl) : cmd("SET", "tp:" + k, JSON.stringify(v));
const del = k => cmd("DEL", "tp:" + k);
async function incr(k, ttl) { const n = await cmd("INCR", "tp:" + k); if (n === 1 && ttl) await cmd("EXPIRE", "tp:" + k, ttl); return n; }
module.exports = { get, set, del, incr, ready };
