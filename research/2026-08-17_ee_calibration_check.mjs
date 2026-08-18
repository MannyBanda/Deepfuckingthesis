// INSTRUMENT VALIDATION (not a prereg cell): is the normalized best-price
// composite calibrated as a probability on the 2026 tape?
import { readFileSync } from 'fs';
const QSEC=600;
const clkSec=(c)=>{if(c==null)return null;c=String(c);if(c.includes(':')){const p=c.split(':');return (+p[0])*60+(+p[1]||0);}const n=parseFloat(c);return isNaN(n)?null:n;};
const elapsed=(p,c)=>{const cs=clkSec(c);if(cs==null||!p)return null;return (p-1)*QSEC+(QSEC-cs);};
const impl=(ml)=>ml==null||!isFinite(ml)?null:(ml>0?100/(ml+100):(-ml)/((-ml)+100));
const {games,snaps,odds}=JSON.parse(readFileSync('/tmp/ee_cache.json','utf8'));
const g26=games.filter(g=>g.date>='2026-05-01'&&g.winner&&String(g.id).includes('-'));
const pts=[];
for(const g of g26){
  const h=snaps[g.id]; if(!Array.isArray(h))continue;
  const ot=Array.isArray(odds[g.id])?odds[g.id].filter(o=>o.hml!=null&&o.aml!=null&&o.ts):[];
  if(!ot.length)continue;
  const seen=new Set();
  const rows=h.map(s=>({...s,el:elapsed(s.period,s.clock)})).filter(s=>s.el!=null).sort((a,b)=>a.el-b.el);
  for(const s of rows){
    if(s.period<2||s.period>4)continue;
    if(!isFinite(s.hp)||!isFinite(s.ap))continue;
    const m=Math.abs(s.hp-s.ap); if(m<1||m>9)continue;
    if(!(s.h&&s.a&&s.h.fga>=12&&s.a.fga>=12))continue;
    const ldHome=s.hp>s.ap;
    const bkt=`${ldHome?g.home_alias:g.away_alias}|${Math.floor(s.el/300)}`;
    if(seen.has(bkt))continue; seen.add(bkt);
    const trAl=ldHome?g.away_alias:g.home_alias;
    const st=Date.parse(s.ts); let best=null,bd=Infinity;
    for(const o of ot){const d=Math.abs(Date.parse(o.ts)-st); if(d<bd){bd=d;best=o;}}
    if(!best||bd>240000)continue;
    const trML=(trAl===g.home_alias)?best.hml:best.aml, ldML=(trAl===g.home_alias)?best.aml:best.hml;
    const it=impl(trML),il=impl(ldML); if(it==null||il==null)continue;
    pts.push({p:it/(it+il), won:g.winner===trAl});
  }
}
pts.sort((a,b)=>a.p-b.p);
console.log(`calibration points (all-gap trailers, band 1-9, 2026): ${pts.length}`);
const B=8, sz=Math.ceil(pts.length/B);
console.log('bucket | n   | mean predicted | actual | diff');
let tot=0;
for(let i=0;i<pts.length;i+=sz){
  const b=pts.slice(i,i+sz); if(!b.length)continue;
  const mp=100*b.reduce((a,x)=>a+x.p,0)/b.length, ac=100*b.filter(x=>x.won).length/b.length;
  tot+=Math.abs(mp-ac)*b.length;
  console.log(`${String(i/sz+1).padStart(6)} | ${String(b.length).padStart(3)} | ${mp.toFixed(1).padStart(14)}% | ${ac.toFixed(1).padStart(5)}% | ${((ac-mp)>0?'+':'')+(ac-mp).toFixed(1)}pp`);
}
console.log(`mean |predicted-actual| weighted: ${(tot/pts.length).toFixed(2)}pp`);
const mp=100*pts.reduce((a,x)=>a+x.p,0)/pts.length, ac=100*pts.filter(x=>x.won).length/pts.length;
console.log(`POOLED: predicted ${mp.toFixed(1)}% vs actual ${ac.toFixed(1)}% -> bias ${((ac-mp)>0?'+':'')+(ac-mp).toFixed(1)}pp`);
