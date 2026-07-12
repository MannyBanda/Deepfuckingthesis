// SS OPS fixtures (SWEETSPOT_OPS_SPEC.md §7) — pure-logic layer. Live paths (resolver
// writes, digest, watchdog) are validated via dry-run + rerun against known finals.
import { readFileSync } from 'fs';
const SRC = readFileSync('netlify/functions/post-game-agent.mjs', 'utf8');
function extract(name, kind = 'function') {
  const sig = kind === 'const' ? `const ${name} = ` : `function ${name}(`;
  const i = SRC.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  if (kind === 'const') return SRC.slice(i, SRC.indexOf(';', i) + 1);
  const open = SRC.indexOf('{', SRC.indexOf(')', i));
  let d = 0, j = open;
  for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) { j++; break; } } }
  return SRC.slice(i, j);
}
const ctx = extract('WNBA_SR2BDL', 'const') + ';' + extract('nextDay') + ';' + extract('resolveOutcome');
const { resolveOutcome, nextDay } = new Function(`${ctx}; return { resolveOutcome, nextDay };`)();

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}`); };

const games = [{ home: 'TOR', away: 'DAL', homeScore: 95, awayScore: 108, status: 'Final' }];
let o = resolveOutcome('DAL', games);
T('away winner: ctrlWon true, margin +13', o.ctrlWon === true && o.finalMargin === 13);
o = resolveOutcome('TOR', games);
T('home loser: ctrlWon false, margin -13', o.ctrlWon === false && o.finalMargin === -13);
T('non-final games return null', resolveOutcome('DAL', [{ ...games[0], status: 'post' }]) === null);
T('unknown team returns null', resolveOutcome('SEA', games) === null);
const legacy = [{ home: 'NY', away: 'LV', homeScore: 80, awayScore: 74, status: 'Final' }];
o = resolveOutcome('NYL', legacy);
T('legacy SR alias NYL matches BDL NY (home)', o && o.ctrlWon === true);
o = resolveOutcome('LVA', legacy);
T('legacy SR alias LVA matches BDL LV (away)', o && o.ctrlWon === false && o.finalMargin === -6);
T('nextDay handles month boundary', nextDay('2026-07-31') === '2026-08-01');
T('nextDay plain increment', nextDay('2026-07-10') === '2026-07-11');
// trailer-won mapping mirror (resolver core): trailer home vs away
const trailerWon = (trailerIsHome, fin) => (trailerIsHome ? fin.homeScore : fin.awayScore) > (trailerIsHome ? fin.awayScore : fin.homeScore);
T('trailer away wins', trailerWon(false, { homeScore: 95, awayScore: 108 }) === true);
T('trailer home loses', trailerWon(true, { homeScore: 63, awayScore: 79 }) === false);
// graduation crossing mirror: fires only on the crossing sweep
const crossed = (before, after) => (before || 0) < 30 && after >= 30;
T('29→31 crosses', crossed(29, 31) === true);
T('30→31 does not re-fire', crossed(30, 31) === false);
T('rerun (35→35) does not re-fire', crossed(35, 35) === false);
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
