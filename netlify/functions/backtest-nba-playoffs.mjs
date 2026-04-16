// NBA Backtest — Indicator Validation Across Playoffs + Regular Season
// BDL-only (60 calls/s). Uses the exact same methodology as the 171-game
// regular season validation (combo-sim-console.js).
//
// Game types:
//   - playoff_2024:  2023-24 postseason (calendar year 2024)
//   - playoff_2025:  2024-25 postseason (calendar year 2025)
//   - regular:       2024-25 regular season (BDL season=2024)
//
// Phases:
//   ?phase=init              — Create nba_backtest table (+ migrate old name)
//   ?phase=collect_playoffs  — BDL: pull postseason games (seasons 2023, 2024)
//   ?phase=collect_regular   — BDL: pull 2024-25 regular season games (~1,230)
//   ?phase=boxscores         — BDL: aggregate team stats from box_scores by date
//   ?phase=pbp&n=200&c=8     — BDL: plays per game, concurrent batches (default c=8)
//   ?phase=compute           — Run computeServer + computeConviction on cached data
//   ?phase=report            — Stratified accuracy (by game_type + close-games slice)
//   ?phase=status            — Progress summary
//   ?phase=reset             — Clear computed columns (keep BDL-collected data)
//
// BDL season convention (confirmed):
//   season=2023 = 2023-24 regular → 2024 playoffs
//   season=2024 = 2024-25 regular → 2025 playoffs

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
  // Migrate old table name if it exists and new one doesn't
  const oldExists = await sql`SELECT to_regclass('nba_playoffs_backtest') AS t`;
  const newExists = await sql`SELECT to_regclass('nba_backtest') AS t`;
  if (oldExists[0].t && !newExists[0].t) {
    console.log('Migrating nba_playoffs_backtest → nba_backtest');
    await sql`ALTER TABLE nba_playoffs_backtest RENAME TO nba_backtest`;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS nba_backtest (
      bdl_game_id INTEGER PRIMARY KEY,
      season INTEGER,
      game_type TEXT,                -- 'regular' | 'playoff_2024' | 'playoff_2025'
      playoff_year INTEGER,          -- nullable for regular season
      playoff_round TEXT,            -- nullable for regular season
      date TEXT,
      home_alias TEXT,
      away_alias TEXT,
      home_pts INTEGER,
      away_pts INTEGER,
      margin INTEGER,                -- home - away (signed)
      margin_abs INTEGER,            -- |margin|, derived for fast close-game filtering
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

  // Add new columns if migrating from old schema
  await sql`ALTER TABLE nba_backtest ADD COLUMN IF NOT EXISTS game_type TEXT`;
  await sql`ALTER TABLE nba_backtest ADD COLUMN IF NOT EXISTS margin_abs INTEGER`;

  // Backfill game_type from playoff_year for any pre-existing rows
  const backfilled = await sql`
    UPDATE nba_backtest
    SET game_type = CASE
      WHEN playoff_year = 2024 THEN 'playoff_2024'
      WHEN playoff_year = 2025 THEN 'playoff_2025'
      ELSE 'regular'
    END
    WHERE game_type IS NULL
  `;

  // Backfill margin_abs from margin
  await sql`UPDATE nba_backtest SET margin_abs = ABS(margin) WHERE margin_abs IS NULL AND margin IS NOT NULL`;

  await sql`CREATE INDEX IF NOT EXISTS idx_nba_bt_type ON nba_backtest(game_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_bt_year ON nba_backtest(playoff_year)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_bt_round ON nba_backtest(playoff_round)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_bt_tier ON nba_backtest((conviction->>'tier'))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nba_bt_close ON nba_backtest(margin_abs)`;

  return {
    status: 'ok',
    message: 'nba_backtest table ready',
    migrated: oldExists[0].t && !newExists[0].t ? 'renamed from nba_playoffs_backtest' : 'none',
    nextStep: '?phase=collect_playoffs or ?phase=collect_regular',
  };
}

async function phaseReset(sql) {
  const before = await sql`SELECT COUNT(*) AS total, COUNT(team_stats) AS with_box, COUNT(pbp_derived) AS with_pbp, COUNT(indicators) AS computed FROM nba_backtest`;
  await sql`
    UPDATE nba_backtest SET
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

// ── PHASE: RETENTION — probe BDL plays retention cliff ──────────────────────
// Binary-search across recent dates to find oldest date where plays still work.
async function phaseRetention(sql, url) {
  if (!BDL_KEY) return { error: 'BDL_KEY missing' };

  // Probe these dates: today, 1w, 2w, 1m, 2m, 3m, 6m, 9m, 12m back
  const today = new Date();
  const daysBack = [1, 7, 14, 30, 60, 90, 120, 180, 270, 365];

  const probes = [];
  for (const db of daysBack) {
    const d = new Date(today);
    d.setDate(d.getDate() - db);
    const dStr = d.toISOString().substring(0, 10);

    // Find a completed game on that date (or nearest day)
    let game = null;
    for (let offset = 0; offset <= 2; offset++) {
      const tryDate = new Date(d);
      tryDate.setDate(tryDate.getDate() - offset);
      const tryStr = tryDate.toISOString().substring(0, 10);
      const resp = await bdlFetch(`/nba/v1/games?dates[]=${tryStr}&per_page=25`);
      const finished = (resp?.data || []).filter(g => g.home_team_score > 0);
      if (finished.length > 0) {
        game = { id: finished[0].id, date: tryStr };
        break;
      }
    }

    if (!game) {
      probes.push({ daysBack: db, target: dStr, error: 'no completed games found within 2d window' });
      continue;
    }

    // Probe plays for this game
    const playsResp = await bdlFetch(`/nba/v1/plays?game_id=${game.id}&per_page=500`);
    const plays = playsResp?.data || [];

    probes.push({
      daysBack: db,
      date: game.date,
      gameId: game.id,
      plays: plays.length,
      hasData: plays.length > 0,
    });
  }

  // Find cliff — oldest date where hasData is true
  const working = probes.filter(p => p.hasData);
  const failing = probes.filter(p => p.hasData === false);
  const oldestWorking = working.length > 0 ? working[working.length - 1] : null;
  const newestFailing = failing.length > 0 ? failing[0] : null;

  return {
    probes,
    cliff: {
      oldestWorkingDate: oldestWorking?.date,
      oldestWorkingDaysBack: oldestWorking?.daysBack,
      newestFailingDate: newestFailing?.date,
      newestFailingDaysBack: newestFailing?.daysBack,
    },
    interpretation: oldestWorking && newestFailing
      ? `Retention window is between ${oldestWorking.daysBack}d and ${newestFailing.daysBack}d. Plays work back to ~${oldestWorking.date}.`
      : working.length === 0
        ? 'No historical plays accessible via BDL.'
        : 'All probed dates have plays — retention is at least 365 days.',
  };
}
async function phaseInventory(sql) {
  // Count games with both PBP and box_score_json in game_pbp (the only ones we can use)
  const counts = await sql`
    SELECT 
      COUNT(*) FILTER (WHERE p.pbp_json IS NOT NULL) AS with_pbp,
      COUNT(*) FILTER (WHERE p.box_score_json IS NOT NULL) AS with_box,
      COUNT(*) FILTER (WHERE p.pbp_json IS NOT NULL AND p.box_score_json IS NOT NULL) AS with_both,
      COUNT(*) FILTER (WHERE p.pbp_json IS NOT NULL AND p.box_score_json IS NOT NULL AND g.home_pts IS NOT NULL AND g.home_pts > 0) AS complete,
      MIN(g.date) AS earliest_date,
      MAX(g.date) AS latest_date
    FROM game_pbp p
    LEFT JOIN games g ON g.id = p.game_id
    WHERE p.league = 'nba'
  `;

  // Check by date bucket to see distribution
  // (games.date is stored as TEXT like '2026-04-15', not DATE — use substring)
  const byMonth = await sql`
    SELECT SUBSTRING(g.date FROM 1 FOR 7) AS month, COUNT(*) AS n
    FROM game_pbp p
    JOIN games g ON g.id = p.game_id
    WHERE p.league = 'nba' AND p.pbp_json IS NOT NULL AND p.box_score_json IS NOT NULL
      AND g.home_pts IS NOT NULL AND g.home_pts > 0
    GROUP BY month
    ORDER BY month
  `;

  // Check playoff vs regular season via date
  const playoffDates = await sql`
    SELECT COUNT(*) AS n FROM game_pbp p
    JOIN games g ON g.id = p.game_id
    WHERE p.league = 'nba' AND p.pbp_json IS NOT NULL AND p.box_score_json IS NOT NULL
      AND g.home_pts IS NOT NULL AND g.home_pts > 0
      AND ((g.date >= '2025-04-19' AND g.date <= '2025-06-30') OR (g.date >= '2026-04-15'))
  `;

  // Sample a row to see what's actually in pbp_json and box_score_json
  const sample = await sql`
    SELECT p.game_id, g.date, g.home_alias, g.away_alias, g.home_pts, g.away_pts,
           p.pbp_json, p.box_score_json
    FROM game_pbp p
    JOIN games g ON g.id = p.game_id
    WHERE p.league = 'nba' AND p.pbp_json IS NOT NULL AND p.box_score_json IS NOT NULL
    ORDER BY g.date DESC LIMIT 1
  `;

  let pbpShape = null, boxShape = null;
  if (sample.length > 0) {
    const pbp = typeof sample[0].pbp_json === 'string' ? JSON.parse(sample[0].pbp_json) : sample[0].pbp_json;
    const box = typeof sample[0].box_score_json === 'string' ? JSON.parse(sample[0].box_score_json) : sample[0].box_score_json;
    pbpShape = {
      topKeys: Object.keys(pbp || {}),
      hasHome: !!pbp?.home,
      hasAway: !!pbp?.away,
      hasRuns6: Array.isArray(pbp?.runs6) ? `array len ${pbp.runs6.length}` : (pbp?.runs6 ? 'object' : 'missing'),
      has_bdl: !!pbp?._bdl,
      homeKeys: pbp?.home ? Object.keys(pbp.home) : null,
      _bdlKeys: pbp?._bdl ? Object.keys(pbp._bdl) : null,
    };
    boxShape = {
      topKeys: Object.keys(box || {}),
      hasHome: !!box?.home,
      hasAway: !!box?.away,
      homeKeys: box?.home ? Object.keys(box.home) : null,
    };
  }

  return {
    totals: {
      with_pbp: Number(counts[0].with_pbp),
      with_box: Number(counts[0].with_box),
      with_both: Number(counts[0].with_both),
      complete_with_scores: Number(counts[0].complete),
      earliest: counts[0].earliest_date,
      latest: counts[0].latest_date,
    },
    playoff_window_games: Number(playoffDates[0].n),
    byMonth: byMonth.map(r => ({ month: r.month, games: Number(r.n) })),
    sampleGame: sample.length > 0 ? {
      id: sample[0].game_id,
      date: sample[0].date,
      matchup: `${sample[0].away_alias}@${sample[0].home_alias}`,
      score: `${sample[0].away_pts}-${sample[0].home_pts}`,
    } : null,
    pbpJsonShape: pbpShape,
    boxScoreJsonShape: boxShape,
  };
}
// Usage: ?phase=diagnose                (tests one from each game_type)
//        ?phase=diagnose&gid=15882375   (specific game ID)
async function phaseDiagnose(sql, url) {
  if (!BDL_KEY) return { error: 'BDL_KEY missing from env' };

  const gidParam = url.searchParams.get('gid');

  async function probe(gid, label) {
    const path = `/nba/v1/plays?game_id=${gid}&per_page=500`;
    try {
      const resp = await fetch(`${BDL_BASE}${path}`, { headers: { Authorization: BDL_KEY } });
      const body = await resp.json().catch(() => ({}));
      return {
        label,
        gid,
        status: resp.status,
        dataLength: Array.isArray(body?.data) ? body.data.length : 'not array',
        firstPlay: Array.isArray(body?.data) && body.data.length > 0 ? body.data[0] : null,
        rateLimitRemaining: resp.headers.get('x-ratelimit-remaining'),
      };
    } catch (e) {
      return { label, gid, error: e.message };
    }
  }

  // Single-game mode (existing behavior)
  if (gidParam) {
    return await probe(gidParam, 'specified');
  }

  // Multi-game mode — test one from each game_type, plus a very recent live game from existing games table
  const probes = [];

  // One from each game_type in our backtest table (oldest to newest)
  const types = ['playoff_2024', 'regular', 'playoff_2025'];
  for (const t of types) {
    const row = await sql`
      SELECT bdl_game_id, date FROM nba_backtest
      WHERE game_type = ${t}
      ORDER BY date ${t === 'playoff_2025' ? sql`DESC` : sql`ASC`}
      LIMIT 1
    `;
    if (row.length > 0) {
      probes.push(await probe(row[0].bdl_game_id, `${t} (${row[0].date})`));
    }
  }

  // Probe a very recent BDL game ID (pull from BDL /games endpoint directly)
  // We can't use the `games` table because it stores SR UUIDs, not BDL integer IDs.
  try {
    // Look back up to 30 days for a completed BDL game
    const today = new Date();
    let foundRecent = null;
    for (let daysBack = 1; daysBack <= 30; daysBack++) {
      const d = new Date(today);
      d.setDate(d.getDate() - daysBack);
      const dStr = d.toISOString().substring(0, 10);
      const resp = await bdlFetch(`/nba/v1/games?dates[]=${dStr}&per_page=25`);
      const games = (resp?.data || []).filter(g => g.home_team_score > 0);
      if (games.length > 0) {
        foundRecent = { id: games[0].id, date: dStr };
        break;
      }
    }
    if (foundRecent) {
      probes.push(await probe(foundRecent.id, `recent_bdl (${foundRecent.date})`));
    } else {
      probes.push({ label: 'recent_bdl', error: 'No completed BDL games found in last 30 days' });
    }
  } catch (e) {
    probes.push({ label: 'recent_bdl', error: e.message });
  }

  return {
    keyPresent: true,
    keyPrefix: BDL_KEY.substring(0, 8) + '...',
    probes,
    interpretation: 'If all dataLength=0 → BDL has retention limits on historical plays. If recent_live > 0 → confirmed retention issue.',
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
    FROM nba_backtest
  `;
  const byType = await sql`
    SELECT game_type, COUNT(*) AS total,
           COUNT(team_stats) AS with_box,
           COUNT(pbp_derived) AS with_pbp,
           COUNT(indicators) AS computed
    FROM nba_backtest GROUP BY game_type ORDER BY game_type
  `;
  const byRound = await sql`
    SELECT playoff_round, COUNT(*) AS total, COUNT(indicators) AS computed
    FROM nba_backtest WHERE playoff_round IS NOT NULL
    GROUP BY playoff_round ORDER BY playoff_round
  `;
  return {
    total: Number(counts[0].total),
    withBox: Number(counts[0].with_box),
    withPbp: Number(counts[0].with_pbp),
    computed: Number(counts[0].computed),
    needsBox: Number(counts[0].needs_box),
    needsPbp: Number(counts[0].needs_pbp),
    byGameType: byType.map(r => ({
      type: r.game_type,
      total: Number(r.total),
      withBox: Number(r.with_box),
      withPbp: Number(r.with_pbp),
      computed: Number(r.computed),
    })),
    byRound: byRound.map(r => ({ round: r.playoff_round, total: Number(r.total), computed: Number(r.computed) })),
  };
}

// ── PHASE: COLLECT_PLAYOFFS — pull postseason games from BDL /games ──────────
async function phaseCollectPlayoffs(sql) {
  const allGames = [];
  for (const season of SEASONS) {
    let cursor = null;
    let pages = 0;
    const MAX_PAGES = 10;

    while (pages < MAX_PAGES) {
      let path = `/nba/v1/games?seasons[]=${season}&postseason=true&per_page=100`;
      if (cursor) path += `&cursor=${cursor}`;
      const resp = await bdlFetch(path);
      if (!resp?.data || resp.data.length === 0) break;

      for (const g of resp.data) {
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
      const homeAbbr = g.home_team?.abbreviation || g.home_team?.team?.abbreviation || '';
      const awayAbbr = g.visitor_team?.abbreviation || g.visitor_team?.team?.abbreviation || g.away_team?.abbreviation || '';
      const homePts = g.home_team_score || 0;
      const awayPts = g.visitor_team_score || 0;
      const margin = homePts - awayPts;
      const marginAbs = Math.abs(margin);
      const winner = margin > 0 ? homeAbbr : awayAbbr;
      const date = (g.date || '').substring(0, 10);
      const playoffYear = g._season + 1; // season=2023 → 2024 playoffs
      const gameType = `playoff_${playoffYear}`;
      const playoffRound = inferRound(date, playoffYear);

      if (!homeAbbr || !awayAbbr) {
        console.log(`collect_playoffs skip game ${g.id}: missing team aliases`);
        errors++;
        continue;
      }

      await sql`
        INSERT INTO nba_backtest (
          bdl_game_id, season, game_type, playoff_year, playoff_round, date,
          home_alias, away_alias, home_pts, away_pts, margin, margin_abs, winner_alias
        )
        VALUES (
          ${g.id}, ${g._season}, ${gameType}, ${playoffYear}, ${playoffRound}, ${date},
          ${homeAbbr}, ${awayAbbr}, ${homePts}, ${awayPts}, ${margin}, ${marginAbs}, ${winner}
        )
        ON CONFLICT (bdl_game_id) DO UPDATE SET
          game_type = EXCLUDED.game_type,
          home_pts = EXCLUDED.home_pts,
          away_pts = EXCLUDED.away_pts,
          margin = EXCLUDED.margin,
          margin_abs = EXCLUDED.margin_abs,
          winner_alias = EXCLUDED.winner_alias,
          playoff_round = EXCLUDED.playoff_round
      `;
      saved++;
    } catch (e) {
      console.log(`collect_playoffs save error game ${g.id}: ${e.message}`);
      errors++;
    }
  }

  const byType = await sql`SELECT game_type, COUNT(*) AS total FROM nba_backtest GROUP BY game_type ORDER BY game_type`;
  const byRound = await sql`SELECT playoff_round, COUNT(*) AS total FROM nba_backtest WHERE playoff_round IS NOT NULL GROUP BY playoff_round ORDER BY playoff_round`;

  return {
    status: 'ok',
    gamesFound: allGames.length,
    saved,
    errors,
    byGameType: byType.map(r => ({ type: r.game_type, total: Number(r.total) })),
    byRound: byRound.map(r => ({ round: r.playoff_round, total: Number(r.total) })),
    nextStep: 'Optionally ?phase=collect_regular, then ?phase=boxscores',
  };
}

// ── PHASE: COLLECT_REGULAR — pull 2024-25 regular season games (~1,230) ──────
async function phaseCollectRegular(sql) {
  const REGULAR_SEASON = 2024; // BDL convention: 2024 = 2024-25 regular season
  const allGames = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 20; // 1,230 games / 100 per page = 13 pages, 20 is safe upper bound

  while (pages < MAX_PAGES) {
    let path = `/nba/v1/games?seasons[]=${REGULAR_SEASON}&postseason=false&per_page=100`;
    if (cursor) path += `&cursor=${cursor}`;
    const resp = await bdlFetch(path);
    if (!resp?.data || resp.data.length === 0) break;

    for (const g of resp.data) {
      const status = (g.status || '').toLowerCase();
      const isFinal = status === 'final' || status.includes('final') || (g.home_team_score > 0 && g.visitor_team_score > 0);
      if (!isFinal) continue;
      allGames.push(g);
    }

    cursor = resp.meta?.next_cursor;
    pages++;
    if (!cursor) break;
  }

  console.log(`BDL: fetched ${allGames.length} completed regular season games (${pages} pages)`);

  // Build rows with dedup by game id
  const rowMap = new Map();
  let skipped = 0;
  for (const g of allGames) {
    const homeAbbr = g.home_team?.abbreviation || g.home_team?.team?.abbreviation || '';
    const awayAbbr = g.visitor_team?.abbreviation || g.visitor_team?.team?.abbreviation || g.away_team?.abbreviation || '';
    const homePts = g.home_team_score || 0;
    const awayPts = g.visitor_team_score || 0;
    const margin = homePts - awayPts;
    const marginAbs = Math.abs(margin);
    const winner = margin > 0 ? homeAbbr : awayAbbr;
    const date = (g.date || '').substring(0, 10);

    if (!homeAbbr || !awayAbbr) { skipped++; continue; }

    rowMap.set(g.id, {
      id: g.id, date,
      homeAbbr, awayAbbr, homePts, awayPts, margin, marginAbs, winner,
    });
  }

  // Parallel INSERT with concurrency cap. Each query is independent,
  // so this cuts wall-clock time from ~60s (sequential) to ~2-3s (20-way parallel).
  const rows = [...rowMap.values()];
  const CONCURRENCY = 20;
  let saved = 0, errors = 0;
  const errorLog = [];

  async function insertOne(r) {
    try {
      await sql`
        INSERT INTO nba_backtest (
          bdl_game_id, season, game_type, playoff_year, playoff_round, date,
          home_alias, away_alias, home_pts, away_pts, margin, margin_abs, winner_alias
        )
        VALUES (
          ${r.id}, ${REGULAR_SEASON}, 'regular', NULL, NULL, ${r.date},
          ${r.homeAbbr}, ${r.awayAbbr}, ${r.homePts}, ${r.awayPts}, ${r.margin}, ${r.marginAbs}, ${r.winner}
        )
        ON CONFLICT (bdl_game_id) DO UPDATE SET
          game_type = EXCLUDED.game_type,
          home_pts = EXCLUDED.home_pts,
          away_pts = EXCLUDED.away_pts,
          margin = EXCLUDED.margin,
          margin_abs = EXCLUDED.margin_abs,
          winner_alias = EXCLUDED.winner_alias
      `;
      return { ok: true };
    } catch (e) {
      return { ok: false, id: r.id, error: e.message };
    }
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(insertOne));
    for (const r of results) {
      if (r.ok) saved++;
      else {
        errors++;
        if (errorLog.length < 5) errorLog.push(`${r.id}: ${r.error}`);
      }
    }
  }

  const byType = await sql`SELECT game_type, COUNT(*) AS total FROM nba_backtest GROUP BY game_type ORDER BY game_type`;

  return {
    status: 'ok',
    gamesFound: allGames.length,
    saved,
    skipped,
    errors,
    errorLog,
    pages,
    byGameType: byType.map(r => ({ type: r.game_type, total: Number(r.total) })),
    nextStep: '?phase=boxscores',
  };
}

// ── PHASE: BOXSCORES — pull box scores by unique date, aggregate team stats ──
async function phaseBoxscores(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;

  // Get unique dates with games still missing team_stats
  const dates = await sql`
    SELECT DISTINCT date FROM nba_backtest
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

        const bdlGameId = bs.id || bs.game_id;
        if (!bdlGameId) continue;

        const updated = await sql`
          UPDATE nba_backtest
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

    await delay(50);
  }

  const remaining = await sql`SELECT COUNT(*) AS n FROM nba_backtest WHERE team_stats IS NULL`;

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

// ── PBP parser — shared helper ──────────────────────────────────────────────
function parsePbpForBacktest(plays, hA, aA) {
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

      if (period === 4) {
        if (team === hA) q4hPts += pts;
        else if (team === aA) q4aPts += pts;
      }

      const margin = hScore - aScore;
      if (margin > hBigLead) hBigLead = margin;
      if (-margin > aBigLead) aBigLead = -margin;

      const isRim = desc.includes('dunk') || desc.includes('layup') || desc.includes('tip');
      const isPaint = isRim || desc.includes('paint') || desc.includes('hook') || desc.includes('floater');
      if (isPaint && pts === 2) {
        if (team === hA) { hPaint += 2; if (isRim) hRimM++; }
        else if (team === aA) { aPaint += 2; if (isRim) aRimM++; }
      }

      if (team === runTeam) { runPts += pts; }
      else { if (runPts >= 6 && runTeam) runs6.push({ team: runTeam }); runTeam = team; runPts = pts; }
    }

    if (desc.includes('miss') && (desc.includes('dunk') || desc.includes('layup') || desc.includes('tip'))) {
      if (team === hA) hRimA++;
      else if (team === aA) aRimA++;
    }
  }
  if (runPts >= 6 && runTeam) runs6.push({ team: runTeam });
  hRimA += hRimM;
  aRimA += aRimM;

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

  return {
    hPaint, aPaint, hRimM, hRimA, aRimM, aRimA,
    hBigLead, aBigLead, hPOT, aPOT,
    q4hPts, q4aPts,
    runs6: { h: hRuns, a: aRuns, total: hRuns + aRuns, detail: runs6 },
    totalPlays: plays.length,
  };
}

// ── PHASE: PBP — pull plays per game, concurrent batches ─────────────────────
async function phasePbp(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;
  const batchSize = parseInt(url.searchParams.get('n') || '200');
  const concurrency = Math.min(parseInt(url.searchParams.get('c') || '8'), 20); // cap at 20

  // Games with team_stats but no pbp_derived
  const games = await sql`
    SELECT bdl_game_id, home_alias, away_alias
    FROM nba_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NULL
    ORDER BY date ASC
    LIMIT ${batchSize}
  `;

  if (games.length === 0) {
    return { status: 'ok', message: 'All games with team_stats have PBP', nextStep: '?phase=compute' };
  }

  let updated = 0, failed = 0;
  const failLog = [];

  // Process game in a single concurrency slot
  async function processGame(g) {
    const { bdl_game_id: gid, home_alias: hA, away_alias: aA } = g;
    try {
      const resp = await bdlFetch(`/nba/v1/plays?game_id=${gid}&per_page=500`);
      const plays = resp?.data || [];

      if (plays.length === 0) {
        await sql`UPDATE nba_backtest SET pbp_available = false WHERE bdl_game_id = ${gid}`;
        return { ok: false, gid, reason: 'no plays' };
      }

      const pbpDerived = parsePbpForBacktest(plays, hA, aA);

      await sql`
        UPDATE nba_backtest
        SET pbp_derived = ${JSON.stringify(pbpDerived)}::jsonb,
            pbp_available = true
        WHERE bdl_game_id = ${gid}
      `;
      return { ok: true, gid };
    } catch (e) {
      return { ok: false, gid, reason: e.message };
    }
  }

  // Run in concurrency-limited batches
  for (let i = 0; i < games.length; i += concurrency) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const slice = games.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(processGame));
    for (const r of results) {
      if (r.ok) updated++;
      else { failed++; if (failLog.length < 10) failLog.push(`${r.gid}: ${r.reason}`); }
    }
  }

  const remaining = await sql`
    SELECT COUNT(*) AS n FROM nba_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NULL
  `;

  return {
    status: 'ok',
    processed: games.length,
    updated,
    failed,
    concurrency,
    failLog,
    remaining: Number(remaining[0].n),
    elapsedMs: Date.now() - startTime,
    nextStep: remaining[0].n > 0 ? `?phase=pbp&n=${batchSize}&c=${concurrency} again` : '?phase=compute',
  };
}

// ── PHASE: COMPUTE — run computeServer + computeConviction on every row ──────
async function phaseCompute(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;
  const CONCURRENCY = 20;

  // Only pick up rows not yet computed — makes it resumable
  const rows = await sql`
    SELECT bdl_game_id, home_alias, away_alias, home_pts, away_pts, winner_alias,
           team_stats, pbp_derived
    FROM nba_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NOT NULL AND indicators IS NULL
  `;

  if (rows.length === 0) {
    return { status: 'ok', message: 'All ready rows are already computed', nextStep: '?phase=report' };
  }

  let computed = 0, errors = 0;

  async function computeOne(row) {
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

      if (!ind) return { ok: false };

      const conv = computeConviction(ind);
      const ctrlWon = row.winner_alias === ind.controlTeam;

      await sql`
        UPDATE nba_backtest
        SET indicators = ${JSON.stringify(ind)}::jsonb,
            conviction = ${JSON.stringify(conv)}::jsonb,
            ctrl_team_won = ${ctrlWon},
            computed_at = NOW()
        WHERE bdl_game_id = ${row.bdl_game_id}
      `;
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const slice = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(computeOne));
    for (const r of results) {
      if (r.ok) computed++;
      else errors++;
    }
  }

  const remaining = await sql`
    SELECT COUNT(*) AS n FROM nba_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NOT NULL AND indicators IS NULL
  `;

  return {
    status: 'ok',
    computed,
    errors,
    total: rows.length,
    remaining: Number(remaining[0].n),
    elapsedMs: Date.now() - startTime,
    nextStep: remaining[0].n > 0 ? '?phase=compute again' : '?phase=report',
  };
}

// ── PHASE: REPORT — stratified accuracy breakdown ────────────────────────────
// Computes the full indicator/tier/pair breakdown for an arbitrary subset of
// rows. Called once per population cut (overall, per game_type, close games).
function analyzeRows(rows, label) {
  if (rows.length === 0) return { label, total: 0, empty: true };

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

  // Per-indicator single-won
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

  // Killer pairs
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

  // Danger combos
  const dangerRows = rows.filter(r => r.conviction?.isDanger);
  const dangerCorrect = dangerRows.filter(r => r.ctrl_team_won).length;
  const dangerReport = {
    count: dangerRows.length,
    correct: dangerCorrect,
    pct: dangerRows.length > 0 ? Math.round(dangerCorrect / dangerRows.length * 1000) / 10 : null,
  };

  return {
    label,
    overall: { correct, total, pct: overallPct },
    by_tier: byTierReport,
    by_indicator_single_won: singlesReport,
    by_killer_pair: pairsReport,
    danger_combos: dangerReport,
  };
}

async function phaseReport(sql) {
  const rows = await sql`
    SELECT bdl_game_id, game_type, playoff_year, playoff_round, date,
           home_alias, away_alias, home_pts, away_pts, margin, margin_abs, winner_alias,
           indicators, conviction, ctrl_team_won
    FROM nba_backtest
    WHERE indicators IS NOT NULL
    ORDER BY date
  `;

  if (rows.length === 0) {
    return { error: 'No computed rows. Run ?phase=compute first.' };
  }

  // Split by game type
  const byType = { regular: [], playoff_2024: [], playoff_2025: [], unknown: [] };
  for (const r of rows) {
    const t = r.game_type || 'unknown';
    if (byType[t]) byType[t].push(r);
    else byType.unknown.push(r);
  }

  // Close games slice (margin_abs ≤ 8)
  const closeAll = rows.filter(r => r.margin_abs != null && r.margin_abs <= 8);
  const closeByType = {
    regular:       closeAll.filter(r => r.game_type === 'regular'),
    playoff_2024:  closeAll.filter(r => r.game_type === 'playoff_2024'),
    playoff_2025:  closeAll.filter(r => r.game_type === 'playoff_2025'),
  };

  // By round (playoffs only)
  const playoffRows = [...byType.playoff_2024, ...byType.playoff_2025];
  const byRound = {};
  for (const r of playoffRows) {
    const rd = r.playoff_round || 'UNK';
    if (!byRound[rd]) byRound[rd] = { correct: 0, total: 0 };
    byRound[rd].total++;
    if (r.ctrl_team_won) byRound[rd].correct++;
  }
  const byRoundReport = {};
  for (const [rd, v] of Object.entries(byRound)) {
    byRoundReport[rd] = { correct: v.correct, total: v.total, pct: Math.round(v.correct / v.total * 1000) / 10 };
  }

  // Wrong games — limit to most interesting: high-tier + close games
  const wrong = rows.filter(r => !r.ctrl_team_won).map(r => ({
    date: r.date,
    game_type: r.game_type,
    matchup: `${r.away_alias}@${r.home_alias}`,
    score: `${r.away_pts}-${r.home_pts}`,
    margin_abs: r.margin_abs,
    ctrl: r.indicators?.controlTeam,
    won: r.winner_alias,
    floor: r.indicators?.score,
    tier: r.conviction?.tier,
    combo: r.conviction?.combo,
    round: r.playoff_round,
    indicators: { I1: r.indicators?.I1, I2: r.indicators?.I2, I3: r.indicators?.I3, I4: r.indicators?.I4, I5: r.indicators?.I5 },
  }));
  // Prioritize: DOMINANT/STRONG wrong calls first, then close games
  wrong.sort((a, b) => {
    const tierRank = { DOMINANT: 0, STRONG: 1, MODEST: 2, CONDITIONAL: 3, 'NO ENTRY': 4 };
    const ta = tierRank[a.tier] ?? 5, tb = tierRank[b.tier] ?? 5;
    if (ta !== tb) return ta - tb;
    return a.margin_abs - b.margin_abs;
  });

  return {
    overall: {
      total: rows.length,
      correct: rows.filter(r => r.ctrl_team_won).length,
      pct: Math.round(rows.filter(r => r.ctrl_team_won).length / rows.length * 1000) / 10,
      baseline_reg_season: '93.4% (171-game console sim)',
    },
    by_game_type: {
      regular:       analyzeRows(byType.regular,       'regular season 2024-25'),
      playoff_2024:  analyzeRows(byType.playoff_2024,  '2024 playoffs'),
      playoff_2025:  analyzeRows(byType.playoff_2025,  '2025 playoffs'),
    },
    close_games_margin_le_8: {
      all:           analyzeRows(closeAll,                  'all close games'),
      regular:       analyzeRows(closeByType.regular,       'close regular season'),
      playoff_2024:  analyzeRows(closeByType.playoff_2024,  'close 2024 playoffs'),
      playoff_2025:  analyzeRows(closeByType.playoff_2025,  'close 2025 playoffs'),
    },
    playoff_by_round: byRoundReport,
    baselines_reg_season_console: {
      DOMINANT: '100% (77 games)',
      STRONG:   '96-99% (I3+I4 99%, I3+I5 96%)',
      MODEST:   '70-80%',
      I4_single_won: '98%',
      'I4+I5_pair': '100%',
    },
    wrong_games_top_20: wrong.slice(0, 20),
    wrong_games_total: wrong.length,
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
      case 'init':              result = await phaseInit(sql); break;
      case 'reset':             result = await phaseReset(sql); break;
      case 'status':            result = await phaseStatus(sql); break;
      case 'diagnose':          result = await phaseDiagnose(sql, url); break;
      case 'retention':         result = await phaseRetention(sql, url); break;
      case 'inventory':         result = await phaseInventory(sql); break;
      case 'collect':           // backward-compat alias for collect_playoffs
      case 'collect_playoffs':  result = await phaseCollectPlayoffs(sql); break;
      case 'collect_regular':   result = await phaseCollectRegular(sql); break;
      case 'boxscores':         result = await phaseBoxscores(sql, url); break;
      case 'pbp':               result = await phasePbp(sql, url); break;
      case 'compute':           result = await phaseCompute(sql, url); break;
      case 'report':            result = await phaseReport(sql); break;
      default:
        result = { error: `Unknown phase: ${phase}. Use init, collect_playoffs, collect_regular, boxscores, pbp, compute, report, status, reset.` };
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
