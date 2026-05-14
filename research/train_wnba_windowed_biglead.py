#!/usr/bin/env python3
"""
WNBA XGB: Cumulative vs Windowed Biglead Comparison.
Pulls training data from wnba_xgb_training, computes windowed biglead
as max margin within cross-fade window, trains both models, compares OOF AUC.
"""
import json, sys
import numpy as np
import pandas as pd
from collections import defaultdict
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import roc_auc_score, brier_score_loss, accuracy_score
import xgboost as xgb

# ── Production feature set (12 features, matches xgb-model-wnba.json) ──
PROD_FEATURES = ['biglead','disruption','ast','oreb','to_ratio','ftm','ast_ratio','pf','blk','fta','efg','pot']

# ── Load training data ──
print("Loading training data...")
with open('/tmp/wnba_xgb_training.json') as f:
    rows = json.load(f)
print(f"  {len(rows)} rows, {len(set(r['game_id'] for r in rows))} games")

# ── Compute windowed biglead ──
print("\nComputing windowed biglead...")

# Group by game
games = defaultdict(list)
for r in rows:
    games[r['game_id']].append(r)

PERIOD_SECS = 600  # 10-minute WNBA quarters

def compute_windowed_biglead(game_rows):
    """Compute windowed biglead for each checkpoint in a game.
    
    Uses same cross-fade logic as production computeServerWindow:
    Q2: fading Q1 + partial Q2
    Q3: Q2 + partial Q3
    Q4: fading Q2 + Q3 + partial Q4
    """
    sorted_rows = sorted(game_rows, key=lambda x: x['gs'])
    
    # Pick reference team: first ctrl seen
    ref_team = sorted_rows[0]['ctrl']
    
    # Convert all margins to reference-team-relative
    for r in sorted_rows:
        if r['ctrl'] == ref_team:
            r['_ref_margin'] = r['margin']
        else:
            r['_ref_margin'] = -r['margin']
    
    # Compute per-quarter max margins (ref team perspective)
    # Per-quarter: track max ref_margin (ref team's best lead)
    # and max -ref_margin (opponent's best lead)
    q_max_ref = {}   # quarter -> max ref_margin (ref team's peak lead)
    q_max_opp = {}   # quarter -> max -ref_margin (opp's peak lead)
    
    for r in sorted_rows:
        q = r['q']
        rm = r['_ref_margin']
        q_max_ref[q] = max(q_max_ref.get(q, 0), max(rm, 0))
        q_max_opp[q] = max(q_max_opp.get(q, 0), max(-rm, 0))
    
    # Also include Q1 from cumulative biglead at first Q2 checkpoint
    # Since Q1 isn't in training data (Q2+ only), approximate from first checkpoint
    # The first checkpoint is Q2_7.5 (gs=750). The margin at that point reflects
    # everything up to 2.5 minutes into Q2. We don't have Q1-only data.
    # For Q1 max margins, we'd need PBP data. Use biglead from first row as approximation.
    first = sorted_rows[0]
    cum_biglead = first['biglead']  # This is ctrl-relative at first checkpoint
    # Convert to ref-relative
    if first['ctrl'] == ref_team:
        # biglead = ctrl_biggest_lead - opp_biggest_lead
        # If positive: ref team had bigger lead
        # We can infer: ref_biggest_lead >= cum_biglead + opp_biggest_lead
        # But we don't know the individual components from just the diff
        # Approximate: if cum_biglead > 0, ref had at least that much lead
        q_max_ref[1] = max(cum_biglead, 0) if cum_biglead > 0 else 0
        q_max_opp[1] = max(-cum_biglead, 0) if cum_biglead < 0 else 0
    else:
        q_max_ref[1] = max(-cum_biglead, 0) if cum_biglead < 0 else 0
        q_max_opp[1] = max(cum_biglead, 0) if cum_biglead > 0 else 0
    
    # For each checkpoint, compute cross-fade windowed biglead
    results = {}
    for r in sorted_rows:
        q = r['q']
        gs = r['gs']
        
        # Elapsed fraction in current quarter
        elapsed_in_q = gs - (q - 1) * PERIOD_SECS
        completion = max(0, min(1, elapsed_in_q / PERIOD_SECS))
        
        # Cross-fade window: collect (weight, quarter) pairs
        window_qs = []
        if q == 2:
            window_qs.append((max(0, 1.0 - completion), 1))  # Q1 fading
            window_qs.append((1.0, 2))                        # current Q2
        elif q == 3:
            window_qs.append((1.0, 2))   # Q2 full weight
            window_qs.append((1.0, 3))   # current Q3
        elif q == 4:
            window_qs.append((max(0, 1.0 - completion), 2))  # Q2 fading
            window_qs.append((1.0, 3))                        # Q3 full weight
            window_qs.append((1.0, 4))                        # current Q4
        
        # Windowed biglead: weighted max of per-quarter maxes
        # Take the max across all window quarters (not weighted avg — it's a max signal)
        w_ref_biglead = 0
        w_opp_biglead = 0
        for weight, wq in window_qs:
            if weight > 0.1:  # Only include quarters with meaningful weight
                w_ref_biglead = max(w_ref_biglead, q_max_ref.get(wq, 0))
                w_opp_biglead = max(w_opp_biglead, q_max_opp.get(wq, 0))
        
        # Convert to ctrl-relative at this checkpoint
        if r['ctrl'] == ref_team:
            r['_windowed_biglead'] = w_ref_biglead - w_opp_biglead
        else:
            r['_windowed_biglead'] = w_opp_biglead - w_ref_biglead
        
        results[f"{r['game_id']}_{r['cp']}"] = r['_windowed_biglead']
    
    return results

all_windowed = {}
for gid, grs in games.items():
    wb = compute_windowed_biglead(grs)
    all_windowed.update(wb)

# ── Build DataFrames ──
print("\nBuilding feature matrices...")

records = []
for r in rows:
    key = f"{r['game_id']}_{r['cp']}"
    rec = {f: r.get(f, 0) for f in PROD_FEATURES}
    rec['windowed_biglead'] = all_windowed.get(key, rec['biglead'])
    rec['won'] = 1 if r['won'] else 0
    rec['game_id'] = r['game_id']
    rec['quarter'] = r['q']
    rec['margin'] = r.get('margin', 0)
    records.append(rec)

df = pd.DataFrame(records)
y = df['won'].values
groups = df['game_id'].values
quarters = df['quarter'].values

# Feature matrices
X_cum = df[PROD_FEATURES].values  # Current production (cumulative biglead)
feat_wind = PROD_FEATURES.copy()
feat_wind[0] = 'windowed_biglead'  # Replace biglead with windowed version
X_wind = df[feat_wind].values

print(f"  Feature matrix: {X_cum.shape}")
print(f"  Cumulative biglead range: [{df['biglead'].min():.0f}, {df['biglead'].max():.0f}]")
print(f"  Windowed biglead range: [{df['windowed_biglead'].min():.0f}, {df['windowed_biglead'].max():.0f}]")
print(f"  Correlation cum vs windowed: {df['biglead'].corr(df['windowed_biglead']):.3f}")

# ── Close game subset (margin within ±7) ──
close_mask = np.abs(df['margin'].values) <= 7

print(f"\n  Close games (|margin| <= 7): {close_mask.sum()} rows ({close_mask.sum()/len(df)*100:.1f}%)")

# ── Training ──
print("\n" + "="*60)
print("TRAINING: 5-fold stratified by game_id")
print("="*60)

# Hyperparams matching production WNBA model
params = {
    'max_depth': 4,
    'learning_rate': 0.03,
    'n_estimators': 300,
    'subsample': 0.8,
    'colsample_bytree': 0.8,
    'min_child_weight': 3,
    'objective': 'binary:logistic',
    'eval_metric': 'auc',
    'verbosity': 0,
    'random_state': 42,
}

sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)

def train_and_eval(X, feature_names, label):
    oof_preds = np.zeros(len(y))
    fold_aucs = []
    
    for fold, (train_idx, val_idx) in enumerate(sgkf.split(X, y, groups)):
        model = xgb.XGBClassifier(**params)
        model.fit(X[train_idx], y[train_idx], verbose=False)
        oof_preds[val_idx] = model.predict_proba(X[val_idx])[:, 1]
        fold_auc = roc_auc_score(y[val_idx], oof_preds[val_idx])
        fold_aucs.append(fold_auc)
    
    # Overall metrics
    auc = roc_auc_score(y, oof_preds)
    brier = brier_score_loss(y, oof_preds)
    acc = accuracy_score(y, (oof_preds >= 0.5).astype(int))
    
    # Per-quarter
    q_metrics = {}
    for q in [2, 3, 4]:
        mask = quarters == q
        if mask.sum() > 0:
            q_auc = roc_auc_score(y[mask], oof_preds[mask])
            q_brier = brier_score_loss(y[mask], oof_preds[mask])
            q_metrics[q] = {'auc': q_auc, 'brier': q_brier, 'n': mask.sum()}
    
    # Close game metrics
    close_auc = roc_auc_score(y[close_mask], oof_preds[close_mask]) if close_mask.sum() > 50 else None
    close_brier = brier_score_loss(y[close_mask], oof_preds[close_mask]) if close_mask.sum() > 50 else None
    
    # Close game per-quarter
    cq_metrics = {}
    for q in [2, 3, 4]:
        mask = (quarters == q) & close_mask
        if mask.sum() > 30:
            cq_auc = roc_auc_score(y[mask], oof_preds[mask])
            cq_metrics[q] = {'auc': cq_auc, 'n': mask.sum()}
    
    # Calibration: predicted vs actual for bins
    cal = {}
    for lo, hi, label_bin in [(0.5, 0.65, '50-65'), (0.65, 0.80, '65-80'), (0.80, 0.95, '80-95'), (0.95, 1.01, '95+')]:
        mask_bin = (oof_preds >= lo) & (oof_preds < hi)
        if mask_bin.sum() > 10:
            cal[label_bin] = {
                'predicted': oof_preds[mask_bin].mean(),
                'actual': y[mask_bin].mean(),
                'n': mask_bin.sum(),
                'gap': oof_preds[mask_bin].mean() - y[mask_bin].mean(),
            }
    
    # Train final model for SHAP
    final_model = xgb.XGBClassifier(**params)
    final_model.fit(X, y, verbose=False)
    importances = final_model.feature_importances_
    
    print(f"\n{'='*50}")
    print(f"  {label}")
    print(f"{'='*50}")
    print(f"  OOF AUC:    {auc:.4f}  (folds: {', '.join(f'{a:.3f}' for a in fold_aucs)})")
    print(f"  Brier:      {brier:.4f}")
    print(f"  Accuracy:   {acc:.4f}")
    print(f"\n  Per-Quarter:")
    for q, m in q_metrics.items():
        print(f"    Q{q}: AUC={m['auc']:.4f}  Brier={m['brier']:.4f}  (n={m['n']})")
    if close_auc:
        print(f"\n  Close Games (|margin| <= 7):")
        print(f"    AUC={close_auc:.4f}  Brier={close_brier:.4f}  (n={close_mask.sum()})")
        for q, m in cq_metrics.items():
            print(f"    Q{q}: AUC={m['auc']:.4f}  (n={m['n']})")
    print(f"\n  Calibration:")
    for bin_label, c in cal.items():
        print(f"    {bin_label}: predicted={c['predicted']:.3f} actual={c['actual']:.3f} gap={c['gap']:+.3f} (n={c['n']})")
    print(f"\n  Feature Importance (gain):")
    for idx in np.argsort(importances)[::-1]:
        print(f"    {feature_names[idx]:>15}: {importances[idx]:.4f}")
    
    return auc, oof_preds, final_model

# Run both
auc_cum, preds_cum, model_cum = train_and_eval(X_cum, PROD_FEATURES, "MODEL A: CUMULATIVE BIGLEAD (production)")
auc_wind, preds_wind, model_wind = train_and_eval(X_wind, feat_wind, "MODEL B: WINDOWED BIGLEAD")

# ── Head-to-head comparison ──
print("\n" + "="*60)
print("HEAD-TO-HEAD COMPARISON")
print("="*60)
print(f"  Overall AUC:  CUM={auc_cum:.4f}  WIND={auc_wind:.4f}  Δ={auc_wind-auc_cum:+.4f}")

for q in [2, 3, 4]:
    mask = quarters == q
    a_cum = roc_auc_score(y[mask], preds_cum[mask])
    a_wind = roc_auc_score(y[mask], preds_wind[mask])
    print(f"  Q{q} AUC:      CUM={a_cum:.4f}  WIND={a_wind:.4f}  Δ={a_wind-a_cum:+.4f}")

if close_mask.sum() > 50:
    a_cum_c = roc_auc_score(y[close_mask], preds_cum[close_mask])
    a_wind_c = roc_auc_score(y[close_mask], preds_wind[close_mask])
    print(f"  Close AUC:    CUM={a_cum_c:.4f}  WIND={a_wind_c:.4f}  Δ={a_wind_c-a_cum_c:+.4f}")
    
    for q in [2, 3, 4]:
        mask = (quarters == q) & close_mask
        if mask.sum() > 30:
            a_cum_cq = roc_auc_score(y[mask], preds_cum[mask])
            a_wind_cq = roc_auc_score(y[mask], preds_wind[mask])
            print(f"  Close Q{q}:     CUM={a_cum_cq:.4f}  WIND={a_wind_cq:.4f}  Δ={a_wind_cq-a_cum_cq:+.4f}")

# ── Disagreement analysis: where do models diverge? ──
print("\n" + "="*60)
print("DISAGREEMENT ANALYSIS")
print("="*60)
diff = preds_wind - preds_cum
big_diff_up = diff > 0.10  # windowed much higher
big_diff_down = diff < -0.10  # windowed much lower

print(f"  Windowed >> Cumulative (>10pp): {big_diff_up.sum()} cases, WR={y[big_diff_up].mean()*100:.1f}%")
print(f"  Windowed << Cumulative (<-10pp): {big_diff_down.sum()} cases, WR={y[big_diff_down].mean()*100:.1f}%")

# Focus on close games where they disagree
close_diff = diff[close_mask]
close_big_up = (diff > 0.10) & close_mask
close_big_down = (diff < -0.10) & close_mask
if close_big_up.sum() > 5:
    print(f"  Close + Wind>>Cum: {close_big_up.sum()} cases, WR={y[close_big_up].mean()*100:.1f}%")
if close_big_down.sum() > 5:
    print(f"  Close + Wind<<Cum: {close_big_down.sum()} cases, WR={y[close_big_down].mean()*100:.1f}%")

print("\nDone.")
