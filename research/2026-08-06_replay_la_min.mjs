// REPLAY — LA@MIN Aug 6 alerts re-rendered through the ACA stack (repo-extracted fns, real data)
import { readFileSync } from 'fs';
import { composeSqueeze } from '../netlify/functions/odds-squeeze.mjs';
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`); if (i < 0) throw new Error(name);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
function extractVar(src, name) {
  const i = src.indexOf(`var ${name}`); return src.slice(i, src.indexOf(';', i) + 1);
}
const S = new Function(`${[extractVar(POLL,'EFG_BANDS'), extractFn(POLL,'efgTier'), extractVar(POLL,'FUELTEMP_TH'),
  extractFn(POLL,'computeFuelTemp'), extractFn(POLL,'ssCautionLines'), extractFn(POLL,'ssFuelTempLines'),
  extractFn(POLL,'ssComposePush')].join(';\n')};
  var TEAM_CTX_ON = true; var _teamCtxMap = null;
  ${extractFn(POLL,'composeTeamCtxLine')};
  return { computeFuelTemp, ssCautionLines, ssFuelTempLines, ssComposePush, composeTeamCtxLine };`)();

const auth = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const api = async (qs) => (await fetch(`https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?${qs}`, { headers: { Authorization: auth } })).json();

const run = async () => {
  // real fire-time fuelTemp from the row-1197 stamp
  const ft = { pot: 4, fuel: 'EARNED', heat: false, temp: 'cold', period: 2, sticky: true, vShare: 20,
    takeaway: false, leaderEfg: 55.3, trailerTo: 3, leaderBand: 'green', threeShare: 12,
    trailerEfg: 38.6, trailerBand: 'green', insufficient: false };
  // team ctx map from live profiles
  const map = {};
  for (const t of ['MIN', 'LA']) {
    const d = await api(`action=get_team_profiles&league=wnba&season=2026&team=${t}`);
    const p = (d.team_profiles || d.profiles || [])[0];
    if (p) map[t] = { archetype: p.archetype, profile: typeof p.profile_json === 'string' ? JSON.parse(p.profile_json) : (p.profile_json || p.profile || {}) };
  }
  // lane check for MIN from def-A tiers
  const mt = map.MIN?.profile?.tiers;
  let lane = null;
  if (mt?.top && mt?.rest) {
    const tn = (mt.top.w||0)+(mt.top.l||0), rn = (mt.rest.w||0)+(mt.rest.l||0);
    if (tn >= 5 && rn > 0) {
      const wp = ((mt.top.w||0)+(mt.rest.w||0))/(tn+rn);
      const infl = ((mt.rest.w||0)/rn) - ((mt.top.w||0)/tn);
      lane = wp >= 0.600 && infl < 0;
    }
  }
  console.log(`[lane check: MIN trailer_lane=${lane}]`);

  // ═══ 1. MECHANICAL REVIEW PUSH (Stage 1b as shipped: compose → ctx line → T+0 FACT block) ═══
  const ss = { subtype: 'WATCHLIST', trailerAl: 'MIN', leaderAl: 'LA', margin: 1, period: 2, clock: '8:38',
    trailerWP: 0.8064516, leaderWP: 0.37931034, leaderEfg: 55.263157, leaderBand: 'green',
    fuelTemp: ft, leadClass: 'EVEN' };
  const push = S.ssComposePush(ss);
  let body = push.body;
  const tc = S.composeTeamCtxLine('MIN', 'LA', 'wnba', map);
  if (tc) body = body + '\n\n' + tc;
  const fb = S.ssFuelTempLines(ss.fuelTemp, ss.leaderAl, ss.trailerAl, { lead_class: ss.leadClass });
  if (fb) body = body + '\n\n' + fb;
  console.log('════ 1. MECHANICAL REVIEW (T+0, priority 2) ════');
  console.log('TITLE: ' + push.title);
  console.log(body);

  // caution block for the narration append
  console.log('\n[caution block for alert 2 append]:');
  console.log(S.ssCautionLines(ft, { lead_class: 'EVEN' }));

  // ═══ 3. JUICE at Q4 2:22 (real fired price -115, F5 gate live, lane capLine) ═══
  const trailerEfg = Math.round((31 + 0.5 * 9) / 67 * 100); // MIN raw at the 2:28 snapshot
  const capLine = lane ? '$300 cap - LANE team: $600 if declared before entry. Staged adds = one position vs cap.'
    : '$300 cap (WATCHLIST). Staged adds = one position vs cap.';
  const j = composeSqueeze({
    trailer: 'MIN', leader: 'LA', price: -115, book: 'williamhill_us', threshold: -150,
    cellRate: 67, cellName: 'killer cell', deficit: 1, period: 4, clock: '2:22',
    leaderEfg: 56, leaderBand: 'green', leaderVar: 40, trailerEfg, trailerTemp: trailerEfg < 45 ? 'cold' : trailerEfg <= 55 ? 'warm' : 'hot',
    asOf: 'read as of Q4 2:28', capLine, shopLine: 'Caesars -115', stale: false, posLine: null,
  });
  console.log('\n════ 3. JUICE (Q4 2:22, priority 5) ════');
  console.log('TITLE: ' + j.title);
  console.log(j.body);
};
run();
