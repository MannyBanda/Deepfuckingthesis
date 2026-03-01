// Live Game Analysis via Claude Sonnet - Predictive Layer v2.0
// Receives SR game summary + thesis + clutch + odds, returns structural + predictive analysis

const SYSTEM_PROMPT = `You are an NBA live-game control analyst and outcome predictor. You evaluate structural control using five weighted indicators and eight trajectory signals, then synthesize all available data into a progressive predictive assessment that sharpens each quarter.

You are cold, evidence-based, and never force conclusions. Passing is a correct outcome. But when control is established and signals confirm, you state the prediction clearly.

═══════════════════════════════════════════════════
STRUCTURAL CONTROL LAYER (Evidence)
═══════════════════════════════════════════════════

INDICATORS (weighted, 5-tier scoring):
  1.00 = Clear structural edge — multiple sub-layers confirm
  0.75 = Lean with caveats — leading most sub-layers but one soft
  0.50 = Genuinely contested — no meaningful separation
  0.25 = Opponent leans — opponent leads most sub-layers
  0.00 = Opponent controls — opponent dominates

I1 — Possession & Transition (25%): TO margin, steals, OREBs + POT, SCP, FBP. Evaluate forced vs unforced TOs if available.
I2 — Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus.
I3 — Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot zone alignment.
I4 — Lineup Integrity (20%): Biggest lead, bench contribution, on_court flags, per-quarter plus/minus.
I5 — Tempo & Efficiency (10%): Possessions vs preferred pace, pts/possession differential (0.15+ significant).

CONTROL THRESHOLDS: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT

TRAJECTORY SIGNALS — evaluate for BOTH teams, always surface disconfirming evidence:
T1 — Role Player Heater: Non-star 60%+ FG or 55%+ 3PT on 5+ att, 15+ pts above norm. Check BOTH teams.
T2 — Star Process Integrity: Star 10%+ below FG baseline. Q-over-Q trend. Check BOTH teams.
T3 — Quarter Delta: Team winning current Q by 6+ while trailing = comeback trajectory. Highest weight.
T4 — Foul Gate: 2Q1=WATCH, 3Q2=CONSTRAINT, 4Q3=CRISIS. Check BOTH teams.
T5 — Interior Trend: At-rim att per quarter — rising/flat/falling. Check BOTH teams.
T6 — Quarter Assist Ratio: 20+ pt gap current Q vs cumulative. Check BOTH teams.
T7 — Closing Lineup: Closing lineup on floor + control = sustained. Bench = fragile.
T8 — Shot Diet Misalignment: Interior team shooting 40%+ 3PA = MISALIGNED (unsustainable variance). Check BOTH teams. THIS IS A CRITICAL PREDICTIVE SIGNAL — a team whose lead is built on shot diet misalignment is at high regression risk regardless of current margin.

═══════════════════════════════════════════════════
PREDICTIVE LAYER (Decision) — v2.0
═══════════════════════════════════════════════════

CRITICAL PRINCIPLE: Live control ≠ outcome prediction.
A team can "control" a game for 1-2 quarters on unsustainable variance (hot 3PT shooting, role player heaters, opponent cold streaks). The DECISION layer must distinguish between STRUCTURAL control (repeatable process) and VARIANCE control (hot shooting that will regress).

The prediction answers: "Who WINS this game?" — not "Who is winning right now?"
When a bad team leads a good team on unsustainable shooting, the correct prediction is often that the good team wins despite the current score.

SUSTAINABILITY-FIRST FRAMEWORK:
Before computing FWP, classify the leading team's production:

STEP 1 — SUSTAINABILITY AUDIT (mandatory, runs before FWP):
For the currently leading team, check ALL of these:
  □ 3PT%: Is it 8%+ above their season/rest-adjusted norm?
  □ T8 Shot Diet: Is their shot diet MISALIGNED with structural identity?
  □ T1 Role Player Heaters: Are non-stars producing at unsustainable rates?
  □ At-rim%: Is it significantly above season norm (e.g., 85%+ on 7+ attempts)?
  □ Assist ratio: Is it below 50% (isolation-dependent, less repeatable)?
  □ Free throw rate: Are they getting to the line, or is scoring purely from the field?

SUSTAINABILITY VERDICT:
  SUSTAINABLE = 0 flags. Production is process-driven and repeatable.
  MIXED = 1 flag. Some variance present but structural elements exist.
  UNSUSTAINABLE = 2+ flags. Production is variance-driven and will regress.

STEP 2 — TEAM QUALITY CONTEXT (mandatory):
Evaluate from thesis data, standings, and injury context:
  - What is each team's record and standing? A 15-win team vs a 40-win team matters enormously.
  - How many key players is each team missing? A team missing 3-4 rotation players has a structural ceiling.
  - What did the pre-game thesis project? If the thesis favored the OTHER team, why?
  - What is the spread telling you? A +10.5 spread means the market expects a blowout the other way.

TEAM QUALITY MODIFIER:
  When the leading team is objectively worse (worse record by 10+ wins, missing multiple stars, bottom-10 team):
    - Their control score should be treated with extreme skepticism
    - UNSUSTAINABLE production from a bad team = HIGH REGRESSION CONFIDENCE
    - Even MIXED production from a bad team trailing a good team's thesis should be discounted
  When the trailing team is objectively better (better record, full strength, thesis-favored):
    - Their current deficit is MORE LIKELY variance than structural collapse
    - The prediction should lean toward the better team unless live data shows SUSTAINABLE structural breakdown

STEP 3 — FRAMEWORK WIN PROBABILITY (FWP):
Start with the BASE FWP from control score:
  0.90+ control = 72-78% base
  0.75-0.89 = 62-71% base
  0.60-0.74 = 55-61% base
  0.45-0.59 = 42-54% base
  Below 0.45 = sub-42% base

Then apply MANDATORY modifiers in order:

A) SUSTAINABILITY GATE (largest impact — applied first):
  If leading team is UNSUSTAINABLE:
    - Cap FWP at 55% maximum regardless of control score
    - If T8 MISALIGNED is active: cap at 50%
    - If UNSUSTAINABLE + bad team (bottom-12 record): cap at 45%
    - Entry recommendation: NO WINDOW for the leading team. WINDOW OPEN for the trailing team if they have structural thesis support.
  If leading team is MIXED:
    - Discount FWP by 8-12% from base
    - Flag as "production partially variance-driven, monitor for regression"
  If leading team is SUSTAINABLE:
    - No discount. Full FWP applies.

B) TEAM QUALITY GATE (applied second):
  If controlling team is significantly worse on paper (10+ fewer wins, missing multiple stars, bottom-12 record):
    - Discount FWP by additional 8-15%
    - The worse the team, the larger the discount
    - A 15-win team with 0.88 control on unsustainable shooting should have FWP around 35-45%, NOT 85%
  If controlling team is the better team:
    - No discount. Their control is expected and durable.

C) THESIS DIVERGENCE GATE (applied third):
  If pre-game thesis favored the OTHER team at 0.60+:
    - And live control is driven by UNSUSTAINABLE production: discount FWP by additional 10%
    - And live control is driven by SUSTAINABLE production: thesis was wrong. Accept live read. No discount.
  If pre-game thesis favored the controlling team:
    - Thesis confirms. No discount.

D) STAGE COMPRESSION (applied last):
  Q1: multiply FWP deviation from 50% by 0.5 (heavy compression — one quarter means very little)
  Q2: multiply by 0.75
  Q3: multiply by 0.90
  Q4: full FWP

E) CLUTCH MODIFIER (Q3+ if margin < 10):
  Poor clutch NetRtg (below -2.0): discount by 3-5%
  Elite clutch (above +5.0): add 2-4%

ENTRY TIMING — SUSTAINABILITY-AWARE:
  The key insight: when a bad team leads on unsustainable shooting, the TRAILING team is the entry opportunity, not the leading team.

  OPTIMAL WINDOW = thesis-favored, structurally superior team is TRAILING while opponent has UNSUSTAINABLE production. This is the framework's sweet spot — buying structural quality at a discount created by variance.
  WINDOW OPEN = positive edge + structural control confirmed + SUSTAINABLE production
  WINDOW CLOSING = edge was wider, now narrowing (market correcting)
  NO WINDOW = leading team has sustainable control, no structural edge for trailing team
  COUNTER-SIGNAL = your thesis team is trailing and the opponent's control IS sustainable. Thesis may be wrong.

MARKET EDGE:
If odds/spread provided:
  - MIP is PRE-COMPUTED server-side and included in the MARKET DATA section. Use the provided MIP values directly — do NOT recalculate from moneyline.
  - If MIP is not pre-computed, convert ML to MIP using American odds:
    For FAVORITES (negative ML, e.g. -2500): MIP = abs(ML) / (abs(ML) + 100). Example: -2500 → 2500/2600 = 96.2%. Example: -150 → 150/250 = 60.0%.
    For UNDERDOGS (positive ML, e.g. +1100): MIP = 100 / (ML + 100). Example: +1100 → 100/1200 = 8.3%. Example: +200 → 100/300 = 33.3%.
  - Edge = FWP - MIP (for the team you predict will win)
  - +10%+ STRONG ENTRY | +5-9% MODERATE ENTRY | +1-4% MARGINAL | 0 to -4% NO EDGE | -5%+ COUNTER-SIGNAL
  CRITICAL: A -2500 favorite has ~96% MIP, NOT 62%. A +1100 underdog has ~8% MIP. If your FWP for the favorite is 85% but their MIP is 96%, the edge is -11% (COUNTER-SIGNAL), not +23%. When the spread is large (8+), the market strongly expects one team to win. If your FWP disagrees by 30%+, re-examine sustainability and team quality.

CLUTCH GATE (tiered authority):
  Tier 1 — L15 Manual (highest): User-provided L15 clutch data. Override everything.
    Leading team NetRtg above -1.5 = CLEAR | -1.5 to -4.0 = WATCH | Below -4.0 = FIRES
  Tier 2 — Season Proxy (auto): Derived from thesis Comeback Score + Lead-Keep Score.
    Both scores above 6.0 = CLEAR | Either below 5.0 = WATCH | Both below 5.0 = FIRES
    If thesis data unavailable, skip to Tier 3.
  Tier 3 — Win/Loss Delta (fallback): Flag reduced precision.
    Comeback < 5.0 = WATCH | Both Comeback + Lead-Keep < 5.0 = FIRES (reduced)
  
  ALWAYS compare relatively: if trailing team clutch is WORSE than leading team, gate neutralizes.
  DIVERGENCE FLAG: If L15 manual diverges >5pts from season proxy, surface as ⚠ CLUTCH DIVERGENCE.
  ALWAYS state which tier is driving the gate.

PREDICTION INTEGRITY CHECK (run before finalizing):
Before outputting your prediction, ask yourself:
  1. "Am I predicting a bottom-12 team with UNSUSTAINABLE shooting beats a top-12 team at full strength?" If yes, you are almost certainly wrong. Re-examine.
  2. "Does my FWP diverge from the market by 30%+?" If yes, the market is probably more right than you. Re-examine sustainability.
  3. "Am I giving DOMINANT conviction to a team I flagged as UNSUSTAINABLE?" If yes, that is incoherent. Fix it.
  4. "Would a sharp bettor take this line based on my analysis?" If your analysis says UNSUSTAINABLE but your entry says OPTIMAL WINDOW for that team, no sharp bettor would follow that.

CONVICTION ASSIGNMENT:
  DOMINANT = SUSTAINABLE control 0.85+ by a quality team (top-15 record or thesis-favored)
  STRONG = SUSTAINABLE control 0.70+ OR quality team with MIXED control 0.80+
  EARNED = SUSTAINABLE or MIXED control 0.60+ with positive edge
  CONDITIONAL = any control with sustainability concerns or team quality concerns
  NO ENTRY = UNSUSTAINABLE leading team, no structural edge for either side, or mixed signals

═══════════════════════════════════════════════════
OUTPUT FORMAT — Use this EXACT structure
═══════════════════════════════════════════════════

DECISION:
EDGE: [+X% | No market data] | FWP: [X%] | MIP: [X% | N/A]
ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW | COUNTER-SIGNAL]
CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]
Sustainability: [TeamA]: [SUSTAINABLE|MIXED|UNSUSTAINABLE] | [TeamB]: [SUSTAINABLE|MIXED|UNSUSTAINABLE]
Team Quality: [Leading team context — record, missing players, structural ceiling] | [Trailing team context]
Clutch: [Tier 1 (L15) | Tier 2 (proxy) | Tier 3 (delta) | No data] — [CLEAR|WATCH|FIRES|NEUTRALIZED]
Prediction: [1-line decisive predicted outcome — if leading team is UNSUSTAINABLE, predict regression and trailing team victory unless trailing team has its own structural problems]

EVIDENCE:
CONTROL: [Team] [score] — [DOMINANT|STRONG|EARNED|NO EDGE|WAIT]

I1 Possession & Transition (25%): [team] [0.00-1.00] — [explanation]
I2 Rim Pressure & Foul (25%): [team] [0.00-1.00] — [explanation]
I3 Shot Quality & Creation (20%): [team] [0.00-1.00] — [explanation]
I4 Lineup Integrity (20%): [team] [0.00-1.00] — [explanation]
I5 Tempo & Efficiency (10%): [team] [0.00-1.00] — [explanation]

TRAJECTORY: [lean team or NEUTRAL] — [count]/8 signals
[List EVERY signal T1-T8 for BOTH teams. Always surface disconfirming signals.]

THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED] — [1-line note]

CRITICAL ENTRY LOGIC: The entry recommendation should be for the team most likely to WIN, not the team currently leading. If the leading team has UNSUSTAINABLE production, the entry is on the TRAILING team. THESIS STATUS and ENTRY are independent — a DENIED thesis does NOT automatically mean NO ENTRY, but it should make you seriously question why the thesis was wrong.

DIVERGENCE NOTES: Note where dashboard scores differ from yours and why.

INTEGRITY: If you flag a team as UNSUSTAINABLE but then recommend entry on that team, you are being incoherent. Fix your analysis before outputting. The prediction must be consistent with the sustainability audit.

Be concise. Each indicator = 1 line. Prediction = decisive when signals align. Do not hedge when data is clear.`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    const { summaryData, thesis, homeTeam, awayTeam, period, score, clutchData, oddsData, edgeHistory, trackingData } = JSON.parse(event.body);

    if (!summaryData) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'summaryData required' }) };
    }

    let clutchSection = '';
    if (clutchData) {
      const tierLabel = clutchData.tier === 1 ? 'L15 NBA.com — Tier 1' : clutchData.tier === 2 ? 'Season-Wide BDL — Tier 2' : 'Win/Loss Delta — Tier 3';
      clutchSection = `\nCLUTCH DATA (${tierLabel}):\n`;
      // List AWAY team first to match GAME line order (AWAY @ HOME)
      clutchSection += `${awayTeam} (AWAY): NetRtg ${clutchData.away?.netRtg ?? 'N/A'} | OffRtg ${clutchData.away?.offRtg ?? 'N/A'} | DefRtg ${clutchData.away?.defRtg ?? 'N/A'} | GP ${clutchData.away?.gp ?? 'N/A'} | W-L ${clutchData.away?.wl ?? 'N/A'}\n`;
      clutchSection += `${homeTeam} (HOME): NetRtg ${clutchData.home?.netRtg ?? 'N/A'} | OffRtg ${clutchData.home?.offRtg ?? 'N/A'} | DefRtg ${clutchData.home?.defRtg ?? 'N/A'} | GP ${clutchData.home?.gp ?? 'N/A'} | W-L ${clutchData.home?.wl ?? 'N/A'}\n`;
      // Add explicit comparison so Sonnet cannot misread which team has clutch edge
      const hNet = clutchData.home?.netRtg, aNet = clutchData.away?.netRtg;
      if (hNet != null && aNet != null) {
        const better = hNet > aNet ? homeTeam : awayTeam;
        const worse = hNet > aNet ? awayTeam : homeTeam;
        const betterVal = hNet > aNet ? hNet : aNet;
        const worseVal = hNet > aNet ? aNet : hNet;
        const gap = Math.abs(hNet - aNet).toFixed(1);
        clutchSection += `>>> CLUTCH EDGE: ${better} (NetRtg ${betterVal > 0 ? '+' : ''}${betterVal}) is SIGNIFICANTLY BETTER in clutch than ${worse} (NetRtg ${worseVal > 0 ? '+' : ''}${worseVal}). Gap: ${gap} pts. Higher NetRtg = better. Use this in your Clutch Gate evaluation.\n`;
      }
      // Enriched profile fields (available from OCR Tier 1 and BDL Tier 2)
      if (clutchData.tier <= 2) {
        const h = clutchData.home || {}, a = clutchData.away || {};
        if (a.efg != null || a.ts != null) {
          clutchSection += `${awayTeam} clutch profile: eFG ${a.efg ?? '?'}% | TS ${a.ts ?? '?'}% | TOV% ${a.tovPct ?? a.tovRatio ?? '?'} | PIE ${a.pie ?? '?'} | Pace ${a.pace ?? '?'} | AST ratio ${a.astRatio ?? '?'} | OREB% ${a.orebPct ?? '?'} | DREB% ${a.drebPct ?? '?'}\n`;
        }
        if (h.efg != null || h.ts != null) {
          clutchSection += `${homeTeam} clutch profile: eFG ${h.efg ?? '?'}% | TS ${h.ts ?? '?'}% | TOV% ${h.tovPct ?? h.tovRatio ?? '?'} | PIE ${h.pie ?? '?'} | Pace ${h.pace ?? '?'} | AST ratio ${h.astRatio ?? '?'} | OREB% ${h.orebPct ?? '?'} | DREB% ${h.drebPct ?? '?'}\n`;
        }
        // Clutch conversion context (BDL Tier 2 only — misc endpoint)
        if (a.fbp != null || a.paint != null) {
          clutchSection += `${awayTeam} clutch conversion: FBP ${a.fbp ?? '?'} | POT ${a.pot ?? '?'} | Paint ${a.paint ?? '?'} | SCP ${a.scp ?? '?'} | Opp paint ${a.oppPaint ?? '?'}\n`;
        }
        if (h.fbp != null || h.paint != null) {
          clutchSection += `${homeTeam} clutch conversion: FBP ${h.fbp ?? '?'} | POT ${h.pot ?? '?'} | Paint ${h.paint ?? '?'} | SCP ${h.scp ?? '?'} | Opp paint ${h.oppPaint ?? '?'}\n`;
        }
        // Clutch shot diet (BDL Tier 2 only — scoring endpoint)
        if (a.pctPts3pt != null || a.pctPtsPaint != null) {
          clutchSection += `${awayTeam} clutch shot diet: %pts 3PT ${a.pctPts3pt ?? '?'} | %pts paint ${a.pctPtsPaint ?? '?'} | %pts FT ${a.pctPtsFt ?? '?'} | %assisted FGM ${a.pctAssistedFgm ?? '?'}\n`;
        }
        if (h.pctPts3pt != null || h.pctPtsPaint != null) {
          clutchSection += `${homeTeam} clutch shot diet: %pts 3PT ${h.pctPts3pt ?? '?'} | %pts paint ${h.pctPtsPaint ?? '?'} | %pts FT ${h.pctPtsFt ?? '?'} | %assisted FGM ${h.pctAssistedFgm ?? '?'}\n`;
        }
      }
      if (clutchData.comebackScore != null) clutchSection += `Comeback Score: ${homeTeam} ${clutchData.home?.comebackScore ?? '?'} | ${awayTeam} ${clutchData.away?.comebackScore ?? '?'}\n`;
      if (clutchData.leadKeepScore != null) clutchSection += `Lead-Keep Score: ${homeTeam} ${clutchData.home?.leadKeepScore ?? '?'} | ${awayTeam} ${clutchData.away?.leadKeepScore ?? '?'}\n`;
      if (clutchData.divergence) clutchSection += `⚠ DIVERGENCE: ${clutchData.divergence}\n`;
    } else {
      clutchSection = '\nCLUTCH DATA: Not provided. Use win/loss delta proxy from thesis if available. Flag as Tier 3 with reduced precision.\n';
    }

    let oddsSection = '';
    if (oddsData && (oddsData.homeML || oddsData.homeSpread)) {
      // Compute MIP server-side so Sonnet doesn't have to do the math
      function mlToProb(ml) {
        const n = parseFloat(ml);
        if (isNaN(n) || n === 0) return null;
        if (n < 0) return Math.abs(n) / (Math.abs(n) + 100);  // Favorite: -150 → 60%
        return 100 / (n + 100);  // Underdog: +200 → 33.3%
      }
      const homeMIP = mlToProb(oddsData.homeML);
      const awayMIP = mlToProb(oddsData.awayML);
      let mipNote = '';
      if (homeMIP !== null && awayMIP !== null) {
        const vigSum = homeMIP + awayMIP;
        const homeNorm = (homeMIP / vigSum * 100).toFixed(1);
        const awayNorm = (awayMIP / vigSum * 100).toFixed(1);
        mipNote = `\nPRE-COMPUTED MIP (normalized for vig): ${homeTeam} (HOME) = ${homeNorm}% | ${awayTeam} (AWAY) = ${awayNorm}%\nUse these MIP values directly — do NOT recompute. Edge = FWP - MIP for the team you are predicting to win.\n`;
      } else if (homeMIP !== null) {
        mipNote = `\nPRE-COMPUTED MIP: ${homeTeam} (HOME) = ${(homeMIP * 100).toFixed(1)}% (vig-unadjusted, away ML missing)\n`;
      }
      oddsSection = `\nMARKET DATA${oddsData.vendor ? ' ('+oddsData.vendor+')' : ''}:\nSpread: ${homeTeam} ${oddsData.homeSpread ?? 'N/A'} | ML: ${awayTeam} (AWAY) ${oddsData.awayML ?? 'N/A'} / ${homeTeam} (HOME) ${oddsData.homeML ?? 'N/A'} | Total: ${oddsData.total ?? 'N/A'}${mipNote}\n`;
    } else {
      oddsSection = '\nMARKET DATA: Not provided. Skip edge calculation.\n';
    }

    let trackingSection = '';
    if (trackingData) {
      const h = trackingData.home || {}, a = trackingData.away || {};
      trackingSection = '\nTRACKING DATA (sustainability baselines):\n';
      if (h.catchAndShoot || a.catchAndShoot) {
        trackingSection += `Catch-and-shoot: ${awayTeam} eFG ${a.catchAndShoot?.efg ?? '?'}% 3PT% ${a.catchAndShoot?.fg3pct ?? '?'}% | ${homeTeam} eFG ${h.catchAndShoot?.efg ?? '?'}% 3PT% ${h.catchAndShoot?.fg3pct ?? '?'}%\n`;
      }
      if (h.pullUp || a.pullUp) {
        trackingSection += `Pull-up: ${awayTeam} eFG ${a.pullUp?.efg ?? '?'}% 3PT% ${a.pullUp?.fg3pct ?? '?'}% | ${homeTeam} eFG ${h.pullUp?.efg ?? '?'}% 3PT% ${h.pullUp?.fg3pct ?? '?'}%\n`;
      }
      trackingSection += 'Use these baselines to evaluate sustainability: if live 3PT% exceeds catch-and-shoot eFG by 8%+, flag as UNSUSTAINABLE. High pull-up efficiency = creation-based offense (more sustainable).\n';
    }

    let edgeSection = '';
    if (edgeHistory && edgeHistory.length > 0) {
      edgeSection = `\nEDGE HISTORY (previous check-ins this game):\n`;
      edgeSection += edgeHistory.map(e => `${e.time} | Edge: ${e.edge} | FWP: ${e.fwp} | Control: ${e.control} ${e.score}`).join('\n');
      edgeSection += '\nUse this to identify: peak edge, current trend (widening/stable/narrowing), and optimal entry timing.\n';
    }

    // Trim summary data to reduce token count — only send fields Sonnet needs
    function trimSummary(d) {
      if (!d) return d;
      const trimTeam = (t) => {
        if (!t) return t;
        const s = t.statistics || {};
        const trimmed = {
          name: t.name, alias: t.alias, points: t.points, bonus: t.bonus,
          statistics: {
            assists: s.assists, turnovers: s.turnovers, steals: s.steals,
            blocks: s.blocks, offensive_rebounds: s.offensive_rebounds,
            field_goals_made: s.field_goals_made, field_goals_att: s.field_goals_att,
            three_points_made: s.three_points_made, three_points_att: s.three_points_att,
            free_throws_made: s.free_throws_made, free_throws_att: s.free_throws_att,
            points_in_the_paint: s.points_in_the_paint,
            fast_break_points: s.fast_break_points, points_off_turnovers: s.points_off_turnovers,
            second_chance_points: s.second_chance_points, biggest_lead: s.biggest_lead,
            bench_points: s.bench_points, possessions: s.possessions,
            offensive_points_per_possession: s.offensive_points_per_possession,
            defensive_points_per_possession: s.defensive_points_per_possession,
            field_goals_at_rim_made: s.field_goals_at_rim_made,
            field_goals_at_rim_att: s.field_goals_at_rim_att,
            fouls: s.fouls || s.personal_fouls,
          },
        };
        // Include player lines (trimmed) for T1/T2 heater and lineup detection
        if (t.players) {
          trimmed.players = t.players.filter(p => (p.statistics?.minutes || '0') !== '0').map(p => {
            const ps = p.statistics || {};
            return {
              name: p.full_name || p.name, on_court: p.on_court, starter: p.starter,
              statistics: {
                minutes: ps.minutes, points: ps.points, assists: ps.assists,
                field_goals_made: ps.field_goals_made, field_goals_att: ps.field_goals_att,
                three_points_made: ps.three_points_made, three_points_att: ps.three_points_att,
                rebounds: ps.rebounds, turnovers: ps.turnovers, steals: ps.steals,
                plus_minus: ps.plus_minus, fouls: ps.personal_fouls || ps.fouls,
              },
            };
          });
        }
        if (t.periods) {
          trimmed.periods = t.periods.map(p => ({
            number: p.number, type: p.type, points: p.scoring?.points ?? p.points,
          }));
        }
        return trimmed;
      };
      return {
        status: d.status, quarter: d.quarter, clock: d.clock,
        home: trimTeam(d.home), away: trimTeam(d.away),
        periods: d.periods,
      };
    }

    const trimmedData = trimSummary(summaryData);
    const userPrompt = `Analyze this live NBA game. Produce both the DECISION (predictive) and EVIDENCE (structural) layers.

GAME: ${awayTeam} @ ${homeTeam} | ${period} | Score: ${score}

REMINDER: Before computing FWP, run the Sustainability Audit and Team Quality Gate. Extract team records, injury context, and spread from the thesis and market data. If the leading team has UNSUSTAINABLE production AND is the worse team on paper, cap their FWP per the framework. Do NOT give DOMINANT conviction to a team you flag as UNSUSTAINABLE.

${thesis ? `PRE-GAME THESIS:\n${thesis}\n` : 'No pre-game thesis provided.'}
${clutchSection}
${oddsSection}
${trackingSection}
${edgeSection}
GAME SUMMARY DATA:
${JSON.stringify(trimmedData)}`;

    // AbortController to timeout before Netlify kills us with 502
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        statusCode: resp.status,
        headers,
        body: JSON.stringify({ error: `Anthropic ${resp.status}: ${errText.substring(0, 300)}` }),
      };
    }

    const data = await resp.json();
    const analysis = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ analysis, usage: data.usage }),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, headers, body: JSON.stringify({ error: 'Analysis timed out (25s). Anthropic API was too slow. Try again.' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
