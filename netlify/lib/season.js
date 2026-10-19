// ══════════════════════════════════════════════════════════════════════════════
// netlify/lib/season.js — SEASON_CONSOLIDATION_SPEC v1 §1
// Single source of truth for season identity across every function and client
// proxy. Pure, dependency-free, CommonJS so both .js (CJS) and .mjs (ESM via
// esbuild default-import interop) functions can consume it. Lives OUTSIDE
// netlify/functions so Netlify can never discover it as a function; esbuild
// bundles it into each importer at build time.
//
// NEVER hardcode a season literal in a function or client again — the lint in
// research/season_fixtures.mjs fails on any '20xx' / '20xx-yy' season literal.
//
// Three classes of season-scoped data (spec §2):
//   BASELINES  — performance priors: warm-start from the PRIOR season when the
//                team has < WARM_START_GP games this season (pickBaselineSeason)
//   RECORDS    — standings, rosters, depth charts, injuries: CURRENT only
//   ARTIFACTS  — DB tables computed per season (floor_wp, wp_profiles, clutch):
//                newest row <= current wins (seasonCandidates)
// ══════════════════════════════════════════════════════════════════════════════

// Split-year leagues roll on Aug 1 (June Finals still belong to the prior
// start-year; preseason in early Oct already belongs to the new one).
// WNBA is calendar-year but its offseason (Nov-Mar) still belongs to the
// season that just ended, so it rolls on Apr 1.
const ROLLOVER_MONTH = { nba: 8, ncaamb: 8, wnba: 4 };
const SPLIT_YEAR = { nba: true, ncaamb: true, wnba: false };
const WARM_START_GP = 10;

// 'YYYY' start-year, the format SR (seasons/YYYY/REG/...) and BDL
// (season=YYYY, seasons[]=YYYY) both use. Emergency override via env
// DFT_SEASON_<LEAGUE> (e.g. DFT_SEASON_NBA=2026) — operational lever only.
function seasonFor(league, date) {
  const lg = String(league || 'nba').toLowerCase();
  const ov = typeof process !== 'undefined' && process.env && process.env['DFT_SEASON_' + lg.toUpperCase()];
  if (ov) return String(ov).trim();
  const d = date ? new Date(date) : new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const roll = ROLLOVER_MONTH[lg] || 8;
  return String(m >= roll ? y : y - 1);
}

function priorSeason(league, season) {
  return String(Number(season || seasonFor(league)) - 1);
}

// DB label format: 'YYYY-YY' for split-year leagues (floor_wp_coefficients,
// wp_profiles), 'YYYY' for WNBA. Pass a start-year season or omit for current.
function seasonLabel(league, season) {
  const lg = String(league || 'nba').toLowerCase();
  const s = Number(season || seasonFor(lg));
  return SPLIT_YEAR[lg] ? s + '-' + String((s + 1) % 100).padStart(2, '0') : String(s);
}

// BASELINES only. Returns which season a performance baseline should come from
// for a team with `currentGP` games played this season. Every consumer stamps
// the returned { season, source } so prior-season priors are never passed off
// as current (spec §2: labeled prior, never silent).
function pickBaselineSeason(league, currentGP, season) {
  const cur = season || seasonFor(league);
  const gp = Number(currentGP) || 0;
  return gp >= WARM_START_GP
    ? { season: cur, source: 'current', gp: gp }
    : { season: priorSeason(league, cur), source: 'prior', gp: gp };
}

// ARTIFACTS: [current, prior] in the table's own label format — consumers read
// both and keep the newest row per team ("newest <= current wins").
function seasonCandidates(league, labelFn) {
  const fn = labelFn || function (lg, s) { return String(s); };
  const cur = seasonFor(league);
  return [fn(league, cur), fn(league, priorSeason(league, cur))];
}

// Reduce rows carrying a `season` label to one row per key, keeping the row
// whose season appears EARLIEST in `candidates` (i.e. newest). Pure.
function newestPerKey(rows, candidates, keyField) {
  const rank = {}; (candidates || []).forEach(function (s, i) { rank[String(s)] = i; });
  const out = {};
  for (const r of rows || []) {
    const k = r[keyField || 'team_alias']; if (k == null) continue;
    const rk = rank[String(r.season)]; if (rk == null) continue;
    if (!out[k] || rk < out[k]._rank) out[k] = Object.assign({}, r, { _rank: rk });
  }
  for (const k of Object.keys(out)) delete out[k]._rank;
  return out;
}

// SR team statistics → games played this season (0 when absent/empty).
// Live shape (verified Oct 2026): { season, own_record:{total,average}, opponents, players }.
// Also accepts the proxy's NCAAMB-normalized { team_records:[{own_record}] } and a bare total.
function gpFromSRStats(stats) {
  if (!stats || typeof stats !== 'object') return 0;
  const own = stats.own_record
    || (Array.isArray(stats.team_records) && stats.team_records[0] && stats.team_records[0].own_record)
    || stats;
  const tot = (own && own.total) || {};
  return Number(tot.games_played) || 0;
}

// SR team splits → games played this season. Shape: { splits:[{ category,
// own_record:{total:{games_played}} }] }. home+away categories sum to the season;
// falls back to the largest single split when those categories are absent.
function gpFromSRSplits(resp) {
  const sp = (resp && (resp.splits || (resp.team && resp.team.splits))) || [];
  let ha = 0, haSeen = false, mx = 0;
  for (const s of Array.isArray(sp) ? sp : []) {
    const g = Number(s && s.own_record && s.own_record.total && s.own_record.total.games_played) || 0;
    if (/^(home|away)$/i.test(String(s && s.category))) { ha += g; haSeen = true; }
    if (g > mx) mx = g;
  }
  return haSeen ? ha : mx;
}

// The three SR per-team BASELINE paths (statistics + two splits). Depth charts
// and profiles are RECORDS — never routed through here.
function srBaselinePaths(teamId, season) {
  const base = 'seasons/' + season + '/REG/teams/' + teamId + '/';
  return { stats: base + 'statistics.json', splitsGame: base + 'splits/game.json', splitsSchedule: base + 'splits/schedule.json' };
}

// One pinned plain-English line for any prompt that received a prior-season
// baseline (ACA principle: the model narrates AROUND pinned facts).
function baselineLine(league, picks) {
  const prior = (picks || []).filter(function (p) { return p && p.pick && p.pick.source === 'prior'; });
  if (!prior.length) return '';
  const lbl = seasonLabel(league, prior[0].pick.season);
  const who = prior.map(function (p) { return p.alias + ' ' + p.pick.gp + ' GP'; }).join(', ');
  return 'BASELINE SEASON: ' + lbl + ' (prior season) for ' + who + ' this season — below the ' + WARM_START_GP + '-GP warm-start bar. Treat these team baselines as last-season priors, not current form.';
}

module.exports = {
  ROLLOVER_MONTH, SPLIT_YEAR, WARM_START_GP,
  seasonFor, priorSeason, seasonLabel, pickBaselineSeason, seasonCandidates,
  newestPerKey, gpFromSRStats, gpFromSRSplits, srBaselinePaths, baselineLine,
};
