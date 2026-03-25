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
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': String(priority), 'Tags': 'basketball' },
      body: body,
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
  const data = await bdlFetch(`${cfg.bdlPrefix}/v1/games?dates[]=${dateStr}&per_page=50`);
  if (!data || !data.data) return { teamIds: {}, gameIds: {} };
  const teamIds = {}; // { 'LAL': 14, 'HOU': 11, ... }
  const gameIds = {}; // { 'HOU@LAL': 54321, ... } — keyed by matchup for SR→BDL mapping
  for (const g of data.data) {
    const hAbbr = g.home_team?.abbreviation;
    const aAbbr = g.visitor_team?.abbreviation;
    if (hAbbr && g.home_team?.id) teamIds[hAbbr] = g.home_team.id;
    if (aAbbr && g.visitor_team?.id) teamIds[aAbbr] = g.visitor_team.id;
    if (hAbbr && aAbbr && g.id) gameIds[`${aAbbr}@${hAbbr}`] = g.id;
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

function normalizeBdlStatusServer(s) {
  if (!s) return 'scheduled';
  const sl = s.toLowerCase();
  if (sl === 'final') return 'closed';
  if (sl === 'in progress' || sl.includes('qtr') || sl.includes('quarter') || sl.includes('overtime') || sl.includes(' ot') || sl === 'ot' || /^\d*\s*ot/i.test(sl)) return 'inprogress';
  if (sl === 'halftime' || sl.includes('half')) return 'halftime';
  if (s.includes('T') && s.includes(':')) return 'scheduled';
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

  const srSt = normalizeBdlStatusServer(game.status);
  return { id: game.id, status: srSt, quarter: game.period || periods.length || 0, clock: game.time || '', lead_changes: lc, times_tied: tt, _dataSource: 'BDL',
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
async function computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, period, clock, matchup) {
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

  // ── 4. ROLLING WINDOW + ACCELERATION (from DB snapshots) ──
  try {
    const snaps = await sql`
      SELECT period, floor_score, floor_team, i1, i2, i3, i4, i5, ts
      FROM snapshots WHERE game_id = ${game.id} AND floor_score IS NOT NULL
      ORDER BY ts ASC
    `;

    if (snaps.length >= 1) {
      // Rolling window: group by period, cross-fade weighted
      const byPeriod = {};
      for (const s of snaps) {
        if (s.period >= 1) byPeriod[s.period] = s; // last snapshot per period
      }
      const periodKeys = Object.keys(byPeriod).map(Number).sort((a, b) => a - b);

      if (periodKeys.length >= 1) {
        const maxPer = periodKeys[periodKeys.length - 1];
        let wI1 = 0, wI2 = 0, wI3 = 0, wI4 = 0, wI5 = 0, wSum = 0;
        for (const pk of periodKeys) {
          const sn = byPeriod[pk];
          const weight = (pk === maxPer) ? 1.0 : (pk >= maxPer - 1) ? 1.0 : 0.5;
          wI1 += (sn.i1 ?? 0.5) * weight;
          wI2 += (sn.i2 ?? 0.5) * weight;
          wI3 += (sn.i3 ?? 0.5) * weight;
          wI4 += (sn.i4 ?? 0.5) * weight;
          wI5 += (sn.i5 ?? 0.5) * weight;
          wSum += weight;
        }
        if (wSum > 0) {
          const nI1 = wI1 / wSum, nI2 = wI2 / wSum, nI3 = wI3 / wSum, nI4 = wI4 / wSum, nI5 = wI5 / wSum;
          const rawW = nI1 * W.I1 + nI2 * W.I2 + nI3 * W.I3 + nI4 * W.I4 + nI5 * W.I5;
          const ctrlHomeW = rawW >= 0.5;
          const wTeam = ctrlHomeW ? hA : aA;
          const wScore = ctrlHomeW ? rawW : 1 - rawW;
          ctx.rollingWindow = {
            available: true,
            score: Math.round(wScore * 100) / 100,
            controlTeam: wTeam,
            windowQuarters: periodKeys.map(q => 'Q' + q),
            windowPossessions: 0,
            possessionBased: false,
            dataQuality: 'SERVER',
            I1: { score: Math.round(nI1 * 10) / 10 }, I2: { score: Math.round(nI2 * 10) / 10 },
            I3: { score: Math.round(nI3 * 10) / 10 }, I4: { score: Math.round(nI4 * 10) / 10 },
            I5: { score: Math.round(nI5 * 10) / 10 },
          };
          // Per-period I1-I5 scores — client uses these as seed data for cross-fade
          ctx.perPeriodScores = {};
          for (const pk of periodKeys) {
            const sn = byPeriod[pk];
            ctx.perPeriodScores[pk] = {
              i1: sn.i1 ?? 0.5, i2: sn.i2 ?? 0.5, i3: sn.i3 ?? 0.5,
              i4: sn.i4 ?? 0.5, i5: sn.i5 ?? 0.5,
              floor_score: sn.floor_score, floor_team: sn.floor_team,
            };
          }
        }
      }

      // Acceleration: compute gap (window - floor) across snapshots
      if (ctx.rollingWindow && snaps.length >= 3) {
        const gapEntries = [];
        // Use one entry per period boundary from snapshots
        for (const pk of periodKeys) {
          const sn = byPeriod[pk];
          if (sn.floor_score != null && ctx.rollingWindow.score != null) {
            // Approximate gap at each period
            const periodRaw = (sn.i1 ?? 0.5) * W.I1 + (sn.i2 ?? 0.5) * W.I2 + (sn.i3 ?? 0.5) * W.I3 + (sn.i4 ?? 0.5) * W.I4 + (sn.i5 ?? 0.5) * W.I5;
            const periodScore = periodRaw >= 0.5 ? periodRaw : 1 - periodRaw;
            const gap = periodScore - sn.floor_score;
            gapEntries.push({ gap, score: sn.floor_score, period: pk });
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
    }
  } catch (e) {
    log(`${matchup}: server context — snapshot query failed: ${e.message}`);
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

    // ── 6. Read client-pushed context from DB (rich layers only client can compute) ──
    let clientCtx = null;
    let ctxSource = 'none';
    try {
      const ctxRows = await sql`
        SELECT context_json, period, updated_at FROM game_context
        WHERE game_id = ${game.id}
        ORDER BY period DESC LIMIT 1
      `;
      if (ctxRows.length > 0) {
        clientCtx = typeof ctxRows[0].context_json === 'string'
          ? JSON.parse(ctxRows[0].context_json)
          : ctxRows[0].context_json;
        const ctxAge = (Date.now() - new Date(ctxRows[0].updated_at).getTime()) / 60000;
        const ctxLayers = clientCtx ? Object.keys(clientCtx).filter(k => !['gamePeriod','gameClock','homePts','awayPts'].includes(k)).length : 0;
        log(`${matchup}: ${triggerTag} CAL — client context found (Q${ctxRows[0].period}, ${ctxAge.toFixed(0)}m ago, ${ctxLayers} layers)`);
        ctxSource = 'client';
      }
    } catch (e) { /* game_context table may not exist yet */ }

    // ── 6b. Server fallback — compute context when client is asleep ──
    if (!clientCtx) {
      log(`${matchup}: ${triggerTag} CAL — no client context, computing server-side fallback`);
      clientCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, period, clock, matchup);
      if (clientCtx) ctxSource = 'server';
    }

    const payload = {
      summaryData: summary,
      thesis: thesis ? thesis + (calibrationNote ? '\n\n' + calibrationNote : '') : calibrationNote || null,
      homeTeam: hA,
      awayTeam: aA,
      period: periodStr,
      score: scoreLine,
      clutchData: clutchData,
      oddsData: odds ? {
        homeSpread: odds.homeSpread, homeML: odds.homeML,
        awayML: odds.awayML, total: odds.total,
      } : null,
      wpProfiles: wpProfiles,
      analysisHistory: analysisHistory,
      // Client-pushed context — fills the 9-layer gap when client is active
      edgeHistory: clientCtx?.edgeHistory || null,
      trackingData: clientCtx?.trackingData || null,
      pbpAudit: clientCtx?.pbpAudit || null,
      rollingWindow: clientCtx?.rollingWindow || null,
      acceleration: clientCtx?.acceleration || null,
      subMetricArrows: clientCtx?.subMetricArrows || null,
      adjustment: clientCtx?.adjustment || null,
      combinedRead: clientCtx?.combinedRead || null,
      bonusStatus: clientCtx?.bonusStatus || null,
      gameClock: clientCtx?.gameClock || clock,
      gamePeriod: period,
      // ESPN WP: prefer server's fresh fetch, fall back to client-pushed
      espnWP: espnWP ? {
        home: espnWP.home, away: espnWP.away,
        homeAlias: hA, awayAlias: aA,
        opening: null, dataPoints: 0,
      } : clientCtx?.espnWP || null,
    };

    // ── 7. Call Anthropic API directly (bypasses site password protection) ──
    const ctxStatus = ctxSource === 'client' ? 'client✓' : ctxSource === 'server' ? 'server-computed' : 'no-context';
    log(`${matchup}: ${triggerTag} CAL — firing Sonnet analysis (${ctxStatus} thesis:${thesis ? 'yes' : 'no'} clutch:${clutchData ? 'yes' : 'no'} odds:${odds ? 'yes' : 'no'} wp:${wpProfiles ? 'yes' : 'no'})`);

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) { log(`${matchup}: ${triggerTag} CAL — ANTHROPIC_API_KEY not configured`); return; }

    // Build user prompt from payload sections
    let userPrompt = `${aA} @ ${hA} | Q${period} ${clock} | ${scoreLine}\n\n`;
    if (thesis) userPrompt += `THESIS:\n${thesis}\n\n`;

    // Sustainability
    if (sust) {
      userPrompt += `3PT SUSTAINABILITY:\n`;
      if (sust.home) userPrompt += `  ${hA}: ${sust.home.tier || '?'} — live ${sust.home.live3Pct || '?'}% vs ${sust.home.seasonPrior || sust.home.seasonBaseline || '?'}% szn, regression ${sust.home.regressionProb || '?'}%\n`;
      if (sust.away) userPrompt += `  ${aA}: ${sust.away.tier || '?'} — live ${sust.away.live3Pct || '?'}% vs ${sust.away.seasonPrior || sust.away.seasonBaseline || '?'}% szn, regression ${sust.away.regressionProb || '?'}%\n`;
    }
    // Lead composition
    if (leadComp) {
      userPrompt += `LEAD COMPOSITION: ${leadComp.classification || '?'} — S:${leadComp.structuralPct || '?'}% V:${leadComp.variancePct || '?'}%\n`;
      userPrompt += `  ${hA}: Paint ${leadComp.home?.paint || 0} FT ${leadComp.home?.ft || 0} 3PT ${leadComp.home?.three || 0}\n`;
      userPrompt += `  ${aA}: Paint ${leadComp.away?.paint || 0} FT ${leadComp.away?.ft || 0} 3PT ${leadComp.away?.three || 0}\n`;
    }
    // Dashboard indicators
    if (ind) {
      userPrompt += `DASHBOARD SCORES: ${ind.controlTeam || '?'} ${ind.score?.toFixed(2) || '?'}\n`;
      ['I1','I2','I3','I4','I5'].forEach(k => {
        if (ind[k]) userPrompt += `  ${k}: ${ind[k].score?.toFixed(1) || '?'} ${ind[k].leader || ''} — ${ind[k].detail || ''}\n`;
      });
    }
    // Clutch
    if (clutchData) {
      userPrompt += `CLUTCH:\n  ${aA}: NetRtg ${clutchData.away?.netRtg ?? 'N/A'}\n  ${hA}: NetRtg ${clutchData.home?.netRtg ?? 'N/A'}\n`;
    }
    // Odds
    if (odds) {
      userPrompt += `MARKET: Spread ${hA} ${odds.homeSpread || 'N/A'} | ML ${aA} ${odds.awayML || 'N/A'} / ${hA} ${odds.homeML || 'N/A'} | O/U ${odds.total || 'N/A'}\n`;
    }
    // ESPN WP
    if (espnWP) {
      userPrompt += `ESPN WP: ${hA} ${espnWP.home ?? '?'}% / ${aA} ${espnWP.away ?? '?'}%\n`;
    }
    // Client context layers
    if (clientCtx?.rollingWindow?.available) {
      const rw = clientCtx.rollingWindow;
      userPrompt += `ROLLING WINDOW: ${rw.controlTeam} ${rw.score?.toFixed(2)}\n`;
    }
    if (clientCtx?.acceleration?.accel) {
      userPrompt += `GAP ACCEL: ${clientCtx.acceleration.accel}\n`;
    }
    if (clientCtx?.combinedRead?.read) {
      userPrompt += `COMBINED READ: ${clientCtx.combinedRead.read}\n`;
    }
    // WP profiles
    if (wpProfiles) userPrompt += `\n${wpProfiles}\n`;
    // Analysis history
    if (analysisHistory && analysisHistory.length > 0) {
      userPrompt += `\nGAME NARRATIVE:\n`;
      analysisHistory.forEach((h, i) => {
        userPrompt += `${i+1}. Q${h.period || '?'} ${h.clock || ''} | ${h.controlTeam || '?'} ${h.controlScore || '?'} | ${h.entry || '—'}/${h.conviction || '—'} | ${h.signal || '—'}\n`;
      });
    }
    // Full game data
    userPrompt += `\nGAME DATA:\n${JSON.stringify(summary)}`;

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
          prediction_json, indicators_json, "trigger")
        VALUES (${game.id}, ${period}, ${clock}, ${parsed.controlTeam}, ${parsed.controlScore},
          ${parsed.fwp}, ${parsed.edge}, ${parsed.entry}, ${parsed.conviction}, ${parsed.signal},
          ${parsed.sustainability}, ${parsed.leadSource}, ${result.analysis},
          ${parsed.predictionJson ? JSON.stringify(parsed.predictionJson) : null},
          ${parsed.indicatorsJson ? JSON.stringify(parsed.indicatorsJson) : null},
          ${triggerTag})
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
      sendNtfy(ntfyTitle, ntfyBody, ntfyPriority).catch(() => {});
    }
  } catch (e) {
    log(`${matchup}: ${triggerTag} CAL ERROR — ${e.message}`);
  }
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function(req) {
  const startTime = Date.now();

  // Get DB connection
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log('ERROR: DATABASE_URL not configured');
    return new Response('DATABASE_URL not configured', { status: 500 });
  }
  const sql = neon(dbUrl);

  const results = { games: 0, snapshots: 0, espn: 0, odds: 0, errors: [], skipped: null };

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
          const gameStatus = normalizeBdlStatusServer(boxScore.status);
          if (gameStatus === 'closed' || gameStatus === 'complete') {
            game.status = gameStatus;
            cacheUpdated = true;
            log(`${matchup}: FINAL — removed from active polling`);
            if (espnMap[game.id]) {
              var finalWP = await espnWinProb(league, espnMap[game.id]);
            }
            continue;
          }
          if (gameStatus === 'scheduled' || gameStatus === 'created') {
            log(`${matchup}: not started yet (${gameStatus})`);
            continue;
          }

          liveCount++;

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

          const bdlEnriched = (homeBdl.length > 0 || awayBdl.length > 0);
          log(`${matchup} Q${currentPeriod} ${clock} | ${ind.homePts}-${ind.awayPts} | ${ind.controlTeam} ${ind.score} | I:${ind.I1.score}/${ind.I2.score}/${ind.I3.score}/${ind.I4.score}/${ind.I5.score} | sust:${leadSust || '?'} class:${leadClass || '?'}${bdlEnriched ? ' BDL✓' : ''}${spreadVal != null ? ` spd:${spreadVal}` : ''}${espnWP ? ` | WP:${espnWP.home}%` : ''}`);

          // ── LIGHTWEIGHT ENTRY SIGNAL CHECK (every cycle, no Sonnet needed) ──
          // Mirrors client synthesizer BUY conditions: floor ≥ 0.70, trailing, deficit 4-15,
          // opponent FRAGILE/UNSUSTAINABLE, control team NOT FRAGILE
          {
            const trailSide = leadSide === 'home' ? 'away' : 'home';
            const ctrlSide = ind.controlTeam === hA ? 'home' : 'away';
            const oppSide = ctrlSide === 'home' ? 'away' : 'home';
            const ctrlSust = sust?.[ctrlSide]?.tier || null;
            const oppSustTier = sust?.[oppSide]?.tier || null;
            const ctrlTrailing = (ctrlSide === 'home' && ind.homePts < ind.awayPts) || (ctrlSide === 'away' && ind.awayPts < ind.homePts);
            const ctrlDeficit = ctrlTrailing ? Math.abs(ind.homePts - ind.awayPts) : 0;
            const oppFragile = oppSustTier === 'FRAGILE' || oppSustTier === 'UNSUSTAINABLE';
            const ctrlNotFragile = ctrlSust !== 'FRAGILE' && ctrlSust !== 'UNSUSTAINABLE';
            const inBuyRange = ctrlDeficit >= 4 && ctrlDeficit <= 15;

            if (ind.score >= 0.70 && ctrlTrailing && inBuyRange && oppFragile && ctrlNotFragile && currentPeriod >= 2) {
              // Debounce: only fire once per game per period
              const alertKey = `${game.id}_Q${currentPeriod}`;
              if (!game._lastAlert || game._lastAlert !== alertKey) {
                game._lastAlert = alertKey;
                cacheUpdated = true;
                const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA}`;
                const ntfyTitle = `🟢 BUY SIGNAL — ${matchup}`;
                const ntfyBody = `${scoreLine} Q${currentPeriod} ${clock}`
                  + `\nFloor: ${ind.controlTeam} ${ind.score.toFixed(2)}`
                  + `\nDeficit: ${ctrlDeficit} | ${oppSustTier} vs ${ctrlSust || 'N/A'}`
                  + (spreadVal != null ? `\nSpread: ${spreadVal}` : '')
                  + (espnWP ? `\nESPN WP: ${espnWP.home}%/${espnWP.away}%` : '')
                  + `\nClass: ${leadClass || '?'}`;
                sendNtfy(ntfyTitle, ntfyBody, 5).catch(() => {});
                log(`${matchup}: 🟢 ENTRY SIGNAL PUSHED — ${ind.controlTeam} ${ind.score.toFixed(2)} trailing by ${ctrlDeficit}, opp ${oppSustTier}`);
              }
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
                { from: 1, to: 2, tag: 'calibration_q1', trigger: 'auto_q1', label: 'Q1', sonnet: true },
                { from: 2, to: 3, tag: 'calibration_q2', trigger: 'auto_q2', label: 'Q2', sonnet: true },
                { from: 3, to: 4, tag: 'calibration_q3', trigger: 'auto_q3', label: 'Q3', sonnet: true },
              ];
            } else if (league === 'ncaamb') {
              // Period-based: halftime (period 1→2)
              transitions.push({ from: 1, to: 2, tag: 'calibration_sq2', trigger: 'auto_sq2', label: 'sQ2(half)', sonnet: false });

              // State-based: if we're past the 10:00 mark, the synthetic quarter boundary should exist
              // DB dedup prevents re-firing on every poll
              if (currentPeriod === 1 && clockMin != null && clockMin <= 10.0) {
                transitions.push({ from: 0, to: 1, tag: 'calibration_sq1', trigger: 'auto_sq1', label: 'sQ1(H1@10)', sonnet: false, clockBased: true });
              }
              if (currentPeriod === 2 && clockMin != null && clockMin <= 10.0) {
                transitions.push({ from: 0, to: 1, tag: 'calibration_sq3', trigger: 'auto_sq3', label: 'sQ3(H2@10)', sonnet: false, clockBased: true });
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

                // Compute + save server context (PBP, arrows, window, etc.)
                // Uses DO NOTHING on conflict — client-pushed context is richer, don't overwrite
                const serverCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, currentPeriod, clock, matchup);
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
                  fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, currentPeriod, clock, t.trigger)
                    .catch(e => log(`${matchup}: ${t.label} CAL analysis async error: ${e.message}`));
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
