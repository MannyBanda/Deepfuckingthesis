// ══════════════════════════════════════════════════════════════════════════════
// poll-live.mjs — Server-Side Live Game Polling (Netlify Scheduled Function v2)
//
// Runs every 2 minutes via cron. For each live NBA game:
//   1. Fetch SR game summary
//   2. Compute I1–I5 indicators (server-side, no browser globals)
//   3. Fetch ESPN Win Probability
//   4. Save snapshot to Neon Postgres
//
// This guarantees continuous data capture even when the client device is asleep.
// ══════════════════════════════════════════════════════════════════════════════

import { neon } from '@neondatabase/serverless';

// ── CONFIG ──────────────────────────────────────────────────────────────────

const LEAGUES = {
  nba: {
    srBase: 'https://api.sportradar.com/nba/trial/v8/en/',
    srKeyEnv: 'SR_API_KEY',
    espnSlug: 'nba',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary',
    season: '2025',
    aliasMap: { NOP: 'NO', GSW: 'GS', NYK: 'NY', SAS: 'SA', PHX: 'PHO', BKN: 'BKN' },
  },
  // ncaamb: { ... } — add when ready
};

const W = { I1: 0.25, I2: 0.25, I3: 0.20, I4: 0.20, I5: 0.10 };

const SR_DELAY_MS = 1400; // respect trial tier rate limit

// ── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function today() {
  // Use ET for game dates (NBA schedule is ET-based)
  const now = new Date();
  // Simple ET approximation: UTC-5 (close enough for date boundaries)
  const et = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  // NBA: games after midnight ET still belong to previous slate
  // If before 6 AM ET, use yesterday's date
  if (et.getUTCHours() < 6) {
    et.setUTCDate(et.getUTCDate() - 1);
  }
  return {
    year: et.getUTCFullYear(),
    month: et.getUTCMonth() + 1,
    day: et.getUTCDate(),
  };
}

function log(msg) {
  console.log(`[poll-live] ${msg}`);
}

// ── SR FETCH ────────────────────────────────────────────────────────────────

async function srFetch(league, path) {
  const cfg = LEAGUES[league];
  const apiKey = process.env[cfg.srKeyEnv];
  if (!apiKey) throw new Error(`${cfg.srKeyEnv} not configured`);
  const url = `${cfg.srBase}${path}?api_key=${apiKey}`;
  const resp = await fetch(url);
  if (resp.status === 429) throw new Error('SR rate limited');
  if (!resp.ok) throw new Error(`SR ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  return resp.json();
}

// ── ESPN FETCH ──────────────────────────────────────────────────────────────

async function espnScoreboard(league, dateStr) {
  const cfg = LEAGUES[league];
  const url = `${cfg.espnBase}scoreboard?dates=${dateStr}`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.events || []).map(ev => {
    const comp = ev.competitions?.[0] || {};
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    return {
      espnId: ev.id,
      homeAbbr: home?.team?.abbreviation || '',
      awayAbbr: away?.team?.abbreviation || '',
      status: ev.status?.type?.name || '',
    };
  });
}

async function espnWinProb(league, espnEventId) {
  const cfg = LEAGUES[league];
  const url = `${cfg.espnSummaryBase}?event=${espnEventId}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const wp = data.winprobability || [];
    if (wp.length === 0) return null;
    const latest = wp[wp.length - 1];
    const homeWP = latest.homeWinPercentage;
    if (homeWP == null) return null;
    return {
      home: Math.round(homeWP * 100),
      away: 100 - Math.round(homeWP * 100),
    };
  } catch (e) {
    log(`ESPN WP error for ${espnEventId}: ${e.message}`);
    return null;
  }
}

// ── SERVER-SIDE COMPUTE (I1–I5) ─────────────────────────────────────────────
// Pure function. No cardState, no DOM, no PBP, no baselines.
// Input: SR game summary JSON. Output: indicator scores + composite.

function computeServer(summary) {
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hA = H.alias || H.name || 'HOME', aA = A.alias || A.name || 'AWAY';
  const hS = H.points || 0, aS = A.points || 0;
  if (hS === 0 && aS === 0) return null;

  // I1 — Possession & Transition
  const hTO = hs.turnovers || hs.total_turnovers || 0;
  const aTO = as.turnovers || as.total_turnovers || 0;
  const hGen = (hs.steals || 0) + (hs.offensive_rebounds || 0) - hTO;
  const aGen = (as.steals || 0) + (as.offensive_rebounds || 0) - aTO;
  const hConv = (hs.fast_break_points || 0) + (hs.points_off_turnovers || 0) + (hs.second_chance_points || 0);
  const aConv = (as.fast_break_points || 0) + (as.points_off_turnovers || 0) + (as.second_chance_points || 0);
  const i1raw = (hGen > aGen ? 1 : hGen < aGen ? -1 : 0) + (hConv > aConv ? 1 : hConv < aConv ? -1 : 0);
  const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? hA : i1raw < 0 ? aA : 'EVEN' };

  // I2 — Rim Pressure & Foul
  const hPaint = hs.points_in_the_paint || hs.points_in_paint || 0;
  const aPaint = as.points_in_the_paint || as.points_in_paint || 0;
  const hAtRim = hs.field_goals_at_rim_att || 0, aAtRim = as.field_goals_at_rim_att || 0;
  const hFTA = hs.free_throws_att || 0, aFTA = as.free_throws_att || 0;
  const hBlk = hs.blocks || 0, aBlk = as.blocks || 0;
  const hFD = hs.fouls_drawn || 0, aFD = as.fouls_drawn || 0;
  const rimScore = (hPaint + hAtRim + hFTA + hBlk + Math.round(hFD * 0.5))
                 - (aPaint + aAtRim + aFTA + aBlk + Math.round(aFD * 0.5));
  const I2 = { score: rimScore > 10 ? 1 : rimScore < -10 ? 0 : 0.5, leader: rimScore > 10 ? hA : rimScore < -10 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation
  const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
  const hEFG = ((hs.field_goals_made || 0) + 0.5 * (hs.three_points_made || 0)) / hFGA;
  const aEFG = ((as.field_goals_made || 0) + 0.5 * (as.three_points_made || 0)) / aFGA;
  const hAst = hs.assists || 0, aAst = as.assists || 0;
  const hFGM = hs.field_goals_made || 1, aFGM = as.field_goals_made || 1;
  const hAR = (hAst / hFGM) * 100, aAR = (aAst / aFGM) * 100;
  const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
              + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? hA : i3raw < 0 ? aA : 'EVEN' };

  // I4 — Lineup Integrity
  const periods = summary.periods || [];
  const qDs = periods.map(p => (p.home_points || 0) - (p.away_points || 0));
  const trend = qDs.length >= 2 ? qDs[qDs.length - 1] - qDs[0] : 0;
  const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
  const hBench = hs.bench_points || 0, aBench = as.bench_points || 0;
  const benchD = hBench - aBench;
  const i4raw = (hBigLead > aBigLead + 4 ? 1 : hBigLead < aBigLead - 4 ? -1 : 0)
              + (trend > 2 ? 1 : trend < -2 ? -1 : 0)
              + (benchD > 10 ? 1 : benchD < -10 ? -1 : 0);
  const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? hA : i4raw < 0 ? aA : 'EVEN' };

  // I5 — Tempo & Efficiency
  const hOPPP = hs.offensive_points_per_possession || 0;
  const aOPPP = as.offensive_points_per_possession || 0;
  const hDPPP = hs.defensive_points_per_possession || 0;
  const aDPPP = as.defensive_points_per_possession || 0;
  const effD = (hOPPP - aDPPP) - (aOPPP - hDPPP);
  const I5 = { score: effD > 0.08 ? 1 : effD < -0.08 ? 0 : 0.5, leader: effD > 0.08 ? hA : effD < -0.08 ? aA : 'EVEN' };

  // Composite
  const raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  const controlHome = raw >= 0.5;
  const controlTeam = controlHome ? hA : aA;
  const score = controlHome ? raw : 1 - raw;

  return {
    controlTeam,
    score: Math.round(score * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA,
    awayAlias: aA,
    homePts: hS,
    awayPts: aS,
  };
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function(req) {
  const startTime = Date.now();
  log('=== Poll cycle starting ===');

  // Get DB connection
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log('ERROR: DATABASE_URL not configured');
    return new Response('DATABASE_URL not configured', { status: 500 });
  }
  const sql = neon(dbUrl);

  const results = { games: 0, snapshots: 0, espn: 0, errors: [] };

  for (const league of Object.keys(LEAGUES)) {
    const cfg = LEAGUES[league];
    const apiKey = process.env[cfg.srKeyEnv];
    if (!apiKey) {
      log(`Skipping ${league}: ${cfg.srKeyEnv} not set`);
      continue;
    }

    try {
      // ── 1. Fetch today's schedule ──
      const d = today();
      const pad = n => String(n).padStart(2, '0');
      const schedule = await srFetch(league, `games/${d.year}/${pad(d.month)}/${pad(d.day)}/schedule.json`);
      const allGames = schedule.games || [];

      // Filter to live games only
      const liveGames = allGames.filter(g => {
        const st = (g.status || '').toLowerCase();
        return st === 'inprogress' || st === 'halftime';
      });

      log(`${league.toUpperCase()}: ${allGames.length} total, ${liveGames.length} live`);
      if (liveGames.length === 0) continue;

      results.games += liveGames.length;

      // ── 2. Fetch ESPN scoreboard for ID mapping ──
      const dateStr = `${d.year}${pad(d.month)}${pad(d.day)}`;
      const espnGames = await espnScoreboard(league, dateStr);
      log(`ESPN scoreboard: ${espnGames.length} events`);

      // Build ESPN mapping: SR alias → ESPN event ID
      const espnMap = {};
      for (const g of liveGames) {
        const hA = g.home?.alias || '';
        const aA = g.away?.alias || '';
        const hE = cfg.aliasMap[hA] || hA;
        const aE = cfg.aliasMap[aA] || aA;
        const match = espnGames.find(eg =>
          (eg.homeAbbr === hA || eg.homeAbbr === hE) &&
          (eg.awayAbbr === aA || eg.awayAbbr === aE)
        );
        if (match) espnMap[g.id] = match.espnId;
      }
      log(`ESPN mapped: ${Object.keys(espnMap).length}/${liveGames.length}`);

      // ── 3. Process each live game sequentially (SR rate limit) ──
      for (const game of liveGames) {
        const hA = game.home?.alias || 'HOME';
        const aA = game.away?.alias || 'AWAY';
        const matchup = `${aA}@${hA}`;

        try {
          // Fetch summary
          await sleep(SR_DELAY_MS);
          const summary = await srFetch(league, `games/${game.id}/summary.json`);

          // Compute indicators
          const ind = computeServer(summary);
          if (!ind) {
            log(`${matchup}: compute returned null (no stats yet?)`);
            continue;
          }

          // Fetch ESPN WP (no rate limit, non-blocking)
          let espnWP = null;
          if (espnMap[game.id]) {
            espnWP = await espnWinProb(league, espnMap[game.id]);
          }

          // Determine period + clock from summary
          const periods = summary.periods || [];
          const currentPeriod = periods.length || 0;
          const clock = summary.clock || '';

          // Compute deficit relative to control team
          const ctrlIsHome = ind.controlTeam === hA;
          const ctrlPts = ctrlIsHome ? ind.homePts : ind.awayPts;
          const oppPts = ctrlIsHome ? ind.awayPts : ind.homePts;
          const deficit = Math.max(0, oppPts - ctrlPts);
          const trailingTeam = oppPts > ctrlPts ? ind.controlTeam
                             : ctrlPts > oppPts ? (ctrlIsHome ? aA : hA)
                             : null;

          // Determine lead team sustainability placeholder
          // (Server doesn't have baselines yet — null is fine, client fills in)
          const leadSust = null;

          // ── 4. Save to DB ──
          // Ensure game row exists
          await sql`
            INSERT INTO games (id, date, league, matchup, home_alias, away_alias)
            VALUES (${game.id}, ${`${d.year}-${pad(d.month)}-${pad(d.day)}`}, ${league}, ${matchup}, ${hA}, ${aA})
            ON CONFLICT (id) DO NOTHING
          `;

          // Insert snapshot
          await sql`
            INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
              floor_score, floor_team, pbp_score, pbp_team, pbp_window_size,
              qtr_score, qtr_team, espn_wp_home, espn_wp_away,
              spread, deficit, trailing_team, lead_sust, gap, accel,
              i1, i2, i3, i4, i5)
            VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
              ${ind.score}, ${ind.controlTeam}, ${null}, ${null}, ${null},
              ${null}, ${null}, ${espnWP?.home || null}, ${espnWP?.away || null},
              ${null}, ${deficit}, ${trailingTeam}, ${leadSust}, ${null}, ${null},
              ${ind.I1.score}, ${ind.I2.score}, ${ind.I3.score}, ${ind.I4.score}, ${ind.I5.score})
          `;

          results.snapshots++;
          if (espnWP) results.espn++;

          log(`${matchup} Q${currentPeriod} ${clock} | ${ind.homePts}-${ind.awayPts} | ${ind.controlTeam} ${ind.score} | I:${ind.I1.score}/${ind.I2.score}/${ind.I3.score}/${ind.I4.score}/${ind.I5.score}${espnWP ? ` | WP:${espnWP.home}%` : ''}`);

        } catch (e) {
          results.errors.push(`${matchup}: ${e.message}`);
          log(`ERROR ${matchup}: ${e.message}`);
        }
      }

    } catch (e) {
      results.errors.push(`${league}: ${e.message}`);
      log(`ERROR ${league}: ${e.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`=== Done in ${elapsed}s | ${results.snapshots} snapshots, ${results.espn} ESPN WP, ${results.errors.length} errors ===`);

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── SCHEDULE CONFIG ─────────────────────────────────────────────────────────

export const config = {
  schedule: "*/2 * * * *",
};
