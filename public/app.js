const T={id:{sub:"Portofolio video iklan & konten AI oleh @tiara_ai_influencer. Pilih kategori untuk melihat contoh karya.",wa:"Hubungi via WhatsApp",igp:"Lihat di Instagram",open:"Buka di Instagram",all:"Semua",fol:"pengikut",ex:"contoh",demo:"MODE DEMO — data contoh, bukan video asli.",empty:"Belum ada video di kategori ini.",msg:"Halo, saya lihat portofolio Tiara Porto dan tertarik bikin video.",order:"🎬 Pesan video seperti ini",pesan:"Pesan Video AI",ordcat:"🎬 Pesan video {c} seperti ini"},
en:{sub:"AI commercial & content video portfolio by @tiara_ai_influencer. Pick a category to explore the work.",wa:"Contact via WhatsApp",igp:"View on Instagram",open:"Open on Instagram",all:"All",fol:"followers",ex:"sample",demo:"DEMO MODE — sample data, not real videos.",empty:"No videos in this category yet.",msg:"Hi Tiara Porto, I'm interested in an AI video.",order:"🎬 Order a video like this",pesan:"Order AI Video",ordcat:"🎬 Order a {c} video like this"}};
const CEN={"Iklan & UGC":"Ads & UGC","Cover Lagu":"Song Covers","Lainnya":"Others"};
const q=new URLSearchParams(location.search);let L=q.get("lang")||localStorage.lang||"id",D,cur=q.get("cat")||"all";
const $=s=>document.querySelector(s),cn=c=>L=="en"?(CEN[c]||c):c,esc=s=>(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const GR=["#ff2f7f,#6a1b9a","#ff8a65,#c2185b","#7c4dff,#ff4081","#00bcd4,#7b1fa2","#ffb300,#d81b60","#455a64,#ad1457"];
function txt(){document.querySelectorAll("[data-i]").forEach(e=>e.textContent=T[L][e.dataset.i]);$("#lang").textContent=L=="id"?"EN":"ID";document.documentElement.lang=L;
 const w=$("#wa");if(D&&D.wa){w.hidden=false;w.href="https://wa.me/"+D.wa.replace(/\D/g,"")+"?text="+encodeURIComponent(T[L].msg)}else w.hidden=true}
function prof(){const p=D.profile,e=$("#prof");if(!p){e.hidden=true;return}e.hidden=false;
 const f=p.followers_count!=null?new Intl.NumberFormat(L=="en"?"en":"id-ID",{notation:"compact"}).format(p.followers_count)+" "+T[L].fol:"";
 e.innerHTML=`<div class="av">${p.profile_picture_url?`<img src="${esc(p.profile_picture_url)}" alt="">`:`<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#2a1820"/><circle cx="50" cy="38" r="18" fill="#6b4a58"/><path d="M14 96c4-22 18-32 36-32s32 10 36 32z" fill="#6b4a58"/></svg><span class="ex">${T[L].ex}</span>`}</div>
 <div class="pi"><b>${esc(p.name||p.username)}</b><a href="https://www.instagram.com/${esc(p.username)}/" target="_blank">@${esc(p.username)}</a>${f?`<small>${f}</small>`:""}${p.biography?`<p>${esc(p.biography.slice(0,120))}</p>`:""}</div>`}
function chips(){$("#chips").innerHTML=["all",...D.categories].map(c=>`<button class="${c==cur?"on":""}" data-c="${esc(c)}">${c=="all"?T[L].all:esc(cn(c))}</button>`).join("");
 $("#chips").querySelectorAll("button").forEach(b=>b.onclick=()=>{cur=b.dataset.c;render()})}
const OK_CAT=["Iklan & UGC","Motion Graphic","Cover Lagu","Short Film","Lifestyle"],ordUrl=c=>"/pesan.html"+(OK_CAT.includes(c)?"?cat="+encodeURIComponent(c):"");
function render(){txt();prof();chips();$("#ordbtn").href=ordUrl(cur);$("#ordbtn").textContent=cur=="all"||!OK_CAT.includes(cur)?"🎬 "+T[L].pesan:T[L].ordcat.replace("{c}",cn(cur));const it=D.items.filter(i=>cur=="all"||i.category==cur);
 $("#grid").innerHTML=it.length?it.map((v,n)=>{const gi=D.categories.indexOf(v.category);return `<div class="card" data-n="${D.items.indexOf(v)}">
 ${v.thumbnail_url?`<img loading="lazy" src="${esc(v.thumbnail_url)}" alt="">`:`<div class="ph" style="background:linear-gradient(160deg,${GR[(gi<0?0:gi)%6]})"></div>`}
 <span class="play">▶</span><div class="info"><span class="tag">${esc(cn(v.category))}</span><p>${esc(v.caption)}</p></div></div>`}).join(""):`<div class="empty">${T[L].empty}</div>`;
 $("#grid").querySelectorAll(".card").forEach(c=>c.onclick=()=>openV(D.items[c.dataset.n]))}
function openV(v){$("#vid").src=v.media_url;$("#vid").poster=v.thumbnail_url||"";$("#mcat").textContent=cn(v.category);$("#mcap").textContent=v.caption||"";$("#mlink").href=v.permalink;$("#morder").href=ordUrl(v.category);$("#modal").hidden=false;$("#vid").play().catch(()=>{})}
$("#close").onclick=()=>{$("#vid").pause();$("#modal").hidden=true};$("#modal").onclick=e=>{if(e.target.id=="modal")$("#close").onclick()};
$("#lang").onclick=()=>{L=L=="id"?"en":"id";localStorage.lang=L;render()};
fetch("/api/media"+(q.get("demo")=="1"?"?demo=1":"")).then(r=>r.json()).then(d=>{D=d;$("#demo").hidden=!d.demo;render();if(q.get("open"))openV(D.items[+q.get("open")])});
