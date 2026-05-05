#!/usr/bin/env python3
"""
Calibration and gate analysis for windowed vs cumulative XGB.
Uses OOF predictions from the training run to derive new thresholds.
"""
import json, sys
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.model_selection import StratifiedKFold
import xgboost as xgb

FEATURES = ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs']

# Load cached data
with open('/tmp/window_xgb_data.json') as f:
    rows = json.load(f)

records = []
for r in rows:
    w = r.get('w', [])
    c = r.get('c', [])
    if len(w) != 13 or len(c) != 13: continue
    rec = {
        'game_id': r['gid'], 'checkpoint': r['cp'], 'period': r['p'],
        'clock': r.get('clk', 0), 'won': 1 if r['won'] else 0, 'margin': r.get('mar', 0),
    }
    for i, f in enumerate(FEATURES):
        rec[f'w_{f}'] = w[i]
        rec[f'c_{f}'] = c[i]
    records.append(rec)
df = pd.DataFrame(records)

# Reproduce OOF predictions (same folds as training)
def get_oof(df, prefix):
    feat_cols = [f'{prefix}_{f}' for f in FEATURES]
    X = df[feat_cols].values
    y = df['won'].values
    unique_games = df['game_id'].unique()
    game_labels = df.groupby('game_id')['won'].first().values
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    oof = np.full(len(df), np.nan)
    for fold, (tr_idx, va_idx) in enumerate(skf.split(unique_games, game_labels)):
        tr_games = set(unique_games[tr_idx])
        va_games = set(unique_games[va_idx])
        tr_mask = df['game_id'].isin(tr_games).values
        va_mask = df['game_id'].isin(va_games).values
        dtrain = xgb.DMatrix(X[tr_mask], label=y[tr_mask], feature_names=feat_cols)
        dval = xgb.DMatrix(X[va_mask], label=y[va_mask], feature_names=feat_cols)
        params = {'objective': 'binary:logistic', 'eval_metric': 'auc', 'max_depth': 4,
                  'learning_rate': 0.05, 'subsample': 0.8, 'colsample_bytree': 0.8,
                  'min_child_weight': 5, 'seed': 42 + fold, 'verbosity': 0}
        model = xgb.train(params, dtrain, num_boost_round=300, evals=[(dval, 'val')],
                          early_stopping_rounds=30, verbose_eval=False)
        best = model.best_iteration + 1 if hasattr(model, 'best_iteration') else 300
        oof[va_mask] = model.predict(dval, iteration_range=(0, best))
    return oof

print('Reproducing OOF predictions...')
df['w_xgb'] = get_oof(df, 'w')
df['c_xgb'] = get_oof(df, 'c')

trailing = df['margin'] < 0
leading = df['margin'] > 0

# ══════════════════════════════════════════════════════════════════
# 1. PROBABILITY CALIBRATION CURVE
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('1. PROBABILITY CALIBRATION — predicted vs actual win rate')
print('='*70)

buckets = [(0, 0.20), (0.20, 0.30), (0.30, 0.40), (0.40, 0.50),
           (0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70),
           (0.70, 0.80), (0.80, 0.90), (0.90, 1.01)]

print(f'\n  {"Bucket":<12} {"Win XGB":>10} {"Cum XGB":>10} {"Win act%":>10} {"Cum act%":>10} {"Win n":>8} {"Cum n":>8}')
print(f'  {"-"*12} {"-"*10} {"-"*10} {"-"*10} {"-"*10} {"-"*8} {"-"*8}')
for lo, hi in buckets:
    w_mask = (df['w_xgb'] >= lo) & (df['w_xgb'] < hi)
    c_mask = (df['c_xgb'] >= lo) & (df['c_xgb'] < hi)
    w_act = df.loc[w_mask, 'won'].mean() if w_mask.sum() > 0 else 0
    c_act = df.loc[c_mask, 'won'].mean() if c_mask.sum() > 0 else 0
    label = f'{lo:.2f}-{hi:.2f}'
    print(f'  {label:<12} {df.loc[w_mask, "w_xgb"].mean():>10.3f} {df.loc[c_mask, "c_xgb"].mean():>10.3f} '
          f'{w_act:>10.1%} {c_act:>10.1%} {w_mask.sum():>8} {c_mask.sum():>8}')

# ══════════════════════════════════════════════════════════════════
# 2. EXIT THRESHOLD SWEEP (ctrl team LOSES = correct exit)
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('2. EXIT THRESHOLD SWEEP — XGB drops below X → team loses?')
print('   (exit accuracy = % of time team LOST when XGB < threshold)')
print('='*70)

for p in [2, 3, 4]:
    qmask = df['period'] == p
    print(f'\n  Q{p}:')
    print(f'  {"Threshold":<12} {"Win exit%":>12} {"Cum exit%":>12} {"Win n":>8} {"Cum n":>8}')
    print(f'  {"-"*12} {"-"*12} {"-"*12} {"-"*8} {"-"*8}')
    for thresh in [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]:
        w_below = qmask & (df['w_xgb'] < thresh)
        c_below = qmask & (df['c_xgb'] < thresh)
        # Exit accuracy = team LOST (won=0) when XGB below threshold
        w_exit_acc = 1 - df.loc[w_below, 'won'].mean() if w_below.sum() > 5 else float('nan')
        c_exit_acc = 1 - df.loc[c_below, 'won'].mean() if c_below.sum() > 5 else float('nan')
        print(f'  <{thresh:<11.2f} {w_exit_acc:>12.1%} {c_exit_acc:>12.1%} {w_below.sum():>8} {c_below.sum():>8}')

# ══════════════════════════════════════════════════════════════════
# 3. BUY-LIKE ANALYSIS (ctrl trailing, XGB by bucket)
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('3. BUY-LIKE ANALYSIS — ctrl trailing (margin<0), win rate by XGB bucket')
print('='*70)

for p in [2, 3, 4]:
    qmask = (df['period'] == p) & trailing
    print(f'\n  Q{p} (trailing, n={qmask.sum()}):')
    print(f'  {"XGB bucket":<15} {"Win win%":>10} {"Cum win%":>10} {"Win n":>8} {"Cum n":>8}')
    print(f'  {"-"*15} {"-"*10} {"-"*10} {"-"*8} {"-"*8}')
    buy_buckets = [(0, 0.30), (0.30, 0.40), (0.40, 0.50), (0.50, 0.55),
                   (0.55, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 1.01)]
    for lo, hi in buy_buckets:
        w_m = qmask & (df['w_xgb'] >= lo) & (df['w_xgb'] < hi)
        c_m = qmask & (df['c_xgb'] >= lo) & (df['c_xgb'] < hi)
        w_wr = df.loc[w_m, 'won'].mean() if w_m.sum() > 3 else float('nan')
        c_wr = df.loc[c_m, 'won'].mean() if c_m.sum() > 3 else float('nan')
        label = f'{lo:.2f}-{hi:.2f}'
        print(f'  {label:<15} {w_wr:>10.1%} {c_wr:>10.1%} {w_m.sum():>8} {c_m.sum():>8}')

# ══════════════════════════════════════════════════════════════════
# 4. HIGH-CONFIDENCE TRAILING WARNINGS
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('4. HIGH-CONFIDENCE + TRAILING — when to warn')
print('   (XGB says high but team is behind)')
print('='*70)

for p in [2, 3, 4]:
    qmask = df['period'] == p
    print(f'\n  Q{p}:')
    for xgb_thresh in [0.60, 0.65, 0.70, 0.75, 0.80]:
        for margin_thresh in [0, -3, -5, -8]:
            w_m = qmask & (df['w_xgb'] >= xgb_thresh) & (df['margin'] <= margin_thresh)
            if w_m.sum() < 5: continue
            w_loss = 1 - df.loc[w_m, 'won'].mean()
            c_m = qmask & (df['c_xgb'] >= xgb_thresh) & (df['margin'] <= margin_thresh)
            c_loss = 1 - df.loc[c_m, 'won'].mean() if c_m.sum() > 5 else float('nan')
            flag = ' *** WARN' if w_loss > 0.40 else ''
            print(f'    XGB>={xgb_thresh:.2f} + margin<={margin_thresh:+d}: Win loss={w_loss:.1%} (n={w_m.sum()}) | Cum loss={c_loss:.1%} (n={c_m.sum()}){flag}')

# ══════════════════════════════════════════════════════════════════
# 5. SEVERITY BOUNDARIES
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('5. SEVERITY BOUNDARIES — distribution of very low predictions')
print('='*70)

for p in [2, 3, 4]:
    qmask = df['period'] == p
    w_q = df.loc[qmask, 'w_xgb']
    c_q = df.loc[qmask, 'c_xgb']
    print(f'\n  Q{p}:')
    for thresh in [0.10, 0.15, 0.20, 0.25, 0.30]:
        w_n = (w_q < thresh).sum()
        c_n = (c_q < thresh).sum()
        w_loss = 1 - df.loc[qmask & (df['w_xgb'] < thresh), 'won'].mean() if w_n > 0 else 0
        c_loss = 1 - df.loc[qmask & (df['c_xgb'] < thresh), 'won'].mean() if c_n > 0 else 0
        print(f'    <{thresh:.2f}: Win n={w_n} loss%={w_loss:.1%} | Cum n={c_n} loss%={c_loss:.1%}')

# ══════════════════════════════════════════════════════════════════
# 6. PREDICTION DISTRIBUTION COMPARISON
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('6. PREDICTION DISTRIBUTION — are probabilities on the same scale?')
print('='*70)

for p in [2, 3, 4]:
    qmask = df['period'] == p
    w_q = df.loc[qmask, 'w_xgb']
    c_q = df.loc[qmask, 'c_xgb']
    print(f'\n  Q{p}: Window mean={w_q.mean():.3f} std={w_q.std():.3f} | Cumul mean={c_q.mean():.3f} std={c_q.std():.3f}')
    for pct in [10, 25, 50, 75, 90]:
        print(f'    P{pct}: Window={np.percentile(w_q, pct):.3f} Cumul={np.percentile(c_q, pct):.3f} delta={np.percentile(w_q, pct) - np.percentile(c_q, pct):+.3f}')

# ══════════════════════════════════════════════════════════════════
# 7. BWC/LEADING ANALYSIS
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('7. BWC-LIKE — ctrl leading (margin>0), win rate by XGB bucket')
print('='*70)

for p in [2, 3, 4]:
    qmask = (df['period'] == p) & leading
    print(f'\n  Q{p} (leading, n={qmask.sum()}):')
    print(f'  {"XGB bucket":<15} {"Win win%":>10} {"Cum win%":>10} {"Win n":>8} {"Cum n":>8}')
    print(f'  {"-"*15} {"-"*10} {"-"*10} {"-"*8} {"-"*8}')
    bwc_buckets = [(0, 0.30), (0.30, 0.40), (0.40, 0.50), (0.50, 0.60),
                   (0.60, 0.70), (0.70, 0.80), (0.80, 1.01)]
    for lo, hi in bwc_buckets:
        w_m = qmask & (df['w_xgb'] >= lo) & (df['w_xgb'] < hi)
        c_m = qmask & (df['c_xgb'] >= lo) & (df['c_xgb'] < hi)
        w_wr = df.loc[w_m, 'won'].mean() if w_m.sum() > 3 else float('nan')
        c_wr = df.loc[c_m, 'won'].mean() if c_m.sum() > 3 else float('nan')
        label = f'{lo:.2f}-{hi:.2f}'
        print(f'  {label:<15} {w_wr:>10.1%} {c_wr:>10.1%} {w_m.sum():>8} {c_m.sum():>8}')

print('\n\nDone.')
