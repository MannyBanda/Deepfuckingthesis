// Database API — Neon Postgres via Netlify DB
// Handles: schema init, snapshot capture, game finalization, calibration queries
// Uses @neondatabase/serverless HTTP transport (no TCP needed)

const { neon } = require('@neondatabase/serverless');

function getSQL() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not configured — set up Netlify DB first');
  return neon(url);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const action = params.action;

  if (!action) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action required' }) };
  }

  try {
    const sql = getSQL();

    // ═══════════════════════════════════════════════════════
    // INIT — create tables (idempotent)
    // ═══════════════════════════════════════════════════════
    if (action === 'init') {
      await sql`
        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY,
          date TEXT,
          league TEXT DEFAULT 'nba',
          matchup TEXT,
          home_alias TEXT,
          away_alias TEXT,
          home_pts INTEGER,
          away_pts INTEGER,
          winner TEXT,
          margin INTEGER,
          spread REAL,
          home_covered BOOLEAN,
          away_covered BOOLEAN,
          thesis_team TEXT,
          thesis_correct BOOLEAN,
          fwp_team TEXT,
          fwp_value REAL,
          fwp_correct BOOLEAN,
          conviction TEXT,
          entry_signal TEXT,
          classification TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS snapshots (
          id SERIAL PRIMARY KEY,
          game_id TEXT REFERENCES games(id),
          ts TIMESTAMPTZ DEFAULT NOW(),
          period INTEGER,
          clock TEXT,
          home_pts INTEGER,
          away_pts INTEGER,
          floor_score REAL,
          floor_team TEXT,
          pbp_score REAL,
          pbp_team TEXT,
          pbp_window_size INTEGER,
          qtr_score REAL,
          qtr_team TEXT,
          espn_wp_home REAL,
          espn_wp_away REAL,
          spread REAL,
          deficit INTEGER,
          trailing_team TEXT,
          lead_sust TEXT,
          gap REAL,
          accel TEXT,
          i1 REAL, i2 REAL, i3 REAL, i4 REAL, i5 REAL
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS theses (
          game_id TEXT PRIMARY KEY,
          league TEXT DEFAULT 'nba',
          text TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS analyses (
          id SERIAL PRIMARY KEY,
          game_id TEXT,
          ts TIMESTAMPTZ DEFAULT NOW(),
          period INTEGER,
          clock TEXT,
          control_team TEXT,
          control_score REAL,
          fwp TEXT,
          edge TEXT,
          entry TEXT,
          conviction TEXT,
          signal TEXT,
          sustainability TEXT,
          lead_source TEXT,
          raw_text TEXT,
          prediction_json JSONB,
          indicators_json JSONB
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_game ON snapshots(game_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_period ON snapshots(period)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_analyses_game ON analyses(game_id)`;

      // Migrations — add columns if they don't exist (safe to re-run)
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS prediction_json JSONB`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS indicators_json JSONB`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS narrative_json JSONB`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS "trigger" TEXT DEFAULT 'manual'`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS home_pts INTEGER`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS away_pts INTEGER`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS context_layers TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS prompt_chars INTEGER`; } catch(e) {}

      // Snapshot enrichment columns (server-side polling)
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'client'`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS lead_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS sust_json JSONB`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS window_json JSONB`; } catch(e) {}
      // Throughput + lead safety persistence for backtesting
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tp_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tp_exp_swing REAL`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tp_remain_poss INTEGER`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS ls_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS ls_exp_swing REAL`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS raw_stats_json JSONB`; } catch(e) {}

      // Quarter-level data for server-authoritative rolling window
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS quarter_data JSONB`; } catch(e) {}

      // Throughput/lead safety trend tracking
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_tp_exp REAL`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_ls_exp REAL`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_ctrl_team TEXT`; } catch(e) {}
      // Transition alert tracking (legacy — single-side, deprecated)
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_tp_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_ls_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_opp_sust TEXT`; } catch(e) {}
      // Per-side transition alert tracking (fixes control-flip false fires)
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_home_tp_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_home_ls_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_home_ls_margin INTEGER`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_home_opp_sust TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_away_tp_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_away_ls_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_away_ls_margin INTEGER`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS prev_away_opp_sust TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS home_lead_degraded_at TIMESTAMPTZ`; } catch(e) {}
      try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS away_lead_degraded_at TIMESTAMPTZ`; } catch(e) {}

      // WP profile table — team-level win probability curve analysis
      await sql`
        CREATE TABLE IF NOT EXISTS wp_profiles (
          team_alias TEXT NOT NULL,
          league TEXT DEFAULT 'nba',
          season TEXT DEFAULT '2025-26',
          games_analyzed INTEGER DEFAULT 0,
          profile_json JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (team_alias, league, season)
        )
      `;

      // Clutch data — persists OCR uploads keyed by team
      await sql`
        CREATE TABLE IF NOT EXISTS clutch (
          id SERIAL PRIMARY KEY,
          team_alias TEXT NOT NULL,
          league TEXT DEFAULT 'nba',
          tier INTEGER DEFAULT 3,
          net_rtg REAL,
          off_rtg REAL,
          def_rtg REAL,
          wl TEXT,
          efg REAL,
          pace REAL,
          pie REAL,
          source TEXT,
          data_json JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_clutch_team ON clutch(team_alias, league)`;

      // Odds history — tracks line movement over time
      await sql`
        CREATE TABLE IF NOT EXISTS odds_history (
          id SERIAL PRIMARY KEY,
          game_id TEXT,
          ts TIMESTAMPTZ DEFAULT NOW(),
          home_spread REAL,
          home_ml INTEGER,
          away_ml INTEGER,
          total REAL,
          source TEXT DEFAULT 'bdl'
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_odds_game ON odds_history(game_id)`;

      // Poll heartbeat — client writes to signal it's active, server checks before polling
      await sql`
        CREATE TABLE IF NOT EXISTS poll_heartbeats (
          league TEXT PRIMARY KEY,
          last_poll TIMESTAMPTZ DEFAULT NOW(),
          device TEXT
        )
      `;

      // Poll state — tracks daily schedule + game window to minimize SR API calls
      await sql`
        CREATE TABLE IF NOT EXISTS poll_state (
          league TEXT NOT NULL,
          date TEXT NOT NULL,
          first_tip TIMESTAMPTZ,
          last_tip TIMESTAMPTZ,
          game_count INTEGER DEFAULT 0,
          all_final BOOLEAN DEFAULT FALSE,
          schedule_json JSONB,
          fetched_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (league, date)
        )
      `;

      // Season cache — weekly-refreshed player season averages per team
      await sql`
        CREATE TABLE IF NOT EXISTS season_cache (
          team_alias TEXT NOT NULL,
          league TEXT NOT NULL DEFAULT 'nba',
          season TEXT NOT NULL DEFAULT '2025',
          players_json JSONB,
          player_count INTEGER DEFAULT 0,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (team_alias, league, season)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_season_cache_league ON season_cache(league, season)`;

      // Game context — client pushes rich computed state at quarter boundaries
      // Server reads this before firing auto calibration analyses
      await sql`
        CREATE TABLE IF NOT EXISTS game_context (
          game_id TEXT NOT NULL,
          league TEXT DEFAULT 'nba',
          period INTEGER NOT NULL,
          context_json JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (game_id, period)
        )
      `;

      // Game PBP — parsed play-by-play audit persisted at finalization
      // Client checks this before burning an SR PBP API call
      await sql`
        CREATE TABLE IF NOT EXISTS game_pbp (
          game_id TEXT PRIMARY KEY,
          league TEXT DEFAULT 'nba',
          home_alias TEXT,
          away_alias TEXT,
          total_shots INTEGER,
          total_tos INTEGER,
          pbp_json JSONB,
          saved_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS alerts (
          id SERIAL PRIMARY KEY,
          game_id TEXT NOT NULL,
          league TEXT DEFAULT 'nba',
          alert_type TEXT NOT NULL,
          period INTEGER,
          clock TEXT,
          control_team TEXT,
          floor_score REAL,
          margin INTEGER,
          is_trailing BOOLEAN,
          edge REAL,
          ml INTEGER,
          spread REAL,
          tp_class TEXT,
          ls_class TEXT,
          ctrl_sust TEXT,
          opp_sust TEXT,
          window_score REAL,
          ts TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      try { await sql`CREATE INDEX IF NOT EXISTS idx_alerts_game ON alerts (game_id)`; } catch(e) {}
      try { await sql`CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts)`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS tp_ratio REAL`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_tier TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS agent_decision TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS agent_reasoning TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS i1 REAL`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS i2 REAL`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS i3 REAL`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS i4 REAL`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS i5 REAL`; } catch(e) {}
      try { await sql`ALTER TABLE game_pbp ADD COLUMN IF NOT EXISTS box_score_json JSONB`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS conviction_tier TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS conviction_combo TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ntfy_sent BOOLEAN`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS monitor_status TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS monitor_reasoning TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS monitor_ts TIMESTAMPTZ`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS parent_alert_id INTEGER`; } catch(e) {}
      try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS emerging_signal TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE poll_state ADD COLUMN IF NOT EXISTS monitor_last_run TIMESTAMPTZ`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS conviction_tier TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS conviction_combo TEXT`; } catch(e) {}

      // ── MONITOR OBSERVATIONS table (game narration by monitor agent) ──
      await sql`CREATE TABLE IF NOT EXISTS monitor_observations (
        id SERIAL PRIMARY KEY,
        game_id TEXT NOT NULL,
        league TEXT DEFAULT 'nba',
        period INTEGER,
        clock TEXT,
        ts TIMESTAMPTZ DEFAULT NOW(),
        control_team TEXT,
        floor_score REAL,
        margin INTEGER,
        momentum_direction TEXT,
        momentum_streak INTEGER,
        momentum_delta REAL,
        sust_arc TEXT,
        sust_arc_detail TEXT,
        floor_margin_rel TEXT,
        narrative TEXT,
        risk_factors TEXT,
        raw_inputs JSONB
      )`;

      // ── LEARNINGS table (post-game agent nightly analysis) ──
      await sql`CREATE TABLE IF NOT EXISTS learnings (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        games_analyzed INT DEFAULT 0,
        alerts_scored INT DEFAULT 0,
        accuracy_overall INT,
        accuracy_by_type JSONB DEFAULT '{}',
        agent_accuracy JSONB DEFAULT '{}',
        findings TEXT,
        patterns JSONB DEFAULT '[]',
        recommendations JSONB DEFAULT '[]',
        ts TIMESTAMPTZ DEFAULT NOW()
      )`;
      try { await sql`CREATE INDEX IF NOT EXISTS idx_learnings_date ON learnings (date)`; } catch(e) {}

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'Schema initialized' }) };
    }

    // ═══════════════════════════════════════════════════════
    // SAVE_PBP — persist parsed PBP audit at game finalization
    // ═══════════════════════════════════════════════════════
    if (action === 'save_pbp' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { game_id, league, home_alias, away_alias, pbp } = body;
      if (!game_id || !pbp) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id and pbp required' }) };

      await sql`
        INSERT INTO game_pbp (game_id, league, home_alias, away_alias, total_shots, total_tos, pbp_json, saved_at)
        VALUES (${game_id}, ${league || 'nba'}, ${home_alias || null}, ${away_alias || null},
          ${pbp.totalShots || 0}, ${pbp.totalTOs || 0}, ${JSON.stringify(pbp)}, NOW())
        ON CONFLICT (game_id) DO UPDATE SET
          pbp_json = ${JSON.stringify(pbp)}, total_shots = ${pbp.totalShots || 0},
          total_tos = ${pbp.totalTOs || 0}, saved_at = NOW()
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, game_id }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_PBP — fetch persisted PBP audit (avoids SR API call)
    // ═══════════════════════════════════════════════════════
    if (action === 'get_pbp') {
      const game_id = params.game_id;
      if (!game_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id required' }) };

      const rows = await sql`
        SELECT pbp_json, saved_at FROM game_pbp WHERE game_id = ${game_id} LIMIT 1
      `;
      if (rows.length === 0) return { statusCode: 200, headers, body: JSON.stringify({ pbp: null }) };

      const pbp = typeof rows[0].pbp_json === 'string' ? JSON.parse(rows[0].pbp_json) : rows[0].pbp_json;
      return { statusCode: 200, headers, body: JSON.stringify({ pbp, saved_at: rows[0].saved_at }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_PBP_ALL — bulk fetch all PBP for debug/analytics
    // ═══════════════════════════════════════════════════════
    if (action === 'get_pbp_all') {
      const league = params.league || 'nba';
      const team = params.team || null;

      let rows;
      if (team) {
        rows = await sql`
          SELECT game_id, home_alias, away_alias, total_shots, total_tos, pbp_json, saved_at
          FROM game_pbp WHERE league = ${league} AND (home_alias = ${team} OR away_alias = ${team})
          ORDER BY saved_at DESC
        `;
      } else {
        rows = await sql`
          SELECT game_id, home_alias, away_alias, total_shots, total_tos, pbp_json, saved_at
          FROM game_pbp WHERE league = ${league}
          ORDER BY saved_at DESC
        `;
      }

      const games = rows.map(r => ({
        game_id: r.game_id,
        home: r.home_alias, away: r.away_alias,
        shots: r.total_shots, tos: r.total_tos,
        saved: r.saved_at,
        pbp: typeof r.pbp_json === 'string' ? JSON.parse(r.pbp_json) : r.pbp_json,
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ games, total: games.length }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_ZONE_BASELINES — aggregated per-team shot zone baselines from game_pbp
    // ═══════════════════════════════════════════════════════
    if (action === 'get_zone_baselines') {
      const league = params.league || 'nba';
      const rows = await sql`SELECT home_alias, away_alias, pbp_json FROM game_pbp WHERE league = ${league}`;
      const teams = {};
      for (const r of rows) {
        const pbp = typeof r.pbp_json === 'string' ? JSON.parse(r.pbp_json) : r.pbp_json;
        for (const [side, alias] of [['home', r.home_alias], ['away', r.away_alias]]) {
          const tm = pbp[side];
          if (!tm) continue;
          if (!teams[alias]) teams[alias] = { gp: 0, rim: {m:0,a:0}, paint: {m:0,a:0}, mid: {m:0,a:0}, corner3: {m:0,a:0}, above3: {m:0,a:0} };
          teams[alias].gp++;
          if (tm.rim) { teams[alias].rim.m += tm.rim.made || 0; teams[alias].rim.a += tm.rim.att || 0; }
          if (tm.paint) { teams[alias].paint.m += tm.paint.made || 0; teams[alias].paint.a += tm.paint.att || 0; }
          if (tm.mid) { teams[alias].mid.m += tm.mid.made || 0; teams[alias].mid.a += tm.mid.att || 0; }
          if (tm.threes) {
            if (tm.threes.corner) { teams[alias].corner3.m += tm.threes.corner.made || 0; teams[alias].corner3.a += tm.threes.corner.att || 0; }
            if (tm.threes.above) { teams[alias].above3.m += tm.threes.above.made || 0; teams[alias].above3.a += tm.threes.above.att || 0; }
          }
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ teams, total_games: rows.length }) };
    }

    // ═══════════════════════════════════════════════════════
    // SAVE_CONTEXT — client pushes rich computed state at quarter boundaries
    // ═══════════════════════════════════════════════════════
    if (action === 'save_context' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.game_id || !body.period) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id and period required' }) };
      await sql`
        INSERT INTO game_context (game_id, league, period, context_json, updated_at)
        VALUES (${body.game_id}, ${body.league || 'nba'}, ${body.period}, ${JSON.stringify(body.context)}, NOW())
        ON CONFLICT (game_id, period) DO UPDATE SET
          context_json = ${JSON.stringify(body.context)}, updated_at = NOW()
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_CONTEXT — server reads client-pushed context before auto analysis
    // ═══════════════════════════════════════════════════════
    if (action === 'get_context') {
      const gameId = params.game_id;
      if (!gameId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id required' }) };
      const period = params.period ? parseInt(params.period) : null;

      let rows;
      if (period) {
        rows = await sql`
          SELECT period, context_json, updated_at FROM game_context
          WHERE game_id = ${gameId} AND period = ${period}
        `;
      } else {
        // Return latest context (highest period)
        rows = await sql`
          SELECT period, context_json, updated_at FROM game_context
          WHERE game_id = ${gameId}
          ORDER BY period DESC LIMIT 1
        `;
      }

      if (rows.length === 0) return { statusCode: 200, headers, body: JSON.stringify({ context: null }) };
      const r = rows[0];
      const ctx = typeof r.context_json === 'string' ? JSON.parse(r.context_json) : r.context_json;
      return { statusCode: 200, headers, body: JSON.stringify({ context: ctx, period: r.period, updated_at: r.updated_at }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_QUARTER_DATA — server-authoritative rolling window data
    // ═══════════════════════════════════════════════════════
    if (action === 'get_quarter_data') {
      const gameId = params.game_id;
      if (!gameId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id required' }) };

      try {
        const rows = await sql`SELECT quarter_data FROM games WHERE id = ${gameId}`;
        if (rows.length === 0 || !rows[0].quarter_data) {
          return { statusCode: 200, headers, body: JSON.stringify({ quarter_data: null }) };
        }
        const qd = typeof rows[0].quarter_data === 'string' ? JSON.parse(rows[0].quarter_data) : rows[0].quarter_data;
        return { statusCode: 200, headers, body: JSON.stringify({ quarter_data: qd }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ quarter_data: null, error: e.message }) };
      }
    }

    // ═══════════════════════════════════════════════════════
    // BUILD_SEASON_CACHE — fetch BDL season data and save to DB
    // ═══════════════════════════════════════════════════════
    if (action === 'build_season_cache' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const league = body.league || 'nba';
      const season = body.season || '2025';
      const forceTeams = body.teams || []; // optional: specific team aliases to refresh
      const bdlKey = process.env.BDL_API_KEY;
      if (!bdlKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'BDL_API_KEY not set' }) };

      const BDL = 'https://api.balldontlie.io';
      const bdlPrefix = league === 'ncaamb' ? '/ncaab' : league === 'wnba' ? '/wnba' : '/nba';

      async function bdl(path) {
        const r = await fetch(`${BDL}${path}`, { headers: { 'Authorization': bdlKey } });
        if (!r.ok) return null;
        return await r.json();
      }

      // Step 1: Get ALL teams from BDL (not just today's games)
      const teamsData = await bdl(`${bdlPrefix}/v1/teams`);
      const teamIds = {}; // { 'BOS': 2, ... }
      if (teamsData?.data) {
        for (const t of teamsData.data) {
          if (t.abbreviation && t.id) teamIds[t.abbreviation] = t.id;
        }
      }

      if (Object.keys(teamIds).length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'BDL teams endpoint returned empty' }) };
      }

      // Determine which teams to fetch
      let targetTeams = forceTeams.length > 0 ? forceTeams : Object.keys(teamIds);

      // Check existing cache — skip fresh teams unless forced
      if (forceTeams.length === 0 && targetTeams.length > 0) {
        try {
          const existing = await sql`
            SELECT team_alias, updated_at FROM season_cache
            WHERE league = ${league} AND season = ${season} AND team_alias = ANY(${targetTeams})
          `;
          const freshSet = new Set();
          for (const r of existing) {
            const age = (Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60 * 24);
            if (age < 7) freshSet.add(r.team_alias);
          }
          const before = targetTeams.length;
          targetTeams = targetTeams.filter(t => !freshSet.has(t));
          if (before !== targetTeams.length) {
            // Some teams are fresh, skip them
          }
        } catch (e) { /* table may not exist */ }
      }

      if (targetTeams.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'All teams fresh', teams: 0 }) };
      }

      // Step 2: Fetch season averages per team (batches of 3 in parallel to stay within timeout)
      let saved = 0, failed = 0;
      const results = {};
      const errors = [];

      async function processTeam(abbr) {
        const bdlId = teamIds[abbr];
        if (!bdlId) { failed++; errors.push(abbr + ': no BDL ID'); return; }

        try {
          let players = [];

          if (league === 'nba') {
            const recentGames = await bdl(`/nba/v1/games?team_ids[]=${bdlId}&seasons[]=${season}&per_page=5`);
            if (!recentGames?.data?.length) { failed++; errors.push(abbr + ': no recent games (bdlId=' + bdlId + ')'); return; }
            const gameId = recentGames.data[recentGames.data.length - 1].id;
            const boxScore = await bdl(`/nba/v1/stats?game_ids[]=${gameId}&per_page=50`);
            if (!boxScore?.data?.length) { failed++; errors.push(abbr + ': no box score for game ' + gameId); return; }

            const teamPlayers = boxScore.data.filter(s => {
              const mins = s.min ? parseInt(s.min) : 0;
              return s.player?.id && s.team?.id == bdlId && mins >= 5;
            });

            if (teamPlayers.length === 0) { failed++; errors.push(abbr + ': 0 players matched'); return; }

            const fetches = teamPlayers.map(async (s) => {
              const data = await bdl(`/nba/v1/season_averages?season=${season}&player_id=${s.player.id}`);
              if (data?.data?.length) {
                const avg = data.data[0];
                players.push({
                  player: { id: s.player.id, first_name: s.player.first_name, last_name: s.player.last_name },
                  fg3m: avg.fg3m || 0, fg3a: avg.fg3a || 0,
                  fgm: avg.fgm || 0, fga: avg.fga || 0,
                  pts: avg.pts || 0, reb: avg.reb || 0, ast: avg.ast || 0,
                  stl: avg.stl || 0, blk: avg.blk || 0, turnover: avg.turnover || 0,
                  min: avg.min || '0', games_played: avg.games_played || 0,
                });
              }
            });
            await Promise.all(fetches);
          } else {
            const data = await bdl(`${bdlPrefix}/v1/player_season_stats?season=${season}&team_id=${bdlId}&per_page=100`);
            if (data?.data) players = data.data;
          }

          if (players.length > 0) {
            await sql`
              INSERT INTO season_cache (team_alias, league, season, players_json, player_count, updated_at)
              VALUES (${abbr}, ${league}, ${season}, ${JSON.stringify(players)}, ${players.length}, NOW())
              ON CONFLICT (team_alias, league, season) DO UPDATE SET
                players_json = ${JSON.stringify(players)}, player_count = ${players.length}, updated_at = NOW()
            `;
            results[abbr] = players.length;
            saved++;
          } else { failed++; errors.push(abbr + ': 0 players after fetch'); }
        } catch (e) {
          failed++;
          errors.push(abbr + ': ' + e.message);
        }
      }

      // Process in batches of 3 teams at a time
      for (let i = 0; i < targetTeams.length; i += 3) {
        const batch = targetTeams.slice(i, i + 3);
        await Promise.all(batch.map(processTeam));
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved, failed, teams: results, errors }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_SEASON_CACHE — fetch cached season averages for teams
    // ═══════════════════════════════════════════════════════
    if (action === 'get_season_cache') {
      const league = params.league || 'nba';
      const season = params.season || '2025';
      const teams = params.teams ? params.teams.split(',').filter(Boolean) : [];

      let rows;
      if (teams.length > 0) {
        rows = await sql`
          SELECT team_alias, players_json, player_count, updated_at
          FROM season_cache
          WHERE league = ${league} AND season = ${season} AND team_alias = ANY(${teams})
        `;
      } else {
        rows = await sql`
          SELECT team_alias, players_json, player_count, updated_at
          FROM season_cache
          WHERE league = ${league} AND season = ${season}
        `;
      }
      const cache = {};
      for (const r of rows) {
        cache[r.team_alias] = {
          players: typeof r.players_json === 'string' ? JSON.parse(r.players_json) : r.players_json,
          playerCount: r.player_count,
          updatedAt: r.updated_at,
        };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ cache, count: rows.length }) };
    }

    // ═══════════════════════════════════════════════════════
    // SAVE_SEASON_CACHE — upsert season averages for a team
    // ═══════════════════════════════════════════════════════
    if (action === 'save_season_cache' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const teams = body.teams || [];
      const league = body.league || 'nba';
      const season = body.season || '2025';
      let saved = 0;

      for (const t of teams) {
        if (!t.alias || !t.players) continue;
        await sql`
          INSERT INTO season_cache (team_alias, league, season, players_json, player_count, updated_at)
          VALUES (${t.alias}, ${league}, ${season}, ${JSON.stringify(t.players)}, ${t.players.length}, NOW())
          ON CONFLICT (team_alias, league, season) DO UPDATE SET
            players_json = ${JSON.stringify(t.players)}, player_count = ${t.players.length}, updated_at = NOW()
        `;
        saved++;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved }) };
    }

    // ═══════════════════════════════════════════════════════
    // SNAPSHOT — save periodic game state
    // ═══════════════════════════════════════════════════════
    if (action === 'snapshot' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const s = body;

      // Upsert game row (create if not exists)
      await sql`
        INSERT INTO games (id, date, league, matchup, home_alias, away_alias)
        VALUES (${s.game_id}, ${s.date || null}, ${s.league || 'nba'}, ${s.matchup || null}, ${s.home_alias || null}, ${s.away_alias || null})
        ON CONFLICT (id) DO NOTHING
      `;

      // Insert snapshot
      await sql`
        INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
          floor_score, floor_team, pbp_score, pbp_team, pbp_window_size,
          qtr_score, qtr_team, espn_wp_home, espn_wp_away,
          spread, deficit, trailing_team, lead_sust, gap, accel,
          i1, i2, i3, i4, i5)
        VALUES (${s.game_id}, ${s.period}, ${s.clock}, ${s.home_pts}, ${s.away_pts},
          ${s.floor_score}, ${s.floor_team}, ${s.pbp_score}, ${s.pbp_team}, ${s.pbp_window_size},
          ${s.qtr_score}, ${s.qtr_team}, ${s.espn_wp_home}, ${s.espn_wp_away},
          ${s.spread}, ${s.deficit}, ${s.trailing_team}, ${s.lead_sust}, ${s.gap}, ${s.accel},
          ${s.i1}, ${s.i2}, ${s.i3}, ${s.i4}, ${s.i5})
      `;

      // Piggyback: return server's latest rolling window from quarter_data
      let serverWindow = null;
      try {
        const wRows = await sql`SELECT quarter_data->'window' AS win FROM games WHERE id = ${s.game_id}`;
        if (wRows.length > 0 && wRows[0].win) {
          serverWindow = typeof wRows[0].win === 'string' ? JSON.parse(wRows[0].win) : wRows[0].win;
        }
      } catch (e) { /* quarter_data column may not exist yet */ }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, window: serverWindow }) };
    }

    // ═══════════════════════════════════════════════════════
    // HEARTBEAT — client signals it's actively polling
    // ═══════════════════════════════════════════════════════
    if (action === 'heartbeat' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const league = body.league || 'nba';
      const device = body.device || 'unknown';

      await sql`
        INSERT INTO poll_heartbeats (league, last_poll, device)
        VALUES (${league}, NOW(), ${device})
        ON CONFLICT (league) DO UPDATE SET last_poll = NOW(), device = ${device}
      `;

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // HEARTBEAT_CHECK — server checks if client is active
    if (action === 'heartbeat_check') {
      const league = params.league || 'nba';
      const staleMinutes = parseInt(params.stale_minutes) || 3;

      const rows = await sql`
        SELECT last_poll, device,
          EXTRACT(EPOCH FROM (NOW() - last_poll)) / 60 AS age_minutes
        FROM poll_heartbeats WHERE league = ${league}
      `;

      const hb = rows.length > 0 ? rows[0] : null;
      const clientActive = hb && hb.age_minutes < staleMinutes;

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          clientActive,
          lastPoll: hb?.last_poll || null,
          ageMinutes: hb ? Math.round(hb.age_minutes * 10) / 10 : null,
          device: hb?.device || null,
        }),
      };
    }

    // ═══════════════════════════════════════════════════════
    // FINALIZE — record game outcome
    // ═══════════════════════════════════════════════════════
    if (action === 'finalize' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const g = body;

      await sql`
        UPDATE games SET
          home_pts = ${g.home_pts},
          away_pts = ${g.away_pts},
          winner = ${g.winner},
          margin = ${g.margin},
          spread = ${g.spread},
          home_covered = ${g.home_covered},
          away_covered = ${g.away_covered},
          thesis_team = ${g.thesis_team},
          thesis_correct = ${g.thesis_correct},
          fwp_team = ${g.fwp_team},
          fwp_value = ${g.fwp_value},
          fwp_correct = ${g.fwp_correct},
          conviction = ${g.conviction},
          entry_signal = ${g.entry_signal},
          classification = ${g.classification}
        WHERE id = ${g.game_id}
      `;

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ═══════════════════════════════════════════════════════
    // THESIS — save/get pre-game thesis
    // ═══════════════════════════════════════════════════════
    if (action === 'save_thesis' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      await sql`
        INSERT INTO theses (game_id, league, text)
        VALUES (${body.game_id}, ${body.league || 'nba'}, ${body.text})
        ON CONFLICT (game_id) DO UPDATE SET text = ${body.text}, created_at = NOW()
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ═══════════════════════════════════════════════════════
    // ANALYSIS — save Sonnet analysis snapshot
    // ═══════════════════════════════════════════════════════
    if (action === 'save_analysis' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const a = body;
      await sql`
        INSERT INTO analyses (game_id, period, clock, control_team, control_score,
          fwp, edge, entry, conviction, signal, sustainability, lead_source, raw_text,
          prediction_json, indicators_json, narrative_json, "trigger", home_pts, away_pts,
          conviction_tier, conviction_combo)
        VALUES (${a.game_id}, ${a.period}, ${a.clock}, ${a.control_team}, ${a.control_score},
          ${a.fwp}, ${a.edge}, ${a.entry}, ${a.conviction}, ${a.signal},
          ${a.sustainability}, ${a.lead_source}, ${a.raw_text},
          ${a.prediction_json || null}, ${a.indicators_json || null}, ${a.narrative_json || null},
          ${a.trigger || 'manual'}, ${a.home_pts || null}, ${a.away_pts || null},
          ${a.conviction_tier || null}, ${a.conviction_combo || null})
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ═══════════════════════════════════════════════════════
    // CALIBRATION — aggregate stats for Sonnet prompt
    // ═══════════════════════════════════════════════════════
    if (action === 'calibration') {
      const league = params.league || 'nba';

      // Overall stats from finalized games
      const gameStats = await sql`
        SELECT
          COUNT(*) as total_games,
          COUNT(CASE WHEN thesis_correct = true THEN 1 END) as thesis_correct,
          COUNT(CASE WHEN thesis_team IS NOT NULL THEN 1 END) as thesis_total,
          COUNT(CASE WHEN fwp_correct = true THEN 1 END) as fwp_correct,
          COUNT(CASE WHEN fwp_team IS NOT NULL THEN 1 END) as fwp_total,
          COUNT(CASE WHEN home_covered = true THEN 1 END) + COUNT(CASE WHEN away_covered = true THEN 1 END) as spread_covered,
          COUNT(CASE WHEN spread IS NOT NULL THEN 1 END) * 2 as spread_total
        FROM games
        WHERE league = ${league} AND winner IS NOT NULL
      `;

      // FWP bucket accuracy
      const fwpBuckets = await sql`
        SELECT
          CASE
            WHEN fwp_value >= 80 THEN '80+'
            WHEN fwp_value >= 70 THEN '70-79'
            WHEN fwp_value >= 60 THEN '60-69'
            WHEN fwp_value >= 50 THEN '50-59'
            ELSE 'under50'
          END as bucket,
          COUNT(*) as total,
          COUNT(CASE WHEN fwp_correct = true THEN 1 END) as correct
        FROM games
        WHERE league = ${league} AND fwp_value IS NOT NULL AND winner IS NOT NULL
        GROUP BY bucket
      `;

      // Recent misses
      const recentMisses = await sql`
        SELECT matchup, fwp_value, fwp_team, winner
        FROM games
        WHERE league = ${league} AND fwp_correct = false AND fwp_value >= 55 AND winner IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 5
      `;

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ gameStats: gameStats[0] || {}, fwpBuckets, recentMisses }),
      };
    }

    // ═══════════════════════════════════════════════════════
    // MATCH — find historical snapshots matching current state
    // ═══════════════════════════════════════════════════════
    if (action === 'match') {
      const floor_min = parseFloat(params.floor_min || '0.60');
      const floor_max = parseFloat(params.floor_max || '1.0');
      const period = parseInt(params.period || '0');
      const trailing = params.trailing === 'true';
      const deficit_min = parseInt(params.deficit_min || '0');
      const deficit_max = parseInt(params.deficit_max || '99');
      const league = params.league || 'nba';

      const matches = await sql`
        SELECT
          s.game_id, s.period, s.floor_score, s.floor_team, s.pbp_score, s.pbp_team,
          s.espn_wp_home, s.deficit, s.gap, s.spread,
          g.winner, g.margin, g.home_covered, g.away_covered, g.matchup,
          CASE WHEN s.floor_team = g.winner THEN true ELSE false END as structural_won,
          CASE WHEN s.floor_team = g.home_alias AND g.home_covered = true THEN true
               WHEN s.floor_team = g.away_alias AND g.away_covered = true THEN true
               ELSE false END as structural_covered
        FROM snapshots s
        JOIN games g ON s.game_id = g.id
        WHERE g.league = ${league}
          AND g.winner IS NOT NULL
          AND s.floor_score >= ${floor_min}
          AND s.floor_score <= ${floor_max}
          AND (${period} = 0 OR s.period = ${period})
          AND (${!trailing} OR s.deficit >= ${deficit_min})
          AND s.deficit <= ${deficit_max}
        ORDER BY s.ts DESC
        LIMIT 100
      `;

      // Aggregate
      const total = matches.length;
      const won = matches.filter(m => m.structural_won).length;
      const covered = matches.filter(m => m.structural_covered).length;
      const coveredTotal = matches.filter(m => m.spread !== null).length;
      const pbpAgreed = matches.filter(m => m.pbp_team === m.floor_team);
      const pbpAgreedWon = pbpAgreed.filter(m => m.structural_won).length;
      const pbpDisagreed = matches.filter(m => m.pbp_team !== m.floor_team && m.pbp_team);
      const pbpDisagreedWon = pbpDisagreed.filter(m => m.structural_won).length;

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          total,
          winRate: total > 0 ? (won / total * 100).toFixed(1) : null,
          coverRate: coveredTotal > 0 ? (covered / coveredTotal * 100).toFixed(1) : null,
          pbpAgreedWinRate: pbpAgreed.length > 0 ? (pbpAgreedWon / pbpAgreed.length * 100).toFixed(1) : null,
          pbpAgreedCount: pbpAgreed.length,
          pbpDisagreedWinRate: pbpDisagreed.length > 0 ? (pbpDisagreedWon / pbpDisagreed.length * 100).toFixed(1) : null,
          pbpDisagreedCount: pbpDisagreed.length,
          samples: matches.slice(0, 10).map(m => ({
            matchup: m.matchup, period: m.period,
            floor: m.floor_score, pbp: m.pbp_score,
            deficit: m.deficit, won: m.structural_won, covered: m.structural_covered,
          })),
        }),
      };
    }

    // ═══════════════════════════════════════════════════════
    // HISTORY — get snapshots for a specific game
    // ═══════════════════════════════════════════════════════
    if (action === 'history') {
      const gameId = params.game_id;
      if (!gameId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id required' }) };

      const snapshots = await sql`
        SELECT * FROM snapshots WHERE game_id = ${gameId} ORDER BY ts ASC
      `;

      return { statusCode: 200, headers, body: JSON.stringify({ snapshots }) };
    }

    // ═══════════════════════════════════════════════════════
    // STATS — dashboard-level aggregate stats
    // ═══════════════════════════════════════════════════════
    if (action === 'stats') {
      const league = params.league || 'nba';
      const games = await sql`
        SELECT COUNT(*) as total, COUNT(CASE WHEN winner IS NOT NULL THEN 1 END) as finalized
        FROM games WHERE league = ${league}
      `;
      const snapshots = await sql`
        SELECT COUNT(*) as total FROM snapshots s
        JOIN games g ON s.game_id = g.id WHERE g.league = ${league}
      `;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ games: games[0], snapshots: snapshots[0] }),
      };
    }

    // ═══════════════════════════════════════════════════════
    // GET_THESES — fetch theses for given game IDs or all today
    // ═══════════════════════════════════════════════════════
    if (action === 'get_theses') {
      const gameIds = params.game_ids ? params.game_ids.split(',') : [];
      const date = params.date || null;
      const league = params.league || 'nba';

      let rows;
      if (gameIds.length > 0) {
        rows = await sql`SELECT game_id, text, created_at FROM theses WHERE game_id = ANY(${gameIds})`;
      } else if (date) {
        rows = await sql`
          SELECT t.game_id, t.text, t.created_at FROM theses t
          JOIN games g ON t.game_id = g.id
          WHERE g.date = ${date} AND g.league = ${league}
        `;
      } else {
        rows = await sql`SELECT game_id, text, created_at FROM theses WHERE league = ${league} ORDER BY created_at DESC LIMIT 50`;
      }

      const result = {};
      rows.forEach(r => { result[r.game_id] = r.text; });
      return { statusCode: 200, headers, body: JSON.stringify({ theses: result }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_ANALYSES — fetch latest analysis per game
    // ═══════════════════════════════════════════════════════
    if (action === 'get_analyses') {
      const gameIds = params.game_ids ? params.game_ids.split(',') : [];
      const league = params.league || 'nba';

      let rows;
      if (gameIds.length > 0) {
        rows = await sql`
          SELECT DISTINCT ON (game_id) game_id, ts, period, clock,
            control_team, control_score, fwp, edge, entry, conviction, signal,
            sustainability, lead_source, prediction_json, indicators_json, raw_text, narrative_json,
            "trigger"
          FROM analyses
          WHERE game_id = ANY(${gameIds})
          ORDER BY game_id, ts DESC
        `;
      } else {
        // Return most recent analyses across all games for this league
        rows = await sql`
          SELECT DISTINCT ON (a.game_id) a.game_id, a.ts, a.period, a.clock,
            a.control_team, a.control_score, a.fwp, a.edge, a.entry, a.conviction, a.signal,
            a.sustainability, a.lead_source, a.prediction_json, a.indicators_json, a.raw_text, a.narrative_json,
            a."trigger",
            g.matchup
          FROM analyses a
          LEFT JOIN games g ON a.game_id = g.id
          WHERE (g.league = ${league} OR g.league IS NULL)
          ORDER BY a.game_id, a.ts DESC
          LIMIT 50
        `;
      }

      return { statusCode: 200, headers, body: JSON.stringify({ analyses: rows }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_AUTO_ANALYSES — all auto quarter-boundary analyses for given games
    // Returns ALL auto_q1/q2/q3 analyses (not just latest), sorted chronologically.
    // Client uses this to hydrate analysisHistory + prediction from server-generated analyses.
    // ═══════════════════════════════════════════════════════
    if (action === 'get_auto_analyses') {
      const gameIds = (params.game_ids || '').split(',').filter(Boolean);
      if (gameIds.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_ids required' }) };

      const rows = await sql`
        SELECT game_id, ts, period, clock,
          control_team, control_score, fwp, edge, entry, conviction, signal,
          sustainability, lead_source, prediction_json, indicators_json, raw_text,
          "trigger", home_pts, away_pts, context_layers, prompt_chars,
          conviction_tier, conviction_combo
        FROM analyses
        WHERE game_id = ANY(${gameIds}) AND "trigger" LIKE 'auto_q%'
        ORDER BY game_id, ts ASC
      `;

      // Group by game_id
      const grouped = {};
      for (const r of rows) {
        if (!grouped[r.game_id]) grouped[r.game_id] = [];
        grouped[r.game_id].push(r);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ analyses: grouped, total: rows.length }) };
    }

    // ═══════════════════════════════════════════════════════
    // SAVE_CLUTCH — persist clutch OCR data per team
    // ═══════════════════════════════════════════════════════
    if (action === 'save_clutch' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const teams = body.teams || [];
      for (const t of teams) {
        // Upsert: delete old entry for this team/league, insert fresh
        await sql`DELETE FROM clutch WHERE team_alias = ${t.alias} AND league = ${body.league || 'nba'}`;
        await sql`
          INSERT INTO clutch (team_alias, league, tier, net_rtg, off_rtg, def_rtg, wl, efg, pace, pie, source, data_json)
          VALUES (${t.alias}, ${body.league || 'nba'}, ${t.tier || 3}, ${t.netRtg || null}, ${t.offRtg || null},
            ${t.defRtg || null}, ${t.wl || null}, ${t.efg || null}, ${t.pace || null}, ${t.pie || null},
            ${t.source || 'ocr'}, ${t.data ? JSON.stringify(t.data) : null})
        `;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved: teams.length }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_CLUTCH — fetch clutch data for teams
    // ═══════════════════════════════════════════════════════
    if (action === 'get_clutch') {
      const teams = params.teams ? params.teams.split(',') : [];
      const league = params.league || 'nba';

      let rows;
      if (teams.length > 0) {
        rows = await sql`
          SELECT DISTINCT ON (team_alias) team_alias, tier, net_rtg, off_rtg, def_rtg, wl, efg, pace, pie, source, data_json, created_at
          FROM clutch WHERE team_alias = ANY(${teams}) AND league = ${league}
          ORDER BY team_alias, created_at DESC
        `;
      } else {
        rows = await sql`
          SELECT DISTINCT ON (team_alias) team_alias, tier, net_rtg, off_rtg, def_rtg, wl, efg, pace, pie, source, data_json, created_at
          FROM clutch WHERE league = ${league}
          ORDER BY team_alias, created_at DESC
        `;
      }

      const result = {};
      rows.forEach(r => {
        result[r.team_alias] = {
          tier: r.tier, netRtg: r.net_rtg, offRtg: r.off_rtg, defRtg: r.def_rtg,
          wl: r.wl, efg: r.efg, pace: r.pace, pie: r.pie, source: r.source,
          data: r.data_json, updated: r.created_at,
        };
      });
      return { statusCode: 200, headers, body: JSON.stringify({ clutch: result }) };
    }

    // ═══════════════════════════════════════════════════════
    // SAVE_ODDS — persist odds snapshot for a game
    // ═══════════════════════════════════════════════════════
    if (action === 'save_odds' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      await sql`
        INSERT INTO odds_history (game_id, home_spread, home_ml, away_ml, total, source)
        VALUES (${body.game_id}, ${body.home_spread || null}, ${body.home_ml || null},
          ${body.away_ml || null}, ${body.total || null}, ${body.source || 'bdl'})
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ═══════════════════════════════════════════════════════
    // INVALIDATE_SEASON_CACHE — force refresh on next poll cycle
    // ═══════════════════════════════════════════════════════
    if (action === 'invalidate_season_cache') {
      const league = params.league || 'nba';
      const season = params.season || '2025';
      const team = params.team; // optional — single team, or all if omitted
      let result;
      if (team) {
        result = await sql`UPDATE season_cache SET updated_at = NOW() - INTERVAL '8 days' WHERE league = ${league} AND season = ${season} AND team_alias = ${team}`;
      } else {
        result = await sql`UPDATE season_cache SET updated_at = NOW() - INTERVAL '8 days' WHERE league = ${league} AND season = ${season}`;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, invalidated: team || 'all', league }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_ALERTS — query alert history with game outcomes for accuracy tracking
    // ═══════════════════════════════════════════════════════
    if (action === 'get_alerts') {
      const league = params.league || 'nba';
      const type = params.type || null; // optional: BUY, LEAN BUY, BWC, WINDOW BUY, etc.
      const date = params.date || null; // optional: YYYY-MM-DD
      const limit = parseInt(params.limit) || 100;

      let rows;
      if (type && date) {
        rows = await sql`
          SELECT a.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.margin as game_margin, g.date
          FROM alerts a JOIN games g ON a.game_id = g.id
          WHERE a.league = ${league} AND a.alert_type = ${type} AND g.date = ${date}
          ORDER BY a.ts DESC LIMIT ${limit}`;
      } else if (type) {
        rows = await sql`
          SELECT a.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.margin as game_margin, g.date
          FROM alerts a JOIN games g ON a.game_id = g.id
          WHERE a.league = ${league} AND a.alert_type = ${type}
          ORDER BY a.ts DESC LIMIT ${limit}`;
      } else if (date) {
        rows = await sql`
          SELECT a.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.margin as game_margin, g.date
          FROM alerts a JOIN games g ON a.game_id = g.id
          WHERE a.league = ${league} AND g.date = ${date}
          ORDER BY a.ts DESC LIMIT ${limit}`;
      } else {
        rows = await sql`
          SELECT a.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.margin as game_margin, g.date
          FROM alerts a JOIN games g ON a.game_id = g.id
          WHERE a.league = ${league}
          ORDER BY a.ts DESC LIMIT ${limit}`;
      }

      // Compute accuracy: did the alert's prediction come true?
      // For SENT alerts: BUY/BWC/WB/RP correct = control team WON
      //                  LEAD CRUMBLING/LEAD LOST correct = control team LOST (warning validated)
      // For SUPPRESSED alerts: invert — suppressing a BUY on a losing team IS correct
      // Position gate suppresses (no prior position) excluded from accuracy
      const alerts = rows.map(r => {
        if (!r.winner) return { ...r, correct: null };
        // Exclude procedural suppresses from accuracy tracking
        if (r.agent_decision === 'SUPPRESS' && r.agent_reasoning && r.agent_reasoning.includes('position gate')) {
          return { ...r, correct: null };
        }
        var inverted = r.alert_type === 'LEAD CRUMBLING' || r.alert_type === 'LEAD LOST';
        var ctrlWon = r.winner === r.control_team;
        var signalCorrect = inverted ? !ctrlWon : ctrlWon;
        // For SUPPRESS/DOWNGRADE: correctness inverts — suppressing a bad signal is good
        var wasSuppressed = r.agent_decision === 'SUPPRESS';
        return { ...r, correct: wasSuppressed ? !signalCorrect : signalCorrect };
      });
      const total = alerts.length;
      const resolved = alerts.filter(a => a.correct !== null);
      const correct = resolved.filter(a => a.correct).length;

      return { statusCode: 200, headers, body: JSON.stringify({
        alerts,
        summary: { total, resolved: resolved.length, correct, accuracy: resolved.length > 0 ? Math.round(correct / resolved.length * 100) : null }
      }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_LEARNINGS — query nightly post-game agent findings
    // ═══════════════════════════════════════════════════════
    if (action === 'get_learnings') {
      const limit = parseInt(params.limit || '30');
      const rows = await sql`SELECT * FROM learnings ORDER BY date DESC LIMIT ${limit}`;
      return { statusCode: 200, headers, body: JSON.stringify({ learnings: rows }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_MONITOR_OBSERVATIONS — query monitor agent v2 observations
    // Supports: game_id, date, league filters
    // Used by: debug.html, console scripts, future alert agent wire-up validation
    // ═══════════════════════════════════════════════════════
    if (action === 'get_monitor_observations') {
      const league = params.league || 'nba';
      const gameId = params.game_id || null;
      const date = params.date || null; // YYYY-MM-DD
      const limit = parseInt(params.limit) || 100;
      const latestPerGame = params.latest_per_game ? parseInt(params.latest_per_game) : null;

      let rows;
      if (gameId) {
        // Single game — all observations ordered chronologically
        rows = await sql`
          SELECT mo.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.date
          FROM monitor_observations mo
          JOIN games g ON mo.game_id = g.id
          WHERE mo.game_id = ${gameId} AND mo.league = ${league}
          ORDER BY mo.ts ASC LIMIT ${limit}`;
      } else if (date) {
        // Slate date — all observations for games on that date
        rows = await sql`
          SELECT mo.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.date
          FROM monitor_observations mo
          JOIN games g ON mo.game_id = g.id
          WHERE g.date = ${date} AND mo.league = ${league}
          ORDER BY mo.ts ASC LIMIT ${limit}`;
      } else if (latestPerGame) {
        // Latest N per game — used for alert agent wire-up validation
        rows = await sql`
          SELECT mo.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.date
          FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY ts DESC) as rn
            FROM monitor_observations WHERE league = ${league}
          ) mo
          JOIN games g ON mo.game_id = g.id
          WHERE mo.rn <= ${latestPerGame}
          ORDER BY mo.game_id, mo.ts DESC LIMIT ${limit}`;
      } else {
        // Recent observations (all games, newest first)
        rows = await sql`
          SELECT mo.*, g.matchup, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.winner, g.date
          FROM monitor_observations mo
          JOIN games g ON mo.game_id = g.id
          WHERE mo.league = ${league}
          ORDER BY mo.ts DESC LIMIT ${limit}`;
      }

      // Build summary
      const gameIds = [...new Set(rows.map(r => r.game_id))];
      const timeRange = rows.length > 0
        ? { earliest: rows[0].ts, latest: rows[rows.length - 1].ts }
        : null;

      // Format agent-ready context per game (for wire-up testing)
      const agentContext = {};
      gameIds.forEach(gid => {
        const gameObs = rows.filter(r => r.game_id === gid).sort((a, b) => new Date(b.ts) - new Date(a.ts));
        agentContext[gid] = gameObs.map(o => {
          const momLabel = `${o.momentum_direction || 'STABLE'}`
            + (o.momentum_streak > 0 ? ` (${o.momentum_streak} polls, ${o.momentum_delta >= 0 ? '+' : ''}${Number(o.momentum_delta || 0).toFixed(2)})` : '');
          const sustLabel = `${o.sust_arc || 'STABLE'}${o.sust_arc_detail ? ' (' + o.sust_arc_detail + ')' : ''}`;
          return `Q${o.period} ${o.clock}: MOMENTUM ${momLabel} | OPP SUST: ${sustLabel} | FLOOR-MARGIN: ${o.floor_margin_rel || 'ALIGNED'}`
            + `\n  OBS: ${o.narrative || ''}`
            + `\n  RISK: ${o.risk_factors || ''}`;
        }).join('\n');
      });

      return { statusCode: 200, headers, body: JSON.stringify({
        observations: rows,
        summary: { count: rows.length, games: gameIds.length, gameIds, timeRange },
        agentContext,
      }) };
    }

    // ═══════════════════════════════════════════════════════
    // INDICATOR_COMBOS — recompute new indicators from historical box scores + PBP, measure win rate by combination
    // ═══════════════════════════════════════════════════════
    if (action === 'indicator_combos') {
      const league = params.league || 'nba';

      // Pull from game_pbp (box_score_json + pbp_json) joined with games for outcomes
      const rows = await sql`
        SELECT p.game_id, p.home_alias, p.away_alias, p.box_score_json, p.pbp_json,
               g.matchup, g.winner, g.home_pts, g.away_pts, g.date
        FROM game_pbp p
        JOIN games g ON p.game_id = g.id
        WHERE g.winner IS NOT NULL AND g.league = ${league}
        AND p.box_score_json IS NOT NULL
        ORDER BY g.date DESC
      `;

      const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
      const games = [];
      let parseErrors = 0;

      for (const r of rows) {
        let box, pbp;
        try { box = typeof r.box_score_json === 'string' ? JSON.parse(r.box_score_json) : r.box_score_json; } catch(e) { parseErrors++; continue; }
        try { pbp = r.pbp_json ? (typeof r.pbp_json === 'string' ? JSON.parse(r.pbp_json) : r.pbp_json) : null; } catch(e) { pbp = null; }
        if (!box?.home || !box?.away) { parseErrors++; continue; }

        const h = box.home, a = box.away;
        const hA = r.home_alias, aA = r.away_alias;

        // I1 — Disruption (steals+blocks diff +/-1) + POT (+/-4)
        const hDisrupt = (h.stl||0) + (h.blk||0), aDisrupt = (a.stl||0) + (a.blk||0);
        const i1subA = (hDisrupt - aDisrupt) > 1 ? 1 : (hDisrupt - aDisrupt) < -1 ? -1 : 0;
        const i1subB = (h.pot||0) - (a.pot||0) > 4 ? 1 : (a.pot||0) - (h.pot||0) > 4 ? -1 : 0;
        const i1raw = i1subA + i1subB;
        const I1 = i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0;

        // I2 — Interior (paint +/-6, rim FG% +/-10%)
        const paintDiff = (h.paint||0) - (a.paint||0);
        const i2subA = paintDiff > 6 ? 1 : paintDiff < -6 ? -1 : 0;
        const hRimPct = (h.atRimA||0) >= 6 ? (h.atRimM||0)/(h.atRimA) : null;
        const aRimPct = (a.atRimA||0) >= 6 ? (a.atRimM||0)/(a.atRimA) : null;
        let i2subB = 0;
        if (hRimPct != null && aRimPct != null) {
          if (hRimPct - aRimPct > 0.10) i2subB = 1;
          else if (aRimPct - hRimPct > 0.10) i2subB = -1;
        }
        const I2 = (i2subA + i2subB) > 0 ? 1 : (i2subA + i2subB) < 0 ? 0 : 0.5;

        // I3 — Shot Quality (eFG% +/-2%, assist ratio +/-5%)
        const hFGA = h.fga || 1, aFGA = a.fga || 1;
        const hEFG = ((h.fgm||0) + 0.5*(h.fg3m||0)) / hFGA;
        const aEFG = ((a.fgm||0) + 0.5*(a.fg3m||0)) / aFGA;
        const hAR = ((h.ast||0) / (h.fgm||1)) * 100;
        const aAR = ((a.ast||0) / (a.fgm||1)) * 100;
        const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
                    + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
        const I3 = i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0;

        // I4 — Game Control (biggest_lead +/-4 + Q4 margin from scoreLog)
        const bigLeadDiff = (h.bigLead||0) - (a.bigLead||0);
        const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
        let i4subB = 0;
        const scoreLog = pbp?._bdl?.scoreLog;
        if (scoreLog && scoreLog.length > 0) {
          const q4plays = scoreLog.filter(s => s.q === 4);
          if (q4plays.length > 0) {
            let q4h = 0, q4a = 0;
            q4plays.forEach(s => { if (s.team === hA) q4h += s.pts; else q4a += s.pts; });
            const q4diff = q4h - q4a;
            i4subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
          }
        }
        const I4 = (i4subA + i4subB) > 0 ? 1 : (i4subA + i4subB) === 0 ? 0.5 : 0;

        // I5 — Run share from PBP
        let I5 = 0.5;
        const runs6 = pbp?.runs6;
        if (runs6 && Array.isArray(runs6)) {
          const hRuns = runs6.filter(r2 => r2.team === hA).length;
          const aRuns = runs6.filter(r2 => r2.team === aA).length;
          const total = hRuns + aRuns;
          if (total >= 4) {
            const share = hRuns / total;
            I5 = share > 0.55 ? 1 : share < 0.45 ? 0 : 0.5;
          }
        }

        // Composite
        const composite = I1*W.I1 + I2*W.I2 + I3*W.I3 + I4*W.I4 + I5*W.I5;
        const ctrlHome = composite >= 0.5;
        const ctrlTeam = ctrlHome ? hA : aA;
        const floor = ctrlHome ? composite : 1 - composite;

        const indScores = { I1, I2, I3, I4, I5 };
        const wins = [], loses = [];
        for (const [k, v] of Object.entries(indScores)) {
          const ctrlScore = ctrlHome ? v : 1 - v;
          if (ctrlScore > 0.5) wins.push(k);
          else if (ctrlScore < 0.5) loses.push(k);
        }

        const comboKey = wins.length > 0 ? wins.join('+') : 'NONE';
        const ctrlWon = r.winner === ctrlTeam;

        games.push({
          game_id: r.game_id, matchup: r.matchup, date: r.date,
          floor: Math.round(floor*100)/100, ctrl_team: ctrlTeam, winner: r.winner,
          ctrl_won: ctrlWon, combo: comboKey, ind_won: wins.length,
          i1: Math.round(I1*10)/10, i2: Math.round(I2*10)/10,
          i3: Math.round(I3*10)/10, i4: Math.round(I4*10)/10, i5: Math.round(I5*10)/10,
          wins, loses
        });
      }

      // Group by combo
      const combos = {};
      for (const g of games) {
        if (!combos[g.combo]) combos[g.combo] = { combo: g.combo, total: 0, ctrl_won: 0, games: [] };
        combos[g.combo].total++;
        if (g.ctrl_won) combos[g.combo].ctrl_won++;
        combos[g.combo].games.push({ matchup: g.matchup, date: g.date, floor: g.floor, winner: g.winner, ctrl: g.ctrl_team });
      }
      const comboList = Object.values(combos).map(c => ({
        ...c, win_pct: Math.round(c.ctrl_won / c.total * 100),
        games: c.games.slice(0, 5)
      })).sort((a, b) => b.total - a.total);

      // By count
      const byCount = {};
      for (const g of games) {
        const k = g.ind_won;
        if (!byCount[k]) byCount[k] = { count: k, total: 0, ctrl_won: 0 };
        byCount[k].total++;
        if (g.ctrl_won) byCount[k].ctrl_won++;
      }
      const countList = Object.values(byCount).map(c => ({
        ...c, win_pct: Math.round(c.ctrl_won / c.total * 100)
      })).sort((a, b) => a.count - b.count);

      // Pairwise
      const pairs = {};
      for (const g of games) {
        for (let i = 0; i < g.wins.length; i++) {
          for (let j = i + 1; j < g.wins.length; j++) {
            const pk = g.wins[i] + '+' + g.wins[j];
            if (!pairs[pk]) pairs[pk] = { pair: pk, total: 0, ctrl_won: 0 };
            pairs[pk].total++;
            if (g.ctrl_won) pairs[pk].ctrl_won++;
          }
        }
      }
      const pairList = Object.values(pairs).map(p => ({
        ...p, win_pct: Math.round(p.ctrl_won / p.total * 100)
      })).sort((a, b) => b.win_pct - a.win_pct);

      // Singles
      const singles = {};
      for (const ind of ['I1','I2','I3','I4','I5']) {
        singles[ind] = { ind, won_total: 0, won_ctrl_won: 0, lost_total: 0, lost_ctrl_won: 0 };
      }
      for (const g of games) {
        for (const w of g.wins) { singles[w].won_total++; if (g.ctrl_won) singles[w].won_ctrl_won++; }
        for (const l of g.loses) { singles[l].lost_total++; if (g.ctrl_won) singles[l].lost_ctrl_won++; }
      }
      const singleList = Object.values(singles).map(s => ({
        ...s,
        won_pct: s.won_total > 0 ? Math.round(s.won_ctrl_won / s.won_total * 100) : null,
        lost_pct: s.lost_total > 0 ? Math.round(s.lost_ctrl_won / s.lost_total * 100) : null,
      }));

      return { statusCode: 200, headers, body: JSON.stringify({
        total_games: games.length, parse_errors: parseErrors,
        by_count: countList, by_combo: comboList, by_pair: pairList, by_single: singleList,
        all_games: games
      }) };
    }

    // ═══════════════════════════════════════════════════════
    // PREGAME_RAW_STATS — final snapshot raw_stats_json for calibration
    // Returns per-game final stats (steals, blocks, POT, paint, etc) + outcome
    // ═══════════════════════════════════════════════════════
    if (action === 'pregame_raw_stats') {
      const league = params.league || 'nba';
      try {
        const rows = await sql`
          SELECT g.id, g.date, g.matchup, g.home_alias, g.away_alias,
                 g.home_pts, g.away_pts, g.winner, g.margin,
                 s.raw_stats_json, s.i1, s.i2, s.i3, s.i4, s.i5,
                 s.floor_score, s.floor_team, s.period
          FROM games g
          INNER JOIN LATERAL (
            SELECT * FROM snapshots
            WHERE game_id = g.id AND source = 'server'
              AND raw_stats_json IS NOT NULL AND period >= 3
            ORDER BY ts DESC LIMIT 1
          ) s ON true
          WHERE g.league = ${league} AND g.winner IS NOT NULL
          ORDER BY g.date DESC
        `;
        return { statusCode: 200, headers, body: JSON.stringify({ games: rows, count: rows.length }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: e.message }) };
      }
    }

    // GET_GAMES — list all games for a league
    // ═══════════════════════════════════════════════════════
    if (action === 'get_games') {
      const league = params.league || 'nba';
      const rows = await sql`
        SELECT id, date, league, matchup, home_alias, away_alias, home_pts, away_pts, winner, margin
        FROM games WHERE league = ${league}
        ORDER BY date DESC, matchup ASC
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ games: rows }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_POLL_STATE — check server polling state for a league
    // ═══════════════════════════════════════════════════════
    if (action === 'get_poll_state') {
      const league = params.league || 'nba';
      try {
        const rows = await sql`
          SELECT league, date, first_tip, last_tip, game_count, all_final, schedule_json, fetched_at
          FROM poll_state WHERE league = ${league}
          ORDER BY date DESC LIMIT 1
        `;
        return { statusCode: 200, headers, body: JSON.stringify({ state: rows.length > 0 ? rows[0] : null }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ state: null, error: 'poll_state table may not exist: ' + e.message }) };
      }
    }

    // ═══════════════════════════════════════════════════════
    // GET_POLL_HISTORY — all poll_state rows for a league (last N days)
    // ═══════════════════════════════════════════════════════
    if (action === 'get_poll_history') {
      const league = params.league || 'nba';
      const limit = parseInt(params.limit) || 14;
      try {
        const rows = await sql`
          SELECT league, date, first_tip, last_tip, game_count, all_final, fetched_at
          FROM poll_state WHERE league = ${league}
          ORDER BY date DESC LIMIT ${limit}
        `;
        return { statusCode: 200, headers, body: JSON.stringify({ history: rows }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ history: [], error: e.message }) };
      }
    }

    // ═══════════════════════════════════════════════════════
    // GET_CALIBRATION — aggregate game outcomes vs framework predictions
    // ═══════════════════════════════════════════════════════
    if (action === 'get_calibration') {
      const league = params.league || 'nba';
      try {
        // Get all finalized games with their final snapshot + latest analysis
        const rows = await sql`
          SELECT
            g.id, g.date, g.matchup, g.home_alias, g.away_alias,
            g.home_pts, g.away_pts, g.winner, g.margin,
            s.floor_score, s.floor_team, s.lead_sust, s.lead_class,
            s.i1, s.i2, s.i3, s.i4, s.i5, s.espn_wp_home, s.spread,
            s.period, s.sust_json,
            a.control_team AS a_control, a.control_score AS a_score,
            a.fwp AS a_fwp, a.edge AS a_edge, a.entry AS a_entry,
            a.conviction AS a_conviction, a.signal AS a_signal,
            a.sustainability AS a_sust, a.prediction_json AS a_pred,
            o.home_spread AS final_spread, o.home_ml, o.away_ml
          FROM games g
          LEFT JOIN LATERAL (
            SELECT * FROM snapshots
            WHERE game_id = g.id
            ORDER BY ts DESC LIMIT 1
          ) s ON true
          LEFT JOIN LATERAL (
            SELECT * FROM analyses
            WHERE game_id = g.id
            ORDER BY ts DESC LIMIT 1
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT * FROM odds_history
            WHERE game_id = g.id
            ORDER BY ts DESC LIMIT 1
          ) o ON true
          WHERE g.league = ${league} AND g.winner IS NOT NULL
          ORDER BY g.date DESC
        `;
        return { statusCode: 200, headers, body: JSON.stringify({ games: rows, count: rows.length }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: e.message }) };
      }
    }

    // ═══════════════════════════════════════════════════════
    // GET_CALIBRATION_Q3 — quarter-end calibration snapshots vs outcomes
    // Accepts ?quarter=1|2|3 (default 3 for gold standard Q3-end).
    // Joins calibration-tagged snapshots + auto analyses with final results.
    // Unlike get_calibration (which uses last snapshot, skewed toward decided games),
    // this uses quarter-boundary snapshots when the game is still contested.
    // ═══════════════════════════════════════════════════════
    if (action === 'get_calibration_q3') {
      const league = params.league || 'nba';
      const quarter = parseInt(params.quarter) || 3;
      const sourceTag = `calibration_q${quarter}`;
      const triggerTag = `auto_q${quarter}`;
      const qLabel = `Q${quarter}`;
      try {
        const rows = await sql`
          SELECT
            g.id, g.date, g.matchup, g.home_alias, g.away_alias,
            g.home_pts, g.away_pts, g.winner, g.margin,
            g.thesis_team, g.thesis_correct,
            -- Quarter-end calibration snapshot
            s.floor_score AS q3_floor, s.floor_team AS q3_floor_team,
            s.i1 AS q3_i1, s.i2 AS q3_i2, s.i3 AS q3_i3, s.i4 AS q3_i4, s.i5 AS q3_i5,
            s.espn_wp_home AS q3_wp_home, s.espn_wp_away AS q3_wp_away,
            s.spread AS q3_spread, s.deficit AS q3_deficit, s.trailing_team AS q3_trailing,
            s.lead_sust AS q3_lead_sust, s.lead_class AS q3_lead_class,
            s.home_pts AS q3_home_pts, s.away_pts AS q3_away_pts,
            s.period AS q3_period, s.clock AS q3_clock, s.ts AS q3_ts,
            s.sust_json AS q3_sust_json,
            s.tp_class AS q3_tp_class, s.tp_exp_swing AS q3_tp_exp_swing,
            s.tp_remain_poss AS q3_tp_remain_poss,
            s.ls_class AS q3_ls_class, s.ls_exp_swing AS q3_ls_exp_swing,
            -- Quarter-end Sonnet analysis
            a.control_team AS q3a_control, a.control_score AS q3a_score,
            a.fwp AS q3a_fwp, a.edge AS q3a_edge, a.entry AS q3a_entry,
            a.conviction AS q3a_conviction, a.signal AS q3a_signal,
            a.sustainability AS q3a_sust, a.lead_source AS q3a_lead_source,
            a.prediction_json AS q3a_pred,
            -- Latest odds near snapshot time
            o.home_spread AS q3_final_spread, o.home_ml AS q3_home_ml, o.away_ml AS q3_away_ml
          FROM games g
          INNER JOIN LATERAL (
            SELECT * FROM snapshots
            WHERE game_id = g.id AND source = ${sourceTag}
            ORDER BY ts DESC LIMIT 1
          ) s ON true
          LEFT JOIN LATERAL (
            SELECT * FROM analyses
            WHERE game_id = g.id AND "trigger" = ${triggerTag}
            ORDER BY ts DESC LIMIT 1
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT * FROM odds_history
            WHERE game_id = g.id AND ts <= s.ts + INTERVAL '5 minutes'
            ORDER BY ts DESC LIMIT 1
          ) o ON true
          WHERE g.league = ${league} AND g.winner IS NOT NULL
          ORDER BY g.date DESC
        `;

        // Compute derived calibration metrics
        const metrics = {
          total: rows.length,
          floorCorrect: 0, floorTotal: 0,
          fwpBuckets: { '50-59': { correct: 0, total: 0 }, '60-69': { correct: 0, total: 0 }, '70-79': { correct: 0, total: 0 }, '80+': { correct: 0, total: 0 } },
          analysisCount: 0,
          signalBuy: { correct: 0, total: 0 },
          signalPass: { correct: 0, total: 0 },
          sustHeld: 0, sustTotal: 0,
          wpCalibration: [],
        };

        for (const r of rows) {
          // Floor score → winner
          if (r.q3_floor_team) {
            metrics.floorTotal++;
            if (r.q3_floor_team === r.winner) metrics.floorCorrect++;
          }

          // FWP from auto_q3 analysis → winner
          if (r.q3a_pred) {
            const pred = typeof r.q3a_pred === 'string' ? JSON.parse(r.q3a_pred) : r.q3a_pred;
            const homeFwp = pred?.homeValue?.fwp || 0;
            const awayFwp = pred?.awayValue?.fwp || 0;
            const fwpTeam = homeFwp >= awayFwp ? r.home_alias : r.away_alias;
            const fwpVal = Math.max(homeFwp, awayFwp);
            const fwpCorrect = fwpTeam === r.winner;
            metrics.analysisCount++;

            const bucket = fwpVal >= 80 ? '80+' : fwpVal >= 70 ? '70-79' : fwpVal >= 60 ? '60-69' : '50-59';
            metrics.fwpBuckets[bucket].total++;
            if (fwpCorrect) metrics.fwpBuckets[bucket].correct++;

            // WP calibration point
            metrics.wpCalibration.push({ predicted: fwpVal, actual: fwpCorrect ? 1 : 0 });
          }

          // Signal accuracy
          if (r.q3a_signal) {
            const buyMatch = r.q3a_signal.match(/BUY\s+(\w+)/);
            if (buyMatch) {
              metrics.signalBuy.total++;
              if (buyMatch[1] === r.winner) metrics.signalBuy.correct++;
            } else if (r.q3a_signal.includes('PASS') || r.q3a_signal.includes('NO VALUE')) {
              metrics.signalPass.total++;
              // PASS is "correct" if the game was close (margin <= 5) — debatable, track both
              if (r.margin <= 5) metrics.signalPass.correct++;
            }
          }

          // Sustainability tier at Q3 → held through to outcome
          if (r.q3_lead_sust && r.q3_floor_team) {
            metrics.sustTotal++;
            const sustainableTiers = ['LOCKED IN', 'DURABLE'];
            const wasSustainable = sustainableTiers.includes(r.q3_lead_sust);
            const leadHeld = r.q3_floor_team === r.winner;
            if (wasSustainable && leadHeld) metrics.sustHeld++;
            else if (!wasSustainable && !leadHeld) metrics.sustHeld++;
          }
        }

        return { statusCode: 200, headers, body: JSON.stringify({ games: rows, count: rows.length, metrics, quarter, label: qLabel }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ games: [], count: 0, metrics: null, quarter, label: `Q${quarter}`, error: e.message }) };
      }
    }

    // ═══════════════════════════════════════════════════════
    // GET_ODDS — fetch odds history for a game
    // ═══════════════════════════════════════════════════════
    if (action === 'get_odds') {
      const gameId = params.game_id;
      if (!gameId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id required' }) };

      const rows = await sql`
        SELECT ts, home_spread, home_ml, away_ml, total, source
        FROM odds_history WHERE game_id = ${gameId}
        ORDER BY ts ASC
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ odds: rows }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_LATEST_SNAPSHOTS — latest snapshot per game (batch)
    // Used by confidence table to show floor/window/gap for unmounted games
    // ═══════════════════════════════════════════════════════
    if (action === 'get_latest_snapshots') {
      const gameIds = (params.game_ids || '').split(',').filter(Boolean);
      if (gameIds.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_ids required' }) };

      // Get latest snapshot per game using DISTINCT ON
      const rows = await sql`
        SELECT DISTINCT ON (game_id) game_id, ts, period, clock, home_pts, away_pts,
          floor_score, floor_team, espn_wp_home, espn_wp_away,
          spread, deficit, trailing_team, lead_sust, lead_class,
          i1, i2, i3, i4, i5, source, sust_json,
          tp_class, tp_exp_swing, tp_remain_poss, ls_class, ls_exp_swing
        FROM snapshots
        WHERE game_id = ANY(${gameIds})
        ORDER BY game_id, ts DESC
      `;
      // Also fetch latest odds per game
      const oddsRows = await sql`
        SELECT DISTINCT ON (game_id) game_id, home_spread, home_ml, away_ml, total
        FROM odds_history
        WHERE game_id = ANY(${gameIds})
        ORDER BY game_id, ts DESC
      `;
      const oddsMap = {};
      for (const o of oddsRows) { oddsMap[o.game_id] = o; }

      const result = {};
      for (const r of rows) {
        result[r.game_id] = {
          ...r,
          odds: oddsMap[r.game_id] || null,
        };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ snapshots: result }) };
    }

    // ═══════════════════════════════════════════════════════
    // SAVE_WP_PROFILE — persist team WP curve profile
    // ═══════════════════════════════════════════════════════
    if (action === 'save_wp_profile' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const profiles = body.profiles || [];
      const league = body.league || 'nba';
      const season = body.season || '2025-26';
      let saved = 0;
      for (const p of profiles) {
        if (!p.team_alias) continue;
        await sql`
          INSERT INTO wp_profiles (team_alias, league, season, games_analyzed, profile_json, updated_at)
          VALUES (${p.team_alias}, ${league}, ${season}, ${p.games_analyzed || 0}, ${JSON.stringify(p.profile)}, NOW())
          ON CONFLICT (team_alias, league, season)
          DO UPDATE SET games_analyzed = ${p.games_analyzed || 0}, profile_json = ${JSON.stringify(p.profile)}, updated_at = NOW()
        `;
        saved++;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved }) };
    }

    // ═══════════════════════════════════════════════════════
    // GET_WP_PROFILES — retrieve team WP profiles
    // ═══════════════════════════════════════════════════════
    if (action === 'get_wp_profiles') {
      const league = params.league || 'nba';
      const season = params.season || '2025-26';
      const teams = params.teams ? params.teams.split(',') : null;

      let rows;
      if (teams && teams.length > 0) {
        rows = await sql`
          SELECT team_alias, games_analyzed, profile_json, updated_at
          FROM wp_profiles
          WHERE league = ${league} AND season = ${season} AND team_alias = ANY(${teams})
        `;
      } else {
        rows = await sql`
          SELECT team_alias, games_analyzed, profile_json, updated_at
          FROM wp_profiles
          WHERE league = ${league} AND season = ${season}
          ORDER BY team_alias
        `;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ profiles: rows }) };
    }

    // ═══════════════════════════════════════════════════════
    // SIM_STABILITY — per-quarter indicator stability from DB
    // ═══════════════════════════════════════════════════════
    if (action === 'sim_stability') {
      const league = params.league || 'nba';

      const games = await sql`
        SELECT g.id, g.home_alias, g.away_alias, g.home_pts, g.away_pts, g.date,
               p.pbp_json
        FROM games g
        JOIN game_pbp p ON p.game_id = g.id
        WHERE g.league = ${league} AND g.home_pts IS NOT NULL AND g.home_pts > 0
        ORDER BY g.date DESC LIMIT 300
      `;

      const results = [];
      for (const g of games) {
        const hA = g.home_alias, aA = g.away_alias;
        const winner = g.home_pts > g.away_pts ? hA : aA;
        let pbp;
        try { pbp = typeof g.pbp_json === 'string' ? JSON.parse(g.pbp_json) : g.pbp_json; } catch(e) { continue; }
        if (!pbp?._bdl?.scoreLog || pbp._bdl.scoreLog.length < 10) continue;

        const scoreLog = pbp._bdl.scoreLog;
        const pq = pbp.perQuarter || {};

        // Compute indicators at end of each quarter cutoff
        function computeAt(maxQ) {
          // I4: biggest_lead through maxQ from scoreLog
          let bigH = 0, bigA = 0;
          for (const s of scoreLog) {
            if (s.q > maxQ) break;
            const mg = (s.hScore || 0) - (s.aScore || 0);
            if (mg > bigH) bigH = mg;
            if (-mg > bigA) bigA = -mg;
          }
          const blDiff = bigH - bigA;
          const i4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
          let i4subB = 0;
          if (maxQ >= 4) {
            const q4scores = scoreLog.filter(s => s.q === maxQ);
            let lastQH = 0, lastQA = 0;
            q4scores.forEach(s => { if (s.team === hA) lastQH += s.pts; else lastQA += s.pts; });
            const lqd = lastQH - lastQA;
            i4subB = lqd > 2 ? 1 : lqd < -2 ? -1 : 0;
          }
          const I4 = (i4subA + i4subB) > 0 ? 1 : (i4subA + i4subB) === 0 ? 0.5 : 0;

          // I5: runs through maxQ
          const sl = scoreLog.filter(s => s.q <= maxQ);
          const runs6 = [];
          let rTm = null, rPts = 0;
          for (let i = 0; i < sl.length; i++) {
            const s = sl[i];
            if (s.team === rTm) { rPts += s.pts; }
            else { if (rPts >= 6 && rTm) runs6.push({ team: rTm }); rTm = s.team; rPts = s.pts; }
          }
          if (rPts >= 6 && rTm) runs6.push({ team: rTm });
          const hRuns = runs6.filter(r => r.team === hA).length;
          const aRuns = runs6.filter(r => r.team === aA).length;
          const totalRuns = hRuns + aRuns;
          let I5 = 0.5;
          if (totalRuns >= 4) {
            const rs = hRuns / totalRuns;
            I5 = rs > 0.55 ? 1 : rs < 0.45 ? 0 : 0.5;
          }

          // I1, I2, I3 from cumulative perQuarter (sum Q1..maxQ)
          let hStl=0, aStl=0, hPaint=0, aPaint=0, hAR=0, aAR=0, qCount=0;
          for (let q = 1; q <= maxQ; q++) {
            if (!pq[q]) continue;
            hStl += pq[q].home?.steals || 0;
            aStl += pq[q].away?.steals || 0;
            hPaint += pq[q].home?.points_in_the_paint || 0;
            aPaint += pq[q].away?.points_in_the_paint || 0;
            hAR += pq[q].home?.assist_ratio || 0;
            aAR += pq[q].away?.assist_ratio || 0;
            qCount++;
          }
          // I1: disruption (steals only from perQuarter — blocks not tracked)
          const stlDiff = hStl - aStl;
          const I1 = stlDiff > 1 ? 1 : stlDiff < -1 ? 0 : 0.5;

          // I2: paint
          const paintDiff = hPaint - aPaint;
          const I2 = paintDiff > 6 ? 1 : paintDiff < -6 ? 0 : 0.5;

          // I3: assist ratio (averaged over quarters — eFG% not available per-quarter)
          const avgHAR = qCount > 0 ? hAR / qCount : 50;
          const avgAAR = qCount > 0 ? aAR / qCount : 50;
          const I3 = avgHAR > avgAAR + 5 ? 1 : avgHAR < avgAAR - 5 ? 0 : 0.5;

          // Composite
          const raw = I1*0.10 + I2*0.15 + I3*0.20 + I4*0.30 + I5*0.25;
          const ctrlHome = raw >= 0.5;
          const ctrlTeam = raw === 0.5 ? 'EVEN' : ctrlHome ? hA : aA;

          return { I1, I2, I3, I4, I5, ctrlTeam, bigH, bigA, hRuns, aRuns, totalRuns };
        }

        results.push({
          id: g.id, date: g.date, matchup: aA+'@'+hA, winner,
          atQ1: computeAt(1), atQ2: computeAt(2), atQ3: computeAt(3), atFinal: computeAt(10),
        });
      }

      // Compute stability metrics
      function stabilityRow(qKey, indKey) {
        let matchWinner=0, holdsFinal=0, decisive=0, even=0;
        for (const r of results) {
          const qv = r[qKey][indKey], fv = r.atFinal[indKey];
          if (qv === 0.5) { even++; continue; }
          decisive++;
          if (qv === fv) holdsFinal++;
          const qWin = qv > 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
          if (qWin === r.winner) matchWinner++;
        }
        return { predicts_winner: decisive > 0 ? +(matchWinner/decisive*100).toFixed(1) : null, holds_to_final: decisive > 0 ? +(holdsFinal/decisive*100).toFixed(1) : null, decisive, even };
      }

      const stability = {};
      ['I1','I2','I3','I4','I5'].forEach(ind => {
        stability[ind] = { Q1: stabilityRow('atQ1',ind), Q2: stabilityRow('atQ2',ind), Q3: stabilityRow('atQ3',ind) };
      });

      // Composite accuracy by quarter
      const composite = {};
      ['atQ1','atQ2','atQ3','atFinal'].forEach(qKey => {
        let correct=0, total=0;
        for (const r of results) { const c = r[qKey].ctrlTeam; if (c==='EVEN') continue; total++; if (c===r.winner) correct++; }
        composite[qKey.replace('at','')] = { accuracy: total > 0 ? +(correct/total*100).toFixed(1) : null, correct, total };
      });

      // I4 combo by quarter
      const i4combo = {};
      ['atQ1','atQ2','atQ3','atFinal'].forEach(qKey => {
        let correct=0, agree=0;
        for (const r of results) {
          const i4 = r[qKey].I4;
          if (i4 === 0.5) continue;
          const i4Win = i4 > 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
          const anyAgree = ['I1','I2','I3','I5'].some(ind => { const v = r[qKey][ind]; if (v===0.5) return false; const w = v > 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0]; return w === i4Win; });
          if (!anyAgree) continue;
          agree++;
          if (i4Win === r.winner) correct++;
        }
        i4combo[qKey.replace('at','')] = { accuracy: agree > 0 ? +(correct/agree*100).toFixed(1) : null, games: agree };
      });

      // Flip rates Q2 → final
      const flips = {};
      ['I1','I2','I3','I4','I5'].forEach(ind => {
        let holds=0, fl=0, q2even=0;
        for (const r of results) { const q2=r.atQ2[ind], fin=r.atFinal[ind]; if(q2===0.5){q2even++;continue;} if(fin===0.5){continue;} if(q2===fin)holds++;else fl++; }
        flips[ind] = { holds, flips: fl, flip_rate: (holds+fl)>0 ? +(fl/(holds+fl)*100).toFixed(1) : null, q2_even: q2even };
      });

      return { statusCode: 200, headers, body: JSON.stringify({ gamesAnalyzed: results.length, stability, composite, i4combo, flips }) };
    }

    // ═══════════════════════════════════════════════════════
    // SIM_INDICATORS — bulk re-sim with new indicator formulas
    // ═══════════════════════════════════════════════════════
    if (action === 'sim_indicators') {
      const league = params.league || 'nba';

      // 1. All finished games with scores
      const games = await sql`
        SELECT id, home_alias, away_alias, home_pts, away_pts, winner, margin, date
        FROM games WHERE league = ${league} AND home_pts IS NOT NULL AND away_pts IS NOT NULL
        AND home_pts > 0 AND away_pts > 0
        ORDER BY date DESC
      `;

      // 2. Latest Q3+ snapshot per game with raw_stats_json
      const snaps = await sql`
        SELECT DISTINCT ON (game_id) game_id, period, clock, home_pts, away_pts,
          floor_score, floor_team, i1, i2, i3, i4, i5, raw_stats_json
        FROM snapshots
        WHERE period >= 3 AND raw_stats_json IS NOT NULL
        ORDER BY game_id, period DESC, clock ASC
      `;
      const snapMap = {};
      snaps.forEach(s => { snapMap[s.game_id] = s; });

      // 3. PBP data for runs + biggest_lead
      const pbps = await sql`
        SELECT game_id, home_alias, away_alias, pbp_json
        FROM game_pbp WHERE league = ${league}
      `;
      const pbpMap = {};
      pbps.forEach(p => {
        try {
          const j = typeof p.pbp_json === 'string' ? JSON.parse(p.pbp_json) : p.pbp_json;
          pbpMap[p.game_id] = j;
        } catch(e) {}
      });

      // 4. Compute indicators per game
      const results = [];
      for (const g of games) {
        const snap = snapMap[g.id];
        if (!snap || !snap.raw_stats_json) continue;

        const raw = typeof snap.raw_stats_json === 'string' ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
        const h = raw.home || {}, a = raw.away || {};
        const hA = g.home_alias, aA = g.away_alias;
        const winner = g.winner || (g.home_pts > g.away_pts ? hA : aA);

        // PBP data
        const pbp = pbpMap[g.id];
        let hBigLead = h.bigLead || 0, aBigLead = a.bigLead || 0;
        let hRuns = 0, aRuns = 0, totalRuns = 0;
        let hRuns6 = 0, aRuns6 = 0, totalRuns6 = 0;

        if (pbp) {
          // Override biggest_lead from PBP if available
          const bdl = pbp._bdl || pbp;
          if (bdl.biggestLeadHome != null) hBigLead = bdl.biggestLeadHome;
          if (bdl.biggestLeadAway != null) aBigLead = bdl.biggestLeadAway;

          // Runs at 8+ threshold (stored)
          if (pbp.runs) {
            pbp.runs.forEach(r => {
              if (r.team === hA) hRuns++;
              else if (r.team === aA) aRuns++;
            });
            totalRuns = hRuns + aRuns;
          }

          // Recompute runs at 6+ threshold from scoreLog
          const sLog = bdl.scoreLog || pbp.scoreLog || [];
          if (sLog.length > 0) {
            let rTm = null, rPts = 0;
            for (let i = 0; i < sLog.length; i++) {
              const s = sLog[i];
              if (s.team === rTm) { rPts += s.pts; }
              else {
                if (rPts >= 6 && rTm) { if (rTm === hA) hRuns6++; else aRuns6++; }
                rTm = s.team; rPts = s.pts;
              }
            }
            if (rPts >= 6 && rTm) { if (rTm === hA) hRuns6++; else aRuns6++; }
            totalRuns6 = hRuns6 + aRuns6;
          }
        }

        // --- OLD INDICATORS ---
        // I1 old: gen + conv
        const hGen = (h.stl||0) + (h.oreb||0) - (h.to||0);
        const aGen = (a.stl||0) + (a.oreb||0) - (a.to||0);
        const hConv = (h.fbp||0) + (h.pot||0) + (h.scp||0);
        const aConv = (a.fbp||0) + (a.pot||0) + (a.scp||0);
        let i1old = (hGen > aGen ? 1 : hGen < aGen ? -1 : 0) + (hConv > aConv ? 1 : hConv < aConv ? -1 : 0);
        const oldI1 = i1old > 0 ? 1 : i1old === 0 ? 0.5 : 0;

        // I4 old: biggest_lead + trend + bench (using raw_stats bigLead which may be 0)
        const qDs = [];
        // approximate from snapshot period data — not available in raw_stats
        // Use score diff as proxy (matches old BDL compute path)
        const scoreDiff = Math.abs((snap.home_pts||0) - (snap.away_pts||0));
        let i4old_raw = (scoreDiff > 8 && (snap.home_pts||0) > (snap.away_pts||0) ? 1 : scoreDiff > 8 ? -1 : 0);
        const oldI4 = i4old_raw > 0 ? 1 : i4old_raw === 0 ? 0.5 : 0;

        // I5 old: effD
        const hOPPP = h.oppp || 0, aOPPP = a.oppp || 0;
        const hDPPP = h.dppp || 0, aDPPP = a.dppp || 0;
        const effD = (hOPPP - aDPPP) - (aOPPP - hDPPP);
        const oldI5 = effD > 0.08 ? 1 : effD < -0.08 ? 0 : 0.5;

        // --- NEW INDICATORS ---
        // I1 new: disruption(stl+blk) + POT
        const disruptDiff = (h.stl||0) + (h.blk||0) - (a.stl||0) - (a.blk||0);
        const i1subA = disruptDiff > 1 ? 1 : disruptDiff < -1 ? -1 : 0;
        const potDiff = (h.pot||0) - (a.pot||0);
        const i1subB = potDiff > 4 ? 1 : potDiff < -4 ? -1 : 0;
        const i1new_raw = i1subA + i1subB;
        const newI1 = i1new_raw > 0 ? 1 : i1new_raw === 0 ? 0.5 : 0;

        // I2 new (already shipped): paint ±6, rimFG% ±10%
        const paintDiff = (h.paint||0) - (a.paint||0);
        const i2subA = paintDiff > 6 ? 1 : paintDiff < -6 ? -1 : 0;
        let i2subB = 0;
        const hRimA = h.atRimA || h.paintA || 0, aRimA = a.atRimA || a.paintA || 0;
        const hRimM = h.atRimM || h.paintM || 0, aRimM = a.atRimM || a.paintM || 0;
        if (hRimA >= 6 && aRimA >= 6) {
          const hRimPct = hRimM / hRimA * 100, aRimPct = aRimM / aRimA * 100;
          i2subB = (hRimPct - aRimPct) > 10 ? 1 : (hRimPct - aRimPct) < -10 ? -1 : 0;
        }
        const newI2 = (i2subA + i2subB) > 0 ? 1 : (i2subA + i2subB) === 0 ? 0.5 : 0;

        // I3: unchanged — use stored snapshot value
        const I3 = snap.i3 != null ? snap.i3 : 0.5;

        // I4 new: biggestLead ±4 + lastQ ±2
        const bigLeadDiff = hBigLead - aBigLead;
        const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
        // For sim, use final margin as lastQ proxy (Q4 already played)
        const finalMargin = (g.home_pts || 0) - (g.away_pts || 0);
        // Actually use Q4 diff = final - Q3 score
        const q4hPts = (g.home_pts || 0) - (snap.home_pts || 0);
        const q4aPts = (g.away_pts || 0) - (snap.away_pts || 0);
        const lastQDiff = q4hPts - q4aPts;
        const i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
        const newI4 = (i4subA + i4subB) > 0 ? 1 : (i4subA + i4subB) === 0 ? 0.5 : 0;

        // I4 variant: biggestLead only (no sub-B)
        const newI4blOnly = i4subA > 0 ? 1 : i4subA === 0 ? 0.5 : 0;

        // I5 new: runShare (6+ pts threshold)
        let newI5 = 0.5;
        if (totalRuns6 >= 4) {
          const runShare = hRuns6 / totalRuns6;
          newI5 = runShare > 0.60 ? 1 : runShare < 0.40 ? 0 : 0.5;
        }
        // I5 variant: 8+ threshold
        let newI5_8 = 0.5;
        if (totalRuns >= 4) {
          const runShare8 = hRuns / totalRuns;
          newI5_8 = runShare8 > 0.60 ? 1 : runShare8 < 0.40 ? 0 : 0.5;
        }

        // Determine who each indicator says wins (home-relative: >0.5=home, <0.5=away)
        function indWinner(score, hAlias, aAlias) {
          return score > 0.5 ? hAlias : score < 0.5 ? aAlias : 'EVEN';
        }

        results.push({
          id: g.id, date: g.date, matchup: hA + ' vs ' + aA, winner,
          home_pts: g.home_pts, away_pts: g.away_pts,
          hBigLead, aBigLead, hRuns6, aRuns6, totalRuns6, hRuns, aRuns, totalRuns,
          // Old
          oldI1, oldI2: snap.i2 != null ? snap.i2 : 0.5, I3,
          oldI4, oldI5,
          // New
          newI1, newI2, newI4, newI4blOnly, newI5, newI5_8,
          // Sub-scores for debugging
          disruptDiff, potDiff, bigLeadDiff, lastQDiff, paintDiff, effD,
        });
      }

      // 5. Test weight distributions
      const weightSets = [
        { name: 'OLD 25/25/20/20/10', w: [0.25, 0.25, 0.20, 0.20, 0.10] },
        { name: 'NEW 15/20/20/20/25', w: [0.15, 0.20, 0.20, 0.20, 0.25] },
        { name: 'EQUAL 20/20/20/20/20', w: [0.20, 0.20, 0.20, 0.20, 0.20] },
        { name: 'I4-HEAVY 15/20/20/25/20', w: [0.15, 0.20, 0.20, 0.25, 0.20] },
        { name: 'I4-MAX 10/20/20/25/25', w: [0.10, 0.20, 0.20, 0.25, 0.25] },
        { name: 'I5-HEAVY 15/20/20/15/30', w: [0.15, 0.20, 0.20, 0.15, 0.30] },
        { name: 'I34-HEAVY 15/15/25/25/20', w: [0.15, 0.15, 0.25, 0.25, 0.20] },
        { name: 'I345 10/15/25/25/25', w: [0.10, 0.15, 0.25, 0.25, 0.25] },
      ];

      const simResults = [];
      for (const ws of weightSets) {
        let correct = 0, total = 0, decisive = 0;
        for (const r of results) {
          const raw = r.newI1 * ws.w[0] + r.newI2 * ws.w[1] + r.I3 * ws.w[2] + r.newI4 * ws.w[3] + r.newI5 * ws.w[4];
          const ctrlHome = raw >= 0.5;
          const ctrlTeam = ctrlHome ? r.matchup.split(' vs ')[0] : r.matchup.split(' vs ')[1];
          if (ctrlTeam !== 'EVEN') {
            total++;
            if (raw !== 0.5) decisive++;
            if (ctrlTeam === r.winner) correct++;
          }
        }
        simResults.push({ name: ws.name, accuracy: total > 0 ? (correct / total * 100).toFixed(1) : 'N/A', correct, total, decisive });
      }

      // Also test old weights with old indicators
      {
        let correct = 0, total = 0;
        for (const r of results) {
          const raw = r.oldI1 * 0.25 + r.oldI2 * 0.25 + r.I3 * 0.20 + r.oldI4 * 0.20 + r.oldI5 * 0.10;
          const ctrlHome = raw >= 0.5;
          const ctrlTeam = ctrlHome ? r.matchup.split(' vs ')[0] : r.matchup.split(' vs ')[1];
          if (ctrlTeam !== 'EVEN') { total++; if (ctrlTeam === r.winner) correct++; }
        }
        simResults.unshift({ name: 'BASELINE old indicators + old weights', accuracy: total > 0 ? (correct / total * 100).toFixed(1) : 'N/A', correct, total });
      }

      // Per-indicator accuracy with new formulas
      function indAccuracy(results, field, hIdx) {
        let correct = 0, decisive = 0, even = 0;
        for (const r of results) {
          const v = r[field];
          if (v === 0.5) { even++; continue; }
          decisive++;
          const indWin = v > 0.5 ? r.matchup.split(' vs ')[0] : r.matchup.split(' vs ')[1];
          if (indWin === r.winner) correct++;
        }
        return { accuracy: decisive > 0 ? (correct / decisive * 100).toFixed(1) : 'N/A', correct, decisive, even, total: results.length };
      }

      const perIndicator = {
        oldI1: indAccuracy(results, 'oldI1'), newI1: indAccuracy(results, 'newI1'),
        oldI2: indAccuracy(results, 'oldI2'), newI2: indAccuracy(results, 'newI2'),
        I3: indAccuracy(results, 'I3'),
        oldI4: indAccuracy(results, 'oldI4'), newI4: indAccuracy(results, 'newI4'),
        newI4blOnly: indAccuracy(results, 'newI4blOnly'),
        oldI5: indAccuracy(results, 'oldI5'), newI5: indAccuracy(results, 'newI5'),
        newI5_8: indAccuracy(results, 'newI5_8'),
      };

      // 2-indicator combos (new indicators)
      const combos = [];
      const indPairs = [['newI1','newI2'],['newI1','I3'],['newI1','newI4'],['newI1','newI5'],
        ['newI2','I3'],['newI2','newI4'],['newI2','newI5'],
        ['I3','newI4'],['I3','newI5'],['newI4','newI5']];
      for (const [a2, b] of indPairs) {
        let correct = 0, agree = 0;
        for (const r of results) {
          const va = r[a2], vb = r[b];
          if (va === 0.5 || vb === 0.5) continue;
          const wa = va > 0.5 ? r.matchup.split(' vs ')[0] : r.matchup.split(' vs ')[1];
          const wb = vb > 0.5 ? r.matchup.split(' vs ')[0] : r.matchup.split(' vs ')[1];
          if (wa === wb) { agree++; if (wa === r.winner) correct++; }
        }
        combos.push({ pair: a2 + '+' + b, accuracy: agree > 0 ? (correct / agree * 100).toFixed(1) : 'N/A', agree, correct });
      }

      return { statusCode: 200, headers, body: JSON.stringify({
        gamesTotal: games.length, gamesWithData: results.length,
        simResults, perIndicator, combos,
        sampleGames: results.slice(0, 5),
      }) };
    }

    if (action === 'test_pipeline') {
      // Write test alerts with known game_id prefix for pipeline verification
      const testGameId = 'TEST_PIPELINE_001';
      const testDate = '2099-01-01';
      
      // Ensure test game exists
      await sql`INSERT INTO games (id, date, league, matchup, home_alias, away_alias, winner, home_pts, away_pts, margin)
        VALUES (${testGameId}, ${testDate}, 'nba', 'TEST@PIPE', 'PIPE', 'TEST', 'PIPE', 110, 102, 8)
        ON CONFLICT (id) DO UPDATE SET winner = 'PIPE', home_pts = 110, away_pts = 102, margin = 8`;

      // Clean any prior test data for this game
      await sql`DELETE FROM alerts WHERE game_id = ${testGameId}`;

      // Write test alerts covering all paths including transition alerts through agent
      const testAlerts = [
        { type: 'BUY', tier: 'FIRED', agent: 'SEND', ctrl: 'PIPE', floor: 0.72, margin: 6, trailing: true, period: 3, clock: '4:00', reasoning: 'I4 COMBO YES, structural case strong' },
        { type: 'BUY', tier: 'CANDIDATE', agent: 'SUPPRESS', ctrl: 'PIPE', floor: 0.58, margin: 8, trailing: true, period: 2, clock: '8:00', reasoning: 'I4 COMBO NO, weak structural case' },
        { type: 'BUY WINDOW CLOSING', tier: 'FIRED', agent: 'SEND', ctrl: 'PIPE', floor: 0.80, margin: 4, trailing: false, period: 3, clock: '6:00', reasoning: 'dominant structural case' },
        { type: 'AUTO_ANALYSIS', tier: 'ANALYSIS', agent: 'SEND', ctrl: 'PIPE', floor: 0.75, margin: 3, trailing: false, period: 2, clock: '12:00', reasoning: 'BWC position holding, floor +0.07' },
        { type: 'AUTO_ANALYSIS', tier: 'ANALYSIS', agent: 'SUPPRESS', ctrl: 'PIPE', floor: 0.55, margin: 1, trailing: true, period: 1, clock: '6:00', reasoning: 'No prior actionable alert (position gate)' },
        { type: 'RECOVERY PATH', tier: 'FIRED', agent: 'SEND', ctrl: 'PIPE', floor: 0.45, margin: 10, trailing: true, period: 2, clock: '10:00', reasoning: 'I4 COMBO YES, TP STRONG backs structural math' },
        { type: 'LEAD CRUMBLING', tier: 'FIRED', agent: 'SUPPRESS', ctrl: 'PIPE', floor: 0.78, margin: 8, trailing: false, period: 3, clock: '8:00', reasoning: 'I4 dominant, sust holds, hot quarter noise' },
        { type: 'LEAD CRUMBLING', tier: 'FIRED', agent: 'SEND', ctrl: 'PIPE', floor: 0.65, margin: 5, trailing: false, period: 4, clock: '3:00', reasoning: 'real erosion, floor -0.13, I4 EVEN' },
        { type: 'LEAD LOST', tier: null, agent: null, ctrl: 'PIPE', floor: 0.60, margin: 0, trailing: false, period: 4, clock: '1:00', reasoning: null },
        { type: 'VARIANCE BREAKING', tier: 'FIRED', agent: 'SEND', ctrl: 'TEST', floor: 0.68, margin: 4, trailing: true, period: 3, clock: '5:00', reasoning: 'opponent sust collapsed, I4 COMBO YES' },
      ];

      let inserted = 0;
      for (const a of testAlerts) {
        try {
          await sql`INSERT INTO alerts (game_id, league, alert_type, alert_tier, agent_decision, agent_reasoning, control_team, floor_score, margin, is_trailing, period, clock, conviction_tier, conviction_combo, i1, i2, i3, i4, i5, ntfy_sent)
            VALUES (${testGameId}, 'nba', ${a.type}, ${a.tier}, ${a.agent}, ${a.reasoning}, ${a.ctrl}, ${a.floor}, ${a.margin}, ${a.trailing}, ${a.period}, ${a.clock}, 'STRONG', 'I3+I4', 0.7, 0.6, 0.8, 0.9, 0.5, ${a.agent === 'SEND' || a.agent === null})`;
          inserted++;
        } catch (e) { /* skip dupes */ }
      }

      // Verify: what would gatherAgentContext see? (excludes AUTO_ANALYSIS SUPPRESS)
      const agentWouldSee = await sql`SELECT alert_type, alert_tier, agent_decision, agent_reasoning, period, clock, floor_score, conviction_tier
        FROM alerts WHERE game_id = ${testGameId}
          AND NOT (alert_type = 'AUTO_ANALYSIS' AND agent_decision = 'SUPPRESS')
        ORDER BY ts DESC LIMIT 5`;

      // Verify: transition alerts have agent columns populated
      const transitionCheck = await sql`SELECT alert_type, alert_tier, agent_decision, agent_reasoning, conviction_tier, conviction_combo, i1, i2, i3, i4, i5
        FROM alerts WHERE game_id = ${testGameId}
          AND alert_type IN ('RECOVERY PATH', 'LEAD CRUMBLING', 'VARIANCE BREAKING')
        ORDER BY ts DESC`;

      const autoSuppressed = await sql`SELECT alert_type, agent_decision FROM alerts WHERE game_id = ${testGameId} AND alert_type = 'AUTO_ANALYSIS' AND agent_decision = 'SUPPRESS'`;

      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true, inserted, testGameId, testDate,
        verification: {
          agent_would_see: agentWouldSee.map(a => `${a.alert_type}[${a.alert_tier}] Q${a.period} ${a.clock} → ${a.agent_decision}`),
          agent_would_see_count: agentWouldSee.length,
          auto_suppress_filtered: autoSuppressed.length + ' AUTO_ANALYSIS SUPPRESS excluded from agent context',
          transition_alerts_with_agent: transitionCheck.map(a => ({
            type: a.alert_type,
            tier: a.alert_tier,
            decision: a.agent_decision,
            reasoning: a.agent_reasoning?.substring(0, 80),
            has_conviction: !!a.conviction_tier,
            has_indicators: a.i1 != null && a.i4 != null,
          })),
        },
        cleanup: 'Run: db-api?action=cleanup_test',
      }) };
    }

    if (action === 'cleanup_test') {
      const testGameId = 'TEST_PIPELINE_001';
      const alertsDel = await sql`DELETE FROM alerts WHERE game_id = ${testGameId} RETURNING id`;
      const gamesDel = await sql`DELETE FROM games WHERE id = ${testGameId} RETURNING id`;
      // Also clean any learnings that scored this data
      const learnDel = await sql`DELETE FROM learnings WHERE date = '2099-01-01' RETURNING date`;
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true,
        alerts_deleted: alertsDel.length,
        games_deleted: gamesDel.length,
        learnings_deleted: learnDel.length,
      }) };
    }

    if (action === 'get_monitor_observations') {
      const gameId = params.game_id;
      const date = params.date;
      const latest = params.latest_per_game;
      const league = params.league || 'nba';
      const limit = Math.min(parseInt(params.limit) || 50, 200);
      let rows;
      if (gameId) {
        rows = await sql`SELECT * FROM monitor_observations WHERE game_id = ${gameId} ORDER BY ts DESC LIMIT ${limit}`;
      } else if (latest) {
        rows = await sql`SELECT DISTINCT ON (game_id) * FROM monitor_observations WHERE league = ${league} ORDER BY game_id, ts DESC`;
      } else if (date) {
        rows = await sql`SELECT * FROM monitor_observations WHERE ts::date = ${date}::date AND league = ${league} ORDER BY ts DESC LIMIT ${limit}`;
      } else {
        rows = await sql`SELECT * FROM monitor_observations WHERE league = ${league} ORDER BY ts DESC LIMIT ${limit}`;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: rows.length, observations: rows }) };
    }

    if (action === 'delete_learning') {
      const date = params.date;
      if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date required' }) };
      const deleted = await sql`DELETE FROM learnings WHERE date = ${date} RETURNING date`;
      if (deleted.length === 0) {
        // Show what dates exist so we can debug
        const existing = await sql`SELECT date FROM learnings ORDER BY date DESC LIMIT 10`;
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, message: 'No row found for ' + date, existing_dates: existing.map(r => r.date) }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: deleted.length }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('DB API error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
