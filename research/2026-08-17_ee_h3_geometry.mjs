// H3 SUBSTITUTED INSTRUMENT (disclosed): committed arena is deduped per
// game x leader x time-bucket, so contiguous episodes are structurally absent.
// Using the un-deduped 2026 production snapshot tape (~26s median grain) —
// arguably more transfer-correct for a fire-latency design question, but NOT
// the instrument the prereg named. Descriptive only, no bar, no promotion.
import { readFileSync } from 'fs';
const QSEC=600;
const clkSec=(c)=>{if(c==null)return null;c=String(c);if(c.includes(':')){const p=c.split(':');return (+p[0])*60+(+p[1]||0);}const n=parseFloat(c);return isNaN(n)?null:n;};
const el=(p,c)=>{const cs=clkSec(c);if(cs==null||!p)return null;return (p-1)*QSEC+(QSEC-cs);};
const {games,snaps}=JSON.parse(readFileSync('/tmp/ee_cache.json','utf8'));
const g26=games.filter(g=>g.date>='2026-05-01'&&g.winner&&String(g.id).includes('-'));
const tl={};
for(const g of g26) for(const [a,w] of [[g.home_alias,g.winner===g.home_alias],[g.away_alias,g.winner===g.away_alias]]) (tl[a]=tl[a]||[]).push({date:g.date,won:w});
for(const a in tl) tl[a].sort((x,y)=>x.date<y.date?-1:1);
const asOf=(a,d)=>{const gs=(tl[a]||[]).filter(r=>r.date<d);return{gp:gs.length,wp:gs.length?gs.filter(r=>r.won).length/gs.length:null};};

function geo(pred,label){
  const eps=[];
  for(const g of g26){
    const h=snaps[g.id]; if(!Array.isArray(h))continue;
    const rows=h.map(s=>({...s,e:el(s.period,s.clock)})).filter(s=>s.e!=null&&isFinite(s.hp)&&isFinite(s.ap)).sort((a,b)=>a.e-b.e);
    let cur=null;
    for(const s of rows){
      const m=Math.abs(s.hp-s.ap);
      const ldHome=s.hp>s.ap;
      const ld=ldHome?g.home_alias:g.away_alias, tr=ldHome?g.away_alias:g.home_alias;
      const rl=asOf(ld,g.date), rt=asOf(tr,g.date);
      const inb = m>=1&&m<=9 && rl.wp!=null&&rt.wp!=null && pred(rl,rt,g);
      if(inb){
        if(cur&&cur.tr===tr&&(s.e-cur.last)<=90){cur.last=s.e;cur.depth=Math.max(cur.depth,m);cur.n++;}
        else{if(cur)eps.push(cur);cur={tr,start:s.e,last:s.e,depth:m,n:1,won:g.winner===tr};}
      } else if(cur){eps.push(cur);cur=null;}
    }
    if(cur)eps.push(cur);
  }
  const d=eps.map(e=>e.last-e.start).sort((a,b)=>a-b);
  const med=(A)=>A.length%2?A[(A.length-1)/2]:(A[A.length/2-1]+A[A.length/2])/2;
  const dep=eps.map(e=>e.depth).sort((a,b)=>a-b);
  console.log(`\n${label}`);
  console.log(`  episodes ${eps.length} | median duration ${med(d)}s | mean ${(d.reduce((a,b)=>a+b,0)/d.length).toFixed(0)}s | p75 ${d[Math.floor(d.length*0.75)]}s | max ${d[d.length-1]}s`);
  console.log(`  share <=60s ${(100*d.filter(x=>x<=60).length/d.length).toFixed(1)}% | <=90s ${(100*d.filter(x=>x<=90).length/d.length).toFixed(1)}% | <=120s ${(100*d.filter(x=>x<=120).length/d.length).toFixed(1)}%`);
  console.log(`  max depth: median ${med(dep)} | single-snapshot episodes ${(100*eps.filter(e=>e.n===1).length/eps.length).toFixed(1)}%`);
  console.log(`  episode-level trailer win ${(100*eps.filter(e=>e.won).length/eps.length).toFixed(1)}%`);
}
console.log('=== H3 EPISODE GEOMETRY — 2026 production tape (SUBSTITUTED INSTRUMENT) ===');
geo((rl,rt)=>rl.wp>=0.55&&rt.wp>=0.55&&rl.gp>=12&&rt.gp>=12,'ELITE-ELITE (both >=.550, >=12 GP)');
geo((rl,rt)=>rl.wp<0.40&&(rt.wp-rl.wp)>=0.15,'FADE COUNTRY (leader <.400, gap >=.15)');
