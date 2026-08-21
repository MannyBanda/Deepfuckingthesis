// Regenerates the R3 context-line stat under the PRODUCTION definition:
// rank-based terciles (top-5 CLEAN / mid-5 / bottom-5 SLOPPY) from as-of shrunk
// M1, strict-<, >=10 GP. Population: 2026 tape, band 1-9, gap>=.15, leader
// POT>=6, pre-Q4. Pin the output in the copy constant with its as-of date.
import { readFileSync } from 'fs';
const K=10, QSEC=600;
const clkSec=(c)=>{if(c==null)return null;c=String(c);if(c.includes(':')){const p=c.split(':');return (+p[0])*60+(+p[1]||0);}const n=parseFloat(c);return isNaN(n)?null:n;};
const el=(p,c)=>{const cs=clkSec(c);if(cs==null||!p)return null;return (p-1)*QSEC+(QSEC-cs);};
const TG = JSON.parse(readFileSync('/tmp/late_exec_substrate.json','utf8'))
  .filter(r=>r.bounds>=4&&r.qto.every(x=>x!=null)&&r.qposs.every(x=>x!=null&&x>0))
  .map(r=>({date:r.date,team:r.team,toL:r.qto[2]+r.qto[3],possL:r.qposs[2]+r.qposs[3]}))
  .sort((a,b)=>a.date<b.date?-1:1);
function ladderAsOf(date){
  const lg=TG.filter(t=>t.date<date);
  if(!lg.length) return null;
  const lgRate=100*lg.reduce((a,t)=>a+t.toL,0)/lg.reduce((a,t)=>a+t.possL,0);
  const teams={};
  for(const t of lg)(teams[t.team]=teams[t.team]||[]).push(t);
  const vals=[];
  for(const [tm,rows] of Object.entries(teams)){
    if(rows.length<10) continue;
    const my=100*rows.reduce((a,t)=>a+t.toL,0)/rows.reduce((a,t)=>a+t.possL,0);
    vals.push([tm,(rows.length*my+K*lgRate)/(rows.length+K)]);
  }
  vals.sort((a,b)=>a[1]-b[1]);
  const out={};
  vals.forEach(([tm],i)=>{out[tm]={rank:i+1,of:vals.length,tercile:i<5?'CLEAN':i<10?'MID':'SLOPPY'};});
  return out;
}
const {games,snaps}=JSON.parse(readFileSync('/tmp/ee_cache.json','utf8'));
const g26=games.filter(g=>g.date>='2026-05-01'&&g.winner&&String(g.id).includes('-'));
const tl={};
for(const g of g26)for(const [a,w] of [[g.home_alias,g.winner===g.home_alias],[g.away_alias,g.winner===g.away_alias]])(tl[a]=tl[a]||[]).push({date:g.date,won:w});
for(const a in tl)tl[a].sort((x,y)=>x.date<y.date?-1:1);
const wp=(a,d)=>{const gs=(tl[a]||[]).filter(r=>r.date<d);return gs.length?gs.filter(r=>r.won).length/gs.length:null;};
const cells={CLEAN:{},MID:{},SLOPPY:{}};
for(const g of g26){
  const h=snaps[g.id]; if(!Array.isArray(h))continue;
  const lad=ladderAsOf(g.date); if(!lad)continue;
  const seen=new Set();
  for(const s of h.map(x=>({...x,e:el(x.period,x.clock)})).filter(x=>x.e!=null&&isFinite(x.hp)&&isFinite(x.ap)).sort((a,b)=>a.e-b.e)){
    if(s.period<2||s.period>3)continue;
    const m=Math.abs(s.hp-s.ap); if(m<1||m>9)continue;
    if(!(s.h&&s.a&&s.h.fga>=12&&s.a.fga>=12))continue;
    const ldHome=s.hp>s.ap;
    const ld=ldHome?g.home_alias:g.away_alias, tr=ldHome?g.away_alias:g.home_alias;
    const lw=wp(ld,g.date), tw=wp(tr,g.date);
    if(lw==null||tw==null||(tw-lw)<0.15)continue;
    if((Number((ldHome?s.h:s.a).pot)||0)<6)continue;
    const key=`${ld}|${Math.floor(s.e/300)}`;
    if(seen.has(key))continue; seen.add(key);
    const t=lad[tr]; if(!t)continue;
    const c=cells[t.tercile]; c[g.id]=c[g.id]??(g.winner===tr);
  }
}
for(const [t,g] of Object.entries(cells)){
  const v=Object.values(g);
  console.log(`${t}: ${v.filter(Boolean).length}/${v.length} games = ${v.length?(100*v.filter(Boolean).length/v.length).toFixed(1):'—'}%`);
}
