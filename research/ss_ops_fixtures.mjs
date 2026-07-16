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

// ── ssComposeDigest (approved plain-English copy 2026-07-12) ──
const digestSrc = extract('ssComposeDigest');
const ssComposeDigest = new Function(`${digestSrc}; return ssComposeDigest;`)();
const laneSrc = extract('ssOverrideLaneLine');
const ssOverrideLaneLine = new Function(`${laneSrc}; return ssOverrideLaneLine;`)();
const T0 = { tiers: { A: { w: 1, l: 0 }, B: { w: 0, l: 0 } }, watchlist: { total: 1, converted: 0 }, resolvedTonight: 4 };
const S0 = { A: { w: 2, l: 0 }, B: { w: 0, l: 0 }, watchlist: { total: 3, converted: 2 }, ledger: { GAP_BASE: { n_resolved: 2, realized_pct: 100, predicted_pct: 73 } } };
let dg = ssComposeDigest('2026-07-12', T0, S0);
T('title plain-dated', dg.title === 'Sweet Spot nightly report (July 12)');
T('tier line + no-B clause', dg.body.includes('Tier A went 1-0 tonight; no Tier B alerts.'));
T('season line', dg.body.includes('Season so far: Tier A 2-0, Tier B 0-0.'));
T('single flag, neutral non-convert wording', dg.body.includes('1 game was flagged for a look tonight — the trailing team did not come back.'));
T('since-launch conversion', dg.body.includes('Since launch, 2 of 3 flagged teams have completed the comeback.'));
T('ledger counts, no early percentages', dg.body.includes('gap-only spots: 2 of 30 collected') && !dg.body.includes('73%'));
T('noise caveat pre-30', dg.body.includes('No conclusions until 30; early percentages are noise.'));
T('absent bucket shows 0 of 30', dg.body.includes('Deep fourth-quarter comebacks: 0 of 30 collected'));
T('housekeeping plural', dg.body.includes('4 finished games were scored and filed tonight.'));
T('no abbreviations anywhere', !/GAP_BASE|Q4C|WATCH |SS /.test(dg.body));
dg = ssComposeDigest('2026-07-12', { tiers: { A: { w: 0, l: 0 }, B: { w: 0, l: 0 } }, watchlist: { total: 0, converted: 0 }, resolvedTonight: 0 }, { A: { w: 0, l: 0 }, B: { w: 0, l: 0 }, watchlist: { total: 0, converted: 0 }, ledger: {} });
T('nothing to report returns null', dg === null);
dg = ssComposeDigest('2026-07-12', { tiers: { A: { w: 0, l: 0 }, B: { w: 0, l: 0 } }, watchlist: { total: 2, converted: 1 }, resolvedTonight: 1 }, S0);
T('multi-flag wording', dg.body.includes('2 games were flagged for a look tonight — 1 of 2 trailing teams completed the comeback.'));
T('housekeeping singular', dg.body.includes('1 finished game was scored and filed tonight.'));
dg = ssComposeDigest('2026-07-12', T0, { ...S0, ledger: { GAP_BASE: { n_resolved: 31, realized_pct: 42, predicted_pct: 40 } } });
T('post-30 shows realized vs predicted', dg.body.includes('gap-only spots: 31 collected — comebacks happened 42% of the time vs 40% predicted'));


// ── ssOverrideLaneLine (OVERRIDE_LANE_SPEC §2, built Jul 16) ──
{
  const mk = (t, tw, tl, rw, rl, ageH) => ({ team_alias: t, updated_at: new Date(Date.now() - (ageH || 1) * 3600 * 1000).toISOString(),
    profile: { tiers: { top: { w: tw, l: tl }, rest: { w: rw, l: rl } } } });
  const fresh = [mk('MIN', 5, 1, 14, 5), mk('LV', 5, 2, 12, 6), mk('GS', 1, 5, 16, 1), mk('DAL', 2, 5, 14, 3)];
  const line = ssOverrideLaneLine(fresh);
  T('lane: MIN + LV both named (infl<0, wp>=.600, nTop>=5)', !!line && line.includes('MIN (5-1') && line.includes('LV (5-2'));
  T('lane: cap $600 wording pinned', !!line && line.includes('cap $600'));
  T('lane: inflated GS/DAL excluded', !!line && !line.includes('GS (') && !line.includes('DAL ('));
  const empty = ssOverrideLaneLine([mk('GS', 1, 5, 16, 1)]);
  T('lane: empty copy pinned', !!empty && empty.indexOf('Override lane: empty') === 0);
  T('lane: stale >48h -> null (digest omits, never guesses)', ssOverrideLaneLine([mk('MIN', 5, 1, 14, 5, 60)]) === null);
  T('lane: nTop<5 n-guard excludes', (ssOverrideLaneLine([mk('MIN', 3, 0, 14, 5)]) || '').includes('empty'));
  const dgL = ssComposeDigest('2026-07-16',
    { tiers: { A: { w: 0, l: 0 }, B: { w: 0, l: 0 } }, watchlist: { total: 0, converted: 0 }, resolvedTonight: 1 },
    { A: { w: 1, l: 0 }, B: { w: 0, l: 0 }, watchlist: { total: 8, converted: 5 }, ledger: {} }, line);
  T('digest: lane section included when line passed', !!dgL && dgL.body.includes('Override lane'));
  const dgN = ssComposeDigest('2026-07-16',
    { tiers: { A: { w: 0, l: 0 }, B: { w: 0, l: 0 } }, watchlist: { total: 0, converted: 0 }, resolvedTonight: 1 },
    { A: { w: 1, l: 0 }, B: { w: 0, l: 0 }, watchlist: { total: 8, converted: 5 }, ledger: {} }, null);
  T('digest: null lane -> section absent (3-arg compat preserved)', !!dgN && !dgN.body.includes('Override lane'));
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
