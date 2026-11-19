// ════════════════════════════════════════════════════════════════════════════
// SS LEAGUE-PARAM FIXTURE INPUTS (NBA_SWEETSPOT_PORT_PHASE1_SPEC §4.1)
// Six hand-built live states shared by the golden PIN script (runs the pre-refactor
// inline block from git blob 3119e2f) and the fixture harness (runs ssComputeShape).
// Shapes mirror production objects exactly: PBP zone object = computeScoringComp input,
// summary.*.statistics = BDL-built box names, odds = fetchOddsAPIBatch map entry.
// ════════════════════════════════════════════════════════════════════════════
const zones = (rim, paint, mid, threes) => ({
  rim: { made: rim[0], att: rim[1] }, paint: { made: paint[0], att: paint[1] },
  mid: { made: mid[0], att: mid[1] }, threes: { made: threes[0], att: threes[1] },
});
const box = (fgm, fga, fg3m) => ({ statistics: { field_goals_made: String(fgm), field_goals_att: String(fga), three_points_made: String(fg3m) } });
const odds = (homeML, awayML) => ({ homeML, awayML, homeMLBook: 'Caesars', awayMLBook: 'FanDuel', homeMLConsensus: homeML, awayMLConsensus: awayML, books: 4 });

export const STANDINGS = {
  // WNBA-style aliases; win% chosen for the cells below
  LEAD_BAD:  { w: 10, l: 18 },  // .357 — beatable leader
  TRAIL_GOOD:{ w: 21, l: 7 },   // .750 — gap .393 STRONG
  TRAIL_MOD: { w: 15, l: 13 },  // .536 — gap .179 (qualifying, < .20 → MODERATE prior)
  LEAD_OK:   { w: 13, l: 15 },  // .464 — leader ≥ .400 → NO_EDGE prior
  THIN:      { w: 2, l: 1 },    // gp 3 → null wp both leagues
  FOUR:      { w: 3, l: 1 },    // gp 4 → wp for WNBA (minGP 4), null for NBA (minGP 5)
};

// Each case: { name, hA, aA, hPts, aPts, period, clock, pbp, summary, odds, standings }
// Home trails in every case except where noted (leader = away).
export const CASES = [
  {
    name: 'A-tier: red-hot variance leader (away) +7 in Q2, STRONG gap, +140 trailer',
    hA: 'TRAIL_GOOD', aA: 'LEAD_BAD', hPts: 48, aPts: 55, period: 2, clock: '5:00',
    // away (leader) 55: paint 5 made (10) · mid 8 (16) · threes 9 (27) · ft 2  → vPct 78
    // home (trailer) 48: paint 12 (24) · mid 4 (8) · threes 3 (9) · ft 7        → structural 31
    pbp: { home: zones([7, 11], [5, 9], [4, 9], [3, 9]), away: zones([3, 5], [2, 4], [8, 12], [9, 13]) },
    summary: { home: box(19, 38, 3), away: box(22, 34, 9) },   // away eFG 77.9 (red Q2) · home 51.3
    odds: odds(140, -165), standings: 'default',
  },
  {
    name: 'B1: orange-band leader, variance lead, STRONG gap',
    hA: 'TRAIL_GOOD', aA: 'LEAD_BAD', hPts: 48, aPts: 55, period: 2, clock: '5:00',
    pbp: { home: zones([7, 11], [5, 9], [4, 9], [3, 9]), away: zones([3, 5], [2, 4], [8, 12], [9, 13]) },
    summary: { home: box(19, 38, 3), away: box(19, 36, 6) },   // away eFG 61.1 (orange Q2)
    odds: odds(130, -150), standings: 'default',
  },
  {
    name: 'GAP_BASE ledger: green leader (no divergence), base gates pass',
    hA: 'TRAIL_GOOD', aA: 'LEAD_BAD', hPts: 48, aPts: 55, period: 3, clock: '8:30',
    pbp: { home: zones([7, 11], [5, 9], [4, 9], [3, 9]), away: zones([9, 14], [4, 7], [5, 11], [4, 12]) },
    summary: { home: box(19, 38, 3), away: box(22, 48, 4) },   // away eFG 50.0 (green Q3)
    odds: odds(150, -175), standings: 'default',
  },
  {
    name: 'No-PBP early-out: zone object missing',
    hA: 'TRAIL_GOOD', aA: 'LEAD_BAD', hPts: 48, aPts: 55, period: 2, clock: '5:00',
    pbp: null, summary: { home: box(19, 38, 3), away: box(22, 34, 9) },
    odds: odds(140, -165), standings: 'default',
  },
  {
    name: 'GP thin: trailer 3-1 (gp 4) — WNBA wp present, NBA wp null',
    hA: 'FOUR', aA: 'LEAD_BAD', hPts: 48, aPts: 55, period: 2, clock: '5:00',
    pbp: { home: zones([7, 11], [5, 9], [4, 9], [3, 9]), away: zones([3, 5], [2, 4], [8, 12], [9, 13]) },
    summary: { home: box(19, 38, 3), away: box(22, 34, 9) },
    odds: odds(140, -165), standings: 'default',
  },
  {
    name: 'Leader ≥ .400 (.464): WNBA prior NO_EDGE, no tier; home leads (trailer = away), no line',
    hA: 'LEAD_OK', aA: 'TRAIL_MOD', hPts: 61, aPts: 55, period: 3, clock: '2:10',
    // home (leader) 61: variance-heavy; away trails by 6
    pbp: { home: zones([4, 7], [2, 4], [8, 13], [9, 15]), away: zones([8, 12], [5, 9], [4, 10], [3, 9]) },
    summary: { home: box(23, 40, 9), away: box(20, 41, 3) },  // home eFG 68.8 (red Q3)
    odds: null, standings: 'default',
  },
];

// Legacy inline block consumed `ind.homePts/awayPts`, `game._bdlPbp`, `summary`, `odds`, `ssStandings`.
export function toLegacyArgs(c) {
  return {
    game: { _bdlPbp: c.pbp }, hA: c.hA, aA: c.aA,
    ind: { homePts: c.hPts, awayPts: c.aPts }, summary: c.summary,
    currentPeriod: c.period, clock: c.clock, odds: c.odds, ssStandings: STANDINGS,
  };
}
