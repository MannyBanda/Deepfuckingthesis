// ═══════════════════════════════════════════════════════════════
// INDICATOR REDESIGN SIM — BDL-sourced, paste in browser console
// Fetches box scores + PBP for last 15 days, recomputes all indicators
// ═══════════════════════════════════════════════════════════════
(async function() {
  const FN = '/.netlify/functions/';
  const BDL = (type, params) => fetch(FN+'bdl-data?type='+type+'&'+new URLSearchParams(params)).then(r=>r.json());
  const delay = ms => new Promise(r=>setTimeout(r,ms));

  // Generate date strings for last 15 days
  const dates = [];
  for (let i = 0; i < 15; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  console.log('%c═══ INDICATOR SIM — fetching '+dates.length+' days ═══','font-weight:bold;color:#00ff88;font-size:14px');

  // 1. Fetch all box scores
  const allGames = [];
  for (const dt of dates) {
    try {
      const resp = await BDL('box_scores', {date: dt});
      const games = resp.data || resp || [];
      const finished = games.filter(g => g.status === 'Final' || g.status === 'final' || (g.home_team_score > 0 && g.away_team_score > 0 && g.period >= 4));
      finished.forEach(g => { g._date = dt; });
      allGames.push(...finished);
      console.log(dt+':', finished.length, 'finished games');
    } catch(e) { console.warn(dt+' failed:', e.message); }
    await delay(150);
  }
  console.log('Total finished games:', allGames.length);

  // 2. Fetch PBP for each game
  const results = [];
  for (let gi = 0; gi < allGames.length; gi++) {
    const g = allGames[gi];
    const gid = g.id;
    let hA = g.home_team?.team?.abbreviation || g.home_team?.abbreviation || 'HOME';
    let aA = g.visitor_team?.team?.abbreviation || g.visitor_team?.abbreviation || g.away_team?.team?.abbreviation || g.away_team?.abbreviation || 'AWAY';
    const hPts = Number(g.home_team_score || 0);
    const aPts = Number(g.visitor_team_score || g.away_team_score || 0);
    if (hPts === 0 && aPts === 0) continue;
    let winner = hPts > aPts ? hA : aA;

    // Aggregate player stats from box score
    const homePlayers = g.home_team?.players || [];
    const awayPlayers = g.visitor_team?.players || g.away_team?.players || [];
    function sumStat(players, key) { return players.reduce((a,p) => a + Number(p[key]||0), 0); }

    const hStl = sumStat(homePlayers,'stl');
    const aStl = sumStat(awayPlayers,'stl');
    const hBlk = sumStat(homePlayers,'blk');
    const aBlk = sumStat(awayPlayers,'blk');
    const hOreb = sumStat(homePlayers,'oreb');
    const aOreb = sumStat(awayPlayers,'oreb');
    const hTo = sumStat(homePlayers,'turnover');
    const aTo = sumStat(awayPlayers,'turnover');
    const hFgm = sumStat(homePlayers,'fgm');
    const aFgm = sumStat(awayPlayers,'fgm');
    const hFga = sumStat(homePlayers,'fga');
    const aFga = sumStat(awayPlayers,'fga');
    const hFg3m = sumStat(homePlayers,'fg3m');
    const aFg3m = sumStat(awayPlayers,'fg3m');
    const hAst = sumStat(homePlayers,'ast');
    const aAst = sumStat(awayPlayers,'ast');
    const hFta = sumStat(homePlayers,'fta');
    const aFta = sumStat(awayPlayers,'fta');

    // Fetch PBP
    let pbpRuns = [], scoreLog = [], pbpBigLeadH = 0, pbpBigLeadA = 0;
    let hPot = 0, aPot = 0, hPaint = 0, aPaint = 0;
    try {
      const playsResp = await BDL('plays', {game_id: gid});
      const plays = (playsResp.data || playsResp || []).sort((a,b) => (a.order||0) - (b.order||0));
      // Fix team abbreviations from PBP if box_scores didn't resolve them
      if (hA === 'HOME' || aA === 'AWAY') {
        const teams = new Set();
        plays.forEach(ev => { if (ev.team?.abbreviation) teams.add(ev.team.abbreviation); });
        const teamArr = [...teams];
        if (teamArr.length >= 2) {
          if (hA === 'HOME') hA = teamArr[0];
          if (aA === 'AWAY') aA = teamArr.find(t => t !== hA) || teamArr[1];
          winner = hPts > aPts ? hA : aA; // recalculate with real names
        }
      }
      let pendPOT = null;
      for (const ev of plays) {
        const tm = ev.team?.abbreviation || '';
        const hs = ev.home_score ?? null, as = ev.away_score ?? null;
        if (hs != null && as != null) {
          const mg = hs - as;
          if (mg > pbpBigLeadH) pbpBigLeadH = mg;
          if (-mg > pbpBigLeadA) pbpBigLeadA = -mg;
        }
        const type = (ev.type || '').toLowerCase();
        const text = (ev.text || '').toLowerCase();
        // Track turnovers for POT
        if (type.includes('turnover') || text.includes('turnover')) {
          const oppTeam = tm === hA ? aA : hA; // opponent scores off this team's TO
          pendPOT = oppTeam;
        }
        // Track scoring plays
        if (ev.scoring_play && ev.score_value > 0 && tm) {
          scoreLog.push({ team: tm, pts: ev.score_value, q: ev.period });
          // POT tracking
          if (pendPOT === tm) {
            if (tm === hA) hPot += ev.score_value; else aPot += ev.score_value;
          }
          // Paint tracking (layup, dunk, hook, float, driving)
          if (type.includes('layup') || type.includes('dunk') || type.includes('hook') ||
              type.includes('float') || type.includes('driving') || type.includes('tip') ||
              type.includes('putback')) {
            if (tm === hA) hPaint += ev.score_value; else aPaint += ev.score_value;
          } else if (ev.score_value === 2 && !type.includes('jump') && !type.includes('pullup') && !type.includes('step back')) {
            // Check distance for paint — if no "jump shot" it's likely interior
            const distMatch = (ev.type||'').match(/(\d+)-foot/);
            if (distMatch && parseInt(distMatch[1]) <= 9) {
              if (tm === hA) hPaint += ev.score_value; else aPaint += ev.score_value;
            }
          }
          if (ev.score_value === 1) { // FTs — check pending
            if (type.includes('free throw')) {
              const ftMatch = (ev.type||'').match(/(\d+)\s*of\s*(\d+)/i);
              if (ftMatch && ftMatch[1] === ftMatch[2]) { pendPOT = null; }
            }
          } else { pendPOT = null; }
        }
      }
      // Run detection at 6+ pts threshold
      let rTm = null, rPts = 0;
      for (let i = 0; i < scoreLog.length; i++) {
        const s = scoreLog[i];
        if (s.team === rTm) { rPts += s.pts; }
        else {
          if (rPts >= 6 && rTm) pbpRuns.push({ team: rTm, pts: rPts });
          rTm = s.team; rPts = s.pts;
        }
      }
      if (rPts >= 6 && rTm) pbpRuns.push({ team: rTm, pts: rPts });
    } catch(e) { /* PBP fetch failed — degrade gracefully */ }
    await delay(150);

    // Use PBP biggest_lead
    const finalBigLeadH = pbpBigLeadH || 0;
    const finalBigLeadA = pbpBigLeadA || 0;

    // Quarter scores for I4 lastQ
    const lastQH = Number(g['home_q4'] || g['home_ot1'] || 0);
    const lastQA = Number(g['visitor_q4'] || g['visitor_ot1'] || 0);
    const lastQDiff = lastQH - lastQA;

    // === OLD INDICATORS ===
    // I1 old: gen + conv (FBP always 0 from BDL)
    const hGen = hStl + hOreb - hTo, aGen = aStl + aOreb - aTo;
    const hConv = hPot, aConv = aPot; // FBP=0 from BDL, SCP hard to get
    const i1old_raw = (hGen>aGen?1:hGen<aGen?-1:0) + (hConv>aConv?1:hConv<aConv?-1:0);
    const oldI1 = i1old_raw > 0 ? 1 : i1old_raw === 0 ? 0.5 : 0;

    // I2 old: rimScore composite
    const rimScore = (hPaint+hFta+hBlk) - (aPaint+aFta+aBlk);
    const oldI2 = rimScore > 8 ? 1 : rimScore < -8 ? 0 : 0.5;

    // I3: eFG% + assist ratio (unchanged)
    const hEFG = hFga > 0 ? (hFgm + 0.5*hFg3m)/hFga : 0;
    const aEFG = aFga > 0 ? (aFgm + 0.5*aFg3m)/aFga : 0;
    const hAR = hFgm > 0 ? hAst/hFgm*100 : 0;
    const aAR = aFgm > 0 ? aAst/aFgm*100 : 0;
    const i3raw = (hEFG>aEFG+0.02?1:hEFG<aEFG-0.02?-1:0) + (hAR>aAR+5?1:hAR<aAR-5?-1:0);
    const I3 = i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0;

    // I4 old: score diff proxy (no biggest_lead from BDL box_scores)
    const scoreDiff = Math.abs(hPts - aPts);
    const i4old_raw = scoreDiff > 8 ? (hPts > aPts ? 1 : -1) : 0;
    const oldI4 = i4old_raw > 0 ? 1 : i4old_raw === 0 ? 0.5 : 0;

    // I5 old: effD (broken — ratings not available from player aggregation)
    const oldI5 = 0.5; // Always EVEN — effD formula is broken per blueprint

    // === NEW INDICATORS ===
    // I1 new: disruption(stl+blk ±1) + POT(±4)
    const disruptDiff = (hStl+hBlk) - (aStl+aBlk);
    const i1subA = disruptDiff > 1 ? 1 : disruptDiff < -1 ? -1 : 0;
    const potDiff = hPot - aPot;
    const i1subB = potDiff > 4 ? 1 : potDiff < -4 ? -1 : 0;
    const newI1 = (i1subA+i1subB) > 0 ? 1 : (i1subA+i1subB) === 0 ? 0.5 : 0;

    // I2 new: paint ±6 + rimFG% ±10%
    const paintDiff = hPaint - aPaint;
    const i2subA = paintDiff > 6 ? 1 : paintDiff < -6 ? -1 : 0;
    // No at-rim from BDL box scores — use paint proxy
    const newI2 = i2subA > 0 ? 1 : i2subA === 0 ? 0.5 : 0; // Sub-B often 0 without at-rim

    // I4 new: biggestLead(PBP) ±4 + lastQ ±2
    const bigLeadDiff = finalBigLeadH - finalBigLeadA;
    const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
    const i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
    const newI4 = (i4subA+i4subB) > 0 ? 1 : (i4subA+i4subB) === 0 ? 0.5 : 0;
    const newI4blOnly = i4subA > 0 ? 1 : i4subA === 0 ? 0.5 : 0;

    // I5 new: runShare (6+ pts)
    const hRuns6 = pbpRuns.filter(r=>r.team===hA).length;
    const aRuns6 = pbpRuns.filter(r=>r.team===aA).length;
    const totalRuns6 = hRuns6 + aRuns6;
    let newI5 = 0.5;
    let newI5_55 = 0.5;
    let newI5_575 = 0.5;
    if (totalRuns6 >= 4) {
      const rs = hRuns6 / totalRuns6;
      newI5 = rs > 0.60 ? 1 : rs < 0.40 ? 0 : 0.5;
      newI5_55 = rs > 0.55 ? 1 : rs < 0.45 ? 0 : 0.5;
      newI5_575 = rs > 0.575 ? 1 : rs < 0.425 ? 0 : 0.5;
    }

    results.push({
      date: g._date, matchup: aA+'@'+hA, winner, hPts, aPts,
      finalBigLeadH, finalBigLeadA, hRuns6, aRuns6, totalRuns6,
      oldI1, oldI2, I3, oldI4, oldI5,
      newI1, newI2, newI4, newI4blOnly, newI5, newI5_55, newI5_575,
      disruptDiff, potDiff, bigLeadDiff, lastQDiff, paintDiff: hPaint-aPaint,
      hPot, aPot, hPaint, aPaint,
    });

    if ((gi+1) % 10 === 0) console.log('Processed', gi+1, '/', allGames.length);
  }

  console.log('%c\n═══ RESULTS: '+results.length+' games ═══','font-weight:bold;color:#00ff88;font-size:14px');

  // === PER-INDICATOR ACCURACY ===
  function indAcc(field) {
    let correct = 0, decisive = 0, even = 0;
    for (const r of results) {
      const v = r[field];
      if (v === 0.5) { even++; continue; }
      decisive++;
      const indWin = v > 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
      if (indWin === r.winner) correct++;
    }
    return { pct: decisive > 0 ? (correct/decisive*100).toFixed(1)+'%' : 'N/A', correct, decisive, even };
  }

  console.log('%c\nPER-INDICATOR ACCURACY','font-weight:bold;color:#a78bfa');
  const indFields = ['oldI1','newI1','oldI2','newI2','I3','oldI4','newI4','newI4blOnly','oldI5','newI5','newI5_575','newI5_55'];
  const indTable = {};
  indFields.forEach(f => { indTable[f] = indAcc(f); });
  console.table(indTable);

  // === WEIGHT SIMS ===
  const weightSets = [
    { name: 'BASELINE old 25/25/20/20/10', inds: ['oldI1','oldI2','I3','oldI4','oldI5'], w: [0.25,0.25,0.20,0.20,0.10] },
    { name: 'NEW old-wt 25/25/20/20/10', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.25,0.25,0.20,0.20,0.10] },
    { name: 'NEW 15/20/20/20/25', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.15,0.20,0.20,0.20,0.25] },
    { name: 'NEW EQUAL 20/20/20/20/20', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.20,0.20,0.20,0.20,0.20] },
    { name: 'NEW I4-HEAVY 15/20/20/25/20', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.15,0.20,0.20,0.25,0.20] },
    { name: 'NEW I4-MAX 10/20/20/25/25', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.10,0.20,0.20,0.25,0.25] },
    { name: 'NEW I5-HEAVY 15/20/20/15/30', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.15,0.20,0.20,0.15,0.30] },
    { name: 'NEW I345 10/15/25/25/25', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.10,0.15,0.25,0.25,0.25] },
    { name: 'NEW I4=30 10/15/20/30/25', inds: ['newI1','newI2','I3','newI4','newI5'], w: [0.10,0.15,0.20,0.30,0.25] },
    { name: 'I4=30 I5@57.5/42.5', inds: ['newI1','newI2','I3','newI4','newI5_575'], w: [0.10,0.15,0.20,0.30,0.25] },
    { name: 'I4=30 I5@55/45', inds: ['newI1','newI2','I3','newI4','newI5_55'], w: [0.10,0.15,0.20,0.30,0.25] },
  ];

  console.log('%c\nWEIGHT SIMS','font-weight:bold;color:#ffd166');
  const wsTable = {};
  for (const ws of weightSets) {
    let correct = 0, total = 0, decisive = 0;
    for (const r of results) {
      const raw = r[ws.inds[0]]*ws.w[0] + r[ws.inds[1]]*ws.w[1] + r[ws.inds[2]]*ws.w[2] + r[ws.inds[3]]*ws.w[3] + r[ws.inds[4]]*ws.w[4];
      const ctrlHome = raw >= 0.5;
      const ctrlTeam = raw === 0.5 ? 'EVEN' : ctrlHome ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
      if (ctrlTeam !== 'EVEN') { total++; decisive++; if (ctrlTeam === r.winner) correct++; }
      else { total++; } // 50/50 — count as wrong
    }
    wsTable[ws.name] = { accuracy: (correct/total*100).toFixed(1)+'%', correct, total, decisive };
  }
  console.table(wsTable);

  // === 2-INDICATOR COMBOS ===
  console.log('%c\n2-INDICATOR COMBOS (new indicators)','font-weight:bold;color:#ff8c42');
  const pairs = [['newI1','newI2'],['newI1','I3'],['newI1','newI4'],['newI1','newI5'],
    ['newI2','I3'],['newI2','newI4'],['newI2','newI5'],['I3','newI4'],['I3','newI5'],['newI4','newI5']];
  const comboTable = {};
  for (const [a, b] of pairs) {
    let correct = 0, agree = 0;
    for (const r of results) {
      if (r[a] === 0.5 || r[b] === 0.5) continue;
      const wa = r[a] > 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
      const wb = r[b] > 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
      if (wa === wb) { agree++; if (wa === r.winner) correct++; }
    }
    comboTable[a+'+'+b] = { accuracy: agree > 0 ? (correct/agree*100).toFixed(1)+'%' : 'N/A', agree, correct };
  }
  console.table(comboTable);

  // === WRONG GAMES DETAIL ===
  console.log('%c\nWRONG GAMES (new 15/20/20/20/25)','font-weight:bold;color:#ff5252');
  for (const r of results) {
    const raw = r.newI1*0.15 + r.newI2*0.20 + r.I3*0.20 + r.newI4*0.20 + r.newI5*0.25;
    const ctrlTeam = raw >= 0.5 ? r.matchup.split('@')[1] : r.matchup.split('@')[0];
    if (ctrlTeam !== r.winner) {
      console.log(r.date, r.matchup, 'ctrl:'+ctrlTeam, 'won:'+r.winner,
        'floor:'+raw.toFixed(2),
        'I1:'+r.newI1, 'I2:'+r.newI2, 'I3:'+r.I3, 'I4:'+r.newI4, 'I5:'+r.newI5,
        'bigLead:'+r.finalBigLeadH+'-'+r.finalBigLeadA, 'runs:'+r.hRuns6+'-'+r.aRuns6);
    }
  }

  // === DATA QUALITY CHECK ===
  const noBigLead = results.filter(r => r.finalBigLeadH === 0 && r.finalBigLeadA === 0).length;
  const noRuns = results.filter(r => r.totalRuns6 === 0).length;
  console.log('%c\nDATA QUALITY','font-weight:bold;color:#9382dc');
  console.log('Games missing biggestLead:', noBigLead, '/', results.length);
  console.log('Games with 0 runs (6+):', noRuns, '/', results.length);
  console.log('I5 EVEN @60/40:', results.filter(r=>r.newI5===0.5).length, '/', results.length);
  console.log('I5 EVEN @57.5/42.5:', results.filter(r=>r.newI5_575===0.5).length, '/', results.length);
  console.log('I5 EVEN @55/45:', results.filter(r=>r.newI5_55===0.5).length, '/', results.length);
  console.log('I4 EVEN:', results.filter(r=>r.newI4===0.5).length, '/', results.length);
  console.log('Games with "AWAY" in matchup:', results.filter(r=>r.matchup.includes('AWAY')||r.matchup.includes('HOME')).length);

  console.log('%c\n═══ SIM COMPLETE ═══','font-weight:bold;color:#00ff88;font-size:14px');
})();
