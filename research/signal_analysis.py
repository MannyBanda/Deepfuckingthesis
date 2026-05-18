#!/usr/bin/env python3
"""Signal analysis for agent prompt rewrite — WNBA focus.
Questions:
  Q1: How much of MC Cum's AUC comes from margin echo?
  Q2: When MC and XGB disagree, who's right — conditioned on margin direction?
  Q3: Floor directional accuracy (proxy from biglead/margin)
  Q4: MC Cum's correlation with margin
"""
import json, math, sys
from collections import defaultdict

PERIOD_SECS = 600  # 10-minute WNBA quarters

# ── Load data ────────────────────────────────────────────────────────────────
print("Loading data...")
with open('/tmp/wnba_training.json') as f:
    rows = json.load(f)
print(f"  {len(rows)} checkpoints loaded")

with open('netlify/functions/xgb-model-wnba.json') as f:
    model = json.load(f)
print(f"  XGB model: {len(model['trees'])} trees, base_score={model['base_score']}")

FEATURES = model['features']
print(f"  Features: {FEATURES}")

# ── XGB scorer ───────────────────────────────────────────────────────────────
def sigmoid(x):
    if x > 30: return 1.0
    if x < -30: return 0.0
    return 1.0 / (1.0 + math.exp(-x))

def predict_tree(tree, features):
    idx = 0
    s, c, l, r, w = tree['s'], tree['c'], tree['l'], tree['r'], tree['w']
    while l[idx] != -1:  # not a leaf
        if features[s[idx]] < c[idx]:
            idx = l[idx]
        else:
            idx = r[idx]
    return w[idx]

def predict_xgb(features_vec):
    base_logit = math.log(model['base_score'] / (1 - model['base_score']))
    total = base_logit
    for tree in model['trees']:
        total += predict_tree(tree, features_vec)
    return sigmoid(total)

# ── Compute windowed biglead ─────────────────────────────────────────────────
print("\nComputing windowed biglead...")
games = defaultdict(list)
for r in rows:
    games[r['game_id']].append(r)

def compute_windowed_biglead(game_rows):
    sorted_rows = sorted(game_rows, key=lambda x: x['gs'])
    ref_team = sorted_rows[0]['ctrl']
    for r in sorted_rows:
        r['_ref_margin'] = r['margin'] if r['ctrl'] == ref_team else -r['margin']
    q_max_ref, q_max_opp = {}, {}
    for r in sorted_rows:
        q = r['q']
        rm = r['_ref_margin']
        q_max_ref[q] = max(q_max_ref.get(q, 0), max(rm, 0))
        q_max_opp[q] = max(q_max_opp.get(q, 0), max(-rm, 0))
    first = sorted_rows[0]
    cum_biglead = first['biglead']
    if first['ctrl'] == ref_team:
        q_max_ref[1] = max(cum_biglead, 0) if cum_biglead > 0 else 0
        q_max_opp[1] = max(-cum_biglead, 0) if cum_biglead < 0 else 0
    else:
        q_max_ref[1] = max(-cum_biglead, 0) if cum_biglead < 0 else 0
        q_max_opp[1] = max(cum_biglead, 0) if cum_biglead > 0 else 0
    for r in sorted_rows:
        q, gs = r['q'], r['gs']
        elapsed_in_q = gs - (q - 1) * PERIOD_SECS
        completion = max(0, min(1, elapsed_in_q / PERIOD_SECS))
        window_qs = []
        if q == 2:
            window_qs.append((max(0, 1.0 - completion), 1))
            window_qs.append((1.0, 2))
        elif q == 3:
            window_qs.append((1.0, 2))
            window_qs.append((1.0, 3))
        elif q == 4:
            window_qs.append((max(0, 1.0 - completion), 2))
            window_qs.append((1.0, 3))
            window_qs.append((1.0, 4))
        w_ref, w_opp = 0, 0
        for weight, wq in window_qs:
            if weight > 0.1:
                w_ref = max(w_ref, q_max_ref.get(wq, 0))
                w_opp = max(w_opp, q_max_opp.get(wq, 0))
        if r['ctrl'] == ref_team:
            r['_wb'] = w_ref - w_opp
        else:
            r['_wb'] = w_opp - w_ref

for gid, grs in games.items():
    compute_windowed_biglead(grs)

# ── Score XGB predictions ────────────────────────────────────────────────────
print("Scoring XGB predictions...")
for r in rows:
    wb = r.get('_wb', r.get('biglead', 0))
    erosion = wb - r.get('margin', 0)
    fvec = [
        wb,                         # windowed_biglead
        r.get('disruption', 0),     # disruption
        r.get('ast', 0),            # ast
        r.get('oreb', 0),           # oreb
        r.get('to_ratio', 0),       # to_ratio
        r.get('ftm', 0),            # ftm
        r.get('ast_ratio', 0),      # ast_ratio
        r.get('pf', 0),             # pf
        r.get('blk', 0),            # blk
        r.get('fta', 0),            # fta
        r.get('efg', 0),            # efg
        r.get('pot', 0),            # pot
        erosion,                    # biglead_erosion
    ]
    r['xgb'] = predict_xgb(fvec)

# Sanity check
xgb_vals = [r['xgb'] for r in rows]
print(f"  XGB range: {min(xgb_vals):.3f} - {max(xgb_vals):.3f}, mean={sum(xgb_vals)/len(xgb_vals):.3f}")

# ── AUC helper ───────────────────────────────────────────────────────────────
def compute_auc(predictions, labels):
    """Compute AUC from lists of predicted probabilities and binary labels."""
    pairs = list(zip(predictions, labels))
    pairs.sort(key=lambda x: -x[0])
    tp, fp, prev_tp, prev_fp = 0, 0, 0, 0
    auc = 0.0
    prev_score = float('inf')
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return 0.5
    for score, label in pairs:
        if score != prev_score:
            auc += (fp - prev_fp) * (tp + prev_tp) / 2.0
            prev_tp, prev_fp = tp, fp
            prev_score = score
        if label:
            tp += 1
        else:
            fp += 1
    auc += (fp - prev_fp) * (tp + prev_tp) / 2.0
    return auc / (pos * neg)

# ═══════════════════════════════════════════════════════════════════════════════
# Q1: MARGIN-CONDITIONED AUC
# ═══════════════════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("Q1: AUC BY MARGIN DIRECTION (ctrl leading vs trailing)")
print("="*70)

for label, condition in [
    ("ALL", lambda r: True),
    ("CTRL LEADING (margin > 0)", lambda r: r['margin'] > 0),
    ("CTRL TRAILING (margin < 0)", lambda r: r['margin'] < 0),
    ("CLOSE (|margin| <= 8)", lambda r: abs(r['margin']) <= 8),
    ("CTRL TRAILING 1-9", lambda r: -9 <= r['margin'] < 0),
    ("CTRL TRAILING 10+", lambda r: r['margin'] <= -10),
]:
    for qtr in [None, 2, 3, 4]:
        subset = [r for r in rows if condition(r) and (qtr is None or r['q'] == qtr)]
        if len(subset) < 20:
            continue
        xgb_auc = compute_auc([r['xgb'] for r in subset], [1 if r['won'] else 0 for r in subset])
        mc_auc = compute_auc([r['mc_cum'] for r in subset], [1 if r['won'] else 0 for r in subset])
        n_won = sum(1 for r in subset if r['won'])
        q_label = f"Q{qtr}" if qtr else "ALL"
        print(f"  {label:35s} {q_label:4s} n={len(subset):5d} won={n_won:4d} ({100*n_won/len(subset):5.1f}%) | XGB AUC={xgb_auc:.3f} | MC AUC={mc_auc:.3f} | Δ={xgb_auc-mc_auc:+.3f}")

# ═══════════════════════════════════════════════════════════════════════════════
# Q2: DISAGREEMENT CONDITIONED ON MARGIN
# ═══════════════════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("Q2: WHEN MC AND XGB DISAGREE (>15pp gap) — WHO IS RIGHT?")
print("="*70)

for margin_label, margin_cond in [
    ("ALL GAMES", lambda r: True),
    ("CTRL LEADING", lambda r: r['margin'] > 0),
    ("CTRL TRAILING", lambda r: r['margin'] < 0),
    ("CLOSE |m|<=8", lambda r: abs(r['margin']) <= 8),
]:
    for qtr in [None, 2, 3, 4]:
        subset = [r for r in rows if margin_cond(r) and (qtr is None or r['q'] == qtr)]
        if len(subset) < 10:
            continue
        
        mc_leads = [r for r in subset if r['mc_cum'] - r['xgb'] > 0.15]
        xgb_leads = [r for r in subset if r['xgb'] - r['mc_cum'] > 0.15]
        
        mc_right = sum(1 for r in mc_leads if r['won']) / len(mc_leads) * 100 if mc_leads else 0
        xgb_right = sum(1 for r in xgb_leads if r['won']) / len(xgb_leads) * 100 if xgb_leads else 0
        
        q_label = f"Q{qtr}" if qtr else "ALL"
        if len(mc_leads) >= 5 or len(xgb_leads) >= 5:
            print(f"  {margin_label:20s} {q_label:4s} | MC>>XGB: {mc_right:5.1f}% right (n={len(mc_leads):4d}) | XGB>>MC: {xgb_right:5.1f}% right (n={len(xgb_leads):4d})")

# ═══════════════════════════════════════════════════════════════════════════════
# Q3: SIGNAL DIRECTIONAL ACCURACY (who does it say wins, and are they right?)
# ═══════════════════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("Q3: DIRECTIONAL ACCURACY (signal > 0.50 → ctrl wins?)")
print("="*70)

for signal_name, get_val in [("XGB", lambda r: r['xgb']), ("MC_CUM", lambda r: r['mc_cum'])]:
    for qtr in [None, 2, 3, 4]:
        subset = [r for r in rows if (qtr is None or r['q'] == qtr)]
        bullish = [r for r in subset if get_val(r) > 0.50]
        bearish = [r for r in subset if get_val(r) <= 0.50]
        
        bull_right = sum(1 for r in bullish if r['won']) / len(bullish) * 100 if bullish else 0
        bear_right = sum(1 for r in bearish if not r['won']) / len(bearish) * 100 if bearish else 0
        overall = (sum(1 for r in bullish if r['won']) + sum(1 for r in bearish if not r['won'])) / len(subset) * 100
        
        q_label = f"Q{qtr}" if qtr else "ALL"
        print(f"  {signal_name:8s} {q_label:4s} | >0.50 right: {bull_right:5.1f}% (n={len(bullish):4d}) | <=0.50 right: {bear_right:5.1f}% (n={len(bearish):4d}) | Overall: {overall:5.1f}%")

# Biglead-based floor proxy: biglead > 0 means ctrl had bigger lead
print("\n  BIGLEAD AS FLOOR PROXY (biglead > 0 → ctrl wins?):")
for qtr in [None, 2, 3, 4]:
    subset = [r for r in rows if (qtr is None or r['q'] == qtr)]
    pos = [r for r in subset if r['biglead'] > 0]
    neg = [r for r in subset if r['biglead'] <= 0]
    pos_right = sum(1 for r in pos if r['won']) / len(pos) * 100 if pos else 0
    neg_right = sum(1 for r in neg if not r['won']) / len(neg) * 100 if neg else 0
    overall = (sum(1 for r in pos if r['won']) + sum(1 for r in neg if not r['won'])) / len(subset) * 100
    q_label = f"Q{qtr}" if qtr else "ALL"
    print(f"  BIGLEAD  {q_label:4s} | >0 right: {pos_right:5.1f}% (n={len(pos):4d}) | <=0 right: {neg_right:5.1f}% (n={len(neg):4d}) | Overall: {overall:5.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# Q4: MC CUM CORRELATION WITH MARGIN
# ═══════════════════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("Q4: MC CUM CORRELATION WITH MARGIN & MARGIN ECHO")
print("="*70)

def pearson_r(xs, ys):
    n = len(xs)
    mx, my = sum(xs)/n, sum(ys)/n
    num = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x-mx)**2 for x in xs))
    dy = math.sqrt(sum((y-my)**2 for y in ys))
    if dx == 0 or dy == 0:
        return 0
    return num / (dx * dy)

margins = [r['margin'] for r in rows]
mc_vals = [r['mc_cum'] for r in rows]
xgb_vals = [r['xgb'] for r in rows]

print(f"  MC Cum ↔ margin: r = {pearson_r(mc_vals, margins):.3f}")
print(f"  XGB    ↔ margin: r = {pearson_r(xgb_vals, margins):.3f}")
print(f"  MC Cum ↔ XGB:    r = {pearson_r(mc_vals, xgb_vals):.3f}")

for qtr in [2, 3, 4]:
    q_rows = [r for r in rows if r['q'] == qtr]
    q_mc = [r['mc_cum'] for r in q_rows]
    q_xgb = [r['xgb'] for r in q_rows]
    q_mar = [r['margin'] for r in q_rows]
    print(f"  Q{qtr}: MC↔margin={pearson_r(q_mc, q_mar):.3f} | XGB↔margin={pearson_r(q_xgb, q_mar):.3f} | MC↔XGB={pearson_r(q_mc, q_xgb):.3f}")

# MC echo rate: how often MC > 0.50 agrees with margin > 0
mc_agrees_margin = sum(1 for r in rows if (r['mc_cum'] > 0.50) == (r['margin'] > 0))
xgb_agrees_margin = sum(1 for r in rows if (r['xgb'] > 0.50) == (r['margin'] > 0))
tied = sum(1 for r in rows if r['margin'] == 0)
non_tied = len(rows) - tied
print(f"\n  MC echo rate (>0.50 agrees with margin sign): {mc_agrees_margin}/{non_tied} = {100*mc_agrees_margin/non_tied:.1f}%")
print(f"  XGB echo rate: {xgb_agrees_margin}/{non_tied} = {100*xgb_agrees_margin/non_tied:.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# BONUS: COMPOUND AGREEMENT BY MARGIN CONTEXT
# ═══════════════════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("BONUS: COMPOUND STATES BY MARGIN DIRECTION (Q3+Q4)")
print("="*70)

late = [r for r in rows if r['q'] >= 3]
for label, cond in [
    ("MC>=0.70 + XGB>=0.65 (both high)", lambda r: r['mc_cum']>=0.70 and r['xgb']>=0.65),
    ("MC>=0.70 + XGB<0.50 (MC high, XGB low)", lambda r: r['mc_cum']>=0.70 and r['xgb']<0.50),
    ("MC<0.50 + XGB>=0.65 (XGB high, MC low)", lambda r: r['mc_cum']<0.50 and r['xgb']>=0.65),
    ("MC<0.50 + XGB<0.50 (both low)", lambda r: r['mc_cum']<0.50 and r['xgb']<0.50),
]:
    for margin_label, m_cond in [("ALL", lambda r: True), ("LEADING", lambda r: r['margin']>0), ("TRAILING", lambda r: r['margin']<0)]:
        subset = [r for r in late if cond(r) and m_cond(r)]
        if len(subset) < 5:
            continue
        wr = sum(1 for r in subset if r['won']) / len(subset) * 100
        avg_m = sum(r['margin'] for r in subset) / len(subset)
        print(f"  {label:45s} {margin_label:10s} n={len(subset):4d} WR={wr:5.1f}% avg_margin={avg_m:+.1f}")

print("\nDone.")
