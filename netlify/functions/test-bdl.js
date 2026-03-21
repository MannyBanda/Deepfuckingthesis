exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const BDL_KEY = 'ee78e074-2f89-4ee5-807a-181fc324398c';
  const base = 'https://api.balldontlie.io';
  const hdrs = { Authorization: BDL_KEY };
  const results = [];
  function log(msg) { results.push(msg); }

  try {
    log('=== STEP 1: Find recent NBA game ===');
    const today = new Date();
    let gamesData = null;
    for (let d = 1; d <= 3; d++) {
      const dt = new Date(today - d * 86400000).toISOString().split('T')[0];
      log('Checking date: ' + dt);
      const r = await fetch(base + '/nba/v1/games?dates[]=' + dt + '&per_page=5', { headers: hdrs });
      const j = await r.json();
      if (j.data && j.data.length > 0) { gamesData = j; break; }
    }
    if (!gamesData || !gamesData.data.length) { log('No recent games found'); return { statusCode: 200, headers, body: JSON.stringify({ results }) }; }

    const game = gamesData.data[0];
    log('Game: ' + (game.visitor_team?.abbreviation||'?') + ' @ ' + (game.home_team?.abbreviation||'?') + ' (ID: ' + game.id + ')');
    log('Status: ' + game.status + ' Score: ' + game.visitor_team_score + '-' + game.home_team_score);

    log('\n=== STEP 2: NBA PBP v1 ===');
    const pbpR = await fetch(base + '/nba/v1/play_by_play?game_id=' + game.id + '&per_page=50', { headers: hdrs });
    log('HTTP: ' + pbpR.status);
    if (!pbpR.ok) {
      log('FAILED: ' + (await pbpR.text()).substring(0, 300));
    } else {
      const pbp = await pbpR.json();
      log('Entries: ' + (pbp.data?.length || 0));
      if (pbp.data && pbp.data.length > 0) {
        const allKeys = new Set();
        pbp.data.forEach(ev => Object.keys(ev).forEach(k => allKeys.add(k)));
        log('\nALL FIELDS: ' + [...allKeys].sort().join(', '));
        log('\n--- First 3 events ---');
        pbp.data.slice(0, 3).forEach((ev, i) => { log('Event ' + i + ': ' + JSON.stringify(ev)); });
        const shots = pbp.data.filter(ev => {
          const d = (ev.description || ev.event_type || ev.type || '').toLowerCase();
          return d.includes('made') || d.includes('miss');
        });
        log('\n--- Shots: ' + shots.length + ' ---');
        if (shots[0]) log('Shot 1: ' + JSON.stringify(shots[0]));
        if (shots[1]) log('Shot 2: ' + JSON.stringify(shots[1]));
        if (shots[2]) log('Shot 3: ' + JSON.stringify(shots[2]));

        log('\n=== CRITICAL CHECKS ===');
        const c = {
          'Shot coords (x/y)': pbp.data.some(e => e.x_coordinate!=null||e.y_coordinate!=null||e.coord_x!=null||e.coord_y!=null||e.x!=null||e.y!=null),
          'Shot distance': pbp.data.some(e => e.shot_distance!=null||e.distance!=null),
          'Action area/zone': pbp.data.some(e => e.action_area!=null||e.shot_type!=null||e.zone!=null||e.area!=null),
          'Player': pbp.data.some(e => e.player!=null||e.player_id!=null||e.player_name!=null),
          'Team': pbp.data.some(e => e.team!=null||e.team_id!=null),
          'Period': pbp.data.some(e => e.period!=null||e.quarter!=null),
          'Clock': pbp.data.some(e => e.clock!=null||e.game_clock!=null||e.time_remaining!=null||e.time!=null),
          'Event type': pbp.data.some(e => e.event_type!=null||e.type!=null||e.action_type!=null),
          'Assist': pbp.data.some(e => e.assist!=null||e.assisted_by!=null),
          'Turnover': pbp.data.some(e => e.turnover_type!=null||e.steal!=null),
        };
        Object.entries(c).forEach(([k,v]) => { log((v?'YES':'NO') + ' — ' + k); });
        const types = new Set();
        pbp.data.forEach(e => { if(e.event_type)types.add(e.event_type); if(e.type)types.add('type:'+e.type); if(e.action_type)types.add('action:'+e.action_type); });
        if (types.size > 0) log('\nEvent types: ' + [...types].join(', '));
      }
    }

    log('\n=== STEP 3: NBA PBP v2 ===');
    try {
      const p2R = await fetch(base + '/nba/v2/play_by_play?game_id=' + game.id + '&per_page=20', { headers: hdrs });
      log('v2 HTTP: ' + p2R.status);
      if (p2R.ok) {
        const p2 = await p2R.json();
        log('v2 entries: ' + (p2.data?.length || 0));
        if (p2.data && p2.data.length > 0) {
          const k2 = new Set(); p2.data.forEach(e => Object.keys(e).forEach(k => k2.add(k)));
          log('v2 FIELDS: ' + [...k2].sort().join(', '));
          log('v2 Event 0: ' + JSON.stringify(p2.data[0]));
        }
      } else { log('v2: ' + (await p2R.text()).substring(0, 200)); }
    } catch(e) { log('v2 err: ' + e.message); }

    log('\n=== STEP 4: Box score ===');
    try {
      const sR = await fetch(base + '/nba/v1/stats?game_ids[]=' + game.id + '&per_page=3', { headers: hdrs });
      if (sR.ok) {
        const s = await sR.json();
        if (s.data && s.data.length > 0) {
          log('Stats fields: ' + Object.keys(s.data[0]).sort().join(', '));
          log('Stat 0: ' + JSON.stringify(s.data[0]));
        }
      }
    } catch(e) { log('Stats err: ' + e.message); }

    log('\n=== STEP 5: NCAAB PBP ===');
    try {
      for (let d = 1; d <= 3; d++) {
        const dt = new Date(today - d * 86400000).toISOString().split('T')[0];
        const nR = await fetch(base + '/ncaab/v1/games?dates[]=' + dt + '&per_page=3', { headers: hdrs });
        const nD = await nR.json();
        if (nD.data && nD.data.length > 0) {
          const ng = nD.data[0];
          log('NCAAB: ' + (ng.visitor_team?.abbreviation||'?') + ' @ ' + (ng.home_team?.abbreviation||'?') + ' ID:' + ng.id);
          const nP = await fetch(base + '/ncaab/v1/play_by_play?game_id=' + ng.id + '&per_page=30', { headers: hdrs });
          log('NCAAB PBP HTTP: ' + nP.status);
          if (nP.ok) {
            const nd = await nP.json();
            log('NCAAB entries: ' + (nd.data?.length || 0));
            if (nd.data && nd.data.length > 0) {
              const nk = new Set(); nd.data.forEach(e => Object.keys(e).forEach(k => nk.add(k)));
              log('NCAAB FIELDS: ' + [...nk].sort().join(', '));
              log('NCAAB Event 0: ' + JSON.stringify(nd.data[0]));
              const ns = nd.data.filter(e => { const d=(e.description||e.type||'').toLowerCase(); return d.includes('made')||d.includes('miss'); });
              if (ns[0]) log('NCAAB Shot: ' + JSON.stringify(ns[0]));
            }
          } else { log('NCAAB PBP: ' + (await nP.text()).substring(0, 200)); }
          break;
        }
      }
    } catch(e) { log('NCAAB err: ' + e.message); }

  } catch(e) { log('FATAL: ' + e.message); }

  return { statusCode: 200, headers, body: JSON.stringify({ results }, null, 2) };
};
