// ═══════════════════════════════════════════════════════════════
// PHASE 1 — IDENTIFY MISSING APRIL 12 GAMES
// Paste in browser console on the dashboard
// Pulls games + snapshot counts to show what we have vs what's missing
// ═══════════════════════════════════════════════════════════════

(async () => {
  const API = '/.netlify/functions/db-api';
  const q = (action, params = {}) => {
    const qs = new URLSearchParams({ action, ...params }).toString();
    return fetch(`${API}?${qs}`).then(r => r.json());
  };

  console.log('%c═══ APRIL 12 AUDIT — PHASE 1: IDENTIFY GAPS ═══', 'color:cyan;font-weight:bold;font-size:14px');

  // 1. Get all April 12 games
  const { games } = await q('get_games', { league: 'nba' });
  const apr12 = games.filter(g => g.date === '2026-04-12');
  console.log(`\n%cApril 12 games: ${apr12.length}`, 'color:lime;font-weight:bold');
  
  if (apr12.length === 0) {
    console.log('%cNo games found for 2026-04-12. Check date format.', 'color:red');
    return;
  }

  // 2. For each game, count snapshots
  const results = [];
  for (const g of apr12) {
    const { snapshots } = await q('history', { game_id: g.id });
    const snapCount = snapshots?.length || 0;
    const firstSnap = snapshots?.[0];
    const lastSnap = snapshots?.[snapCount - 1];
    
    results.push({
      matchup: g.matchup,
      id: g.id,
      homeAlias: g.home_alias,
      awayAlias: g.away_alias,
      finalScore: g.winner ? `${g.home_pts}-${g.away_pts} (${g.winner} +${g.margin})` : 'NOT FINALIZED',
      snapshots: snapCount,
      firstSnapPeriod: firstSnap ? `Q${firstSnap.period} ${firstSnap.clock}` : '-',
      firstSnapTime: firstSnap?.ts || '-',
      lastSnapPeriod: lastSnap ? `Q${lastSnap.period} ${lastSnap.clock}` : '-',
      coverage: snapCount === 0 ? 'MISSING' : snapCount < 10 ? 'PARTIAL' : 'GOOD'
    });
  }

  // 3. Sort: missing first, then partial, then good
  const order = { MISSING: 0, PARTIAL: 1, GOOD: 2 };
  results.sort((a, b) => order[a.coverage] - order[b.coverage]);

  // 4. Display
  console.log('\n%c┌─────────────────────────────────────────────────────────────────────┐', 'color:gray');
  console.log('%c│ GAME COVERAGE REPORT                                                │', 'color:yellow;font-weight:bold');
  console.log('%c└─────────────────────────────────────────────────────────────────────┘', 'color:gray');

  const missing = results.filter(r => r.coverage === 'MISSING');
  const partial = results.filter(r => r.coverage === 'PARTIAL');
  const good = results.filter(r => r.coverage === 'GOOD');

  if (missing.length > 0) {
    console.log(`\n%c❌ MISSING (${missing.length} games — no snapshots):`, 'color:red;font-weight:bold');
    missing.forEach(r => console.log(`   ${r.matchup}  ${r.finalScore}  [${r.id.slice(0,8)}]`));
  }

  if (partial.length > 0) {
    console.log(`\n%c⚠️ PARTIAL (${partial.length} games — incomplete coverage):`, 'color:orange;font-weight:bold');
    partial.forEach(r => console.log(`   ${r.matchup}  ${r.finalScore}  │ ${r.snapshots} snaps │ First: ${r.firstSnapPeriod} │ Last: ${r.lastSnapPeriod}  [${r.id.slice(0,8)}]`));
  }

  if (good.length > 0) {
    console.log(`\n%c✅ GOOD (${good.length} games — solid coverage):`, 'color:lime;font-weight:bold');
    good.forEach(r => console.log(`   ${r.matchup}  ${r.finalScore}  │ ${r.snapshots} snaps │ First: ${r.firstSnapPeriod} │ Last: ${r.lastSnapPeriod}  [${r.id.slice(0,8)}]`));
  }

  // 5. Also pull alerts for context
  const { alerts, summary: alertSummary } = await q('get_alerts', { date: '2026-04-12', league: 'nba' });
  console.log(`\n%c📊 ALERTS: ${alertSummary.total} total, ${alertSummary.correct}/${alertSummary.resolved} correct (${alertSummary.accuracy}%)`, 'color:cyan;font-weight:bold');
  
  // Group alerts by game
  const alertsByGame = {};
  alerts.forEach(a => {
    if (!alertsByGame[a.matchup]) alertsByGame[a.matchup] = [];
    alertsByGame[a.matchup].push(a);
  });
  
  console.log('\n%cAlerts by game:', 'color:yellow');
  for (const [matchup, gameAlerts] of Object.entries(alertsByGame)) {
    const sent = gameAlerts.filter(a => a.ntfy_sent);
    const suppressed = gameAlerts.filter(a => !a.ntfy_sent);
    console.log(`   ${matchup}: ${gameAlerts.length} total (${sent.length} sent, ${suppressed.length} suppressed)`);
    sent.forEach(a => {
      const tag = a.correct ? '✅' : '❌';
      console.log(`      ${tag} ${a.alert_type} ${a.control_team} Q${a.period} ${a.clock || ''} │ agent: ${a.agent_decision || '-'}`);
    });
  }

  // 6. Export for Phase 2
  console.log('\n%c═══ GAME IDS FOR RECONSTRUCTION ═══', 'color:cyan;font-weight:bold');
  const needsReconstruction = results.filter(r => r.coverage === 'MISSING' || r.coverage === 'PARTIAL');
  console.log('Missing/Partial game IDs:', needsReconstruction.map(r => r.id));
  console.log('All game IDs:', results.map(r => ({ matchup: r.matchup, id: r.id, coverage: r.coverage })));
  
  // Store for Phase 2
  window._apr12Audit = { results, alerts, alertsByGame, needsReconstruction };
  console.log('\n%cStored in window._apr12Audit for Phase 2', 'color:gray');
})();
