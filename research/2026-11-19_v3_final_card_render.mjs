// Render the shipped v3 FINAL-card text for tonight's NBA games from live get_ss_state + the v3 pure core
import fs from 'fs';
const src=fs.readFileSync('/home/claude/dft/v3.html','utf8');
const a=src.indexOf('// SS_NBA_CORE_BEGIN'), b=src.indexOf('// SS_NBA_CORE_END');
const core=src.slice(a,b);
const B='https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?action=';
const H={Authorization:'Basic '+Buffer.from('manny:DFT2025!').toString('base64')};
const get=async u=>(await fetch(u,{headers:H})).json();
const sandbox={FN:'',dbReady:false,cardState:{},fetch:async()=>({ok:false}),console,Number,Math,String,Date,isNaN,parseFloat,parseInt,JSON,Object,Array,encodeURIComponent,setTimeout};
const fn=new Function(...Object.keys(sandbox),core+'\nreturn {ssVerdictComposeNba,ssGateLineNba,ssCueReadNba,ssPriceLineNba,ssNbaFireLine,ssNbaChipFor,ssForwardLedgerPanelNba,ssGapFmt};');
const P=fn(...Object.values(sandbox));
const games=(await get(B+'get_games&league=nba')).games.filter(g=>String(g.date).slice(0,10)==='2026-11-19');
const ledgerRaw=await get(B+'ss_ledger_summary&league=nba'); const ledger={}; (ledgerRaw.ledger||[]).forEach(r=>ledger[r.alert_subtype]=r);
const stand=(await get(B+'get_standings&league=nba')).standings||{};
const wp=r=>r&&(r.w+r.l)>=5?r.w/(r.w+r.l):null;
for(const g of games){
  const d=await get(B+`get_ss_state&game_id=${g.id}&league=nba`);
  const sn=d.snapshot,gm=d.game||{};
  const hp=+sn.home_pts||0,ap=+sn.away_pts||0,tied=hp===ap;
  const hA=gm.home_alias,aA=gm.away_alias;
  const ld=tied?null:(sn.ss_leader_alias||(hp>ap?hA:aA)), tr=tied?null:(ld===hA?aA:hA);
  const v=P.ssVerdictComposeNba({period:sn.period,homePts:hp,awayPts:ap,homeAlias:hA,awayAlias:aA,leaderAlias:sn.ss_leader_alias,gap:sn.ss_quality_gap,leaderEfg:sn.ss_leader_efg,leadClass:sn.ss_lead_class,lineUsed:sn.ss_line_used,rows:d.rows,subtypes:d.subtypes,gapBaseN:+((ledger.GAP_BASE||{}).n_resolved)||0,gameStatus:gm.status,finalHome:gm.home_pts,finalAway:gm.away_pts,winner:gm.winner});
  const chip=P.ssNbaChipFor(v);
  // ESPN at final = winner 100 / loser 0 (espn-data current.homeWinPct) — emulate the card's cs.espnWP
  const espnHome=gm.winner===hA?100:0; const espnTr=tr?(tr===hA?espnHome:100-espnHome):null;
  console.log(`\n=== ${aA}@${hA}  FINAL ${gm.home_pts}-${gm.away_pts} (home-away) winner ${gm.winner} · last snapshot Q${sn.period} ${sn.clock} ${hp}-${ap}`);
  console.log(`chip: SS ${chip?chip.label:'—'}`);
  console.log('gate:  '+P.ssGateLineNba({tied,gap:sn.ss_quality_gap,leaderAlias:ld,trailerAlias:tr,leaderWp:sn.ss_leader_wp,trailerWp:sn.ss_trailer_wp,homeAlias:hA,awayAlias:aA,homeWp:wp(stand[hA]),awayWp:wp(stand[aA]),margin:Math.abs(hp-ap),leadClass:sn.ss_lead_class}));
  const cr=P.ssCueReadNba({tied,gap:sn.ss_quality_gap,deficit:Math.abs(hp-ap),period:sn.period,leaderEfg:sn.ss_leader_efg},ledger); if(cr)console.log('cue:   '+cr);
  const pl=tied?null:P.ssPriceLineNba({trailerAlias:tr,serverML:sn.ss_line_used,cardML:null,espnTrailerWp:espnTr}); if(pl)console.log('price: '+pl);
  console.log('ledger:\n  '+P.ssForwardLedgerPanelNba(ledger).join('\n  '));
  const fl=P.ssNbaFireLine(d.fire_review); console.log('fire:  '+(fl||'(no row)'));
  console.log(`verdict [${v.v}]: ${v.text}`+(v.trap?'\n  trap: '+v.trap:''));
  console.log(`as-of: server read as of Q${sn.period} ${sn.clock}`);
}
