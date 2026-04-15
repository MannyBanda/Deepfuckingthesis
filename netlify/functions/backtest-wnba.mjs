// WNBA Backtest — Indicator Validation Against 2025 Season
// BDL-primary (60 calls/s), SR-targeted (1 call/s, cached)
//
// Phases:
//   ?phase=init     — Create wnba_backtest table
//   ?phase=collect  — BDL: pull all 2025 games + team_stats, cache to DB
//   ?phase=sample   — SR: fetch 50 stratified game summaries, cache to DB
//   ?phase=compute  — Run computeServer + computeConviction on cached data
//   ?phase=report   — Return validation report
//
// Delete this file after WNBA calibration is complete.

import { neon } from '@neondatabase/serverless';

const BDL_BASE = 'https://api.balldontlie.io';
const BDL_KEY = process.env.BDL_API_KEY;
const SR_BASE = 'https://api.sportradar.com/wnba/trial/v8/en/';
const SR_KEY = process.env.SR_API_KEY; // same key covers NBA + WNBA

const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

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
  NYL: 'NY', WAS: 'WSH', LVA: 'LV', CON: 'CT',
  ATL: 'ATL', IND: 'IND', CHI: 'CHI', MIN: 'MIN',
  PHX: 'PHX', SEA: 'SEA', DAL: 'DAL', LAS: 'LA',
  PDX: 'POR', TOY: 'TOR', GSV: 'GSV',
};
function bdlAlias(srAlias) { return SR_TO_BDL[srAlias] || srAlias; }

// ── computeServer (copied from poll-live-bdl.mjs — Netlify bundles separately) ──
function computeServer(summary) {
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hA = H.alias || H.name || 'HOME', aA = A.alias || A.name || 'AWAY';
  const hS = H.points || 0, aS = A.points || 0;
  if (hS === 0 && aS === 0) return null;

  // I1 — Disruption & Conversion
  const hDisrupt = (hs.steals || 0) + (hs.blocks || 0);
  const aDisrupt = (as.steals || 0) + (as.blocks || 0);
  const disruptDiff = hDisrupt - aDisrupt;
  const i1subA = disruptDiff > 1 ? 1 : disruptDiff < -1 ? -1 : 0;
  const hPOT = hs.points_off_turnovers || 0, aPOT = as.points_off_turnovers || 0;
  const potDiff = hPOT - aPOT;
  const i1subB = potDiff > 4 ? 1 : potDiff < -4 ? -1 : 0;
  const i1raw = i1subA + i1subB;
  const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? hA : i1raw < 0 ? aA : 'EVEN' };

  // I2 — Interior Control
  const hPaint = hs.points_in_the_paint || hs.points_in_paint || 0;
  const aPaint = as.points_in_the_paint || as.points_in_paint || 0;
  const paintDiff = hPaint - aPaint;
  let i2subA = 0;
  if (paintDiff > 6) i2subA = 1;
  else if (paintDiff < -6) i2subA = -1;
  const hRimM = hs.field_goals_at_rim_made || 0, hRimA = hs.field_goals_at_rim_att || 0;
  const aRimM = as.field_goals_at_rim_made || 0, aRimA = as.field_goals_at_rim_att || 0;
  const hRimPct = hRimA >= 6 ? hRimM / hRimA : null;
  const aRimPct = aRimA >= 6 ? aRimM / aRimA : null;
  let i2subB = 0;
  if (hRimPct != null && aRimPct != null) {
    if (hRimPct - aRimPct > 0.10) i2subB = 1;
    else if (aRimPct - hRimPct > 0.10) i2subB = -1;
  }
  const i2raw = i2subA + i2subB;
  const I2 = { score: i2raw > 0 ? 1 : i2raw < 0 ? 0 : 0.5, leader: i2raw > 0 ? hA : i2raw < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation
  const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
  const hEFG = ((hs.field_goals_made || 0) + 0.5 * (hs.three_points_made || 0)) / hFGA;
  const aEFG = ((as.field_goals_made || 0) + 0.5 * (as.three_points_made || 0)) / aFGA;
  const hAst = hs.assists || 0, aAst = as.assists || 0;
  const hFGM = hs.field_goals_made || 1, aFGM = as.field_goals_made || 1;
  const hAR = (hAst / hFGM) * 100, aAR = (aAst / aFGM) * 100;
  // No PBP in backtest — skip C&S 3PM component
  const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
              + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? hA : i3raw < 0 ? aA : 'EVEN' };

  // I4 — Game Control
  const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
  const bigLeadDiff = hBigLead - aBigLead;
  const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
  // I4 subB — last quarter scoring diff (completed games always have 4+ periods)
  let i4subB = 0;
  // Build periods from scoring arrays
  const hScoring = H.scoring || [];
  const aScoring = A.scoring || [];
  if (hScoring.length >= 4) {
    const lastQ = hScoring.length; // last quarter/OT
    const hLastPts = hScoring[lastQ - 1]?.points || 0;
    const aLastPts = aScoring[lastQ - 1]?.points || 0;
    const lastQDiff = hLastPts - aLastPts;
    i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
  }
  const i4raw = i4subA + i4subB;
  const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? hA : i4raw < 0 ? aA : 'EVEN' };

  // I5 — Sustained Execution
  // Backtest v1: use offensive/defensive rating differential as proxy (no PBP runs)
  let I5 = { score: 0.5, leader: 'EVEN' };
  const hOffRtg = hs.offensive_rating || hs.offensive_points_per_possession || 0;
  const aOffRtg = as.offensive_rating || as.offensive_points_per_possession || 0;
  const hDefRtg = hs.defensive_rating || hs.defensive_points_per_possession || 0;
  const aDefRtg = as.defensive_rating || as.defensive_points_per_possession || 0;
  if (hOffRtg > 0 && aOffRtg > 0) {
    const hNetRtg = hOffRtg - hDefRtg;
    const aNetRtg = aOffRtg - aDefRtg;
    const netDiff = hNetRtg - aNetRtg;
    I5 = {
      score: netDiff > 3 ? 1 : netDiff < -3 ? 0 : 0.5,
      leader: netDiff > 3 ? hA : netDiff < -3 ? aA : 'EVEN',
      source: 'net_rating'
    };
  }

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

// ── computeConviction (copied from poll-live-bdl.mjs) ────────────────────────
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
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000; // 100s of 120s timeout — leave margin

  // Stratified sample: pick from each margin bucket proportionally
  // Close games are most important for indicator validation
  const sampleGames = await sql`
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

  console.log(`Sample: ${sampleGames.length} games selected for SR fetch`);

  if (sampleGames.length === 0) {
    const total = await sql`SELECT COUNT(*) as count FROM wnba_backtest WHERE sr_summary IS NOT NULL`;
    return { status: 'ok', message: 'No more games to sample — all have SR data', totalWithSR: Number(total[0].count) };
  }

  // Group by date for efficient SR schedule fetching
  const dateGames = {};
  for (const g of sampleGames) {
    const d = g.date;
    if (!dateGames[d]) dateGames[d] = [];
    dateGames[d].push(g);
  }

  let fetched = 0, errors = 0, skippedTimeout = 0;

  for (const [dateStr, games] of Object.entries(dateGames)) {
    // Time budget check
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      skippedTimeout += games.length;
      console.log(`Time budget exceeded — skipping ${dateStr}`);
      continue;
    }

    const [year, month, day] = dateStr.split('-');
    const schedResp = await srFetch(`games/${year}/${month}/${day}/schedule.json`);
    await delay(1200);

    if (!schedResp?.games) {
      console.log(`SR schedule empty for ${dateStr}`);
      errors += games.length;
      continue;
    }

    // Match each BDL game to an SR game
    for (const g of games) {
      // Time check before each summary fetch
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        skippedTimeout++;
        continue;
      }

      // Find SR game by matching team aliases
      const srGame = schedResp.games.find(sg => {
        const srHome = sg.home?.alias;
        const srAway = sg.away?.alias;
        const bdlHome = g.home_alias;
        const bdlAway = g.away_alias;
        return (bdlAlias(srHome) === bdlHome && bdlAlias(srAway) === bdlAway)
            || (srHome === bdlHome && srAway === bdlAway);
      });

      if (!srGame) {
        console.log(`No SR match for ${g.away_alias}@${g.home_alias} on ${dateStr}`);
        errors++;
        continue;
      }

      if (srGame.status !== 'closed') {
        console.log(`SR game ${srGame.id} not closed (${srGame.status})`);
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
      console.log(`✓ ${g.away_alias}@${g.home_alias} (${dateStr}) — SR ${srGame.id}`);
    }
  }

  const ready = await sql`SELECT COUNT(*) as count FROM wnba_backtest WHERE sr_summary IS NOT NULL`;

  return {
    status: 'ok',
    attempted: sampleGames.length,
    fetched,
    errors,
    skippedTimeout,
    totalWithSR: Number(ready[0].count),
    uniqueDates: Object.keys(dateGames).length,
    srCallsMade: fetched + Object.keys(dateGames).length,
    elapsed: `${Math.round((Date.now() - startTime) / 1000)}s`,
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
      const ctrlTeamWon = ind.controlTeam === g.winner;

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

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async (req) => {
  const sql = neon(process.env.DATABASE_URL);
  const url = new URL(req.url);
  const phase = url.searchParams.get('phase') || 'report';

  try {
    let result;
    switch (phase) {
      case 'init':    result = await phaseInit(sql); break;
      case 'collect': result = await phaseCollect(sql); break;
      case 'sample':  result = await phaseSample(sql, url); break;
      case 'compute': result = await phaseCompute(sql); break;
      case 'report':  result = await phaseReport(sql); break;
      case 'explore': result = await phaseExplore(sql); break;
      default:
        result = { error: `Unknown phase: ${phase}. Use init, collect, sample, compute, explore, or report.` };
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
