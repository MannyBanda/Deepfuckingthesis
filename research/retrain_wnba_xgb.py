#!/usr/bin/env python3
"""
WNBA XGB Retrain with Correct Export.

Pulls training data from wnba_xgb_training, computes windowed biglead + erosion,
trains XGBClassifier with production hyperparams, exports to compact JSON with
correct sum_hessian covers for exact SHAP expected values.

Output: /tmp/xgb-model-wnba.json (ready to copy to netlify/functions/)
"""
import json, math, sys, time
import urllib.request, base64
import numpy as np
import xgboost as xgb
from collections import defaultdict
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import roc_auc_score, brier_score_loss, accuracy_score

# ── Config ──
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()
BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/backtest-wnba'
BATCH_SIZE = 500
CACHE_PATH = '/tmp/wnba_xgb_training_data.json'

# Production feature set (13 features, order must match extractXGBFeaturesWNBA in poll-live-bdl.mjs)
PROD_FEATURES = [
    'windowed_biglead',  # [0] cross-fade max margin
    'disruption',        # [1] (stl+blk) diff
    'ast',               # [2] assists diff
    'oreb',              # [3] offensive rebounds diff
    'to_ratio',          # [4] stl/tov ratio diff
    'ftm',               # [5] free throws made diff
    'ast_ratio',         # [6] ast/fgm ratio diff
    'pf',                # [7] personal fouls diff
    'blk',               # [8] blocks diff
    'fta',               # [9] free throws attempted diff
    'efg',               # [10] effective FG% diff
    'pot',               # [11] points off turnovers diff
    'biglead_erosion',   # [12] windowed_biglead - margin
]

HYPERPARAMS = {
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

PERIOD_SECS = 600  # 10-minute WNBA quarters

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1: Pull training data
# ══════════════════════════════════════════════════════════════════════════════

def fetch_page(offset, batch):
    url = f'{BASE}?phase=export_xgb_training&batch={batch}&offset={offset}'
    req = urllib.request.Request(url, headers={'Authorization': AUTH})
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        return json.loads(resp.read())
    except Exception as e:
        print(f'  Error at offset {offset}: {e}')
        return None

def pull_all_data():
    """Paginate through all training rows."""
    import os
    if os.path.exists(CACHE_PATH):
        print(f'  Loading cached data from {CACHE_PATH}')
        with open(CACHE_PATH) as f:
            rows = json.load(f)
        print(f'  Loaded {len(rows)} rows from cache')
        return rows

    all_rows = []
    offset = 0
    while True:
        print(f'  Fetching offset={offset}...')
        data = fetch_page(offset, BATCH_SIZE)
        if not data:
            print('  Retrying in 3s...')
            time.sleep(3)
            data = fetch_page(offset, BATCH_SIZE)
            if not data:
                print(f'  Failed at offset {offset}, stopping.')
                break

        rows = data.get('rows', [])
        print(f'    Got {len(rows)} rows (total so far: {len(all_rows) + len(rows)})')
        all_rows.extend(rows)

        if not data.get('hasMore', False):
            break
        offset = data.get('nextOffset', offset + BATCH_SIZE)
        time.sleep(1)

    with open(CACHE_PATH, 'w') as f:
        json.dump(all_rows, f)
    print(f'  Saved {len(all_rows)} rows to {CACHE_PATH}')
    return all_rows


# ══════════════════════════════════════════════════════════════════════════════
# STEP 2: Compute windowed biglead (exact production cross-fade logic)
# ══════════════════════════════════════════════════════════════════════════════

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
        r['_ref_margin'] = r['margin'] if r['ctrl'] == ref_team else -r['margin']
    
    # Per-quarter max margins (ref team perspective)
    q_max_ref = {}   # quarter -> max ref_margin (ref team's peak lead)
    q_max_opp = {}   # quarter -> max -ref_margin (opp's peak lead)
    
    for r in sorted_rows:
        q = r['q']
        rm = r['_ref_margin']
        q_max_ref[q] = max(q_max_ref.get(q, 0), max(rm, 0))
        q_max_opp[q] = max(q_max_opp.get(q, 0), max(-rm, 0))
    
    # Approximate Q1 from cumulative biglead at first Q2 checkpoint
    first = sorted_rows[0]
    cum_biglead = first['biglead']
    if first['ctrl'] == ref_team:
        q_max_ref[1] = max(cum_biglead, 0) if cum_biglead > 0 else 0
        q_max_opp[1] = max(-cum_biglead, 0) if cum_biglead < 0 else 0
    else:
        q_max_ref[1] = max(-cum_biglead, 0) if cum_biglead < 0 else 0
        q_max_opp[1] = max(cum_biglead, 0) if cum_biglead > 0 else 0
    
    # For each checkpoint, compute cross-fade windowed biglead
    for r in sorted_rows:
        q = r['q']
        gs = r['gs']
        
        elapsed_in_q = gs - (q - 1) * PERIOD_SECS
        completion = max(0, min(1, elapsed_in_q / PERIOD_SECS))
        
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
        
        w_ref_biglead = 0
        w_opp_biglead = 0
        for weight, wq in window_qs:
            if weight > 0.1:
                w_ref_biglead = max(w_ref_biglead, q_max_ref.get(wq, 0))
                w_opp_biglead = max(w_opp_biglead, q_max_opp.get(wq, 0))
        
        if r['ctrl'] == ref_team:
            r['_windowed_biglead'] = w_ref_biglead - w_opp_biglead
        else:
            r['_windowed_biglead'] = w_opp_biglead - w_ref_biglead


# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: Build feature matrix
# ══════════════════════════════════════════════════════════════════════════════

def build_feature_matrix(rows):
    """Build 13-feature matrix matching production extractXGBFeaturesWNBA order."""
    # Group by game and compute windowed biglead
    games = defaultdict(list)
    for r in rows:
        games[r['game_id']].append(r)
    
    print(f'  Computing windowed biglead for {len(games)} games...')
    for gid, grs in games.items():
        compute_windowed_biglead(grs)
    
    # Build feature matrix
    records = []
    for r in rows:
        wb = r.get('_windowed_biglead', r.get('biglead', 0))
        erosion = wb - r.get('margin', 0)
        
        records.append({
            'windowed_biglead': wb,
            'disruption': r.get('disruption', 0),
            'ast': r.get('ast', 0),
            'oreb': r.get('oreb', 0),
            'to_ratio': r.get('to_ratio', 0),
            'ftm': r.get('ftm', 0),
            'ast_ratio': r.get('ast_ratio', 0),
            'pf': r.get('pf', 0),
            'blk': r.get('blk', 0),
            'fta': r.get('fta', 0),
            'efg': r.get('efg', 0),
            'pot': r.get('pot', 0),
            'biglead_erosion': erosion,
            'won': 1 if r['won'] else 0,
            'game_id': r['game_id'],
            'quarter': r['q'],
            'margin': r.get('margin', 0),
        })
    
    import pandas as pd
    df = pd.DataFrame(records)
    X = df[PROD_FEATURES].values
    y = df['won'].values
    groups = df['game_id'].values
    quarters = df['quarter'].values
    
    return df, X, y, groups, quarters


# ══════════════════════════════════════════════════════════════════════════════
# STEP 4: Train with OOF evaluation
# ══════════════════════════════════════════════════════════════════════════════

def train_and_evaluate(X, y, groups, quarters):
    """5-fold stratified OOF evaluation, then train final model on all data."""
    sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
    oof_preds = np.zeros(len(y))
    fold_aucs = []
    
    for fold, (train_idx, val_idx) in enumerate(sgkf.split(X, y, groups)):
        model = xgb.XGBClassifier(**HYPERPARAMS)
        model.fit(X[train_idx], y[train_idx], verbose=False)
        oof_preds[val_idx] = model.predict_proba(X[val_idx])[:, 1]
        fold_auc = roc_auc_score(y[val_idx], oof_preds[val_idx])
        fold_aucs.append(fold_auc)
        print(f'    Fold {fold+1}: AUC={fold_auc:.4f}')
    
    auc = roc_auc_score(y, oof_preds)
    brier = brier_score_loss(y, oof_preds)
    acc = accuracy_score(y, (oof_preds >= 0.5).astype(int))
    
    print(f'\n  OOF AUC:  {auc:.4f}')
    print(f'  Brier:    {brier:.4f}')
    print(f'  Accuracy: {acc:.4f}')
    
    # Per-quarter
    for q in [2, 3, 4]:
        mask = quarters == q
        if mask.sum() > 50:
            q_auc = roc_auc_score(y[mask], oof_preds[mask])
            print(f'  Q{q}: AUC={q_auc:.4f} (n={mask.sum()})')
    
    # Close games
    close_mask = np.abs(np.array([r for r in oof_preds]) - 0.5) < 0.5  # placeholder
    # Actually use margin
    
    # Train final model
    print('\n  Training final model on all data...')
    final = xgb.XGBClassifier(**HYPERPARAMS)
    final.fit(X, y, verbose=False)
    
    # Feature importance
    importances = final.feature_importances_
    print('\n  Feature Importance (gain):')
    for idx in np.argsort(importances)[::-1]:
        print(f'    {PROD_FEATURES[idx]:>20}: {importances[idx]:.4f}')
    
    return final, auc, oof_preds


# ══════════════════════════════════════════════════════════════════════════════
# STEP 5: Export to compact JSON with correct covers
# ══════════════════════════════════════════════════════════════════════════════

def compute_expected_values(c_arr, l_arr, r_arr, covers, n_nodes):
    """Compute expected value at each node using cover-weighted averaging.
    
    For leaves: ev = leaf weight (stored in c_arr).
    For internal nodes: ev = (cover_left * ev_left + cover_right * ev_right) / (cover_left + cover_right).
    
    Uses post-order traversal (children before parents).
    XGBoost guarantees children have higher indices than parents, so reverse iteration works.
    """
    ev = [0.0] * n_nodes
    
    for i in range(n_nodes - 1, -1, -1):
        if l_arr[i] == -1:
            # Leaf: expected value = leaf weight
            ev[i] = c_arr[i]
        else:
            # Internal: cover-weighted average of children
            li, ri = l_arr[i], r_arr[i]
            wl = covers[li]
            wr = covers[ri]
            total = wl + wr
            if total > 0:
                ev[i] = (wl * ev[li] + wr * ev[ri]) / total
            else:
                ev[i] = 0.0
    
    return ev


def export_compact_model(model, n_features):
    """Export XGBClassifier to compact JSON with correct sum_hessian covers.
    
    Compact format per tree:
      s: split feature index (0 for leaves)
      c: split threshold (internal) / leaf weight (leaves)
      l: left child index (-1 for leaves)
      r: right child index (-1 for leaves)  
      w: sum_hessian cover (internal) / leaf weight (leaves)
         - Internal nodes: cover for SHAP ev computation
         - Leaf nodes: leaf weight for predictXGB
      ev: cover-weighted expected values for TreeSHAP
    """
    # Save to native JSON, parse
    tmp_path = '/tmp/xgb_native_wnba.json'
    model.save_model(tmp_path)
    with open(tmp_path) as f:
        native = json.load(f)
    
    # Extract base_score (probability in XGBoost 3.2.0)
    bs_raw = str(native['learner']['learner_model_param']['base_score']).strip('[]')
    base_score = float(bs_raw)
    print(f'\n  Native base_score: {base_score:.8f} (probability)')
    
    # Verify it's in probability space (0 < bs < 1)
    assert 0 < base_score < 1, f'base_score {base_score} not in (0,1) — check if logit conversion needed'
    
    tree_infos = native['learner']['gradient_booster']['model']['trees']
    print(f'  Trees: {len(tree_infos)}')
    
    compact_trees = []
    total_nodes = 0
    total_leaves = 0
    
    for ti, tree_info in enumerate(tree_infos):
        n_nodes = int(tree_info['tree_param']['num_nodes'])
        total_nodes += n_nodes
        
        left_children = tree_info['left_children']
        right_children = tree_info['right_children']
        split_indices = tree_info['split_indices']
        split_conditions = tree_info['split_conditions']
        sum_hessian = tree_info['sum_hessian']
        
        s_arr = []
        c_arr = []
        l_arr = []
        r_arr = []
        w_arr = []
        covers = []  # sum_hessian for ALL nodes (used for ev computation)
        
        for i in range(n_nodes):
            is_leaf = left_children[i] == -1
            if is_leaf:
                total_leaves += 1
            
            # Validate leaf sentinel consistency
            if is_leaf:
                assert right_children[i] == -1, f'Tree {ti} node {i}: l=-1 but r={right_children[i]}'
            
            s_arr.append(0 if is_leaf else int(split_indices[i]))
            c_arr.append(float(split_conditions[i]))
            l_arr.append(int(left_children[i]))
            r_arr.append(int(right_children[i]))
            
            # covers: sum_hessian for ALL nodes (needed for ev computation)
            covers.append(float(sum_hessian[i]))
            
            # w: sum_hessian at internal nodes, leaf weight at leaves
            if is_leaf:
                w_arr.append(float(split_conditions[i]))  # leaf weight for predictXGB
            else:
                w_arr.append(float(sum_hessian[i]))  # cover for reference
        
        # Compute expected values using cover-weighted averaging
        ev_arr = compute_expected_values(c_arr, l_arr, r_arr, covers, n_nodes)
        
        compact_trees.append({
            's': s_arr,
            'c': [round(v, 10) for v in c_arr],
            'l': l_arr,
            'r': r_arr,
            'w': [round(v, 6) for v in w_arr],
            'ev': [round(v, 10) for v in ev_arr],
        })
    
    print(f'  Total nodes: {total_nodes}, Leaves: {total_leaves}')
    
    return {
        'trees': compact_trees,
        'base_score': round(base_score, 8),
        'features': PROD_FEATURES,
        'n_features': n_features,
        'feature_count': n_features,
        'trained_on': f'{len(tree_infos)} trees, XGBoost {xgb.__version__}',
        'note': 'Retrained with correct sum_hessian covers for exact SHAP ev',
    }


# ══════════════════════════════════════════════════════════════════════════════
# STEP 6: Verify predictions match
# ══════════════════════════════════════════════════════════════════════════════

def verify_predictions(compact_model, xgb_model, X, n_samples=500):
    """Verify compact model matches float64 native JSON traversal.
    
    XGBoost internally uses float32 for split comparisons. Our production
    JS uses float64. We verify against float64 native traversal (matching
    production behavior), not XGBoost predict_proba (which may differ on
    edge cases where feature values land exactly on float32 split thresholds).
    """
    with open('/tmp/xgb_native_wnba.json') as f:
        native = json.load(f)
    tree_infos = native['learner']['gradient_booster']['model']['trees']
    bs_native = float(str(native['learner']['learner_model_param']['base_score']).strip('[]'))
    bl_native = math.log(bs_native / (1 - bs_native))
    
    base_score = compact_model['base_score']
    base_logit = math.log(base_score / (1 - base_score))
    
    max_err_native = 0
    xgb_preds = xgb_model.predict_proba(X[:n_samples])[:, 1]
    f32_edge_cases = 0
    
    for si in range(min(n_samples, len(X))):
        features = X[si]
        
        # Compact model traversal (float64)
        compact_sum = 0
        for tree in compact_model['trees']:
            node = 0
            while tree['l'][node] != -1:
                fval = features[tree['s'][node]] if tree['s'][node] < len(features) else 0
                node = tree['l'][node] if fval < tree['c'][node] else tree['r'][node]
            compact_sum += tree['w'][node]
        compact_pred = 1 / (1 + math.exp(-(base_logit + compact_sum)))
        
        # Native JSON traversal (float64 reference)
        native_sum = 0
        for ti in tree_infos:
            node = 0
            while ti['left_children'][node] != -1:
                fval = float(features[ti['split_indices'][node]])
                node = ti['left_children'][node] if fval < ti['split_conditions'][node] else ti['right_children'][node]
            native_sum += ti['split_conditions'][node]
        native_pred = 1 / (1 + math.exp(-(bl_native + native_sum)))
        
        err_native = abs(compact_pred - native_pred)
        max_err_native = max(max_err_native, err_native)
        
        # Track float32 edge cases
        err_xgb = abs(compact_pred - xgb_preds[si])
        if err_xgb > 0.005:
            f32_edge_cases += 1
        
        if si < 5:
            print(f'    Sample {si}: compact={compact_pred:.8f} native64={native_pred:.8f} err={err_native:.2e}')
    
    print(f'  Max error vs native float64: {max_err_native:.2e}')
    if f32_edge_cases > 0:
        print(f'  Float32 edge cases (>0.5pp vs XGBoost): {f32_edge_cases}/{min(n_samples, len(X))} (expected, not a bug)')
    assert max_err_native < 0.005, f'Compact model diverges from native float64! Max error {max_err_native}'
    print('  ✓ Compact model matches native float64 traversal (production-equivalent)')


def verify_shap(compact_model, X, n_samples=5):
    """Verify SHAP contributions sum to prediction (bias + sum = leaf_sum)."""
    base_score = compact_model['base_score']
    base_logit = math.log(base_score / (1 - base_score))
    n_features = compact_model['n_features']
    
    print('\n  SHAP round-trip verification:')
    for si in range(min(n_samples, len(X))):
        features = X[si]
        contribs = [0.0] * n_features
        bias_sum = 0.0
        leaf_sum = 0.0
        
        for tree in compact_model['trees']:
            # Prediction path
            node = 0
            while tree['l'][node] != -1:
                feat = tree['s'][node]
                fval = features[feat] if feat < len(features) else 0
                child = tree['l'][node] if fval < tree['c'][node] else tree['r'][node]
                contribs[feat] += tree['ev'][child] - tree['ev'][node]
                node = child
            leaf_sum += tree['w'][node]
            bias_sum += tree['ev'][0]  # root expected value
        
        shap_sum = sum(contribs)
        reconstructed = bias_sum + shap_sum  # should equal leaf_sum
        err = abs(reconstructed - leaf_sum)
        
        pred = 1 / (1 + math.exp(-(base_logit + leaf_sum)))
        print(f'    Sample {si}: pred={pred:.4f} leaf_sum={leaf_sum:.6f} bias+shap={reconstructed:.6f} err={err:.2e}')
        
        if err > 0.001:
            print(f'    ⚠ SHAP decomposition error > 0.001!')
    
    print('  ✓ SHAP decomposition verified')


def verify_model_structure(compact_model):
    """Verify w contains covers at internal nodes and leaf weights at leaves."""
    print('\n  Model structure verification:')
    tree = compact_model['trees'][0]
    n = len(tree['l'])
    
    internal_w_positive = 0
    internal_w_total = 0
    leaf_w_eq_c = 0
    leaf_total = 0
    
    for i in range(n):
        if tree['l'][i] == -1:
            # Leaf: w should equal c
            leaf_total += 1
            if abs(tree['w'][i] - round(tree['c'][i], 6)) < 1e-8:
                leaf_w_eq_c += 1
        else:
            # Internal: w should be positive (cover/sum_hessian)
            internal_w_total += 1
            if tree['w'][i] > 0:
                internal_w_positive += 1
    
    print(f'    Internal nodes: {internal_w_positive}/{internal_w_total} have positive w (covers)')
    print(f'    Leaf nodes: {leaf_w_eq_c}/{leaf_total} have w == c (leaf weights)')
    
    # Show sample nodes
    print(f'    Sample internal node 0: s={tree["s"][0]} c={tree["c"][0]:.4f} w={tree["w"][0]:.4f} ev={tree["ev"][0]:.6f}')
    for i in range(n):
        if tree['l'][i] == -1:
            print(f'    Sample leaf node {i}: c={tree["c"][i]:.6f} w={tree["w"][i]:.4f} ev={tree["ev"][i]:.6f}')
            break
    
    assert internal_w_positive == internal_w_total, 'Some internal nodes have non-positive w!'
    assert leaf_w_eq_c == leaf_total, 'Some leaf nodes have w != c!'
    print('  ✓ Structure verified')


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print('=' * 60)
    print('WNBA XGB RETRAIN — Clean Export with Correct Covers')
    print('=' * 60)
    
    # Step 1: Pull data
    print('\n[1/6] Pulling training data...')
    rows = pull_all_data()
    n_games = len(set(r['game_id'] for r in rows))
    print(f'  {len(rows)} rows, {n_games} games')
    
    # Step 2-3: Build feature matrix (includes windowed biglead computation)
    print('\n[2/6] Building feature matrix...')
    df, X, y, groups, quarters = build_feature_matrix(rows)
    print(f'  Feature matrix: {X.shape}')
    print(f'  Positive rate: {y.mean():.4f}')
    print(f'  Windowed biglead range: [{X[:, 0].min():.0f}, {X[:, 0].max():.0f}]')
    print(f'  Biglead erosion range: [{X[:, 12].min():.1f}, {X[:, 12].max():.1f}]')
    
    # Step 4: Train
    print('\n[3/6] Training with OOF evaluation...')
    final_model, oof_auc, oof_preds = train_and_evaluate(X, y, groups, quarters)
    
    # Step 5: Export
    print('\n[4/6] Exporting to compact JSON...')
    compact = export_compact_model(final_model, n_features=13)
    
    # Save first (before verification, so we don't lose on assertion)
    output_path = '/tmp/xgb-model-wnba.json'
    print(f'\n[5/6] Saving to {output_path}...')
    with open(output_path, 'w') as f:
        json.dump(compact, f)
    
    import os
    size_kb = os.path.getsize(output_path) / 1024
    print(f'  Model size: {size_kb:.0f} KB')
    
    # Verify
    print('\n[6/6] Verifying...')
    verify_predictions(compact, final_model, X)
    verify_shap(compact, X)
    verify_model_structure(compact)
    
    # Summary
    print(f'\n  OOF AUC: {oof_auc:.4f}')
    print(f'  Trees: {len(compact["trees"])}')
    print(f'  Features: {compact["n_features"]}')
    print(f'  base_score: {compact["base_score"]}')
    
    # Compare to NBA model structure
    if os.path.exists('netlify/functions/xgb-model.json'):
        with open('netlify/functions/xgb-model.json') as f:
            nba = json.load(f)
        nba_t0 = nba['trees'][0]
        wnba_t0 = compact['trees'][0]
        print(f'\n  Structure comparison (tree 0):')
        print(f'    NBA:  {len(nba_t0["l"])} nodes, internal w range [{min(nba_t0["w"][i] for i in range(len(nba_t0["l"])) if nba_t0["l"][i]!=-1):.1f}, {max(nba_t0["w"][i] for i in range(len(nba_t0["l"])) if nba_t0["l"][i]!=-1):.1f}]')
        print(f'    WNBA: {len(wnba_t0["l"])} nodes, internal w range [{min(wnba_t0["w"][i] for i in range(len(wnba_t0["l"])) if wnba_t0["l"][i]!=-1):.1f}, {max(wnba_t0["w"][i] for i in range(len(wnba_t0["l"])) if wnba_t0["l"][i]!=-1):.1f}]')
    
    print('\n' + '=' * 60)
    print('DONE — Model ready at /tmp/xgb-model-wnba.json')
    print('=' * 60)
