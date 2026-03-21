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
    let game = null;
    for (let d = 1; d <= 3; d++) {
      const dt = new Date(today - d * 86400000).toISOString().split('T')[0];
      log('Checking: ' + dt);
      const r = await fetch(base + '/nba/v1/games?dates[]=' + dt + '&per_page=5', { headers: hdrs });
      const j = await r.json();
      if (j.data && j.data.length > 0) { game = j.data[0]; break; }
    }
    if (!game) { log('No games found'); return { statusCode: 200, headers, body: JSON.stringify({ results }) }; }
    log('Game: ' + (game.visitor_team?.abbreviation||'?') + ' @ ' + (game.home_team?.abbreviation||'?') + ' ID:' + game.id + ' ' + game.status);

    // The docs call it "Plays" — try /plays endpoint
    var paths = [
      '/nba/v1/plays?game_id=' + game.id + '&per_page=50',
      '/nba/v2/plays?game_id=' + game.id + '&per_page=50',
      '/nba/v1/play_by_play?game_id=' + game.id + '&per_page=50',
      '/nba/v1/games/' + game.id + '/plays?per_page=50',
      '/nba/v1/games/' + game.id + '/pbp?per_page=50',
    ];

    for (var pi = 0; pi < paths.length; pi++) {
      var path = paths[pi];
      log('\n=== Trying: ' + path + ' ===');
      var r = await fetch(base + path, { headers: hdrs });
      log('HTTP: ' + r.status);
      if (r.ok) {
        var d = await r.json();
        log('SUCCESS! Entries: ' + (d.data?.length || 0));
        if (d.data && d.data.length > 0) {
          var allKeys = new Set();
          d.data.forEach(function(ev) { Object.keys(ev).forEach(function(k) { allKeys.add(k); }); });
          log('ALL FIELDS: ' + [...allKeys].sort().join(', '));
          log('\nEvent 0: ' + JSON.stringify(d.data[0]));
          log('Event 1: ' + JSON.stringify(d.data[1]));
          log('Event 2: ' + JSON.stringify(d.data[2]));

          // Find shots
          var shots = d.data.filter(function(ev) {
            var desc = (ev.description || ev.event_type || ev.type || ev.play_type || '').toLowerCase();
            return desc.includes('made') || desc.includes('miss') || desc.includes('shot') || desc.includes('field_goal');
          });
          log('\nShots found: ' + shots.length);
          if (shots[0]) log('Shot 0: ' + JSON.stringify(shots[0]));
          if (shots[1]) log('Shot 1: ' + JSON.stringify(shots[1]));

          log('\n=== CRITICAL CHECKS ===');
          var checks = {
            'Shot coords': d.data.some(function(e) { return e.x!=null||e.y!=null||e.x_coordinate!=null||e.y_coordinate!=null||e.coord_x!=null||e.shot_x!=null; }),
            'Shot distance': d.data.some(function(e) { return e.shot_distance!=null||e.distance!=null; }),
            'Zone/area': d.data.some(function(e) { return e.action_area!=null||e.shot_type!=null||e.zone!=null||e.area!=null||e.shot_zone!=null; }),
            'Player': d.data.some(function(e) { return e.player!=null||e.player_id!=null||e.player_name!=null; }),
            'Team': d.data.some(function(e) { return e.team!=null||e.team_id!=null; }),
            'Period': d.data.some(function(e) { return e.period!=null||e.quarter!=null; }),
            'Clock': d.data.some(function(e) { return e.clock!=null||e.game_clock!=null||e.time!=null||e.time_remaining!=null; }),
            'Event type': d.data.some(function(e) { return e.event_type!=null||e.type!=null||e.action_type!=null||e.play_type!=null; }),
          };
          Object.entries(checks).forEach(function(pair) { log((pair[1]?'YES':'NO') + ' — ' + pair[0]); });
        }
        break; // Found working endpoint, stop trying others
      } else {
        var txt = await r.text();
        log('Failed: ' + txt.substring(0, 150));
      }
    }

    // Also try NCAAB
    log('\n=== NCAAB PBP ===');
    var ncPaths = [
      '/ncaab/v1/plays',
      '/ncaab/v1/play_by_play',
    ];
    var ncGame = null;
    for (var d = 1; d <= 3; d++) {
      var dt = new Date(today - d * 86400000).toISOString().split('T')[0];
      var nr = await fetch(base + '/ncaab/v1/games?dates[]=' + dt + '&per_page=3', { headers: hdrs });
      var nd = await nr.json();
      if (nd.data && nd.data.length > 0) { ncGame = nd.data[0]; break; }
    }
    if (ncGame) {
      log('NCAAB game: ' + (ncGame.visitor_team?.abbreviation||'?') + ' @ ' + (ncGame.home_team?.abbreviation||'?') + ' ID:' + ncGame.id);
      for (var ni = 0; ni < ncPaths.length; ni++) {
        var nPath = ncPaths[ni] + '?game_id=' + ncGame.id + '&per_page=20';
        log('Trying: ' + nPath);
        var nR = await fetch(base + nPath, { headers: hdrs });
        log('HTTP: ' + nR.status);
        if (nR.ok) {
          var nD = await nR.json();
          log('NCAAB entries: ' + (nD.data?.length || 0));
          if (nD.data && nD.data.length > 0) {
            var nk = new Set(); nD.data.forEach(function(e) { Object.keys(e).forEach(function(k) { nk.add(k); }); });
            log('NCAAB FIELDS: ' + [...nk].sort().join(', '));
            log('NCAAB Event 0: ' + JSON.stringify(nD.data[0]));
          }
          break;
        } else {
          log('Failed: ' + (await nR.text()).substring(0, 150));
        }
      }
    }

  } catch(e) { log('FATAL: ' + e.message + '\n' + e.stack); }
  return { statusCode: 200, headers, body: JSON.stringify({ results }, null, 2) };
};
