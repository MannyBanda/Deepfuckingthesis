// ═══════════════════════════════════════════════════════════
// DFT Apr 19 Assessment — paste in browser console on live site
// Pulls: alerts, snapshots, auto analyses, quarter data, live_tracking
// ═══════════════════════════════════════════════════════════

const BASE = '/.netlify/functions/db-api';
const DATE = '2026-04-19';
const OPTS = { credentials: 'include' };

async function api(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}?${qs}`, OPTS);
  if (!r.ok) throw new Error(`${r.status} on ${params.action}`);
  return r.json();
}

(async () => {
  console.log(`%c═══ DFT ASSESSMENT: ${DATE} ═══`, 'color: gold; font-size: 16px; font-weight: bold');

  // ── 1. ALERTS ──────────────────────────────────────────
  console.log('%c\n📋 Fetching alerts...', 'color: cyan');
  const alertData = await api({ action: 'get_alerts', date: DATE, limit: 500 });
  const alerts = alertData.alerts || [];
  console.log(`Total alerts: ${alerts.length}`);
  console.log('Summary:', alertData.summary);

  // Group alerts by game
  const alertsByGame = {};
  const gameIds = new Set();
  for (const a of alerts) {
    if (!alertsByGame[a.game_id]) alertsByGame[a.game_id] = [];
    alertsByGame[a.game_id].push(a);
    gameIds.add(a.game_id);
  }
  const gameIdList = [...gameIds];
  console.log(`Games with alerts: ${gameIdList.length}`);

  // Per-type breakdown
  const byType = {};
  for (const a of alerts) {
    const key = `${a.alert_type}|${a.alert_tier || 'N/A'}|${a.agent_decision || 'N/A'}`;
    if (!byType[key]) byType[key] = { count: 0, correct: 0, wrong: 0, pending: 0 };
    byType[key].count++;
    if (a.correct === true) byType[key].correct++;
    else if (a.correct === false) byType[key].wrong++;
    else byType[key].pending++;
  }
  console.log('%c\nAlert breakdown (type|tier|decision):', 'color: yellow');
  console.table(byType);

  // Detailed alert log per game
  console.log('%c\n🔍 Alert detail per game:', 'color: yellow');
  for (const gid of gameIdList) {
    const ga = alertsByGame[gid];
    const matchup = ga[0]?.matchup || gid;
    const winner = ga[0]?.winner || '?';
    const score = ga[0]?.home_pts != null ? `${ga[0].home_alias} ${ga[0].home_pts} - ${ga[0].away_alias} ${ga[0].away_pts}` : 'in progress';
    console.log(`%c\n${matchup} → ${winner} wins (${score})`, 'color: lime; font-weight: bold');
    for (const a of ga.sort((x, y) => new Date(x.ts) - new Date(y.ts))) {
      const mark = a.correct === true ? '✅' : a.correct === false ? '❌' : '⏳';
      const bwcInfo = a.bwc_state ? ` [BWC:${a.bwc_state}${a.erosion_level ? '/'+a.erosion_level : ''}${a.peak_floor ? '/pk'+a.peak_floor : ''}]` : '';
      console.log(
        `  ${mark} Q${a.period} ${a.clock} | ${a.alert_type} ${a.alert_tier || ''} → ${a.agent_decision || 'DIRECT'} | ` +
        `ctrl=${a.control_team} floor=${a.floor_score} margin=${a.margin} trail=${a.is_trailing}` +
        `${a.conviction_tier ? ' conv=' + a.conviction_tier : ''}${a.conviction_combo ? '(' + a.conviction_combo + ')' : ''}` +
        `${a.tp_class ? ' tp=' + a.tp_class : ''}${a.ls_class ? ' ls=' + a.ls_class : ''}` +
        `${bwcInfo}`
      );
      if (a.agent_reasoning) {
        console.log(`    💬 ${a.agent_reasoning.substring(0, 200)}`);
      }
    }
  }

  // ── 2. SNAPSHOTS (server only) per game ────────────────
  console.log('%c\n📊 Fetching server snapshots per game...', 'color: cyan');
  const snapshotsByGame = {};
  for (const gid of gameIdList) {
    const d = await api({ action: 'history', game_id: gid });
    const all = d.snapshots || [];
    const server = all.filter(s => s.source === 'server');
    snapshotsByGame[gid] = { total: all.length, server: server.length, snaps: server };

    // Floor trajectory summary
    if (server.length > 0) {
      const first = server[0];
      const last = server[server.length - 1];
      const matchup = alertsByGame[gid]?.[0]?.matchup || gid;
      const floors = server.map(s => s.floor_score).filter(f => f != null);
      const minF = Math.min(...floors).toFixed(2);
      const maxF = Math.max(...floors).toFixed(2);
      const ctrlTeams = [...new Set(server.map(s => s.floor_team).filter(Boolean))];

      console.log(
        `  ${matchup}: ${server.length} server snaps | ` +
        `floor ${first.floor_score?.toFixed(2)} → ${last.floor_score?.toFixed(2)} (range ${minF}-${maxF}) | ` +
        `ctrl teams: ${ctrlTeams.join(', ')} | ` +
        `last: Q${last.period} ${last.clock} (${last.home_pts}-${last.away_pts})`
      );

      // TP/LS trajectory (last 5 server snaps)
      const tail = server.slice(-5);
      const tpLs = tail.map(s => `Q${s.period}${s.clock ? ' ' + s.clock : ''}: f=${s.floor_score?.toFixed(2)} tp=${s.tp_class || '?'} ls=${s.ls_class || '?'}`);
      console.log(`    Last 5: ${tpLs.join(' → ')}`);
    }
  }

  // ── 3. AUTO ANALYSES ──────────────────────────────────
  if (gameIdList.length > 0) {
    console.log('%c\n🤖 Fetching auto Sonnet analyses...', 'color: cyan');
    const analysisData = await api({ action: 'get_auto_analyses', game_ids: gameIdList.join(',') });
    const analyses = analysisData.analyses || {};
    for (const gid of gameIdList) {
      const ga = analyses[gid];
      if (!ga || ga.length === 0) {
        console.log(`  ${alertsByGame[gid]?.[0]?.matchup || gid}: no auto analyses`);
        continue;
      }
      const matchup = alertsByGame[gid]?.[0]?.matchup || gid;
      console.log(`%c  ${matchup}: ${ga.length} auto analyses`, 'color: lime');
      for (const a of ga) {
        console.log(
          `    ${a.trigger} Q${a.period} | ctrl=${a.control_team} score=${a.control_score} | ` +
          `FWP=${a.fwp} edge=${a.edge} conv=${a.conviction || a.conviction_tier || '?'} signal=${a.signal} | ` +
          `sust=${a.sustainability}`
        );
      }
    }
  }

  // ── 4. QUARTER DATA per game ───────────────────────────
  console.log('%c\n📐 Fetching quarter data...', 'color: cyan');
  for (const gid of gameIdList) {
    const qd = await api({ action: 'get_quarter_data', game_id: gid });
    const matchup = alertsByGame[gid]?.[0]?.matchup || gid;
    if (!qd.quarter_data) {
      console.log(`  ${matchup}: no quarter data`);
      continue;
    }
    const quarters = Object.keys(qd.quarter_data).sort();
    console.log(`  ${matchup}: quarters ${quarters.join(', ')}`);
    for (const q of quarters) {
      const d = qd.quarter_data[q];
      if (d && d.home && d.away) {
        const hAlias = alertsByGame[gid]?.[0]?.home_alias || 'HOME';
        const aAlias = alertsByGame[gid]?.[0]?.away_alias || 'AWAY';
        console.log(
          `    ${q}: Paint ${hAlias}:${d.home.paint_pts ?? '?'} ${aAlias}:${d.away.paint_pts ?? '?'} | ` +
          `FTA ${d.home.fta ?? '?'}/${d.away.fta ?? '?'} | ` +
          `3PM ${d.home.fg3m ?? '?'}/${d.away.fg3m ?? '?'} | ` +
          `AST ${d.home.ast ?? '?'}/${d.away.ast ?? '?'} | ` +
          `TO ${d.home.to ?? d.home.turnovers ?? '?'}/${d.away.to ?? d.away.turnovers ?? '?'} | ` +
          `Score ${d.home.pts ?? '?'}-${d.away.pts ?? '?'}`
        );
      }
    }
  }

  // ── 5. LIVE_TRACKING (graduation / BWC state machine) ──
  // Not exposed by db-api — pull games table directly
  // We can check alerts for bwc_state columns as proxy
  console.log('%c\n🎓 Graduation / BWC state from alerts:', 'color: cyan');
  for (const gid of gameIdList) {
    const ga = alertsByGame[gid];
    const matchup = ga[0]?.matchup || gid;
    const bwcAlerts = ga.filter(a => a.bwc_state);
    if (bwcAlerts.length === 0) {
      console.log(`  ${matchup}: no BWC state data on alerts`);
    } else {
      console.log(`%c  ${matchup}:`, 'color: lime');
      for (const a of bwcAlerts) {
        console.log(
          `    Q${a.period} ${a.clock} | ${a.alert_type} | state=${a.bwc_state} erosion=${a.erosion_level || 'none'} ` +
          `peak_floor=${a.peak_floor} exit=${a.exit_severity || 'none'} | floor=${a.floor_score} margin=${a.margin}`
        );
      }
    }
  }

  // ── 6. OVERALL SUMMARY ────────────────────────────────
  console.log('%c\n═══ SUMMARY ═══', 'color: gold; font-size: 14px; font-weight: bold');
  const sent = alerts.filter(a => a.agent_decision === 'SEND' || a.agent_decision === null);
  const suppressed = alerts.filter(a => a.agent_decision === 'SUPPRESS');
  const sentCorrect = sent.filter(a => a.correct === true).length;
  const sentWrong = sent.filter(a => a.correct === false).length;
  const sentPending = sent.filter(a => a.correct === null).length;
  const suppCorrect = suppressed.filter(a => a.correct === true).length;
  const suppWrong = suppressed.filter(a => a.correct === false).length;

  console.log(`Games: ${gameIdList.length}`);
  console.log(`Total alerts: ${alerts.length} (SENT: ${sent.length}, SUPPRESSED: ${suppressed.length})`);
  console.log(`SENT accuracy: ${sentCorrect}/${sentCorrect + sentWrong} = ${sentCorrect + sentWrong > 0 ? Math.round(sentCorrect / (sentCorrect + sentWrong) * 100) : 'N/A'}%${sentPending > 0 ? ` (${sentPending} pending)` : ''}`);
  console.log(`SUPPRESS accuracy: ${suppCorrect}/${suppCorrect + suppWrong} = ${suppCorrect + suppWrong > 0 ? Math.round(suppCorrect / (suppCorrect + suppWrong) * 100) : 'N/A'}%`);
  console.log(`Overall: ${alertData.summary?.accuracy != null ? alertData.summary.accuracy + '%' : 'N/A'} (${alertData.summary?.correct}/${alertData.summary?.resolved})`);
  console.log(`Suppress categories:`, alertData.summary?.suppressions);

  // Package everything for easy copy-paste back to Claude
  const payload = {
    date: DATE,
    summary: alertData.summary,
    sent_accuracy: { correct: sentCorrect, wrong: sentWrong, pending: sentPending, pct: sentCorrect + sentWrong > 0 ? Math.round(sentCorrect / (sentCorrect + sentWrong) * 100) : null },
    suppress_accuracy: { correct: suppCorrect, wrong: suppWrong, pct: suppCorrect + suppWrong > 0 ? Math.round(suppCorrect / (suppCorrect + suppWrong) * 100) : null },
    games: gameIdList.map(gid => {
      const ga = alertsByGame[gid];
      const ss = snapshotsByGame[gid];
      return {
        game_id: gid,
        matchup: ga[0]?.matchup,
        winner: ga[0]?.winner,
        score: `${ga[0]?.home_alias} ${ga[0]?.home_pts} - ${ga[0]?.away_alias} ${ga[0]?.away_pts}`,
        server_snaps: ss?.server || 0,
        floor_start: ss?.snaps?.[0]?.floor_score,
        floor_end: ss?.snaps?.[ss.snaps.length - 1]?.floor_score,
        ctrl_team_start: ss?.snaps?.[0]?.floor_team,
        ctrl_team_end: ss?.snaps?.[ss.snaps.length - 1]?.floor_team,
        alerts: ga.map(a => ({
          type: a.alert_type, tier: a.alert_tier, decision: a.agent_decision,
          period: a.period, clock: a.clock, floor: a.floor_score, margin: a.margin,
          trailing: a.is_trailing, correct: a.correct,
          conv: a.conviction_tier, combo: a.conviction_combo,
          tp: a.tp_class, ls: a.ls_class, bwc_state: a.bwc_state,
          erosion: a.erosion_level, peak_floor: a.peak_floor,
          reasoning: a.agent_reasoning?.substring(0, 300),
        })),
      };
    }),
  };

  console.log('%c\n📦 Full payload (copy this for Claude):', 'color: magenta; font-weight: bold');
  console.log(JSON.stringify(payload, null, 2));

  return payload;
})();
