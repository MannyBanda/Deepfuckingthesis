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

      // Snapshot enrichment columns (server-side polling)
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'client'`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS lead_class TEXT`; } catch(e) {}
      try { await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS sust_json JSONB`; } catch(e) {}

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

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'Schema initialized' }) };
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

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
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
          prediction_json, indicators_json, narrative_json)
        VALUES (${a.game_id}, ${a.period}, ${a.clock}, ${a.control_team}, ${a.control_score},
          ${a.fwp}, ${a.edge}, ${a.entry}, ${a.conviction}, ${a.signal},
          ${a.sustainability}, ${a.lead_source}, ${a.raw_text},
          ${a.prediction_json || null}, ${a.indicators_json || null}, ${a.narrative_json || null})
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
            sustainability, lead_source, prediction_json, indicators_json, raw_text, narrative_json
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
          i1, i2, i3, i4, i5, source, sust_json
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

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('DB API error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
