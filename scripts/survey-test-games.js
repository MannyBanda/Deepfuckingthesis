// Survey production data for Alert System v2 test dataset
// Paste in browser console on the dashboard
// Finds target games + checks snapshot/alert/monitor coverage

const BASE = window.location.origin + '/.netlify/functions/db-api';

async function survey() {
  console.log('=== ALERT SYSTEM v2 TEST DATA SURVEY ===\n');

  // 1. Get all games
  const gamesRes = await fetch(`${BASE}?action=get_games&league=nba`);
  const { games } = await gamesRes.json();
  console.log(`Total games in DB: ${games.length}`);

  // 2. Find target games by matchup keywords
  const targets = [
    { label: 'SAC@GSW (+500/+700 BUY)', search: ['SAC', 'GSW'] },
    { label: 'DEN@POR (+700)', search: ['DEN', 'POR'] },
    { label: 'POR@PHX (+700)', search: ['POR', 'PHX'] },
    { label: 'GSW@LAC (collapse)', search: ['GSW', 'LAC'] },
    { label: 'MIA@CHA (OT bad beat)', search: ['MIA', 'CHA'] },
    { label: 'ORL@PHI (5 correct)', search: ['ORL', 'PHI'] },
  ];

  const foundGames = [];
  for (const t of targets) {
    const matches = games.filter(g => {
      const m = (g.matchup || '').toUpperCase();
      const h = (g.home_alias || '').toUpperCase();
      const a = (g.away_alias || '').toUpperCase();
      return t.search.every(s => m.includes(s) || h === s || a === s);
    });
    console.log(`\n--- ${t.label} ---`);
    if (matches.length === 0) {
      console.log('  NOT FOUND');
    } else {
      for (const g of matches) {
        console.log(`  ${g.date} | ${g.matchup || g.away_alias + '@' + g.home_alias} | ${g.away_pts}-${g.home_pts} | W: ${g.winner} | id: ${g.id}`);
        foundGames.push({ ...g, label: t.label });
      }
    }
  }

  // 3. For each found game, check data coverage
  console.log('\n\n=== DATA COVERAGE PER GAME ===\n');
  
  const coverageResults = [];
  
  for (const g of foundGames) {
    const gameId = g.id;
    const label = `${g.date} ${g.matchup || g.away_alias + '@' + g.home_alias}`;
    
    // Snapshots count (use history endpoint)
    let snapCount = 0, snapPeriods = [];
    try {
      const snapRes = await fetch(`${BASE}?action=history&game_id=${gameId}&league=nba`);
      const snapData = await snapRes.json();
      const snaps = snapData.snapshots || snapData.history || [];
      snapCount = snaps.length;
      // Get period range
      const periods = [...new Set(snaps.map(s => s.period))].sort((a,b) => a-b);
      snapPeriods = periods;
    } catch(e) { console.log(`  snapshot query failed: ${e.message}`); }
    
    // Alerts
    let alertCount = 0, alertTypes = {};
    try {
      const alertRes = await fetch(`${BASE}?action=get_alerts&league=nba&limit=200`);
      const alertData = await alertRes.json();
      const gameAlerts = (alertData.alerts || []).filter(a => a.game_id === gameId);
      alertCount = gameAlerts.length;
      gameAlerts.forEach(a => {
        const key = `${a.alert_type}[${a.agent_decision || 'N/A'}]`;
        alertTypes[key] = (alertTypes[key] || 0) + 1;
      });
    } catch(e) {}
    
    // Monitor observations
    let monitorCount = 0;
    try {
      const monRes = await fetch(`${BASE}?action=get_monitor_observations&game_id=${gameId}&league=nba&limit=200`);
      const monData = await monRes.json();
      monitorCount = (monData.observations || []).length;
    } catch(e) {}
    
    // Auto analyses
    let analysisCount = 0;
    try {
      const anaRes = await fetch(`${BASE}?action=get_auto_analyses&game_id=${gameId}&league=nba`);
      const anaData = await anaRes.json();
      analysisCount = (anaData.analyses || []).length;
    } catch(e) {}
    
    const coverage = {
      label, gameId,
      date: g.date,
      result: `${g.away_pts}-${g.home_pts} (W: ${g.winner})`,
      snapshots: snapCount,
      periods: snapPeriods.join(','),
      alerts: alertCount,
      alertTypes: Object.entries(alertTypes).map(([k,v]) => `${k}:${v}`).join(', '),
      monitor: monitorCount,
      analyses: analysisCount,
    };
    coverageResults.push(coverage);
    
    console.log(`${label}`);
    console.log(`  Result: ${coverage.result}`);
    console.log(`  Snapshots: ${snapCount} (periods: ${coverage.periods || 'none'})`);
    console.log(`  Alerts: ${alertCount} ${coverage.alertTypes ? '(' + coverage.alertTypes + ')' : ''}`);
    console.log(`  Monitor obs: ${monitorCount}`);
    console.log(`  Auto analyses: ${analysisCount}`);
    console.log('');
  }

  // 4. Summary table
  console.log('\n=== SUMMARY TABLE ===');
  console.table(coverageResults.map(c => ({
    game: c.label.substring(11), // trim date prefix
    date: c.date,
    snaps: c.snapshots,
    alerts: c.alerts,
    monitor: c.monitor,
    analyses: c.analyses,
    result: c.result,
  })));

  // 5. Find archetype candidates from ALL games with alerts
  console.log('\n\n=== ARCHETYPE CANDIDATES (games with 3+ alerts) ===');
  
  // Get all alerts (need more than just target games)
  try {
    const allAlertRes = await fetch(`${BASE}?action=get_alerts&league=nba&limit=500`);
    const allAlertData = await allAlertRes.json();
    const allAlerts = allAlertData.alerts || [];
    
    // Group by game
    const byGame = {};
    allAlerts.forEach(a => {
      if (!byGame[a.game_id]) byGame[a.game_id] = { 
        matchup: a.matchup || `${a.away_alias}@${a.home_alias}`,
        date: a.date,
        winner: a.winner,
        alerts: [],
      };
      byGame[a.game_id].alerts.push(a);
    });
    
    // Find interesting archetypes
    for (const [gid, g] of Object.entries(byGame)) {
      if (g.alerts.length < 2) continue;
      const types = g.alerts.map(a => a.alert_type);
      const hasBWC = types.includes('BUY WINDOW CLOSING');
      const hasBUY = types.includes('BUY');
      const hasLL = types.includes('LEAD LOST');
      const hasLC = types.includes('LEAD CRUMBLING');
      const hasRP = types.includes('RECOVERY PATH');
      
      // Tag archetype
      let archetype = '';
      if (hasBWC && hasLL) archetype = 'BWC→LEAD_LOST (potential VALUE/EXIT)';
      else if (hasBWC && hasLC) archetype = 'BWC→EROSION';
      else if (hasBUY && hasBWC) archetype = 'BUY+BWC (control flip game)';
      else if (hasBUY) archetype = 'BUY (trailing structural)';
      else if (hasBWC) archetype = 'BWC (holding lead)';
      
      if (archetype) {
        const ctrlWon = g.alerts[0].winner === g.alerts[0].control_team;
        console.log(`${g.date} ${g.matchup} | ${archetype} | ${types.join(', ')} | ctrl ${ctrlWon ? 'WON' : 'LOST'} | id: ${gid}`);
      }
    }
  } catch(e) { console.log('Alert survey failed:', e.message); }

  console.log('\n=== SURVEY COMPLETE ===');
  console.log('Copy/paste the output and share — we\'ll pick the final test set from this.');
  
  return coverageResults;
}

survey();
