const KEY='ee78e074-2f89-4ee5-807a-181fc324398c';
async function plays(gid){ let out=[], cursor=null; for(let i=0;i<12;i++){ const r=await fetch(`https://api.balldontlie.io/nba/v1/plays?game_id=${gid}&per_page=500${cursor?'&cursor='+cursor:''}`,{headers:{Authorization:KEY}}); const j=await r.json(); out.push(...(j.data||[])); cursor=j.meta?.next_cursor; if(!cursor) break; } return out; }
const old=await import('./w_c0d33b8.mjs'); const neu=await import('./w_HEAD.mjs');
for (const [gid,hA,aA] of [[18446820,null,null]]) {
  const p=await plays(gid);
  // aliases from plays
  const teams=[...new Set(p.map(x=>x.team?.abbreviation).filter(Boolean))];
  console.log('game',gid,'plays',p.length,'teams',teams, 'home_score sample', p.find(x=>x.home_score!=null)?.home_score);
  // determine home via a scoring play: home_score increases when home scores
  let home=null; for (let i=1;i<p.length;i++){ const a=p[i-1],b=p[i]; if(b.scoring_play && b.home_score>a.home_score && b.team?.abbreviation){home=b.team.abbreviation;break;} }
  const away=teams.find(t=>t!==home);
  console.log('home',home,'away',away);
  const so=old.walkAndSnapshot(p,home,away), sn=neu.walkAndSnapshot(p,home,away);
  let same=0; for (let i=0;i<so.length;i++){ const a=so[i],b=sn[i]; const eq=JSON.stringify(a.team_stats)===JSON.stringify(b.team_stats)&&JSON.stringify(a.pbp_derived)===JSON.stringify(b.pbp_derived); if(eq) same++; else console.log('DIFF at',a.checkpoint, a.pbp_derived.hPOT,a.pbp_derived.aPOT,'vs',b.pbp_derived.hPOT,b.pbp_derived.aPOT); }
  console.log(`old vs new walker on today's plays: ${same}/${so.length} identical`);
  console.log('today POT at Q1_6 (old walker):', so[0].pbp_derived.hPOT, so[0].pbp_derived.aPOT, ' stored row had aPOT=7, walker-now aPOT=6');
  // order ties?
  const orders=p.map(x=>x.order); const dup=orders.length-new Set(orders).size; console.log('duplicate order values:',dup);
}
