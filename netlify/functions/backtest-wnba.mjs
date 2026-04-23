// WNBA Backtest — Indicator Validation Against 2025 Season
// BDL-primary (60 calls/s), SR-targeted (1 call/s, cached)
//
// Phases:
//   ?phase=init               — Create wnba_backtest table
//   ?phase=collect            — BDL: pull all 2025 games + team_stats
//   ?phase=sample             — SR: fetch stratified game summaries
//   ?phase=compute            — Run computeServer + computeConviction on SR data
//   ?phase=report             — Overall validation report
//   ?phase=explore            — Raw stat correlation analysis
//   ?phase=collect_pbp        — BDL: fetch PBP for all games (use console auto-runner)
//   ?phase=compute_checkpoints — Reconstruct box scores at 2.5-min checkpoints
//   ?phase=report_cp_journey  — Control stability at checkpoint granularity
//   ?phase=report_cp_graduation — Test MF/minF gates for WNBA graduation
//   ?phase=report_cp_trailing — BUY profile: trailing ctrl team comeback rates
//   ?phase=report_cp_stability — Per-indicator hold rates across checkpoints
//   ?phase=report_cp_close    — Close game filter definitions

import { neon } from '@neondatabase/serverless';

const BDL_BASE = 'https://api.balldontlie.io';
const BDL_KEY = process.env.BDL_API_KEY;
const SR_BASE = 'https://api.sportradar.com/wnba/trial/v8/en/';
const SR_KEY = process.env.SR_WNBA_KEY || process.env.SR_API_KEY; // prefer dedicated WNBA key

// ── WNBA INDICATOR WEIGHTS ───────────────────────────────────────────────────
// I1 Disruption 15%, I2 Perimeter+FT 20%, I3 Shot Quality 30%, I4 Game Control 25%, I5 Momentum 10%
const W = { I1: 0.15, I2: 0.20, I3: 0.30, I4: 0.25, I5: 0.10 };

// ── BDL FETCH ────────────────────────────────────────────────────────────────
async function bdlFetch(path) {
  if (!BDL_KEY) return null;
  const resp = await fetch(`${BDL_BASE}${path}`, { headers: { Authorization: BDL_KEY } });
  if (!resp.ok) { console.log(`BDL ${resp.status}: ${path}`); return null; }
  return resp.json();
}

// ── SR FETCH (rate-limited) ──────────────────────────────────────────────────
async function srFetch(path) {
  if (!SR_KEY) return null;
  const resp = await fetch(`${SR_BASE}${path}?api_key=${SR_KEY}`, { headers: { Accept: 'application/json' } });
  if (!resp.ok) { console.log(`SR ${resp.status}: ${path}`); return null; }
  return resp.json();
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── SR alias → BDL alias mapping ────────────────────────────────────────────
const SR_TO_BDL = {
  NYL: 'NY', WAS: 'WSH', LVA: 'LV', CON: 'CON',
  ATL: 'ATL', IND: 'IND', CHI: 'CHI', MIN: 'MIN',
  PHX: 'PHX', SEA: 'SEA', DAL: 'DAL', LAS: 'LA',
  PDX: 'POR', TOY: 'TOR', GSV: 'GS',
};
function bdlAlias(srAlias) { return SR_TO_BDL[srAlias] || srAlias; }

// ── computeServer — WNBA-specific indicators ────────────────────────────────
// Designed from 126-game explore analysis on stratified 2025 sample.
// Key diff from NBA: shot quality is anchor (not paint), turnovers inverse, paint is noise.
function computeServer(summary) {
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hA = H.alias || H.name || 'HOME', aA = A.alias || A.name || 'AWAY';
  const hS = H.points || 0, aS = A.points || 0;
  if (hS === 0 && aS === 0) return null;

  // I1 — Disruption & Conversion (15%)
  // Sub-A: disruption combined steals+blocks (±2)
  const hDisrupt = (hs.steals || 0) + (hs.blocks || 0);
  const aDisrupt = (as.steals || 0) + (as.blocks || 0);
  const disruptDiff = hDisrupt - aDisrupt;
  const i1subA = disruptDiff > 2 ? 1 : disruptDiff < -2 ? -1 : 0;
  // Sub-B: POT diff (±3)
  const hPOT = hs.points_off_turnovers || 0, aPOT = as.points_off_turnovers || 0;
  const potDiff = hPOT - aPOT;
  const i1subB = potDiff > 3 ? 1 : potDiff < -3 ? -1 : 0;
  const i1raw = i1subA + i1subB;
  const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? hA : i1raw < 0 ? aA : 'EVEN',
    detail: { disruptDiff, potDiff } };

  // I2 — Perimeter & FT Access (20%)
  // Sub-A: 3PT% diff (±3%)
  const h3Pct = hs.three_points_pct || 0, a3Pct = as.three_points_pct || 0;
  const threePctDiff = h3Pct - a3Pct;
  const i2subA = threePctDiff > 3 ? 1 : threePctDiff < -3 ? -1 : 0;
  // Sub-B: FTA diff (±2)
  const hFTA = hs.free_throws_att || 0, aFTA = as.free_throws_att || 0;
  const ftaDiff = hFTA - aFTA;
  const i2subB = ftaDiff > 2 ? 1 : ftaDiff < -2 ? -1 : 0;
  const i2raw = i2subA + i2subB;
  const I2 = { score: i2raw > 0 ? 1 : i2raw === 0 ? 0.5 : 0, leader: i2raw > 0 ? hA : i2raw < 0 ? aA : 'EVEN',
    detail: { threePctDiff: Math.round(threePctDiff * 10) / 10, ftaDiff } };

  // I3 — Shot Quality (30% — WNBA anchor)
  // Sub-A: eFG diff (±0.03)
  const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
  const hEFG = ((hs.field_goals_made || 0) + 0.5 * (hs.three_points_made || 0)) / hFGA;
  const aEFG = ((as.field_goals_made || 0) + 0.5 * (as.three_points_made || 0)) / aFGA;
  const efgDiff = hEFG - aEFG;
  const i3subA = efgDiff > 0.03 ? 1 : efgDiff < -0.03 ? -1 : 0;
  // Sub-B: assists diff (±2)
  const hAst = hs.assists || 0, aAst = as.assists || 0;
  const astDiff = hAst - aAst;
  const i3subB = astDiff > 2 ? 1 : astDiff < -2 ? -1 : 0;
  const i3raw = i3subA + i3subB;
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? hA : i3raw < 0 ? aA : 'EVEN',
    detail: { efgDiff: Math.round(efgDiff * 1000) / 1000, astDiff } };

  // I4 — Game Control (25%)
  // Sub-A: biggest_lead diff (±4)
  const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
  const bigLeadDiff = hBigLead - aBigLead;
  const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
  // Sub-B: last Q scoring diff (±2)
  let i4subB = 0;
  const hScoring = H.scoring || [];
  const aScoring = A.scoring || [];
  if (hScoring.length >= 4) {
    const lastQ = hScoring.length;
    const lastQDiff = (hScoring[lastQ - 1]?.points || 0) - (aScoring[lastQ - 1]?.points || 0);
    i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
  }
  const i4raw = i4subA + i4subB;
  const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? hA : i4raw < 0 ? aA : 'EVEN',
    detail: { bigLeadDiff, i4subB } };

  // I5 — Momentum (10%)
  // Sub-A: fastbreak pts diff (±3)
  const hFB = hs.fast_break_pts || 0, aFB = as.fast_break_pts || 0;
  const fbDiff = hFB - aFB;
  const i5subA = fbDiff > 3 ? 1 : fbDiff < -3 ? -1 : 0;
  // Sub-B: total rebounds diff (±3)
  const hReb = (hs.offensive_rebounds || 0) + (hs.defensive_rebounds || 0);
  const aReb = (as.offensive_rebounds || 0) + (as.defensive_rebounds || 0);
  const rebDiff = hReb - aReb;
  const i5subB = rebDiff > 3 ? 1 : rebDiff < -3 ? -1 : 0;
  const i5raw = i5subA + i5subB;
  const I5 = { score: i5raw > 0 ? 1 : i5raw === 0 ? 0.5 : 0, leader: i5raw > 0 ? hA : i5raw < 0 ? aA : 'EVEN',
    detail: { fbDiff, rebDiff } };

  // Composite
  const raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  const controlHome = raw >= 0.5;
  const controlTeam = controlHome ? hA : aA;
  const score = controlHome ? raw : 1 - raw;

  return {
    controlTeam,
    score: Math.round(score * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA, awayAlias: aA,
    homePts: hS, awayPts: aS,
  };
}

// ── computeConviction — WNBA combo patterns ────────────────────────────────
// I3 = shot quality anchor, I4 = game control. Killer pairs: I3+I4, I3+I2, I4+I2.
function computeConviction(ind) {
  if (!ind || ind.score == null) return { tier: 'NO ENTRY', combo: 'NONE', indicatorsWon: [], indicatorsLost: [], count: 0, pairs: [] };
  const ctrlHome = ind.controlTeam === ind.homeAlias;
  const wins = [], loses = [], even = [];
  for (const [key, val] of [['I1', ind.I1], ['I2', ind.I2], ['I3', ind.I3], ['I4', ind.I4], ['I5', ind.I5]]) {
    if (!val || val.score == null) { even.push(key); continue; }
    const ctrlScore = ctrlHome ? val.score : 1 - val.score;
    if (ctrlScore > 0.5) wins.push(key);
    else if (ctrlScore < 0.5) loses.push(key);
    else even.push(key);
  }
  const count = wins.length;
  const has = (a, b) => wins.includes(a) && wins.includes(b);
  const combo = count > 0 ? wins.join('+') : 'NONE';
  const hasI3I4 = has('I3', 'I4');
  const hasI3I2 = has('I3', 'I2');
  const hasI4I2 = has('I4', 'I2');
  const hasKillerPair = hasI3I4 || hasI3I2 || hasI4I2;
  const isDanger = (
    (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4'))
  );
  let tier;
  if (count >= 4 || (hasI3I4 && count >= 3)) tier = 'DOMINANT';
  else if (hasKillerPair) tier = 'STRONG';
  else if (count >= 2 && !isDanger) tier = 'MODEST';
  else if (count >= 1) tier = 'CONDITIONAL';
  else tier = 'NO ENTRY';
  const pairs = [];
  if (hasI3I4) pairs.push('I3+I4');
  if (hasI3I2) pairs.push('I3+I2');
  if (hasI4I2) pairs.push('I4+I2');
  return { tier, combo, count, indicatorsWon: wins, indicatorsLost: loses, indicatorsEven: even, pairs, isDanger };
}

// ── PHASE HANDLERS ───────────────────────────────────────────────────────────

async function phaseInit(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS wnba_backtest (
      game_id TEXT PRIMARY KEY,
      bdl_game_id INTEGER,
      sr_game_id TEXT,
      date TEXT,
      home_alias TEXT,
      away_alias TEXT,
      home_score INTEGER,
      away_score INTEGER,
      winner TEXT,
      margin INTEGER,
      margin_bucket TEXT,
      bdl_home_stats JSONB,
      bdl_away_stats JSONB,
      sr_summary JSONB,
      indicators JSONB,
      conviction_tier TEXT,
      conviction_combo TEXT,
      conviction_detail JSONB,
      ctrl_team_won BOOLEAN,
      computed_at TIMESTAMPTZ
    )
  `;
  return { status: 'ok', message: 'wnba_backtest table created' };
}

async function phaseReset(sql) {
  const before = await sql`SELECT COUNT(*) as total, COUNT(sr_summary) as with_sr FROM wnba_backtest`;
  await sql`
    UPDATE wnba_backtest SET
      sr_summary = ${null}, sr_game_id = ${null},
      indicators = ${null}, conviction_tier = ${null}, conviction_combo = ${null},
      conviction_detail = ${null}, ctrl_team_won = ${null}, computed_at = ${null}
  `;
  const after = await sql`SELECT COUNT(*) as total, COUNT(sr_summary) as with_sr, COUNT(CASE WHEN sr_summary IS NULL THEN 1 END) as null_sr FROM wnba_backtest`;
  return {
    status: 'ok',
    message: 'SR summaries + computed indicators cleared. BDL game data preserved.',
    gamesKept: Number(before[0]?.total || 0),
    srCleared: Number(before[0]?.with_sr || 0),
    afterReset: { total: Number(after[0].total), withSR: Number(after[0].with_sr), nullSR: Number(after[0].null_sr) },
    nextStep: 'Run ?phase=sample&n=40 to start fresh SR collection',
  };
}

async function phaseStatus(sql) {
  const counts = await sql`
    SELECT 
      COUNT(*) as total,
      COUNT(sr_summary) as with_sr,
      COUNT(indicators) as computed,
      COUNT(CASE WHEN sr_summary IS NULL THEN 1 END) as needs_sr
    FROM wnba_backtest
  `;
  const buckets = await sql`
    SELECT margin_bucket, COUNT(*) as total, COUNT(sr_summary) as with_sr 
    FROM wnba_backtest GROUP BY margin_bucket ORDER BY total DESC
  `;
  return {
    total: Number(counts[0].total),
    withSR: Number(counts[0].with_sr),
    computed: Number(counts[0].computed),
    needsSR: Number(counts[0].needs_sr),
    buckets: buckets.map(r => ({ bucket: r.margin_bucket, total: Number(r.total), withSR: Number(r.with_sr) })),
  };
}

async function phaseDiagnose(sql, url) {
  const startTime = Date.now();
  const checkLimit = parseInt(url?.searchParams?.get('n') || '10');
  
  // 1. Get all distinct BDL team abbreviations from the DB
  const bdlTeams = await sql`
    SELECT DISTINCT abbr FROM (
      SELECT home_alias as abbr FROM wnba_backtest
      UNION
      SELECT away_alias as abbr FROM wnba_backtest
    ) t ORDER BY abbr
  `;
  const bdlAbbrs = bdlTeams.map(r => r.abbr);

  // 2. Show reverse lookup — for each BDL abbr, which SR alias maps to it?
  const reverseMap = {};
  for (const [sr, bdl] of Object.entries(SR_TO_BDL)) {
    if (!reverseMap[bdl]) reverseMap[bdl] = [];
    reverseMap[bdl].push(sr);
  }
  const coverage = bdlAbbrs.map(a => ({
    bdlAbbr: a,
    srMapsFrom: reverseMap[a] || ['(identity — no mapping needed, or MISSING)'],
    inMap: !!reverseMap[a] || Object.values(SR_TO_BDL).includes(a),
  }));

  // 3. Try matching ALL unmatched games — schedule calls only, no summaries
  const unmatched = await sql`
    SELECT game_id, date, home_alias, away_alias, margin_bucket
    FROM wnba_backtest WHERE sr_summary IS NULL
    ORDER BY date
    LIMIT ${checkLimit}
  `;

  const schedCache = {};
  async function getSchedule(dateStr) {
    if (schedCache[dateStr] !== undefined) return schedCache[dateStr];
    const [y, m, d] = dateStr.split('-');
    const resp = await srFetch(`games/${y}/${m}/${d}/schedule.json`);
    await delay(1200);
    schedCache[dateStr] = resp?.games || [];
    return schedCache[dateStr];
  }
  function offsetDate(dateStr, offset) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  function findMatch(srGames, bdlHome, bdlAway) {
    return srGames.find(sg => {
      const srHome = sg.home?.alias, srAway = sg.away?.alias;
      if (bdlAlias(srHome) === bdlHome && bdlAlias(srAway) === bdlAway) return true;
      if (srHome === bdlHome && srAway === bdlAway) return true;
      return false;
    });
  }

  const failures = [];
  let matched = 0;
  const TIME_BUDGET = 90000;

  for (const g of unmatched) {
    if (Date.now() - startTime > TIME_BUDGET) break;
    
    let found = false;
    for (const offset of [0, 1, -1]) {
      const tryDate = offsetDate(g.date, offset);
      const srGames = await getSchedule(tryDate);
      if (findMatch(srGames, g.home_alias, g.away_alias)) {
        found = true;
        matched++;
        break;
      }
    }

    if (!found) {
      const dates = [0, 1, -1].map(o => offsetDate(g.date, o));
      const allSR = dates.flatMap(d => (schedCache[d] || []).map(sg => `${sg.away?.alias}@${sg.home?.alias}`));
      // Dedupe
      const uniqueSR = [...new Set(allSR)];
      failures.push({
        bdlGame: `${g.away_alias}@${g.home_alias}`,
        bdlDate: g.date,
        bucket: g.margin_bucket,
        searchedDates: dates,
        srGamesFound: uniqueSR,
      });
    }
  }

  // 4. Analyze failure patterns
  const failedTeams = {};
  for (const f of failures) {
    const teams = f.bdlGame.split('@');
    for (const t of teams) {
      if (!failedTeams[t]) failedTeams[t] = 0;
      failedTeams[t]++;
    }
  }

  return {
    bdlTeams: bdlAbbrs,
    aliasCoverage: coverage,
    gamesChecked: Math.min(unmatched.length, matched + failures.length),
    matched,
    failed: failures.length,
    failedTeams: Object.entries(failedTeams).sort((a,b) => b[1]-a[1]).map(([t,c]) => `${t}: ${c} failures`),
    failures: failures.slice(0, 30),
    elapsed: `${Math.round((Date.now() - startTime) / 1000)}s`,
    scheduleDatesCached: Object.keys(schedCache).length,
  };
}

async function phaseCollect(sql) {
  // Pull all 2025 WNBA games from BDL, paginate
  // This ONLY saves game metadata — no per-game stats calls (those come from SR in sample phase)
  const allGames = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 30;

  while (pages < MAX_PAGES) {
    let path = `/wnba/v1/games?seasons[]=2025&per_page=100`;
    if (cursor) path += `&cursor=${cursor}`;
    const resp = await bdlFetch(path);
    if (!resp?.data || resp.data.length === 0) break;
    
    for (const g of resp.data) {
      if (g.status !== 'post' && g.status !== 'Final') continue;
      allGames.push(g);
    }
    
    cursor = resp.meta?.next_cursor;
    pages++;
    if (!cursor) break;
  }

  console.log(`BDL: fetched ${allGames.length} completed 2025 games (${pages} pages)`);

  // Save game metadata to DB (no stats calls — fast)
  let saved = 0, errors = 0;
  for (const g of allGames) {
    try {
      const homeAbbr = g.home_team?.abbreviation || '';
      const awayAbbr = g.visitor_team?.abbreviation || '';
      const winner = g.home_score > g.away_score ? homeAbbr : awayAbbr;
      const margin = Math.abs(g.home_score - g.away_score);
      const bucket = margin >= 15 ? 'blowout' : margin >= 8 ? 'comfortable' : margin >= 1 ? 'close' : 'tie';

      await sql`
        INSERT INTO wnba_backtest (game_id, bdl_game_id, date, home_alias, away_alias, home_score, away_score, winner, margin, margin_bucket)
        VALUES (${`bdl_${g.id}`}, ${g.id}, ${g.date?.substring(0, 10)}, ${homeAbbr}, ${awayAbbr}, ${g.home_score}, ${g.away_score}, ${winner}, ${margin}, ${bucket})
        ON CONFLICT (game_id) DO UPDATE SET
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          winner = EXCLUDED.winner,
          margin = EXCLUDED.margin,
          margin_bucket = EXCLUDED.margin_bucket
      `;
      saved++;
    } catch (e) {
      console.log(`Error saving game ${g.id}: ${e.message}`);
      errors++;
    }
  }

  const buckets = await sql`
    SELECT margin_bucket, COUNT(*) as count FROM wnba_backtest GROUP BY margin_bucket ORDER BY count DESC
  `;

  return {
    status: 'ok',
    gamesFound: allGames.length,
    saved,
    errors,
    buckets: buckets.map(r => ({ bucket: r.margin_bucket, count: Number(r.count) })),
    nextStep: 'Run ?phase=sample to fetch SR summaries for a stratified sample',
  };
}

async function phaseSample(sql, url) {
  const sampleSize = parseInt(url.searchParams.get('n') || '25');
  const stratify = url.searchParams.get('stratify') !== '0';
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000; // 100s of 120s timeout — leave margin

  let sampleGames;
  if (stratify) {
    // Stratified sample: oversample close games
    sampleGames = await sql`
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY margin_bucket ORDER BY RANDOM()) as rn,
               COUNT(*) OVER (PARTITION BY margin_bucket) as bucket_total
        FROM wnba_backtest
        WHERE sr_summary IS NULL
      )
      SELECT * FROM ranked
      WHERE (margin_bucket = 'close' AND rn <= ${Math.ceil(sampleSize * 0.5)})
         OR (margin_bucket = 'comfortable' AND rn <= ${Math.ceil(sampleSize * 0.3)})
         OR (margin_bucket = 'blowout' AND rn <= ${Math.ceil(sampleSize * 0.2)})
      ORDER BY margin_bucket, rn
      LIMIT ${sampleSize}
    `;
  } else {
    // Random sample — natural distribution
    sampleGames = await sql`
      SELECT * FROM wnba_backtest
      WHERE sr_summary IS NULL
      ORDER BY RANDOM()
      LIMIT ${sampleSize}
    `;
  }

  console.log(`Sample: ${sampleGames.length} games selected for SR fetch`);

  if (sampleGames.length === 0) {
    const total = await sql`SELECT COUNT(*) as count FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
    return { status: 'ok', message: 'No more games to sample — all have SR data', totalWithSR: Number(total[0].count) };
  }

  let fetched = 0, errors = 0, skippedTimeout = 0;
  const errorDetails = [];
  const schedCache = {}; // date string → SR games array

  // Helper: fetch SR schedule with caching
  async function getSchedule(dateStr) {
    if (schedCache[dateStr] !== undefined) return schedCache[dateStr];
    const [y, m, d] = dateStr.split('-');
    const resp = await srFetch(`games/${y}/${m}/${d}/schedule.json`);
    await delay(1200);
    schedCache[dateStr] = resp?.games || [];
    return schedCache[dateStr];
  }

  // Helper: get date ± offset as YYYY-MM-DD
  function offsetDate(dateStr, offset) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }

  // Helper: try to find an SR game matching BDL aliases
  function findSRMatch(srGames, bdlHome, bdlAway) {
    return srGames.find(sg => {
      const srHome = sg.home?.alias;
      const srAway = sg.away?.alias;
      if (bdlAlias(srHome) === bdlHome && bdlAlias(srAway) === bdlAway) return true;
      if (srHome === bdlHome && srAway === bdlAway) return true;
      return false;
    });
  }

  // Process each game individually with date±1 fallback
  for (const g of sampleGames) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      skippedTimeout++;
      continue;
    }

    const bdlDate = g.date;
    let srGame = null;
    let matchedDate = null;

    // Try date, date+1, date-1
    for (const offset of [0, 1, -1]) {
      const tryDate = offsetDate(bdlDate, offset);
      const srGames = await getSchedule(tryDate);
      const match = findSRMatch(srGames, g.home_alias, g.away_alias);
      if (match) {
        srGame = match;
        matchedDate = tryDate;
        break;
      }
    }

    if (!srGame) {
      // Show what we found across all 3 dates for debugging
      const dates = [0, 1, -1].map(o => offsetDate(bdlDate, o));
      const allAvailable = dates.flatMap(d => (schedCache[d] || []).map(sg => `${sg.away?.alias}@${sg.home?.alias} (${d})`));
      errorDetails.push({
        bdlDate,
        reason: 'no_match_across_3_dates',
        bdlGame: `${g.away_alias}@${g.home_alias}`,
        searchedDates: dates,
        srAvailable: allAvailable.slice(0, 15),
      });
      errors++;
      continue;
    }

    if (srGame.status !== 'closed') {
      errors++;
      continue;
    }

    // Fetch game summary
    const summaryResp = await srFetch(`games/${srGame.id}/summary.json`);
    await delay(1200);

    if (!summaryResp) {
      console.log(`SR summary failed for ${srGame.id}`);
      errors++;
      continue;
    }

    // Save SR summary + game ID
    await sql`
      UPDATE wnba_backtest
      SET sr_summary = ${JSON.stringify(summaryResp)},
          sr_game_id = ${srGame.id}
      WHERE game_id = ${g.game_id}
    `;
    fetched++;
    console.log(`✓ ${g.away_alias}@${g.home_alias} (${bdlDate}→${matchedDate}) — SR ${srGame.id}`);
  }

  const ready = await sql`SELECT COUNT(*) as count FROM wnba_backtest WHERE sr_summary IS NOT NULL`;

  return {
    status: 'ok',
    attempted: sampleGames.length,
    fetched,
    errors,
    skippedTimeout,
    totalWithSR: Number(ready[0].count),
    uniqueDates: Object.keys(schedCache).length,
    srCallsMade: fetched + Object.keys(schedCache).length,
    elapsed: `${Math.round((Date.now() - startTime) / 1000)}s`,
    errorDetails: errorDetails.slice(0, 20),
    note: skippedTimeout > 0 ? 'Re-run ?phase=sample to continue fetching (idempotent — only fetches games missing SR data)' : 'All selected games fetched',
    nextStep: 'Run ?phase=compute to calculate indicators',
  };
}

async function phaseCompute(sql) {
  // Load all games with SR summaries
  const games = await sql`
    SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL
  `;

  console.log(`Computing indicators for ${games.length} games`);

  let computed = 0, errors = 0;
  const results = [];

  for (const g of games) {
    try {
      const summary = g.sr_summary;
      const ind = computeServer(summary);
      if (!ind) { errors++; continue; }

      const conviction = computeConviction(ind);
      const ctrlTeamWon = bdlAlias(ind.controlTeam) === g.winner || ind.controlTeam === g.winner;

      await sql`
        UPDATE wnba_backtest SET
          indicators = ${JSON.stringify(ind)},
          conviction_tier = ${conviction.tier},
          conviction_combo = ${conviction.combo},
          conviction_detail = ${JSON.stringify(conviction)},
          ctrl_team_won = ${ctrlTeamWon},
          computed_at = NOW()
        WHERE game_id = ${g.game_id}
      `;

      results.push({
        matchup: `${g.away_alias}@${g.home_alias}`,
        margin: g.margin,
        bucket: g.margin_bucket,
        controlTeam: ind.controlTeam,
        winner: g.winner,
        ctrlWon: ctrlTeamWon,
        floor: ind.score,
        tier: conviction.tier,
        combo: conviction.combo,
        I1: ind.I1.score, I2: ind.I2.score, I3: ind.I3.score, I4: ind.I4.score, I5: ind.I5.score,
        I5source: ind.I5.source || 'default',
      });

      computed++;
    } catch (e) {
      console.log(`Compute error ${g.game_id}: ${e.message}`);
      errors++;
    }
  }

  return { status: 'ok', computed, errors, results };
}

async function phaseReport(sql) {
  const games = await sql`
    SELECT * FROM wnba_backtest 
    WHERE indicators IS NOT NULL AND conviction_tier IS NOT NULL
  `;

  if (games.length === 0) {
    return { status: 'error', message: 'No computed games. Run ?phase=compute first.' };
  }

  // ── Overall accuracy ──
  const total = games.length;
  const ctrlWins = games.filter(g => g.ctrl_team_won).length;

  // ── Per-indicator win correlation ──
  function indicatorCorrelation(indicatorKey) {
    let winnerHad = 0, loserHad = 0, ties = 0;
    const winnerScores = [], loserScores = [];
    for (const g of games) {
      const ind = g.indicators;
      if (!ind) continue;
      const ctrlHome = ind.controlTeam === ind.homeAlias;
      const iVal = ind[indicatorKey];
      if (!iVal) continue;
      const ctrlScore = ctrlHome ? iVal.score : 1 - iVal.score;

      // Map to winner perspective
      const winnerIsCtrl = g.ctrl_team_won;
      const winnerScore = winnerIsCtrl ? ctrlScore : 1 - ctrlScore;
      const loserScore = 1 - winnerScore;

      winnerScores.push(winnerScore);
      loserScores.push(loserScore);
      if (winnerScore > 0.5) winnerHad++;
      else if (winnerScore < 0.5) loserHad++;
      else ties++;
    }

    const avg = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    return {
      winnerWonIndicator: winnerHad,
      winnerLostIndicator: loserHad,
      even: ties,
      winCorrelation: total > 0 ? Math.round(winnerHad / total * 1000) / 1000 : 0,
      avgWinnerScore: Math.round(avg(winnerScores) * 100) / 100,
      avgLoserScore: Math.round(avg(loserScores) * 100) / 100,
    };
  }

  const indicators = {};
  for (const key of ['I1', 'I2', 'I3', 'I4', 'I5']) {
    indicators[key] = indicatorCorrelation(key);
  }

  // ── Conviction tier accuracy ──
  const tiers = {};
  for (const g of games) {
    const t = g.conviction_tier;
    if (!tiers[t]) tiers[t] = { games: 0, wins: 0 };
    tiers[t].games++;
    if (g.ctrl_team_won) tiers[t].wins++;
  }
  const convictionAccuracy = {};
  for (const [tier, data] of Object.entries(tiers)) {
    convictionAccuracy[tier] = {
      games: data.games,
      wins: data.wins,
      pct: Math.round(data.wins / data.games * 1000) / 10,
    };
  }

  // ── Combo pattern accuracy ──
  const combos = {};
  for (const g of games) {
    const detail = g.conviction_detail;
    if (!detail?.indicatorsWon) continue;
    const won = detail.indicatorsWon;

    // Check specific pairs
    const pairChecks = [
      ['I4+I5', won.includes('I4') && won.includes('I5')],
      ['I3+I4', won.includes('I3') && won.includes('I4')],
      ['I3+I5', won.includes('I3') && won.includes('I5')],
      ['I1+I5', won.includes('I1') && won.includes('I5') && !won.includes('I3') && !won.includes('I4')],
      ['I1+I2+I5', won.includes('I1') && won.includes('I2') && won.includes('I5') && !won.includes('I3') && !won.includes('I4')],
    ];

    for (const [pairName, matches] of pairChecks) {
      if (!matches) continue;
      if (!combos[pairName]) combos[pairName] = { games: 0, wins: 0 };
      combos[pairName].games++;
      if (g.ctrl_team_won) combos[pairName].wins++;
    }
  }

  const comboPatterns = {};
  for (const [name, data] of Object.entries(combos)) {
    comboPatterns[name] = {
      games: data.games,
      wins: data.wins,
      pct: Math.round(data.wins / data.games * 1000) / 10,
    };
  }

  // ── By margin bucket ──
  const bucketAccuracy = {};
  for (const g of games) {
    const b = g.margin_bucket;
    if (!bucketAccuracy[b]) bucketAccuracy[b] = { games: 0, wins: 0 };
    bucketAccuracy[b].games++;
    if (g.ctrl_team_won) bucketAccuracy[b].wins++;
  }
  for (const [b, data] of Object.entries(bucketAccuracy)) {
    data.pct = Math.round(data.wins / data.games * 1000) / 10;
  }

  // ── Generate recommendations ──
  const recs = [];
  if (indicators.I4.winCorrelation >= 0.90) {
    recs.push(`I4 win correlation ${indicators.I4.winCorrelation} — consistent with NBA. Keep weight at 30%.`);
  } else if (indicators.I4.winCorrelation < 0.80) {
    recs.push(`⚠️ I4 win correlation ${indicators.I4.winCorrelation} — significantly lower than NBA (0.98). Investigate biggest_lead reliability in WNBA.`);
  }

  if (indicators.I5.winCorrelation < 0.60) {
    recs.push(`⚠️ I5 win correlation ${indicators.I5.winCorrelation} — low. Using net rating proxy instead of PBP runs. Consider adding BDL PBP runs for full validation.`);
  }

  if (comboPatterns['I4+I5'] && comboPatterns['I4+I5'].pct < 90) {
    recs.push(`⚠️ I4+I5 combo at ${comboPatterns['I4+I5'].pct}% — below NBA's 100%. DOMINANT conviction may need higher threshold for WNBA.`);
  }

  if (convictionAccuracy['DOMINANT']?.pct < 90) {
    recs.push(`⚠️ DOMINANT tier at ${convictionAccuracy['DOMINANT']?.pct}% — investigate which games failed.`);
  }

  const nbaComparison = {
    note: 'NBA reference values (171-game validation)',
    I4_winCorr: 0.98, I3_winCorr: 0.85, I1_winCorr: 0.72,
    DOMINANT_pct: 100, STRONG_pct: 97, MODEST_pct: 75,
    'I4+I5_pct': 100, 'I3+I4_pct': 99, 'I3+I5_pct': 96,
    'I1+I5_pct': 50, 'I1+I2+I5_pct': 40,
  };

  return {
    gamesAnalyzed: total,
    overallAccuracy: { controlTeamWins: ctrlWins, total, pct: Math.round(ctrlWins / total * 1000) / 10 },
    indicators,
    convictionAccuracy,
    comboPatterns,
    bucketAccuracy,
    recommendations: recs,
    nbaComparison,
    i5Note: 'I5 uses net rating proxy (offensive_rating - defensive_rating) instead of PBP run share. Add BDL PBP phase for full I5 validation.',
  };
}

// ── EXPLORE PHASE — Raw stat correlation analysis ────────────────────────────
// Instead of testing NBA indicators, find what ACTUALLY predicts WNBA wins
async function phaseExplore(sql) {
  const games = await sql`
    SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL
  `;

  if (games.length < 20) {
    return { status: 'error', message: `Only ${games.length} games with SR data. Run ?phase=sample more times to get 50+.` };
  }

  // Define raw stat differentials to test (positive = home advantage)
  const statDefs = [
    // Disruption & transition
    { key: 'steals_diff', extract: (hs, as) => (hs.steals || 0) - (as.steals || 0) },
    { key: 'blocks_diff', extract: (hs, as) => (hs.blocks || 0) - (as.blocks || 0) },
    { key: 'disruption_combined', extract: (hs, as) => ((hs.steals||0)+(hs.blocks||0)) - ((as.steals||0)+(as.blocks||0)) },
    { key: 'turnovers_diff', extract: (hs, as) => (hs.total_turnovers || 0) - (as.total_turnovers || 0) },
    { key: 'pot_diff', extract: (hs, as) => (hs.points_off_turnovers || 0) - (as.points_off_turnovers || 0) },
    { key: 'oreb_diff', extract: (hs, as) => (hs.offensive_rebounds || 0) - (as.offensive_rebounds || 0) },
    { key: 'fastbreak_diff', extract: (hs, as) => (hs.fast_break_pts || 0) - (as.fast_break_pts || 0) },
    { key: 'second_chance_diff', extract: (hs, as) => (hs.second_chance_pts || 0) - (as.second_chance_pts || 0) },
    // Interior
    { key: 'paint_diff', extract: (hs, as) => (hs.points_in_the_paint || hs.points_in_paint || 0) - (as.points_in_the_paint || as.points_in_paint || 0) },
    { key: 'fta_diff', extract: (hs, as) => (hs.free_throws_att || 0) - (as.free_throws_att || 0) },
    { key: 'rim_made_diff', extract: (hs, as) => (hs.field_goals_at_rim_made || 0) - (as.field_goals_at_rim_made || 0) },
    { key: 'fouls_drawn_diff', extract: (hs, as) => (hs.fouls_drawn || 0) - (as.fouls_drawn || 0) },
    { key: 'pf_diff', extract: (hs, as) => (hs.personal_fouls || 0) - (as.personal_fouls || 0) },
    // Shot quality
    { key: 'efg_diff', extract: (hs, as) => {
      const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
      return ((hs.field_goals_made||0)+0.5*(hs.three_points_made||0))/hFGA - ((as.field_goals_made||0)+0.5*(as.three_points_made||0))/aFGA;
    }},
    { key: 'ast_diff', extract: (hs, as) => (hs.assists || 0) - (as.assists || 0) },
    { key: 'ast_ratio_diff', extract: (hs, as) => {
      return (hs.assists||0) / (hs.field_goals_made||1) * 100 - (as.assists||0) / (as.field_goals_made||1) * 100;
    }},
    { key: 'fg_pct_diff', extract: (hs, as) => (hs.field_goals_pct || 0) - (as.field_goals_pct || 0) },
    { key: 'three_pct_diff', extract: (hs, as) => (hs.three_points_pct || 0) - (as.three_points_pct || 0) },
    { key: 'three_made_diff', extract: (hs, as) => (hs.three_points_made || 0) - (as.three_points_made || 0) },
    { key: 'ts_pct_diff', extract: (hs, as) => (hs.true_shooting_pct || 0) - (as.true_shooting_pct || 0) },
    // Game control
    { key: 'biggest_lead_diff', extract: (hs, as) => (hs.biggest_lead || 0) - (as.biggest_lead || 0) },
    { key: 'bench_pts_diff', extract: (hs, as) => (hs.bench_points || 0) - (as.bench_points || 0) },
    { key: 'last_q_scoring_diff', extract: (hs, as, g) => {
      const hS = g.sr_summary?.home?.scoring || [];
      const aS = g.sr_summary?.away?.scoring || [];
      if (hS.length < 4) return null;
      return (hS[hS.length-1]?.points || 0) - (aS[aS.length-1]?.points || 0);
    }},
    // Tempo & efficiency (CAUTION: outcome-correlated for completed games)
    { key: 'off_rating_diff_OUTCOME', extract: (hs, as) => (hs.offensive_rating || hs.offensive_points_per_possession || 0) - (as.offensive_rating || as.offensive_points_per_possession || 0) },
    { key: 'net_rating_diff_OUTCOME', extract: (hs, as) => {
      const hNet = (hs.offensive_rating||hs.offensive_points_per_possession||0) - (hs.defensive_rating||hs.defensive_points_per_possession||0);
      const aNet = (as.offensive_rating||as.offensive_points_per_possession||0) - (as.defensive_rating||as.defensive_points_per_possession||0);
      return hNet - aNet;
    }},
    // Composite / other
    { key: 'total_reb_diff', extract: (hs, as) => ((hs.defensive_rebounds||0)+(hs.offensive_rebounds||0)) - ((as.defensive_rebounds||0)+(as.offensive_rebounds||0)) },
    { key: 'ast_to_ratio_diff', extract: (hs, as) => (hs.assists_turnover_ratio || 0) - (as.assists_turnover_ratio || 0) },
    { key: 'most_unanswered_diff', extract: (hs, as) => (hs.most_unanswered || 0) - (as.most_unanswered || 0) },
  ];

  // Process all games
  const statData = {};
  for (const sd of statDefs) statData[sd.key] = [];

  let processed = 0;
  for (const g of games) {
    const summary = g.sr_summary;
    if (!summary?.home?.statistics || !summary?.away?.statistics) continue;
    const hs = summary.home.statistics;
    const as = summary.away.statistics;
    const homeWon = g.home_score > g.away_score;

    for (const sd of statDefs) {
      try {
        const val = sd.extract(hs, as, g);
        if (val == null || isNaN(val)) continue;
        // Store winner-relative: positive = winner had more
        const winnerRelative = homeWon ? val : -val;
        statData[sd.key].push({ raw: val, winnerRel: winnerRelative, homeWon });
      } catch (e) { /* skip */ }
    }
    processed++;
  }

  // Compute predictiveness for each stat
  const avg = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const rankings = [];

  for (const [key, entries] of Object.entries(statData)) {
    if (entries.length < 20) continue;

    let correctDir = 0, wrongDir = 0, neutral = 0;
    const winnerVals = [], loserVals = [];

    for (const e of entries) {
      if (e.winnerRel > 0) correctDir++;
      else if (e.winnerRel < 0) wrongDir++;
      else neutral++;
      winnerVals.push(e.winnerRel);
    }

    const decidedGames = correctDir + wrongDir;
    const directionalPct = decidedGames > 0 ? Math.round(correctDir / decidedGames * 1000) / 10 : 50;

    rankings.push({
      stat: key,
      games: entries.length,
      directionalAccuracy: directionalPct,
      avgWinnerAdvantage: Math.round(avg(winnerVals) * 100) / 100,
      correctDir,
      wrongDir,
      neutral,
      isOutcomeStat: key.includes('OUTCOME'),
    });
  }

  rankings.sort((a, b) => b.directionalAccuracy - a.directionalAccuracy);

  // Group into tiers (exclude outcome stats from tier classification)
  const structural = rankings.filter(r => !r.isOutcomeStat);
  const outcome = rankings.filter(r => r.isOutcomeStat);

  return {
    gamesAnalyzed: processed,
    totalStats: rankings.length,
    structural_rankings: structural,
    outcome_stats_for_reference: outcome,
    tiers: {
      'highly_predictive_70pct_plus': structural.filter(r => r.directionalAccuracy >= 70).map(r => `${r.stat}: ${r.directionalAccuracy}%`),
      'moderately_predictive_60_to_70pct': structural.filter(r => r.directionalAccuracy >= 60 && r.directionalAccuracy < 70).map(r => `${r.stat}: ${r.directionalAccuracy}%`),
      'weak_55_to_60pct': structural.filter(r => r.directionalAccuracy >= 55 && r.directionalAccuracy < 60).map(r => `${r.stat}: ${r.directionalAccuracy}%`),
      'noise_below_55pct': structural.filter(r => r.directionalAccuracy < 55).map(r => `${r.stat}: ${r.directionalAccuracy}%`),
    },
    methodology: 'For each stat, we compute the home-away differential. Then we ask: when this stat favors a team, how often does that team win? Ties excluded. 50% = coin flip.',
    caveat: 'Stats marked _OUTCOME are circular for completed games (net rating = who scored more). Use structural stats only for indicator design.',
  };
}

// ── CUMULATIVE INDICATOR ENGINE ──────────────────────────────────────────────
// Computes WNBA indicators cumulatively through quarter `throughQ` (1-4).
// Uses SR per-period stats summed up to that quarter boundary.
function computeCumulativeAtQuarter(summary, throughQ) {
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hPeriods = H.statistics?.periods || [];
  const aPeriods = A.statistics?.periods || [];
  if (hPeriods.length < throughQ || aPeriods.length < throughQ) return null;

  const hA = H.alias || H.name || 'HOME', aA = A.alias || A.name || 'AWAY';

  // Sum stats across periods 1..throughQ
  const sum = (periods, field) => {
    let s = 0;
    for (let i = 0; i < throughQ; i++) s += Number(periods[i]?.[field] || 0);
    return s;
  };
  const maxField = (periods, field) => {
    let m = 0;
    for (let i = 0; i < throughQ; i++) m = Math.max(m, Number(periods[i]?.[field] || 0));
    return m;
  };

  // Cumulative stats
  const hs = {
    steals: sum(hPeriods, 'steals'), blocks: sum(hPeriods, 'blocks'),
    points_off_turnovers: sum(hPeriods, 'points_off_turnovers'),
    three_points_made: sum(hPeriods, 'three_points_made'), three_points_att: sum(hPeriods, 'three_points_att'),
    free_throws_att: sum(hPeriods, 'free_throws_att'),
    field_goals_made: sum(hPeriods, 'field_goals_made'), field_goals_att: sum(hPeriods, 'field_goals_att'),
    assists: sum(hPeriods, 'assists'),
    biggest_lead: maxField(hPeriods, 'biggest_lead'),
    fast_break_pts: sum(hPeriods, 'fast_break_pts'),
    offensive_rebounds: sum(hPeriods, 'offensive_rebounds'), defensive_rebounds: sum(hPeriods, 'defensive_rebounds'),
  };
  const as = {
    steals: sum(aPeriods, 'steals'), blocks: sum(aPeriods, 'blocks'),
    points_off_turnovers: sum(aPeriods, 'points_off_turnovers'),
    three_points_made: sum(aPeriods, 'three_points_made'), three_points_att: sum(aPeriods, 'three_points_att'),
    free_throws_att: sum(aPeriods, 'free_throws_att'),
    field_goals_made: sum(aPeriods, 'field_goals_made'), field_goals_att: sum(aPeriods, 'field_goals_att'),
    assists: sum(aPeriods, 'assists'),
    biggest_lead: maxField(aPeriods, 'biggest_lead'),
    fast_break_pts: sum(aPeriods, 'fast_break_pts'),
    offensive_rebounds: sum(aPeriods, 'offensive_rebounds'), defensive_rebounds: sum(aPeriods, 'defensive_rebounds'),
  };

  // Cumulative scoring for current-Q scoring diff (I4-B)
  const hScoring = H.scoring || [];
  const aScoring = A.scoring || [];
  const lastQPts_h = hScoring[throughQ - 1]?.points || 0;
  const lastQPts_a = aScoring[throughQ - 1]?.points || 0;

  // Cumulative score
  let hPts = 0, aPts = 0;
  for (let i = 0; i < throughQ; i++) {
    hPts += hScoring[i]?.points || 0;
    aPts += aScoring[i]?.points || 0;
  }

  // I1 — Disruption
  const disruptDiff = (hs.steals + hs.blocks) - (as.steals + as.blocks);
  const i1subA = disruptDiff > 2 ? 1 : disruptDiff < -2 ? -1 : 0;
  const potDiff = hs.points_off_turnovers - as.points_off_turnovers;
  const i1subB = potDiff > 3 ? 1 : potDiff < -3 ? -1 : 0;
  const i1raw = i1subA + i1subB;
  const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? hA : i1raw < 0 ? aA : 'EVEN' };

  // I2 — Perimeter & FT
  const h3Pct = hs.three_points_att > 0 ? (hs.three_points_made / hs.three_points_att) * 100 : 0;
  const a3Pct = as.three_points_att > 0 ? (as.three_points_made / as.three_points_att) * 100 : 0;
  const threePctDiff = h3Pct - a3Pct;
  const i2subA = threePctDiff > 3 ? 1 : threePctDiff < -3 ? -1 : 0;
  const ftaDiff = hs.free_throws_att - as.free_throws_att;
  const i2subB = ftaDiff > 2 ? 1 : ftaDiff < -2 ? -1 : 0;
  const i2raw = i2subA + i2subB;
  const I2 = { score: i2raw > 0 ? 1 : i2raw === 0 ? 0.5 : 0, leader: i2raw > 0 ? hA : i2raw < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality (anchor)
  const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
  const hEFG = (hs.field_goals_made + 0.5 * hs.three_points_made) / hFGA;
  const aEFG = (as.field_goals_made + 0.5 * as.three_points_made) / aFGA;
  const efgDiff = hEFG - aEFG;
  const i3subA = efgDiff > 0.03 ? 1 : efgDiff < -0.03 ? -1 : 0;
  const astDiff = hs.assists - as.assists;
  const i3subB = astDiff > 2 ? 1 : astDiff < -2 ? -1 : 0;
  const i3raw = i3subA + i3subB;
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? hA : i3raw < 0 ? aA : 'EVEN' };

  // I4 — Game Control
  const bigLeadDiff = hs.biggest_lead - as.biggest_lead;
  const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
  const lastQDiff = lastQPts_h - lastQPts_a;
  const i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
  const i4raw = i4subA + i4subB;
  const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? hA : i4raw < 0 ? aA : 'EVEN' };

  // I5 — Momentum
  const fbDiff = hs.fast_break_pts - as.fast_break_pts;
  const i5subA = fbDiff > 3 ? 1 : fbDiff < -3 ? -1 : 0;
  const hReb = hs.offensive_rebounds + hs.defensive_rebounds;
  const aReb = as.offensive_rebounds + as.defensive_rebounds;
  const rebDiff = hReb - aReb;
  const i5subB = rebDiff > 3 ? 1 : rebDiff < -3 ? -1 : 0;
  const i5raw = i5subA + i5subB;
  const I5 = { score: i5raw > 0 ? 1 : i5raw === 0 ? 0.5 : 0, leader: i5raw > 0 ? hA : i5raw < 0 ? aA : 'EVEN' };

  // Composite
  const raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  const controlHome = raw >= 0.5;
  const controlTeam = controlHome ? hA : aA;
  const score = controlHome ? raw : 1 - raw;

  return {
    controlTeam, score: Math.round(score * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA, awayAlias: aA, homePts: hPts, awayPts: aPts,
    quarter: throughQ, margin: hPts - aPts,
  };
}

// Helper: compute conviction from indicators (reuse existing)
function computeConvictionFromInd(ind) {
  return computeConviction(ind);
}

// ── REPORT: QUARTER JOURNEY ─────────────────────────────────────────────────
// Track control team, floor, and conviction at each quarter boundary.
// Answers: How stable is WNBA structural control across quarters?
async function reportQuarterJourney(sql) {
  const games = await sql`SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
  if (games.length === 0) return { error: 'No SR data' };

  let totalGames = 0;
  let flipGames = 0;           // Games where control team changed between any quarters
  const flipPatterns = {};      // e.g., "Q1:MIN Q2:MIN Q3:SEA Q4:SEA" → count
  const floorByQ = { Q1: [], Q2: [], Q3: [], Q4: [] };
  const ctrlWonByQ = { Q1: { n: 0, wins: 0 }, Q2: { n: 0, wins: 0 }, Q3: { n: 0, wins: 0 }, Q4: { n: 0, wins: 0 } };
  const holdPatterns = { wire_to_wire: 0, one_flip: 0, two_flips: 0, three_flips: 0 };
  const wireToWireWins = { n: 0, wins: 0 };
  const flippedWins = { n: 0, wins: 0 };
  // Track: if Q2 ctrl team wins at full game
  const q2CtrlWins = { n: 0, wins: 0 };
  const q3CtrlWins = { n: 0, wins: 0 };

  for (const g of games) {
    const summary = g.sr_summary;
    const quarters = [];
    let valid = true;
    for (let q = 1; q <= 4; q++) {
      const ind = computeCumulativeAtQuarter(summary, q);
      if (!ind) { valid = false; break; }
      quarters.push(ind);
    }
    if (!valid || quarters.length < 4) continue;
    totalGames++;

    const winner = g.winner;
    const ctrlTeams = quarters.map(q => q.controlTeam);
    const floors = quarters.map(q => q.score);

    // Track floors
    for (let i = 0; i < 4; i++) {
      const qLabel = `Q${i + 1}`;
      floorByQ[qLabel].push(floors[i]);
      const ctrlWon = bdlAlias(ctrlTeams[i]) === winner || ctrlTeams[i] === winner;
      ctrlWonByQ[qLabel].n++;
      if (ctrlWon) ctrlWonByQ[qLabel].wins++;
    }

    // Count flips
    let flips = 0;
    for (let i = 1; i < 4; i++) {
      if (ctrlTeams[i] !== ctrlTeams[i - 1]) flips++;
    }
    if (flips === 0) holdPatterns.wire_to_wire++;
    else if (flips === 1) holdPatterns.one_flip++;
    else if (flips === 2) holdPatterns.two_flips++;
    else holdPatterns.three_flips++;

    if (flips > 0) flipGames++;

    // Wire-to-wire accuracy
    const finalCtrlWon = bdlAlias(ctrlTeams[3]) === winner || ctrlTeams[3] === winner;
    if (flips === 0) {
      wireToWireWins.n++;
      if (finalCtrlWon) wireToWireWins.wins++;
    } else {
      flippedWins.n++;
      if (finalCtrlWon) flippedWins.wins++;
    }

    // Q2/Q3 ctrl → final win
    const q2CtrlWon = bdlAlias(ctrlTeams[1]) === winner || ctrlTeams[1] === winner;
    q2CtrlWins.n++;
    if (q2CtrlWon) q2CtrlWins.wins++;

    const q3CtrlWon = bdlAlias(ctrlTeams[2]) === winner || ctrlTeams[2] === winner;
    q3CtrlWins.n++;
    if (q3CtrlWon) q3CtrlWins.wins++;

    // Track pattern
    const pattern = ctrlTeams.map((t, i) => `Q${i + 1}:${t}`).join(' ');
    flipPatterns[pattern] = (flipPatterns[pattern] || 0) + 1;
  }

  const avg = arr => arr.length > 0 ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 1000) / 1000 : 0;
  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;

  return {
    totalGames,
    flipRate: pct(flipGames, totalGames),
    holdPatterns,
    wireToWire: { ...wireToWireWins, pct: pct(wireToWireWins.wins, wireToWireWins.n) },
    flipped: { ...flippedWins, pct: pct(flippedWins.wins, flippedWins.n) },
    ctrlAccuracyByQuarter: {
      Q1: { ...ctrlWonByQ.Q1, pct: pct(ctrlWonByQ.Q1.wins, ctrlWonByQ.Q1.n) },
      Q2: { ...ctrlWonByQ.Q2, pct: pct(ctrlWonByQ.Q2.wins, ctrlWonByQ.Q2.n) },
      Q3: { ...ctrlWonByQ.Q3, pct: pct(ctrlWonByQ.Q3.wins, ctrlWonByQ.Q3.n) },
      Q4: { ...ctrlWonByQ.Q4, pct: pct(ctrlWonByQ.Q4.wins, ctrlWonByQ.Q4.n) },
    },
    q2CtrlWinsGame: { ...q2CtrlWins, pct: pct(q2CtrlWins.wins, q2CtrlWins.n) },
    q3CtrlWinsGame: { ...q3CtrlWins, pct: pct(q3CtrlWins.wins, q3CtrlWins.n) },
    avgFloorByQ: {
      Q1: avg(floorByQ.Q1), Q2: avg(floorByQ.Q2), Q3: avg(floorByQ.Q3), Q4: avg(floorByQ.Q4),
    },
    topPatterns: Object.entries(flipPatterns).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, c]) => ({ pattern: p, count: c })),
  };
}

// ── REPORT: GRADUATION SIM ──────────────────────────────────────────────────
// Simulate checkpoint graduation using quarter boundaries.
// Tests multiple MF/minF gates to find optimal WNBA thresholds.
async function reportGraduationSim(sql) {
  const games = await sql`SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
  if (games.length === 0) return { error: 'No SR data' };

  // MF gates to test
  const mfGates = [0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.70];
  const minFGates = [0.50, 0.55, 0.58, 0.60];

  // For each game, compute indicators at Q1-Q4 boundaries
  const gameData = [];
  for (const g of games) {
    const quarters = [];
    let valid = true;
    for (let q = 1; q <= 4; q++) {
      const ind = computeCumulativeAtQuarter(g.sr_summary, q);
      if (!ind) { valid = false; break; }
      const conv = computeConvictionFromInd(ind);
      quarters.push({ ...ind, conviction: conv.tier, indicatorsWon: conv.indicatorsWon, combo: conv.combo });
    }
    if (!valid || quarters.length < 4) continue;

    const winner = g.winner;
    const margin = Math.abs(g.margin);
    gameData.push({ quarters, winner, margin, marginBucket: g.margin_bucket, gameId: g.game_id,
      homeAlias: quarters[0].homeAlias, awayAlias: quarters[0].awayAlias });
  }

  // Simulate graduation for each MF/minF combo
  const results = {};
  for (const mfGate of mfGates) {
    for (const minFGate of minFGates) {
      if (minFGate > mfGate) continue; // minF can't exceed MF gate

      const key = `MF${mfGate}_minF${minFGate}`;
      let graduated = 0, gradWins = 0, neverGrad = 0, neverGradWins = 0;
      const byCheckpoint = {};
      const byRank = { S: { n: 0, wins: 0 }, A: { n: 0, wins: 0 }, B: { n: 0, wins: 0 } };
      let flipped = 0, flippedWins = 0, standard = 0, standardWins = 0;

      for (const gd of gameData) {
        const { quarters, winner } = gd;
        const floors = quarters.map(q => q.score);
        const ctrlTeams = quarters.map(q => q.controlTeam);
        const convictions = quarters.map(q => q.conviction);

        // Check graduation at each quarter boundary (Q1=checkpoint 0, Q2=1, Q3=2, Q4=3)
        // Graduation requires: MF >= gate, minF >= gate, conviction >= STRONG, leading (margin > 0)
        let gradQ = -1;
        let gradTeam = null;
        let gradRank = null;
        let isFlip = false;

        // Track per-team checkpoint history
        const teamCheckpoints = {};
        for (let q = 0; q < 4; q++) {
          const ctrl = ctrlTeams[q];
          const floor = floors[q];
          const conv = convictions[q];
          const margin = quarters[q].margin;
          const ctrlHome = ctrl === quarters[q].homeAlias;
          const ctrlLeading = ctrlHome ? margin > 0 : margin < 0;
          const ctrlMargin = ctrlHome ? margin : -margin;

          if (!teamCheckpoints[ctrl]) teamCheckpoints[ctrl] = [];
          teamCheckpoints[ctrl].push({ q, floor, conv, ctrlLeading, ctrlMargin });

          // Check if this team graduates
          if (gradQ < 0) {
            const cps = teamCheckpoints[ctrl];
            if (cps.length >= 2) {  // Need at least 2 checkpoints to graduate
              const cpFloors = cps.map(c => c.floor);
              const mf = cpFloors.reduce((s, v) => s + v, 0) / cpFloors.length;
              const minF = Math.min(...cpFloors);

              if (mf >= mfGate && minF >= minFGate && ctrlLeading) {
                // Determine rank
                const hasLead8 = ctrlMargin >= 8;
                const hasDominant = cps.some(c => c.conv === 'DOMINANT');
                const hasStrong = cps.some(c => c.conv === 'STRONG' || c.conv === 'DOMINANT');

                if (hasDominant && hasLead8) gradRank = 'A';
                else if (hasStrong) gradRank = 'B';
                else continue; // Don't graduate without at least STRONG

                gradQ = q;
                gradTeam = ctrl;

                // Check if another team had prior checkpoints (flip)
                for (const [otherTeam, otherCps] of Object.entries(teamCheckpoints)) {
                  if (otherTeam !== ctrl && otherCps.length >= 2) {
                    const otherMF = otherCps.map(c => c.floor).reduce((s, v) => s + v, 0) / otherCps.length;
                    if (otherMF >= minFGate) isFlip = true;
                  }
                }
              }
            }
          }
        }

        // Also check wire-to-wire (S-rank): same ctrl team Q1-Q4, A-rank quality
        if (gradQ >= 0 && ctrlTeams.every(t => t === ctrlTeams[0]) && gradRank === 'A') {
          gradRank = 'S';
        }

        const ctrlWon = gradTeam ? (bdlAlias(gradTeam) === winner || gradTeam === winner) : false;

        if (gradQ >= 0) {
          graduated++;
          if (ctrlWon) gradWins++;
          const cpLabel = `Q${gradQ + 1}`;
          if (!byCheckpoint[cpLabel]) byCheckpoint[cpLabel] = { n: 0, wins: 0 };
          byCheckpoint[cpLabel].n++;
          if (ctrlWon) byCheckpoint[cpLabel].wins++;

          byRank[gradRank].n++;
          if (ctrlWon) byRank[gradRank].wins++;

          if (isFlip) { flipped++; if (ctrlWon) flippedWins++; }
          else { standard++; if (ctrlWon) standardWins++; }
        } else {
          neverGrad++;
          // For never-graduated, check if final ctrl team won
          const finalCtrl = ctrlTeams[3];
          const finalWon = bdlAlias(finalCtrl) === winner || finalCtrl === winner;
          if (finalWon) neverGradWins++;
        }
      }

      const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
      results[key] = {
        mfGate, minFGate,
        graduated, gradPct: pct(gradWins, graduated),
        coverage: pct(graduated, gameData.length),
        neverGrad, neverGradPct: pct(neverGradWins, neverGrad),
        byRank: {
          S: { ...byRank.S, pct: pct(byRank.S.wins, byRank.S.n) },
          A: { ...byRank.A, pct: pct(byRank.A.wins, byRank.A.n) },
          B: { ...byRank.B, pct: pct(byRank.B.wins, byRank.B.n) },
        },
        byCheckpoint: Object.fromEntries(
          Object.entries(byCheckpoint).map(([k, v]) => [k, { ...v, pct: pct(v.wins, v.n) }])
        ),
        flip: { standard, standardPct: pct(standardWins, standard), flipped, flippedPct: pct(flippedWins, flipped) },
      };
    }
  }

  // Sort by graduated accuracy descending
  const ranked = Object.values(results)
    .filter(r => r.graduated >= 20) // minimum sample
    .sort((a, b) => {
      // Optimize for accuracy * coverage
      const scoreA = (a.gradPct / 100) * (a.coverage / 100);
      const scoreB = (b.gradPct / 100) * (b.coverage / 100);
      return scoreB - scoreA;
    });

  return {
    totalGames: gameData.length,
    note: 'Quarter boundaries as checkpoints (Q1-Q4). Graduation requires 2+ checkpoints, MF >= gate, minF >= gate, team leading, conviction >= STRONG.',
    bestCombos: ranked.slice(0, 10).map(r => ({
      gates: `MF=${r.mfGate} minF=${r.minFGate}`,
      accuracy: r.gradPct + '%',
      coverage: r.coverage + '%',
      score: Math.round((r.gradPct / 100) * (r.coverage / 100) * 1000) / 10,
      graduated: r.graduated,
      byRank: r.byRank,
    })),
    allResults: results,
  };
}

// ── REPORT: CLOSE GAME ──────────────────────────────────────────────────────
// Test different close game filter definitions for WNBA.
// WNBA has lower scoring (10-min Q), so NBA's "within 5 Q3, within 7 Q4" may need tightening.
async function reportCloseGame(sql) {
  const games = await sql`SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
  if (games.length === 0) return { error: 'No SR data' };

  const gameData = [];
  for (const g of games) {
    const quarters = [];
    let valid = true;
    for (let q = 1; q <= 4; q++) {
      const ind = computeCumulativeAtQuarter(g.sr_summary, q);
      if (!ind) { valid = false; break; }
      quarters.push(ind);
    }
    if (!valid) continue;
    gameData.push({
      quarters, winner: g.winner, margin: Math.abs(g.margin),
      q3Margin: quarters[2] ? Math.abs(quarters[2].margin) : null,
      q4Margin: Math.abs(g.margin),
      fullGameCtrl: quarters[3]?.controlTeam,
      fullGameFloor: quarters[3]?.score,
      fullGameConv: computeConvictionFromInd(quarters[3])?.tier,
      ctrlWon: bdlAlias(quarters[3]?.controlTeam) === g.winner || quarters[3]?.controlTeam === g.winner,
    });
  }

  // Test definitions
  const filters = [
    { name: 'NBA standard (Q3≤5, Q4≤7)', q3max: 5, q4max: 7 },
    { name: 'NBA standard Q4 only (≤7)', q3max: 999, q4max: 7 },
    { name: 'Tight (Q3≤4, Q4≤6)', q3max: 4, q4max: 6 },
    { name: 'Tighter (Q3≤3, Q4≤5)', q3max: 3, q4max: 5 },
    { name: 'Final margin ≤5', q3max: 999, q4max: 5 },
    { name: 'Final margin ≤7', q3max: 999, q4max: 7 },
    { name: 'Final margin ≤10', q3max: 999, q4max: 10 },
  ];

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;

  const results = filters.map(f => {
    const close = gameData.filter(gd => {
      if (f.q3max < 999 && gd.q3Margin != null && gd.q3Margin > f.q3max) return false;
      if (gd.q4Margin > f.q4max) return false;
      return true;
    });
    const wins = close.filter(gd => gd.ctrlWon).length;

    // Per-conviction tier in close games
    const byTier = {};
    for (const gd of close) {
      const t = gd.fullGameConv || 'UNKNOWN';
      if (!byTier[t]) byTier[t] = { n: 0, wins: 0 };
      byTier[t].n++;
      if (gd.ctrlWon) byTier[t].wins++;
    }
    for (const v of Object.values(byTier)) v.pct = pct(v.wins, v.n);

    return {
      filter: f.name,
      games: close.length,
      pctOfTotal: pct(close.length, gameData.length),
      accuracy: pct(wins, close.length),
      byTier,
    };
  });

  // Margin distribution
  const marginDist = {};
  for (const gd of gameData) {
    const bucket = gd.margin <= 3 ? '1-3' : gd.margin <= 5 ? '4-5' : gd.margin <= 7 ? '6-7'
      : gd.margin <= 10 ? '8-10' : gd.margin <= 14 ? '11-14' : '15+';
    if (!marginDist[bucket]) marginDist[bucket] = { n: 0, wins: 0 };
    marginDist[bucket].n++;
    if (gd.ctrlWon) marginDist[bucket].wins++;
  }
  for (const v of Object.values(marginDist)) v.pct = pct(v.wins, v.n);

  return {
    totalGames: gameData.length,
    note: 'WNBA has 10-min quarters (vs NBA 12). Lower scoring means tighter margins. Testing which close-game filter best isolates competitive games.',
    results,
    marginDistribution: marginDist,
  };
}

// ── REPORT: TRAILING PROFILE ────────────────────────────────────────────────
// BUY profile equivalent — when control team trails, how often do they win?
// Uses per-quarter data to identify trailing scenarios.
async function reportTrailingProfile(sql) {
  const games = await sql`SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
  if (games.length === 0) return { error: 'No SR data' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;

  // For each game at each quarter boundary, check: is ctrl team trailing?
  const trailingBuckets = {};
  const byIndicatorCount = {};
  const byConviction = {};
  const byDeficit = {};
  const goldenStack = { n: 0, wins: 0 }; // trail 1-4, 3+ indicators, opp 0

  for (const g of games) {
    for (let q = 2; q <= 4; q++) { // Start at Q2 (Q1 too early)
      const ind = computeCumulativeAtQuarter(g.sr_summary, q);
      if (!ind) continue;

      const conv = computeConvictionFromInd(ind);
      const ctrlHome = ind.controlTeam === ind.homeAlias;
      const ctrlMargin = ctrlHome ? ind.margin : -ind.margin;

      // Only interested in trailing ctrl team
      if (ctrlMargin >= 0) continue;
      const deficit = Math.abs(ctrlMargin);

      const ctrlWon = bdlAlias(ind.controlTeam) === g.winner || ind.controlTeam === g.winner;

      // Track by quarter
      const qKey = `Q${q}`;
      if (!trailingBuckets[qKey]) trailingBuckets[qKey] = { n: 0, wins: 0 };
      trailingBuckets[qKey].n++;
      if (ctrlWon) trailingBuckets[qKey].wins++;

      // Track by indicator count
      const iKey = `${conv.count}_indicators`;
      if (!byIndicatorCount[iKey]) byIndicatorCount[iKey] = { n: 0, wins: 0 };
      byIndicatorCount[iKey].n++;
      if (ctrlWon) byIndicatorCount[iKey].wins++;

      // Track by conviction tier
      if (!byConviction[conv.tier]) byConviction[conv.tier] = { n: 0, wins: 0 };
      byConviction[conv.tier].n++;
      if (ctrlWon) byConviction[conv.tier].wins++;

      // Track by deficit range
      const dKey = deficit <= 4 ? '1-4' : deficit <= 7 ? '5-7' : deficit <= 10 ? '8-10' : deficit <= 15 ? '11-15' : '16+';
      if (!byDeficit[dKey]) byDeficit[dKey] = { n: 0, wins: 0 };
      byDeficit[dKey].n++;
      if (ctrlWon) byDeficit[dKey].wins++;

      // Golden stack: trail 1-4, 3+ indicators, opponent has 0 indicators won
      const oppIndicators = conv.indicatorsLost?.length || 0; // ctrl lost = opp won
      if (deficit >= 1 && deficit <= 4 && conv.count >= 3 && oppIndicators === 0) {
        goldenStack.n++;
        if (ctrlWon) goldenStack.wins++;
      }
    }
  }

  // Add pct to all buckets
  for (const v of Object.values(trailingBuckets)) v.pct = pct(v.wins, v.n);
  for (const v of Object.values(byIndicatorCount)) v.pct = pct(v.wins, v.n);
  for (const v of Object.values(byConviction)) v.pct = pct(v.wins, v.n);
  for (const v of Object.values(byDeficit)) v.pct = pct(v.wins, v.n);
  goldenStack.pct = pct(goldenStack.wins, goldenStack.n);

  // I3 inversion check — does ctrl team winning I3 while trailing hurt?
  const i3Won = { n: 0, wins: 0 };
  const i3Lost = { n: 0, wins: 0 };
  for (const g of games) {
    for (let q = 2; q <= 4; q++) {
      const ind = computeCumulativeAtQuarter(g.sr_summary, q);
      if (!ind) continue;
      const ctrlHome = ind.controlTeam === ind.homeAlias;
      const ctrlMargin = ctrlHome ? ind.margin : -ind.margin;
      if (ctrlMargin >= 0) continue;

      const ctrlWon = bdlAlias(ind.controlTeam) === g.winner || ind.controlTeam === g.winner;
      const i3score = ctrlHome ? ind.I3.score : 1 - ind.I3.score;
      if (i3score > 0.5) { i3Won.n++; if (ctrlWon) i3Won.wins++; }
      else if (i3score < 0.5) { i3Lost.n++; if (ctrlWon) i3Lost.wins++; }
    }
  }
  i3Won.pct = pct(i3Won.wins, i3Won.n);
  i3Lost.pct = pct(i3Lost.wins, i3Lost.n);

  return {
    note: 'Ctrl team trailing at Q2/Q3/Q4 boundaries. Measures comeback rate by deficit, indicators, conviction.',
    trailingByQuarter: trailingBuckets,
    byIndicatorCount,
    byConviction,
    byDeficit,
    goldenStack,
    i3Inversion: {
      ctrlWinsI3: i3Won,
      ctrlLosesI3: i3Lost,
      note: 'In NBA, ctrl team winning I3 while trailing is NEGATIVE (37.3%). Check if same pattern in WNBA.',
    },
  };
}

// ── REPORT: INDICATOR STABILITY ─────────────────────────────────────────────
// How stable are individual indicators across quarters?
// If I3 leads at Q2, does it hold through Q4?
async function reportIndicatorStability(sql) {
  const games = await sql`SELECT * FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
  if (games.length === 0) return { error: 'No SR data' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
  const indicators = ['I1', 'I2', 'I3', 'I4', 'I5'];

  // For each indicator, track: if team leads at Q(n), probability they lead at Q4
  const stability = {};
  for (const iKey of indicators) {
    stability[iKey] = {
      q1_to_q4: { n: 0, held: 0 },
      q2_to_q4: { n: 0, held: 0 },
      q3_to_q4: { n: 0, held: 0 },
      flipRate: { n: 0, flips: 0 }, // total quarter-to-quarter flips
      evenRate: { q1: 0, q2: 0, q3: 0, q4: 0, total: 0 },
    };
  }

  let totalGames = 0;
  for (const g of games) {
    const quarters = [];
    let valid = true;
    for (let q = 1; q <= 4; q++) {
      const ind = computeCumulativeAtQuarter(g.sr_summary, q);
      if (!ind) { valid = false; break; }
      quarters.push(ind);
    }
    if (!valid) continue;
    totalGames++;

    for (const iKey of indicators) {
      // Get indicator leader at each quarter
      const leaders = quarters.map(q => q[iKey]?.leader || 'EVEN');

      // Track EVEN rates
      for (let q = 0; q < 4; q++) {
        if (leaders[q] === 'EVEN') stability[iKey].evenRate[`q${q + 1}`]++;
      }
      stability[iKey].evenRate.total++;

      // Stability: Q(n) leader holds through Q4
      const q4Leader = leaders[3];
      if (q4Leader !== 'EVEN') {
        if (leaders[0] !== 'EVEN') {
          stability[iKey].q1_to_q4.n++;
          if (leaders[0] === q4Leader) stability[iKey].q1_to_q4.held++;
        }
        if (leaders[1] !== 'EVEN') {
          stability[iKey].q2_to_q4.n++;
          if (leaders[1] === q4Leader) stability[iKey].q2_to_q4.held++;
        }
        if (leaders[2] !== 'EVEN') {
          stability[iKey].q3_to_q4.n++;
          if (leaders[2] === q4Leader) stability[iKey].q3_to_q4.held++;
        }
      }

      // Quarter-to-quarter flips
      for (let q = 1; q < 4; q++) {
        if (leaders[q] !== 'EVEN' && leaders[q - 1] !== 'EVEN') {
          stability[iKey].flipRate.n++;
          if (leaders[q] !== leaders[q - 1]) stability[iKey].flipRate.flips++;
        }
      }
    }
  }

  // Compute percentages
  const report = {};
  for (const iKey of indicators) {
    const s = stability[iKey];
    report[iKey] = {
      q1_holds_to_q4: { ...s.q1_to_q4, pct: pct(s.q1_to_q4.held, s.q1_to_q4.n) },
      q2_holds_to_q4: { ...s.q2_to_q4, pct: pct(s.q2_to_q4.held, s.q2_to_q4.n) },
      q3_holds_to_q4: { ...s.q3_to_q4, pct: pct(s.q3_to_q4.held, s.q3_to_q4.n) },
      flipRate: { ...s.flipRate, pct: pct(s.flipRate.flips, s.flipRate.n) },
      evenRate: {
        Q1: pct(s.evenRate.q1, totalGames), Q2: pct(s.evenRate.q2, totalGames),
        Q3: pct(s.evenRate.q3, totalGames), Q4: pct(s.evenRate.q4, totalGames),
      },
    };
  }

  return {
    totalGames,
    note: 'Stability = if indicator leader at Q(n) is same leader at Q4 (full game). Higher = more stable/reliable early signal.',
    indicators: report,
    summary: indicators.map(i => ({
      indicator: i,
      q2_stability: report[i].q2_holds_to_q4.pct + '%',
      q3_stability: report[i].q3_holds_to_q4.pct + '%',
      flipRate: report[i].flipRate.pct + '%',
    })),
  };
}

// ── WNBA 2.5-MINUTE CHECKPOINTS ─────────────────────────────────────────────
// 10-min quarters → 4 checkpoints per quarter (Q2-Q4) = 11 total + Q4_END
const WNBA_CHECKPOINTS = [
  { label: 'Q2_7.5', period: 2, clockSec: 450, gameSec: 750  },
  { label: 'Q2_5',   period: 2, clockSec: 300, gameSec: 900  },
  { label: 'Q2_2.5', period: 2, clockSec: 150, gameSec: 1050 },
  { label: 'Q2_END', period: 2, clockSec: 0,   gameSec: 1200 },
  { label: 'Q3_7.5', period: 3, clockSec: 450, gameSec: 1350 },
  { label: 'Q3_5',   period: 3, clockSec: 300, gameSec: 1500 },
  { label: 'Q3_2.5', period: 3, clockSec: 150, gameSec: 1650 },
  { label: 'Q3_END', period: 3, clockSec: 0,   gameSec: 1800 },
  { label: 'Q4_7.5', period: 4, clockSec: 450, gameSec: 1950 },
  { label: 'Q4_5',   period: 4, clockSec: 300, gameSec: 2100 },
  { label: 'Q4_2.5', period: 4, clockSec: 150, gameSec: 2250 },
];

function parseClockSec(clock) {
  if (!clock) return 0;
  const p = String(clock).split(':');
  return parseInt(p[0] || 0) * 60 + parseInt(p[1] || 0);
}

// ── PBP BOX SCORE RECONSTRUCTION ────────────────────────────────────────────
// Walk BDL plays chronologically, accumulate stats, snapshot at each checkpoint.
function reconstructCheckpoints(plays, homeAbbr, awayAbbr) {
  if (!plays || plays.length === 0) return null;
  const sorted = plays.slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  const mk = () => ({ fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0,
    oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pot: 0 });
  const h = mk(), a = mk();
  let bigH = 0, bigA = 0, pendPOT = null, lastPeriod = 0;
  const snaps = [];
  let cpIdx = 0;

  const snap = (hScore, aScore) => ({
    cp: WNBA_CHECKPOINTS[cpIdx],
    home: { ...h, biggest_lead: bigH, three_points_pct: h.fg3a > 0 ? h.fg3m / h.fg3a * 100 : 0 },
    away: { ...a, biggest_lead: bigA, three_points_pct: a.fg3a > 0 ? a.fg3m / a.fg3a * 100 : 0 },
    homeScore: hScore, awayScore: aScore, margin: hScore - aScore,
  });

  for (const ev of sorted) {
    const period = ev.period || 1;
    const clockSec = parseClockSec(ev.clock);
    const gs = (period - 1) * 600 + (600 - clockSec);

    // Reset POT on period change
    if (period !== lastPeriod) { pendPOT = null; lastPeriod = period; }

    // Snapshot at each passed checkpoint
    while (cpIdx < WNBA_CHECKPOINTS.length && gs >= WNBA_CHECKPOINTS[cpIdx].gameSec) {
      snaps.push(snap(ev.home_score || 0, ev.away_score || 0));
      cpIdx++;
    }

    const tm = ev.team?.abbreviation || '';
    if (!tm) continue;
    const isH = tm === homeAbbr;
    const s = isH ? h : a;
    const opp = isH ? awayAbbr : homeAbbr;
    const type = (ev.type || '').toLowerCase();
    const text = (ev.text || '').toLowerCase();

    // Biggest lead
    if (ev.home_score != null && ev.away_score != null) {
      const mg = ev.home_score - ev.away_score;
      if (mg > bigH) bigH = mg;
      if (-mg > bigA) bigA = -mg;
    }

    if (type.includes('substitution') || text.includes('enters the game')) continue;

    // ── Free throws
    if (type.includes('free throw')) {
      s.fta++;
      if (ev.scoring_play || text.includes('makes')) {
        s.ftm++;
        if (pendPOT === tm) s.pot += 1;
      }
      continue;
    }

    // ── Field goals — detect from scoring_play + score_value OR type keywords
    const isShotType = type.includes('shot') || type.includes('layup') || type.includes('dunk') ||
      type.includes('hook') || type.includes('tip') || type.includes('alley') || type.includes('finger roll') ||
      type.includes('pullup') || type.includes('driving') || type.includes('fadeaway') ||
      type.includes('float') || type.includes('runner') || type.includes('step back') ||
      type.includes('turnaround') || type.includes('cutting') || type.includes('putback');
    const isMadeFG = ev.scoring_play && ev.score_value >= 2;

    if (isShotType || isMadeFG || (text.includes('misses') && !type.includes('free throw'))) {
      const is3 = ev.score_value === 3 || type.includes('three point') || type.includes('3-point') || type.includes('3pt');
      s.fga++;
      if (is3) s.fg3a++;
      if (isMadeFG || text.includes('makes')) {
        s.fgm++;
        if (is3) s.fg3m++;
        if (text.includes('assist')) s.ast++;
        if (pendPOT === tm) s.pot += (is3 ? 3 : 2);
        pendPOT = null;
      }
      continue;
    }

    // ── Turnovers
    if (type.includes('turnover') || type.includes('offensive foul')) {
      s.tov++;
      pendPOT = opp;
      continue;
    }

    // ── Rebounds
    if (type.includes('rebound')) {
      if (type.includes('offensive') || text.includes('offensive')) s.oreb++;
      else { s.dreb++; pendPOT = null; }
      continue;
    }

    // ── Steals (may appear as separate play or in text of turnover)
    if (type.includes('steal')) { s.stl++; continue; }

    // ── Blocks
    if (type.includes('block')) { s.blk++; continue; }

    // ── Fouls
    if (type.includes('foul') && !type.includes('offensive')) { s.pf++; continue; }
  }

  // Capture remaining checkpoints
  const last = sorted[sorted.length - 1];
  while (cpIdx < WNBA_CHECKPOINTS.length) {
    snaps.push(snap(last?.home_score || 0, last?.away_score || 0));
    cpIdx++;
  }
  return snaps;
}

// ── COMPUTE INDICATORS FROM CHECKPOINT SNAPSHOT ─────────────────────────────
function computeAtCheckpoint(cpSnap, homeAlias, awayAlias) {
  const hs = cpSnap.home, as = cpSnap.away;
  const hA = homeAlias, aA = awayAlias;

  // I1 — Disruption: steals+blocks (±2) + POT (±3)
  const disruptDiff = (hs.stl + hs.blk) - (as.stl + as.blk);
  const i1A = disruptDiff > 2 ? 1 : disruptDiff < -2 ? -1 : 0;
  const potDiff = (hs.pot || 0) - (as.pot || 0);
  const i1B = potDiff > 3 ? 1 : potDiff < -3 ? -1 : 0;
  const i1r = i1A + i1B;
  const I1 = { score: i1r > 0 ? 1 : i1r === 0 ? 0.5 : 0, leader: i1r > 0 ? hA : i1r < 0 ? aA : 'EVEN' };

  // I2 — Perimeter: 3PT% (±3%) + FTA (±2)
  const h3P = hs.fg3a > 0 ? hs.fg3m / hs.fg3a * 100 : 0;
  const a3P = as.fg3a > 0 ? as.fg3m / as.fg3a * 100 : 0;
  const i2A = (h3P - a3P) > 3 ? 1 : (h3P - a3P) < -3 ? -1 : 0;
  const ftaDiff = hs.fta - as.fta;
  const i2B = ftaDiff > 2 ? 1 : ftaDiff < -2 ? -1 : 0;
  const i2r = i2A + i2B;
  const I2 = { score: i2r > 0 ? 1 : i2r === 0 ? 0.5 : 0, leader: i2r > 0 ? hA : i2r < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality: eFG (±0.03) + assists (±2)
  const hFGA = hs.fga || 1, aFGA = as.fga || 1;
  const hEFG = (hs.fgm + 0.5 * hs.fg3m) / hFGA;
  const aEFG = (as.fgm + 0.5 * as.fg3m) / aFGA;
  const efgDiff = hEFG - aEFG;
  const i3A = efgDiff > 0.03 ? 1 : efgDiff < -0.03 ? -1 : 0;
  const astDiff = hs.ast - as.ast;
  const i3B = astDiff > 2 ? 1 : astDiff < -2 ? -1 : 0;
  const i3r = i3A + i3B;
  const I3 = { score: i3r > 0 ? 1 : i3r === 0 ? 0.5 : 0, leader: i3r > 0 ? hA : i3r < 0 ? aA : 'EVEN' };

  // I4 — Game Control: biggest_lead (±4) + last-checkpoint scoring (±2)
  const blDiff = hs.biggest_lead - as.biggest_lead;
  const i4A = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
  // Use current margin as proxy for "recent scoring diff"
  const marg = cpSnap.margin || 0;
  const i4B = marg > 2 ? 1 : marg < -2 ? -1 : 0;
  const i4r = i4A + i4B;
  const I4 = { score: i4r > 0 ? 1 : i4r === 0 ? 0.5 : 0, leader: i4r > 0 ? hA : i4r < 0 ? aA : 'EVEN' };

  // I5 — Momentum: fast_break_pts=0 (unavailable from BDL PBP) + rebounds (±3)
  const rebDiff = (hs.oreb + hs.dreb) - (as.oreb + as.dreb);
  const i5B = rebDiff > 3 ? 1 : rebDiff < -3 ? -1 : 0;
  // i5A always 0 (fast break unavailable)
  const i5r = i5B;
  const I5 = { score: i5r > 0 ? 1 : i5r === 0 ? 0.5 : 0, leader: i5r > 0 ? hA : i5r < 0 ? aA : 'EVEN' };

  const raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  const controlHome = raw >= 0.5;
  const controlTeam = controlHome ? hA : aA;
  const score = controlHome ? raw : 1 - raw;

  return {
    controlTeam, score: Math.round(score * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA, awayAlias: aA,
    homePts: cpSnap.homeScore, awayPts: cpSnap.awayScore,
    margin: cpSnap.margin, cpLabel: cpSnap.cp.label,
  };
}

// ── PHASE: COLLECT PBP ──────────────────────────────────────────────────────
// Fetch BDL PBP for games missing it. Run via console auto-runner.
async function phaseCollectPBP(sql, url) {
  // Ensure column exists
  await sql`ALTER TABLE wnba_backtest ADD COLUMN IF NOT EXISTS bdl_pbp JSONB`;
  await sql`ALTER TABLE wnba_backtest ADD COLUMN IF NOT EXISTS checkpoint_data JSONB`;

  const batch = parseInt(url.searchParams.get('batch') || '15');

  const games = await sql`
    SELECT game_id, bdl_game_id, home_alias, away_alias
    FROM wnba_backtest WHERE bdl_game_id IS NOT NULL AND bdl_pbp IS NULL
    ORDER BY date LIMIT ${batch}
  `;

  const remaining = await sql`
    SELECT COUNT(*) as n FROM wnba_backtest WHERE bdl_game_id IS NOT NULL AND bdl_pbp IS NULL
  `;

  let collected = 0, errors = 0;
  for (const g of games) {
    try {
      const data = await bdlFetch(`/wnba/v1/plays?game_id=${g.bdl_game_id}`);
      const plays = data?.data || [];
      if (plays.length > 0) {
        await sql`UPDATE wnba_backtest SET bdl_pbp = ${JSON.stringify(plays)} WHERE game_id = ${g.game_id}`;
        collected++;
      } else {
        // Store empty array to mark as attempted
        await sql`UPDATE wnba_backtest SET bdl_pbp = '[]'::jsonb WHERE game_id = ${g.game_id}`;
        errors++;
      }
    } catch (e) {
      console.log(`PBP error ${g.game_id}: ${e.message}`);
      errors++;
    }
  }

  return {
    status: 'ok', collected, errors, batch: games.length,
    remaining: Number(remaining[0].n) - games.length,
    note: collected > 0 ? 'Run again to continue. When remaining=0, run ?phase=compute_checkpoints.' : 'No games to collect.',
    console_runner: `// Paste in browser console to auto-collect all PBP:
(async()=>{let r=999,i=0;while(r>0){i++;try{const d=await(await fetch('/.netlify/functions/backtest-wnba?phase=collect_pbp&batch=15')).json();r=d.remaining;console.log('Round '+i+': +'+d.collected+', remaining='+r);}catch(e){console.error('Round '+i+' failed:',e);await new Promise(r=>setTimeout(r,3000));}await new Promise(r=>setTimeout(r,500));}console.log('Done! Run ?phase=compute_checkpoints next.');})();`,
  };
}

// ── PHASE: COMPUTE CHECKPOINTS ──────────────────────────────────────────────
// Reconstruct box scores from PBP, compute indicators at each 2.5-min checkpoint.
async function phaseComputeCheckpoints(sql) {
  const games = await sql`
    SELECT game_id, bdl_pbp, home_alias, away_alias, winner, margin, margin_bucket
    FROM wnba_backtest WHERE bdl_pbp IS NOT NULL AND bdl_pbp != '[]'::jsonb AND checkpoint_data IS NULL
    LIMIT 50
  `;

  const remaining = await sql`
    SELECT COUNT(*) as n FROM wnba_backtest
    WHERE bdl_pbp IS NOT NULL AND bdl_pbp != '[]'::jsonb AND checkpoint_data IS NULL
  `;

  let computed = 0, errors = 0;
  for (const g of games) {
    try {
      const plays = g.bdl_pbp;
      const snaps = reconstructCheckpoints(plays, g.home_alias, g.away_alias);
      if (!snaps || snaps.length === 0) { errors++; continue; }

      // Compute indicators at each checkpoint
      const cpData = snaps.map(s => {
        const ind = computeAtCheckpoint(s, g.home_alias, g.away_alias);
        const conv = computeConviction(ind);
        return {
          label: s.cp.label, gameSec: s.cp.gameSec,
          controlTeam: ind.controlTeam, floor: ind.score,
          conviction: conv.tier, indicatorsWon: conv.indicatorsWon,
          I1: ind.I1.leader, I2: ind.I2.leader, I3: ind.I3.leader,
          I4: ind.I4.leader, I5: ind.I5.leader,
          margin: s.margin, homeScore: s.homeScore, awayScore: s.awayScore,
        };
      });

      await sql`UPDATE wnba_backtest SET checkpoint_data = ${JSON.stringify(cpData)} WHERE game_id = ${g.game_id}`;
      computed++;
    } catch (e) {
      console.log(`CP error ${g.game_id}: ${e.message}`);
      errors++;
    }
  }

  return {
    status: 'ok', computed, errors,
    remaining: Number(remaining[0].n) - games.length,
    note: 'When remaining=0, run report phases (report_cp_journey, report_cp_graduation, etc.)',
  };
}

// ── CHECKPOINT REPORTS ──────────────────────────────────────────────────────

// Report: CP Journey — control stability at 2.5-min granularity
async function reportCPJourney(sql) {
  const games = await sql`SELECT game_id, checkpoint_data, winner, home_alias, away_alias, margin, margin_bucket FROM wnba_backtest WHERE checkpoint_data IS NOT NULL`;
  if (games.length === 0) return { error: 'No checkpoint data. Run compute_checkpoints first.' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
  let total = 0;
  const cpAccuracy = {};  // per-checkpoint: ctrl team at that CP wins game?
  const floorByCP = {};
  let wireToWire = { n: 0, wins: 0 }, flipped = { n: 0, wins: 0 };
  const flipCounts = { 0: 0, 1: 0, 2: 0, '3+': 0 };

  for (const g of games) {
    const cps = g.checkpoint_data;
    if (!cps || cps.length === 0) continue;
    total++;

    // Count control flips between consecutive checkpoints
    let flips = 0;
    for (let i = 1; i < cps.length; i++) {
      if (cps[i].controlTeam !== cps[i - 1].controlTeam) flips++;
    }
    const fk = flips >= 3 ? '3+' : String(flips);
    flipCounts[fk] = (flipCounts[fk] || 0) + 1;

    const won = bdlAlias(cps[cps.length - 1].controlTeam) === g.winner || cps[cps.length - 1].controlTeam === g.winner;
    if (flips === 0) { wireToWire.n++; if (won) wireToWire.wins++; }
    else { flipped.n++; if (won) flipped.wins++; }

    for (const cp of cps) {
      const label = cp.label;
      if (!cpAccuracy[label]) cpAccuracy[label] = { n: 0, wins: 0 };
      cpAccuracy[label].n++;
      const cpWon = bdlAlias(cp.controlTeam) === g.winner || cp.controlTeam === g.winner;
      if (cpWon) cpAccuracy[label].wins++;

      if (!floorByCP[label]) floorByCP[label] = [];
      floorByCP[label].push(cp.floor);
    }
  }

  const avg = arr => arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 1000) / 1000 : 0;
  const cpReport = {};
  for (const [label, data] of Object.entries(cpAccuracy)) {
    cpReport[label] = { n: data.n, wins: data.wins, pct: pct(data.wins, data.n), avgFloor: avg(floorByCP[label] || []) };
  }

  return {
    totalGames: total,
    wireToWire: { ...wireToWire, pct: pct(wireToWire.wins, wireToWire.n) },
    flipped: { ...flipped, pct: pct(flipped.wins, flipped.n) },
    flipDistribution: flipCounts,
    checkpointAccuracy: cpReport,
  };
}

// Report: CP Graduation Sim — test MF/minF gates at 2.5-min granularity
async function reportCPGraduation(sql) {
  const games = await sql`SELECT game_id, checkpoint_data, winner, home_alias, away_alias, margin, margin_bucket FROM wnba_backtest WHERE checkpoint_data IS NOT NULL`;
  if (games.length === 0) return { error: 'No checkpoint data.' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
  const mfGates = [0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.70];
  const minFGates = [0.50, 0.55, 0.58, 0.60];

  const results = {};
  for (const mfG of mfGates) {
    for (const minFG of minFGates) {
      if (minFG > mfG) continue;
      const key = `MF${mfG}_minF${minFG}`;
      let grad = 0, gradW = 0, never = 0, neverW = 0;
      const byRank = { S: { n: 0, w: 0 }, A: { n: 0, w: 0 }, B: { n: 0, w: 0 } };
      const byCP = {};
      let flipped = 0, flippedW = 0, standard = 0, standardW = 0;

      for (const g of games) {
        const cps = g.checkpoint_data;
        if (!cps || cps.length < 2) continue;

        // Track per-team checkpoint history
        const teamCPs = {};
        let gradTeam = null, gradIdx = -1, gradRank = null, isFlip = false;

        for (let i = 0; i < cps.length; i++) {
          const cp = cps[i];
          const tm = cp.controlTeam;
          if (!teamCPs[tm]) teamCPs[tm] = [];
          teamCPs[tm].push({ idx: i, floor: cp.floor, conv: cp.conviction, margin: cp.margin, label: cp.label });

          if (gradTeam) continue; // already graduated

          const tcps = teamCPs[tm];
          if (tcps.length < 2) continue;
          const floors = tcps.map(c => c.floor);
          const mf = floors.reduce((s, v) => s + v, 0) / floors.length;
          const minF = Math.min(...floors);
          const ctrlHome = tm === cps[i].controlTeam && tm === g.home_alias; // check if ctrl is home
          const leading = ctrlHome ? cp.margin > 0 : cp.margin < 0;

          if (mf >= mfG && minF >= minFG && leading) {
            const hasDom = tcps.some(c => c.conv === 'DOMINANT');
            const hasStrong = tcps.some(c => c.conv === 'STRONG' || c.conv === 'DOMINANT');
            if (!hasStrong) continue;

            gradTeam = tm;
            gradIdx = i;
            const ctrlMargin = ctrlHome ? cp.margin : -cp.margin;
            gradRank = (hasDom && ctrlMargin >= 8) ? 'A' : 'B';

            // Check if wire-to-wire (S-rank)
            if (cps.every(c => c.controlTeam === tm) && gradRank === 'A') gradRank = 'S';

            // Check flip
            for (const [otm, otcps] of Object.entries(teamCPs)) {
              if (otm !== tm && otcps.length >= 2) {
                const omf = otcps.map(c => c.floor).reduce((s, v) => s + v, 0) / otcps.length;
                if (omf >= minFG) isFlip = true;
              }
            }
          }
        }

        const won = gradTeam && (bdlAlias(gradTeam) === g.winner || gradTeam === g.winner);
        if (gradTeam) {
          grad++; if (won) gradW++;
          byRank[gradRank].n++; if (won) byRank[gradRank].w++;
          const cpLabel = cps[gradIdx].label;
          if (!byCP[cpLabel]) byCP[cpLabel] = { n: 0, w: 0 };
          byCP[cpLabel].n++; if (won) byCP[cpLabel].w++;
          if (isFlip) { flipped++; if (won) flippedW++; }
          else { standard++; if (won) standardW++; }
        } else {
          never++;
          const lastCtrl = cps[cps.length - 1].controlTeam;
          if (bdlAlias(lastCtrl) === g.winner || lastCtrl === g.winner) neverW++;
        }
      }

      results[key] = {
        mfGate: mfG, minFGate: minFG,
        graduated: grad, gradPct: pct(gradW, grad), coverage: pct(grad, games.length),
        neverGrad: never, neverGradPct: pct(neverW, never),
        byRank: { S: { n: byRank.S.n, pct: pct(byRank.S.w, byRank.S.n) }, A: { n: byRank.A.n, pct: pct(byRank.A.w, byRank.A.n) }, B: { n: byRank.B.n, pct: pct(byRank.B.w, byRank.B.n) } },
        byCheckpoint: Object.fromEntries(Object.entries(byCP).map(([k, v]) => [k, { n: v.n, pct: pct(v.w, v.n) }])),
        flip: { standard, standardPct: pct(standardW, standard), flipped, flippedPct: pct(flippedW, flipped) },
      };
    }
  }

  const ranked = Object.values(results).filter(r => r.graduated >= 20)
    .sort((a, b) => ((b.gradPct / 100) * (b.coverage / 100)) - ((a.gradPct / 100) * (a.coverage / 100)));

  return {
    totalGames: games.length,
    note: '2.5-min checkpoints across Q2-Q4. Graduation: 2+ CPs same team, MF>=gate, minF>=gate, leading, conviction>=STRONG.',
    bestCombos: ranked.slice(0, 10).map(r => ({
      gates: `MF=${r.mfGate} minF=${r.minFGate}`, accuracy: r.gradPct + '%', coverage: r.coverage + '%',
      score: Math.round((r.gradPct / 100) * (r.coverage / 100) * 1000) / 10,
      graduated: r.graduated, byRank: r.byRank,
    })),
    allResults: results,
  };
}

// Report: CP Trailing Profile — BUY profile at 2.5-min checkpoints
async function reportCPTrailing(sql) {
  const games = await sql`SELECT game_id, checkpoint_data, winner, home_alias, away_alias, margin, margin_bucket FROM wnba_backtest WHERE checkpoint_data IS NOT NULL`;
  if (games.length === 0) return { error: 'No checkpoint data.' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
  const byDeficit = {}, byIndicators = {}, byConviction = {}, byCP = {};
  const goldenStack = { n: 0, wins: 0 };
  const i3Won = { n: 0, wins: 0 }, i3Lost = { n: 0, wins: 0 };

  for (const g of games) {
    for (const cp of (g.checkpoint_data || [])) {
      const ctrlHome = cp.controlTeam === g.home_alias;
      const ctrlMargin = ctrlHome ? cp.margin : -cp.margin;
      if (ctrlMargin >= 0) continue; // only trailing

      const deficit = Math.abs(ctrlMargin);
      const won = bdlAlias(cp.controlTeam) === g.winner || cp.controlTeam === g.winner;
      const indCount = cp.indicatorsWon?.length || 0;

      // By checkpoint
      if (!byCP[cp.label]) byCP[cp.label] = { n: 0, w: 0 };
      byCP[cp.label].n++; if (won) byCP[cp.label].w++;

      // By deficit
      const dk = deficit <= 4 ? '1-4' : deficit <= 7 ? '5-7' : deficit <= 10 ? '8-10' : deficit <= 15 ? '11-15' : '16+';
      if (!byDeficit[dk]) byDeficit[dk] = { n: 0, w: 0 };
      byDeficit[dk].n++; if (won) byDeficit[dk].w++;

      // By indicator count
      const ik = indCount + '_ind';
      if (!byIndicators[ik]) byIndicators[ik] = { n: 0, w: 0 };
      byIndicators[ik].n++; if (won) byIndicators[ik].w++;

      // By conviction
      if (!byConviction[cp.conviction]) byConviction[cp.conviction] = { n: 0, w: 0 };
      byConviction[cp.conviction].n++; if (won) byConviction[cp.conviction].w++;

      // Golden stack
      // For opp indicators, we'd need more data. Approximate: if indCount >= 3, check conviction
      if (deficit >= 1 && deficit <= 4 && indCount >= 3) {
        goldenStack.n++; if (won) goldenStack.wins++;
      }

      // I3 inversion
      if (cp.I3 === cp.controlTeam) { i3Won.n++; if (won) i3Won.wins++; }
      else if (cp.I3 !== 'EVEN') { i3Lost.n++; if (won) i3Lost.wins++; }
    }
  }

  const addPct = obj => { for (const v of Object.values(obj)) v.pct = pct(v.w || v.wins, v.n); };
  addPct(byDeficit); addPct(byIndicators); addPct(byConviction); addPct(byCP);
  goldenStack.pct = pct(goldenStack.wins, goldenStack.n);
  i3Won.pct = pct(i3Won.wins, i3Won.n);
  i3Lost.pct = pct(i3Lost.wins, i3Lost.n);

  return {
    totalGames: games.length,
    note: 'Ctrl team trailing at each 2.5-min checkpoint. Measures comeback rate.',
    byCheckpoint: byCP, byDeficit, byIndicatorCount: byIndicators, byConviction,
    goldenStack: { ...goldenStack, note: 'trail 1-4 + 3+ indicators' },
    i3Inversion: { ctrlWinsI3: i3Won, ctrlLosesI3: i3Lost,
      note: 'NBA: winning I3 while trailing = 37.3% (negative signal). Check WNBA.' },
  };
}

// Report: CP Indicator Stability — per-indicator hold rates at 2.5-min granularity
async function reportCPStability(sql) {
  const games = await sql`SELECT game_id, checkpoint_data, winner, home_alias, away_alias, margin, margin_bucket FROM wnba_backtest WHERE checkpoint_data IS NOT NULL`;
  if (games.length === 0) return { error: 'No checkpoint data.' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
  const indicators = ['I1', 'I2', 'I3', 'I4', 'I5'];
  const stability = {};
  for (const ik of indicators) {
    stability[ik] = {
      early_to_final: { n: 0, held: 0 },   // Q2_7.5 leader → final leader
      mid_to_final: { n: 0, held: 0 },      // Q3_END leader → final
      late_to_final: { n: 0, held: 0 },      // Q4_5 leader → final
      flipRate: { n: 0, flips: 0 },
      evenCount: 0,
    };
  }
  let total = 0;

  for (const g of games) {
    const cps = g.checkpoint_data;
    if (!cps || cps.length < 2) continue;
    total++;
    const last = cps[cps.length - 1];

    for (const ik of indicators) {
      const leaders = cps.map(c => c[ik]);
      const finalL = last[ik];

      // Early (first CP) → final
      if (leaders[0] !== 'EVEN' && finalL !== 'EVEN') {
        stability[ik].early_to_final.n++;
        if (leaders[0] === finalL) stability[ik].early_to_final.held++;
      }

      // Mid (Q3_END, index ~7) → final
      const midIdx = cps.findIndex(c => c.label === 'Q3_END');
      if (midIdx >= 0 && leaders[midIdx] !== 'EVEN' && finalL !== 'EVEN') {
        stability[ik].mid_to_final.n++;
        if (leaders[midIdx] === finalL) stability[ik].mid_to_final.held++;
      }

      // Late (Q4_5, index ~9) → final
      const lateIdx = cps.findIndex(c => c.label === 'Q4_5');
      if (lateIdx >= 0 && leaders[lateIdx] !== 'EVEN' && finalL !== 'EVEN') {
        stability[ik].late_to_final.n++;
        if (leaders[lateIdx] === finalL) stability[ik].late_to_final.held++;
      }

      // Flip rate
      for (let i = 1; i < cps.length; i++) {
        if (leaders[i] !== 'EVEN' && leaders[i - 1] !== 'EVEN') {
          stability[ik].flipRate.n++;
          if (leaders[i] !== leaders[i - 1]) stability[ik].flipRate.flips++;
        }
      }

      stability[ik].evenCount += leaders.filter(l => l === 'EVEN').length;
    }
  }

  const report = {};
  for (const ik of indicators) {
    const s = stability[ik];
    report[ik] = {
      early_holds: { ...s.early_to_final, pct: pct(s.early_to_final.held, s.early_to_final.n) },
      mid_holds: { ...s.mid_to_final, pct: pct(s.mid_to_final.held, s.mid_to_final.n) },
      late_holds: { ...s.late_to_final, pct: pct(s.late_to_final.held, s.late_to_final.n) },
      flipRate: { ...s.flipRate, pct: pct(s.flipRate.flips, s.flipRate.n) },
      avgEvensPerGame: total > 0 ? Math.round(s.evenCount / total * 10) / 10 : 0,
    };
  }

  return {
    totalGames: total,
    note: 'Stability at 2.5-min checkpoints. Early=Q2_7.5, Mid=Q3_END, Late=Q4_5.',
    indicators: report,
    summary: indicators.map(i => ({
      indicator: i, earlyStability: report[i].early_holds.pct + '%',
      midStability: report[i].mid_holds.pct + '%', flipRate: report[i].flipRate.pct + '%',
    })),
  };
}

// Report: CP Close Game — test close-game filters with checkpoint data
async function reportCPClose(sql) {
  const games = await sql`SELECT game_id, checkpoint_data, winner, home_alias, away_alias, margin, margin_bucket FROM wnba_backtest WHERE checkpoint_data IS NOT NULL`;
  if (games.length === 0) return { error: 'No checkpoint data.' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;

  // Get Q3_END margin and final margin from checkpoint data
  const gameData = games.map(g => {
    const cps = g.checkpoint_data || [];
    const q3End = cps.find(c => c.label === 'Q3_END');
    const last = cps[cps.length - 1];
    return {
      q3Margin: q3End ? Math.abs(q3End.margin) : null,
      finalMargin: Math.abs(g.margin),
      ctrlWon: last && (bdlAlias(last.controlTeam) === g.winner || last.controlTeam === g.winner),
      conviction: last?.conviction,
    };
  });

  const filters = [
    { name: 'NBA standard (Q3≤5, final≤7)', q3: 5, fin: 7 },
    { name: 'Tight (Q3≤4, final≤6)', q3: 4, fin: 6 },
    { name: 'Tighter (Q3≤3, final≤5)', q3: 3, fin: 5 },
    { name: 'Final ≤5 only', q3: 999, fin: 5 },
    { name: 'Final ≤7 only', q3: 999, fin: 7 },
    { name: 'Final ≤10 only', q3: 999, fin: 10 },
  ];

  return {
    totalGames: gameData.length,
    results: filters.map(f => {
      const close = gameData.filter(gd => (f.q3 >= 999 || (gd.q3Margin != null && gd.q3Margin <= f.q3)) && gd.finalMargin <= f.fin);
      const wins = close.filter(gd => gd.ctrlWon).length;
      const byTier = {};
      for (const gd of close) {
        const t = gd.conviction || '?';
        if (!byTier[t]) byTier[t] = { n: 0, w: 0 };
        byTier[t].n++; if (gd.ctrlWon) byTier[t].w++;
      }
      for (const v of Object.values(byTier)) v.pct = pct(v.w, v.n);
      return { filter: f.name, games: close.length, pctOfTotal: pct(close.length, gameData.length), accuracy: pct(wins, close.length), byTier };
    }),
  };
}

// ── REPORT: RECONSTRUCTION VALIDATION ────────────────────────────────────────
// Compare PBP full-game reconstruction to SR full-game indicators for 203 overlap games.
// Answers: is the PBP parsing faithful, or is data quality inflating the gap?
async function reportReconstructionValidation(sql) {
  const games = await sql`
    SELECT game_id, home_alias, away_alias, winner, margin, indicators, bdl_pbp
    FROM wnba_backtest
    WHERE indicators IS NOT NULL AND bdl_pbp IS NOT NULL AND bdl_pbp != '[]'::jsonb
  `;
  if (games.length === 0) return { error: 'No games with both SR indicators and BDL PBP.' };

  const pct = (w, n) => n > 0 ? Math.round(w / n * 1000) / 10 : 0;
  let total = 0, ctrlAgree = 0, convAgree = 0;
  const indAgree = { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0 };
  const indN = { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0 };
  const floorDiffs = [];
  const disagrees = [];
  // Per-indicator stat comparison
  const statDiffs = { stl: [], blk: [], pot: [], fg3pct: [], fta: [], efg: [], ast: [], bigLead: [], reb: [] };

  for (const g of games) {
    const srInd = g.indicators;
    const plays = g.bdl_pbp;
    if (!srInd || !plays || plays.length === 0) continue;

    // Reconstruct full game from PBP
    const sorted = plays.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const mk = () => ({ fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0,
      oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pot: 0 });
    const h = mk(), a = mk();
    let bigH = 0, bigA = 0, pendPOT = null, lastPeriod = 0;

    for (const ev of sorted) {
      const period = ev.period || 1;
      if (period !== lastPeriod) { pendPOT = null; lastPeriod = period; }
      const tm = ev.team?.abbreviation || '';
      if (!tm) continue;
      const isH = tm === g.home_alias;
      const s = isH ? h : a;
      const opp = isH ? g.away_alias : g.home_alias;
      const type = (ev.type || '').toLowerCase();
      const text = (ev.text || '').toLowerCase();

      if (ev.home_score != null && ev.away_score != null) {
        const mg = ev.home_score - ev.away_score;
        if (mg > bigH) bigH = mg;
        if (-mg > bigA) bigA = -mg;
      }
      if (type.includes('substitution') || text.includes('enters the game')) continue;

      if (type.includes('free throw')) {
        s.fta++;
        if (ev.scoring_play || text.includes('makes')) { s.ftm++; if (pendPOT === tm) s.pot += 1; }
        continue;
      }
      const isShotType = type.includes('shot') || type.includes('layup') || type.includes('dunk') ||
        type.includes('hook') || type.includes('tip') || type.includes('alley') || type.includes('finger roll') ||
        type.includes('pullup') || type.includes('driving') || type.includes('fadeaway') ||
        type.includes('float') || type.includes('runner') || type.includes('step back') ||
        type.includes('turnaround') || type.includes('cutting') || type.includes('putback');
      const isMadeFG = ev.scoring_play && ev.score_value >= 2;
      if (isShotType || isMadeFG || (text.includes('misses') && !type.includes('free throw'))) {
        const is3 = ev.score_value === 3 || type.includes('three point') || type.includes('3-point') || type.includes('3pt');
        s.fga++; if (is3) s.fg3a++;
        if (isMadeFG || text.includes('makes')) {
          s.fgm++; if (is3) s.fg3m++;
          if (text.includes('assist')) s.ast++;
          if (pendPOT === tm) s.pot += (is3 ? 3 : 2);
          pendPOT = null;
        }
        continue;
      }
      if (type.includes('turnover') || type.includes('offensive foul')) { s.tov++; pendPOT = opp; continue; }
      if (type.includes('rebound')) {
        if (type.includes('offensive') || text.includes('offensive')) s.oreb++;
        else { s.dreb++; pendPOT = null; }
        continue;
      }
      if (type.includes('steal')) { s.stl++; continue; }
      if (type.includes('block')) { s.blk++; continue; }
      if (type.includes('foul') && !type.includes('offensive')) { s.pf++; continue; }
    }

    // Build snapshot and compute indicators
    const lastPlay = sorted[sorted.length - 1];
    const cpSnap = {
      home: { ...h, biggest_lead: bigH, three_points_pct: h.fg3a > 0 ? h.fg3m / h.fg3a * 100 : 0 },
      away: { ...a, biggest_lead: bigA, three_points_pct: a.fg3a > 0 ? a.fg3m / a.fg3a * 100 : 0 },
      homeScore: lastPlay?.home_score || 0, awayScore: lastPlay?.away_score || 0,
      margin: (lastPlay?.home_score || 0) - (lastPlay?.away_score || 0),
    };
    const pbpInd = computeAtCheckpoint(cpSnap, g.home_alias, g.away_alias);
    const pbpConv = computeConviction(pbpInd);
    const srConv = computeConviction(srInd);
    total++;

    // Compare control team
    if (pbpInd.controlTeam === srInd.controlTeam) ctrlAgree++;

    // Compare conviction
    if (pbpConv.tier === srConv.tier) convAgree++;

    // Compare each indicator leader
    for (const ik of ['I1', 'I2', 'I3', 'I4', 'I5']) {
      const srLeader = srInd[ik]?.leader || 'EVEN';
      const pbpLeader = pbpInd[ik]?.leader || 'EVEN';
      indN[ik]++;
      if (srLeader === pbpLeader) indAgree[ik]++;
    }

    // Floor diff
    const floorDiff = Math.abs(pbpInd.score - srInd.score);
    floorDiffs.push(floorDiff);

    // Raw stat comparison for diagnostics
    const srS = srInd;
    // SR uses full stats object, PBP uses reconstructed
    // Compare key sub-metric inputs
    const srHome = srS.I1?.detail || {};
    statDiffs.stl.push(Math.abs((h.stl + h.blk) - (a.stl + a.blk) - (srHome.disruptDiff || 0)));
    statDiffs.pot.push(Math.abs((h.pot - a.pot) - (srHome.potDiff || 0)));
    const srI2 = srS.I2?.detail || {};
    const pbp3Diff = (h.fg3a > 0 ? h.fg3m / h.fg3a * 100 : 0) - (a.fg3a > 0 ? a.fg3m / a.fg3a * 100 : 0);
    statDiffs.fg3pct.push(Math.abs(pbp3Diff - (srI2.threePctDiff || 0)));
    statDiffs.fta.push(Math.abs((h.fta - a.fta) - (srI2.ftaDiff || 0)));
    const srI3 = srS.I3?.detail || {};
    const hEFG = h.fga > 0 ? (h.fgm + 0.5 * h.fg3m) / h.fga : 0;
    const aEFG = a.fga > 0 ? (a.fgm + 0.5 * a.fg3m) / a.fga : 0;
    statDiffs.efg.push(Math.abs((hEFG - aEFG) - (srI3.efgDiff || 0)));
    statDiffs.ast.push(Math.abs((h.ast - a.ast) - (srI3.astDiff || 0)));
    const srI4 = srS.I4?.detail || {};
    statDiffs.bigLead.push(Math.abs((bigH - bigA) - (srI4.bigLeadDiff || 0)));
    statDiffs.reb.push(Math.abs((h.oreb + h.dreb - a.oreb - a.dreb)));

    // Log disagreements for inspection
    if (pbpInd.controlTeam !== srInd.controlTeam) {
      disagrees.push({
        game: `${g.away_alias}@${g.home_alias}`,
        srCtrl: srInd.controlTeam, pbpCtrl: pbpInd.controlTeam,
        srFloor: srInd.score, pbpFloor: pbpInd.score,
        srConv: srConv.tier, pbpConv: pbpConv.tier,
        indicators: ['I1','I2','I3','I4','I5'].map(ik => ({
          ind: ik, sr: srInd[ik]?.leader, pbp: pbpInd[ik]?.leader,
          agree: srInd[ik]?.leader === pbpInd[ik]?.leader,
        })),
        statGaps: {
          disruption: Math.abs((h.stl+h.blk)-(a.stl+a.blk) - (srHome.disruptDiff||0)),
          pot: Math.abs((h.pot-a.pot) - (srHome.potDiff||0)),
          efg: Math.round(Math.abs((hEFG-aEFG) - (srI3.efgDiff||0)) * 1000) / 1000,
          assists: Math.abs((h.ast-a.ast) - (srI3.astDiff||0)),
          bigLead: Math.abs((bigH-bigA) - (srI4.bigLeadDiff||0)),
          fta: Math.abs((h.fta-a.fta) - (srI2.ftaDiff||0)),
        },
      });
    }
  }

  const avg = arr => arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 100) / 100 : 0;
  const med = arr => { if (arr.length === 0) return 0; const s = arr.slice().sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };

  return {
    totalOverlap: total,
    controlTeamAgreement: { agree: ctrlAgree, total, pct: pct(ctrlAgree, total) },
    convictionAgreement: { agree: convAgree, total, pct: pct(convAgree, total) },
    indicatorAgreement: Object.fromEntries(
      ['I1','I2','I3','I4','I5'].map(ik => [ik, { agree: indAgree[ik], total: indN[ik], pct: pct(indAgree[ik], indN[ik]) }])
    ),
    floorDiff: { avg: avg(floorDiffs), median: med(floorDiffs), max: Math.round(Math.max(...floorDiffs) * 100) / 100 },
    statDiffs: {
      note: 'Average absolute difference between PBP-reconstructed and SR values for key sub-metrics',
      disruption_diff: avg(statDiffs.stl),
      pot_diff: avg(statDiffs.pot),
      fg3pct_diff: avg(statDiffs.fg3pct),
      fta_diff: avg(statDiffs.fta),
      efg_diff: avg(statDiffs.efg),
      assists_diff: avg(statDiffs.ast),
      biggest_lead_diff: avg(statDiffs.bigLead),
    },
    controlDisagrees: disagrees.slice(0, 15),
  };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async (req) => {
  const sql = neon(process.env.DATABASE_URL);
  const url = new URL(req.url);
  const phase = url.searchParams.get('phase') || 'report';

  try {
    let result;
    switch (phase) {
      case 'init':    result = await phaseInit(sql); break;
      case 'reset':   result = await phaseReset(sql); break;
      case 'status':  result = await phaseStatus(sql); break;
      case 'diagnose': result = await phaseDiagnose(sql, url); break;
      case 'collect': result = await phaseCollect(sql); break;
      case 'sample':  result = await phaseSample(sql, url); break;
      case 'compute': result = await phaseCompute(sql); break;
      case 'report':  result = await phaseReport(sql); break;
      case 'explore': result = await phaseExplore(sql); break;
      case 'report_quarter_journey': result = await reportQuarterJourney(sql); break;
      case 'report_graduation_sim': result = await reportGraduationSim(sql); break;
      case 'report_close_game': result = await reportCloseGame(sql); break;
      case 'report_trailing_profile': result = await reportTrailingProfile(sql); break;
      case 'report_indicator_stability': result = await reportIndicatorStability(sql); break;
      case 'collect_pbp':       result = await phaseCollectPBP(sql, url); break;
      case 'compute_checkpoints': result = await phaseComputeCheckpoints(sql); break;
      case 'report_cp_journey': result = await reportCPJourney(sql); break;
      case 'report_cp_graduation': result = await reportCPGraduation(sql); break;
      case 'report_cp_trailing': result = await reportCPTrailing(sql); break;
      case 'report_cp_stability': result = await reportCPStability(sql); break;
      case 'report_cp_close':   result = await reportCPClose(sql); break;
      case 'report_validate_reconstruction': result = await reportReconstructionValidation(sql); break;
      default:
        result = { error: `Unknown phase: ${phase}. Phases: init, collect, sample, compute, report, explore, collect_pbp, compute_checkpoints, report_cp_journey, report_cp_graduation, report_cp_trailing, report_cp_stability, report_cp_close` };
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

export const config = { path: '/.netlify/functions/backtest-wnba' };
