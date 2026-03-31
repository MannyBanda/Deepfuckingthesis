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
    bdlPrefix: '/nba',
    bdlHasSeasonStats: true,
    season: '2025',
    aliasMap: { NOP: 'NO', GSW: 'GS', NYK: 'NY', SAS: 'SA', PHX: 'PHO', BKN: 'BKN' },
  },
  ncaamb: {
    srBase: 'https://api.sportradar.com/ncaamb/trial/v8/en/',
    srKeyEnv: 'SR_NCAAMB_KEY',
    espnSlug: 'mens-college-basketball',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary',
    bdlPrefix: '/ncaab',
    bdlHasSeasonStats: true,
    season: '2025',
    aliasMap: {},  // NCAAMB uses name-based ESPN matching, no alias overrides needed
  },
};

const BDL_BASE = 'https://api.balldontlie.io';

// BDL team IDs (NBA only — tracking data is NBA-specific)
const BDL_TEAMS = {
  ATL:1, BOS:2, BKN:3, CHA:4, CHI:5, CLE:6, DAL:7, DEN:8, DET:9, GSW:10,
  HOU:11, IND:12, LAC:13, LAL:14, MEM:15, MIA:16, MIL:17, MIN:18, NOP:19, NYK:20,
  OKC:21, ORL:22, PHI:23, PHX:24, POR:25, SAC:26, SAS:27, TOR:28, UTA:29, WAS:30
};

const W = { I1: 0.25, I2: 0.25, I3: 0.20, I4: 0.20, I5: 0.10 };

const SR_DELAY_MS = 1400; // respect trial tier rate limit

// ── SONNET SYSTEM PROMPT (same as analyze.js) ────────────────────────────────
const SONNET_SYSTEM_PROMPT = 'You are an elite NBA live-game analyst providing real-time control assessment and outcome prediction for sports betting.\n\n'
+ 'CORE TASK: Determine which team structurally controls this game, assess whether each team\'s production is sustainable, evaluate whether control is compounding or fading, and identify the best entry — on EITHER team — using pre-computed data and your own reasoning.\n\n'
+ 'FIVE INDICATORS (score each 0.00-1.00 for the controlling team):\n'
+ 'I1 Possession & Transition (25%): TO margin, steals, OREBs, fast break pts, pts off TOs, second chance pts\n'
+ 'I2 Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus status\n'
+ 'I3 Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot diet\n'
+ 'I4 Lineup Integrity (20%): Biggest lead, bench contribution, which lineups producing, plus/minus\n'
+ 'I5 Tempo & Efficiency (10%): Possessions, pts/possession differential, pace control\n\n'
+ 'CONTROL: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT\n\n'
+ 'YOU RECEIVE PRE-COMPUTED DATA LAYERS:\n\n'
+ '1. 3PT SUSTAINABILITY AUDIT (per team):\n'
+ '   - PERSONNEL AUDIT: What % of 3PM came from ELITE (38%+ season) vs NON-SHOOTERS (<33%)\n'
+ '   - BAYESIAN REGRESSION: Sample-size-aware posterior expected 3PT% and regression probability\n'
+ '   - SHOT TYPE: Assist ratio proxy — catch-and-shoot (durable) vs pull-up/isolation (fragile)\n'
+ '   - COMPOSITE TIER: LOCKED IN / DURABLE / MIXED / FRAGILE / UNSUSTAINABLE\n\n'
+ '2. LEAD COMPOSITION (both teams):\n'
+ '   - Structural points (Paint + FT) vs Variance points (3PT + Mid-range)\n'
+ '   - MARGIN DURABILITY: is the lead structurally sourced, variance sourced, or mixed\n\n'
+ '3. STRUCTURAL FLOOR (cumulative I1-I5):\n'
+ '   - Dashboard\'s client-side indicator scores on ALL game data from tip to now\n'
+ '   - This is "who has controlled this game overall"\n'
+ '   - AUTHORITATIVE SOURCE: When DASHBOARD SCORES are provided, use them as your I1-I5 baseline.\n'
+ '     They include PBP chaos enrichment (forced vs unforced TOs), at-rim paint fallback\n'
+ '     (when SR delays points_in_the_paint), and Pythagorean cap. The raw game JSON does NOT\n'
+ '     include these enhancements. Only diverge from dashboard scores with stated reasoning.\n\n'
+ '4. ROLLING WINDOW (cross-fade, activates Q2+):\n'
+ '   - I1-I5 scored on a sliding ~2-quarter window with cross-fade weighting\n'
+ '   - This is "who is controlling the game RIGHT NOW" — never stale\n\n'
+ '5. GAP ACCELERATION (when window available):\n'
+ '   - Gap = window score minus floor score. Positive = window stronger than cumulative (edge compounding)\n'
+ '   - Classification: GROWING | DECLINING | STABLE | FLIPPED | TOO EARLY\n\n'
+ '6. DIRECTIONAL ARROWS (both teams, per quarter):\n'
+ '   - Raw sub-metric trends: I2 (Paint, At-rim, FTA), I1 (Steals, TOs), I3 (3PA share, Assist ratio), I5 (Possessions)\n'
+ '   - ADJUSTMENT SIGNAL: INTERIOR PIVOT | STRUCTURAL EROSION | VARIANCE SHIFT | STRUCTURAL ACCEL\n\n'
+ '7. EVENT FLAGS (player-level): Trag1 Role Player Heater, Trag2 Star Process, Trag3 Foul Gate, Trag4 Closing Lineup\n\n'
+ '8. DEPTH AUDIT (PBP): 3PT assisted/unassisted, forced/unforced TOs, shot zones, scoring runs\n\n'
+ 'DATA QUALITY NOTE — PAINT POINTS:\n'
+ '   Use DEPTH AUDIT rim section as AUTHORITATIVE paint signal. Lead composition has at-rim fallback.\n'
+ '   Only trust raw JSON points_in_the_paint when non-zero.\n\n'
+ '9. BONUS STATUS RULE:\n'
+ '   - "TeamX IN BONUS" = BENEFITS TeamX. PENALIZES opponent. PURE UPSIDE.\n'
+ '   - Before 4:00 mark = STRUCTURAL I2 MULTIPLIER. Both in bonus = NEUTRALIZED.\n\n'
+ '10. TEAM WP IDENTITY PROFILES (when provided):\n'
+ '   - COMEBACK, FRONTRUNNER, VOLATILE, CLOSER, STEADY — modifies FWP and conviction, not indicators.\n\n'
+ 'HOW TO USE LAYERS TOGETHER:\n'
+ '   FLOOR = "who should win." WINDOW = "who is winning now." GAP = "compounding or fading."\n'
+ '   ARROWS = HOW. FLAGS = WHY. SUSTAINABILITY + LEAD COMP = "is the scoreline real."\n\n'
+ '   COMBINED READ: DOMINANT | STRONG | EMERGING | EARNED | ERODING | COLLAPSING | FADING | SHIFT | NO EDGE\n\n'
+ 'ENTRY STRATEGY — FIND THE STRUCTURAL EDGE AT VALUE PRICE:\n'
+ '   Evaluate BOTH teams. Pre-game thesis is context, not permanent anchor.\n'
+ '   Core strategy: buy structural control when trailing on variance.\n'
+ '   ENTRY SIGNALS:\n'
+ '   OPTIMAL WINDOW = dominant + TRAILING + opponent FRAGILE/UNSUSTAINABLE + variance lead + gap GROWING\n'
+ '   WINDOW OPEN = structural edge + trailing or at value + opponent MIXED\n'
+ '   WINDOW CLOSING = structural team now LEADING + variance cooling\n'
+ '   NO WINDOW = no structural edge, or dominant team at full price\n'
+ '   FADE = structural read says do not buy either team\n\n'
+ '   CRITICAL: A team leading AND priced beyond -400 ML has NO VALUE.\n\n'
+ '   SUSTAINABILITY CHECK: Before signaling BUY, check the structural team\'s own sustainability.\n'
+ '   If FRAGILE/UNSUSTAINABLE, downgrade to CAUTION/CONDITIONAL. Exception: 0.85+ driven by I1+I2.\n\n'
+ '   ATTRIBUTION CHECK: The team you call unsustainable must match the UNSUSTAINABLE/FRAGILE tier.\n\n'
+ 'FWP (Framework Win Probability) IS GAME-STATE-AWARE:\n'
+ '   FWP = probability of WINNING given score, time, AND structural control. NOT the control score.\n'
+ '   Factor in: score margin, quarter, time remaining, combined read trajectory. BE ACCURATE.\n'
+ '   OUTPUT BOTH TEAMS with alias labels. The two values must sum to ~100%.\n'
+ '   Example: FWP: MEM 72% / LAC 28%\n'
+ '   COHERENCE: If you signal BUY TeamB, TeamB FWP MUST be > 50%.\n\n'
+ 'CONVICTION: DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY\n'
+ '  State which indicators drive your score. I1+I2 (50% weight) warrants higher conviction than I4+I5 (30%).\n\n'
+ 'OUTPUT FORMAT (follow exactly):\n\n'
+ 'DECISION:\n'
+ 'EDGE: [+X% | No market data] | FWP: [AwayAlias X% / HomeAlias Y%] | MIP: [X% | N/A]\n'
+ 'ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW | FADE]\n'
+ 'CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]\n'
+ 'SIGNAL: [BUY TeamAlias | NO VALUE | PASS] — [1-line reason naming both teams]\n'
+ 'Sustainability: [TeamA]: [tier] | [TeamB]: [tier]\n'
+ 'Lead Source: [STRUCTURAL | VARIANCE | MIXED | EVEN] — [1-line]\n'
+ 'SPREAD ANALYSIS: [1-line]\n'
+ 'Team Quality: [context for both teams]\n'
+ 'Clutch: [Tier X] — [CLEAR|WATCH|FIRES|NEUTRALIZED]\n'
+ 'Prediction: [1-line decisive call]\n\n'
+ 'EVIDENCE:\n'
+ 'CONTROL: [Team] [score] — [level]\n'
+ 'COMBINED READ: [DOMINANT|STRONG|EMERGING|EARNED|ERODING|FADING|COLLAPSING|SHIFT|NO EDGE] — [note]\n\n'
+ 'I1 Possession & Transition (25%): [team] [score] — [explanation]\n'
+ 'I2 Rim Pressure & Foul (25%): [team] [score] — [explanation]\n'
+ 'I3 Shot Quality & Creation (20%): [team] [score] — [explanation]\n'
+ 'I4 Lineup Integrity (20%): [team] [score] — [explanation]\n'
+ 'I5 Tempo & Efficiency (10%): [team] [score] — [explanation]\n\n'
+ 'EVENT FLAGS:\n'
+ 'Trag1 — Role Player Heater: [detail or CLEAR]\n'
+ 'Trag2 — Star Process: [detail or CLEAR]\n'
+ 'Trag3 — Foul Gate: [detail or CLEAR]\n'
+ 'Trag4 — Closing Lineup: [detail or CLEAR]\n\n'
+ 'THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED|FLIPPED] — [note]\n'
+ 'FLIPPED = thesis was wrong AND the other team has emerged as the structural edge with a valid entry.\n'
+ 'DIVERGENCE NOTES: [where your scores differ from dashboard and why]\n\n'
+ 'Be concise. 1 line per indicator. Decisive when clear. Passing is correct when it is not.';

// ── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── NTFY PUSH NOTIFICATIONS ─────────────────────────────────────────────
async function sendNtfy(title, body, priority = 4) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    // Node.js fetch requires ASCII-only headers — strip emojis/unicode from Title
    const asciiTitle = title.replace(/\u2014/g, '-').replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim();
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Title': asciiTitle || 'DFT Alert', 'Priority': String(priority), 'Tags': 'basketball' },
      body: title + '\n' + body,
    });
    log(`NTFY sent: ${title}`);
  } catch (e) {
    log(`NTFY failed: ${e.message}`);
  }
}

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
  let url = `${cfg.espnBase}scoreboard?dates=${dateStr}`;
  // NCAAMB needs groups=100&limit=200 to get all games
  if (league === 'ncaamb') url += '&groups=100&limit=200';
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
      homeName: (home?.team?.displayName || '').toLowerCase(),
      awayName: (away?.team?.displayName || '').toLowerCase(),
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

// ── BDL FETCH ───────────────────────────────────────────────────────────────

async function bdlFetch(path) {
  const apiKey = process.env.BDL_API_KEY;
  if (!apiKey) return null;
  const url = `${BDL_BASE}${path}`;
  try {
    const resp = await fetch(url, { headers: { 'Authorization': apiKey } });
    if (!resp.ok) {
      log(`BDL ${resp.status}: ${path}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    log(`BDL error: ${e.message}`);
    return null;
  }
}

// Fetch today's BDL games → build team ID map + game ID map (for odds)
async function bdlGameData(league, dateStr) {
  const cfg = LEAGUES[league];
  if (!cfg.bdlHasSeasonStats) return { teamIds: {}, gameIds: {} };
  // dateStr format: YYYY-MM-DD
  // NCAAMB: BDL uses UTC dates, so late-ET games appear on the next UTC day.
  // Fetch both the requested date and the next day, merge results.
  const dates = [dateStr];
  if (league === 'ncaamb') {
    const dt = new Date(dateStr + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    const nd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
    dates.push(nd);
  }
  const teamIds = {}; // { 'LAL': 14, 'HOU': 11, ... }
  const gameIds = {}; // { 'HOU@LAL': 54321, ... } — keyed by matchup for SR→BDL mapping
  for (const ds of dates) {
    try {
      const data = await bdlFetch(`${cfg.bdlPrefix}/v1/games?dates[]=${ds}&per_page=50`);
      if (!data || !data.data) continue;
      for (const g of data.data) {
        const hAbbr = g.home_team?.abbreviation;
        const aAbbr = g.visitor_team?.abbreviation;
        if (hAbbr && g.home_team?.id) teamIds[hAbbr] = g.home_team.id;
        if (aAbbr && g.visitor_team?.id) teamIds[aAbbr] = g.visitor_team.id;
        if (hAbbr && aAbbr && g.id) gameIds[`${aAbbr}@${hAbbr}`] = g.id;
      }
    } catch (e) {
      log(`bdlGameData ${ds} failed: ${e.message}`);
    }
  }
  return { teamIds, gameIds };
}

// Fetch player season stats for a team — NCAAMB batch endpoint (works as-is)
async function bdlSeasonStatsNCAAMB(league, bdlTeamId, season) {
  const cfg = LEAGUES[league];
  const data = await bdlFetch(`${cfg.bdlPrefix}/v1/player_season_stats?season=${season}&team_id=${bdlTeamId}&per_page=100`);
  if (!data || !data.data) return [];
  return data.data;
}

// Fetch NBA season averages — per-player (BDL has no batch-by-team for NBA)
// Step 1: Get player IDs from a recent game's box score
// Step 2: Call /nba/v1/season_averages per player
async function bdlSeasonStatsNBA(bdlTeamId, season) {
  // Find a recent game for this team to get player IDs
  const gamesData = await bdlFetch(`/nba/v1/games?team_ids[]=${bdlTeamId}&seasons[]=${season}&per_page=5`);
  if (!gamesData?.data?.length) return [];

  // Get the most recent game's box score for player IDs (BDL returns oldest first)
  const recentGameId = gamesData.data[gamesData.data.length - 1].id;
  const statsData = await bdlFetch(`/nba/v1/stats?game_ids[]=${recentGameId}&per_page=50`);
  if (!statsData?.data?.length) return [];

  // Filter to players on this team who played meaningful minutes
  const teamPlayers = statsData.data.filter(s => {
    const mins = s.min ? parseInt(s.min) : 0;
    return s.player?.id && s.team?.id == bdlTeamId && mins >= 5;
  });

  // Fetch season averages for each player in parallel
  const results = [];
  const fetches = teamPlayers.map(async (s) => {
    const pid = s.player.id;
    const data = await bdlFetch(`/nba/v1/season_averages?season=${season}&player_id=${pid}`);
    if (data?.data?.length) {
      const avg = data.data[0];
      results.push({
        player: { id: pid, first_name: s.player.first_name, last_name: s.player.last_name },
        fg3m: avg.fg3m || 0, fg3a: avg.fg3a || 0,
        fgm: avg.fgm || 0, fga: avg.fga || 0,
        pts: avg.pts || 0, reb: avg.reb || 0, ast: avg.ast || 0,
        stl: avg.stl || 0, blk: avg.blk || 0, turnover: avg.turnover || 0,
        min: avg.min || '0', games_played: avg.games_played || 0,
      });
    }
  });
  await Promise.all(fetches);
  return results;
}

// Load season cache from DB for given teams
async function loadSeasonCache(sql, league, season, teamAbbrs) {
  if (teamAbbrs.length === 0) return {};
  try {
    const rows = await sql`
      SELECT team_alias, players_json, updated_at
      FROM season_cache
      WHERE league = ${league} AND season = ${season} AND team_alias = ANY(${teamAbbrs})
    `;
    const cache = {};
    for (const r of rows) {
      const age = (Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      cache[r.team_alias] = {
        players: typeof r.players_json === 'string' ? JSON.parse(r.players_json) : r.players_json,
        ageDays: Math.round(age * 10) / 10,
        fresh: age < 7, // fresh if under 7 days old
      };
    }
    return cache;
  } catch (e) {
    log(`Season cache load failed: ${e.message}`);
    return {};
  }
}

// Save season cache to DB
async function saveSeasonCache(sql, league, season, teamAlias, players) {
  try {
    await sql`
      INSERT INTO season_cache (team_alias, league, season, players_json, player_count, updated_at)
      VALUES (${teamAlias}, ${league}, ${season}, ${JSON.stringify(players)}, ${players.length}, NOW())
      ON CONFLICT (team_alias, league, season) DO UPDATE SET
        players_json = ${JSON.stringify(players)}, player_count = ${players.length}, updated_at = NOW()
    `;
  } catch (e) {
    log(`Season cache save failed for ${teamAlias}: ${e.message}`);
  }
}

// Get season stats for teams — cache-first, fetch stale/missing
async function getSeasonStatsForTeams(sql, league, season, teamAbbrs, bdlTeamIds) {
  const abbrArr = Array.from(teamAbbrs);
  const cache = await loadSeasonCache(sql, league, season, abbrArr);
  const result = {}; // { 'BOS': [...playerStats], ... }
  const stale = []; // teams that need refresh

  for (const abbr of abbrArr) {
    if (cache[abbr]?.fresh) {
      result[abbr] = cache[abbr].players;
    } else {
      stale.push(abbr);
    }
  }

  const freshCount = abbrArr.length - stale.length;
  if (freshCount > 0) log(`Season cache: ${freshCount} teams from cache`);

  if (stale.length > 0) {
    log(`Season cache: ${stale.length} teams stale/missing — refreshing: ${stale.join(', ')}`);

    const fetches = stale.map(async (abbr) => {
      const bdlId = bdlTeamIds[abbr];
      if (!bdlId) return;

      try {
        let players;
        if (league === 'nba') {
          players = await bdlSeasonStatsNBA(bdlId, season);
        } else {
          players = await bdlSeasonStatsNCAAMB(league, bdlId, season);
        }

        if (players.length > 0) {
          result[abbr] = players;
          await saveSeasonCache(sql, league, season, abbr, players);
          log(`Season cache: ${abbr} refreshed — ${players.length} players`);
        }
      } catch (e) {
        log(`Season fetch ${abbr}: ${e.message}`);
      }
    });

    await Promise.all(fetches);
  }

  return result;
}

// Fetch odds for a game → returns { homeSpread, homeML, awayML, total } or null
async function bdlOdds(league, bdlGameId) {
  const cfg = LEAGUES[league];
  // NBA uses /v2/odds, NCAAMB uses /v1/odds with array param
  let path;
  if (league === 'nba') {
    path = `/nba/v2/odds?game_ids[]=${bdlGameId}`;
  } else {
    path = `${cfg.bdlPrefix}/v1/odds?game_ids[]=${bdlGameId}`;
  }
  const data = await bdlFetch(path);
  if (!data || !data.data || data.data.length === 0) return null;

  // BDL NBA v2 odds are flat per-vendor objects:
  //   { vendor, spread_home_value, spread_away_value, moneyline_home_odds, moneyline_away_odds, total_value, ... }
  // Prefer FanDuel or DraftKings
  const odds = data.data;
  const preferred = odds.find(o =>
    o.vendor?.toLowerCase().includes('fanduel') || o.vendor?.toLowerCase().includes('draftkings')
  ) || odds[0];

  if (!preferred) return null;

  const homeSpread = preferred.spread_home_value != null ? parseFloat(preferred.spread_home_value) : null;
  const homeML = preferred.moneyline_home_odds != null ? parseInt(preferred.moneyline_home_odds) : null;
  const awayML = preferred.moneyline_away_odds != null ? parseInt(preferred.moneyline_away_odds) : null;
  const total = preferred.total_value != null ? parseFloat(preferred.total_value) : null;

  if (homeSpread == null && homeML == null) return null;
  return { homeSpread, homeML, awayML, total };
}

// Fetch tracking baselines (catch-and-shoot + pull-up eFG) — NBA only, season stats
// Called once per game, cached on game._trackingData
async function fetchTrackingData(hA, aA, season) {
  const hId = BDL_TEAMS[hA], aId = BDL_TEAMS[aA];
  if (!hId || !aId) return null;
  try {
    const s = season || '2025';
    function extractStats(resp) {
      const entry = resp?.data?.[0];
      return entry?.stats || entry || {};
    }
    const [hCAS, aCAS, hPU, aPU] = await Promise.all([
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${hId}&season=${s}&season_type=regular&type=catch_and_shoot`),
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${aId}&season=${s}&season_type=regular&type=catch_and_shoot`),
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${hId}&season=${s}&season_type=regular&type=pullups`),
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${aId}&season=${s}&season_type=regular&type=pullups`),
    ]);
    return {
      home: {
        catchAndShoot: { efg: extractStats(hCAS).effective_field_goal_percentage || extractStats(hCAS).efg_pct || null },
        pullUp: { efg: extractStats(hPU).effective_field_goal_percentage || extractStats(hPU).efg_pct || null },
      },
      away: {
        catchAndShoot: { efg: extractStats(aCAS).effective_field_goal_percentage || extractStats(aCAS).efg_pct || null },
        pullUp: { efg: extractStats(aPU).effective_field_goal_percentage || extractStats(aPU).efg_pct || null },
      },
    };
  } catch (e) {
    log(`Tracking data fetch failed for ${hA}/${aA}: ${e.message}`);
    return null;
  }
}

// Normalize player name for fuzzy matching (lowercase, strip Jr./Sr./III/II/IV, trim)
function normName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, '')
    .replace(/[.']/g, '')
    .trim();
}

// Merge BDL season averages onto SR summary players
// Attaches .average = { three_points_made, three_points_att, field_goals_made, field_goals_att }
// so the sustainability audit's player loop picks them up
function mergeBdlSeasonData(summary, bdlHomeSeason, bdlAwaySeason) {
  function mergeTeam(teamData, bdlStats) {
    if (!teamData?.players || !bdlStats || bdlStats.length === 0) return;
    // Build lookup by normalized name
    const bdlMap = {};
    for (const ps of bdlStats) {
      const pName = ps.player?.first_name && ps.player?.last_name
        ? `${ps.player.first_name} ${ps.player.last_name}`
        : '';
      const key = normName(pName);
      if (key) bdlMap[key] = ps;
    }

    for (const player of teamData.players) {
      const srName = player.full_name || player.name || '';
      const key = normName(srName);
      const bdl = bdlMap[key];
      if (!bdl) continue;

      // Attach season averages so sustainability audit reads them
      // BDL player_season_stats returns per-game averages
      player.average = {
        three_points_made: bdl.fg3m || 0,
        three_points_att: bdl.fg3a || 0,
        field_goals_made: bdl.fgm || 0,
        field_goals_att: bdl.fga || 0,
        points: bdl.pts || 0,
        rebounds: bdl.reb || 0,
        assists: bdl.ast || 0,
      };
    }
  }

  mergeTeam(summary.home, bdlHomeSeason);
  mergeTeam(summary.away, bdlAwaySeason);
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE BDL ADAPTERS
// Same logic as client — coordinateToZone, parseBDLPBP, buildSummaryFromBDL
// ══════════════════════════════════════════════════════════════════════════════

function normalizeBdlStatusServer(s, boxScore) {
  if (!s) return 'scheduled';
  const sl = s.toLowerCase();
  if (sl === 'final') return 'closed';
  if (sl === 'in progress' || sl.includes('qtr') || sl.includes('quarter') || sl.includes('overtime') || sl.includes(' ot') || sl === 'ot' || /^\d*\s*ot/i.test(sl)) return 'inprogress';
  if (sl === 'halftime' || sl.includes('half')) return 'halftime';
  // Datetime string — check box score for live signals (BDL sometimes returns
  // scheduled time as status even when game is in progress)
  if (s.includes('T') && s.includes(':')) {
    if (boxScore) {
      const hasScore = ((boxScore.home_team_score || 0) + (boxScore.visitor_team_score || 0)) > 0;
      const hasPeriod = (boxScore.period || 0) > 0;
      const hasTime = boxScore.time && boxScore.time !== '' && !boxScore.time.includes('T');
      const hasQtrScore = (boxScore.home_q1 || 0) > 0 || (boxScore.visitor_q1 || 0) > 0;
      const hasPlayers = boxScore.home_team && boxScore.home_team.players && boxScore.home_team.players.length > 0;
      if (hasScore || hasPeriod || hasTime || hasQtrScore || hasPlayers) return 'inprogress';
    }
    try { const _tipMs = new Date(s).getTime(); if (!isNaN(_tipMs) && Date.now() > _tipMs + 120000) return 'inprogress'; } catch(e) {}
    return 'scheduled';
  }
  return s;
}

const BDL_BASKET_X = 25, BDL_BASKET_Y = 1.5, BDL_RIM_RADIUS = 4, BDL_PAINT_RADIUS = 9, BDL_THREE_RADIUS = 22, BDL_CORNER_Y_MAX = 9;
function bdlCoordsValid(x, y) { return x != null && y != null && x > -1000 && y > -1000 && x < 1000 && y < 1000; }
function bdlDistFromBasket(x, y) { return Math.sqrt(Math.pow(x - BDL_BASKET_X, 2) + Math.pow(y - BDL_BASKET_Y, 2)); }

const BDL_RIM_SET = new Set(['layup shot','driving layup shot','running layup shot','cutting layup shot','reverse layup shot','finger roll layup','layup shot putback','putback layup shot','driving reverse layup shot','running reverse layup shot','dunk shot','driving dunk shot','running dunk shot','cutting dunk shot','alley oop dunk shot','putback dunk shot','running alley oop dunk shot','tip shot','tip dunk shot']);
const BDL_PAINT_SET = new Set(['driving floating jump shot','floating jump shot','driving hook shot','hook shot','running hook shot','driving finger roll layup','turnaround hook shot']);

function coordinateToZoneServer(x, y, shotType, text, scoreValue) {
  const tl = (shotType || '').toLowerCase().trim();
  const tx = (text || '').toLowerCase();
  const is3 = scoreValue === 3 || tx.includes('three point');
  if (BDL_RIM_SET.has(tl)) return 'rim';
  if (BDL_PAINT_SET.has(tl)) return 'paint';
  if (is3) { if (bdlCoordsValid(x, y) && y < BDL_CORNER_Y_MAX) return 'corner3'; return 'above3'; }
  if (bdlCoordsValid(x, y)) { const d = bdlDistFromBasket(x, y); if (d < BDL_RIM_RADIUS) return 'rim'; if (d < BDL_PAINT_RADIUS) return 'paint'; if (d >= BDL_THREE_RADIUS) return y < BDL_CORNER_Y_MAX ? 'corner3' : 'above3'; return 'mid'; }
  const dm = tx.match(/(\d+)-foot/); if (dm) { const dd = parseInt(dm[1]); if (dd <= 4) return 'rim'; if (dd <= 9) return 'paint'; if (dd >= 22) return 'above3'; return 'mid'; }
  if (tl.includes('layup') || tl.includes('dunk') || tl.includes('tip')) return 'rim';
  if (tl.includes('hook') || tl.includes('float')) return 'paint';
  return 'mid';
}

function bdlExtractPlayerS(t) { if (!t) return '?'; const c = t.replace(/\n/g, ' ').trim(); const m = c.match(/^([A-Z][a-zA-Z'.]+(?:[\s-][A-Z][a-zA-Z'.]+)*(?:\s+(?:Jr\.|Sr\.|III|II|IV))?)\s+(?:makes|misses|personal|shooting|loose|bad|offensive|defensive|lost|out|traveling|turnover|flagrant|double|blocks|steals|enters|steps|kicked)/i); if (m) return m[1].trim(); const m2 = c.match(/^(.+?)\s+(?:makes|misses|personal|shooting|offensive|defensive|bad|loose|lost|blocks|steals)/i); if (m2) return m2[1].trim(); return c.split(/\s+/).slice(0, 2).join(' '); }
function bdlExtractAssistS(t) { if (!t) return null; const m = t.match(/\(([^)]+?)\s+assists?\)/i); return m ? m[1].trim() : null; }
function bdlExtractBlockS(t) { if (!t) return null; const m = t.match(/\(([^)]+?)\s+blocks?\)/i); if (m) return m[1].trim(); const m2 = t.match(/([A-Z][a-zA-Z'.]+(?:[\s-][A-Z][a-zA-Z'.]+)*)\s+blocks\s/i); return m2 ? m2[1].trim() : null; }
function bdlExtractStealS(t) { if (!t) return null; const m = t.match(/\(([^)]+?)\s+steals?\)/i); return m ? m[1].trim() : null; }
function bdlClassifyContextS(type, assisted, isThree) { const t = (type || '').toLowerCase(); if (t.includes('driving') || t.includes('layup') || t.includes('dunk')) return 'drive'; if (t.includes('pullup') || t.includes('step back') || t.includes('fadeaway')) return 'pullup'; if (t.includes('putback') || t.includes('tip')) return 'putback'; if (t.includes('cutting') || t.includes('alley')) return 'cut'; if (t.includes('hook') || t.includes('float')) return 'floater'; if (t.includes('running') && !t.includes('pullup')) return 'transition'; if (assisted && isThree) return 'catch-shoot'; return 'halfcourt'; }
function bdlClassifyTOS(type, text) { const t = (type || '').toLowerCase(); const tx = (text || '').toLowerCase(); if (tx.includes('steal')) return { forced: true, type: t }; if (t.includes('bad pass')) return { forced: true, type: t }; if (t.includes('traveling') || t.includes('out of bounds') || t.includes('3-second') || t.includes('shot clock') || t.includes('offensive foul') || t.includes('double dribble') || t.includes('backcourt') || t.includes('kicked ball')) return { forced: false, type: t }; return { forced: null, type: t }; }

// Server-side parseBDLPBP — same as client but returns perQuarter for sub-metric arrows
function parseBDLPBPServer(plays, homeAbbr, awayAbbr) {
  if (!plays || plays.length === 0) return null;
  const hA = homeAbbr, aA = awayAbbr;
  const shots = [], turnovers = [], scoreLog = [], runs = [];
  let hScore = 0, aScore = 0, bigH = 0, bigA = 0;
  let pendPOT = null, pendOREB = null, potH = 0, potA = 0, scpH = 0, scpA = 0, lastP = 0;

  const sorted = plays.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  sorted.forEach(ev => {
    const type = (ev.type || '').trim(), tl = type.toLowerCase();
    const text = (ev.text || '').replace(/\n/g, ' ').trim(), tx = text.toLowerCase();
    const tAbbr = ev.team?.abbreviation || '';
    const team = tAbbr === hA ? hA : tAbbr === aA ? aA : tAbbr || '?';
    const player = bdlExtractPlayerS(text);
    const quarter = ev.period || 0;
    const hs = ev.home_score ?? null, as = ev.away_score ?? null;

    if (quarter !== lastP && lastP > 0) { pendPOT = null; pendOREB = null; }
    lastP = quarter;
    if (hs != null && as != null) { const mg = hs - as; if (mg > bigH) bigH = mg; if (-mg > bigA) bigA = -mg; }
    if (tl.includes('substitution') || tx.includes('enters the game for')) return;

    if (ev.shooting_play) {
      const made = ev.scoring_play || false;
      const is3 = ev.score_value === 3 || tx.includes('three point');
      let pts = made ? (ev.score_value || (is3 ? 3 : 2)) : 0;
      const zone = coordinateToZoneServer(ev.coordinate_x, ev.coordinate_y, type, text, ev.score_value);

      if (tl.includes('free throw')) {
        pts = made ? 1 : 0;
        if (made) {
          if (team === hA) hScore += 1; else aScore += 1;
          scoreLog.push({ team, pts: 1, hScore, aScore, q: quarter });
          if (pendOREB === team) { if (team === hA) scpH += 1; else scpA += 1; }
          if (pendPOT === team) { if (team === hA) potH += 1; else potA += 1; }
        }
        const ftM = type.match(/(\d+)\s*of\s*(\d+)/i);
        if (ftM && ftM[1] === ftM[2] && made) { pendOREB = null; pendPOT = null; }
        return;
      }

      const assisted = made ? !!bdlExtractAssistS(text) : false;
      const context = bdlClassifyContextS(type, assisted, is3);
      shots.push({ p: player, tm: team, z: zone, m: made, a: assisted, q: quarter, ctx: context, is3 });
      if (made) {
        if (team === hA) hScore += pts; else aScore += pts;
        scoreLog.push({ team, pts, hScore, aScore, q: quarter });
        if (pendOREB === team) { if (team === hA) scpH += pts; else scpA += pts; }
        if (pendPOT === team) { if (team === hA) potH += pts; else potA += pts; }
        pendOREB = null; pendPOT = null;
      }
      return;
    }

    if (tl.includes('turnover')) {
      const tc = bdlClassifyTOS(type, text);
      turnovers.push({ p: player, tm: team, q: quarter, forced: tc.forced, type: tc.type });
      pendOREB = null;
      pendPOT = team === hA ? aA : hA;
      return;
    }

    if (tl.includes('rebound')) {
      if (tl.includes('offensive')) pendOREB = team;
      else { pendOREB = null; pendPOT = null; }
      return;
    }

    if (tl.includes('foul') && tl.includes('offensive')) {
      pendOREB = null; pendPOT = team === hA ? aA : hA;
    }

    if (tl.includes('end period') || tl.includes('end game')) {
      pendPOT = null; pendOREB = null;
    }
  });

  // Runs
  let rTm = null, rPts = 0, rSt = 0, rCt = 0, rST = [];
  for (let i = 0; i < scoreLog.length; i++) {
    const s = scoreLog[i];
    if (s.team === rTm) { rPts += s.pts; rCt++; rST.push(s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT'); }
    else { if (rPts >= 8 || rCt >= 3) runs.push({ team: rTm, pts: rPts, count: rCt, q: scoreLog[rSt]?.q, mechanism: rST.slice(), si: rSt, ei: i - 1 }); rTm = s.team; rPts = s.pts; rSt = i; rCt = 1; rST = [s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT']; }
  }
  if (rPts >= 8 || rCt >= 3) runs.push({ team: rTm, pts: rPts, count: rCt, q: scoreLog[rSt]?.q, mechanism: rST.slice(), si: rSt, ei: scoreLog.length - 1 });
  runs.sort((a, b) => b.ei - a.ei);

  // Aggregates (same shape as SR parsePBPServer aggTeam)
  function aggTeam(tm) {
    const s = shots.filter(x => x.tm === tm);
    const threes = s.filter(x => x.is3), rim = s.filter(x => x.z === 'rim'), paint = s.filter(x => x.z === 'paint'), mid = s.filter(x => x.z === 'mid');
    const threeMade = threes.filter(x => x.m), rimMade = rim.filter(x => x.m), midMade = mid.filter(x => x.m);
    const assistedThrees = threeMade.filter(x => x.a).length;
    const tms = turnovers.filter(t => t.tm === tm);
    return {
      threes: { made: threeMade.length, att: threes.length, assisted: assistedThrees, pct: threes.length > 0 ? (threeMade.length / threes.length * 100).toFixed(1) : '0',
        corner: { made: threeMade.filter(x => x.z === 'corner3').length, att: threes.filter(x => x.z === 'corner3').length },
        above: { made: threeMade.filter(x => x.z === 'above3').length, att: threes.filter(x => x.z === 'above3').length },
        byPlayer: [] },
      rim: { made: rimMade.length, att: rim.length, pct: rim.length > 0 ? (rimMade.length / rim.length * 100).toFixed(1) : '0', byPlayer: [] },
      paint: { made: paint.filter(x => x.m).length, att: paint.length, pct: paint.length > 0 ? (paint.filter(x => x.m).length / paint.length * 100).toFixed(1) : '0' },
      mid: { made: midMade.length, att: mid.length, assisted: midMade.filter(x => x.a).length, pct: mid.length > 0 ? (midMade.length / mid.length * 100).toFixed(1) : '0', byPlayer: [] },
      tos: { total: tms.length, forced: tms.filter(t => t.forced === true).length, unforced: tms.filter(t => t.forced === false).length, unknown: tms.filter(t => t.forced === null).length },
      shotDiet: { total: s.length, threePct: s.length > 0 ? (threes.length / s.length * 100).toFixed(1) : '0', rimPct: s.length > 0 ? (rim.length / s.length * 100).toFixed(1) : '0', midPct: s.length > 0 ? (mid.length / s.length * 100).toFixed(1) : '0' },
    };
  }

  return {
    home: aggTeam(hA), away: aggTeam(aA),
    homeAlias: hA, awayAlias: aA,
    totalShots: shots.length, totalTOs: turnovers.length,
    runs: runs.slice(0, 10),
    perQuarter: buildPerQuarterMetrics(shots, turnovers, hA, aA),
    pbpPeriod: lastP, pbpAge: 0,
    _bdl: { potHome: potH, potAway: potA, scpHome: scpH, scpAway: scpA, biggestLeadHome: bigH, biggestLeadAway: bigA, scoreLog },
  };
}

// Normalize BDL clock format — strips period prefix, handles sub-minute and special labels
// BDL returns: "Q4 8:03", "Q3 :15.2", "END Q1", "Half", "Final", "PT04M32S", "8:03"
function normalizeBdlClockServer(time) {
  if (!time) return '';
  if (time === 'Final' || time === 'final') return '00:00';
  if (/^END\s|^Half/i.test(time)) return '0:00';
  // Period-prefixed: "Q4 8:03" or "Q3 :15.2" or "OT1 3:22"
  const qMatch = time.match(/^(?:Q\d+|OT\d?)\s+(.+)$/i);
  if (qMatch) return normalizeBdlClockServer(qMatch[1]);
  // Sub-minute: ":45.0" or ":08.9"
  if (/^:\d/.test(time)) {
    const secs = parseFloat(time.substring(1));
    if (!isNaN(secs)) return '0:' + String(Math.floor(secs)).padStart(2, '0');
  }
  // Already MM:SS
  if (/^\d{1,2}:\d{2}(\.\d)?$/.test(time)) return time;
  // ISO duration PT04M32S
  const iso = time.match(/PT(\d+)M(\d+)(?:\.(\d+))?S/);
  if (iso) return iso[1] + ':' + iso[2].padStart(2, '0');
  // Seconds only
  if (/^\d+(\.\d+)?$/.test(time)) {
    const sec = parseFloat(time);
    return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  }
  return time;
}

// Server-side buildSummaryFromBDL — builds SR summary shape from BDL box score + PBP
function buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr) {
  const game = boxScore || {};
  const bdl = pbpResult?._bdl || {};
  const homeTeam = game.home_team?.team || game.home_team || {};
  const awayTeam = game.visitor_team?.team || game.visitor_team || {};
  const hA = homeTeam.abbreviation || 'HOME', aA = awayTeam.abbreviation || 'AWAY';
  const homePlayers = game.home_team?.players || [];
  const awayPlayers = game.visitor_team?.players || [];
  const hSIds = new Set(), aSIds = new Set();
  if (lineupsArr) lineupsArr.forEach(l => { if (!l.starter) return; const ab = l.team?.abbreviation || ''; if (ab === hA) hSIds.add(l.player?.id); else if (ab === aA) aSIds.add(l.player?.id); });

  function bts(players, starterIds, side) {
    const s = { field_goals_made: 0, field_goals_att: 0, three_points_made: 0, three_points_att: 0, two_points_made: 0, two_points_att: 0, free_throws_made: 0, free_throws_att: 0, assists: 0, steals: 0, blocks: 0, offensive_rebounds: 0, defensive_rebounds: 0, rebounds: 0, turnovers: 0, total_turnovers: 0, personal_fouls: 0, points: 0, bench_points: 0 };
    let sPts = 0;
    players.forEach(p => { s.field_goals_made += p.fgm || 0; s.field_goals_att += p.fga || 0; s.three_points_made += p.fg3m || 0; s.three_points_att += p.fg3a || 0; s.free_throws_made += p.ftm || 0; s.free_throws_att += p.fta || 0; s.assists += p.ast || 0; s.steals += p.stl || 0; s.blocks += p.blk || 0; s.offensive_rebounds += p.oreb || 0; s.defensive_rebounds += p.dreb || 0; s.rebounds += p.reb || 0; s.turnovers += p.turnover || 0; s.personal_fouls += p.pf || 0; s.points += p.pts || 0; if (starterIds.has(p.player?.id || p.id)) sPts += p.pts || 0; });
    s.total_turnovers = s.turnovers; s.two_points_made = s.field_goals_made - s.three_points_made; s.two_points_att = s.field_goals_att - s.three_points_att; s.bench_points = Math.max(0, s.points - sPts);
    const fga = s.field_goals_att || 1;
    s.field_goals_pct = +(s.field_goals_made / fga * 100).toFixed(1); s.three_points_pct = s.three_points_att > 0 ? +(s.three_points_made / s.three_points_att * 100).toFixed(1) : 0;
    s.effective_fg_pct = +((s.field_goals_made + 0.5 * s.three_points_made) / fga * 100).toFixed(1);
    s.true_shooting_att = +(fga + 0.44 * s.free_throws_att).toFixed(1); s.true_shooting_pct = s.true_shooting_att > 0 ? +(s.points / (2 * s.true_shooting_att) * 100).toFixed(1) : 0;
    s.assists_turnover_ratio = s.turnovers > 0 ? +(s.assists / s.turnovers).toFixed(2) : s.assists;
    s.possessions = +(fga - s.offensive_rebounds + s.turnovers + 0.4 * s.free_throws_att).toFixed(1);
    s.offensive_points_per_possession = s.possessions > 0 ? +(s.points / s.possessions).toFixed(2) : 0;
    const isHome = side === 'home'; const pbpSide = isHome ? pbpResult?.home : pbpResult?.away;
    if (pbpSide) { const rM = pbpSide.rim?.made || 0, rA = pbpSide.rim?.att || 0, pM = pbpSide.paint?.made || 0, pA = pbpSide.paint?.att || 0; s.points_in_paint_made = rM + pM; s.points_in_paint_att = rA + pA; s.points_in_paint = s.points_in_paint_made * 2; s.points_in_the_paint = s.points_in_paint; s.field_goals_at_rim_made = rM; s.field_goals_at_rim_att = rA; }
    s.points_off_turnovers = isHome ? (bdl.potHome || 0) : (bdl.potAway || 0); s.second_chance_pts = isHome ? (bdl.scpHome || 0) : (bdl.scpAway || 0); s.second_chance_points = s.second_chance_pts;
    s.biggest_lead = isHome ? (bdl.biggestLeadHome || 0) : (bdl.biggestLeadAway || 0);
    s.fast_break_pts = 0; s.fast_break_points = 0; s.most_unanswered = { points: 0 };
    if (pbpResult?.runs) { const tr = pbpResult.runs.filter(r => r.team === (isHome ? hA : aA)); if (tr.length > 0) s.most_unanswered.points = tr.reduce((m, r) => r.pts > m ? r.pts : m, 0); }
    s.fouls_drawn = 0; s.defensive_points_per_possession = 0; s.offensive_rating = 0; s.defensive_rating = 0; s.points_against = 0; s.time_leading = '';
    return s;
  }

  const homeStats = bts(homePlayers, hSIds, 'home'), awayStats = bts(awayPlayers, aSIds, 'away');
  homeStats.points_against = awayStats.points; awayStats.points_against = homeStats.points;
  homeStats.defensive_points_per_possession = homeStats.possessions > 0 ? +(awayStats.points / homeStats.possessions).toFixed(2) : 0;
  awayStats.defensive_points_per_possession = awayStats.possessions > 0 ? +(homeStats.points / awayStats.possessions).toFixed(2) : 0;
  homeStats.offensive_rating = homeStats.possessions > 0 ? +(homeStats.points / homeStats.possessions * 100).toFixed(1) : 0;
  homeStats.defensive_rating = homeStats.possessions > 0 ? +(awayStats.points / homeStats.possessions * 100).toFixed(1) : 0;
  awayStats.offensive_rating = awayStats.possessions > 0 ? +(awayStats.points / awayStats.possessions * 100).toFixed(1) : 0;
  awayStats.defensive_rating = awayStats.possessions > 0 ? +(homeStats.points / awayStats.possessions * 100).toFixed(1) : 0;

  // Per-quarter scores
  const periods = [];
  for (let q = 1; q <= 4; q++) { const hP = game['home_q' + q] ?? null, aP = game['visitor_q' + q] ?? null; if (hP != null || aP != null) periods.push({ number: q, home_points: hP || 0, away_points: aP || 0 }); }
  for (let ot = 1; ot <= 3; ot++) { const hOT = game['home_ot' + ot] ?? null, aOT = game['visitor_ot' + ot] ?? null; if (hOT != null || aOT != null) periods.push({ number: 4 + ot, home_points: hOT || 0, away_points: aOT || 0 }); }

  const hScoring = periods.map(p => ({ type: 'quarter', number: p.number, sequence: p.number, points: p.home_points }));
  const aScoring = periods.map(p => ({ type: 'quarter', number: p.number, sequence: p.number, points: p.away_points }));

  // Lead changes / ties
  let lc = 0, tt = 0, prev = null;
  if (bdl.scoreLog) bdl.scoreLog.forEach(s => { const mg = s.hScore - s.aScore; const ld = mg > 0 ? 'h' : mg < 0 ? 'a' : 't'; if (ld === 't') tt++; else if (prev && prev !== 't' && ld !== prev) lc++; prev = ld; });

  function bpa(bPlayers, sIds) { return bPlayers.map(p => { const pl = p.player || {}; const pid = pl.id || p.id; return { id: pid, full_name: ((pl.first_name || '') + ' ' + (pl.last_name || '')).trim(), position: pl.position || '', primary_position: pl.position || '', played: (p.min && p.min !== '0') || (p.pts > 0), active: true, starter: sIds.has(pid), on_court: false, statistics: { minutes: p.min || '0', field_goals_made: p.fgm || 0, field_goals_att: p.fga || 0, three_points_made: p.fg3m || 0, three_points_att: p.fg3a || 0, free_throws_made: p.ftm || 0, free_throws_att: p.fta || 0, offensive_rebounds: p.oreb || 0, defensive_rebounds: p.dreb || 0, rebounds: p.reb || 0, assists: p.ast || 0, steals: p.stl || 0, blocks: p.blk || 0, turnovers: p.turnover || 0, personal_fouls: p.pf || 0, points: p.pts || 0, pls_min: p.plus_minus || 0 } }; }); }

  const srSt = normalizeBdlStatusServer(game.status, game);
  return { id: game.id, status: srSt, quarter: game.period || periods.length || 0, clock: normalizeBdlClockServer(game.time) || '', lead_changes: lc, times_tied: tt, _dataSource: 'BDL',
    home: { name: homeTeam.name || '', alias: hA, market: homeTeam.city || '', id: homeTeam.id || '', points: game.home_team_score || homeStats.points, bonus: game.home_in_bonus || false, double_bonus: false, remaining_timeouts: game.home_timeouts_remaining ?? null, scoring: hScoring, statistics: homeStats, players: bpa(homePlayers, hSIds) },
    away: { name: awayTeam.name || '', alias: aA, market: awayTeam.city || '', id: awayTeam.id || '', points: game.visitor_team_score || awayStats.points, bonus: game.visitor_in_bonus || false, double_bonus: false, remaining_timeouts: game.visitor_timeouts_remaining ?? null, scoring: aScoring, statistics: awayStats, players: bpa(awayPlayers, aSIds) },
    periods };
}

// ── In-memory BDL caches for server polling ──
let _serverBoxScoreCache = null;    // Array of box score objects
let _serverBoxScoreTime = 0;
let _serverLineupsCache = {};       // bdlGameId → lineups array

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

// ── QUARTER DATA HELPERS ──────────────────────────────────────────────────────
// Extracts the ~23 stat fields that power I1-I5 from a team's statistics object.
// Used for boundary capture and per-quarter diffing.

const QD_STAT_KEYS = [
  // I1 inputs
  'steals', 'offensive_rebounds', 'turnovers', 'total_turnovers',
  'fast_break_points', 'points_off_turnovers', 'second_chance_points',
  // I2 inputs
  'points_in_the_paint', 'points_in_paint', 'field_goals_at_rim_made', 'field_goals_at_rim_att',
  'free_throws_att', 'blocks', 'fouls_drawn', 'personal_fouls',
  // I3 inputs
  'field_goals_made', 'field_goals_att', 'three_points_made', 'three_points_att',
  'assists',
  // I4 inputs
  'bench_points', 'biggest_lead', 'points',
  // I5 inputs
  'offensive_points_per_possession', 'defensive_points_per_possession',
  'possessions',
  // Free throws (for sustainability / evidence)
  'free_throws_made',
];

function extractBoundaryStats(teamStats) {
  if (!teamStats) return {};
  const out = {};
  for (const k of QD_STAT_KEYS) {
    if (teamStats[k] != null) out[k] = teamStats[k];
  }
  return out;
}

function diffBoundaryStats(current, previous) {
  if (!current || !previous) return current || {};
  const d = {};
  for (const k of QD_STAT_KEYS) {
    const c = current[k], p = previous[k];
    // Rate fields — don't diff, use current value directly
    if (k === 'offensive_points_per_possession' || k === 'defensive_points_per_possession') {
      d[k] = c != null ? c : null;
      continue;
    }
    // biggest_lead — game-level max, not diffable, use current cumulative
    if (k === 'biggest_lead') {
      d[k] = c != null ? c : null;
      continue;
    }
    // Count fields — diff normally
    if (c != null && p != null) d[k] = c - p;
    else if (c != null) d[k] = c;
    else d[k] = null;
  }
  // Compute per-quarter efficiency from diffed possessions and points
  const qPoss = d.possessions;
  const qPts = d.points;
  if (qPoss != null && qPoss > 0 && qPts != null) {
    d._quarter_ppp = qPts / qPoss;
  }
  return d;
}

// Read quarter_data from games row, or return empty structure
async function readQuarterData(sql, gameId) {
  try {
    const rows = await sql`SELECT quarter_data FROM games WHERE id = ${gameId}`;
    if (rows.length > 0 && rows[0].quarter_data) {
      const qd = typeof rows[0].quarter_data === 'string'
        ? JSON.parse(rows[0].quarter_data)
        : rows[0].quarter_data;
      return qd;
    }
  } catch (e) { /* column may not exist yet */ }
  return { boundaries: {}, diffs: {}, window: null };
}

// Write quarter_data back to games row
async function writeQuarterData(sql, gameId, qd) {
  try {
    await sql`UPDATE games SET quarter_data = ${JSON.stringify(qd)} WHERE id = ${gameId}`;
  } catch (e) {
    log(`quarter_data write failed for ${gameId}: ${e.message}`);
  }
}

// Capture a boundary: freeze cumulative stats, compute diff from previous boundary
function captureBoundary(qd, periodKey, prevKey, homeStats, awayStats) {
  const boundary = {
    ts: new Date().toISOString(),
    home: extractBoundaryStats(homeStats),
    away: extractBoundaryStats(awayStats),
  };
  qd.boundaries[periodKey] = boundary;

  // Compute diff from the specified previous boundary
  const prevBoundary = qd.boundaries[prevKey];
  if (prevBoundary) {
    qd.diffs[periodKey] = {
      home: diffBoundaryStats(boundary.home, prevBoundary.home),
      away: diffBoundaryStats(boundary.away, prevBoundary.away),
    };
  }

  return qd;
}

// ── COMPUTE SERVER-SIDE ROLLING WINDOW ────────────────────────────────────────
// Runs every poll. Reads quarter_data boundaries, computes a partial diff for
// the current quarter, scores I1-I5 on the cross-fade weighted aggregate,
// saves the result back to quarter_data.window.
//
// Cross-fade weighting (matches client):
//   Q2: Q1(fading) + Q2(partial)
//   Q3: Q2(anchor) + Q3(partial)
//   Q4: Q2(fading) + Q3(anchor) + Q4(partial)
//   OT: Q3(fading) + Q4(anchor) + OT(partial)

function computeServerWindow(qd, currentPeriod, clock, summary, hA, aA, league) {
  if (!qd || !qd.boundaries) return null;

  // Need at least one completed quarter boundary + current stats
  const completedKeys = Object.keys(qd.diffs || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (completedKeys.length === 0) return null;

  // Compute partial current quarter: current cumulative - last boundary
  const lastBoundaryKey = String(Math.max(...completedKeys));
  const lastBoundary = qd.boundaries[lastBoundaryKey];
  if (!lastBoundary) return null;

  const homeStats = summary.home?.statistics || {};
  const awayStats = summary.away?.statistics || {};
  const partialDiff = {
    home: diffBoundaryStats(extractBoundaryStats(homeStats), lastBoundary.home),
    away: diffBoundaryStats(extractBoundaryStats(awayStats), lastBoundary.away),
  };

  // Clock → completion fraction
  const clockParts = (clock || '').split(':');
  const clockMins = clockParts.length === 2 ? parseInt(clockParts[0]) + (parseInt(clockParts[1] || 0) / 60) : 12;
  const periodLength = league === 'ncaamb' ? 20 : 12;
  const completion = Math.max(0, Math.min(1, (periodLength - clockMins) / periodLength));

  // Build weighted quarter map: {quarterKey: {weight, diff}}
  const windowQs = [];
  const p = currentPeriod;

  if (league === 'ncaamb') {
    // NCAAMB uses synthetic quarter keys 1,2,3
    // sQ1 = H1 first 10min, sQ2 = H1 last 10min + halftime, sQ3 = H2 first 10min
    // The diff keys match: 1, 2, 3
    for (const k of completedKeys) {
      // Older quarters fade, recent anchor
      const maxK = Math.max(...completedKeys);
      const weight = (k === maxK) ? 1.0 : (k >= maxK - 1) ? 1.0 : 0.5;
      if (qd.diffs[k]) windowQs.push({ key: k, weight, diff: qd.diffs[k] });
    }
    // Add partial current — key is next synthetic quarter after last completed
    const partialKey = Math.max(...completedKeys) + 1;
    windowQs.push({ key: partialKey, weight: 1.0, diff: partialDiff, partial: true });
  } else {
    // NBA cross-fade logic
    if (p === 2) {
      if (qd.diffs['1']) windowQs.push({ key: 1, weight: Math.max(0, 1.0 - completion), diff: qd.diffs['1'] });
      windowQs.push({ key: 2, weight: 1.0, diff: partialDiff, partial: true });
    } else if (p === 3) {
      if (qd.diffs['2']) windowQs.push({ key: 2, weight: 1.0, diff: qd.diffs['2'] });
      windowQs.push({ key: 3, weight: 1.0, diff: partialDiff, partial: true });
    } else if (p === 4) {
      if (qd.diffs['2']) windowQs.push({ key: 2, weight: Math.max(0, 1.0 - completion), diff: qd.diffs['2'] });
      if (qd.diffs['3']) windowQs.push({ key: 3, weight: 1.0, diff: qd.diffs['3'] });
      windowQs.push({ key: 4, weight: 1.0, diff: partialDiff, partial: true });
    } else if (p >= 5) {
      if (qd.diffs['3']) windowQs.push({ key: 3, weight: Math.max(0, 1.0 - completion), diff: qd.diffs['3'] });
      if (qd.diffs['4']) windowQs.push({ key: 4, weight: 1.0, diff: qd.diffs['4'] });
      windowQs.push({ key: p, weight: 1.0, diff: partialDiff, partial: true });
    } else {
      // Q1 or earlier — too early for a window
      return null;
    }
  }

  if (windowQs.length === 0) return null;

  // Aggregate stats with cross-fade weights
  function aggSide(side) {
    const agg = {};
    const countKeys = QD_STAT_KEYS.filter(k =>
      k !== 'offensive_points_per_possession' && k !== 'defensive_points_per_possession' && k !== 'biggest_lead'
    );
    for (const k of countKeys) {
      let sum = 0, hasAny = false;
      for (const wq of windowQs) {
        const v = wq.diff?.[side]?.[k];
        if (v != null) { sum += v * wq.weight; hasAny = true; }
      }
      agg[k] = hasAny ? sum : null;
    }
    // Derived rates from aggregated counts
    const fga = agg.field_goals_att || 1;
    agg.efg = fga > 0 ? ((agg.field_goals_made || 0) + 0.5 * (agg.three_points_made || 0)) / fga : null;
    agg.assist_ratio = (agg.field_goals_made || 0) > 0 ? ((agg.assists || 0) / (agg.field_goals_made || 1)) * 100 : null;
    // Per-quarter efficiency: weighted average of _quarter_ppp
    let pppSum = 0, pppW = 0;
    for (const wq of windowQs) {
      const ppp = wq.diff?.[side]?._quarter_ppp;
      if (ppp != null) { pppSum += ppp * wq.weight; pppW += wq.weight; }
    }
    agg.ppp = pppW > 0 ? pppSum / pppW : null;
    return agg;
  }

  const hW = aggSide('home'), aW = aggSide('away');

  // Score I1-I5 on aggregated window stats
  // Thresholds scaled for ~2 quarter window volume

  // I1 — Possession & Transition
  const hTO = hW.turnovers || hW.total_turnovers || 0;
  const aTO = aW.turnovers || aW.total_turnovers || 0;
  const hGen = (hW.steals || 0) + (hW.offensive_rebounds || 0) - hTO;
  const aGen = (aW.steals || 0) + (aW.offensive_rebounds || 0) - aTO;
  const hConv = (hW.fast_break_points || 0) + (hW.points_off_turnovers || 0) + (hW.second_chance_points || 0);
  const aConv = (aW.fast_break_points || 0) + (aW.points_off_turnovers || 0) + (aW.second_chance_points || 0);
  const i1r = (hGen > aGen ? 1 : hGen < aGen ? -1 : 0) + (hConv > aConv ? 1 : hConv < aConv ? -1 : 0);
  const wI1 = { score: i1r > 0 ? 1 : i1r === 0 ? 0.5 : 0, leader: i1r > 0 ? hA : i1r < 0 ? aA : 'EVEN' };

  // I2 — Rim Pressure & Foul (scaled threshold: 5 instead of 10 for ~half game volume)
  const hPaint = hW.points_in_the_paint || hW.points_in_paint || 0;
  const aPaint = aW.points_in_the_paint || aW.points_in_paint || 0;
  const hAtRim = hW.field_goals_at_rim_att || 0, aAtRim = aW.field_goals_at_rim_att || 0;
  const hFTA = hW.free_throws_att || 0, aFTA = aW.free_throws_att || 0;
  const hBlk = hW.blocks || 0, aBlk = aW.blocks || 0;
  const hFD = hW.fouls_drawn || 0, aFD = aW.fouls_drawn || 0;
  const rimD = (hPaint + hAtRim + hFTA + hBlk + Math.round(hFD * 0.5))
             - (aPaint + aAtRim + aFTA + aBlk + Math.round(aFD * 0.5));
  const wI2 = { score: rimD > 5 ? 1 : rimD < -5 ? 0 : 0.5, leader: rimD > 5 ? hA : rimD < -5 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation (eFG% and assist ratio are rates — thresholds unchanged)
  const hEFG = hW.efg || 0, aEFG = aW.efg || 0;
  const hAR = hW.assist_ratio || 0, aAR = aW.assist_ratio || 0;
  const i3r = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
            + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  const wI3 = { score: i3r > 0 ? 1 : i3r === 0 ? 0.5 : 0, leader: i3r > 0 ? hA : i3r < 0 ? aA : 'EVEN' };

  // I4 — Lineup Integrity (use cumulative biggest_lead + window bench diff + per-quarter scoring margins)
  const hBigLead = homeStats.biggest_lead || 0, aBigLead = awayStats.biggest_lead || 0;
  const hBench = hW.bench_points || 0, aBench = aW.bench_points || 0;
  const benchD = hBench - aBench;
  // Scoring margin trend from the window quarters
  const margins = windowQs.map(wq => ((wq.diff?.home?.points || 0) - (wq.diff?.away?.points || 0)));
  const trend = margins.length >= 2 ? margins[margins.length - 1] - margins[0] : 0;
  const i4r = (hBigLead > aBigLead + 4 ? 1 : hBigLead < aBigLead - 4 ? -1 : 0)
            + (trend > 2 ? 1 : trend < -2 ? -1 : 0)
            + (benchD > 5 ? 1 : benchD < -5 ? -1 : 0); // scaled bench threshold
  const wI4 = { score: i4r > 0 ? 1 : i4r === 0 ? 0.5 : 0, leader: i4r > 0 ? hA : i4r < 0 ? aA : 'EVEN' };

  // I5 — Tempo & Efficiency (use per-quarter PPP from diffs)
  const hPPP = hW.ppp || 0, aPPP = aW.ppp || 0;
  const effD = hPPP - aPPP;
  const wI5 = { score: effD > 0.08 ? 1 : effD < -0.08 ? 0 : 0.5, leader: effD > 0.08 ? hA : effD < -0.08 ? aA : 'EVEN' };

  // Composite
  const raw = wI1.score * W.I1 + wI2.score * W.I2 + wI3.score * W.I3 + wI4.score * W.I4 + wI5.score * W.I5;
  const ctrlHome = raw >= 0.5;
  const wTeam = ctrlHome ? hA : aA;
  const wScore = ctrlHome ? raw : 1 - raw;

  // Build window labels
  const windowQuarters = windowQs.map(wq => 'Q' + wq.key + (wq.partial ? '*' : ''));

  return {
    available: true,
    score: Math.round(wScore * 100) / 100,
    controlTeam: wTeam,
    windowQuarters,
    I1: { score: Math.round(wI1.score * 10) / 10 },
    I2: { score: Math.round(wI2.score * 10) / 10 },
    I3: { score: Math.round(wI3.score * 10) / 10 },
    I4: { score: Math.round(wI4.score * 10) / 10 },
    I5: { score: Math.round(wI5.score * 10) / 10 },
    dataQuality: 'SERVER-QD',
    source: 'server-qd',
    partial_quarter: currentPeriod,
    updated_at: new Date().toISOString(),
  };
}

// ── SERVER-SIDE SUSTAINABILITY AUDIT ─────────────────────────────────────────
// Ported from analyze.js. Pure function of SR summary data.
// No tracking data server-side — degrades gracefully (uses assist ratio only).

function computeSustainability(summary) {
  if (!summary) return null;

  function auditTeam(teamData, teamAlias) {
    if (!teamData) return null;
    var stats = teamData.statistics || {};
    var players = teamData.players || [];

    var team3PM = stats.three_points_made || 0;
    var team3PA = stats.three_points_att || 0;
    var teamFGA = stats.field_goals_att || 1;
    var live3Pct = team3PA > 0 ? (team3PM / team3PA * 100) : 0;

    // Season prior from player averages (SR summary may include .average)
    var seasonPrior3Pct = 36.0; // NBA average fallback
    var gotSeasonData = false;
    var seasonTot3PM = 0, seasonTot3PA = 0;
    players.forEach(function(p) {
      var avg = p.average || p.season || {};
      var m = avg.three_points_made || avg.fg3m || 0;
      var a = avg.three_points_att || avg.fg3a || 0;
      seasonTot3PM += m;
      seasonTot3PA += a;
    });
    if (seasonTot3PA >= 5) {
      seasonPrior3Pct = seasonTot3PM / seasonTot3PA * 100;
      gotSeasonData = true;
    }

    // Personnel audit
    var makesByTier = { elite: 0, average: 0, non: 0 };
    var personnelDetails = [];
    players.forEach(function(p) {
      var live = p.statistics || {};
      var avg = p.average || p.season || {};
      var live3m = live.three_points_made || 0;
      var live3a = live.three_points_att || 0;
      if (live3a < 2) return;

      var szn3m = avg.three_points_made || avg.fg3m || 0;
      var szn3a = avg.three_points_att || avg.fg3a || 0;
      var sznPct = szn3a >= 1.0 ? (szn3m / szn3a * 100) : null;
      var sznVol = szn3a;

      var tier, tierLabel;
      if (sznPct === null) { tier = 'non'; tierLabel = 'UNKNOWN'; }
      else if (sznPct >= 38.0 && sznVol >= 2.0) { tier = 'elite'; tierLabel = 'ELITE'; }
      else if (sznPct >= 33.0 || (sznPct >= 30.0 && sznVol >= 3.0)) { tier = 'average'; tierLabel = 'AVERAGE'; }
      else { tier = 'non'; tierLabel = 'NON-SHOOTER'; }

      if (sznVol < 1.5 && tier === 'elite') { tier = 'average'; tierLabel = 'AVG (low vol)'; }
      if (sznVol < 0.8 && tier !== 'non') { tier = 'non'; tierLabel = 'NON-SHOOTER (rare)'; }

      makesByTier[tier] += live3m;

      var livePct = (live3m / live3a * 100).toFixed(0);
      var sznStr = sznPct !== null ? sznPct.toFixed(1) + '% (' + sznVol.toFixed(1) + '/gm)' : 'N/A';
      var hot = sznPct !== null && (live3m / live3a * 100) > sznPct + 12;

      personnelDetails.push({
        name: p.full_name || p.name || '?',
        live3m: live3m, live3a: live3a, livePct: livePct,
        sznPct: sznPct, sznVol: sznVol, sznStr: sznStr,
        tier: tier, tierLabel: tierLabel, hot: hot,
      });
    });

    var totalMakes = team3PM || 1;
    var elitePct = makesByTier.elite / totalMakes * 100;
    var nonPct = makesByTier.non / totalMakes * 100;

    var personnelGrade;
    if (elitePct >= 70) personnelGrade = 'LOCKED IN';
    else if (elitePct >= 50 && nonPct <= 20) personnelGrade = 'DURABLE';
    else if (nonPct >= 50) personnelGrade = 'UNSUSTAINABLE';
    else if (nonPct >= 35) personnelGrade = 'FRAGILE';
    else personnelGrade = 'MIXED';

    // Bayesian regression
    var priorStrength = 30;
    var priorAlpha = seasonPrior3Pct / 100 * priorStrength;
    var priorBeta = (1 - seasonPrior3Pct / 100) * priorStrength;
    var posteriorAlpha = priorAlpha + team3PM;
    var posteriorBeta = priorBeta + (team3PA - team3PM);
    var posteriorMean = posteriorAlpha / (posteriorAlpha + posteriorBeta) * 100;
    var deviation = live3Pct - seasonPrior3Pct;

    var regressionProb;
    if (team3PA <= 8) regressionProb = 85;
    else if (team3PA <= 14) regressionProb = 70;
    else if (team3PA <= 20) regressionProb = 55;
    else if (team3PA <= 28) regressionProb = 40;
    else regressionProb = 25;

    if (deviation > 15) regressionProb = Math.min(95, regressionProb + 15);
    else if (deviation > 8) regressionProb = Math.min(95, regressionProb + 8);
    else if (deviation > 3) regressionProb = Math.min(95, regressionProb + 3);
    else if (deviation < -8) regressionProb = Math.max(5, regressionProb - 15);
    else if (deviation < -3) regressionProb = Math.max(5, regressionProb - 8);

    var regressionPull = 0;
    if (team3PA > 0 && Math.abs(live3Pct - seasonPrior3Pct) > 0.5) {
      regressionPull = Math.abs(posteriorMean - live3Pct) / Math.abs(live3Pct - seasonPrior3Pct) * 100;
    }
    regressionPull = Math.min(100, Math.max(0, regressionPull));

    var regressionGrade;
    if (regressionProb >= 75) regressionGrade = 'HIGH';
    else if (regressionProb >= 55) regressionGrade = 'MODERATE';
    else if (regressionProb >= 35) regressionGrade = 'LOW';
    else regressionGrade = 'MINIMAL';

    // Shot type context (no tracking data server-side — assist ratio only)
    var teamAssists = stats.assists || 0;
    var teamFGM = stats.field_goals_made || 1;
    var assistRatio = teamAssists / teamFGM * 100;

    var shotTypeGrade, shotTypeNote;
    if (assistRatio >= 65) { shotTypeGrade = 'DURABLE'; shotTypeNote = 'High ast% (' + assistRatio.toFixed(0) + '%)'; }
    else if (assistRatio < 45) { shotTypeGrade = 'FRAGILE'; shotTypeNote = 'Low ast% (' + assistRatio.toFixed(0) + '%)'; }
    else { shotTypeGrade = 'MIXED'; shotTypeNote = 'Moderate ast% (' + assistRatio.toFixed(0) + '%)'; }

    // Composite tier: personnel 40%, regression 35%, shot type 25%
    var scores = { personnel: 0, regression: 0, shotType: 0 };
    if (personnelGrade === 'LOCKED IN') scores.personnel = 0;
    else if (personnelGrade === 'DURABLE') scores.personnel = 0.5;
    else if (personnelGrade === 'MIXED') scores.personnel = 1;
    else if (personnelGrade === 'FRAGILE') scores.personnel = 1.5;
    else scores.personnel = 2;

    if (regressionGrade === 'MINIMAL') scores.regression = 0;
    else if (regressionGrade === 'LOW') scores.regression = 0.5;
    else if (regressionGrade === 'MODERATE') scores.regression = 1;
    else scores.regression = 2;

    if (shotTypeGrade === 'DURABLE') scores.shotType = 0;
    else if (shotTypeGrade === 'MIXED') scores.shotType = 1;
    else scores.shotType = 2;

    var composite = scores.personnel * 0.40 + scores.regression * 0.35 + scores.shotType * 0.25;

    var tier;
    if (composite <= 0.3) tier = 'LOCKED IN';
    else if (composite <= 0.7) tier = 'DURABLE';
    else if (composite <= 1.1) tier = 'MIXED';
    else if (composite <= 1.5) tier = 'FRAGILE';
    else tier = 'UNSUSTAINABLE';

    // Override: at/below season norm
    if (live3Pct <= seasonPrior3Pct + 2) {
      tier = 'LOCKED IN';
      regressionGrade = 'MINIMAL';
      personnelGrade = 'N/A (at baseline)';
    }
    // Override: too few attempts
    if (team3PA < 5) tier = 'TOO EARLY';

    return {
      teamAlias: teamAlias,
      live3PM: team3PM, live3PA: team3PA,
      live3Pct: live3Pct.toFixed(1), live3Rate: (team3PA / teamFGA * 100).toFixed(1),
      seasonPrior: seasonPrior3Pct.toFixed(1), gotSeasonData: gotSeasonData,
      deviation: deviation.toFixed(1),
      personnelGrade: personnelGrade, personnelDetails: personnelDetails,
      elitePct: elitePct.toFixed(0), nonPct: nonPct.toFixed(0),
      posteriorMean: posteriorMean.toFixed(1),
      regressionPull: regressionPull.toFixed(0),
      regressionProb: regressionProb, regressionGrade: regressionGrade,
      shotTypeGrade: shotTypeGrade, shotTypeNote: shotTypeNote,
      assistRatio: assistRatio.toFixed(0),
      composite: composite.toFixed(2), tier: tier,
    };
  }

  return {
    home: auditTeam(summary.home, summary.home?.alias || 'HOME'),
    away: auditTeam(summary.away, summary.away?.alias || 'AWAY'),
  };
}

// ── SERVER-SIDE LEAD COMPOSITION ────────────────────────────────────────────
// Ported from analyze.js. Pure function of SR summary data.

function computeLeadComposition(summary) {
  if (!summary) return null;
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hPts = H.points || 0, aPts = A.points || 0;
  if (hPts === 0 && aPts === 0) return null;
  const hA = H.alias || 'HOME', aA = A.alias || 'AWAY';

  function breakdown(stats, total) {
    var paint = stats.points_in_the_paint || stats.points_in_paint || 0;
    var atRimPts = (stats.field_goals_at_rim_made || 0) * 2;
    paint = Math.max(paint, atRimPts);
    var ft = stats.free_throws_made || 0;
    var three = (stats.three_points_made || 0) * 3;
    var midOther = Math.max(0, total - paint - ft - three);
    var structural = paint + ft;
    var variance = three + midOther;
    return { total, paint, ft, three, midOther, structural, variance };
  }

  var hB = breakdown(hs, hPts);
  var aB = breakdown(as, aPts);

  var margin = hPts - aPts;
  var absMargin = Math.abs(margin);
  var leadTeam = margin >= 0 ? hA : aA;
  var trailTeam = margin >= 0 ? aA : hA;
  var leadStruct = margin >= 0 ? (hB.structural - aB.structural) : (aB.structural - hB.structural);
  var leadVar = margin >= 0 ? (hB.variance - aB.variance) : (aB.variance - hB.variance);

  var classification;
  if (absMargin <= 2) classification = 'EVEN';
  else if (leadStruct >= absMargin * 0.6) classification = 'STRUCTURAL';
  else if (leadVar >= absMargin * 0.6) classification = 'VOLATILE'; // simplified — no sustainability cross-ref server-side
  else classification = 'MIXED';

  return { classification, leadTeam, structuralMargin: leadStruct, varianceMargin: leadVar };
}

// ── THROUGHPUT / LEAD SAFETY (ported from client) ──────────────────────────
// Pure math — no API calls, no DB queries. All inputs from poll loop.

function computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, deficit, minsLeft, minsElapsed, gameFraction, sznDefault) {
  var focalPoss = Number(focalStats.possessions) || 0;
  var targetPoss = Number(targetStats.possessions) || 0;
  if (focalPoss < 3) focalPoss = (Number(focalStats.field_goals_att)||0) + 0.44*(Number(focalStats.free_throws_att)||0) - (Number(focalStats.offensive_rebounds)||0) + (Number(focalStats.turnovers||focalStats.total_turnovers)||0);
  if (targetPoss < 3) targetPoss = (Number(targetStats.field_goals_att)||0) + 0.44*(Number(targetStats.free_throws_att)||0) - (Number(targetStats.offensive_rebounds)||0) + (Number(targetStats.turnovers||targetStats.total_turnovers)||0);
  if (focalPoss < 5 || targetPoss < 5 || isNaN(focalPoss) || isNaN(targetPoss)) return null;

  function structRate(st, poss) {
    var paint = Number(st.points_in_the_paint || st.points_in_paint) || 0;
    var ft = Number(st.free_throws_made) || 0;
    var pot = Number(st.points_off_turnovers) || 0;
    var scp = Number(st.second_chance_points || st.second_chance_pts) || 0;
    return (paint + ft + pot + scp) / poss;
  }
  var focalStructRate = structRate(focalStats, focalPoss);
  var targetStructRate = structRate(targetStats, targetPoss);
  var structEdge = focalStructRate - targetStructRate;

  function getVarData(sustObj, stats, poss) {
    if (!sustObj) return { deviation: 0, threePARate: 0, live3Pct: 0, sznPct: sznDefault };
    var livePct = parseFloat(sustObj.live3Pct || 0);
    var sznPct = parseFloat(sustObj.seasonPrior || sustObj.seasonBaseline || sznDefault);
    var dev = livePct - sznPct;
    var tpaRate = poss > 0 ? (Number(stats.three_points_att) || 0) / poss : 0;
    return { deviation: dev, threePARate: tpaRate, live3Pct: livePct, sznPct: sznPct };
  }
  var focalVar = getVarData(focalSustData, focalStats, focalPoss);
  var targetVar = getVarData(targetSustData, targetStats, targetPoss);

  var avgPoss = (focalPoss + targetPoss) / 2;
  var possPerMin = avgPoss / minsElapsed;
  var remainingPoss = possPerMin * minsLeft;
  if (isNaN(remainingPoss) || remainingPoss < 1) return null;

  var degradation = 1.0;
  if (deficit >= 24) degradation = 0.70;
  else if (deficit >= 18) degradation = 0.85;

  var bandDefs = [
    { label: 'conservative', baseRate: 0.40 },
    { label: 'expected',     baseRate: 0.65 },
    { label: 'optimistic',   baseRate: 0.90 },
  ];
  var bands = bandDefs.map(function(band) {
    var appliedRegression = band.baseRate * gameFraction;
    var targetCooling = targetVar.deviation > 0 ? (targetVar.deviation / 100) * appliedRegression * targetVar.threePARate * 3 : 0;
    var focalHeating = focalVar.deviation < 0 ? (Math.abs(focalVar.deviation) / 100) * appliedRegression * focalVar.threePARate * 3 : 0;
    var targetHeating = targetVar.deviation < 0 ? (Math.abs(targetVar.deviation) / 100) * appliedRegression * targetVar.threePARate * 3 : 0;
    var focalCooling = focalVar.deviation > 0 ? (focalVar.deviation / 100) * appliedRegression * focalVar.threePARate * 3 : 0;
    var netSwingPerPoss = (structEdge * degradation) + targetCooling + focalHeating - targetHeating - focalCooling;
    var totalSwing = netSwingPerPoss * remainingPoss;
    var ratio = deficit > 0 ? totalSwing / deficit : 0;
    return { label: band.label, ratio: Math.round(ratio * 100) / 100, totalSwing: Math.round(totalSwing * 10) / 10, netSwingPerPoss: Math.round(netSwingPerPoss * 1000) / 1000 };
  });
  if (isNaN(bands[0].totalSwing) || isNaN(bands[1].totalSwing) || isNaN(remainingPoss)) return null;

  return { bands, focalStructRate: Math.round(focalStructRate * 1000) / 1000, targetStructRate: Math.round(targetStructRate * 1000) / 1000,
    structEdge: Math.round(structEdge * 1000) / 1000, focalVar, targetVar, remainingPoss: Math.round(remainingPoss), degradation };
}

function computeThroughputServer(summary, ind, sust, hA, aA, period, clock, league) {
  if (!summary || !summary.home || !summary.away || period < 2) return null;
  if (!ind || !ind.score) return null;
  var fTeam = ind.controlTeam;
  var ctrlIsHome = fTeam === hA;
  var hPts = summary.home?.points || 0, aPts = summary.away?.points || 0;
  var ctrlPts = ctrlIsHome ? hPts : aPts;
  var oppPts = ctrlIsHome ? aPts : hPts;
  var deficit = oppPts - ctrlPts;
  if (deficit <= 0) return null; // not trailing

  var PERIOD_MINUTES = league === 'ncaamb' ? 20 : 12;
  var GAME_MINUTES = league === 'ncaamb' ? 40 : 48;
  var totalPeriods = league === 'ncaamb' ? 2 : 4;
  var clockParts = (clock || '').split(':');
  var clockMins = clockParts.length === 2 ? (parseInt(clockParts[0]) || 0) + ((parseInt(clockParts[1]) || 0) / 60) : PERIOD_MINUTES;
  var periodsLeft = Math.max(0, totalPeriods - period);
  var minsLeft = clockMins + (periodsLeft * PERIOD_MINUTES);
  var minsElapsed = Math.max(1, GAME_MINUTES - minsLeft);
  var gameFraction = Math.min(1, minsLeft / GAME_MINUTES);
  if (minsLeft < 0.3 || isNaN(minsLeft)) return null;

  var hs = summary.home?.statistics || {};
  var as = summary.away?.statistics || {};
  var focalStats = ctrlIsHome ? hs : as;
  var targetStats = ctrlIsHome ? as : hs;
  var sznDefault = league === 'ncaamb' ? 33 : 36;

  var focalSustData = sust ? (ctrlIsHome ? sust.home : sust.away) : null;
  var targetSustData = sust ? (ctrlIsHome ? sust.away : sust.home) : null;

  var core = computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, deficit, minsLeft, minsElapsed, gameFraction, sznDefault);
  if (!core) return null;
  var con = core.bands[0], exp = core.bands[1], opt = core.bands[2];

  var classification;
  if (con.ratio > 1.2) classification = 'STRONG RECOVERY';
  else if (con.ratio > 0.9) classification = 'PROBABLE';
  else if (con.ratio > 0.6) classification = 'CONTESTED';
  else if (con.ratio > 0.3) classification = 'UNLIKELY';
  else classification = 'NO PATH';

  return { classification, deficit, remainingPoss: core.remainingPoss,
    conservative: con, expected: exp, optimistic: opt,
    ctrlStructRate: core.focalStructRate, oppStructRate: core.targetStructRate,
    structEdge: core.structEdge, degradation: core.degradation,
    minsLeft: Math.round(minsLeft * 10) / 10, fTeam };
}

function computeLeadSafetyServer(summary, ind, sust, hA, aA, period, clock, league) {
  if (!summary || !summary.home || !summary.away || period < 2) return null;
  if (!ind || !ind.score) return null;
  var fTeam = ind.controlTeam;
  var ctrlIsHome = fTeam === hA;
  var hPts = summary.home?.points || 0, aPts = summary.away?.points || 0;
  var ctrlPts = ctrlIsHome ? hPts : aPts;
  var oppPts = ctrlIsHome ? aPts : hPts;
  var lead = ctrlPts - oppPts;
  if (lead < 2) return null; // not leading enough

  var PERIOD_MINUTES = league === 'ncaamb' ? 20 : 12;
  var GAME_MINUTES = league === 'ncaamb' ? 40 : 48;
  var totalPeriods = league === 'ncaamb' ? 2 : 4;
  var clockParts = (clock || '').split(':');
  var clockMins = clockParts.length === 2 ? (parseInt(clockParts[0]) || 0) + ((parseInt(clockParts[1]) || 0) / 60) : PERIOD_MINUTES;
  var periodsLeft = Math.max(0, totalPeriods - period);
  var minsLeft = clockMins + (periodsLeft * PERIOD_MINUTES);
  var minsElapsed = Math.max(1, GAME_MINUTES - minsLeft);
  var gameFraction = Math.min(1, minsLeft / GAME_MINUTES);
  if (minsLeft < 0.3 || isNaN(minsLeft)) return null;

  var hs = summary.home?.statistics || {};
  var as = summary.away?.statistics || {};
  // Focal = OPPONENT (trailing, trying to recover)
  var focalStats = ctrlIsHome ? as : hs;
  var targetStats = ctrlIsHome ? hs : as;
  var sznDefault = league === 'ncaamb' ? 33 : 36;

  var focalSustData = sust ? (ctrlIsHome ? sust.away : sust.home) : null;
  var targetSustData = sust ? (ctrlIsHome ? sust.home : sust.away) : null;

  var core = computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, lead, minsLeft, minsElapsed, gameFraction, sznDefault);
  if (!core) return null;
  var con = core.bands[0], exp = core.bands[1], opt = core.bands[2];

  var classification;
  if (con.ratio > 0.8) classification = 'CRITICAL';
  else if (exp.ratio > 0.7) classification = 'AT RISK';
  else if (opt.ratio > 0.5 && exp.ratio >= 0.3) classification = 'CUSHIONED';
  else classification = 'SAFE';

  var oppTeam = ctrlIsHome ? aA : hA;
  return { classification, lead, remainingPoss: core.remainingPoss,
    conservative: con, expected: exp, optimistic: opt,
    oppStructRate: core.focalStructRate, ctrlStructRate: core.targetStructRate,
    structEdge: core.structEdge, degradation: core.degradation,
    minsLeft: Math.round(minsLeft * 10) / 10, fTeam, oppTeam };
}

function mlToProb(ml) {
  var n = parseFloat(ml);
  if (isNaN(n) || n === 0) return null;
  return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100);
}

function fmtSwing(v) { var n = Math.round(v); return n >= 0 ? '+' + n : '' + n; }

// ── SERVER-SIDE CONTEXT COMPUTATION ─────────────────────────────────────────
// Computes the 9 data layers that are normally client-only.
// Used as fallback when client hasn't pushed context to DB.
// Priority: client-pushed context > server-computed context > null.

// Classify combined read — ported from client
function classifyCombinedReadServer(floorScore, floorTeam, windowResult, accelResult) {
  if (!windowResult || !windowResult.available) return { read: 'TOO EARLY', note: 'Window not yet available' };
  const wScore = windowResult.score;
  const wTeam = windowResult.controlTeam;
  const accel = accelResult?.accel || 'STABLE';

  if (floorTeam !== wTeam) {
    if (accel === 'FLIPPED') return { read: 'FLIPPED', note: wTeam + ' taking control from ' + floorTeam };
    return { read: 'SHIFT', note: 'Floor: ' + floorTeam + ' / Window: ' + wTeam + ' — control contested' };
  }
  if (floorScore >= 0.75 && wScore >= 0.80 && (accel === 'GROWING' || accel === 'STABLE'))
    return { read: 'DOMINANT', note: 'Structural edge compounding' };
  if (floorScore >= 0.75 && wScore >= 0.75)
    return { read: 'STRONG', note: 'Structural edge holding' };
  if (floorScore >= 0.75 && wScore >= 0.60 && wScore < 0.75 && (accel === 'DECLINING' || accel === 'STABLE'))
    return { read: 'ERODING', note: 'Structure holds but momentum lost' };
  if (floorScore >= 0.75 && wScore < 0.60)
    return { read: 'COLLAPSING', note: 'Structural edge breaking down' };
  if (floorScore >= 0.60 && floorScore < 0.75 && wScore >= 0.75 && accel === 'GROWING')
    return { read: 'EMERGING', note: 'Edge strengthening toward confirmation' };
  if (floorScore >= 0.60 && floorScore < 0.75 && wScore >= 0.60)
    return { read: 'EARNED', note: 'Modest edge, steady' };
  if (floorScore >= 0.60 && floorScore < 0.75 && wScore < 0.60)
    return { read: 'FADING', note: 'Edge was real but dissipating' };
  if (floorScore < 0.60 && wScore >= 0.65 && accel === 'GROWING')
    return { read: 'SHIFT', note: 'No cumulative edge but recent control emerging' };
  return { read: 'NO EDGE', note: 'Insufficient signal' };
}

// Compute acceleration from gap entries — ported from client
function computeAccelerationServer(entries) {
  if (!entries || entries.length < 2) return { accel: 'TOO EARLY', entries: entries || [], consecutive: 0 };

  const recent = entries.slice(-4);
  const deltas = [];
  for (let i = 1; i < recent.length; i++) deltas.push(recent[i].gap - recent[i - 1].gap);

  // Check gap sign flip
  const lastTwo = entries.slice(-2);
  if ((lastTwo[0].gap > 0.02 && lastTwo[1].gap < -0.02) || (lastTwo[0].gap < -0.02 && lastTwo[1].gap > 0.02)) {
    return { accel: 'FLIPPED', entries: entries.slice(-5), consecutive: 1 };
  }

  const threshold = 0.015;
  let growing = 0, declining = 0;
  for (let i = deltas.length - 1; i >= 0; i--) {
    if (deltas[i] > threshold) growing++;
    else if (deltas[i] < -threshold) declining++;
    else break;
  }

  if (growing >= 2) return { accel: 'GROWING', entries: entries.slice(-5), consecutive: growing };
  if (declining >= 2) return { accel: 'DECLINING', entries: entries.slice(-5), consecutive: declining };
  return { accel: 'STABLE', entries: entries.slice(-5), consecutive: 0 };
}

// Classify adjustment from arrows — ported from client
function classifyAdjustmentServer(arrows, controlTeam, hA, aA) {
  if (!arrows) return { signal: 'NO DATA', note: 'Arrows unavailable' };
  const side = controlTeam === hA ? 'home' : 'away';
  const a = arrows[side];
  if (!a) return { signal: 'NO DATA', note: 'No arrow data for control team' };
  const risingStructural = ['paint', 'atRim', 'fta', 'steals'].filter(k => a[k]?.arrow === 'RISING').length;
  const fallingVariance = ['fg3aShare', 'tos'].filter(k => a[k]?.arrow === 'FALLING').length;
  const fallingStructural = ['paint', 'atRim', 'fta'].filter(k => a[k]?.arrow === 'FALLING').length;
  const risingVariance = ['fg3aShare', 'tos'].filter(k => a[k]?.arrow === 'RISING').length;

  if (risingStructural >= 2 && fallingVariance >= 1)
    return { signal: 'INTERIOR PIVOT', note: 'Progressive rim pressure replacing perimeter variance', team: controlTeam };
  if (fallingStructural >= 2)
    return { signal: 'STRUCTURAL EROSION', note: 'Interior game fading — structural edge at risk', team: controlTeam };
  if (risingVariance >= 1 && fallingStructural >= 1)
    return { signal: 'VARIANCE SHIFT', note: 'Shifting to perimeter — production becoming less durable', team: controlTeam };
  if (risingStructural >= 2)
    return { signal: 'STRUCTURAL ACCEL', note: 'Multiple structural inputs compounding', team: controlTeam };
  return { signal: 'NO ADJUSTMENT', note: 'Shot diet stable', team: controlTeam };
}

// Parse PBP into audit — simplified server-side port (no possession log, no timeline)
function parsePBPServer(pbpData, hId, aId, hA, aA) {
  const allEvents = [];
  const periods = pbpData?.periods || [];
  periods.forEach(per => {
    const q = per.number || per.sequence || 0;
    (per.events || []).forEach(ev => { ev._quarter = q; allEvents.push(ev); });
  });

  function resolveTeam(ev, stat) {
    const attrId = ev.attribution?.id || stat?.team?.id || '';
    if (attrId === hId) return hA;
    if (attrId === aId) return aA;
    return ev.attribution?.market || '?';
  }

  function classifyZone(ev, stat, isThree) {
    const loc = ev.location || {};
    const actionArea = (loc.action_area || ev.action_area || stat.action_area || '').toLowerCase();
    const coordY = loc.coord_y ?? ev.coord_y ?? null;
    const shotDist = stat.shot_distance ?? ev.shot_distance ?? null;
    if (isThree) {
      if (actionArea.includes('corner') || (coordY !== null && (coordY < 8 || coordY > 42))) return 'corner3';
      return 'above3';
    }
    if (shotDist !== null && shotDist <= 4) return 'rim';
    const shotTypeRaw = (stat.shot_type_desc || stat.shot_type || '').toLowerCase();
    const descRaw = (ev.description || '').toLowerCase();
    if (actionArea.includes('restricted') || actionArea.includes('rim')
      || shotTypeRaw.includes('layup') || shotTypeRaw.includes('dunk') || shotTypeRaw.includes('tip')
      || descRaw.includes('layup') || descRaw.includes('dunk')) return 'rim';
    if (actionArea.includes('paint') || actionArea.includes('lane')) return 'paint';
    return 'mid';
  }

  function classifyTO(stat, ev) {
    const toType = (stat.turnover_type || ev.turnover_type || '').toLowerCase();
    const desc = (ev.description || '').toLowerCase();
    if (toType.includes('steal') || toType.includes('bad pass') || desc.includes('steal')) return true;
    if (toType.includes('lost ball') || toType.includes('out of bounds') || toType.includes('travel') || toType.includes('violation')) return false;
    return null;
  }

  const shots = [], turnovers = [], scoreLog = [];
  let hScore = 0, aScore = 0;

  allEvents.forEach(ev => {
    if (ev.rescinded) return;
    const et = (ev.event_type || '').toLowerCase().replace(/[\s_-]/g, '');
    const stat = (ev.statistics || [])[0] || {};
    const team = resolveTeam(ev, stat);
    const player = stat?.player?.full_name || stat?.player?.name || ev.player?.full_name || '?';
    const quarter = ev._quarter;

    const isThree = et.includes('threepoint') || et.includes('3pt');
    const isTwo = et.includes('twopoint') || et.includes('2pt');
    if (isThree || isTwo) {
      const made = et.includes('made');
      const zone = classifyZone(ev, stat, isThree);
      let assisted = false;
      if (made) {
        const d = (ev.description || '').toLowerCase();
        if (d.includes('assist')) assisted = true;
        (ev.statistics || []).forEach(s => { if ((s.type || '').toLowerCase().includes('assist')) assisted = true; });
      }
      const pts = made ? (isThree ? 3 : 2) : 0;
      shots.push({ p: player, tm: team, z: zone, m: made, a: assisted, q: quarter, is3: isThree });
      if (made) {
        if (team === hA) hScore += pts; else aScore += pts;
        scoreLog.push({ team, pts, hScore, aScore, q: quarter });
      }
    } else if (et.includes('turnover')) {
      const forced = classifyTO(stat, ev);
      const toType = (stat.turnover_type || ev.turnover_type || '').substring(0, 40);
      turnovers.push({ p: player, tm: team, q: quarter, forced, type: toType });
    }
  });

  // Scoring runs
  const runs = [];
  let runTeam = null, runPts = 0, runStart = 0, runCount = 0, runShotTypes = [];
  for (let i = 0; i < scoreLog.length; i++) {
    const s = scoreLog[i];
    if (s.team === runTeam) {
      runPts += s.pts; runCount++;
      runShotTypes.push(s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT');
    } else {
      if (runPts >= 8 || runCount >= 3) runs.push({ team: runTeam, pts: runPts, count: runCount, q: scoreLog[runStart]?.q, mechanism: runShotTypes.slice() });
      runTeam = s.team; runPts = s.pts; runStart = i; runCount = 1; runShotTypes = [s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT'];
    }
  }
  if (runPts >= 8 || runCount >= 3) runs.push({ team: runTeam, pts: runPts, count: runCount, q: scoreLog[runStart]?.q, mechanism: runShotTypes.slice() });
  runs.sort((a, b) => b.pts - a.pts);

  // Per-team aggregation
  function aggTeam(tm) {
    const s = shots.filter(x => x.tm === tm);
    const threes = s.filter(x => x.is3), rim = s.filter(x => x.z === 'rim'), mid = s.filter(x => x.z === 'mid');
    const threeMade = threes.filter(x => x.m), rimMade = rim.filter(x => x.m), midMade = mid.filter(x => x.m);
    const assistedThrees = threeMade.filter(x => x.a).length;
    const assistedMid = midMade.filter(x => x.a).length;

    // Per-player 3PT
    const playerThrees = {};
    threes.forEach(x => {
      if (!playerThrees[x.p]) playerThrees[x.p] = { name: x.p, made: 0, att: 0, assisted: 0, contexts: {} };
      playerThrees[x.p].att++;
      if (x.m) { playerThrees[x.p].made++; if (x.a) playerThrees[x.p].assisted++; }
    });
    // Per-player rim
    const playerRim = {};
    rim.forEach(x => {
      if (!playerRim[x.p]) playerRim[x.p] = { name: x.p, made: 0, att: 0, contexts: {} };
      playerRim[x.p].att++; if (x.m) playerRim[x.p].made++;
    });
    // Per-player mid
    const playerMid = {};
    mid.forEach(x => {
      if (!playerMid[x.p]) playerMid[x.p] = { name: x.p, made: 0, att: 0, assisted: 0 };
      playerMid[x.p].att++; if (x.m) { playerMid[x.p].made++; if (x.a) playerMid[x.p].assisted++; }
    });
    // TOs
    const tms = turnovers.filter(t => t.tm === tm);
    const forced = tms.filter(t => t.forced === true).length;
    const unforced = tms.filter(t => t.forced === false).length;
    const unknown = tms.filter(t => t.forced === null).length;

    return {
      threes: { made: threeMade.length, att: threes.length, assisted: assistedThrees, pct: threes.length > 0 ? (threeMade.length / threes.length * 100).toFixed(1) : '0',
        corner: { made: threeMade.filter(x => x.z === 'corner3').length, att: threes.filter(x => x.z === 'corner3').length },
        above: { made: threeMade.filter(x => x.z === 'above3').length, att: threes.filter(x => x.z === 'above3').length },
        byPlayer: Object.values(playerThrees).filter(x => x.att >= 1).sort((a, b) => b.att - a.att) },
      rim: { made: rimMade.length, att: rim.length, pct: rim.length > 0 ? (rimMade.length / rim.length * 100).toFixed(1) : '0',
        byPlayer: Object.values(playerRim).filter(x => x.att >= 1).sort((a, b) => b.att - a.att) },
      mid: { made: midMade.length, att: mid.length, assisted: assistedMid, pct: mid.length > 0 ? (midMade.length / mid.length * 100).toFixed(1) : '0',
        byPlayer: Object.values(playerMid).filter(x => x.att >= 1).sort((a, b) => b.att - a.att) },
      tos: { total: tms.length, forced, unforced, unknown, byPlayer: tms },
      shotDiet: { total: s.length, threePct: s.length > 0 ? (threes.length / s.length * 100).toFixed(1) : '0', rimPct: s.length > 0 ? (rim.length / s.length * 100).toFixed(1) : '0', midPct: s.length > 0 ? (mid.length / s.length * 100).toFixed(1) : '0' },
    };
  }

  return {
    home: aggTeam(hA), away: aggTeam(aA),
    homeAlias: hA, awayAlias: aA,
    totalShots: shots.length, totalTOs: turnovers.length,
    runs: runs.slice(0, 5),
    // Per-quarter sub-metric aggregation for arrows
    perQuarter: buildPerQuarterMetrics(shots, turnovers, hA, aA),
    pbpPeriod: periods.length,
    pbpAge: 0,
  };
}

// Build per-quarter sub-metrics from PBP for arrow computation
function buildPerQuarterMetrics(shots, turnovers, hA, aA) {
  const quarters = {};
  // Get all quarter numbers
  const allQ = new Set();
  shots.forEach(s => allQ.add(s.q));
  turnovers.forEach(t => allQ.add(t.q));

  for (const q of allQ) {
    const qShots = shots.filter(s => s.q === q);
    const qTOs = turnovers.filter(t => t.q === q);

    function teamMetrics(tm) {
      const s = qShots.filter(x => x.tm === tm);
      const threes = s.filter(x => x.is3);
      const rim = s.filter(x => x.z === 'rim');
      const rimMade = rim.filter(x => x.m);
      const threeMade = threes.filter(x => x.m);
      const allMade = s.filter(x => x.m);
      const assisted = allMade.filter(x => x.a).length;
      const tms = qTOs.filter(t => t.tm === tm);
      const stls = qTOs.filter(t => t.tm !== tm && t.forced === true).length; // opponent's forced TOs = our steals

      return {
        points_in_the_paint: rimMade.length * 2, // proxy
        field_goals_at_rim_att: rim.length,
        free_throws_att: 0, // can't extract from shot PBP alone — would need FT events
        steals: stls,
        turnovers: tms.length,
        fg3a_share: s.length > 0 ? (threes.length / s.length * 100) : 0,
        assist_ratio: allMade.length > 0 ? (assisted / allMade.length * 100) : 0,
        possessions: s.length + tms.length, // rough proxy
      };
    }

    quarters[q] = {
      home: teamMetrics(hA),
      away: teamMetrics(aA),
    };
  }
  return quarters;
}

// Compute sub-metric arrows from per-quarter PBP metrics
function computeSubMetricArrowsServer(perQuarter, hA, aA) {
  if (!perQuarter) return null;
  const qNums = Object.keys(perQuarter).map(Number).sort((a, b) => a - b);
  if (qNums.length < 2) return null;

  const metrics = [
    { key: 'paint', field: 'points_in_the_paint', label: 'Paint pts', threshold: 3 },
    { key: 'atRim', field: 'field_goals_at_rim_att', label: 'At-rim att', threshold: 2 },
    { key: 'fta', field: 'free_throws_att', label: 'FTA', threshold: 2 },
    { key: 'steals', field: 'steals', label: 'Steals', threshold: 1 },
    { key: 'tos', field: 'turnovers', label: 'TOs', threshold: 1 },
    { key: 'fg3aShare', field: 'fg3a_share', label: '3PA%', threshold: 5 },
    { key: 'astRatio', field: 'assist_ratio', label: 'Ast ratio', threshold: 8 },
    { key: 'poss', field: 'possessions', label: 'Poss', threshold: 2 },
  ];

  function computeArrow(values, threshold) {
    const valid = values.filter(v => v != null);
    if (valid.length < 2) return { arrow: null, values };
    const last3 = valid.slice(-3);
    if (last3.length < 2) return { arrow: null, values: last3 };
    const first = last3[0], last = last3[last3.length - 1];
    const diff = last - first;
    let rising = true, falling = true;
    for (let i = 1; i < last3.length; i++) {
      if (last3[i] < last3[i - 1]) rising = false;
      if (last3[i] > last3[i - 1]) falling = false;
    }
    if (rising && diff > threshold) return { arrow: 'RISING', values: last3 };
    if (falling && Math.abs(diff) > threshold) return { arrow: 'FALLING', values: last3 };
    if (last3.length >= 3) {
      if (last3[1] > first + threshold && last > first + threshold) return { arrow: 'RISING', values: last3 };
      if (last3[1] < first - threshold && last < first - threshold) return { arrow: 'FALLING', values: last3 };
    }
    return { arrow: 'FLAT', values: last3 };
  }

  const result = { home: {}, away: {} };
  ['home', 'away'].forEach(side => {
    metrics.forEach(m => {
      const vals = qNums.map(q => perQuarter[q]?.[side]?.[m.field] ?? null);
      const { arrow, values } = computeArrow(vals, m.threshold);
      const display = arrow ? (arrow === 'RISING' ? '▲' : arrow === 'FALLING' ? '▼' : '▬') : '—';
      const valStr = values.map(v => v != null ? (m.field.includes('share') || m.field.includes('ratio') ? v.toFixed(0) + '%' : String(Math.round(v))) : '?').join('→');
      result[side][m.key] = { arrow, values, display: display + ' (' + valStr + ')', label: m.label };
    });
  });

  return result;
}

// Main server context computation — called when client hasn't pushed context
async function computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, period, clock, matchup, sust, odds) {
  const ctx = {};
  const W = { I1: 0.25, I2: 0.25, I3: 0.20, I4: 0.20, I5: 0.10 };

  // ── 1. BONUS STATUS (from SR summary — trivial) ──
  if (summary.home?.bonus || summary.away?.bonus) {
    ctx.bonusStatus = {
      home: summary.home?.bonus || false,
      away: summary.away?.bonus || false,
      homeDouble: summary.home?.double_bonus || false,
      awayDouble: summary.away?.double_bonus || false,
    };
  }

  // ── 2. ESPN WP ──
  if (espnWP) {
    ctx.espnWP = {
      home: espnWP.home, away: espnWP.away,
      homeAlias: hA, awayAlias: aA,
      opening: null, dataPoints: 0,
    };
  }

  // ── 3. EDGE HISTORY (from prior analyses in DB) ──
  try {
    const rows = await sql`
      SELECT control_team, control_score, fwp, edge, ts, period, clock
      FROM analyses WHERE game_id = ${game.id}
      ORDER BY ts ASC LIMIT 10
    `;
    if (rows.length > 0) {
      ctx.edgeHistory = rows.map(r => ({
        time: r.ts ? new Date(r.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) : '?',
        period: 'Q' + (r.period || '?'),
        edge: r.edge || '?',
        fwp: r.fwp || '?',
        control: (r.control_team || '?') + ' ' + (r.control_score != null ? r.control_score.toFixed(2) : '?'),
        score: '',
      }));
    }
  } catch (e) { /* no prior analyses */ }

  // ── 4. ROLLING WINDOW + ACCELERATION (from quarter_data — same engine as snapshot responses) ──
  try {
    const qd = await readQuarterData(sql, game.id);
    const completedKeys = Object.keys(qd.diffs || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (completedKeys.length >= 1 && summary) {
      // Use the good server window function (same as snapshot piggyback)
      const serverWindow = computeServerWindow(qd, period, clock, summary, hA, aA, league);
      if (serverWindow && serverWindow.available) {
        ctx.rollingWindow = serverWindow;
        ctx.rollingWindow.dataQuality = 'SERVER-QD';
      }
    }
    // Store quarter diffs for prompt
    if (qd.diffs && Object.keys(qd.diffs).length > 0) {
      ctx.quarterDiffs = qd.diffs;
    }

    // Acceleration from snapshots (gap trajectory still uses snapshot history — more data points)
    const snaps = await sql`
      SELECT period, floor_score, floor_team, i1, i2, i3, i4, i5, ts
      FROM snapshots WHERE game_id = ${game.id} AND floor_score IS NOT NULL
      ORDER BY ts ASC
    `;
    if (snaps.length >= 3 && ctx.rollingWindow) {
      const byPeriod = {};
      for (const s of snaps) { if (s.period >= 1) byPeriod[s.period] = s; }
      const periodKeys = Object.keys(byPeriod).map(Number).sort((a, b) => a - b);
      const gapEntries = [];
      for (const pk of periodKeys) {
        const sn = byPeriod[pk];
        if (sn.floor_score != null) {
          const periodRaw = (sn.i1 ?? 0.5) * W.I1 + (sn.i2 ?? 0.5) * W.I2 + (sn.i3 ?? 0.5) * W.I3 + (sn.i4 ?? 0.5) * W.I4 + (sn.i5 ?? 0.5) * W.I5;
          const periodScore = periodRaw >= 0.5 ? periodRaw : 1 - periodRaw;
          gapEntries.push({ gap: periodScore - sn.floor_score, score: sn.floor_score, period: pk });
        }
      }
      if (gapEntries.length >= 2) {
        ctx.acceleration = computeAccelerationServer(gapEntries);
      }
    }

    // Combined read
    if (ctx.rollingWindow) {
      ctx.combinedRead = classifyCombinedReadServer(ind.score, ind.controlTeam, ctx.rollingWindow, ctx.acceleration);
    }
  } catch (e) {
    log(`${matchup}: server context — quarter_data/window failed: ${e.message}`);
  }

  // ── 5. PBP AUDIT + SUB-METRIC ARROWS (from BDL — already parsed in main loop) ──
  try {
    const pbpResult = game._bdlPbp || null;
    if (pbpResult) {
      ctx.pbpAudit = {
        home: pbpResult.home, away: pbpResult.away,
        homeAlias: hA, awayAlias: aA,
        runs: pbpResult.runs,
        pbpPeriod: pbpResult.pbpPeriod, pbpAge: 0,
      };

      // Save PBP to DB
      try {
        const pbpSave = {
          home: pbpResult.home, away: pbpResult.away,
          homeAlias: hA, awayAlias: aA,
          totalShots: pbpResult.totalShots, totalTOs: pbpResult.totalTOs,
          runs: pbpResult.runs,
        };
        await sql`
          INSERT INTO game_pbp (game_id, league, home_alias, away_alias, total_shots, total_tos, pbp_json, saved_at)
          VALUES (${game.id}, ${league}, ${hA}, ${aA}, ${pbpResult.totalShots || 0}, ${pbpResult.totalTOs || 0}, ${JSON.stringify(pbpSave)}, NOW())
          ON CONFLICT (game_id) DO UPDATE SET
            pbp_json = ${JSON.stringify(pbpSave)}, total_shots = ${pbpResult.totalShots || 0},
            total_tos = ${pbpResult.totalTOs || 0}, saved_at = NOW()
        `;
      } catch (e) { /* non-fatal */ }

      // Sub-metric arrows from PBP per-quarter data
      if (pbpResult.perQuarter) {
        ctx.subMetricArrows = computeSubMetricArrowsServer(pbpResult.perQuarter, hA, aA);
        if (ctx.subMetricArrows && ind.controlTeam) {
          ctx.adjustment = classifyAdjustmentServer(ctx.subMetricArrows, ind.controlTeam, hA, aA);
        }
      }
      log(`${matchup}: BDL PBP — ${pbpResult.totalShots || 0} shots, ${pbpResult.totalTOs || 0} TOs, ${Object.keys(pbpResult.perQuarter || {}).length}Q arrows`);
    }
  } catch (e) {
    log(`${matchup}: server PBP processing failed: ${e.message}`);
  }

  // ── 6. THROUGHPUT + LEAD SAFETY (ported from client) ──
  try {
    ctx.throughput = computeThroughputServer(summary, ind, sust, hA, aA, period, clock, league);
    ctx.leadSafety = computeLeadSafetyServer(summary, ind, sust, hA, aA, period, clock, league);

    // Trend arrows — compare against previous poll's expected swing
    try {
      const prevRows = await sql`SELECT prev_tp_exp, prev_ls_exp FROM games WHERE id = ${game.id}`;
      const prev = prevRows.length > 0 ? prevRows[0] : {};

      if (ctx.throughput) {
        const curExp = ctx.throughput.expected.totalSwing;
        const prevExp = prev.prev_tp_exp;
        if (prevExp != null && !isNaN(prevExp)) {
          const delta = Math.round((curExp - prevExp) * 10) / 10;
          ctx.throughput.trend = Math.abs(delta) < 0.5 ? '▬' : delta > 0 ? '▲' : '▼';
          ctx.throughput.trendDelta = delta;
        }
        await sql`UPDATE games SET prev_tp_exp = ${curExp} WHERE id = ${game.id}`;
      }

      if (ctx.leadSafety) {
        const curExp = ctx.leadSafety.expected.totalSwing;
        const prevExp = prev.prev_ls_exp;
        if (prevExp != null && !isNaN(prevExp)) {
          const delta = Math.round((curExp - prevExp) * 10) / 10;
          // For lead safety, LOWER opponent recovery = safer lead = ▲ (improving)
          ctx.leadSafety.trend = Math.abs(delta) < 0.5 ? '▬' : delta < 0 ? '▲' : '▼';
          ctx.leadSafety.trendDelta = delta;
        }
        await sql`UPDATE games SET prev_ls_exp = ${curExp} WHERE id = ${game.id}`;
      }
    } catch (e) {
      // prev columns may not exist yet — non-fatal
      log(`${matchup}: trend columns read/write failed (run init?): ${e.message}`);
    }
  } catch (e) {
    log(`${matchup}: server throughput/leadSafety failed: ${e.message}`);
  }

  // ── 7. MIP (Market Implied Probability) ──
  if (odds && (odds.homeML || odds.awayML)) {
    const hML = parseFloat(odds.homeML), aML = parseFloat(odds.awayML);
    const garbageLine = (Math.abs(hML) >= 50000 || Math.abs(aML) >= 50000 || hML === aML);
    if (!garbageLine) {
      const homeMIP = mlToProb(odds.homeML);
      const awayMIP = mlToProb(odds.awayML);
      if (homeMIP != null && awayMIP != null) {
        const vigSum = homeMIP + awayMIP;
        ctx.mip = {
          homeNorm: (homeMIP / vigSum * 100).toFixed(1),
          awayNorm: (awayMIP / vigSum * 100).toFixed(1),
          homeAlias: hA, awayAlias: aA,
        };
      }
    } else {
      ctx.mip = { garbage: true };
    }
  }

  // ── 8. BONUS STATUS ──
  if (summary.home?.bonus || summary.away?.bonus) {
    ctx.bonusStatus = {
      home: summary.home?.bonus || false,
      away: summary.away?.bonus || false,
      homeDouble: summary.home?.double_bonus || false,
      awayDouble: summary.away?.double_bonus || false,
    };
  }

  // ── 9. GAME META ──
  const hs = summary.home?.statistics || {};
  const as = summary.away?.statistics || {};
  ctx.gameMeta = {
    leadChanges: summary.lead_changes || 0,
    timesTied: summary.times_tied || 0,
    hFoulouts: hs.foulouts || 0, aFoulouts: as.foulouts || 0,
  };

  // ── 10. TRACKING DATA (catch-and-shoot + pull-up eFG — NBA only, fetched once per game) ──
  if (league === 'nba') {
    if (!game._trackingData && !game._trackingFetched) {
      game._trackingFetched = true;
      try {
        game._trackingData = await fetchTrackingData(hA, aA);
        if (game._trackingData) log(`${matchup}: tracking data fetched`);
      } catch (e) { /* non-fatal */ }
    }
    if (game._trackingData) {
      ctx.trackingData = game._trackingData;
    }
  }

  const layerCount = Object.keys(ctx).length;
  if (layerCount > 0) {
    log(`${matchup}: server context computed — ${layerCount} layers: ${Object.keys(ctx).join(', ')}`);
  }
  return layerCount > 0 ? ctx : null;
}

// ── Q3-END CALIBRATION: PARSE SONNET RESPONSE ──────────────────────────────
// Extracts structured fields from Sonnet's analysis text for DB storage.

function parseAnalysisText(text, homeAlias, awayAlias) {
  const result = {
    controlTeam: null, controlScore: null,
    fwp: null, edge: null, entry: null,
    conviction: null, signal: null,
    sustainability: null, leadSource: null,
    predictionJson: null, indicatorsJson: null,
  };
  if (!text) return result;

  // CONTROL: Team 0.XX — LEVEL
  const controlMatch = text.match(/CONTROL:\s*(\w+)\s+([\d.]+)/);
  if (controlMatch) {
    result.controlTeam = controlMatch[1];
    result.controlScore = parseFloat(controlMatch[2]);
  }

  // FWP: AWAY XX% / HOME YY%
  const fwpMatch = text.match(/FWP:\s*(\w+)\s+([\d.]+)%\s*\/\s*(\w+)\s+([\d.]+)%/);
  if (fwpMatch) {
    result.fwp = `${fwpMatch[1]} ${fwpMatch[2]}% / ${fwpMatch[3]} ${fwpMatch[4]}%`;
    const t1 = fwpMatch[1], v1 = parseFloat(fwpMatch[2]);
    const t3 = fwpMatch[3], v3 = parseFloat(fwpMatch[4]);
    result.predictionJson = {
      homeValue: { fwp: t1 === homeAlias ? v1 : v3 },
      awayValue: { fwp: t1 === awayAlias ? v1 : v3 },
    };
  }

  // EDGE
  const edgeMatch = text.match(/EDGE:\s*([^\n|]+)/);
  if (edgeMatch) result.edge = edgeMatch[1].trim();

  // ENTRY
  const entryMatch = text.match(/ENTRY:\s*(OPTIMAL WINDOW|WINDOW OPEN|WINDOW CLOSING|NO WINDOW|FADE)/);
  if (entryMatch) result.entry = entryMatch[1];

  // CONVICTION
  const convMatch = text.match(/CONVICTION:\s*(DOMINANT|STRONG|EARNED|CONDITIONAL|NO ENTRY)/);
  if (convMatch) result.conviction = convMatch[1];

  // SIGNAL (full line)
  const sigMatch = text.match(/SIGNAL:\s*(.+?)(?:\n|$)/);
  if (sigMatch) result.signal = sigMatch[1].trim();

  // Sustainability
  const sustMatch = text.match(/Sustainability:\s*(.+?)(?:\n|$)/);
  if (sustMatch) result.sustainability = sustMatch[1].trim();

  // Lead Source
  const leadMatch = text.match(/Lead Source:\s*(.+?)(?:\n|$)/);
  if (leadMatch) result.leadSource = leadMatch[1].trim();

  // Per-indicator scores
  const indicators = {};
  const indRe = /I(\d)\s+[^:]+:\s*(\w+)\s+([\d.]+)\s*—\s*(.+?)(?:\n|$)/g;
  let m;
  while ((m = indRe.exec(text)) !== null) {
    indicators['I' + m[1]] = { leader: m[2], score: parseFloat(m[3]), detail: m[4].trim() };
  }
  if (Object.keys(indicators).length > 0) result.indicatorsJson = indicators;

  return result;
}

// ── FORMAT SONNET PROMPT ──────────────────────────────────────────────────────
// Single function that formats ALL data layers into prompt text.
// Matches analyze.js quality — no more "payload ghost" layers.

function formatSonnetPrompt({ hA, aA, period, clock, score, thesis, calibrationNote, sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory, ctx, quarterDataFromDB, summary }) {
  let p = `${aA} @ ${hA} | Q${period} ${clock} | ${score}\n\n`;

  // Thesis + calibration
  if (thesis) p += `THESIS:\n${thesis}\n`;
  if (calibrationNote) p += `${calibrationNote}\n`;
  p += '\n';

  // Game meta
  if (ctx?.gameMeta) {
    const m = ctx.gameMeta;
    p += `GAME META: LC:${m.leadChanges} TT:${m.timesTied} Foulouts:${m.hFoulouts}/${m.aFoulouts}\n`;
  }

  // 3PT Sustainability (rich format with personnel details)
  if (sust) {
    p += `3PT SUSTAINABILITY AUDIT:\n`;
    [{ data: sust.away, alias: aA }, { data: sust.home, alias: hA }].forEach(({ data: t, alias }) => {
      if (!t) return;
      if (t.tier === 'TOO EARLY') { p += `${alias}: ${t.live3PM || '?'}/${t.live3PA || '?'} 3PT — TOO EARLY (< 5 attempts)\n`; return; }
      p += `${alias}: ${t.live3PM || '?'}/${t.live3PA || '?'} (${t.live3Pct || '?'}%) vs season ${t.seasonPrior || '?'}%${t.gotSeasonData ? '' : ' [avg fallback]'}\n`;
      if (t.personnelGrade === 'N/A (at baseline)') {
        p += `  Personnel: N/A — shooting at/below baseline\n`;
      } else if (t.personnelDetails && t.personnelDetails.length > 0) {
        p += `  Personnel: ${t.elitePct || 0}% from ELITE, ${t.nonPct || 0}% from NON-SHOOTERS — ${t.personnelGrade || '?'}\n`;
        t.personnelDetails.forEach(pl => {
          p += `    ${pl.name}: ${pl.live3m}/${pl.live3a} (${pl.livePct}%) vs szn ${pl.sznStr} [${pl.tierLabel}]${pl.hot ? ' HOT' : ''}\n`;
        });
      }
      p += `  Regression: prior ${t.seasonPrior || '?'}% | posterior ${t.posteriorMean || '?'}% | pull ${t.regressionPull || '?'}% — ${t.regressionGrade || '?'} (${t.regressionProb || '?'}%)\n`;
      p += `  Shot type: ${t.shotTypeNote || '?'} — ${t.shotTypeGrade || '?'}\n`;
      p += `  -> TIER: ${t.tier} (composite ${t.composite || '?'})\n`;
    });
  }

  // Lead composition
  if (leadComp) {
    const h = leadComp.home || {}, a = leadComp.away || {};
    if (h.total && a.total) {
      p += `\nLEAD COMPOSITION: ${aA} ${a.total} — ${hA} ${h.total} (${leadComp.leadTeam || '?'} ${leadComp.margin >= 0 ? '+' : ''}${leadComp.margin || 0})\n`;
      p += `${aA}: Paint ${a.paint || 0} (${a.total > 0 ? Math.round((a.paint||0)/a.total*100) : 0}%) | FT ${a.ft || 0} | 3PT ${a.three || 0} (${a.total > 0 ? Math.round((a.three||0)/a.total*100) : 0}%) | Mid ${a.midOther || 0} | Trans ${a.transition || 0}\n`;
      p += `${hA}: Paint ${h.paint || 0} (${h.total > 0 ? Math.round((h.paint||0)/h.total*100) : 0}%) | FT ${h.ft || 0} | 3PT ${h.three || 0} (${h.total > 0 ? Math.round((h.three||0)/h.total*100) : 0}%) | Mid ${h.midOther || 0} | Trans ${h.transition || 0}\n`;
      p += `Structural (Paint+FT): ${aA} ${a.structural || 0} (${a.structuralPct || 0}%) vs ${hA} ${h.structural || 0} (${h.structuralPct || 0}%)\n`;
      p += `Variance (3PT+Mid): ${aA} ${a.variance || 0} (${a.variancePct || 0}%) vs ${hA} ${h.variance || 0} (${h.variancePct || 0}%)\n`;
      if (leadComp.durability) p += `MARGIN DURABILITY: ${leadComp.durability}\n`;
    } else {
      p += `\nLEAD COMPOSITION: ${leadComp.classification || '?'} — S:${leadComp.structuralPct || '?'}% V:${leadComp.variancePct || '?'}%\n`;
      if (leadComp.home) p += `  ${hA}: Paint ${leadComp.home?.paint || 0} FT ${leadComp.home?.ft || 0} 3PT ${leadComp.home?.three || 0}\n`;
      if (leadComp.away) p += `  ${aA}: Paint ${leadComp.away?.paint || 0} FT ${leadComp.away?.ft || 0} 3PT ${leadComp.away?.three || 0}\n`;
    }
  }

  // Dashboard indicators
  if (ind) {
    p += `\nDASHBOARD SCORES: ${ind.controlTeam || '?'} ${ind.score?.toFixed(2) || '?'}\n`;
    ['I1', 'I2', 'I3', 'I4', 'I5'].forEach(k => {
      if (ind[k]) p += `  ${k}: ${ind[k].score?.toFixed(1) || '?'} ${ind[k].leader || ''} — ${ind[k].detail || ''}\n`;
    });
  }

  // Clutch (rich format)
  if (clutchData) {
    const tierLabel = clutchData.tier === 1 ? 'L15 NBA.com Tier 1' : clutchData.tier === 2 ? 'Season BDL Tier 2' : 'Tier 3';
    p += `\nCLUTCH (${tierLabel}):\n`;
    p += `${aA}: NetRtg ${clutchData.away?.netRtg ?? 'N/A'} OffRtg ${clutchData.away?.offRtg ?? 'N/A'} DefRtg ${clutchData.away?.defRtg ?? 'N/A'} ${clutchData.away?.wl || ''}\n`;
    p += `${hA}: NetRtg ${clutchData.home?.netRtg ?? 'N/A'} OffRtg ${clutchData.home?.offRtg ?? 'N/A'} DefRtg ${clutchData.home?.defRtg ?? 'N/A'} ${clutchData.home?.wl || ''}\n`;
    const hNet = clutchData.home?.netRtg, aNet = clutchData.away?.netRtg;
    if (hNet != null && aNet != null) p += `Edge: ${hNet > aNet ? hA : aA} by ${Math.abs(hNet - aNet).toFixed(1)} NetRtg\n`;
  }

  // Odds + MIP
  if (odds && (odds.homeML || odds.homeSpread)) {
    p += `\nMARKET: Spread ${hA} ${odds.homeSpread || 'N/A'} | ML ${aA} ${odds.awayML || 'N/A'} / ${hA} ${odds.homeML || 'N/A'} | O/U ${odds.total || 'N/A'}\n`;
    if (ctx?.mip && !ctx.mip.garbage) {
      p += `PRE-COMPUTED MIP: If ${hA} wins -> Edge = FWP - ${ctx.mip.homeNorm}% | If ${aA} wins -> Edge = FWP - ${ctx.mip.awayNorm}%\nUse the MIP of the team you are PREDICTING TO WIN.\n`;
    } else if (ctx?.mip?.garbage) {
      p += `MIP: N/A — line dead (extreme/identical MLs)\n`;
    }
  }

  // Bonus status (with I2 multiplier)
  if (ctx?.bonusStatus) {
    const bs = ctx.bonusStatus;
    const homeInBonus = bs.home, awayInBonus = bs.away;
    if (homeInBonus || awayInBonus) {
      const bothInBonus = homeInBonus && awayInBonus;
      p += `\nBONUS STATUS: `;
      if (bothInBonus) {
        p += `BOTH teams in bonus — advantage NEUTRALIZED\n`;
      } else {
        const bonusTeam = homeInBonus ? hA : aA;
        const penalizedTeam = homeInBonus ? aA : hA;
        const clockParts = (clock || '').split(':');
        const clockMins = clockParts.length === 2 ? (parseInt(clockParts[0]) || 0) + (parseInt(clockParts[1] || 0) / 60) : 12;
        p += `${bonusTeam} IN BONUS (BENEFITS ${bonusTeam}, PENALIZES ${penalizedTeam})`;
        if (clockMins >= 4.0) {
          p += ` with ${clockMins.toFixed(1)} min remaining — STRUCTURAL I2 MULTIPLIER.\n`;
          p += `  ${bonusTeam} GAINS: Every drive/paint touch = automatic free throws. Compounds every possession.\n`;
          p += `  ${penalizedTeam} LOSES: Cannot play physical defense. Players risk fouling out. Interior defense compromised.\n`;
        } else {
          p += ` with ${clockMins.toFixed(1)} min remaining\n`;
        }
      }
    }
  }

  // Tracking baselines (from client context if available)
  if (ctx?.trackingData) {
    const ht = ctx.trackingData.home || {}, at = ctx.trackingData.away || {};
    p += `\nSHOOTING BASELINES:\n`;
    if (ht.catchAndShoot || at.catchAndShoot) p += `C&S: ${aA} ${at.catchAndShoot?.efg || '?'}% | ${hA} ${ht.catchAndShoot?.efg || '?'}%\n`;
    if (ht.pullUp || at.pullUp) p += `Pull-up: ${aA} ${at.pullUp?.efg || '?'}% | ${hA} ${ht.pullUp?.efg || '?'}%\n`;
  }

  // ESPN WP (with divergence check)
  if (espnWP && (espnWP.home != null || espnWP.away != null)) {
    p += `\nESPN WIN PROBABILITY (live model):\n`;
    p += `${hA} ${espnWP.home ?? '?'}% / ${aA} ${espnWP.away ?? '?'}%\n`;
    p += `NOTE: ESPN WP is a reference model, not ground truth.\n`;
    p += `DIVERGENCE CHECK: If your FWP diverges >15% from ESPN WP, explain WHY.\n`;
  }

  // Rolling window (full I1-I5 breakdown)
  if (ctx?.rollingWindow?.available) {
    const rw = ctx.rollingWindow;
    const wLabel = rw.windowQuarters ? rw.windowQuarters.join('+') : '?';
    p += `\nROLLING WINDOW (${wLabel}, ${rw.windowPossessions || '?'} poss):\n`;
    p += `Control: ${rw.controlTeam} ${rw.score != null ? rw.score.toFixed(2) : '?'}\n`;
    ['I1', 'I2', 'I3', 'I4', 'I5'].forEach(k => {
      const i = rw[k];
      if (i && i.score != null) p += `  ${k}: ${i.score.toFixed(1)} — ${i.detail || ''}\n`;
    });
    p += `Data quality: ${rw.dataQuality || '?'}\n`;
  }

  // Per-quarter breakdown
  const qdSource = quarterDataFromDB || ctx?.quarterDiffs;
  if (qdSource && Object.keys(qdSource).length > 0) {
    p += `\nPER-QUARTER BREAKDOWN:\n`;
    const qdKeys = Object.keys(qdSource).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    for (const qk of qdKeys) {
      const d = qdSource[qk];
      if (!d || !d.home || !d.away) continue;
      const h = d.home, a = d.away;
      const hPaint = h.points_in_the_paint || h.points_in_paint || 0;
      const aPaint = a.points_in_the_paint || a.points_in_paint || 0;
      p += `  Q${qk}: Paint ${hPaint}-${aPaint}`
        + `, FTA ${h.free_throws_att||0}-${a.free_throws_att||0}`
        + `, 3P ${h.three_points_made||0}/${h.three_points_att||0}-${a.three_points_made||0}/${a.three_points_att||0}`
        + `, AST ${h.assists||0}-${a.assists||0}`
        + `, TO ${h.turnovers||h.total_turnovers||0}-${a.turnovers||a.total_turnovers||0}`
        + `, STL ${h.steals||0}-${a.steals||0}`
        + (h.possessions ? `, Poss ${h.possessions||0}-${a.possessions||0}` : '')
        + ` (${hA}-${aA})\n`;
    }
  }

  // Gap acceleration (with values and history)
  if (ctx?.acceleration) {
    const acc = ctx.acceleration;
    if (acc.entries && acc.entries.length > 0) {
      const last = acc.entries[acc.entries.length - 1];
      p += `\nGAP ACCELERATION:\n`;
      p += `Gap: ${last.gap >= 0 ? '+' : ''}${last.gap != null ? last.gap.toFixed(3) : '?'} | Acceleration: ${acc.accel} (${acc.consecutive} consecutive)\n`;
      p += `History: ${acc.entries.slice(-5).map(e => `${e.gap >= 0 ? '+' : ''}${e.gap != null ? e.gap.toFixed(2) : '?'} (${e.score})`).join(' -> ')}\n`;
    } else {
      p += `\nGAP: ${acc.accel || 'TOO EARLY'}\n`;
    }
  }

  // Combined read (with supporting data)
  if (ctx?.combinedRead?.read) {
    p += `\nCOMBINED READ: ${ctx.combinedRead.read} — ${ctx.combinedRead.note || ''}\n`;
  }

  // Sub-metric arrows (directional trends)
  if (ctx?.subMetricArrows && (ctx.subMetricArrows.home || ctx.subMetricArrows.away)) {
    p += `\nDIRECTIONAL ARROWS:\n`;
    const arrowOrder = [
      { header: 'I2 RIM PRESSURE', keys: ['paint', 'atRim', 'fta'] },
      { header: 'I1 POSSESSION', keys: ['steals', 'tos'] },
      { header: 'I3 SHOT QUALITY', keys: ['fg3aShare', 'astRatio'] },
      { header: 'I5 TEMPO', keys: ['poss'] },
    ];
    p += `${''.padEnd(12)}${hA.padEnd(18)}${aA}\n`;
    arrowOrder.forEach(grp => {
      p += `${grp.header}:\n`;
      grp.keys.forEach(key => {
        const hm = ctx.subMetricArrows.home ? ctx.subMetricArrows.home[key] : null;
        const am = ctx.subMetricArrows.away ? ctx.subMetricArrows.away[key] : null;
        const label = (hm ? hm.label : (am ? am.label : key)).toString();
        const hStr = (hm && hm.arrow ? (hm.display || '?') : '-').toString();
        const aStr = (am && am.arrow ? (am.display || '?') : '-').toString();
        p += `  ${label.padEnd(10)}${hStr.padEnd(18)}${aStr}\n`;
      });
    });
  }

  // Adjustment signal
  if (ctx?.adjustment && ctx.adjustment.signal && ctx.adjustment.signal !== 'NO ADJUSTMENT' && ctx.adjustment.signal !== 'NO DATA') {
    p += `ADJUSTMENT: ${ctx.adjustment.signal} (${ctx.adjustment.team || '?'}) — ${ctx.adjustment.note || ''}\n`;
  }

  // PBP depth audit (full shot maps, TO breakdown, runs)
  if (ctx?.pbpAudit && (ctx.pbpAudit.home || ctx.pbpAudit.away)) {
    const pAge = ctx.pbpAudit.pbpAge != null ? ctx.pbpAudit.pbpAge + ' min ago' : '';
    const pPer = ctx.pbpAudit.pbpPeriod ? 'Q' + ctx.pbpAudit.pbpPeriod : '?';
    p += `\nDEPTH AUDIT (PBP through ${pPer} ${pAge}):\n`;
    const teams = [
      { data: ctx.pbpAudit.away, alias: ctx.pbpAudit.awayAlias || aA },
      { data: ctx.pbpAudit.home, alias: ctx.pbpAudit.homeAlias || hA },
    ];
    teams.forEach(t => {
      const tm = t.data;
      if (!tm) return;
      p += `\n${t.alias} SHOT MAP:\n`;
      if (tm.threes && tm.threes.byPlayer && tm.threes.byPlayer.length > 0) {
        p += `  3PT (${tm.threes.made}/${tm.threes.att}, ${tm.threes.pct}%, ${tm.threes.assisted}/${tm.threes.made} ast): `;
        tm.threes.byPlayer.forEach(pl => {
          const ctxStr = Object.entries(pl.contexts || {}).map(e => e[0] + ':' + e[1]).join(',');
          p += `${pl.name} ${pl.made}/${pl.att} (${pl.assisted} ast, ${ctxStr}) | `;
        });
        p += '\n';
        if (tm.threes.corner && tm.threes.above) p += `  Corner: ${tm.threes.corner.made}/${tm.threes.corner.att} | Above: ${tm.threes.above.made}/${tm.threes.above.att}\n`;
      }
      if (tm.rim && tm.rim.byPlayer && tm.rim.byPlayer.length > 0) {
        p += `  AT-RIM (${tm.rim.made}/${tm.rim.att}, ${tm.rim.pct}%): `;
        tm.rim.byPlayer.forEach(pl => {
          const ctxStr = Object.entries(pl.contexts || {}).map(e => e[0] + ':' + e[1]).join(',');
          p += `${pl.name} ${pl.made}/${pl.att} (${ctxStr}) | `;
        });
        p += '\n';
      }
      if (tm.mid && tm.mid.byPlayer && tm.mid.byPlayer.length > 0) {
        p += `  MID-RANGE (${tm.mid.made}/${tm.mid.att}, ${tm.mid.pct}%, ${tm.mid.assisted}/${tm.mid.made} ast): `;
        tm.mid.byPlayer.forEach(pl => { p += `${pl.name} ${pl.made}/${pl.att} (${pl.assisted} ast) | `; });
        p += '\n';
      }
      if (tm.shotDiet) p += `  ZONES: rim ${tm.shotDiet.rimPct}% | mid ${tm.shotDiet.midPct}% | 3pt ${tm.shotDiet.threePct}% of FGA\n`;
      if (tm.tos && tm.tos.total > 0) {
        p += `  TOs: ${tm.tos.forced || 0} forced / ${tm.tos.unforced || 0} unforced${tm.tos.unknown > 0 ? ' / ' + tm.tos.unknown + ' unclear' : ''}\n`;
      }
    });
    if (ctx.pbpAudit.runs && ctx.pbpAudit.runs.length > 0) {
      p += `\nSCORING RUNS:\n`;
      ctx.pbpAudit.runs.forEach(r => {
        const mechStr = Array.isArray(r.mechanism) ? r.mechanism.join('+') : (r.mechanism || '?');
        p += `  ${r.team} ${r.pts}-${r.count} run (Q${r.q}): ${mechStr}\n`;
      });
    }
  }

  // Edge history
  if (ctx?.edgeHistory && ctx.edgeHistory.length > 0) {
    p += `\nEDGE HISTORY:\n${ctx.edgeHistory.map(e => `${e.time || '?'} | ${e.edge || '?'} FWP ${e.fwp || '?'} | ${e.control || '?'} ${e.score || ''}`).join('\n')}\n`;
  }

  // Throughput recovery model
  if (ctx?.throughput) {
    const tp = ctx.throughput;
    p += `\nTHROUGHPUT RECOVERY MODEL (server-computed, 4-direction variance regression):\n`;
    p += `Classification: ${tp.classification}\n`;
    p += `The trailing structural team (${tp.fTeam}) projects to recover:\n`;
    p += `  Conservative (25th pctile): ${fmtSwing(tp.conservative.totalSwing)} pts\n`;
    p += `  Expected (50th pctile): ${fmtSwing(tp.expected.totalSwing)} pts\n`;
    p += `  Optimistic (75th pctile): ${fmtSwing(tp.optimistic.totalSwing)} pts\n`;
    p += `Current deficit: ${tp.deficit} pts | Remaining possessions: ~${tp.remainingPoss}\n`;
    p += `Structural edge per possession: ${tp.structEdge} (${tp.fTeam} structural rate: ${tp.ctrlStructRate} vs opponent: ${tp.oppStructRate})\n`;
    if (tp.degradation < 1.0) p += `Deficit degradation applied: ${(tp.degradation * 100).toFixed(0)}%\n`;
    if (tp.trend) p += `TREND: ${tp.trend} ${tp.trendDelta >= 0 ? '+' : ''}${tp.trendDelta} (${tp.trend === '▲' ? 'recovery improving' : tp.trend === '▼' ? 'recovery fading' : 'stable'})\n`;
    p += `HOW TO USE: Compare projected recovery points to deficit. If conservative covers deficit, recovery is PROBABLE. If only optimistic covers it, CONTESTED. If none cover it, NO PATH.\n`;
  }

  // Lead safety model
  if (ctx?.leadSafety) {
    const ls = ctx.leadSafety;
    p += `\nLEAD SAFETY MODEL (server-computed, opponent recovery potential):\n`;
    p += `Classification: ${ls.classification}\n`;
    p += `The leading structural team (${ls.fTeam}) leads by ${ls.lead}. The opponent (${ls.oppTeam}) recovery projects:\n`;
    p += `  Conservative: ${fmtSwing(ls.conservative.totalSwing)} pts recovery\n`;
    p += `  Expected: ${fmtSwing(ls.expected.totalSwing)} pts recovery\n`;
    p += `  Optimistic: ${fmtSwing(ls.optimistic.totalSwing)} pts recovery\n`;
    p += `Remaining possessions: ~${ls.remainingPoss}\n`;
    if (ls.trend) p += `TREND: ${ls.trend} ${ls.trendDelta >= 0 ? '+' : ''}${ls.trendDelta} (${ls.trend === '▲' ? 'lead strengthening' : ls.trend === '▼' ? 'lead eroding' : 'stable'})\n`;
    p += `SAFE = optimistic < 50% of lead. AT RISK = expected meaningfully erodes lead. CRITICAL = conservative threatens lead.\n`;
  }

  // WP profiles
  if (wpProfiles) p += `\n${wpProfiles}\n`;

  // Analysis history (rich format)
  if (analysisHistory && analysisHistory.length > 0) {
    p += `\nGAME NARRATIVE (prior reads this game):\n`;
    analysisHistory.forEach((h, i) => {
      p += `${i + 1}. Q${h.period || '?'} ${h.clock || ''} | ${h.controlTeam || '?'} ${h.controlScore != null ? h.controlScore.toFixed(2) : '?'} | ${h.entry || '-'}/${h.conviction || '-'} | ${h.signal || '-'}\n`;
    });
  }

  // Full game data
  p += `\nGAME DATA:\n${JSON.stringify(summary)}`;

  return p;
}

// ── Q3-END CALIBRATION: FIRE SONNET ANALYSIS ───────────────────────────────
// Called once per game at the Q3→Q4 transition. Gathers all available context
// from DB (thesis, clutch, WP profiles, calibration stats) and calls the
// analyze function with the full SR summary + server-computed layers.
// Result is saved as a tagged 'auto_q3' analysis row — gold standard metric.

async function fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, period, clock, trigger) {
  const triggerTag = trigger || 'auto_q3';

  try {
    // ── 1. Fetch thesis from DB ──
    let thesis = null;
    try {
      const rows = await sql`SELECT text FROM theses WHERE game_id = ${game.id}`;
      if (rows.length > 0) thesis = rows[0].text;
    } catch (e) { /* no thesis — proceed without */ }

    // ── 2. Fetch clutch data from DB ──
    let clutchData = null;
    try {
      const rows = await sql`
        SELECT DISTINCT ON (team_alias) team_alias, tier, net_rtg, off_rtg, def_rtg, wl, efg, pace, pie
        FROM clutch WHERE team_alias = ANY(${[hA, aA]}) AND league = ${league}
        ORDER BY team_alias, created_at DESC
      `;
      if (rows.length > 0) {
        clutchData = { tier: 3 };
        for (const r of rows) {
          const side = r.team_alias === hA ? 'home' : 'away';
          clutchData[side] = { netRtg: r.net_rtg, offRtg: r.off_rtg, defRtg: r.def_rtg, wl: r.wl, efg: r.efg, pace: r.pace, pie: r.pie };
          if (r.tier && r.tier < clutchData.tier) clutchData.tier = r.tier;
        }
      }
    } catch (e) { /* no clutch data */ }

    // ── 3. Fetch WP identity profiles from DB ──
    let wpProfiles = null;
    try {
      const rows = await sql`
        SELECT team_alias, profile_json FROM wp_profiles
        WHERE team_alias = ANY(${[hA, aA]}) AND league = ${league}
      `;
      if (rows.length > 0) {
        let wpText = 'WP IDENTITY PROFILES:\n';
        for (const r of rows) {
          const p = typeof r.profile_json === 'string' ? JSON.parse(r.profile_json) : r.profile_json;
          if (p) wpText += `${r.team_alias}: ${p.identity || '?'} — comeback ${p.comebackRate || '?'}%, collapse ${p.collapseRate || '?'}%, avg swing ${p.avgSwing || '?'}\n`;
        }
        wpProfiles = wpText;
      }
    } catch (e) { /* no WP profiles */ }

    // ── 4. Fetch prior analyses for this game (narrative history) ──
    let analysisHistory = null;
    try {
      const rows = await sql`
        SELECT period, clock, control_team, control_score, fwp, entry, conviction, signal, sustainability
        FROM analyses WHERE game_id = ${game.id}
        ORDER BY ts ASC LIMIT 5
      `;
      if (rows.length > 0) {
        analysisHistory = rows.map(r => ({
          period: r.period, clock: r.clock,
          controlTeam: r.control_team, controlScore: r.control_score,
          entry: r.entry, conviction: r.conviction,
          signal: r.signal, verdict: '',
          leadSust: '', trailSust: '',
        }));
      }
    } catch (e) { /* no history */ }

    // ── 5. Fetch calibration context for prompt ──
    let calibrationNote = null;
    try {
      const gs = await sql`
        SELECT COUNT(*) as total,
          COUNT(CASE WHEN fwp_correct = true THEN 1 END) as fwp_ok,
          COUNT(CASE WHEN fwp_team IS NOT NULL THEN 1 END) as fwp_total,
          COUNT(CASE WHEN thesis_correct = true THEN 1 END) as thesis_ok,
          COUNT(CASE WHEN thesis_team IS NOT NULL THEN 1 END) as thesis_total
        FROM games WHERE league = ${league} AND winner IS NOT NULL
      `;
      const s = gs[0];
      if (s && s.total >= 3) {
        calibrationNote = `CALIBRATION (${s.total} games): FWP ${s.fwp_ok}/${s.fwp_total} (${s.fwp_total > 0 ? (s.fwp_ok/s.fwp_total*100).toFixed(0) : '?'}%), thesis ${s.thesis_ok}/${s.thesis_total}`;
      }
    } catch (e) { /* no calibration */ }

    // ── 6. Build analyze payload ──
    const scoreLine = `${aA} ${ind.awayPts} — ${hA} ${ind.homePts}`;
    const periodStr = `Q${period} ${clock}`;

    // ── 6. Compute server context (server is self-sufficient — no client dependency) ──
    let clientCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, period, clock, matchup, sust, odds);
    const ctxSource = clientCtx ? 'server' : 'none';

    // ── 7. Call Anthropic API directly (bypasses site password protection) ──
    const ctxStatus = ctxSource === 'client' ? 'client' : ctxSource === 'server' ? 'server-rich' : 'no-context';
    const ctxLayers = clientCtx ? Object.keys(clientCtx).filter(k => clientCtx[k] != null).length : 0;
    log(`${matchup}: ${triggerTag} CAL — firing Sonnet (${ctxStatus} ${ctxLayers}L thesis:${thesis ? 'y' : 'n'} clutch:${clutchData ? 'y' : 'n'} odds:${odds ? 'y' : 'n'} tp:${clientCtx?.throughput ? 'y' : 'n'} ls:${clientCtx?.leadSafety ? 'y' : 'n'} pbp:${clientCtx?.pbpAudit ? 'y' : 'n'} arrows:${clientCtx?.subMetricArrows ? 'y' : 'n'})`);

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) { log(`${matchup}: ${triggerTag} CAL — ANTHROPIC_API_KEY not configured`); return; }

    // Build user prompt from payload sections via formatSonnetPrompt
    // Fetch quarter_data from DB for per-quarter breakdown
    let quarterDataFromDB = null;
    try {
      const qdRows = await sql`SELECT quarter_data FROM games WHERE id = ${game.id}`;
      if (qdRows.length > 0 && qdRows[0].quarter_data) {
        const qd = typeof qdRows[0].quarter_data === 'string' ? JSON.parse(qdRows[0].quarter_data) : qdRows[0].quarter_data;
        if (qd.diffs) quarterDataFromDB = qd.diffs;
      }
    } catch (e) { /* quarter_data not available */ }

    const userPrompt = formatSonnetPrompt({
      hA, aA, period, clock, score: scoreLine,
      thesis: thesis ? thesis + (calibrationNote ? '\n\n' + calibrationNote : '') : calibrationNote || null,
      calibrationNote: null, // already merged into thesis above
      sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory,
      ctx: clientCtx || {},
      quarterDataFromDB,
      summary,
    });

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: SONNET_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      log(`${matchup}: ${triggerTag} CAL — Anthropic ${anthropicResp.status}: ${errText.substring(0, 200)}`);
      return;
    }

    const anthropicData = await anthropicResp.json();
    const analysisText = anthropicData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!analysisText || analysisText.length < 20) {
      log(`${matchup}: ${triggerTag} CAL — Sonnet returned empty analysis`);
      return;
    }
    const result = { analysis: analysisText, usage: anthropicData.usage };

    // ── 8. Parse structured fields from Sonnet response ──
    const parsed = parseAnalysisText(result.analysis, hA, aA);

    // ── 9. Save analysis to DB with trigger tag ──
    try {
      await sql`
        INSERT INTO analyses (game_id, period, clock, control_team, control_score,
          fwp, edge, entry, conviction, signal, sustainability, lead_source, raw_text,
          prediction_json, indicators_json, "trigger", home_pts, away_pts)
        VALUES (${game.id}, ${period}, ${clock}, ${parsed.controlTeam}, ${parsed.controlScore},
          ${parsed.fwp}, ${parsed.edge}, ${parsed.entry}, ${parsed.conviction}, ${parsed.signal},
          ${parsed.sustainability}, ${parsed.leadSource}, ${result.analysis},
          ${parsed.predictionJson ? JSON.stringify(parsed.predictionJson) : null},
          ${parsed.indicatorsJson ? JSON.stringify(parsed.indicatorsJson) : null},
          ${triggerTag}, ${ind.homePts || null}, ${ind.awayPts || null})
      `;
    } catch (e) {
      log(`${matchup}: ${triggerTag} CAL — analysis save failed: ${e.message}`);
    }

    log(`${matchup}: ★ ${triggerTag.toUpperCase()} CALIBRATION COMPLETE — ${parsed.controlTeam || '?'} ${parsed.controlScore || '?'} | ${parsed.signal || '?'} | FWP: ${parsed.fwp || '?'}`);

    // ── 10. Push notification for actionable signals ──
    const entry = (parsed.entry || '').toUpperCase();
    const signal = (parsed.signal || '');
    const isBuy = signal.toUpperCase().includes('BUY');
    const isOptimal = entry === 'OPTIMAL WINDOW';
    const isOpen = entry === 'WINDOW OPEN';
    if (isBuy || isOptimal || isOpen) {
      const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA}`;
      const periodStr = `Q${period} ${clock}`;
      const ntfyTitle = `${isOptimal ? '🟢' : '🟡'} ${signal || entry} — ${matchup}`;
      const ntfyBody = `${scoreLine} ${periodStr}`
        + `\nControl: ${parsed.controlTeam || '?'} ${parsed.controlScore || '?'}`
        + `\nFWP: ${parsed.fwp || '?'}`
        + `\nEntry: ${entry} | ${parsed.conviction || '?'}`
        + (parsed.sustainability ? `\nSust: ${parsed.sustainability}` : '')
        + `\n[${triggerTag}]`;
      const ntfyPriority = isOptimal ? 5 : 4;
      await sendNtfy(ntfyTitle, ntfyBody, ntfyPriority);
    }
  } catch (e) {
    log(`${matchup}: ${triggerTag} CAL ERROR — ${e.message}`);
  }
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function(req) {
  const startTime = Date.now();

  // ── TEST MODE: verify ntfy pipeline end-to-end ──
  const url = new URL(req.url, 'https://localhost');
  if (url.searchParams.get('test_ntfy') === '1') {
    const topic = process.env.NTFY_TOPIC;
    const result = { test: true, ntfy_topic: topic ? 'SET' : 'MISSING', topic_value: topic || null };
    if (topic) {
      try {
        await sendNtfy('DFT Server Alert Test', 'If you see this, server alerts are working!\nTimestamp: ' + new Date().toISOString(), 3);
        result.status = 'sent';
      } catch (e) {
        result.error = e.message;
      }
    }
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get DB connection
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log('ERROR: DATABASE_URL not configured');
    return new Response('DATABASE_URL not configured', { status: 500 });
  }
  const sql = neon(dbUrl);

  const results = { games: 0, snapshots: 0, espn: 0, odds: 0, errors: [], skipped: null };
  const pendingAnalyses = []; // collect async Sonnet calls so we await them before returning

  for (const league of Object.keys(LEAGUES)) {
    const cfg = LEAGUES[league];
    const apiKey = process.env[cfg.srKeyEnv];
    if (!apiKey) {
      continue;
    }

    const d = today();
    const pad = n => String(n).padStart(2, '0');
    const dateKey = `${d.year}-${pad(d.month)}-${pad(d.day)}`;

    try {
      // ── 0. Load poll_state from DB — do we even need to be awake? ──
      let pollState = null;
      try {
        const psRows = await sql`
          SELECT first_tip, last_tip, game_count, all_final, schedule_json
          FROM poll_state WHERE league = ${league} AND date = ${dateKey}
        `;
        if (psRows.length > 0) pollState = psRows[0];
      } catch (e) {
        // Table may not exist yet — proceed to fetch schedule
      }

      // ── 0a. Quick exits from cached state ──
      if (pollState) {
        if (pollState.all_final) {
          log(`${league.toUpperCase()}: all games FINAL — sleeping`);
          results.skipped = 'all_final';
          continue;
        }
        if (pollState.game_count === 0) {
          log(`${league.toUpperCase()}: no games today — sleeping`);
          results.skipped = 'no_games';
          continue;
        }
        const now = new Date();
        const windowStart = new Date(new Date(pollState.first_tip).getTime() - 15 * 60 * 1000);
        const windowEnd = new Date(new Date(pollState.last_tip).getTime() + 3 * 60 * 60 * 1000);
        if (now < windowStart) {
          log(`${league.toUpperCase()}: before game window (first tip ${new Date(pollState.first_tip).toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET) — sleeping`);
          results.skipped = 'before_window';
          continue;
        }
        if (now > windowEnd) {
          log(`${league.toUpperCase()}: past game window — marking all_final`);
          try { await sql`UPDATE poll_state SET all_final = TRUE WHERE league = ${league} AND date = ${dateKey}`; } catch(e) {}
          results.skipped = 'past_window';
          continue;
        }
      }

      // ── 0b. Client heartbeat — logged but no longer skips server polling ──
      // BDL has 600 req/min — both client and server can poll simultaneously.
      // Server must always run for quarter-boundary calibration snapshots.

      // ── 1. Get game list — from cache OR one-time SR schedule fetch ──
      let cachedGames = null; // [{id, scheduled, home_alias, away_alias, status}]

      if (pollState && pollState.schedule_json) {
        // Use cached schedule — NO SR call
        cachedGames = typeof pollState.schedule_json === 'string'
          ? JSON.parse(pollState.schedule_json)
          : pollState.schedule_json;
        log(`${league.toUpperCase()}: using cached schedule (${cachedGames.length} games)`);
      } else {
        // First fetch today — single SR schedule call, cache to DB
        log(`${league.toUpperCase()}: fetching schedule (first call today)...`);
        const schedule = await srFetch(league, `games/${d.year}/${pad(d.month)}/${pad(d.day)}/schedule.json`);
        const allGames = schedule.games || [];

        // Build minimal cache: only the fields we need per cycle
        cachedGames = allGames.map(g => ({
          id: g.id,
          scheduled: g.scheduled || null,
          home_alias: g.home?.alias || '',
          away_alias: g.away?.alias || '',
          home_name: g.home?.name || '',
          away_name: g.away?.name || '',
          status: (g.status || 'scheduled').toLowerCase(),
        }));

        // Extract tip times
        const tips = cachedGames
          .filter(g => g.scheduled)
          .map(g => new Date(g.scheduled))
          .sort((a, b) => a - b);
        const firstTip = tips.length > 0 ? tips[0].toISOString() : null;
        const lastTip = tips.length > 0 ? tips[tips.length - 1].toISOString() : null;

        // Save to DB
        try {
          await sql`
            INSERT INTO poll_state (league, date, first_tip, last_tip, game_count, all_final, schedule_json)
            VALUES (${league}, ${dateKey}, ${firstTip}, ${lastTip}, ${cachedGames.length}, ${false}, ${JSON.stringify(cachedGames)})
            ON CONFLICT (league, date) DO UPDATE SET
              first_tip = ${firstTip}, last_tip = ${lastTip},
              game_count = ${cachedGames.length}, schedule_json = ${JSON.stringify(cachedGames)}, fetched_at = NOW()
          `;
        } catch (e) {
          log(`poll_state save failed: ${e.message}`);
        }

        if (cachedGames.length === 0) {
          log(`${league.toUpperCase()}: no games today — stored & sleeping`);
          continue;
        }
        log(`${league.toUpperCase()}: schedule cached — ${cachedGames.length} games, first tip ${firstTip ? new Date(firstTip).toLocaleTimeString('en-US', {timeZone:'America/New_York'}) : '?'} ET`);

        // Check if before window (just fetched, might be too early)
        if (firstTip) {
          const now = new Date();
          const windowStart = new Date(new Date(firstTip).getTime() - 15 * 60 * 1000);
          if (now < windowStart) {
            log(`${league.toUpperCase()}: before game window — sleeping until ${windowStart.toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET`);
            results.skipped = 'before_window';
            continue;
          }
        }
      }

      // ── 2. Determine which games need summary fetches ──
      // A game needs a fetch if: tip time has passed AND not already marked final in cache
      const now = new Date();
      const potentiallyLive = cachedGames.filter(g => {
        if (g.status === 'closed' || g.status === 'complete') return false;
        if (!g.scheduled) return true; // no tip time, assume could be live
        return new Date(g.scheduled) <= now;
      });

      if (potentiallyLive.length === 0) {
        // All games either haven't started or already final
        const allDone = cachedGames.every(g => g.status === 'closed' || g.status === 'complete');
        if (allDone && cachedGames.length > 0) {
          log(`${league.toUpperCase()}: all ${cachedGames.length} games FINAL — marking done`);
          try { await sql`UPDATE poll_state SET all_final = TRUE WHERE league = ${league} AND date = ${dateKey}`; } catch(e) {}
        } else {
          log(`${league.toUpperCase()}: no games tipped yet — waiting`);
        }
        continue;
      }

      log(`${league.toUpperCase()}: ${cachedGames.length} total, ${potentiallyLive.length} potentially live`);
      results.games += potentiallyLive.length;

      // ── 3. Fetch ESPN scoreboard for ID mapping ──
      const dateStr = `${d.year}${pad(d.month)}${pad(d.day)}`;
      const espnGames = await espnScoreboard(league, dateStr);
      log(`ESPN scoreboard: ${espnGames.length} events`);

      // Build ESPN mapping: SR alias → ESPN event ID
      const espnMap = {};
      for (const g of potentiallyLive) {
        const hA = g.home_alias || '';
        const aA = g.away_alias || '';
        const hE = cfg.aliasMap[hA] || hA;
        const aE = cfg.aliasMap[aA] || aA;
        // Try abbreviation match first
        let match = espnGames.find(eg =>
          (eg.homeAbbr === hA || eg.homeAbbr === hE) &&
          (eg.awayAbbr === aA || eg.awayAbbr === aE)
        );
        // Fallback: name-based matching (critical for NCAAMB where abbreviations diverge)
        if (!match && (g.home_name || g.away_name)) {
          const hName = (g.home_name || '').toLowerCase();
          const aName = (g.away_name || '').toLowerCase();
          match = espnGames.find(eg =>
            (hName && eg.homeName && (eg.homeName.includes(hName) || hName.includes(eg.homeName))) &&
            (aName && eg.awayName && (eg.awayName.includes(aName) || aName.includes(eg.awayName)))
          );
        }
        if (match) espnMap[g.id] = match.espnId;
      }
      log(`ESPN mapped: ${Object.keys(espnMap).length}/${potentiallyLive.length}`);

      // ── 3b. Fetch BDL team IDs + season stats (parallel) ──
      const bdlDateStr = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
      const bdlData = await bdlGameData(league, bdlDateStr);
      const bdlTeamIds = bdlData.teamIds;
      const bdlGameIds = bdlData.gameIds;
      log(`BDL: ${Object.keys(bdlTeamIds).length} teams, ${Object.keys(bdlGameIds).length} games mapped`);

      // Collect unique team abbreviations from potentially live games
      const teamAbbrs = new Set();
      for (const g of potentiallyLive) {
        if (g.home_alias) teamAbbrs.add(g.home_alias);
        if (g.away_alias) teamAbbrs.add(g.away_alias);
      }

      // Load season stats — cache-first (DB), fetch stale/missing from BDL
      const bdlSeasonCache = await getSeasonStatsForTeams(sql, league, cfg.season, teamAbbrs, bdlTeamIds);

      // Track which cached games got updated this cycle
      let cacheUpdated = false;
      let liveCount = 0;

      // ── 3c. Batch BDL box_scores + lineups fetch (one call each, covers ALL games) ──
      let bdlBoxScores = [];
      try {
        // Use date endpoint — returns ALL games (in-progress, OT, halftime, final)
        // box_scores/live may omit OT games
        const boxResult = await bdlFetch(`${cfg.bdlPrefix}/v1/box_scores?date=${bdlDateStr}`);
        bdlBoxScores = boxResult?.data || [];
        // NCAAMB: BDL uses UTC dates — also fetch next day to catch late-ET games
        if (league === 'ncaamb') {
          const dt = new Date(bdlDateStr + 'T12:00:00Z');
          dt.setUTCDate(dt.getUTCDate() + 1);
          const nd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
          try {
            const box2 = await bdlFetch(`${cfg.bdlPrefix}/v1/box_scores?date=${nd}`);
            if (box2?.data) bdlBoxScores = bdlBoxScores.concat(box2.data);
          } catch (e) { log(`BDL box_scores next-day ${nd} failed: ${e.message}`); }
        }
        _serverBoxScoreCache = bdlBoxScores;
        _serverBoxScoreTime = Date.now();
        log(`BDL box_scores: ${bdlBoxScores.length} games`);
      } catch (e) {
        log(`BDL box_scores failed: ${e.message}`);
      }

      // Batch lineups for all games we don't have cached
      const lineupsNeeded = potentiallyLive.filter(g => {
        const bdlGid = bdlGameIds[`${g.away_alias}@${g.home_alias}`];
        return bdlGid && !_serverLineupsCache[bdlGid];
      }).map(g => bdlGameIds[`${g.away_alias}@${g.home_alias}`]);
      if (lineupsNeeded.length > 0) {
        try {
          const luResult = await bdlFetch(`${cfg.bdlPrefix}/v1/lineups?${lineupsNeeded.map(id => 'game_ids[]=' + id).join('&')}&per_page=100`);
          if (luResult?.data) {
            // Group by game_id
            luResult.data.forEach(l => {
              const gid = l.game_id;
              if (!_serverLineupsCache[gid]) _serverLineupsCache[gid] = [];
              _serverLineupsCache[gid].push(l);
            });
            log(`BDL lineups: ${luResult.data.length} records cached`);
          }
        } catch (e) { log(`BDL lineups failed: ${e.message}`); }
      }

      // ── 4. Process each potentially live game — BDL box_scores + plays ──
      // Fetch plays for all live games in parallel (BDL: 600 req/min)
      const playsFetches = potentiallyLive.map(g => {
        const bdlGid = bdlGameIds[`${g.away_alias}@${g.home_alias}`];
        if (!bdlGid) return Promise.resolve(null);
        return bdlFetch(`${cfg.bdlPrefix}/v1/plays?game_id=${bdlGid}&per_page=500`).catch(() => null);
      });
      const allPlaysResults = await Promise.all(playsFetches);

      for (let gi = 0; gi < potentiallyLive.length; gi++) {
        const game = potentiallyLive[gi];
        const hA = game.home_alias || 'HOME';
        const aA = game.away_alias || 'AWAY';
        const matchup = `${aA}@${hA}`;
        const bdlGid = bdlGameIds[matchup];

        try {
          if (!bdlGid) {
            log(`${matchup}: no BDL game ID mapped — skipping`);
            continue;
          }

          // Find box score for this game
          const boxScore = bdlBoxScores.find(b => b.id === bdlGid);
          if (!boxScore) {
            log(`${matchup}: no box score — game may not have started`);
            continue;
          }

          // Check game status
          const gameStatus = normalizeBdlStatusServer(boxScore.status, boxScore);
          if (gameStatus === 'closed' || gameStatus === 'complete') {
            game.status = gameStatus;
            cacheUpdated = true;
            log(`${matchup}: FINAL — removed from active polling`);

            // ── QUARTER DATA: capture game-end boundary before finalization ──
            // This captures the final cumulative stats so the last period's diff is computable.
            // NBA: boundary '4' (Q4 end). NCAAMB: boundary '4' (game end / H2 end).
            try {
              const playsResult = allPlaysResults[gi];
              const plays = playsResult?.data || [];
              const pbpResult = parseBDLPBPServer(plays, hA, aA);
              const lineupsArr = _serverLineupsCache[bdlGid] || null;
              const finalSummary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
              const homeStats = finalSummary.home?.statistics || {};
              const awayStats = finalSummary.away?.statistics || {};
              if (Object.keys(homeStats).length > 0) {
                const qd = await readQuarterData(sql, game.id);
                // Determine last boundary key: NBA='4', NCAAMB='4' (game end)
                const endKey = '4';
                // Find the previous boundary key
                const prevKey = league === 'ncaamb' ? '3' : '3';
                if (!qd.boundaries[endKey]) {
                  captureBoundary(qd, endKey, prevKey, homeStats, awayStats);
                  await writeQuarterData(sql, game.id, qd);
                  log(`${matchup}: ★ game-end quarter_data boundary[${endKey}] captured`);
                }
              }
            } catch (e) {
              log(`${matchup}: game-end quarter_data capture failed: ${e.message}`);
            }

            if (espnMap[game.id]) {
              var finalWP = await espnWinProb(league, espnMap[game.id]);
            }

            // ── SERVER-SIDE FINALIZE — ensures calibration view works even when client is asleep ──
            try {
              const homePts = boxScore.home_team_score || 0;
              const awayPts = boxScore.visitor_team_score || 0;
              const winner = homePts > awayPts ? hA : (awayPts > homePts ? aA : 'TIE');
              const margin = Math.abs(homePts - awayPts);

              // Pull FWP from latest auto analysis if available
              let fwpTeam = null, fwpValue = null, conviction = null, entrySignal = null;
              try {
                const aRows = await sql`
                  SELECT prediction_json, conviction, entry FROM analyses
                  WHERE game_id = ${game.id} AND "trigger" LIKE 'auto_q%'
                  ORDER BY ts DESC LIMIT 1
                `;
                if (aRows.length > 0) {
                  const pred = typeof aRows[0].prediction_json === 'string'
                    ? JSON.parse(aRows[0].prediction_json) : aRows[0].prediction_json;
                  if (pred?.homeValue?.fwp != null && pred?.awayValue?.fwp != null) {
                    if (pred.homeValue.fwp >= pred.awayValue.fwp) { fwpTeam = hA; fwpValue = pred.homeValue.fwp; }
                    else { fwpTeam = aA; fwpValue = pred.awayValue.fwp; }
                  }
                  conviction = aRows[0].conviction || null;
                  entrySignal = aRows[0].entry || null;
                }
              } catch (e) { /* no auto analyses */ }

              // Pull thesis team from theses table
              let thesisTeam = null;
              try {
                const tRows = await sql`SELECT text FROM theses WHERE game_id = ${game.id} LIMIT 1`;
                if (tRows.length > 0) {
                  const csMatch = (tRows[0].text || '').match(/CONTROL SCORE:\s*(\w+)/i);
                  if (csMatch) thesisTeam = csMatch[1].toUpperCase();
                }
              } catch (e) { /* no thesis */ }

              // Pull latest odds for spread coverage
              let homeSpread = null;
              try {
                const oRows = await sql`
                  SELECT home_spread FROM odds_history
                  WHERE game_id = ${game.id} AND home_spread IS NOT NULL
                  ORDER BY ts DESC LIMIT 1
                `;
                if (oRows.length > 0) homeSpread = parseFloat(oRows[0].home_spread);
              } catch (e) { /* no odds */ }

              let homeCovered = null, awayCovered = null;
              if (homeSpread != null && !isNaN(homeSpread)) {
                const m = homePts - awayPts;
                homeCovered = (m + homeSpread) > 0;
                awayCovered = (-m + (-homeSpread)) > 0;
              }

              await sql`
                UPDATE games SET
                  home_pts = ${homePts}, away_pts = ${awayPts},
                  winner = ${winner}, margin = ${margin},
                  spread = ${homeSpread},
                  home_covered = ${homeCovered}, away_covered = ${awayCovered},
                  thesis_team = ${thesisTeam},
                  thesis_correct = ${thesisTeam ? thesisTeam === winner : null},
                  fwp_team = ${fwpTeam}, fwp_value = ${fwpValue},
                  fwp_correct = ${fwpTeam ? fwpTeam === winner : null},
                  conviction = ${conviction}, entry_signal = ${entrySignal}
                WHERE id = ${game.id}
              `;
              log(`${matchup}: ★ SERVER FINALIZED — ${winner} by ${margin} (FWP:${fwpTeam || 'N/A'} thesis:${thesisTeam || 'N/A'} spread:${homeSpread || 'N/A'})`);
            } catch (e) {
              log(`${matchup}: server finalize failed: ${e.message}`);
            }

            continue;
          }
          if (gameStatus === 'scheduled' || gameStatus === 'created') {
            log(`${matchup}: not started yet (${gameStatus})`);
            continue;
          }

          liveCount++;

          // Update cached schedule status (so poll_state reflects live games)
          if (game.status !== gameStatus) {
            game.status = gameStatus;
            cacheUpdated = true;
          }

          // Parse PBP
          const playsResult = allPlaysResults[gi];
          const plays = playsResult?.data || [];
          const pbpResult = parseBDLPBPServer(plays, hA, aA);
          const lineupsArr = _serverLineupsCache[bdlGid] || null;

          // Build SR-shaped summary
          const summary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);

          // Stash PBP result for computeServerContext to use (avoids re-fetching)
          game._bdlPbp = pbpResult;

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
          // SR NBA has summary.quarter, NCAAMB has summary.half
          // Periods may be nested under home/away, not top-level
          const currentPeriod = summary.quarter || summary.half
            || (summary.periods || []).length
            || (summary.home?.periods || []).length
            || 0;
          const clock = summary.clock || '';

          // Compute deficit relative to control team
          const ctrlIsHome = ind.controlTeam === hA;
          const ctrlPts = ctrlIsHome ? ind.homePts : ind.awayPts;
          const oppPts = ctrlIsHome ? ind.awayPts : ind.homePts;
          const deficit = Math.max(0, oppPts - ctrlPts);
          const trailingTeam = oppPts > ctrlPts ? ind.controlTeam
                             : ctrlPts > oppPts ? (ctrlIsHome ? aA : hA)
                             : null;

          // Merge BDL season averages onto SR summary players (enriches sustainability audit)
          const homeBdl = bdlSeasonCache[hA] || [];
          const awayBdl = bdlSeasonCache[aA] || [];
          if (homeBdl.length > 0 || awayBdl.length > 0) {
            mergeBdlSeasonData(summary, homeBdl, awayBdl);
          }

          // Compute sustainability + lead composition
          const sust = computeSustainability(summary);
          const leadComp = computeLeadComposition(summary);

          // Lead team sustainability tier
          const leadSide = ind.homePts > ind.awayPts ? 'home'
                         : ind.awayPts > ind.homePts ? 'away'
                         : 'home'; // tie → home default
          const leadSust = sust?.[leadSide]?.tier || null;
          const leadClass = leadComp?.classification || null;

          // Fetch BDL odds (no rate limit, fast)
          let odds = null;
          if (bdlGid) {
            odds = await bdlOdds(league, bdlGid);
          }
          const spreadVal = odds?.homeSpread != null ? parseFloat(odds.homeSpread) : null;

          // ── 4. Save to DB ──
          // Ensure game row exists
          await sql`
            INSERT INTO games (id, date, league, matchup, home_alias, away_alias)
            VALUES (${game.id}, ${`${d.year}-${pad(d.month)}-${pad(d.day)}`}, ${league}, ${matchup}, ${hA}, ${aA})
            ON CONFLICT (id) DO NOTHING
          `;

          // Insert snapshot (source = 'server' to distinguish from client)
          const sustJson = sust ? JSON.stringify(sust) : null;
          await sql`
            INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
              floor_score, floor_team, pbp_score, pbp_team, pbp_window_size,
              qtr_score, qtr_team, espn_wp_home, espn_wp_away,
              spread, deficit, trailing_team, lead_sust, gap, accel,
              i1, i2, i3, i4, i5, source, lead_class, sust_json)
            VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
              ${ind.score}, ${ind.controlTeam}, ${null}, ${null}, ${null},
              ${null}, ${null}, ${espnWP?.home || null}, ${espnWP?.away || null},
              ${spreadVal}, ${deficit}, ${trailingTeam}, ${leadSust}, ${null}, ${null},
              ${ind.I1.score}, ${ind.I2.score}, ${ind.I3.score}, ${ind.I4.score}, ${ind.I5.score},
              ${'server'}, ${leadClass}, ${sustJson})
          `;

          // Save odds to odds_history table if we got data
          if (odds) {
            try {
              await sql`
                INSERT INTO odds_history (game_id, home_spread, home_ml, away_ml, total, source)
                VALUES (${game.id}, ${odds.homeSpread != null ? parseFloat(odds.homeSpread) : null}, ${odds.homeML != null ? parseInt(odds.homeML) : null}, ${odds.awayML != null ? parseInt(odds.awayML) : null}, ${odds.total != null ? parseFloat(odds.total) : null}, ${'server'})
              `;
            } catch (e) { /* odds_history table may not exist — non-fatal */ }
          }

          results.snapshots++;
          if (espnWP) results.espn++;
          if (odds) results.odds++;

          // ── QUARTER DATA: baseline capture (first poll with stats) ──
          // Saves boundaries["0"] so Q1 diffs are computable from game start.
          if (!game._qdBaselineSaved) {
            try {
              const qd = await readQuarterData(sql, game.id);
              if (!qd.boundaries['0']) {
                const homeStats = summary.home?.statistics || {};
                const awayStats = summary.away?.statistics || {};
                // Only save baseline if we actually have stats
                if (Object.keys(homeStats).length > 0 || Object.keys(awayStats).length > 0) {
                  qd.boundaries['0'] = {
                    ts: new Date().toISOString(),
                    home: extractBoundaryStats(homeStats),
                    away: extractBoundaryStats(awayStats),
                  };
                  await writeQuarterData(sql, game.id, qd);
                  log(`${matchup}: ★ quarter_data baseline captured (${Object.keys(homeStats).length} home fields, ${Object.keys(awayStats).length} away fields)`);
                }
              }
              game._qdBaselineSaved = true;
            } catch (e) {
              log(`${matchup}: quarter_data baseline failed: ${e.message}`);
            }
          }

          const bdlEnriched = (homeBdl.length > 0 || awayBdl.length > 0);
          log(`${matchup} Q${currentPeriod} ${clock} | ${ind.homePts}-${ind.awayPts} | ${ind.controlTeam} ${ind.score} | I:${ind.I1.score}/${ind.I2.score}/${ind.I3.score}/${ind.I4.score}/${ind.I5.score} | sust:${leadSust || '?'} class:${leadClass || '?'}${bdlEnriched ? ' BDL✓' : ''}${spreadVal != null ? ` spd:${spreadVal}` : ''}${espnWP ? ` | WP:${espnWP.home}%` : ''}`);

          // ── LIGHTWEIGHT ENTRY SIGNAL CHECK (every cycle, no Sonnet needed) ──
          // Relaxed to match client synthesizer coverage:
          //   BUY:  floor ≥ 0.70, trailing 4-15, Q2+
          //   LEAN: floor ≥ 0.60, trailing 4-15, opp FRAGILE/UNSUSTAINABLE, Q2+
          //   BWC:  floor ≥ 0.70, leading 2+, Q2+
          //   HOLD RISK: floor ≥ 0.65, leading 2+, opp sust LOCKED/DURABLE (opponent engine strong), Q3+
          {
            const ctrlSide = ind.controlTeam === hA ? 'home' : 'away';
            const oppSide = ctrlSide === 'home' ? 'away' : 'home';
            const ctrlSust = sust?.[ctrlSide]?.tier || null;
            const oppSustTier = sust?.[oppSide]?.tier || null;
            const ctrlIsHome = ind.controlTeam === hA;
            const ctrlPtsA = ctrlIsHome ? ind.homePts : ind.awayPts;
            const oppPtsA = ctrlIsHome ? ind.awayPts : ind.homePts;
            const ctrlTrailing = oppPtsA > ctrlPtsA;
            const ctrlLeading = ctrlPtsA > oppPtsA;
            const margin = Math.abs(ctrlPtsA - oppPtsA);
            const oppFragile = oppSustTier === 'FRAGILE' || oppSustTier === 'UNSUSTAINABLE';
            const oppStrong = oppSustTier === 'LOCKED IN' || oppSustTier === 'DURABLE';

            let alertType = null, alertEmoji = '', alertPriority = 4;

            if (ind.score >= 0.70 && ctrlTrailing && margin >= 4 && margin <= 15 && currentPeriod >= 2) {
              alertType = 'BUY';
              alertEmoji = '🟢';
              alertPriority = 5;
            } else if (ind.score >= 0.60 && ctrlTrailing && margin >= 4 && margin <= 15 && oppFragile && currentPeriod >= 2) {
              alertType = 'LEAN BUY';
              alertEmoji = '🟡';
              alertPriority = 4;
            } else if (ind.score >= 0.70 && ctrlLeading && margin >= 2 && currentPeriod >= 2) {
              alertType = 'BWC';
              alertEmoji = '🔵';
              alertPriority = 3;
            }

            if (alertType) {
              const alertKey = `${game.id}_${alertType}_Q${currentPeriod}`;
              if (!game._lastAlert || game._lastAlert !== alertKey) {
                game._lastAlert = alertKey;
                cacheUpdated = true;
                const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA}`;
                const sustLine = (ctrlSust || oppSustTier) ? `\nSust: ${oppSustTier || '?'} vs ${ctrlSust || '?'}` : '';
                const ntfyTitle = `${alertEmoji} ${alertType} — ${matchup}`;
                const ntfyBody = `${scoreLine} Q${currentPeriod} ${clock}`
                  + `\nFloor: ${ind.controlTeam} ${ind.score.toFixed(2)}`
                  + (ctrlTrailing ? `\nDeficit: ${margin}` : `\nLead: ${margin}`)
                  + sustLine
                  + (spreadVal != null ? `\nSpread: ${spreadVal}` : '')
                  + (espnWP ? `\nESPN: ${espnWP.home}%/${espnWP.away}%` : '')
                  + `\nClass: ${leadClass || '?'}`;
                await sendNtfy(ntfyTitle, ntfyBody, alertPriority);
                log(`${matchup}: ${alertEmoji} ${alertType} PUSHED — ${ind.controlTeam} ${ind.score.toFixed(2)} ${ctrlTrailing ? 'trailing' : 'leading'} by ${margin}${oppSustTier ? ', opp ' + oppSustTier : ''}`);
              }
            }
          }
          // ── TRANSITION ALERTS (throughput/lead safety/sustainability) ──────
          // Computed every poll cycle. Fires on classification changes.
          if (currentPeriod >= 2) {
            try {
              const tp = computeThroughputServer(summary, ind, sust, hA, aA, currentPeriod, clock, league);
              const ls = computeLeadSafetyServer(summary, ind, sust, hA, aA, currentPeriod, clock, league);
              const oppSide = ind.controlTeam === hA ? 'away' : 'home';
              const oppSustNow = sust?.[oppSide]?.tier || null;
              const tpClass = tp?.classification || null;
              const lsClass = ls?.classification || null;

              // Read previous values
              const prevRows = await sql`SELECT prev_tp_class, prev_ls_class, prev_opp_sust FROM games WHERE id = ${game.id}`;
              const prev = prevRows.length > 0 ? prevRows[0] : {};
              const prevTpClass = prev.prev_tp_class || null;
              const prevLsClass = prev.prev_ls_class || null;
              const prevOppSust = prev.prev_opp_sust || null;

              const ctrlIsHome = ind.controlTeam === hA;
              const ctrlPtsT = ctrlIsHome ? ind.homePts : ind.awayPts;
              const oppPtsT = ctrlIsHome ? ind.awayPts : ind.homePts;
              const marginT = Math.abs(ctrlPtsT - oppPtsT);
              const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA}`;

              // ALERT 1: RECOVERY PATH OPENED
              if (tpClass && ind.score >= 0.65 && oppPtsT > ctrlPtsT && marginT >= 4 && marginT <= 15) {
                const wasWeak = !prevTpClass || prevTpClass === 'UNLIKELY' || prevTpClass === 'NO PATH';
                const nowStrong = tpClass === 'CONTESTED' || tpClass === 'PROBABLE' || tpClass === 'STRONG RECOVERY';
                if (wasWeak && nowStrong) {
                  const tpAlertKey = `${game.id}_TP_RECOVERY_Q${currentPeriod}`;
                  if (!game._lastTpAlert || game._lastTpAlert !== tpAlertKey) {
                    game._lastTpAlert = tpAlertKey;
                    await sendNtfy(
                      `RECOVERY PATH OPENED — ${matchup}`,
                      `${scoreLine} Q${currentPeriod} ${clock}`
                        + `\nThroughput: ${prevTpClass || 'none'} -> ${tpClass}`
                        + `\n${ind.controlTeam} trails by ${marginT} | Floor: ${ind.score.toFixed(2)}`
                        + `\nEngine: ${fmtSwing(tp.conservative.totalSwing)} / ${fmtSwing(tp.expected.totalSwing)} / ${fmtSwing(tp.optimistic.totalSwing)} vs ${tp.deficit} deficit`
                        + `\n~${tp.remainingPoss} poss remaining`,
                      5
                    );
                    log(`${matchup}: RECOVERY PATH OPENED — ${prevTpClass} -> ${tpClass}, trailing ${marginT}`);
                  }
                }
              }

              // ALERT 2: LEAD CRUMBLING / LEAD LOST
              const wasSafe = prevLsClass === 'SAFE' || prevLsClass === 'CUSHIONED';
              if (wasSafe) {
                const nowDanger = lsClass === 'AT RISK' || lsClass === 'CRITICAL';
                const leadLost = !lsClass && oppPtsT >= ctrlPtsT;
                if (nowDanger || leadLost) {
                  const lsAlertKey = `${game.id}_LS_CRUMBLE_Q${currentPeriod}`;
                  if (!game._lastLsAlert || game._lastLsAlert !== lsAlertKey) {
                    game._lastLsAlert = lsAlertKey;
                    const alertBody = leadLost
                      ? `${scoreLine} Q${currentPeriod} ${clock}`
                        + `\nLEAD LOST — was ${prevLsClass}`
                        + `\n${ind.controlTeam} ${ctrlPtsT > oppPtsT ? 'now leads by ' + marginT : ctrlPtsT === oppPtsT ? 'TIED' : 'now trails by ' + marginT}`
                      : `${scoreLine} Q${currentPeriod} ${clock}`
                        + `\nLead Safety: ${prevLsClass} -> ${lsClass}`
                        + `\n${ind.controlTeam} leads by ${marginT}`
                        + `\nOpp recovery: ${fmtSwing(ls.conservative.totalSwing)} / ${fmtSwing(ls.expected.totalSwing)} / ${fmtSwing(ls.optimistic.totalSwing)}`
                        + `\n~${ls.remainingPoss} poss remaining`;
                    await sendNtfy(
                      `${leadLost ? 'LEAD LOST' : 'LEAD CRUMBLING'} — ${matchup}`,
                      alertBody,
                      5
                    );
                    log(`${matchup}: ${leadLost ? 'LEAD LOST' : 'LEAD CRUMBLING'} — ${prevLsClass} -> ${lsClass || 'null'}`);
                  }
                }
              }

              // ALERT 3: OPPONENT VARIANCE BREAKING
              if (oppPtsT > ctrlPtsT && marginT >= 3 && ind.score >= 0.60) {
                const wasStable = prevOppSust === 'LOCKED IN' || prevOppSust === 'DURABLE';
                const nowBreaking = oppSustNow === 'FRAGILE' || oppSustNow === 'UNSUSTAINABLE';
                if (wasStable && nowBreaking) {
                  const sustAlertKey = `${game.id}_SUST_BREAK_Q${currentPeriod}`;
                  if (!game._lastSustAlert || game._lastSustAlert !== sustAlertKey) {
                    game._lastSustAlert = sustAlertKey;
                    const oppAlias = ctrlIsHome ? aA : hA;
                    await sendNtfy(
                      `VARIANCE BREAKING — ${matchup}`,
                      `${scoreLine} Q${currentPeriod} ${clock}`
                        + `\n${oppAlias} shooting: ${prevOppSust} -> ${oppSustNow}`
                        + `\n${ind.controlTeam} structural edge ${ind.score.toFixed(2)}, trailing by ${marginT}`
                        + `\nVariance-sourced lead expected to erode`,
                      4
                    );
                    log(`${matchup}: VARIANCE BREAKING — ${oppAlias} ${prevOppSust} -> ${oppSustNow}`);
                  }
                }
              }

              // Write current values for next cycle comparison
              await sql`UPDATE games SET
                prev_tp_class = ${tpClass},
                prev_ls_class = ${lsClass},
                prev_opp_sust = ${oppSustNow}
                WHERE id = ${game.id}`;
            } catch (e) {
              log(`${matchup}: transition alert error: ${e.message}`);
            }
          }
          // ── QUARTER-BOUNDARY CALIBRATION SNAPSHOTS ─────────────────
          // Detect Q1→Q2, Q2→Q3, Q3→Q4 transitions. Fire ONCE each per game:
          //   1. Save calibration-tagged snapshot (all data layers fresh from this cycle)
          //   2. Fire async Sonnet analysis with full context from DB
          // Q3→Q4 is the GOLD STANDARD (game still contested).
          // Q1→Q2 and Q2→Q3 track framework accuracy at earlier stages.
          // ── QUARTER-BOUNDARY CALIBRATION SNAPSHOTS ─────────────────
          // NBA: Q1→Q2, Q2→Q3, Q3→Q4 transitions (from period tracking)
          // NCAAMB: Synthetic quarters — sQ1 (H1 >10:00), sQ2 (halftime), sQ3 (H2 >10:00)
          //   detected via clock crossing 10:00 within a half + period transition
          // Saves calibration snapshot + computes server context at each boundary.
          // NBA fires Sonnet auto-analysis. NCAAMB saves snapshot + context only (no Sonnet).
          {
            const prevPeriod = game.last_period || 0;
            if (!game.cal_captured) game.cal_captured = {};

            // Parse clock minutes for NCAAMB mid-half detection
            let clockMin = null;
            if (clock) {
              const cp = clock.split(':');
              clockMin = (parseInt(cp[0]) || 0) + (parseInt(cp[1] || 0) / 60);
            }

            let transitions = [];

            if (league === 'nba') {
              transitions = [
                { from: 1, to: 2, tag: 'calibration_q1', trigger: 'auto_q1', label: 'Q1', sonnet: true, qdKey: '1', qdPrev: '0' },
                { from: 2, to: 3, tag: 'calibration_q2', trigger: 'auto_q2', label: 'Q2', sonnet: true, qdKey: '2', qdPrev: '1' },
                { from: 3, to: 4, tag: 'calibration_q3', trigger: 'auto_q3', label: 'Q3', sonnet: true, qdKey: '3', qdPrev: '2' },
              ];
            } else if (league === 'ncaamb') {
              // Period-based: halftime (period 1→2)
              transitions.push({ from: 1, to: 2, tag: 'calibration_sq2', trigger: 'auto_sq2', label: 'sQ2(half)', sonnet: false, qdKey: '2', qdPrev: '1' });

              // State-based: if we're past the 10:00 mark, the synthetic quarter boundary should exist
              // DB dedup prevents re-firing on every poll
              if (currentPeriod === 1 && clockMin != null && clockMin <= 10.0) {
                transitions.push({ from: 0, to: 1, tag: 'calibration_sq1', trigger: 'auto_sq1', label: 'sQ1(H1@10)', sonnet: false, clockBased: true, qdKey: '1', qdPrev: '0' });
              }
              if (currentPeriod === 2 && clockMin != null && clockMin <= 10.0) {
                transitions.push({ from: 0, to: 1, tag: 'calibration_sq3', trigger: 'auto_sq3', label: 'sQ3(H2@10)', sonnet: false, clockBased: true, qdKey: '3', qdPrev: '2' });
              }
            }

            for (const t of transitions) {
              // DB-based dedup — check if calibration snapshot already exists for this game+tag
              // In-memory cal_captured doesn't persist across serverless invocations
              try {
                const existing = await sql`
                  SELECT 1 FROM snapshots WHERE game_id = ${game.id} AND source = ${t.tag} LIMIT 1
                `;
                if (existing.length > 0) continue; // already captured in a prior invocation
              } catch (e) { /* table may not exist yet, proceed */ }

              // Period-based transitions: standard detection
              const triggered = t.clockBased
                ? true  // clock-based: already validated above
                : (currentPeriod >= t.to);

              if (triggered) {
                game.cal_captured[t.tag] = true;
                cacheUpdated = true;

                log(`${matchup}: ★ ${t.label} TRANSITION — capturing calibration snapshot`);

                // Save calibration-tagged snapshot
                try {
                  await sql`
                    INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
                      floor_score, floor_team, espn_wp_home, espn_wp_away,
                      spread, deficit, trailing_team, lead_sust, lead_class,
                      i1, i2, i3, i4, i5, source, sust_json)
                    VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
                      ${ind.score}, ${ind.controlTeam}, ${espnWP?.home || null}, ${espnWP?.away || null},
                      ${spreadVal}, ${deficit}, ${trailingTeam}, ${leadSust}, ${leadClass},
                      ${ind.I1.score}, ${ind.I2.score}, ${ind.I3.score}, ${ind.I4.score}, ${ind.I5.score},
                      ${t.tag}, ${sustJson})
                  `;
                  log(`${matchup}: ${t.label} CAL snapshot saved — floor ${ind.controlTeam} ${ind.score} | sust:${leadSust || '?'} class:${leadClass || '?'} | WP:${espnWP?.home || '?'}% | spd:${spreadVal != null ? spreadVal : 'N/A'}`);
                } catch (e) {
                  log(`${matchup}: ${t.label} CAL snapshot save failed: ${e.message}`);
                }

                // ── QUARTER DATA: capture boundary stats + compute diffs ──
                if (t.qdKey) {
                  try {
                    const qd = await readQuarterData(sql, game.id);
                    const homeStats = summary.home?.statistics || {};
                    const awayStats = summary.away?.statistics || {};
                    captureBoundary(qd, t.qdKey, t.qdPrev, homeStats, awayStats);
                    await writeQuarterData(sql, game.id, qd);
                    const diffKeys = qd.diffs[t.qdKey] ? Object.keys(qd.diffs[t.qdKey].home || {}).length : 0;
                    log(`${matchup}: ${t.label} quarter_data boundary[${t.qdKey}] captured (diff from [${t.qdPrev}]: ${diffKeys} fields)`);
                  } catch (e) {
                    log(`${matchup}: ${t.label} quarter_data capture failed: ${e.message}`);
                  }
                }

                // Compute + save server context (PBP, arrows, window, etc.)
                // Uses DO NOTHING on conflict — client-pushed context is richer, don't overwrite
                const serverCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, currentPeriod, clock, matchup, sust, odds);
                if (serverCtx) {
                  try {
                    await sql`
                      INSERT INTO game_context (game_id, league, period, context_json, updated_at)
                      VALUES (${game.id}, ${league}, ${currentPeriod}, ${JSON.stringify(serverCtx)}, NOW())
                      ON CONFLICT (game_id, period) DO NOTHING
                    `;
                    log(`${matchup}: ${t.label} server context saved — ${Object.keys(serverCtx).length} layers`);
                  } catch (e) {
                    log(`${matchup}: ${t.label} server context save failed: ${e.message}`);
                  }
                }

                // Fire Sonnet analysis only for NBA (NCAAMB: snapshot + context only)
                if (t.sonnet) {
                  pendingAnalyses.push(
                    fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, currentPeriod, clock, t.trigger)
                      .catch(e => log(`${matchup}: ${t.label} CAL analysis async error: ${e.message}`))
                  );
                }
              }
            }

            // Track period + clock for transition detection across cycles
            if (league === 'ncaamb' && clockMin != null) {
              game.last_clock_min = clockMin;
            }
          }
          // Always track period for transition detection across cycles
          game.last_period = currentPeriod;

          // ── QUARTER DATA: compute rolling window every poll ──
          // Reads quarter_data (with any freshly captured boundaries), computes
          // partial current quarter diff, scores I1-I5, saves window back.
          // This runs AFTER boundary capture so new boundaries are included.
          if (currentPeriod >= 2 || (league === 'ncaamb' && currentPeriod >= 1)) {
            try {
              const qd = await readQuarterData(sql, game.id);
              const hasDiffs = Object.keys(qd.diffs || {}).length > 0;
              if (hasDiffs) {
                const serverWindow = computeServerWindow(qd, currentPeriod, clock, summary, hA, aA, league);
                if (serverWindow) {
                  qd.window = serverWindow;
                  await writeQuarterData(sql, game.id, qd);
                  log(`${matchup}: QTR window — ${serverWindow.controlTeam} ${serverWindow.score} [${serverWindow.windowQuarters.join(',')}]`);
                }
              }
            } catch (e) {
              log(`${matchup}: server window compute failed: ${e.message}`);
            }
          }

        } catch (e) {
          results.errors.push(`${matchup}: ${e.message}`);
          log(`ERROR ${matchup}: ${e.message}`);
        }
      }

      // ── 5. Update cached schedule if any game status changed ──
      if (cacheUpdated) {
        try {
          // Check if all games are now final
          const allDone = cachedGames.every(g => g.status === 'closed' || g.status === 'complete');
          await sql`
            UPDATE poll_state SET schedule_json = ${JSON.stringify(cachedGames)},
              all_final = ${allDone}
            WHERE league = ${league} AND date = ${dateKey}
          `;
          if (allDone) {
            log(`${league.toUpperCase()}: ALL GAMES FINAL — server going to sleep`);
          }
        } catch (e) {
          log(`Cache update failed: ${e.message}`);
        }
      }

      if (liveCount === 0 && potentiallyLive.length > 0) {
        log(`${league.toUpperCase()}: ${potentiallyLive.length} games checked, none currently live`);
      }

    } catch (e) {
      results.errors.push(`${league}: ${e.message}`);
      log(`ERROR ${league}: ${e.message}`);
    }
  }

  // Wait for all Sonnet analyses to complete (including DB INSERT) before runtime exits
  if (pendingAnalyses.length > 0) {
    log(`Awaiting ${pendingAnalyses.length} Sonnet analyse(s)...`);
    await Promise.all(pendingAnalyses);
    log(`All Sonnet analyses complete.`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (results.snapshots > 0 || results.errors.length > 0) {
    log(`=== Done in ${elapsed}s | ${results.snapshots} snapshots, ${results.espn} ESPN WP, ${results.odds} odds, ${results.errors.length} errors ===`);
  } else if (results.skipped) {
    log(`=== Done in ${elapsed}s | skipped: ${results.skipped} ===`);
  }

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── SCHEDULE CONFIG ─────────────────────────────────────────────────────────

export const config = {
  schedule: "*/1 * * * *",  // BDL: every 1 min
};
