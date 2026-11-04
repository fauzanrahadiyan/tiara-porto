// Radar Tiara — globe 3D ringan (d3-geo orthographic di canvas), dimuat hanya saat tab Radar dibuka.
(function(){
const CAT={influencer:["⭐ AI influencer","#ffd54a"],murid:["🎓 Calon murid","#3ee8a5"],viral:["🔥 Viral AI","#ff5a3c"],lain:["🎬 AI lain","#8b9cff"],collab:["🤝 Calon collab","#29d4ff"]};
const ld=src=>new Promise((ok,no)=>{if(document.querySelector(`script[src="${src}"]`))return ok();const s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=()=>no(new Error("Gagal memuat "+src));document.head.appendChild(s)});
let LAND=null,RAF=0,STOP=null;
async function libs(){await ld("https://cdn.jsdelivr.net/npm/d3-array@3");await ld("https://cdn.jsdelivr.net/npm/d3-geo@3");await ld("https://cdn.jsdelivr.net/npm/topojson-client@3");
 if(!LAND){const w=await (await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json")).json();LAND=topojson.feature(w,w.objects.land)}}
function globe(cv,items,onPick){
 const mob=innerWidth<700,dpr=Math.min(devicePixelRatio||1,mob?1.5:2),ctx=cv.getContext("2d");
 let W,R,rot=[-110,-10],drag=null,last=0,sweep=0,sel=null,pins=[];
 const size=()=>{W=cv.clientWidth;cv.width=W*dpr;cv.height=W*dpr;R=W/2-8};size();addEventListener("resize",size);
 const P=d3.geoOrthographic().clipAngle(90);const path=d3.geoPath(P,ctx);const grat=d3.geoGraticule10();
 function draw(t){
  const fps=mob?24:50;if(t-last<1000/fps){RAF=requestAnimationFrame(draw);return}const dt=Math.min(100,t-last);last=t;
  if(!drag)rot[0]+=dt*0.006;sweep=(sweep+dt*0.0025)%(Math.PI*2);
  P.scale(R).translate([W/2,W/2]).rotate(rot);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,W);
  const g=ctx.createRadialGradient(W/2-R*.3,W/2-R*.3,R*.1,W/2,W/2,R);g.addColorStop(0,"#2a1640");g.addColorStop(1,"#0b0614");
  ctx.beginPath();path({type:"Sphere"});ctx.fillStyle=g;ctx.fill();ctx.strokeStyle="#ff2d9566";ctx.lineWidth=1.5;ctx.stroke();
  ctx.beginPath();path(grat);ctx.strokeStyle="#ffffff12";ctx.lineWidth=.6;ctx.stroke();
  ctx.beginPath();path(LAND);ctx.fillStyle="#3a2350";ctx.fill();ctx.strokeStyle="#ff6ab855";ctx.lineWidth=.7;ctx.stroke();
  // garis radar menyapu
  ctx.save();ctx.beginPath();ctx.arc(W/2,W/2,R,0,7);ctx.clip();
  const sg=ctx.createConicGradient?ctx.createConicGradient(sweep-0.9,W/2,W/2):null;
  if(sg){sg.addColorStop(0,"#ff2d9500");sg.addColorStop(.14,"#ff2d9555");sg.addColorStop(.145,"#ff2d9500");ctx.fillStyle=sg;ctx.fillRect(0,0,W,W)}
  ctx.strokeStyle="#ff8ac4";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(W/2,W/2);ctx.lineTo(W/2+Math.cos(sweep)*R,W/2+Math.sin(sweep)*R);ctx.stroke();
  for(const r of [.33,.66])ctx.beginPath(),ctx.arc(W/2,W/2,R*r,0,7),ctx.strokeStyle="#ff2d9522",ctx.stroke();ctx.restore();
  // titik
  pins=[];const c=P.invert([W/2,W/2]);
  for(const it of items){if(d3.geoDistance([it.lng,it.lat],c)>Math.PI/2-.05)continue;const [x,y]=P([it.lng,it.lat]);const col=(CAT[it.cat]||CAT.lain)[1];
   const ph=(t/600+(it.lat*7%6))%(Math.PI*2),pulse=(Math.sin(ph)+1)/2,done=it.status!="new";if(it.cat=="collab"){ctx.save();ctx.translate(x,y);ctx.rotate(Math.PI/4);ctx.strokeStyle=col;ctx.lineWidth=1.5;const q=7+pulse*6;ctx.strokeRect(-q,-q,q*2,q*2);ctx.restore()}
   ctx.beginPath();ctx.arc(x,y,5+pulse*9,0,7);ctx.fillStyle=col+(done?"18":"33");ctx.fill();
   ctx.beginPath();ctx.arc(x,y,sel===it?7:4.5,0,7);ctx.fillStyle=done?"#777":col;ctx.shadowColor=col;ctx.shadowBlur=mob?0:12;ctx.fill();ctx.shadowBlur=0;
   if(sel===it){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.stroke()}pins.push([x,y,it])}
  RAF=requestAnimationFrame(draw)}
 const pt=e=>{const r=cv.getBoundingClientRect(),p=e.touches?e.touches[0]:e;return[p.clientX-r.left,p.clientY-r.top]};
 cv.onpointerdown=e=>{drag={p:pt(e),r:rot.slice(),moved:0}};
 cv.onpointermove=e=>{if(!drag)return;const p=pt(e),dx=p[0]-drag.p[0],dy=p[1]-drag.p[1];if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=1;rot=[drag.r[0]+dx*.4,Math.max(-60,Math.min(60,drag.r[1]-dy*.4))]};
 cv.onpointerup=e=>{const d=drag;drag=null;if(d&&d.moved)return;const [x,y]=pt(e);let b=null,bd=18;for(const [px,py,it] of pins){const dd=Math.hypot(px-x,py-y);if(dd<bd)bd=dd,b=it}if(b){sel=b;onPick(b)}};
 const vis=()=>{cancelAnimationFrame(RAF);if(!document.hidden)RAF=requestAnimationFrame(draw)};document.addEventListener("visibilitychange",vis);
 RAF=requestAnimationFrame(draw);
 window.RADAR_FOCUS=it=>{sel=it;rot=[-it.lng,-it.lat]};
 return()=>{cancelAnimationFrame(RAF);document.removeEventListener("visibilitychange",vis);removeEventListener("resize",size)}}
window.RADAR={CAT,libs,globe,stop:()=>{STOP&&STOP();STOP=null},start:(cv,items,onPick)=>{STOP&&STOP();STOP=globe(cv,items,onPick)}};
})();
