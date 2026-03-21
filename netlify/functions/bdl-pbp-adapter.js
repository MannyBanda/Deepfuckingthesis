// ══════════════════════════════════════════════════════════════════════════════
// BDL PBP ADAPTER — Drop-in replacement for SR parsePBP()
// Produces identical output shape for compute() pipeline compatibility
//
// Functions:
//   coordinateToZone(x, y, shotType, text, scoreValue)
//   parseBDLPBP(plays, homeAbbr, awayAbbr, starters)
//   buildPossessionLogBDL(timeline, hA, aA)  [reuses existing logic]
//
// Copy this block into index.html / ncaamb.html / poll-live.mjs
// ══════════════════════════════════════════════════════════════════════════════

// ── ZONE CONSTANTS (calibrated from probe: basket at ~(25, 1.5), half-court) ──
var BDL_BASKET_X = 25;
var BDL_BASKET_Y = 1.5;
var BDL_RIM_RADIUS = 4;       // ft — layups/dunks cluster here
var BDL_PAINT_RADIUS = 9;     // ft — floaters, hooks, short jumpers
var BDL_THREE_RADIUS = 22;    // ft — NBA 3PT arc (corner is 22ft, above-break 23.75ft)
var BDL_CORNER_Y_MAX = 9;     // y < 9 = near baseline = corner territory

// Sentinel check — BDL uses INT_MIN for non-shooting events
function bdlCoordsValid(x, y) {
  return x != null && y != null && x > -1000 && y > -1000 && x < 1000 && y < 1000;
}

function bdlDistFromBasket(x, y) {
  return Math.sqrt(Math.pow(x - BDL_BASKET_X, 2) + Math.pow(y - BDL_BASKET_Y, 2));
}

// ── SHOT TYPE CLASSIFICATION MAPS ──
var BDL_RIM_TYPES = [
  'layup shot', 'driving layup shot', 'running layup shot', 'cutting layup shot',
  'reverse layup shot', 'finger roll layup', 'layup shot putback', 'putback layup shot',
  'driving reverse layup shot', 'running reverse layup shot',
  'dunk shot', 'driving dunk shot', 'running dunk shot', 'cutting dunk shot',
  'alley oop dunk shot', 'putback dunk shot', 'running alley oop dunk shot',
  'tip shot', 'tip dunk shot',
];
var BDL_PAINT_TYPES = [
  'driving floating jump shot', 'floating jump shot',
  'driving hook shot', 'hook shot', 'running hook shot',
  'driving finger roll layup', 'turnaround hook shot',
];
var BDL_RIM_SET = null;
var BDL_PAINT_SET = null;

function ensureTypeSets() {
  if (!BDL_RIM_SET) {
    BDL_RIM_SET = new Set(BDL_RIM_TYPES);
    BDL_PAINT_SET = new Set(BDL_PAINT_TYPES);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// coordinateToZone — 3-layer classification: type → coords → text fallback
// ══════════════════════════════════════════════════════════════════════════════
function coordinateToZone(x, y, shotType, text, scoreValue) {
  ensureTypeSets();
  var typeLower = (shotType || '').toLowerCase().trim();
  var textLower = (text || '').toLowerCase();
  var isThree = scoreValue === 3 || textLower.includes('three point');

  // Layer 1: Type field — definitive classification
  if (BDL_RIM_SET.has(typeLower)) return 'rim';
  if (BDL_PAINT_SET.has(typeLower)) return 'paint';

  // If it's a three, classify corner vs above-break
  if (isThree) {
    if (bdlCoordsValid(x, y) && y < BDL_CORNER_Y_MAX) return 'corner3';
    return 'above3';
  }

  // Layer 2: Coordinates — for everything not caught by type
  if (bdlCoordsValid(x, y)) {
    var dist = bdlDistFromBasket(x, y);
    if (dist < BDL_RIM_RADIUS) return 'rim';
    if (dist < BDL_PAINT_RADIUS) return 'paint';
    if (dist >= BDL_THREE_RADIUS) {
      // Coordinate says 3PT range but score_value isn't 3 — trust coords for zone
      if (y < BDL_CORNER_Y_MAX) return 'corner3';
      return 'above3';
    }
    return 'mid';
  }

  // Layer 3: Text fallback — parse distance from text
  var distMatch = textLower.match(/(\d+)-foot/);
  if (distMatch) {
    var dist = parseInt(distMatch[1]);
    if (dist <= 4) return 'rim';
    if (dist <= 9) return 'paint';
    if (dist >= 22) return 'above3'; // can't distinguish corner without coords
    return 'mid';
  }

  // Default: if type contains keywords
  if (typeLower.includes('layup') || typeLower.includes('dunk') || typeLower.includes('tip')) return 'rim';
  if (typeLower.includes('hook') || typeLower.includes('float')) return 'paint';

  return 'mid'; // safe default for unclassified shots
}

// ══════════════════════════════════════════════════════════════════════════════
// TEXT PARSING HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// Extract primary player name from BDL text field
// "Jalen Brunson misses 23-foot running jump shot" → "Jalen Brunson"
// "Karl-Anthony Towns makes 3-foot driving layup" → "Karl-Anthony Towns"
// "Nolan Traore bad pass\nturnover (Landry Shamet steals)" → "Nolan Traore"
function bdlExtractPlayer(text) {
  if (!text) return '?';
  // Clean up newlines
  var clean = text.replace(/\n/g, ' ').trim();
  // Pattern: Name + verb (makes, misses, personal foul, bad pass, etc.)
  var m = clean.match(/^([A-Z][a-zA-Z'.]+(?:[\s-][A-Z][a-zA-Z'.]+)*(?:\s+(?:Jr\.|Sr\.|III|II|IV))?)\s+(?:makes|misses|personal|shooting|loose|bad|offensive|defensive|lost|out|traveling|turnover|flagrant|double|blocks|steals|enters|steps|kicked)/i);
  if (m) return m[1].trim();
  // Fallback: take everything before "makes" or "misses" or first verb-like word
  var m2 = clean.match(/^(.+?)\s+(?:makes|misses|personal|shooting|offensive|defensive|bad|loose|lost|blocks|steals)/i);
  if (m2) return m2[1].trim();
  return clean.split(/\s+/).slice(0, 2).join(' ');
}

// Extract assist player: "(Player assists)"
function bdlExtractAssist(text) {
  if (!text) return null;
  var m = text.match(/\(([^)]+?)\s+assists?\)/i);
  return m ? m[1].trim() : null;
}

// Extract block player: "blocks Player's" or "(Player blocks)"
function bdlExtractBlock(text) {
  if (!text) return null;
  var m = text.match(/\(([^)]+?)\s+blocks?\)/i);
  if (m) return m[1].trim();
  var m2 = text.match(/([A-Z][a-zA-Z'.]+(?:[\s-][A-Z][a-zA-Z'.]+)*)\s+blocks\s/i);
  return m2 ? m2[1].trim() : null;
}

// Extract steal player: "(Player steals)"
function bdlExtractSteal(text) {
  if (!text) return null;
  var m = text.match(/\(([^)]+?)\s+steals?\)/i);
  return m ? m[1].trim() : null;
}

// Extract foul drawn player from text
function bdlExtractFoulDrawn(text) {
  if (!text) return null;
  var m = text.match(/\(([^)]+?)\s+draws\s+the\s+foul\)/i);
  return m ? m[1].trim() : null;
}

// Extract shot distance from text: "23-foot" → 23
function bdlExtractDistance(text) {
  if (!text) return null;
  var m = text.match(/(\d+)-foot/i);
  return m ? parseInt(m[1]) : null;
}

// Classify shot context from BDL type field
function bdlClassifyContext(type, assisted, isThree) {
  var t = (type || '').toLowerCase();
  if (t.includes('driving') || t.includes('layup') || t.includes('dunk')) return 'drive';
  if (t.includes('pullup') || t.includes('pull-up') || t.includes('step back') || t.includes('fadeaway') || t.includes('fade away')) return 'pullup';
  if (t.includes('putback') || t.includes('tip')) return 'putback';
  if (t.includes('cutting') || t.includes('alley')) return 'cut';
  if (t.includes('hook') || t.includes('float') || t.includes('runner')) return 'floater';
  if (t.includes('running') && !t.includes('pullup')) return 'transition';
  if (assisted && isThree) return 'catch-shoot';
  return 'halfcourt';
}

// Classify turnover type from BDL type + text
function bdlClassifyTO(type, text) {
  var t = (type || '').toLowerCase();
  var tx = (text || '').toLowerCase();
  // Forced turnovers (defensive play caused it)
  if (t.includes('bad pass') || tx.includes('steal') || t.includes('lost ball')) {
    // Bad pass + steal = forced. Lost ball could be either.
    if (tx.includes('steal')) return { forced: true, type: t };
    if (t.includes('bad pass')) return { forced: true, type: t };
    return { forced: null, type: t };
  }
  // Unforced turnovers (self-inflicted)
  if (t.includes('traveling') || t.includes('out of bounds') || t.includes('3-second') ||
      t.includes('shot clock') || t.includes('offensive foul') || t.includes('double dribble') ||
      t.includes('backcourt') || t.includes('5-second') || t.includes('kicked ball')) {
    return { forced: false, type: t };
  }
  // Steals embedded in text = forced
  if (tx.includes('steal')) return { forced: true, type: t };
  return { forced: null, type: t };
}

// ══════════════════════════════════════════════════════════════════════════════
// LINEUP TRACKER — maintains running 5-man lineup from starters + substitutions
// ══════════════════════════════════════════════════════════════════════════════
function createLineupTracker(starters, homeAbbr, awayAbbr) {
  // starters: array of {player: {first_name, last_name, id}, starter: bool, team: {abbreviation}}
  var home5 = [];
  var away5 = [];
  if (starters && starters.length > 0) {
    starters.forEach(function(s) {
      if (!s.starter) return;
      var name = (s.player?.first_name || '') + ' ' + (s.player?.last_name || '');
      name = name.trim() || '?';
      var abbr = s.team?.abbreviation || '';
      if (abbr === homeAbbr) home5.push(name);
      else if (abbr === awayAbbr) away5.push(name);
    });
  }

  return {
    home: home5.slice(),
    away: away5.slice(),
    // Process a substitution event
    processSub: function(text, teamAbbr) {
      if (!text) return;
      // BDL sub format: "Player A enters the game for Player B"
      var m = text.match(/^(.+?)\s+enters\s+the\s+game\s+for\s+(.+?)$/i);
      if (!m) {
        // Try alternate: "Player A enters for Player B"
        m = text.match(/^(.+?)\s+enters\s+(?:the\s+game\s+)?for\s+(.+?)$/i);
      }
      if (!m) return;
      var entering = m[1].trim();
      var leaving = m[2].trim();
      var roster = teamAbbr === homeAbbr ? this.home : this.away;
      // Remove leaving player
      var idx = roster.indexOf(leaving);
      if (idx >= 0) roster.splice(idx, 1);
      // Add entering player (avoid duplicates)
      if (roster.indexOf(entering) < 0) roster.push(entering);
      // Clamp to 5 (safety)
      if (roster.length > 5) roster.splice(0, roster.length - 5);
    },
    // Get current on-court for an event
    getOnCourt: function() {
      return { home: this.home.slice(), away: this.away.slice() };
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// parseBDLPBP — Main parser, produces identical shape to SR parsePBP()
//
// Input:
//   plays    — BDL /plays array (490 events for a full game)
//   homeAbbr — e.g. "BKN"
//   awayAbbr — e.g. "NYK"
//   starters — BDL /lineups array (20 records with starter flag), optional
//
// Output: same shape as parsePBP() — see return at bottom
// ══════════════════════════════════════════════════════════════════════════════
function parseBDLPBP(plays, homeAbbr, awayAbbr, starters) {
  if (!plays || !Array.isArray(plays) || plays.length === 0) {
    return { home: null, away: null, homeAlias: homeAbbr, awayAlias: awayAbbr,
             totalShots: 0, totalTOs: 0, runs: [], raw: { shots: [], turnovers: [] },
             scoringEvents: [], possessionLog: [], timeline: [] };
  }

  var hA = homeAbbr;
  var aA = awayAbbr;

  // Initialize lineup tracker
  var lineups = createLineupTracker(starters || [], hA, aA);

  // ── ENRICHED TIMELINE ──
  var shots = [], turnovers = [], scoreLog = [], scoringEvents = [], timeline = [];
  var hScore = 0, aScore = 0;
  var biggestLeadHome = 0, biggestLeadAway = 0;

  // ── POT / SECOND CHANCE TRACKING ──
  var pendingPOT = null;          // team that should get credit if they score next
  var pendingOREBTeam = null;     // team tracking for second chance
  var potHome = 0, potAway = 0;   // points off turnovers
  var scpHome = 0, scpAway = 0;   // second chance points
  var lastPeriod = 0;

  // Sort by order field to ensure chronological
  var sorted = plays.slice().sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

  sorted.forEach(function(ev, idx) {
    var type = (ev.type || '').trim();
    var typeLower = type.toLowerCase();
    var text = (ev.text || '').replace(/\n/g, ' ').trim();
    var textLower = text.toLowerCase();
    var teamAbbr = ev.team?.abbreviation || '';
    var team = teamAbbr === hA ? hA : teamAbbr === aA ? aA : teamAbbr || '?';
    var player = bdlExtractPlayer(text);
    var clock = ev.clock || null;
    var quarter = ev.period || 0;
    var homeScore = ev.home_score ?? null;
    var awayScore = ev.away_score ?? null;

    // Period boundary — reset chains
    if (quarter !== lastPeriod && lastPeriod > 0) {
      pendingPOT = null;
      pendingOREBTeam = null;
    }
    lastPeriod = quarter;

    // Track biggest lead from running scores
    if (homeScore != null && awayScore != null) {
      var margin = homeScore - awayScore;
      if (margin > biggestLeadHome) biggestLeadHome = margin;
      if (-margin > biggestLeadAway) biggestLeadAway = -margin;
    }

    // Process substitutions for lineup tracking
    if (typeLower.includes('substitution') || textLower.includes('enters the game for')) {
      lineups.processSub(text, team);
      // Don't add to timeline — SR doesn't include subs either
      return;
    }

    // Get current on-court
    var onCourt = lineups.getOnCourt();

    // Build enriched event (same shape as SR)
    var enriched = {
      idx: idx, type: 'other', team: team, player: player,
      clock: clock, quarter: quarter,
      homeScore: homeScore, awayScore: awayScore,
      possTeam: team !== '?' ? team : null,
      onCourt: onCourt,
      shot: null, turnover: null, rebound: null, foul: null,
      freeThrow: null, block: null, steal: null
    };

    // ── SHOOTING PLAYS ──
    if (ev.shooting_play) {
      var made = ev.scoring_play || false;
      var isThree = ev.score_value === 3 || textLower.includes('three point');
      var pts = made ? (ev.score_value || (isThree ? 3 : 2)) : 0;
      var zone = coordinateToZone(ev.coordinate_x, ev.coordinate_y, type, text, ev.score_value);

      // Free throw check — BDL marks FTs as shooting_play too
      if (typeLower.includes('free throw')) {
        pts = made ? 1 : 0;
        enriched.type = made ? 'ft_made' : 'ft_miss';
        enriched.freeThrow = { made: made, ftType: type, points: pts };

        if (made) {
          if (team === hA) hScore += 1; else aScore += 1;
          scoreLog.push({ team: team, pts: 1, hScore: hScore, aScore: aScore, q: quarter, lineup: team === hA ? onCourt.home : onCourt.away });
          scoringEvents.push({ tm: team, p: player, pts: 1, type: 'FT', ck: clock, q: quarter, m: aScore - hScore });

          // Second chance / POT credit
          if (pendingOREBTeam === team) { scpHome += team === hA ? 1 : 0; scpAway += team === aA ? 1 : 0; }
          if (pendingPOT === team) { potHome += team === hA ? 1 : 0; potAway += team === aA ? 1 : 0; }
        }

        // Check if last FT of set → close possession chains
        var ftMatch = type.match(/(\d+)\s*of\s*(\d+)/i);
        var isLastFT = ftMatch && ftMatch[1] === ftMatch[2];
        if (isLastFT && made) {
          pendingOREBTeam = null;
          pendingPOT = null;
        }

        timeline.push(enriched);
        return;
      }

      // Regular field goal
      var shotDist = bdlExtractDistance(text);
      var assisted = false;
      var assistPlayer = null;
      if (made) {
        assistPlayer = bdlExtractAssist(text);
        if (assistPlayer) assisted = true;
      }
      var context = bdlClassifyContext(type, assisted, isThree);

      enriched.type = made ? 'shot_made' : 'shot_miss';
      enriched.shot = {
        zone: zone, made: made, assisted: assisted, is3: isThree,
        context: context, shotDistance: shotDist, points: pts
      };

      // Check for block in text
      if (!made) {
        var blocker = bdlExtractBlock(text);
        if (blocker) enriched.block = { blocker: blocker };
      }

      shots.push({
        p: player, tm: team, z: zone, m: made, a: assisted,
        q: quarter, ctx: context, is3: isThree
      });

      if (made) {
        if (team === hA) hScore += pts; else aScore += pts;
        scoreLog.push({ team: team, pts: pts, hScore: hScore, aScore: aScore, q: quarter, lineup: team === hA ? onCourt.home : onCourt.away });
        scoringEvents.push({ tm: team, p: player, pts: pts, type: isThree ? '3PT' : '2PT', ck: clock, q: quarter, m: aScore - hScore });

        // Second chance / POT credit
        if (pendingOREBTeam === team) { scpHome += team === hA ? pts : 0; scpAway += team === aA ? pts : 0; }
        if (pendingPOT === team) { potHome += team === hA ? pts : 0; potAway += team === aA ? pts : 0; }

        // Scoring ends possession chains
        pendingOREBTeam = null;
        pendingPOT = null;
      }

      timeline.push(enriched);
      return;
    }

    // ── TURNOVERS ──
    if (typeLower.includes('turnover')) {
      var toClass = bdlClassifyTO(type, text);
      enriched.type = 'turnover';
      enriched.turnover = { forced: toClass.forced, type: toClass.type };

      // Check for steal in text
      var stealer = bdlExtractSteal(text);
      if (stealer) enriched.steal = { stealer: stealer };

      turnovers.push({ p: player, tm: team, q: quarter, forced: toClass.forced, type: toClass.type });

      // Break OREB chain
      pendingOREBTeam = null;

      // Set POT chain — OTHER team gets credit if they score next
      var otherTeam = team === hA ? aA : hA;
      pendingPOT = otherTeam;

      timeline.push(enriched);
      return;
    }

    // ── REBOUNDS ──
    if (typeLower.includes('rebound')) {
      var isOffensive = typeLower.includes('offensive');
      enriched.type = 'rebound';
      enriched.rebound = { type: isOffensive ? 'offensive' : 'defensive' };

      if (isOffensive) {
        // Start/continue second chance chain for this team
        pendingOREBTeam = team;
      } else {
        // Defensive rebound — break OREB chain and POT chain
        pendingOREBTeam = null;
        pendingPOT = null;
      }

      timeline.push(enriched);
      return;
    }

    // ── FOULS ──
    if (typeLower.includes('foul')) {
      var foulType = 'personal';
      if (typeLower.includes('offensive')) foulType = 'offensive';
      else if (typeLower.includes('flagrant')) foulType = 'flagrant';
      else if (typeLower.includes('technical') || typeLower.includes('double technical')) foulType = 'technical';
      else if (typeLower.includes('shooting')) foulType = 'shooting';
      enriched.type = 'foul';
      enriched.foul = { type: foulType, player: player };
      var drawnBy = bdlExtractFoulDrawn(text);
      if (drawnBy) enriched.foul.drawnBy = drawnBy;

      // Offensive foul = turnover
      if (foulType === 'offensive') {
        pendingOREBTeam = null;
        var otherTeam = team === hA ? aA : hA;
        pendingPOT = otherTeam;
      }

      timeline.push(enriched);
      return;
    }

    // ── END PERIOD ──
    if (typeLower.includes('end period') || typeLower.includes('end game')) {
      pendingPOT = null;
      pendingOREBTeam = null;
      // Don't add to timeline
      return;
    }

    // ── EVERYTHING ELSE (jumpball, timeout, challenge, etc.) ──
    timeline.push(enriched);
  });

  // ── SCORING RUNS — same logic as SR parsePBP ──
  var runs = [];
  var runTeam = null, runPts = 0, runStart = 0, runCount = 0, runLineup = [], runShotTypes = [];
  for (var i = 0; i < scoreLog.length; i++) {
    var s = scoreLog[i];
    if (s.team === runTeam) {
      runPts += s.pts; runCount++;
      if (s.lineup && s.lineup.length > 0) runLineup = s.lineup;
      runShotTypes.push(s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT');
    } else {
      if (runPts >= 8 || runCount >= 3) {
        runs.push({ team: runTeam, pts: runPts, count: runCount, q: scoreLog[runStart]?.q,
                     lineup: runLineup, mechanism: runShotTypes.slice(), si: runStart, ei: i - 1 });
      }
      runTeam = s.team; runPts = s.pts; runStart = i; runCount = 1;
      runLineup = s.lineup || [];
      runShotTypes = [s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT'];
    }
  }
  if (runPts >= 8 || runCount >= 3) {
    runs.push({ team: runTeam, pts: runPts, count: runCount, q: scoreLog[runStart]?.q,
                lineup: runLineup, mechanism: runShotTypes.slice(), si: runStart, ei: scoreLog.length - 1 });
  }
  runs.sort(function(a, b) { return b.ei - a.ei; }); // most recent first

  // ── AGGREGATE SUMMARIES — same shape as SR aggTeam ──
  function teamShots(tm) { return shots.filter(function(s) { return s.tm === tm; }); }

  function aggTeam(tm) {
    var s = teamShots(tm);
    var threes = s.filter(function(x) { return x.is3; });
    var rim = s.filter(function(x) { return x.z === 'rim'; });
    var paint = s.filter(function(x) { return x.z === 'paint'; });
    var mid = s.filter(function(x) { return x.z === 'mid'; });
    var threeMade = threes.filter(function(x) { return x.m; });
    var rimMade = rim.filter(function(x) { return x.m; });
    var paintMade = paint.filter(function(x) { return x.m; });
    var midMade = mid.filter(function(x) { return x.m; });
    var assistedThrees = threeMade.filter(function(x) { return x.a; }).length;
    var assistedRim = rimMade.filter(function(x) { return x.a; }).length;

    // Per-player breakdowns
    var playerThrees = {};
    threes.forEach(function(x) {
      if (!playerThrees[x.p]) playerThrees[x.p] = { name: x.p, made: 0, att: 0, assisted: 0, zones: { corner3: 0, above3: 0 }, contexts: {} };
      playerThrees[x.p].att++;
      if (x.m) { playerThrees[x.p].made++; if (x.a) playerThrees[x.p].assisted++; playerThrees[x.p].zones[x.z] = (playerThrees[x.p].zones[x.z] || 0) + 1; }
      playerThrees[x.p].contexts[x.ctx] = (playerThrees[x.p].contexts[x.ctx] || 0) + 1;
    });
    var playerRim = {};
    rim.forEach(function(x) {
      if (!playerRim[x.p]) playerRim[x.p] = { name: x.p, made: 0, att: 0, contexts: {} };
      playerRim[x.p].att++; if (x.m) playerRim[x.p].made++;
      playerRim[x.p].contexts[x.ctx] = (playerRim[x.p].contexts[x.ctx] || 0) + 1;
    });
    var playerMid = {};
    mid.forEach(function(x) {
      if (!playerMid[x.p]) playerMid[x.p] = { name: x.p, made: 0, att: 0, assisted: 0 };
      playerMid[x.p].att++; if (x.m) { playerMid[x.p].made++; if (x.a) playerMid[x.p].assisted++; }
    });

    var tms = turnovers.filter(function(t) { return t.tm === tm; });
    var forced = tms.filter(function(t) { return t.forced === true; }).length;
    var unforced = tms.filter(function(t) { return t.forced === false; }).length;
    var unknown = tms.filter(function(t) { return t.forced === null; }).length;

    return {
      threes: {
        made: threeMade.length, att: threes.length, assisted: assistedThrees,
        pct: threes.length > 0 ? (threeMade.length / threes.length * 100).toFixed(1) : '0',
        corner: { made: threeMade.filter(function(x) { return x.z === 'corner3'; }).length, att: threes.filter(function(x) { return x.z === 'corner3'; }).length },
        above: { made: threeMade.filter(function(x) { return x.z === 'above3'; }).length, att: threes.filter(function(x) { return x.z === 'above3'; }).length },
        byPlayer: Object.values(playerThrees).filter(function(x) { return x.att >= 1; }).sort(function(a, b) { return b.att - a.att; })
      },
      rim: {
        made: rimMade.length, att: rim.length, assisted: assistedRim,
        pct: rim.length > 0 ? (rimMade.length / rim.length * 100).toFixed(1) : '0',
        byPlayer: Object.values(playerRim).filter(function(x) { return x.att >= 1; }).sort(function(a, b) { return b.att - a.att; })
      },
      paint: {
        made: paintMade.length, att: paint.length,
        pct: paint.length > 0 ? (paintMade.length / paint.length * 100).toFixed(1) : '0'
      },
      mid: {
        made: midMade.length, att: mid.length,
        assisted: midMade.filter(function(x) { return x.a; }).length,
        pct: mid.length > 0 ? (midMade.length / mid.length * 100).toFixed(1) : '0',
        byPlayer: Object.values(playerMid).filter(function(x) { return x.att >= 1; }).sort(function(a, b) { return b.att - a.att; })
      },
      tos: { total: tms.length, forced: forced, unforced: unforced, unknown: unknown, byPlayer: tms },
      shotDiet: {
        total: s.length,
        threePct: s.length > 0 ? (threes.length / s.length * 100).toFixed(1) : '0',
        rimPct: s.length > 0 ? (rim.length / s.length * 100).toFixed(1) : '0',
        midPct: s.length > 0 ? (mid.length / s.length * 100).toFixed(1) : '0'
      }
    };
  }

  var home = aggTeam(hA);
  var away = aggTeam(aA);

  // ── BUILD POSSESSION LOG (reuse existing buildPossessionLog if available) ──
  var possessionLog = [];
  if (typeof buildPossessionLog === 'function') {
    possessionLog = buildPossessionLog(timeline, hA, aA);
  }

  console.log('[BDL-PBP] Parsed: ' + timeline.length + ' events, ' + shots.length + ' shots, ' +
    turnovers.length + ' TOs, ' + runs.length + ' runs, ' +
    'POT: ' + hA + '=' + potHome + ' ' + aA + '=' + potAway +
    ' | SCP: ' + hA + '=' + scpHome + ' ' + aA + '=' + scpAway);

  return {
    home: home,
    away: away,
    homeAlias: hA,
    awayAlias: aA,
    totalShots: shots.length,
    totalTOs: turnovers.length,
    runs: runs,
    raw: { shots: shots, turnovers: turnovers },
    scoringEvents: scoringEvents,
    possessionLog: possessionLog,
    timeline: timeline,
    // ── BDL-specific extras (used by buildSummaryFromBDL) ──
    _bdl: {
      potHome: potHome, potAway: potAway,
      scpHome: scpHome, scpAway: scpAway,
      biggestLeadHome: biggestLeadHome,
      biggestLeadAway: biggestLeadAway,
      scoreLog: scoreLog,
    }
  };
}
