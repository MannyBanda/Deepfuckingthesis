#!/usr/bin/env python3
"""3-way XGB comparison: 1Q extreme recency vs 2Q window vs cumulative."""
import json, os, time
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score, brier_score_loss, accuracy_score
import xgboost as xgb
import urllib.request, base64

FEATURES = ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs']
BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/mc-backtest'
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()

def pull_all():
    all_rows = []
    offset = 0
    while True:
        url = f'{BASE}?phase=window_xgb_export&batch=100&offset={offset}'
        req = urllib.request.Request(url)
        req.add_header('Authorization', AUTH)
        data = json.loads(urllib.request.urlopen(req, timeout=120).read())
        rows = data.get('rows', [])
        print(f'  offset={offset}: {len(rows)} rows')
        all_rows.extend(rows)
        if not data.get('hasMore', False): break
        offset = data.get('nextOffset', offset + 100)
        time.sleep(1)
    return all_rows

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

# ── Load data ──
cache = '/tmp/window_xgb_3way.json'
if os.path.exists(cache):
    print('Loading cached data...')
    with open(cache) as f:
        rows = json.load(f)
else:
    print('Pulling data...')
    rows = pull_all()
    with open(cache, 'w') as f:
        json.dump(rows, f)
print(f'Total: {len(rows)} rows')

# Build DataFrame
records = []
for r in rows:
    w1 = r.get('w1', [])
    w = r.get('w', [])
    c = r.get('c', [])
    if len(w) != 13 or len(c) != 13 or len(w1) != 13: continue
    rec = {
        'game_id': r['gid'], 'checkpoint': r['cp'], 'period': r['p'],
        'clock': r.get('clk', 0), 'won': 1 if r['won'] else 0,
        'margin': r.get('mar', 0), 'floor': r.get('flr', 0),
    }
    for i, f in enumerate(FEATURES):
        rec[f'w1_{f}'] = w1[i]
        rec[f'w_{f}'] = w[i]
        rec[f'c_{f}'] = c[i]
    records.append(rec)

df = pd.DataFrame(records)
print(f'Samples: {len(df)}, Games: {df["game_id"].nunique()}, Win rate: {df["won"].mean():.3f}')
print(f'Periods: {df["period"].value_counts().sort_index().to_dict()}')

# ── Train all three ──
print('\n=== TRAINING 1Q (extreme recency) ===')
df['xgb_1q'] = get_oof(df, 'w1')
print('\n=== TRAINING 2Q (production window) ===')
df['xgb_2q'] = get_oof(df, 'w')
print('\n=== TRAINING CUMULATIVE ===')
df['xgb_cum'] = get_oof(df, 'c')

y = df['won'].values

# ── Overall comparison ──
print('\n' + '='*70)
print('OVERALL COMPARISON')
print('='*70)
for label, col in [('1Q RECENCY', 'xgb_1q'), ('2Q WINDOW', 'xgb_2q'), ('CUMULATIVE', 'xgb_cum')]:
    preds = df[col].values
    auc = roc_auc_score(y, preds)
    brier = brier_score_loss(y, preds)
    acc50 = accuracy_score(y, (preds >= 0.50).astype(int))
    h70 = preds >= 0.70
    acc70 = y[h70].mean() if h70.sum() > 0 else 0
    print(f'  {label:<14} AUC={auc:.4f}  Brier={brier:.4f}  Acc@50={acc50:.4f}  Acc@70={acc70:.3f}(n={h70.sum()})')

# ── Per-quarter breakdown ──
print('\n' + '='*70)
print('PER-QUARTER BREAKDOWN')
print('='*70)
for p in sorted(df['period'].unique()):
    mask = (df['period'] == p).values
    yq = y[mask]
    if len(np.unique(yq)) < 2: continue
    print(f'\n  Q{p} (n={mask.sum()}):')
    print(f'  {"Model":<14} {"AUC":>8} {"Brier":>8} {"Acc@70":>8} {"n@70":>6}')
    print(f'  {"-"*14} {"-"*8} {"-"*8} {"-"*8} {"-"*6}')
    for label, col in [('1Q RECENCY', 'xgb_1q'), ('2Q WINDOW', 'xgb_2q'), ('CUMULATIVE', 'xgb_cum')]:
        pq = df.loc[mask, col].values
        auc = roc_auc_score(yq, pq)
        brier = brier_score_loss(yq, pq)
        h70 = pq >= 0.70
        acc70 = yq[h70].mean() if h70.sum() > 0 else 0
        print(f'  {label:<14} {auc:>8.4f} {brier:>8.4f} {acc70:>8.3f} {h70.sum():>6}')

# ── EXIT analysis (flat 0.45 threshold) ──
print('\n' + '='*70)
print('EXIT at flat <0.45 — per quarter')
print('='*70)
for p in [2, 3, 4]:
    mask = (df['period'] == p).values
    yq = y[mask]
    print(f'\n  Q{p}:')
    for label, col in [('1Q', 'xgb_1q'), ('2Q', 'xgb_2q'), ('CUM', 'xgb_cum')]:
        below = mask & (df[col] < 0.45).values
        if below.sum() < 5:
            print(f'    {label}: n={below.sum()} (too few)')
            continue
        exit_acc = 1 - y[below].mean()
        print(f'    {label}: exit_acc={exit_acc:.1%} (n={below.sum()})')

# ── BUY calibration (trailing + floor >= 0.65) ──
print('\n' + '='*70)
print('BUY CALIBRATION — trailing + floor >= 0.65')
print('='*70)
buy = (df['margin'] < 0) & (df['floor'] >= 0.65)

for p in [2, 3, 4]:
    qmask = buy & (df['period'] == p)
    n = qmask.sum()
    if n == 0: continue
    print(f'\n  Q{p} (n={n}):')
    ranges = [(0.70, 1.01, '>=0.70'), (0.55, 0.70, '0.55-0.70'), (0.45, 0.55, '0.45-0.55'), (0, 0.45, '<0.45')]
    print(f'  {"Bucket":<12} {"1Q":>12} {"2Q":>12} {"CUM":>12}')
    print(f'  {"-"*12} {"-"*12} {"-"*12} {"-"*12}')
    for lo, hi, label in ranges:
        vals = []
        for col in ['xgb_1q', 'xgb_2q', 'xgb_cum']:
            m = qmask & (df[col] >= lo) & (df[col] < hi)
            wr = df.loc[m, 'won'].mean() if m.sum() > 3 else float('nan')
            vals.append(f'{wr:.0%}(n={m.sum()})' if not np.isnan(wr) else f'-(n={m.sum()})')
        print(f'  {label:<12} {vals[0]:>12} {vals[1]:>12} {vals[2]:>12}')

# ── Graduated EXIT simulation ──
print('\n' + '='*70)
print('GRADUATED EXIT — position entered at floor >= 0.65')
print('='*70)

def cp_sort_key(cp):
    parts = cp.replace('Q','').split('_')
    p = int(parts[0])
    clk = 0 if parts[1] == 'END' else -int(parts[1])
    return (p, clk)
df['_sort'] = df['checkpoint'].apply(cp_sort_key)
df = df.sort_values(['game_id', '_sort']).reset_index(drop=True)

for xgb_label, xgb_col in [('1Q', 'xgb_1q'), ('2Q', 'xgb_2q'), ('CUM', 'xgb_cum')]:
    correct = 0; premature = 0; held_won = 0; held_lost = 0; entered = 0
    for gid, group in df.groupby('game_id'):
        snaps = group.sort_values('_sort').reset_index(drop=True)
        entry_idx = None
        for i, row in snaps.iterrows():
            if row['floor'] >= 0.65:
                entry_idx = i; break
        if entry_idx is None: continue
        entered += 1
        entry_ctrl = snaps.loc[entry_idx, 'ctrl'] if 'ctrl' in snaps.columns else ''
        won = snaps.loc[entry_idx, 'won']
        post = snaps.loc[entry_idx+1:]
        exit_fired = False
        for _, snap in post.iterrows():
            if snap[xgb_col] < 0.45:
                exit_fired = True; break
        if exit_fired:
            if won == 0: correct += 1
            else: premature += 1
        else:
            if won == 1: held_won += 1
            else: held_lost += 1
    total_exits = correct + premature
    exit_acc = correct / total_exits if total_exits > 0 else 0
    total_damage = premature + held_lost
    print(f'  {xgb_label}: exits={total_exits} acc={exit_acc:.1%} | held_won={held_won} left_hang={held_lost} | total_damage={total_damage}')

print('\nDone.')
