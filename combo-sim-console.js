// INDICATOR COMBO ANALYSIS — paste into browser console on DFT dashboard
// Fetches BDL box scores + plays for historical games, computes new I1-I5, measures combo win rates
(async function() {
  const BDL_KEY = 'ee78e074-2f89-4ee5-807a-181fc324398c';
  const FN = '/.netlify/functions/';
  const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
  const DAYS = 30; // how many days back to scan

  async function bdl(path) {
    const r = await fetch('https://api.balldontlie.io' + path, { headers: { Authorization: BDL_KEY } });
    if (!r.ok) throw new Error(`BDL ${r.status}`);
    return r.json();
  }

  // 1. Get finished games from DB
  console.log('Fetching games from DB...');
  const gamesResp = await fetch(FN + 'db-api?action=get_alerts&limit=1').then(r => r.json());
  // Actually, let's just scan BDL directly for finished games
  const allGames = [];
  const today = new Date();

  for (let d = 1; d <= DAYS; d++) {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - d);
    const ds = dt.toISOString().split('T')[0];

    let boxData;
    try {
      boxData = await bdl(`/nba/v1/box_scores?date=${ds}`);
    } catch(e) { console.log(`${ds}: box_scores failed`); continue; }
    await new Promise(r => setTimeout(r, 150));

    const games = (boxData.data || []).filter(g =>
      g.status === 'Final' && g.home_team_score > 0 && g.visitor_team_score > 0
    );

    for (const g of games) {
      const hA = g.home_team?.team?.abbreviation || g.home_team?.abbreviation || '';
      const aA = g.visitor_team?.team?.abbreviation || g.visitor_team?.abbreviation || g.away_team?.abbreviation || '';
      if (!hA || !aA) continue;

      allGames.push({
        id: g.id, date: ds, hA, aA,
        hPts: g.home_team_score, aPts: g.visitor_team_score,
        winner: g.home_team_score > g.visitor_team_score ? hA : aA,
        homePlayers: g.home_team?.players || [],
        awayPlayers: g.visitor_team?.players || [],
        periods: g.periods || [],
      });
    }
    console.log(`${ds}: ${games.length} games`);
  }

  console.log(`\nTotal games: ${allGames.length}. Fetching PBP for each...`);

  const results = [];
  let fetched = 0;

  for (const game of allGames) {
    // Aggregate player stats
    const sum = (players, key) => players.reduce((a, p) => a + (p[key] || 0), 0);
    const hP = game.homePlayers, aP = game.awayPlayers;

    const h = {
      stl: sum(hP,'stl'), blk: sum(hP,'blk'), oreb: sum(hP,'oreb'),
      to: sum(hP,'turnover'), fta: sum(hP,'fta'), ftm: sum(hP,'ftm'),
      fgm: sum(hP,'fgm'), fga: sum(hP,'fga'),
      fg3m: sum(hP,'fg3m'), fg3a: sum(hP,'fg3a'),
      ast: sum(hP,'ast'), pts: sum(hP,'pts'),
    };
    const a = {
      stl: sum(aP,'stl'), blk: sum(aP,'blk'), oreb: sum(aP,'oreb'),
      to: sum(aP,'turnover'), fta: sum(aP,'fta'), ftm: sum(aP,'ftm'),
      fgm: sum(aP,'fgm'), fga: sum(aP,'fga'),
      fg3m: sum(aP,'fg3m'), fg3a: sum(aP,'fg3a'),
      ast: sum(aP,'ast'), pts: sum(aP,'pts'),
    };

    // Fetch PBP for paint, rim, biggest_lead, runs
    let plays = [];
    try {
      const pbpResp = await bdl(`/nba/v1/plays?game_id=${game.id}&per_page=500`);
      plays = pbpResp.data || [];
    } catch(e) { /* continue without PBP */ }
    await new Promise(r => setTimeout(r, 120));
    fetched++;
    if (fetched % 20 === 0) console.log(`  ...fetched PBP for ${fetched}/${allGames.length}`);

    // Parse PBP for paint, rim, biggest_lead, runs, POT, SCP
    let hPaint = 0, aPaint = 0, hRimM = 0, hRimA = 0, aRimM = 0, aRimA = 0;
    let hBigLead = 0, aBigLead = 0, hPOT = 0, aPOT = 0;
    let hScore = 0, aScore = 0;
    const scoreLog = [];
    // Runs
    let runTeam = null, runPts = 0;
    const runs6 = [];

    for (const p of plays) {
      const team = p.team?.abbreviation || '';
      const pts = p.scoring_play ? (p.points_scored || 0) : 0;
      const desc = (p.play_type || p.description || '').toLowerCase();
      const period = p.period || 0;

      if (pts > 0) {
        if (team === game.hA) hScore += pts; else aScore += pts;
        scoreLog.push({ team, pts, q: period, hScore, aScore });

        const margin = hScore - aScore;
        if (margin > hBigLead) hBigLead = margin;
        if (-margin > aBigLead) aBigLead = -margin;

        // Paint/rim classification
        const isRim = desc.includes('dunk') || desc.includes('layup') || desc.includes('tip');
        const isPaint = isRim || (desc.includes('paint') || (desc.includes('hook') || desc.includes('floater')));
        if (isPaint && pts === 2) {
          if (team === game.hA) { hPaint += 2; if (isRim) hRimM++; }
          else { aPaint += 2; if (isRim) aRimM++; }
        }

        // Runs
        if (team === runTeam) { runPts += pts; }
        else { if (runPts >= 6 && runTeam) runs6.push({ team: runTeam }); runTeam = team; runPts = pts; }
      }

      // Rim attempts (missed shots at rim)
      if (desc.includes('miss') && (desc.includes('dunk') || desc.includes('layup') || desc.includes('tip'))) {
        if (team === game.hA) hRimA++; else aRimA++;
      }

      // POT
      if (desc.includes('turnover') || p.play_type === 'turnover') {
        // Next scoring play by opponent = POT (simplified)
      }
    }
    if (runPts >= 6 && runTeam) runs6.push({ team: runTeam });
    hRimA += hRimM; // total attempts = makes + misses
    aRimA += aRimM;

    // POT from BDL (use team-level if available, otherwise estimate)
    // BDL box_scores don't have team POT directly, but plays analysis can approximate
    // For now, use a simplified approach: count scoring plays immediately after opponent TO
    let lastTO = null;
    for (const p of plays) {
      const team = p.team?.abbreviation || '';
      const desc = (p.play_type || p.description || '').toLowerCase();
      if (desc.includes('turnover') || p.play_type === 'turnover') {
        lastTO = team;
      } else if (p.scoring_play && lastTO && team !== lastTO) {
        if (team === game.hA) hPOT += (p.points_scored || 0);
        else aPOT += (p.points_scored || 0);
        lastTO = null;
      } else if (p.scoring_play) {
        lastTO = null;
      }
    }

    // === COMPUTE INDICATORS ===

    // I1 — Disruption (stl+blk ±1) + POT (±4)
    const hDisrupt = h.stl + h.blk, aDisrupt = a.stl + a.blk;
    const i1subA = (hDisrupt - aDisrupt) > 1 ? 1 : (hDisrupt - aDisrupt) < -1 ? -1 : 0;
    const i1subB = (hPOT - aPOT) > 4 ? 1 : (aPOT - hPOT) > 4 ? -1 : 0;
    const I1 = (i1subA + i1subB) > 0 ? 1 : (i1subA + i1subB) === 0 ? 0.5 : 0;

    // I2 — Interior (paint ±6, rim FG% ±10%)
    const paintDiff = hPaint - aPaint;
    const i2subA = paintDiff > 6 ? 1 : paintDiff < -6 ? -1 : 0;
    const hRimPct = hRimA >= 6 ? hRimM / hRimA : null;
    const aRimPct = aRimA >= 6 ? aRimM / aRimA : null;
    let i2subB = 0;
    if (hRimPct != null && aRimPct != null) {
      if (hRimPct - aRimPct > 0.10) i2subB = 1;
      else if (aRimPct - hRimPct > 0.10) i2subB = -1;
    }
    const I2 = (i2subA + i2subB) > 0 ? 1 : (i2subA + i2subB) < 0 ? 0 : 0.5;

    // I3 — Shot Quality (eFG% ±2%, assist ratio ±5%)
    const hEFG = (h.fgm + 0.5 * h.fg3m) / (h.fga || 1);
    const aEFG = (a.fgm + 0.5 * a.fg3m) / (a.fga || 1);
    const hAR = (h.ast / (h.fgm || 1)) * 100;
    const aAR = (a.ast / (a.fgm || 1)) * 100;
    const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
                + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
    const I3 = i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0;

    // I4 — Game Control (biggest_lead ±4 + Q4 margin ±2)
    const blDiff = hBigLead - aBigLead;
    const i4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
    let i4subB = 0;
    const q4plays = scoreLog.filter(s => s.q === 4);
    if (q4plays.length > 0) {
      let q4h = 0, q4a = 0;
      q4plays.forEach(s => { if (s.team === game.hA) q4h += s.pts; else q4a += s.pts; });
      const q4diff = q4h - q4a;
      i4subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
    }
    const I4 = (i4subA + i4subB) > 0 ? 1 : (i4subA + i4subB) === 0 ? 0.5 : 0;

    // I5 — Run share
    let I5 = 0.5;
    const hRuns = runs6.filter(r => r.team === game.hA).length;
    const aRuns = runs6.filter(r => r.team === game.aA).length;
    const totalRuns = hRuns + aRuns;
    if (totalRuns >= 4) {
      const rs = hRuns / totalRuns;
      I5 = rs > 0.55 ? 1 : rs < 0.45 ? 0 : 0.5;
    }

    // Composite
    const composite = I1*W.I1 + I2*W.I2 + I3*W.I3 + I4*W.I4 + I5*W.I5;
    const ctrlHome = composite >= 0.5;
    const ctrlTeam = ctrlHome ? game.hA : game.aA;
    const floor = ctrlHome ? composite : 1 - composite;

    // Which indicators does ctrl team win?
    const indScores = { I1, I2, I3, I4, I5 };
    const wins = [], loses = [];
    for (const [k, v] of Object.entries(indScores)) {
      const ctrlScore = ctrlHome ? v : 1 - v;
      if (ctrlScore > 0.5) wins.push(k);
      else if (ctrlScore < 0.5) loses.push(k);
    }

    results.push({
      matchup: `${game.aA}@${game.hA}`, date: game.date,
      floor: Math.round(floor * 100) / 100,
      ctrlTeam, winner: game.winner,
      ctrlWon: game.winner === ctrlTeam,
      combo: wins.length > 0 ? wins.join('+') : 'NONE',
      indWon: wins.length, wins, loses,
      I1, I2, I3, I4, I5,
      raw: { hPaint, aPaint, hRimM, hRimA, aRimM, aRimA, hBigLead, aBigLead, hPOT, aPOT, hRuns, aRuns, totalRuns }
    });
  }

  // === ANALYSIS ===
  console.log(`\n═══ COMBO ANALYSIS: ${results.length} games ═══\n`);

  // By count
  const byCount = {};
  results.forEach(g => {
    const k = g.indWon;
    if (!byCount[k]) byCount[k] = { count: k, total: 0, won: 0 };
    byCount[k].total++;
    if (g.ctrlWon) byCount[k].won++;
  });
  console.log('BY INDICATOR COUNT:');
  console.table(Object.values(byCount).sort((a,b) => a.count - b.count).map(c => ({
    indicators: c.count, total: c.total, won: c.won, pct: Math.round(c.won/c.total*100) + '%'
  })));

  // By single indicator
  const singles = {};
  for (const ind of ['I1','I2','I3','I4','I5']) {
    singles[ind] = { won: 0, wonCtrl: 0, lost: 0, lostCtrl: 0, even: 0, evenCtrl: 0 };
  }
  results.forEach(g => {
    g.wins.forEach(w => { singles[w].won++; if (g.ctrlWon) singles[w].wonCtrl++; });
    g.loses.forEach(l => { singles[l].lost++; if (g.ctrlWon) singles[l].lostCtrl++; });
    ['I1','I2','I3','I4','I5'].forEach(ind => {
      if (!g.wins.includes(ind) && !g.loses.includes(ind)) {
        singles[ind].even++;
        if (g.ctrlWon) singles[ind].evenCtrl++;
      }
    });
  });
  console.log('\nPER-INDICATOR:');
  console.table(Object.entries(singles).map(([ind, s]) => ({
    ind,
    won: s.won, wonPct: s.won > 0 ? Math.round(s.wonCtrl/s.won*100)+'%' : '-',
    lost: s.lost, lostPct: s.lost > 0 ? Math.round(s.lostCtrl/s.lost*100)+'%' : '-',
    even: s.even, evenPct: s.even > 0 ? Math.round(s.evenCtrl/s.even*100)+'%' : '-',
  })));

  // By pair
  const pairs = {};
  results.forEach(g => {
    for (let i = 0; i < g.wins.length; i++) {
      for (let j = i + 1; j < g.wins.length; j++) {
        const pk = g.wins[i] + '+' + g.wins[j];
        if (!pairs[pk]) pairs[pk] = { pair: pk, total: 0, won: 0 };
        pairs[pk].total++;
        if (g.ctrlWon) pairs[pk].won++;
      }
    }
  });
  console.log('\nPAIRWISE COMBOS:');
  console.table(Object.values(pairs).sort((a,b) => b.total - a.total).map(p => ({
    pair: p.pair, total: p.total, won: p.won, pct: Math.round(p.won/p.total*100) + '%'
  })));

  // Top exact combos
  const combos = {};
  results.forEach(g => {
    if (!combos[g.combo]) combos[g.combo] = { combo: g.combo, total: 0, won: 0 };
    combos[g.combo].total++;
    if (g.ctrlWon) combos[g.combo].won++;
  });
  console.log('\nEXACT COMBOS (sorted by count):');
  console.table(Object.values(combos).sort((a,b) => b.total - a.total).map(c => ({
    combo: c.combo, total: c.total, won: c.won, pct: Math.round(c.won/c.total*100) + '%'
  })));

  // Data quality check
  const i2decisive = results.filter(g => g.I2 !== 0.5).length;
  const i4decisive = results.filter(g => g.I4 !== 0.5).length;
  const i5decisive = results.filter(g => g.I5 !== 0.5).length;
  const avgPaint = results.reduce((a,g) => a + Math.abs(g.raw.hPaint - g.raw.aPaint), 0) / results.length;
  const avgBigLead = results.reduce((a,g) => a + Math.abs(g.raw.hBigLead - g.raw.aBigLead), 0) / results.length;
  console.log('\nDATA QUALITY:');
  console.log(`I2 decisive: ${i2decisive}/${results.length} (${Math.round(i2decisive/results.length*100)}%)`);
  console.log(`I4 decisive: ${i4decisive}/${results.length} (${Math.round(i4decisive/results.length*100)}%)`);
  console.log(`I5 decisive: ${i5decisive}/${results.length} (${Math.round(i5decisive/results.length*100)}%)`);
  console.log(`Avg paint diff: ${avgPaint.toFixed(1)}`);
  console.log(`Avg biggest_lead diff: ${avgBigLead.toFixed(1)}`);
  console.log(`Avg runs per game: ${(results.reduce((a,g) => a + g.raw.totalRuns, 0) / results.length).toFixed(1)}`);

  // Store globally for inspection
  window._comboResults = results;
  console.log('\nResults stored in window._comboResults for inspection');
})();
