#!/usr/bin/env python3
"""
Train XGBoost on cross-fade window features vs cumulative features.
Pulls data from mc-backtest window_xgb_export endpoint, trains both models,
compares OOF AUC/accuracy/Brier.
"""
import urllib.request, urllib.parse, json, base64, time
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score, brier_score_loss, accuracy_score
import xgboost as xgb

BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/mc-backtest'
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()
FEATURES = ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs']

def fetch_batch(offset, batch=100):
    url = f'{BASE}?phase=window_xgb_export&batch={batch}&offset={offset}'
    req = urllib.request.Request(url)
    req.add_header('Authorization', AUTH)
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        return json.loads(resp.read())
    except Exception as e:
        print(f'  Error at offset {offset}: {e}')
        return None

def pull_all_data():
    """Paginate through all games, return list of row dicts."""
    all_rows = []
    offset = 0
    batch = 100
    while True:
        print(f'  Fetching offset={offset}...')
        data = fetch_batch(offset, batch)
        if not data:
            print('  Retrying in 5s...')
            time.sleep(5)
            data = fetch_batch(offset, batch)
            if not data:
                print(f'  Failed at offset {offset}, stopping.')
                break
        
        rows = data.get('rows', [])
        n_games = data.get('gamesProcessed', 0)
        skipped = data.get('skippedNoWindow', 0)
        print(f'    Games={n_games}, rows={len(rows)}, skipped={skipped}')
        all_rows.extend(rows)
        
        if not data.get('hasMore', False):
            break
        offset = data.get('nextOffset', offset + batch)
        time.sleep(1)
    
    return all_rows

def build_dataframes(rows):
    """Convert raw rows to windowed and cumulative DataFrames."""
    records = []
    for r in rows:
        w = r.get('w', [])
        c = r.get('c', [])
        if len(w) != 13 or len(c) != 13:
            continue
        rec = {
            'game_id': r['gid'],
            'checkpoint': r['cp'],
            'period': r['p'],
            'clock': r.get('clk', 0),
            'won': 1 if r['won'] else 0,
            'margin': r.get('mar', 0),
        }
        for i, fname in enumerate(FEATURES):
            rec[f'w_{fname}'] = w[i]
            rec[f'c_{fname}'] = c[i]
        records.append(rec)
    
    df = pd.DataFrame(records)
    print(f'\nTotal samples: {len(df)}')
    print(f'Win rate: {df["won"].mean():.3f}')
    print(f'Periods: {df["period"].value_counts().sort_index().to_dict()}')
    return df

def train_and_evaluate(df, feature_prefix, label='won', n_folds=5):
    """Train XGBoost with stratified k-fold CV (game-level splits), return OOF predictions."""
    feat_cols = [f'{feature_prefix}_{f}' for f in FEATURES]
    X = df[feat_cols].values
    y = df[label].values
    
    # Group by game for fold assignment — no leaking game data across folds
    unique_games = df['game_id'].unique()
    game_labels = df.groupby('game_id')['won'].first().values
    
    skf = StratifiedKFold(n_splits=n_folds, shuffle=True, random_state=42)
    oof_preds = np.full(len(df), np.nan)
    
    for fold, (train_game_idx, val_game_idx) in enumerate(skf.split(unique_games, game_labels)):
        train_games = set(unique_games[train_game_idx])
        val_games = set(unique_games[val_game_idx])
        
        train_mask = df['game_id'].isin(train_games).values
        val_mask = df['game_id'].isin(val_games).values
        
        dtrain = xgb.DMatrix(X[train_mask], label=y[train_mask], feature_names=feat_cols)
        dval = xgb.DMatrix(X[val_mask], label=y[val_mask], feature_names=feat_cols)
        
        params = {
            'objective': 'binary:logistic',
            'eval_metric': 'auc',
            'max_depth': 4,
            'learning_rate': 0.05,
            'subsample': 0.8,
            'colsample_bytree': 0.8,
            'min_child_weight': 5,
            'seed': 42 + fold,
            'verbosity': 0,
        }
        
        model = xgb.train(
            params, dtrain, num_boost_round=300,
            evals=[(dval, 'val')],
            early_stopping_rounds=30,
            verbose_eval=False,
        )
        
        best_trees = model.best_iteration + 1 if hasattr(model, 'best_iteration') else 300
        oof_preds[val_mask] = model.predict(dval, iteration_range=(0, best_trees))
        print(f'  Fold {fold+1}: AUC={roc_auc_score(y[val_mask], oof_preds[val_mask]):.4f}, '
              f'trees={best_trees}')
    
    return oof_preds

def evaluate_predictions(y_true, preds, label):
    """Compute comprehensive metrics."""
    auc = roc_auc_score(y_true, preds)
    brier = brier_score_loss(y_true, preds)
    acc_50 = accuracy_score(y_true, (preds >= 0.50).astype(int))
    
    high60 = preds >= 0.60
    high70 = preds >= 0.70
    acc_60 = y_true[high60].mean() if high60.sum() > 0 else 0
    acc_70 = y_true[high70].mean() if high70.sum() > 0 else 0
    
    print(f'\n  {label}:')
    print(f'    OOF AUC:    {auc:.4f}')
    print(f'    Brier:      {brier:.4f}')
    print(f'    Acc @0.50:  {acc_50:.4f}')
    print(f'    Acc @0.60:  {acc_60:.4f} (n={high60.sum()})')
    print(f'    Acc @0.70:  {acc_70:.4f} (n={high70.sum()})')
    
    return {'auc': auc, 'brier': brier, 'acc_50': acc_50, 'acc_60': acc_60, 'acc_70': acc_70, 'n_60': int(high60.sum()), 'n_70': int(high70.sum())}

def per_quarter_analysis(df, w_preds, c_preds):
    """Break down accuracy by quarter."""
    print('\n=== PER-QUARTER BREAKDOWN ===')
    for p in sorted(df['period'].unique()):
        mask = (df['period'] == p).values
        y = df.loc[mask, 'won'].values
        wp = w_preds[mask]
        cp = c_preds[mask]
        n = mask.sum()
        
        w_auc = roc_auc_score(y, wp) if len(np.unique(y)) > 1 else 0
        c_auc = roc_auc_score(y, cp) if len(np.unique(y)) > 1 else 0
        w_brier = brier_score_loss(y, wp)
        c_brier = brier_score_loss(y, cp)
        
        w_high = wp >= 0.70
        c_high = cp >= 0.70
        w_acc70 = y[w_high].mean() if w_high.sum() > 0 else 0
        c_acc70 = y[c_high].mean() if c_high.sum() > 0 else 0
        
        delta_auc = w_auc - c_auc
        delta_brier = c_brier - w_brier
        
        winner = 'WINDOW' if delta_auc > 0.005 else ('CUMUL' if delta_auc < -0.005 else 'TIE')
        
        print(f'\n  Q{p} (n={n}):')
        print(f'    AUC:   Window={w_auc:.4f}  Cumul={c_auc:.4f}  delta={delta_auc:+.4f} -> {winner}')
        print(f'    Brier: Window={w_brier:.4f}  Cumul={c_brier:.4f}  delta={delta_brier:+.4f}')
        print(f'    >0.70: Window={w_acc70:.3f} (n={w_high.sum()})  Cumul={c_acc70:.3f} (n={c_high.sum()})')

def train_final_model(df, feature_prefix, n_trees=300):
    """Train on full dataset and return model."""
    feat_cols = [f'{feature_prefix}_{f}' for f in FEATURES]
    X = df[feat_cols].values
    y = df['won'].values
    
    dtrain = xgb.DMatrix(X, label=y, feature_names=feat_cols)
    params = {
        'objective': 'binary:logistic',
        'eval_metric': 'auc',
        'max_depth': 4,
        'learning_rate': 0.05,
        'subsample': 0.8,
        'colsample_bytree': 0.8,
        'min_child_weight': 5,
        'seed': 42,
        'verbosity': 0,
    }
    model = xgb.train(params, dtrain, num_boost_round=n_trees)
    return model

def export_model_json(model, path):
    """Export model to JSON format."""
    model.save_model(path)
    import os
    size_kb = os.path.getsize(path) / 1024
    print(f'  Model exported to {path} ({size_kb:.0f} KB)')

# ── Main ──

if __name__ == '__main__':
    print('=== PULLING DATA FROM BACKTEST ===')
    import os
    cache_path = '/tmp/window_xgb_data.json'
    if os.path.exists(cache_path):
        print(f'  Loading cached data from {cache_path}')
        with open(cache_path) as f:
            rows = json.load(f)
        print(f'  Loaded {len(rows)} rows from cache')
    else:
        rows = pull_all_data()
        if not rows:
            print('No data returned!')
            exit(1)
        with open(cache_path, 'w') as f:
            json.dump(rows, f)
        print(f'\nSaved {len(rows)} rows to {cache_path}')
    
    df = build_dataframes(rows)
    
    print('\n=== TRAINING: WINDOWED FEATURES ===')
    w_preds = train_and_evaluate(df, 'w')
    
    print('\n=== TRAINING: CUMULATIVE FEATURES ===')
    c_preds = train_and_evaluate(df, 'c')
    
    print('\n=== OVERALL COMPARISON ===')
    y = df['won'].values
    w_metrics = evaluate_predictions(y, w_preds, 'WINDOWED')
    c_metrics = evaluate_predictions(y, c_preds, 'CUMULATIVE')
    
    delta_auc = w_metrics['auc'] - c_metrics['auc']
    print(f'\n  AUC delta (window - cumulative): {delta_auc:+.4f}')
    if delta_auc > 0:
        print(f'  -> WINDOWED wins by {delta_auc:.4f} AUC')
    else:
        print(f'  -> CUMULATIVE wins by {-delta_auc:.4f} AUC')
    
    per_quarter_analysis(df, w_preds, c_preds)
    
    print('\n=== FINAL MODELS ===')
    w_model = train_final_model(df, 'w')
    export_model_json(w_model, '/tmp/xgb_window_model.json')
    c_model = train_final_model(df, 'c')
    export_model_json(c_model, '/tmp/xgb_cumul_model.json')
    
    # Feature importance comparison
    print('\n=== FEATURE IMPORTANCE (gain) ===')
    w_imp = w_model.get_score(importance_type='gain')
    c_imp = c_model.get_score(importance_type='gain')
    print(f'  {"Feature":<12} {"Window":>10} {"Cumul":>10} {"Delta":>10}')
    print(f'  {"-"*12} {"-"*10} {"-"*10} {"-"*10}')
    for fname in FEATURES:
        wv = w_imp.get(f'w_{fname}', 0)
        cv = c_imp.get(f'c_{fname}', 0)
        print(f'  {fname:<12} {wv:>10.1f} {cv:>10.1f} {wv-cv:>+10.1f}')
    
    print('\nDone.')
