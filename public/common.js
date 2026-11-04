// Helper bersama: API, upload file (Vercel Blob / lokal), format Rupiah.
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rp = n => "Rp" + Number(n || 0).toLocaleString("id-ID");
const rpk = n => n >= 1e6 ? "Rp" + (n / 1e6).toLocaleString("id-ID") + "jt" : "Rp" + (n / 1e3) + "rb";
const tgl = t => new Date(t).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " WIB";
function toast(m, bad) { const d = document.createElement("div"); d.className = "toast"; d.innerHTML = (bad ? "⚠️ " : "") + esc(m); document.body.appendChild(d); setTimeout(() => d.remove(), 3500); }
async function api(url, data) {
  const r = await fetch(url, data ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {});
  const j = await r.json().catch(() => ({ error: "Server error " + r.status }));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || "Gagal"), { status: r.status });
  return j;
}
let BLOB = null;
async function upFile(file, kind, onp) {
  if (BLOB === null) BLOB = (await api("/api/order?action=config")).blob;
  if (BLOB) {
    const { upload } = await import("https://esm.sh/@vercel/blob@2/client");
    const r = await upload(file.name.replace(/[^\w.\-]/g, "_"), file, { access: "public", handleUploadUrl: "/api/upload", clientPayload: kind, multipart: file.size > 20e6, onUploadProgress: e => onp && onp(e.percentage) });
    return r.url;
  }
  const r = await fetch(`/api/upload?kind=${kind}&name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`, { method: "POST", body: file });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.url;
}
// pasang upload ke <label class="drop"><input type=file hidden></label>
function dropper(el, kind, cb) {
  const inp = el.querySelector("input"), txt = el.querySelector("span");
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return; txt.textContent = "Mengupload " + f.name + "…";
    try { const url = await upFile(f, kind, p => txt.textContent = `Mengupload ${Math.round(p)}%…`); el.classList.add("done"); txt.textContent = "✓ " + f.name; el.dataset.url = url; cb && cb(url, f); }
    catch (e) { txt.textContent = "Gagal: " + e.message; toast(e.message, 1); }
  };
}
