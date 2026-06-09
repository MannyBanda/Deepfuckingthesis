#!/usr/bin/env node
/**
 * XGB AGENT REPLAY — DEN vs MIN (Apr 20, 2026)
 * 
 * Calls Opus 4.6 with the actual V2 agent prompt for two key alerts:
 *   1. Q4 5:54 POSITION_OPEN (SEND → wrong, DEN lost)
 *   2. Q4 5:32 BWC_EDGE (SEND → wrong, DEN lost)
 * 
 * Each alert is run TWICE:
 *   A) WITHOUT XGB context (baseline — should reproduce original decision)
 *   B) WITH XGB context injected (test — does the decision change?)
 */

import { readFileSync } from 'fs';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Load XGB model for feature computation ──
const XGB_MODEL = JSON.parse(readFileSync('netlify/functions/xgb-model.json', 'utf8'));
const XGB_LABELS = ['progress','paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs'];

function predictXGB(features) {
  let sum = 0;
  for (const tree of XGB_MODEL.trees) {
    let node = 0;
    while (tree.l[node] !== -1) {
      node = (features[tree.s[node]] ?? 0) < tree.c[node] ? tree.l[node] : tree.r[node];
    }
    sum += tree.w[node];
  }
  return 1 / (1 + Math.exp(-(Math.log(XGB_MODEL.base_score / (1 - XGB_MODEL.base_score)) + sum)));
}

function computeSHAP(features) {
  const contribs = new Float64Array(14);
  for (const tree of XGB_MODEL.trees) {
    let node = 0;
    while (tree.l[node] !== -1) {
      const feat = tree.s[node];
      const child = (features[feat] ?? 0) < tree.c[node] ? tree.l[node] : tree.r[node];
      contribs[feat] += tree.ev[child] - tree.ev[node];
      node = child;
    }
  }
  return XGB_LABELS.map((f, i) => ({ f, v: Math.round(contribs[i] * 1000) / 1000 }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 5);
}

// ── Call Opus ──
async function callAgent(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Opus ${resp.status}: ${err.substring(0, 200)}`);
  }
  const data = await resp.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const decision = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i)?.[1]?.toUpperCase();
  const reasoning = text.match(/REASONING:\s*([\s\S]*?)(?:\nBODY:|$)/i)?.[1]?.trim();
  const body = text.match(/BODY:\s*([\s\S]*)/i)?.[1]?.trim();
  return { decision, reasoning, body, usage: data.usage, raw: text };
}

// ── Build V2-style prompt ──
// Reconstructed from alert row data + snapshot context
function buildTestPrompt(alertData, xgbBlock) {
  const a = alertData;
  
  const xgbSection = xgbBlock ? `
XGBOOST STRUCTURAL MODEL (independent — trained on raw stats, does NOT use floor/indicators/margin):
XGB win probability: ${(xgbBlock.prob * 100).toFixed(1)}% | Floor: ${(a.floor_score * 100).toFixed(1)}% | ${xgbBlock.aligned ? 'ALIGNED' : '⚠️ DIVERGENT (' + (xgbBlock.divergence > 0 ? '+' : '') + (xgbBlock.divergence * 100).toFixed(1) + '%)'}
SHAP drivers (what raw stats push XGB prediction): ${xgbBlock.shap.map(s => s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2)).join(', ')}
${!xgbBlock.aligned && xgbBlock.prob < 0.50 ? 'WARNING: XGBoost sees < 50% win probability from raw stats despite floor at ' + a.floor_score + '. Raw production data does NOT confirm structural dominance.' : ''}` : '';

  return `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${a.alert_type} (${a.alert_tier})
Control team: ${a.control_team} | Floor: ${a.floor_score} | Margin: ${a.margin} (${a.margin < 0 ? 'trailing' : a.margin > 0 ? 'leading' : 'tied'})
Score: MIN ${a.away_pts_live} - DEN ${a.home_pts_live} (${a.control_team} is HOME)
Period: Q${a.period} ${a.clock}
BWC team (subscriber position): DEN

INDICATORS (control-team-relative):
I1 Disruption: ${a.i1} | I2 Interior: ${a.i2} | I3 Shot Quality: ${a.i3} | I4 Game Control: ${a.i4} | I5 Execution: ${a.i5}
Indicators won: I2, I3, I4 (3/5)
Ctrl sust: ${a.ctrl_sust} | Opp sust: ${a.opp_sust}
TP: ${a.tp_class || 'N/A'} | LS: ${a.ls_class || 'N/A'}

OPPONENT PROFILE:
Opponent indicators won: 1 (I1 — disruption)
WARNING: Opponent structural counter-indicator (I1), not just variance.

POSITION HEALTH:
Peak floor: 0.77 | Mean floor: 0.68 | Current: ${a.floor_score}
Erosion: STABLE
Conviction trend: HELD (CONDITIONAL → MODEST → STRONG)
Consecutive holds: 37
BWC lifecycle: ${a.bwc_state} (BWC fired Q3, floor 0.60)
Graduation: B-Rank (graduated @ Q4_6, floor was 0.77) | MF FLAT (0.68 → 0.60 → 0.77) delta=+0.005 | MF=0.683 minF=0.60 (3 eligible CPs)
Lane: heavy_favorite (pregame ML -315) | CP flips: 1 | Control flips (game total): 1

STRUCTURAL STRESS (rolling window vs cumulative — does the recent game agree with the floor?):
Window (Q3+Q4, ~32 poss): MIN 0.${a.alert_type === 'BWC_EDGE' ? '53' : '57'}
  I1: 0.3 — MIN steals/TO advantage in recent quarters
  I2: 0.6 — DEN slight interior edge in window
  I3: 0.4 — MIN shooting better recently
  I4: 0.5 — game control contested in window
  I5: 0.5 — pace even
Combined read: ${a.alert_type === 'BWC_EDGE' ? 'COLLAPSING' : 'SHIFT'} — Rolling window DISAGREES with cumulative floor. Recent quarters favor MIN. Cumulative indicators may be anchored from earlier quarters that no longer reflect game state.

Per-quarter breakdown:
  Q1 (DEN vs MIN): Paint DEN:20 MIN:10 | FT DEN:6/6 MIN:3/4 | 3P DEN:5/12 MIN:5/10 | AST DEN:8 MIN:5 | TO DEN:3 MIN:5 | STL DEN:3 MIN:1
  Q2 (DEN vs MIN): Paint DEN:16 MIN:16 | FT DEN:8/10 MIN:8/9 | 3P DEN:6/16 MIN:5/14 | AST DEN:12 MIN:14 | TO DEN:4 MIN:2 | STL DEN:0 MIN:3
  Q3 (DEN vs MIN): Paint DEN:14 MIN:14 | FT DEN:6/6 MIN:5/6 | 3P DEN:0/4 MIN:3/6 | AST DEN:7 MIN:7 | TO DEN:1 MIN:3 | STL DEN:1 MIN:3
  Q4 partial: Paint DEN:0 MIN:6 | FT DEN:6/6 MIN:8/9 | TO even | STL MIN:2 DEN:0

STRUCTURE-SCORE RELATIONSHIP:
Floor trend: RISING | Margin trend: DECLINING | Signal: DIVERGING_NEGATIVE
Floor is rising but margin is shrinking — structure improving but not translating to scoreboard.
${xgbSection}

FLOOR TRAJECTORY:
Q4 5:54: 0.77 (DEN) +3 | Q4 7:56: 0.77 +5 | Q4 8:51: 0.60 +1 | Q4 9:10: 0.60 +1 | Q3 0:00: 0.60 +3 | Q3 2:41: 0.68 +6 | Q3 6:21: 0.68 -2 | Q3 9:02: 0.68 -1

PRIOR ALERT REASONING TRAIL:
Q2 4:41 BUY CANDIDATE → SEND (treated as tracking — first structural signal for DEN)
Q3 10:23 TRACKING → SEND (DEN leading 3, floor 0.60, I4 only, CONDITIONAL)
Q3 9:02 BUY CANDIDATE → SUPPRESS (MODEST conviction I2+I4, opp holds I1 counter-indicator, TP UNLIKELY)
Q3 6:21 BUY FIRED → SUPPRESS (MODEST I2+I4, opp I1 structural counter, TP CONTESTED, weak structural case despite floor 0.68)
Q4 5:54 POSITION_OPEN → SEND (B-Rank grad, 37 holds, but SHIFT combined read)
Q4 5:54 POSITION_SAFE → SEND

RULES:
- BWC_EDGE: SEND by default — position update for subscriber already holding. MAY SUPPRESS if structural stress override applies. MUST include RISK line.
- POSITION_OPEN: Graduated through checkpoint system. B-Rank: Sustained DOMINANT/STRONG conviction with lead 3+. 1 CP flip — structural control briefly contested.
  Lane: heavy_favorite — PO confirms structural read but line may offer limited edge.
  Also check: If eligible MF says RISING but full CP trend says DECLINING, graduation badge may overstate current control.
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded.
  For position alerts (POSITION_OPEN, BWC_EDGE): When rolling window is SIGNIFICANTLY weaker than cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES per-alert-type ALWAYS SEND rules.
  DOWNGRADE preferred over SUPPRESS for POSITION_OPEN.
${xgbBlock ? `- XGB REASONING (use SHAP drivers to interpret floor-XGB disagreements):
  DIVERGENT — XGB BELOW FLOOR: SHAP tells you why.
  • efg as primary negative driver → shooting variance. Cross-ref sustainability.
  • paint/fta/oreb as negative drivers → STRUCTURAL interior weakness. Cumulative floor may be anchoring past early-game dominance. Weight XGB heavily.
  • biglead negative = team hasn't converted structural control to scoreboard separation.
  DECISION GUIDANCE:
  • BWC/PO with XGB < 0.50 + paint/fta negative in SHAP: lean DOWNGRADE — interior dominance thesis failing in raw stats.
  • Floor > 0.70 AND XGB > 0.70: highest-conviction combined read.
  • 2+ CP flips + XGB < 0.50: 9.7% win rate. Near-automatic SUPPRESS.` : ''}

BODY RULES: Lead with score + action, explain WHY in basketball terms, 2-4 sentences max.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [2-3 sentences]
BODY: [If SEND/DOWNGRADE: plain-English alert. If SUPPRESS: blank]`;
}

// ── Main ──
async function main() {
  if (!ANTHROPIC_KEY) {
    console.error('Set ANTHROPIC_API_KEY env var');
    process.exit(1);
  }

  // XGB values computed from raw stats at these moments
  const xgbPO = {  // Q4 5:54 POSITION_OPEN
    features: [0.877, 0, -5, 0, -2, -3, 0, -2, -2, 0.023, 11, 0.088, 0.167, 0.5],
    prob: 0.494,
    divergence: 0.494 - 0.77,
    aligned: false,
    shap: [
      { f: 'progress', v: 0.426 }, { f: 'pot', v: -0.352 }, { f: 'efg', v: -0.269 },
      { f: 'paint', v: -0.245 }, { f: 'fta', v: -0.239 }
    ],
  };
  const xgbBWC = {  // Q4 5:32 BWC_EDGE
    features: [0.885, 0, -5, 0, -2, -4, 0, -1, -2, 0.024, 11, 0.097, 0.146, 0.5],
    prob: 0.548,
    divergence: 0.548 - 0.77,
    aligned: false,
    shap: [
      { f: 'progress', v: 0.426 }, { f: 'pot', v: -0.317 }, { f: 'paint', v: -0.266 },
      { f: 'efg', v: -0.247 }, { f: 'fta', v: -0.234 }
    ],
  };

  const alerts = [
    {
      label: 'Q4 5:54 — POSITION_OPEN (B-Rank)',
      data: {
        alert_type: 'POSITION_OPEN', alert_tier: 'FIRED', control_team: 'DEN',
        floor_score: 0.77, margin: 3, period: 4, clock: '5:54',
        home_pts_live: 107, away_pts_live: 104,
        i1: 0, i2: 1, i3: 1, i4: 1, i5: 0.5,
        ctrl_sust: 'LOCKED IN', opp_sust: 'DURABLE',
        tp_class: null, ls_class: 'SAFE', bwc_state: 'LOCK',
        edge: 1.1, ml: -315, spread: -3.5,
      },
      xgb: xgbPO,
      originalDecision: 'SEND',
    },
    {
      label: 'Q4 5:32 — BWC_EDGE (lead compressed to 1)',
      data: {
        alert_type: 'BWC_EDGE', alert_tier: 'FIRED', control_team: 'DEN',
        floor_score: 0.77, margin: 1, period: 4, clock: '5:32',
        home_pts_live: 107, away_pts_live: 106,
        i1: 0, i2: 1, i3: 1, i4: 1, i5: 0.5,
        ctrl_sust: 'LOCKED IN', opp_sust: 'DURABLE',
        tp_class: null, ls_class: null, bwc_state: 'EDGE',
        edge: 3.3, ml: -280, spread: -3.5,
      },
      xgb: xgbBWC,
      originalDecision: 'SEND',
    },
  ];

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  XGB AGENT REPLAY — DEN vs MIN (Apr 20, 2026)');
  console.log('  Model: claude-opus-4-8 | FINAL: MIN 119, DEN 114');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const alert of alerts) {
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`  ${alert.label}`);
    console.log(`  Original agent decision: ${alert.originalDecision} (WRONG — DEN lost)`);
    console.log(`  XGB: ${(alert.xgb.prob * 100).toFixed(1)}% (floor ${alert.data.floor_score}, divergence ${(alert.xgb.divergence * 100).toFixed(1)}%)`);
    console.log(`${'━'.repeat(60)}\n`);

    // A) WITHOUT XGB
    console.log('  ── RUN A: WITHOUT XGB ──');
    const promptA = buildTestPrompt(alert.data, null);
    try {
      const resultA = await callAgent(promptA);
      console.log(`  DECISION: ${resultA.decision}`);
      console.log(`  REASONING: ${resultA.reasoning}`);
      if (resultA.body && resultA.body !== 'blank' && resultA.body.toLowerCase() !== 'n/a') {
        console.log(`  BODY: ${resultA.body.substring(0, 200)}`);
      }
      console.log(`  Tokens: ${resultA.usage?.input_tokens}in/${resultA.usage?.output_tokens}out`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }

    console.log('');

    // B) WITH XGB
    console.log('  ── RUN B: WITH XGB ──');
    const promptB = buildTestPrompt(alert.data, alert.xgb);
    try {
      const resultB = await callAgent(promptB);
      console.log(`  DECISION: ${resultB.decision}`);
      console.log(`  REASONING: ${resultB.reasoning}`);
      if (resultB.body && resultB.body !== 'blank' && resultB.body.toLowerCase() !== 'n/a') {
        console.log(`  BODY: ${resultB.body.substring(0, 200)}`);
      }
      console.log(`  Tokens: ${resultB.usage?.input_tokens}in/${resultB.usage?.output_tokens}out`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }

    console.log('');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  REPLAY COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
