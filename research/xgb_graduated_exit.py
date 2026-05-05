#!/usr/bin/env python3
"""
1. Graduated EXIT analysis — simulate position entry at floor >= 0.65,
   track XGB through game, measure EXIT accuracy at various thresholds.
2. BUY calibration — trailing + floor >= 0.65, win rate by Q × XGB bucket.
Uses enriched window_xgb_export data (includes floor, ctrl team).
"""
import json, os
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score
import xgboost as xgb

FEATURES = ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs']

# ── Load and build OOF predictions ──

with open('/tmp/window_xgb_data.json') as f:
    rows = json.load(f)

records = []
for r in rows:
    w = r.get('w', [])
    c = r.get('c', [])
    if len(w) != 13 or len(c) != 13: continue
    rec = {
        'game_id': r['gid'], 'checkpoint': r['cp'], 'period': r['p'],
        'clock': r.get('clk', 0), 'won': 1 if r['won'] else 0,
        'margin': r.get('mar', 0), 'floor': r.get('flr', 0),
        'ctrl': r.get('ctrl', ''), 'hA': r.get('hA', ''), 'aA': r.get('aA', ''),
        'final_margin': r.get('fmar', 0),
    }
    for i, f in enumerate(FEATURES):
        rec[f'w_{f}'] = w[i]
        rec[f'c_{f}'] = c[i]
    records.append(rec)
df = pd.DataFrame(records)
print(f'Total: {len(df)} rows, {df["game_id"].nunique()} games')
print(f'Floor available: {(df["floor"] > 0).sum()} rows')

# Reproduce OOF predictions
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

print('\nBuilding OOF predictions...')
df['w_xgb'] = get_oof(df, 'w')
df['c_xgb'] = get_oof(df, 'c')
print('Done.\n')

# Sort by game progression
def cp_sort_key(cp):
    """Q2_9 → (2, -9), Q3_END → (3, 0), etc."""
    parts = cp.replace('Q','').split('_')
    p = int(parts[0])
    clk = 0 if parts[1] == 'END' else -int(parts[1])
    return (p, clk)

df['_sort'] = df['checkpoint'].apply(cp_sort_key)
df = df.sort_values(['game_id', '_sort']).reset_index(drop=True)

# ══════════════════════════════════════════════════════════════════
# 1. GRADUATED EXIT ANALYSIS
# ══════════════════════════════════════════════════════════════════
print('='*70)
print('1. GRADUATED EXIT ANALYSIS')
print('   Position "entered" at first checkpoint where floor >= 0.65')
print('   EXIT fires when XGB drops below threshold at any later checkpoint')
print('   Correct EXIT = ctrl team lost. Premature EXIT = ctrl team won.')
print('='*70)

# For each game, simulate position entry and EXIT
def simulate_exits(df, xgb_col, thresholds):
    """
    For each game:
    1. Find first checkpoint where floor >= 0.65 AND ctrl team is consistent (entry point)
    2. Track ctrl team from that point
    3. Check if XGB drops below each threshold at any subsequent checkpoint
       where ctrl team is still the same
    4. Record: did exit fire? Was it correct (team lost)?
    
    Also track: games where NO exit fires (position held to end)
    """
    results = {t: {'correct_exit': 0, 'premature_exit': 0, 'held_won': 0, 'held_lost': 0,
                    'exit_margins': [], 'held_margins': []} for t in thresholds}
    
    games_entered = 0
    
    for gid, group in df.groupby('game_id'):
        snaps = group.sort_values('_sort').reset_index(drop=True)
        
        # Find entry point: first checkpoint where floor >= 0.65
        entry_idx = None
        for i, row in snaps.iterrows():
            if row['floor'] >= 0.65:
                entry_idx = i
                break
        if entry_idx is None:
            continue
        
        entry_ctrl = snaps.loc[entry_idx, 'ctrl']
        won = snaps.loc[entry_idx, 'won']
        games_entered += 1
        
        # Track post-entry checkpoints where ctrl team is the same
        post_entry = snaps.loc[entry_idx+1:]
        same_ctrl = post_entry[post_entry['ctrl'] == entry_ctrl]
        
        for thresh in thresholds:
            # Check if XGB drops below threshold at any post-entry checkpoint
            exit_fired = False
            exit_margin = None
            for _, snap in same_ctrl.iterrows():
                if snap[xgb_col] < thresh:
                    exit_fired = True
                    exit_margin = snap['margin']
                    break
            
            if exit_fired:
                if won == 0:  # ctrl team lost → correct exit
                    results[thresh]['correct_exit'] += 1
                else:  # ctrl team won → premature exit
                    results[thresh]['premature_exit'] += 1
                results[thresh]['exit_margins'].append(exit_margin)
            else:
                if won == 1:
                    results[thresh]['held_won'] += 1
                else:
                    results[thresh]['held_lost'] += 1  # should have exited
                results[thresh]['held_margins'].append(snaps.iloc[-1]['margin'])
    
    return results, games_entered

thresholds = [0.35, 0.40, 0.45, 0.50, 0.55, 0.60]

print('\n  WINDOWED XGB:')
w_results, w_entered = simulate_exits(df, 'w_xgb', thresholds)
print(f'  Games with floor >= 0.65 entry: {w_entered}')
print(f'\n  {"Thresh":<8} {"Exits":>6} {"Correct":>8} {"Premature":>10} {"Exit Acc":>9} {"Held":>6} {"Held Won":>9} {"Left Hang":>10}')
print(f'  {"-"*8} {"-"*6} {"-"*8} {"-"*10} {"-"*9} {"-"*6} {"-"*9} {"-"*10}')
for t in thresholds:
    r = w_results[t]
    total_exits = r['correct_exit'] + r['premature_exit']
    total_held = r['held_won'] + r['held_lost']
    exit_acc = r['correct_exit'] / total_exits if total_exits > 0 else 0
    left_hanging = r['held_lost']  # games where should have exited but didn't
    print(f'  <{t:<7.2f} {total_exits:>6} {r["correct_exit"]:>8} {r["premature_exit"]:>10} {exit_acc:>9.1%} {total_held:>6} {r["held_won"]:>9} {left_hanging:>10}')

print('\n  CUMULATIVE XGB:')
c_results, c_entered = simulate_exits(df, 'c_xgb', thresholds)
print(f'  Games with floor >= 0.65 entry: {c_entered}')
print(f'\n  {"Thresh":<8} {"Exits":>6} {"Correct":>8} {"Premature":>10} {"Exit Acc":>9} {"Held":>6} {"Held Won":>9} {"Left Hang":>10}')
print(f'  {"-"*8} {"-"*6} {"-"*8} {"-"*10} {"-"*9} {"-"*6} {"-"*9} {"-"*10}')
for t in thresholds:
    r = c_results[t]
    total_exits = r['correct_exit'] + r['premature_exit']
    total_held = r['held_won'] + r['held_lost']
    exit_acc = r['correct_exit'] / total_exits if total_exits > 0 else 0
    left_hanging = r['held_lost']
    print(f'  <{t:<7.2f} {total_exits:>6} {r["correct_exit"]:>8} {r["premature_exit"]:>10} {exit_acc:>9.1%} {total_held:>6} {r["held_won"]:>9} {left_hanging:>10}')

# Side-by-side comparison
print('\n  HEAD-TO-HEAD:')
print(f'  {"Thresh":<8} {"Win Exit%":>10} {"Cum Exit%":>10} {"Win LeftH":>10} {"Cum LeftH":>10} {"Winner":>8}')
print(f'  {"-"*8} {"-"*10} {"-"*10} {"-"*10} {"-"*10} {"-"*8}')
for t in thresholds:
    wr = w_results[t]
    cr = c_results[t]
    w_exits = wr['correct_exit'] + wr['premature_exit']
    c_exits = cr['correct_exit'] + cr['premature_exit']
    w_acc = wr['correct_exit'] / w_exits if w_exits > 0 else 0
    c_acc = cr['correct_exit'] / c_exits if c_exits > 0 else 0
    w_lh = wr['held_lost']
    c_lh = cr['held_lost']
    winner = 'WIN' if w_acc > c_acc + 0.01 else ('CUM' if c_acc > w_acc + 0.01 else 'TIE')
    print(f'  <{t:<7.2f} {w_acc:>10.1%} {c_acc:>10.1%} {w_lh:>10} {c_lh:>10} {winner:>8}')

# The key tradeoff: exit accuracy vs left hanging
print('\n  THE TRADEOFF (windowed):')
print(f'  {"Thresh":<8} {"Exit Acc":>9} {"Exits/Game":>11} {"Left Hang":>10} {"Total Lost":>11}')
print(f'  {"-"*8} {"-"*9} {"-"*11} {"-"*10} {"-"*11}')
for t in thresholds:
    r = w_results[t]
    total_exits = r['correct_exit'] + r['premature_exit']
    exit_acc = r['correct_exit'] / total_exits if total_exits > 0 else 0
    exits_per_game = total_exits / w_entered if w_entered > 0 else 0
    left_hanging = r['held_lost']
    total_lost = r['premature_exit'] + left_hanging  # wrong exits + missed exits
    print(f'  <{t:<7.2f} {exit_acc:>9.1%} {exits_per_game:>11.2%} {left_hanging:>10} {total_lost:>11}')

# ══════════════════════════════════════════════════════════════════
# 2. BUY CALIBRATION WITH FLOOR FILTER
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('2. BUY CALIBRATION — ctrl trailing + floor >= 0.65')
print('   (matches production BUY eligibility)')
print('='*70)

buy_eligible = (df['margin'] < 0) & (df['floor'] >= 0.65)
print(f'\n  BUY-eligible checkpoints: {buy_eligible.sum()} ({buy_eligible.mean():.1%} of all)')

for p in [2, 3, 4]:
    qmask = buy_eligible & (df['period'] == p)
    n = qmask.sum()
    if n == 0: continue
    
    print(f'\n  Q{p} (trailing + floor>=0.65, n={n}):')
    print(f'  {"XGB bucket":<15} {"Win win%":>10} {"Cum win%":>10} {"Win n":>8} {"Cum n":>8}')
    print(f'  {"-"*15} {"-"*10} {"-"*10} {"-"*8} {"-"*8}')
    
    buckets = [(0, 0.30), (0.30, 0.40), (0.40, 0.45), (0.45, 0.50),
               (0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70),
               (0.70, 0.80), (0.80, 1.01)]
    for lo, hi in buckets:
        w_m = qmask & (df['w_xgb'] >= lo) & (df['w_xgb'] < hi)
        c_m = qmask & (df['c_xgb'] >= lo) & (df['c_xgb'] < hi)
        w_wr = df.loc[w_m, 'won'].mean() if w_m.sum() > 3 else float('nan')
        c_wr = df.loc[c_m, 'won'].mean() if c_m.sum() > 3 else float('nan')
        label = f'{lo:.2f}-{hi:.2f}'
        print(f'  {label:<15} {w_wr:>10.1%} {c_wr:>10.1%} {w_m.sum():>8} {c_m.sum():>8}')

# Also produce the exact table format for agent prompt
print('\n  AGENT PROMPT TABLE (windowed, trailing + floor >= 0.65):')
print('  Format: Q | XGB>=0.70 | 0.55-0.70 | 0.45-0.55 | 0.40-0.45 | <0.40')
for p in [2, 3, 4]:
    qmask = buy_eligible & (df['period'] == p)
    ranges = [(0.70, 1.01), (0.55, 0.70), (0.45, 0.55), (0.40, 0.45), (0, 0.40)]
    vals = []
    for lo, hi in ranges:
        m = qmask & (df['w_xgb'] >= lo) & (df['w_xgb'] < hi)
        wr = df.loc[m, 'won'].mean() if m.sum() > 3 else float('nan')
        n = m.sum()
        vals.append(f'{wr:.0%}(n={n})')
    print(f'  Q{p}: {" | ".join(vals)}')

# ══════════════════════════════════════════════════════════════════
# 3. MARGIN-STRATIFIED BUY
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('3. MARGIN-STRATIFIED BUY — how deficit size affects XGB accuracy')
print('   (trailing + floor >= 0.65)')
print('='*70)

for p in [3, 4]:
    print(f'\n  Q{p}:')
    for mar_lo, mar_hi, label in [(-4, 0, 'trail 1-4'), (-8, -4, 'trail 5-8'), 
                                    (-15, -8, 'trail 9-15'), (-99, -15, 'trail 16+')]:
        qmask = buy_eligible & (df['period'] == p) & (df['margin'] >= mar_lo) & (df['margin'] < mar_hi)
        if qmask.sum() < 10: continue
        # Windowed XGB > 0.55 win rate
        high = qmask & (df['w_xgb'] >= 0.55)
        wr_high = df.loc[high, 'won'].mean() if high.sum() > 3 else float('nan')
        # All
        wr_all = df.loc[qmask, 'won'].mean()
        print(f'    {label:<12} n={qmask.sum():>4} | all={wr_all:.1%} | XGB>=0.55={wr_high:.1%}(n={high.sum()}) | XGB>=0.70={df.loc[qmask & (df["w_xgb"] >= 0.70), "won"].mean():.1%}(n={(qmask & (df["w_xgb"] >= 0.70)).sum()})')

# ══════════════════════════════════════════════════════════════════
# 4. XGB SUPPRESS WARNING THRESHOLDS
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('4. XGB SUPPRESS THRESHOLDS — at what XGB should agent consider suppressing?')
print('   (trailing + floor >= 0.65, win rate < 50% = should suppress)')
print('='*70)

for p in [2, 3, 4]:
    qmask = buy_eligible & (df['period'] == p)
    print(f'\n  Q{p}:')
    for thresh in [0.30, 0.35, 0.40, 0.45, 0.50]:
        below = qmask & (df['w_xgb'] < thresh)
        if below.sum() < 5: continue
        wr = df.loc[below, 'won'].mean()
        verdict = 'SUPPRESS' if wr < 0.50 else 'MARGINAL' if wr < 0.60 else 'PASS'
        print(f'    XGB<{thresh:.2f}: win={wr:.1%} (n={below.sum()}) -> {verdict}')

print('\nDone.')
