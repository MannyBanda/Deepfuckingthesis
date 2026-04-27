#!/usr/bin/env node
/**
 * XGB REPLAY TEST — DEN vs MIN (Apr 20, 2026)
 * 
 * Pulls real snapshot data from prod, computes XGB predictions retroactively,
 * and compares with actual agent decisions (which had NO XGB context).
 */

import { readFileSync } from 'fs';

// ── Load XGB model ──
const XGB_MODEL = JSON.parse(readFileSync('netlify/functions/xgb-model.json', 'utf8'));
const XGB_FEATURE_LABELS = ['progress','paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs'];

function predictXGB(features) {
  if (!XGB_MODEL) return null;
  let sum = 0;
  for (const tree of XGB_MODEL.trees) {
    let node = 0;
    while (tree.l[node] !== -1) {
      const fval = features[tree.s[node]] ?? 0;
      node = fval < tree.c[node] ? tree.l[node] : tree.r[node];
    }
    sum += tree.w[node];
  }
  const baseLogit = Math.log(XGB_MODEL.base_score / (1 - XGB_MODEL.base_score));
  return 1 / (1 + Math.exp(-(baseLogit + sum)));
}

function computeXGBContributions(features) {
  if (!features || !XGB_MODEL?.trees?.[0]?.ev) return null;
  const contribs = new Float64Array(14);
  for (let ti = 0; ti < XGB_MODEL.trees.length; ti++) {
    const tree = XGB_MODEL.trees[ti];
    let node = 0;
    while (tree.l[node] !== -1) {
      const feat = tree.s[node];
      const child = (features[feat] ?? 0) < tree.c[node] ? tree.l[node] : tree.r[node];
      contribs[feat] += tree.ev[child] - tree.ev[node];
      node = child;
    }
  }
  const ranked = [];
  for (let i = 0; i < 14; i++) {
    ranked.push({ f: XGB_FEATURE_LABELS[i], v: Math.round(contribs[i] * 1000) / 1000 });
  }
  ranked.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  return ranked.slice(0, 5);
}

function extractFeatures(raw, ctrlTeam, isHome, period, clock) {
  const hs = raw.home;
  const as = raw.away;
  const flip = isHome ? 1 : -1;

  // Game progress
  let clockMin = 6;
  try {
    const parts = String(clock || '12:00').split(':');
    clockMin = parseInt(parts[0]) + parseInt(parts[1] || 0) / 60;
  } catch(e) {}
  const elapsed = (Math.min(period, 4) - 1) * 12 + (12 - clockMin);
  const progress = Math.min(elapsed / 48, 1.0);

  // eFG
  const hFGA = hs.fga || 0, aFGA = as.fga || 0;
  const hFGM = hs.fgm || 0, aFGM = as.fgm || 0;
  const hFG3M = hs.fg3m || 0, aFG3M = as.fg3m || 0;
  const hFG3A = hs.fg3a || 0, aFG3A = as.fg3a || 0;
  const hEFG = hFGA > 0 ? (hFGM + 0.5 * hFG3M) / hFGA : 0;
  const aEFG = aFGA > 0 ? (aFGM + 0.5 * aFG3M) / aFGA : 0;

  // Rim pct (BDL = atRimA/atRimM)
  const hRimM = hs.atRimM || 0, hRimA = hs.atRimA || 0;
  const aRimM = as.atRimM || 0, aRimA = as.atRimA || 0;
  const rimDiff = ((hRimM / Math.max(hRimA, 1)) - (aRimM / Math.max(aRimA, 1))) * flip;

  // Runs (from runs6 if available — we don't have PBP in snapshots, use 0.5)
  const runShare = 0.5;

  return [
    progress,
    ((hs.paint || 0) - (as.paint || 0)) * flip,        // paint diff
    ((hs.pot || 0) - (as.pot || 0)) * flip,             // POT diff
    ((hs.to || 0) - (as.to || 0)) * flip,               // TO diff (positive = MORE ctrl TOs = bad)
    ((hs.stl || 0) - (as.stl || 0)) * flip,             // steals diff
    ((hs.oreb || 0) - (as.oreb || 0)) * flip,           // OREB diff
    ((hs.ast || 0) - (as.ast || 0)) * flip,             // assists diff
    ((hs.blk || 0) - (as.blk || 0)) * flip,             // blocks diff
    ((hs.fta || 0) - (as.fta || 0)) * flip,             // FTA diff
    (hEFG - aEFG) * flip,                                // eFG diff
    ((hs.bigLead || 0) - (as.bigLead || 0)) * flip,     // biggest lead diff
    (hFGA > 0 && aFGA > 0 ? (hFG3A / hFGA - aFG3A / aFGA) : 0) * flip,  // 3PR diff
    rimDiff,
    runShare,
  ];
}

// ── Main ──
async function main() {
  const GAME_ID = 'b3b02f44-3d8f-4fd1-a33e-207fbf6b91b6';
  
  // Fetch snapshots
  const resp = await fetch(
    `https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?action=history&game_id=${GAME_ID}`,
    { headers: { 'Authorization': 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64') } }
  );
  const data = await resp.json();
  const snaps = data.snapshots || [];
  console.log(`Loaded ${snaps.length} snapshots\n`);

  // Key alert moments (DEN = home)
  const moments = [
    { label: 'Q2 4:41 — BUY CANDIDATE (→ SEND as tracking)', period: 2, clock: '4:41', agentDecision: 'SEND', alertType: 'BUY CANDIDATE' },
    { label: 'Q3 9:02 — BUY CANDIDATE', period: 3, clock: '9:02', agentDecision: 'SUPPRESS', alertType: 'BUY CANDIDATE' },
    { label: 'Q3 6:21 — BUY FIRED (trailing by 2)', period: 3, clock: '6:21', agentDecision: 'SUPPRESS', alertType: 'BUY FIRED' },
    { label: 'Q4 11:19 — AUTO_ANALYSIS (leading 4)', period: 4, clock: '11:19', agentDecision: 'SUPPRESS', alertType: 'AUTO_ANALYSIS' },
    { label: 'Q4 5:54 — POSITION_OPEN B-Rank (leading 3)', period: 4, clock: '5:54', agentDecision: 'SEND', alertType: 'POSITION_OPEN' },
    { label: 'Q4 5:32 — BWC_EDGE (leading 1)', period: 4, clock: '5:32', agentDecision: 'SEND', alertType: 'BWC_EDGE' },
    { label: 'Q4 4:06 — CTRL FLIPS TO MIN (trailing 3)', period: 4, clock: '4:06', agentDecision: 'N/A', alertType: 'CTRL FLIP' },
  ];

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DEN (home) vs MIN (away) — Apr 20, 2026');
  console.log('  FINAL: MIN 119, DEN 114 — MIN WINS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const m of moments) {
    // Find matching server snapshot with raw_stats
    const match = snaps.find(s => 
      s.period === m.period && 
      s.clock === m.clock && 
      s.source === 'server' && 
      s.raw_stats_json
    );

    if (!match) {
      console.log(`--- ${m.label}: NO SNAPSHOT ---\n`);
      continue;
    }

    const raw = typeof match.raw_stats_json === 'string' ? JSON.parse(match.raw_stats_json) : match.raw_stats_json;
    const ctrlTeam = match.floor_team;
    const isHome = ctrlTeam === 'DEN'; // DEN is home
    const floor = match.floor_score;
    const margin = match.home_pts - match.away_pts; // home - away

    const features = extractFeatures(raw, ctrlTeam, isHome, m.period, m.clock);
    const xgbProb = predictXGB(features);
    const shap = computeXGBContributions(features);
    const divergence = xgbProb != null ? xgbProb - floor : null;
    const aligned = xgbProb != null ? Math.abs(xgbProb - floor) < 0.15 : null;

    // XGB gate check
    let gateResult = 'N/A';
    if (xgbProb != null) {
      if (m.alertType.includes('BUY') && !m.alertType.includes('WINDOW')) {
        const buyXgbFloor = m.period >= 4 ? 0.60 : m.period >= 3 ? 0.45 : 0.40;
        gateResult = xgbProb < buyXgbFloor ? `GATE SUPPRESS (xgb ${(xgbProb*100).toFixed(1)}% < threshold ${(buyXgbFloor*100).toFixed(0)}%)` : `GATE PASS (xgb ${(xgbProb*100).toFixed(1)}% ≥ threshold ${(buyXgbFloor*100).toFixed(0)}%)`;
      } else if (m.alertType === 'BWC_EDGE') {
        gateResult = xgbProb < 0.40 ? `GATE SUPPRESS (xgb < 40%)` : `GATE PASS`;
      } else if (m.alertType === 'POSITION_OPEN') {
        gateResult = 'NO GATE (PO not gated)';
      } else if (m.alertType === 'POSITION_SAFE') {
        gateResult = xgbProb < 0.50 ? `GATE SUPPRESS` : `GATE PASS`;
      }
    }

    // Calibration lookup (BUY only)
    let calibrated = '';
    if (m.alertType.includes('BUY') && xgbProb != null) {
      const q = m.period;
      const xp = xgbProb;
      if (q >= 4) calibrated = xp >= 0.70 ? '97%' : xp >= 0.55 ? '50%' : xp >= 0.40 ? '38%' : '29%';
      else if (q >= 3) calibrated = xp >= 0.70 ? '100%' : xp >= 0.55 ? '76%' : xp >= 0.40 ? '73%' : '63%';
      else calibrated = xp >= 0.70 ? '100%' : xp >= 0.55 ? '82%' : xp >= 0.40 ? '78%' : '76%';
      calibrated = ` → calibrated baseline: ${calibrated}`;
    }

    console.log(`┌──────────────────────────────────────────────────────────────`);
    console.log(`│ ${m.label}`);
    console.log(`│ Score: DEN ${match.home_pts} - MIN ${match.away_pts} (margin ${margin > 0 ? '+' : ''}${margin})`);
    console.log(`│ Floor: ${floor} (ctrl=${ctrlTeam}) | Agent: ${m.agentDecision}`);
    console.log(`│`);
    console.log(`│ XGB Win Prob: ${xgbProb != null ? (xgbProb * 100).toFixed(1) + '%' : 'N/A'}${calibrated}`);
    console.log(`│ Divergence:   ${divergence != null ? (divergence > 0 ? '+' : '') + (divergence * 100).toFixed(1) + '%' : 'N/A'} ${aligned ? '✓ ALIGNED' : '⚠ DIVERGENT'}`);
    console.log(`│ XGB Gate:     ${gateResult}`);
    console.log(`│ SHAP:         ${shap ? shap.map(s => `${s.f}=${s.v > 0 ? '+' : ''}${s.v}`).join(', ') : 'N/A'}`);
    console.log(`│`);
    
    // Feature values for inspection
    const featureMap = {};
    features.forEach((v, i) => featureMap[XGB_FEATURE_LABELS[i]] = v);
    console.log(`│ Features: paint=${featureMap.paint} pot=${featureMap.pot} to=${featureMap.to} stl=${featureMap.stl} oreb=${featureMap.oreb}`);
    console.log(`│           ast=${featureMap.ast} blk=${featureMap.blk} fta=${featureMap.fta} efg=${featureMap.efg.toFixed(3)} biglead=${featureMap.biglead}`);
    console.log(`│           3pr=${featureMap['3pr'].toFixed(3)} rim=${featureMap.rim_pct.toFixed(3)} runs=${featureMap.runs} progress=${featureMap.progress.toFixed(3)}`);
    
    // Verdict
    const correct = m.agentDecision === 'SEND' ? 'WRONG (DEN lost)' : m.agentDecision === 'SUPPRESS' ? 'CORRECT (DEN lost)' : '';
    if (correct) {
      console.log(`│`);
      console.log(`│ ★ AGENT WAS: ${correct}`);
    }
    console.log(`└──────────────────────────────────────────────────────────────\n`);
  }
}

main().catch(console.error);
