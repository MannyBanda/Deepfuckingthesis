// NBA Playoffs Backtest — Indicator Validation Against 2024 + 2025 Postseasons
// BDL-only (60 calls/s). Uses the exact same methodology as the 171-game
// regular season validation (combo-sim-console.js).
//
// Phases:
//   ?phase=init       — Create nba_playoffs_backtest table
//   ?phase=collect    — BDL: pull all postseason games for seasons[]=2023,2024
//   ?phase=boxscores  — BDL: pull box_scores by date (team stat aggregation)
//   ?phase=pbp&n=50   — BDL: pull plays for games missing it (chunked, resumable)
//   ?phase=compute    — Run computeServer + computeConviction on cached data
//   ?phase=report     — Return stratified accuracy report (vs regular season baseline)
//   ?phase=status     — Progress (rows, missing pbp, computed)
//   ?phase=reset      — Clear computed columns (keep BDL data)
//
// BDL season convention (confirmed):
//   season=2023 = 2023-24 regular season → 2024 playoffs (calendar year)
//   season=2024 = 2024-25 regular season → 2025 playoffs (calendar year)

import { neon } from '@neondatabase/serverless';

const BDL_BASE = 'https://api.balldontlie.io';
const BDL_KEY = process.env.BDL_API_KEY;

// ── NBA INDICATOR WEIGHTS (current production) ───────────────────────────────
// Matches poll-live-bdl.mjs:51 and combo-sim-console.js:6
const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

// Seasons to pull: BDL convention is starting year
// 2023 = 2023-24 season → 2024 playoffs
// 2024 = 2024-25 season → 2025 playoffs
const SEASONS = [2023, 2024];

// Rough date windows for round inference (NBA calendar is fairly stable)
// R1 starts third Saturday of April, Finals end mid-to-late June
function inferRound(dateStr, playoffYear) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const month = d.getUTCMonth() + 1; // 1-12
  const day = d.getUTCDate();

  // April dates = R1 start through early May = R1
  if (month === 4) return 'R1';
  // Early May = late R1 + CSF start
  if (month === 5 && day <= 6) return 'R1';
  if (month === 5 && day <= 19) return 'CSF';
  // Late May = CF
  if (month === 5 && day >= 20) return 'CF';
  if (month === 6 && day <= 4) return 'CF';
  // June = Finals
  if (month === 6) return 'FIN';
  return 'UNK';
}

// ── BDL FETCH ────────────────────────────────────────────────────────────────
async function bdlFetch(path) {
  if (!BDL_KEY) { console.log('BDL_KEY missing'); return null; }
  const resp = await fetch(`${BDL_BASE}${path}`, { headers: { Authorization: BDL_KEY } });
  if (!resp.ok) { console.log(`BDL ${resp.status}: ${path}`); return null; }
  return resp.json();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── computeServer — NBA indicators, ported from combo-sim-console.js ─────────
// Signature matches that script exactly. Inputs are the aggregated team stats
// (h, a — summed from box score players) and PBP-derived fields. Do NOT change
// thresholds or weights — we need apples-to-apples comparison with the 171-game
// regular season baseline (93.4% composite).
function computeServer({ h, a, hA, aA, hPaint, aPaint, hRimM, hRimA, aRimM, aRimA,
                          hBigLead, aBigLead, hPOT, aPOT, runs6, q4hPts, q4aPts }) {
  // Guard: both teams scored something
  if ((h.pts || 0) === 0 && (a.pts || 0) === 0) return null;

  // I1 — Disruption (stl+blk ±1) + POT (±4)
  const hDisrupt = (h.stl || 0) + (h.blk || 0);
  const aDisrupt = (a.stl || 0) + (a.blk || 0);
  const i1subA = (hDisrupt - aDisrupt) > 1 ? 1 : (hDisrupt - aDisrupt) < -1 ? -1 : 0;
  const i1subB = (hPOT - aPOT) > 4 ? 1 : (aPOT - hPOT) > 4 ? -1 : 0;
  const I1 = (i1subA + i1subB) > 0 ? 1 : (i1subA + i1subB) === 0 ? 0.5 : 0;

  // I2 — Interior (paint ±6, rim FG% ±10%)
  const paintDiff = hPaint - aPaint;
  const i2subA = paintDiff > 6 ? 1 : paintDiff < -6 ? -1 : 0;
  const hRimPct = hRimA >= 6 ? hRimM / hRimA : null;
  const aRimPct = aRimA >= 6 ? aRimM / aRimA : null;
  let i2subB = 0;
  if (hRimPct != null && aRimPct != null) {
    if (hRimPct - aRimPct > 0.10) i2subB = 1;
    else if (aRimPct - hRimPct > 0.10) i2subB = -1;
  }
  const I2 = (i2subA + i2subB) > 0 ? 1 : (i2subA + i2subB) < 0 ? 0 : 0.5;

  // I3 — Shot Quality (eFG% ±2%, assist ratio ±5%)
  const hEFG = ((h.fgm || 0) + 0.5 * (h.fg3m || 0)) / (h.fga || 1);
  const aEFG = ((a.fgm || 0) + 0.5 * (a.fg3m || 0)) / (a.fga || 1);
  const hAR = ((h.ast || 0) / (h.fgm || 1)) * 100;
  const aAR = ((a.ast || 0) / (a.fgm || 1)) * 100;
  const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
              + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  const I3 = i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0;

  // I4 — Game Control (biggest_lead ±4 + Q4 margin ±2)
  const blDiff = hBigLead - aBigLead;
  const i4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
  let i4subB = 0;
  if (q4hPts != null && q4aPts != null) {
    const q4diff = q4hPts - q4aPts;
    i4subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
  }
  const I4 = (i4subA + i4subB) > 0 ? 1 : (i4subA + i4subB) === 0 ? 0.5 : 0;

  // I5 — Run share (6+ point runs)
  let I5 = 0.5;
  const hRuns = runs6.filter(r => r.team === hA).length;
  const aRuns = runs6.filter(r => r.team === aA).length;
  const totalRuns = hRuns + aRuns;
  if (totalRuns >= 4) {
    const rs = hRuns / totalRuns;
    I5 = rs > 0.55 ? 1 : rs < 0.45 ? 0 : 0.5;
  }

  // Composite (home-relative)
  const composite = I1 * W.I1 + I2 * W.I2 + I3 * W.I3 + I4 * W.I4 + I5 * W.I5;
  const ctrlHome = composite >= 0.5;
  const controlTeam = ctrlHome ? hA : aA;
  const score = ctrlHome ? composite : 1 - composite;

  return {
    controlTeam,
    score: Math.round(score * 100) / 100,
    composite: Math.round(composite * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA, awayAlias: aA,
    homePts: h.pts || 0, awayPts: a.pts || 0,
    raw: { hPaint, aPaint, hRimM, hRimA, aRimM, aRimA, hBigLead, aBigLead, hPOT, aPOT, hRuns, aRuns, totalRuns, q4hPts, q4aPts },
  };
}

// ── computeConviction — direct copy from poll-live-bdl.mjs:1779-1830 ─────────
// Data basis: I4+I5=100%(77g), I3+I4=99%(68g), I3+I5=96%(68g), 4+=100%(66g)
function computeConviction(ind) {
  if (!ind || ind.score == null) return { tier: 'NO ENTRY', combo: 'NONE', indicatorsWon: [], indicatorsLost: [], count: 0, pairs: [], isDanger: false };
  const ctrlHome = ind.controlTeam === ind.homeAlias;

  const wins = [], loses = [], even = [];
  for (const [key, val] of [['I1', ind.I1], ['I2', ind.I2], ['I3', ind.I3], ['I4', ind.I4], ['I5', ind.I5]]) {
    if (val == null) { even.push(key); continue; }
    const ctrlScore = ctrlHome ? val : 1 - val;
    if (ctrlScore > 0.5) wins.push(key);
    else if (ctrlScore < 0.5) loses.push(key);
    else even.push(key);
  }

  const count = wins.length;
  const has = (a, b) => wins.includes(a) && wins.includes(b);
  const combo = count > 0 ? wins.join('+') : 'NONE';

  const hasI4I5 = has('I4', 'I5');
  const hasI3I4 = has('I3', 'I4');
  const hasI3I5 = has('I3', 'I5');
  const hasKillerPair = hasI4I5 || hasI3I4 || hasI3I5;

  const isDanger = (
    (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
    (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
    (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4'))
  );

  let tier;
  if (count >= 4 || hasI4I5) tier = 'DOMINANT';
  else if (hasKillerPair && !isDanger) tier = 'STRONG';
  else if (count >= 2 && !isDanger) tier = 'MODEST';
  else if (count >= 1) tier = 'CONDITIONAL';
  else tier = 'NO ENTRY';

  const pairs = [];
  if (hasI4I5) pairs.push('I4+I5');
  if (hasI3I4) pairs.push('I3+I4');
  if (hasI3I5) pairs.push('I3+I5');

  return { tier, combo, count, indicatorsWon: wins, indicatorsLost: loses, indicatorsEven: even, pairs, isDanger };
}

// ── PHASE HANDLERS ───────────────────────────────────────────────────────────

async function phaseInit(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS nba_playoffs_backtest (
      bdl_game_id INTEGER PRIMARY KEY,
      season INTEGER,
      playoff_year INTEGER,
      playoff_round TEXT,
      date TEXT,
      home_alias TEXT,
      away_alias TEXT,
      home_pts INTEGER,
      away_pts INTEGER,
      margin INTEGER,
      winner_alias TEXT,
      team_stats JSONB,
      pbp_derived JSONB,
      indicators JSONB,
      conviction JSONB,
      ctrl_team_won BOOLEAN,
      pbp_available BOOLEAN DEFAULT false,
      computed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_po_year ON nba_playoffs_backtest(playoff_year)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_po_round ON nba_playoffs_backtest(playoff_round)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_po_tier ON nba_playoffs_backtest((conviction->>'tier'))`;
  return { status: 'ok', message: 'nba_playoffs_backtest table created', nextStep: '?phase=collect' };
}

async function phaseReset(sql) {
  const before = await sql`SELECT COUNT(*) AS total, COUNT(team_stats) AS with_box, COUNT(pbp_derived) AS with_pbp, COUNT(indicators) AS computed FROM nba_playoffs_backtest`;
  await sql`
    UPDATE nba_playoffs_backtest SET
      team_stats = NULL, pbp_derived = NULL,
      indicators = NULL, conviction = NULL, ctrl_team_won = NULL,
      pbp_available = false, computed_at = NULL
  `;
  return {
    status: 'ok',
    before: {
      total: Number(before[0].total),
      with_box: Number(before[0].with_box),
      with_pbp: Number(before[0].with_pbp),
      computed: Number(before[0].computed),
    },
    message: 'team_stats, pbp_derived, indicators, conviction cleared. Skeleton rows preserved.',
    nextStep: '?phase=boxscores, then ?phase=pbp, then ?phase=compute',
  };
}

async function phaseStatus(sql) {
  const counts = await sql`
    SELECT 
      COUNT(*) AS total,
      COUNT(team_stats) AS with_box,
      COUNT(pbp_derived) AS with_pbp,
      COUNT(indicators) AS computed,
      COUNT(CASE WHEN team_stats IS NULL THEN 1 END) AS needs_box,
      COUNT(CASE WHEN pbp_derived IS NULL THEN 1 END) AS needs_pbp
    FROM nba_playoffs_backtest
  `;
  const byYear = await sql`
    SELECT playoff_year, COUNT(*) AS total, COUNT(indicators) AS computed
    FROM nba_playoffs_backtest GROUP BY playoff_year ORDER BY playoff_year
  `;
  const byRound = await sql`
    SELECT playoff_round, COUNT(*) AS total, COUNT(indicators) AS computed
    FROM nba_playoffs_backtest GROUP BY playoff_round ORDER BY playoff_round
  `;
  return {
    total: Number(counts[0].total),
    withBox: Number(counts[0].with_box),
    withPbp: Number(counts[0].with_pbp),
    computed: Number(counts[0].computed),
    needsBox: Number(counts[0].needs_box),
    needsPbp: Number(counts[0].needs_pbp),
    byYear: byYear.map(r => ({ year: r.playoff_year, total: Number(r.total), computed: Number(r.computed) })),
    byRound: byRound.map(r => ({ round: r.playoff_round, total: Number(r.total), computed: Number(r.computed) })),
  };
}

// ── PHASE: COLLECT — pull game list from BDL /games endpoint ─────────────────
async function phaseCollect(sql) {
  const allGames = [];
  for (const season of SEASONS) {
    let cursor = null;
    let pages = 0;
    const MAX_PAGES = 10; // ~85 games per postseason, 100/page → 1 page enough, 10 is safe upper bound

    while (pages < MAX_PAGES) {
      let path = `/nba/v1/games?seasons[]=${season}&postseason=true&per_page=100`;
      if (cursor) path += `&cursor=${cursor}`;
      const resp = await bdlFetch(path);
      if (!resp?.data || resp.data.length === 0) break;

      for (const g of resp.data) {
        // Only include completed games
        const status = (g.status || '').toLowerCase();
        const isFinal = status === 'final' || status.includes('final') || (g.home_team_score > 0 && g.visitor_team_score > 0);
        if (!isFinal) continue;
        allGames.push({ ...g, _season: season });
      }

      cursor = resp.meta?.next_cursor;
      pages++;
      if (!cursor) break;
    }
  }

  console.log(`BDL: fetched ${allGames.length} completed postseason games`);

  let saved = 0, errors = 0;
  for (const g of allGames) {
    try {
      // BDL schema: home_team, visitor_team. Defensive against older/varied response shapes.
      const homeAbbr = g.home_team?.abbreviation || g.home_team?.team?.abbreviation || '';
      const awayAbbr = g.visitor_team?.abbreviation || g.visitor_team?.team?.abbreviation || g.away_team?.abbreviation || '';
      const homePts = g.home_team_score || 0;
      const awayPts = g.visitor_team_score || 0;
      const margin = homePts - awayPts;
      const winner = margin > 0 ? homeAbbr : awayAbbr;
      const date = (g.date || '').substring(0, 10);
      const playoffYear = g._season + 1; // season=2023 → 2024 playoffs
      const playoffRound = inferRound(date, playoffYear);

      if (!homeAbbr || !awayAbbr) {
        console.log(`collect skip game ${g.id}: missing team aliases (home=${homeAbbr}, away=${awayAbbr})`);
        errors++;
        continue;
      }

      await sql`
        INSERT INTO nba_playoffs_backtest (
          bdl_game_id, season, playoff_year, playoff_round, date,
          home_alias, away_alias, home_pts, away_pts, margin, winner_alias
        )
        VALUES (
          ${g.id}, ${g._season}, ${playoffYear}, ${playoffRound}, ${date},
          ${homeAbbr}, ${awayAbbr}, ${homePts}, ${awayPts}, ${margin}, ${winner}
        )
        ON CONFLICT (bdl_game_id) DO UPDATE SET
          home_pts = EXCLUDED.home_pts,
          away_pts = EXCLUDED.away_pts,
          margin = EXCLUDED.margin,
          winner_alias = EXCLUDED.winner_alias,
          playoff_round = EXCLUDED.playoff_round
      `;
      saved++;
    } catch (e) {
      console.log(`collect save error game ${g.id}: ${e.message}`);
      errors++;
    }
  }

  const byYear = await sql`
    SELECT playoff_year, COUNT(*) AS total FROM nba_playoffs_backtest GROUP BY playoff_year ORDER BY playoff_year
  `;
  const byRound = await sql`
    SELECT playoff_round, COUNT(*) AS total FROM nba_playoffs_backtest GROUP BY playoff_round ORDER BY playoff_round
  `;

  return {
    status: 'ok',
    gamesFound: allGames.length,
    saved,
    errors,
    byYear: byYear.map(r => ({ year: r.playoff_year, total: Number(r.total) })),
    byRound: byRound.map(r => ({ round: r.playoff_round, total: Number(r.total) })),
    nextStep: '?phase=boxscores to hydrate team stats',
  };
}

// ── PHASE: BOXSCORES — pull box scores by unique date, aggregate team stats ──
async function phaseBoxscores(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;

  // Get unique dates with games still missing team_stats
  const dates = await sql`
    SELECT DISTINCT date FROM nba_playoffs_backtest
    WHERE team_stats IS NULL
    ORDER BY date
  `;

  if (dates.length === 0) {
    return { status: 'ok', message: 'All games already have team_stats', nextStep: '?phase=pbp' };
  }

  let datesProcessed = 0, gamesUpdated = 0, errors = 0;
  const errorLog = [];

  for (const { date } of dates) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;

    try {
      const resp = await bdlFetch(`/nba/v1/box_scores?date=${date}`);
      if (!resp?.data) { errors++; errorLog.push(`${date}: no data`); continue; }

      for (const bs of resp.data) {
        // BDL box_scores: home_team + visitor_team (confirmed). Defensive against away_team alternatives.
        const hPlayers = bs.home_team?.players || [];
        const aPlayers = bs.visitor_team?.players || bs.away_team?.players || [];
        if (hPlayers.length === 0 || aPlayers.length === 0) continue;

        const sum = (arr, key) => arr.reduce((s, p) => s + (Number(p[key]) || 0), 0);
        const h = {
          stl: sum(hPlayers, 'stl'), blk: sum(hPlayers, 'blk'), oreb: sum(hPlayers, 'oreb'),
          to: sum(hPlayers, 'turnover'), fta: sum(hPlayers, 'fta'), ftm: sum(hPlayers, 'ftm'),
          fgm: sum(hPlayers, 'fgm'), fga: sum(hPlayers, 'fga'),
          fg3m: sum(hPlayers, 'fg3m'), fg3a: sum(hPlayers, 'fg3a'),
          ast: sum(hPlayers, 'ast'), pts: sum(hPlayers, 'pts'),
        };
        const a = {
          stl: sum(aPlayers, 'stl'), blk: sum(aPlayers, 'blk'), oreb: sum(aPlayers, 'oreb'),
          to: sum(aPlayers, 'turnover'), fta: sum(aPlayers, 'fta'), ftm: sum(aPlayers, 'ftm'),
          fgm: sum(aPlayers, 'fgm'), fga: sum(aPlayers, 'fga'),
          fg3m: sum(aPlayers, 'fg3m'), fg3a: sum(aPlayers, 'fg3a'),
          ast: sum(aPlayers, 'ast'), pts: sum(aPlayers, 'pts'),
        };

        // Match by game_id — try both common key names
        const bdlGameId = bs.id || bs.game_id;
        if (!bdlGameId) continue;

        const updated = await sql`
          UPDATE nba_playoffs_backtest
          SET team_stats = ${JSON.stringify({ home: h, away: a })}::jsonb
          WHERE bdl_game_id = ${bdlGameId}
        `;
        if (updated.length || updated.count) gamesUpdated++;
      }
      datesProcessed++;
    } catch (e) {
      errors++;
      errorLog.push(`${date}: ${e.message}`);
    }

    // Tiny courtesy delay — BDL is 60/s but no need to hammer
    await delay(50);
  }

  const remaining = await sql`SELECT COUNT(*) AS n FROM nba_playoffs_backtest WHERE team_stats IS NULL`;

  return {
    status: 'ok',
    datesProcessed,
    gamesUpdated,
    errors,
    errorLog: errorLog.slice(0, 10),
    remaining: Number(remaining[0].n),
    nextStep: remaining[0].n > 0 ? '?phase=boxscores again' : '?phase=pbp',
  };
}

// ── PHASE: PBP — pull plays per game, derive paint/rim/biggest_lead/runs/POT ─
async function phasePbp(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;
  const batchSize = parseInt(url.searchParams.get('n') || '50');

  // Games with team_stats but no pbp_derived
  const games = await sql`
    SELECT bdl_game_id, home_alias, away_alias
    FROM nba_playoffs_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NULL
    ORDER BY date ASC
    LIMIT ${batchSize}
  `;

  if (games.length === 0) {
    return { status: 'ok', message: 'All games with team_stats have PBP', nextStep: '?phase=compute' };
  }

  let updated = 0, failed = 0;
  const failLog = [];

  for (const g of games) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;

    const { bdl_game_id: gid, home_alias: hA, away_alias: aA } = g;

    try {
      const resp = await bdlFetch(`/nba/v1/plays?game_id=${gid}&per_page=500`);
      const plays = resp?.data || [];

      if (plays.length === 0) {
        // No PBP available — mark pbp_available=false but leave pbp_derived null
        await sql`UPDATE nba_playoffs_backtest SET pbp_available = false WHERE bdl_game_id = ${gid}`;
        failed++; failLog.push(`${gid}: no plays`);
        continue;
      }

      // Parse PBP — same logic as combo-sim-console.js:98-155
      let hPaint = 0, aPaint = 0, hRimM = 0, hRimA = 0, aRimM = 0, aRimA = 0;
      let hBigLead = 0, aBigLead = 0, hPOT = 0, aPOT = 0;
      let hScore = 0, aScore = 0;
      let q4hPts = 0, q4aPts = 0;
      const scoreLog = [];
      const runs6 = [];
      let runTeam = null, runPts = 0;

      for (const p of plays) {
        const team = p.team?.abbreviation || '';
        const pts = p.scoring_play ? (p.points_scored || 0) : 0;
        const desc = (p.play_type || p.description || '').toLowerCase();
        const period = p.period || 0;

        if (pts > 0) {
          if (team === hA) hScore += pts; else if (team === aA) aScore += pts;
          scoreLog.push({ team, pts, q: period, hScore, aScore });

          // Q4 margin (sub-B for I4)
          if (period === 4) {
            if (team === hA) q4hPts += pts;
            else if (team === aA) q4aPts += pts;
          }

          const margin = hScore - aScore;
          if (margin > hBigLead) hBigLead = margin;
          if (-margin > aBigLead) aBigLead = -margin;

          // Paint/rim classification
          const isRim = desc.includes('dunk') || desc.includes('layup') || desc.includes('tip');
          const isPaint = isRim || desc.includes('paint') || desc.includes('hook') || desc.includes('floater');
          if (isPaint && pts === 2) {
            if (team === hA) { hPaint += 2; if (isRim) hRimM++; }
            else if (team === aA) { aPaint += 2; if (isRim) aRimM++; }
          }

          // Runs
          if (team === runTeam) { runPts += pts; }
          else { if (runPts >= 6 && runTeam) runs6.push({ team: runTeam }); runTeam = team; runPts = pts; }
        }

        // Rim misses
        if (desc.includes('miss') && (desc.includes('dunk') || desc.includes('layup') || desc.includes('tip'))) {
          if (team === hA) hRimA++;
          else if (team === aA) aRimA++;
        }
      }
      if (runPts >= 6 && runTeam) runs6.push({ team: runTeam });
      hRimA += hRimM; // total attempts = makes + misses
      aRimA += aRimM;

      // POT: scoring play immediately after opponent TO
      let lastTO = null;
      for (const p of plays) {
        const team = p.team?.abbreviation || '';
        const desc = (p.play_type || p.description || '').toLowerCase();
        if (desc.includes('turnover') || p.play_type === 'turnover') {
          lastTO = team;
        } else if (p.scoring_play && lastTO && team !== lastTO) {
          if (team === hA) hPOT += (p.points_scored || 0);
          else if (team === aA) aPOT += (p.points_scored || 0);
          lastTO = null;
        } else if (p.scoring_play) {
          lastTO = null;
        }
      }

      const hRuns = runs6.filter(r => r.team === hA).length;
      const aRuns = runs6.filter(r => r.team === aA).length;

      const pbpDerived = {
        hPaint, aPaint, hRimM, hRimA, aRimM, aRimA,
        hBigLead, aBigLead, hPOT, aPOT,
        q4hPts, q4aPts,
        runs6: { h: hRuns, a: aRuns, total: hRuns + aRuns, detail: runs6 },
        totalPlays: plays.length,
      };

      await sql`
        UPDATE nba_playoffs_backtest
        SET pbp_derived = ${JSON.stringify(pbpDerived)}::jsonb,
            pbp_available = true
        WHERE bdl_game_id = ${gid}
      `;
      updated++;
    } catch (e) {
      failed++;
      failLog.push(`${gid}: ${e.message}`);
    }

    await delay(50);
  }

  const remaining = await sql`
    SELECT COUNT(*) AS n FROM nba_playoffs_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NULL
  `;

  return {
    status: 'ok',
    processed: games.length,
    updated,
    failed,
    failLog: failLog.slice(0, 10),
    remaining: Number(remaining[0].n),
    nextStep: remaining[0].n > 0 ? `?phase=pbp&n=${batchSize} again` : '?phase=compute',
  };
}

// ── PHASE: COMPUTE — run computeServer + computeConviction on every row ──────
async function phaseCompute(sql) {
  const rows = await sql`
    SELECT bdl_game_id, home_alias, away_alias, home_pts, away_pts, winner_alias,
           team_stats, pbp_derived
    FROM nba_playoffs_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NOT NULL
  `;

  let computed = 0, errors = 0;
  for (const row of rows) {
    try {
      const ts = row.team_stats;
      const pd = row.pbp_derived;

      const ind = computeServer({
        h: ts.home, a: ts.away,
        hA: row.home_alias, aA: row.away_alias,
        hPaint: pd.hPaint, aPaint: pd.aPaint,
        hRimM: pd.hRimM, hRimA: pd.hRimA, aRimM: pd.aRimM, aRimA: pd.aRimA,
        hBigLead: pd.hBigLead, aBigLead: pd.aBigLead,
        hPOT: pd.hPOT, aPOT: pd.aPOT,
        runs6: pd.runs6?.detail || [],
        q4hPts: pd.q4hPts, q4aPts: pd.q4aPts,
      });

      if (!ind) { errors++; continue; }

      const conv = computeConviction(ind);
      const ctrlWon = row.winner_alias === ind.controlTeam;

      await sql`
        UPDATE nba_playoffs_backtest
        SET indicators = ${JSON.stringify(ind)}::jsonb,
            conviction = ${JSON.stringify(conv)}::jsonb,
            ctrl_team_won = ${ctrlWon},
            computed_at = NOW()
        WHERE bdl_game_id = ${row.bdl_game_id}
      `;
      computed++;
    } catch (e) {
      console.log(`compute error ${row.bdl_game_id}: ${e.message}`);
      errors++;
    }
  }

  return {
    status: 'ok',
    computed,
    errors,
    total: rows.length,
    nextStep: '?phase=report',
  };
}

// ── PHASE: REPORT — stratified accuracy breakdown ────────────────────────────
async function phaseReport(sql) {
  const rows = await sql`
    SELECT bdl_game_id, playoff_year, playoff_round, date,
           home_alias, away_alias, home_pts, away_pts, margin, winner_alias,
           indicators, conviction, ctrl_team_won
    FROM nba_playoffs_backtest
    WHERE indicators IS NOT NULL
    ORDER BY date
  `;

  if (rows.length === 0) {
    return { error: 'No computed rows. Run ?phase=compute first.' };
  }

  const total = rows.length;
  const correct = rows.filter(r => r.ctrl_team_won).length;
  const overallPct = Math.round(correct / total * 1000) / 10;

  // By conviction tier
  const byTier = {};
  for (const r of rows) {
    const t = r.conviction?.tier || 'UNKNOWN';
    if (!byTier[t]) byTier[t] = { correct: 0, total: 0 };
    byTier[t].total++;
    if (r.ctrl_team_won) byTier[t].correct++;
  }
  const byTierReport = {};
  for (const [tier, v] of Object.entries(byTier)) {
    byTierReport[tier] = {
      correct: v.correct,
      total: v.total,
      pct: Math.round(v.correct / v.total * 1000) / 10,
    };
  }
  // Add regular-season baselines
  if (byTierReport.DOMINANT) byTierReport.DOMINANT.baseline_reg_season = '100%';
  if (byTierReport.STRONG) byTierReport.STRONG.baseline_reg_season = '96-99%';
  if (byTierReport.MODEST) byTierReport.MODEST.baseline_reg_season = '70-80%';
  if (byTierReport.CONDITIONAL) byTierReport.CONDITIONAL.baseline_reg_season = '40-70%';

  // By single indicator won (ctrl team won this indicator)
  const singles = { I1: { correct: 0, total: 0 }, I2: { correct: 0, total: 0 },
                    I3: { correct: 0, total: 0 }, I4: { correct: 0, total: 0 },
                    I5: { correct: 0, total: 0 } };
  for (const r of rows) {
    const wins = r.conviction?.indicatorsWon || [];
    for (const w of wins) {
      if (singles[w]) {
        singles[w].total++;
        if (r.ctrl_team_won) singles[w].correct++;
      }
    }
  }
  const singlesReport = {};
  for (const [k, v] of Object.entries(singles)) {
    singlesReport[k] = {
      correct: v.correct,
      total: v.total,
      pct: v.total > 0 ? Math.round(v.correct / v.total * 1000) / 10 : null,
    };
  }
  // I4 baseline is 98% regular season
  singlesReport.I4.baseline_reg_season = '98%';

  // By killer pair
  const killerPairs = { 'I4+I5': { correct: 0, total: 0 }, 'I3+I4': { correct: 0, total: 0 }, 'I3+I5': { correct: 0, total: 0 } };
  for (const r of rows) {
    const pairs = r.conviction?.pairs || [];
    for (const p of pairs) {
      if (killerPairs[p]) {
        killerPairs[p].total++;
        if (r.ctrl_team_won) killerPairs[p].correct++;
      }
    }
  }
  const pairsReport = {};
  for (const [k, v] of Object.entries(killerPairs)) {
    pairsReport[k] = {
      correct: v.correct,
      total: v.total,
      pct: v.total > 0 ? Math.round(v.correct / v.total * 1000) / 10 : null,
    };
  }
  pairsReport['I4+I5'].baseline_reg_season = '100%';
  pairsReport['I3+I4'].baseline_reg_season = '99%';
  pairsReport['I3+I5'].baseline_reg_season = '96%';

  // By round
  const byRound = {};
  for (const r of rows) {
    const rd = r.playoff_round || 'UNK';
    if (!byRound[rd]) byRound[rd] = { correct: 0, total: 0 };
    byRound[rd].total++;
    if (r.ctrl_team_won) byRound[rd].correct++;
  }
  const byRoundReport = {};
  for (const [rd, v] of Object.entries(byRound)) {
    byRoundReport[rd] = { correct: v.correct, total: v.total, pct: Math.round(v.correct / v.total * 1000) / 10 };
  }

  // By year
  const byYear = {};
  for (const r of rows) {
    const y = r.playoff_year || 0;
    if (!byYear[y]) byYear[y] = { correct: 0, total: 0 };
    byYear[y].total++;
    if (r.ctrl_team_won) byYear[y].correct++;
  }
  const byYearReport = {};
  for (const [y, v] of Object.entries(byYear)) {
    byYearReport[y] = { correct: v.correct, total: v.total, pct: Math.round(v.correct / v.total * 1000) / 10 };
  }

  // Danger combos
  const dangerReport = { count: 0, correct: 0, examples: [] };
  for (const r of rows) {
    if (r.conviction?.isDanger) {
      dangerReport.count++;
      if (r.ctrl_team_won) dangerReport.correct++;
      if (dangerReport.examples.length < 10) {
        dangerReport.examples.push({
          date: r.date, matchup: `${r.away_alias}@${r.home_alias}`,
          ctrl: r.indicators?.controlTeam, won: r.winner_alias,
          combo: r.conviction?.combo,
        });
      }
    }
  }
  dangerReport.pct = dangerReport.count > 0 ? Math.round(dangerReport.correct / dangerReport.count * 1000) / 10 : null;

  // Wrong games (for diagnosis)
  const wrong = rows.filter(r => !r.ctrl_team_won).map(r => ({
    date: r.date,
    matchup: `${r.away_alias}@${r.home_alias}`,
    score: `${r.away_pts}-${r.home_pts}`,
    ctrl: r.indicators?.controlTeam,
    won: r.winner_alias,
    floor: r.indicators?.score,
    tier: r.conviction?.tier,
    combo: r.conviction?.combo,
    round: r.playoff_round,
    year: r.playoff_year,
    indicators: { I1: r.indicators?.I1, I2: r.indicators?.I2, I3: r.indicators?.I3, I4: r.indicators?.I4, I5: r.indicators?.I5 },
  }));

  return {
    total,
    overall: {
      correct,
      total,
      pct: overallPct,
      baseline_reg_season: '93.4%',
    },
    by_tier: byTierReport,
    by_indicator_single_won: singlesReport,
    by_killer_pair: pairsReport,
    by_round: byRoundReport,
    by_year: byYearReport,
    danger_combos: dangerReport,
    wrong_games: wrong,
  };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async (req) => {
  const sql = neon(process.env.DATABASE_URL);
  const url = new URL(req.url);
  const phase = url.searchParams.get('phase') || 'status';

  try {
    let result;
    switch (phase) {
      case 'init':      result = await phaseInit(sql); break;
      case 'reset':     result = await phaseReset(sql); break;
      case 'status':    result = await phaseStatus(sql); break;
      case 'collect':   result = await phaseCollect(sql); break;
      case 'boxscores': result = await phaseBoxscores(sql, url); break;
      case 'pbp':       result = await phasePbp(sql, url); break;
      case 'compute':   result = await phaseCompute(sql); break;
      case 'report':    result = await phaseReport(sql); break;
      default:
        result = { error: `Unknown phase: ${phase}. Use init, collect, boxscores, pbp, compute, report, status, reset.` };
    }
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/backtest-nba-playoffs' };
