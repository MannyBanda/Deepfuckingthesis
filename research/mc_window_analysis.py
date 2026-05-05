#!/usr/bin/env python3
"""Compare MC with 2Q window rates vs cumulative rates vs floor vs XGB."""
import json, os, time
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, brier_score_loss
import urllib.request, base64

BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/mc-backtest'
AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()

def pull_all():
    all_rows = []
    offset = 0
    batch = 50  # smaller batches — MC adds compute time
    while True:
        url = f'{BASE}?phase=window_xgb_export&batch={batch}&offset={offset}&mc=1&sims=500'
        req = urllib.request.Request(url)
        req.add_header('Authorization', AUTH)
        try:
            data = json.loads(urllib.request.urlopen(req, timeout=180).read())
        except Exception as e:
            print(f'  Error at offset {offset}: {e}')
            print('  Retrying in 5s...')
            time.sleep(5)
            try:
                data = json.loads(urllib.request.urlopen(req, timeout=180).read())
            except Exception as e2:
                print(f'  Failed again: {e2}, stopping.')
                break
        rows = data.get('rows', [])
        print(f'  offset={offset}: {len(rows)} rows, {data.get("gamesProcessed",0)} games')
        all_rows.extend(rows)
        if not data.get('hasMore', False): break
        offset = data.get('nextOffset', offset + batch)
        time.sleep(0.5)
    return all_rows

# ── Load data ──
cache = '/tmp/mc_window_data.json'
if os.path.exists(cache):
    print('Loading cached data...')
    with open(cache) as f:
        rows = json.load(f)
else:
    print('Pulling data with MC...')
    rows = pull_all()
    with open(cache, 'w') as f:
        json.dump(rows, f)

# Build DataFrame
records = []
for r in rows:
    mc2q = r.get('mc2q')
    mcC = r.get('mcC')
    if mc2q is None and mcC is None: continue
    records.append({
        'game_id': r['gid'], 'checkpoint': r['cp'], 'period': r['p'],
        'clock': r.get('clk', 0), 'won': 1 if r['won'] else 0,
        'margin': r.get('mar', 0), 'floor': r.get('flr', 0),
        'mc_2q': mc2q, 'mc_cum': mcC,
    })

df = pd.DataFrame(records)
print(f'\nSamples with MC: {len(df)}, Games: {df["game_id"].nunique()}')
print(f'MC null rate: mc_2q={df["mc_2q"].isna().mean():.1%}, mc_cum={df["mc_cum"].isna().mean():.1%}')
# Drop rows where either MC is null
df = df.dropna(subset=['mc_2q', 'mc_cum']).reset_index(drop=True)
print(f'After dropping nulls: {len(df)} rows')
print(f'Periods: {df["period"].value_counts().sort_index().to_dict()}')

y = df['won'].values

# ══════════════════════════════════════════════════════════════════
# 1. OVERALL COMPARISON — all signals
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('1. OVERALL SIGNAL COMPARISON')
print('='*70)

signals = [('MC 2Q Window', 'mc_2q'), ('MC Cumulative', 'mc_cum'), ('Floor', 'floor')]
print(f'\n  {"Signal":<16} {"AUC":>8} {"Brier":>8} {"Acc@70":>8} {"n@70":>6}')
print(f'  {"-"*16} {"-"*8} {"-"*8} {"-"*8} {"-"*6}')
for label, col in signals:
    preds = df[col].values
    valid = ~np.isnan(preds)
    if valid.sum() < 10: continue
    auc = roc_auc_score(y[valid], preds[valid])
    brier = brier_score_loss(y[valid], preds[valid])
    h70 = preds >= 0.70
    acc70 = y[h70].mean() if h70.sum() > 0 else 0
    print(f'  {label:<16} {auc:>8.4f} {brier:>8.4f} {acc70:>8.3f} {h70.sum():>6}')

# ══════════════════════════════════════════════════════════════════
# 2. PER-QUARTER BREAKDOWN
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('2. PER-QUARTER BREAKDOWN')
print('='*70)
for p in sorted(df['period'].unique()):
    mask = (df['period'] == p).values
    yq = y[mask]
    if len(np.unique(yq)) < 2: continue
    n = mask.sum()
    print(f'\n  Q{p} (n={n}):')
    print(f'  {"Signal":<16} {"AUC":>8} {"Brier":>8} {"Acc@70":>8} {"n@70":>6}')
    print(f'  {"-"*16} {"-"*8} {"-"*8} {"-"*8} {"-"*6}')
    for label, col in signals:
        pq = df.loc[mask, col].values
        valid = ~np.isnan(pq)
        if valid.sum() < 10: continue
        auc = roc_auc_score(yq[valid], pq[valid])
        brier = brier_score_loss(yq[valid], pq[valid])
        h70 = pq >= 0.70
        acc70 = yq[h70].mean() if h70.sum() > 0 else 0
        print(f'  {label:<16} {auc:>8.4f} {brier:>8.4f} {acc70:>8.3f} {h70.sum():>6}')

# ══════════════════════════════════════════════════════════════════
# 3. MC CALIBRATION — predicted vs actual by bucket
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('3. MC CALIBRATION — predicted vs actual win rate')
print('='*70)
buckets = [(0, 0.30), (0.30, 0.40), (0.40, 0.50), (0.50, 0.60),
           (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 1.01)]

print(f'\n  {"Bucket":<12} {"2Q act%":>10} {"Cum act%":>10} {"2Q n":>8} {"Cum n":>8}')
print(f'  {"-"*12} {"-"*10} {"-"*10} {"-"*8} {"-"*8}')
for lo, hi in buckets:
    m2q = (df['mc_2q'] >= lo) & (df['mc_2q'] < hi)
    mCum = (df['mc_cum'] >= lo) & (df['mc_cum'] < hi)
    act2q = df.loc[m2q, 'won'].mean() if m2q.sum() > 3 else float('nan')
    actCum = df.loc[mCum, 'won'].mean() if mCum.sum() > 3 else float('nan')
    label = f'{lo:.2f}-{hi:.2f}'
    print(f'  {label:<12} {act2q:>10.1%} {actCum:>10.1%} {m2q.sum():>8} {mCum.sum():>8}')

# ══════════════════════════════════════════════════════════════════
# 4. MC vs FLOOR DISAGREEMENT — who's right?
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('4. MC vs FLOOR DISAGREEMENT — when they disagree, who wins?')
print('='*70)
for p in [2, 3, 4]:
    mask = (df['period'] == p).values
    for mc_col, mc_label in [('mc_2q', 'MC 2Q'), ('mc_cum', 'MC Cum')]:
        # MC says yes (>0.60), floor says no (<0.50)
        mc_yes_flr_no = mask & (df[mc_col] >= 0.60).values & (df['floor'] < 0.50).values
        if mc_yes_flr_no.sum() > 5:
            wr = y[mc_yes_flr_no].mean()
            print(f'  Q{p} {mc_label}>0.60 + Floor<0.50: {mc_label} right={wr:.1%} (n={mc_yes_flr_no.sum()})')
        
        # Floor says yes (>0.65), MC says no (<0.40)
        flr_yes_mc_no = mask & (df['floor'] >= 0.65).values & (df[mc_col] < 0.40).values
        if flr_yes_mc_no.sum() > 5:
            wr = y[flr_yes_mc_no].mean()
            print(f'  Q{p} Floor>0.65 + {mc_label}<0.40: Floor right={wr:.1%} (n={flr_yes_mc_no.sum()})')

# ══════════════════════════════════════════════════════════════════
# 5. COLLAPSE DETECTION — MC < 0.50 when floor > 0.65
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('5. COLLAPSE DETECTION — MC drops while floor stays high')
print('   (proxy for the MC canary trigger)')
print('='*70)
for p in [2, 3, 4]:
    mask = (df['period'] == p).values
    for mc_col, mc_label in [('mc_2q', 'MC 2Q'), ('mc_cum', 'MC Cum')]:
        collapse = mask & (df[mc_col] < 0.50).values & (df['floor'] >= 0.65).values
        n = collapse.sum()
        if n > 3:
            loss_rate = 1 - y[collapse].mean()
            print(f'  Q{p} {mc_label}<0.50 + Floor>0.65: ctrl loses {loss_rate:.1%} (n={n}) — '
                  f'{"GOOD CANARY" if loss_rate > 0.40 else "NOISY" if loss_rate > 0.25 else "FALSE ALARM"}')

# ══════════════════════════════════════════════════════════════════
# 6. 2Q vs CUMULATIVE HEAD-TO-HEAD
# ══════════════════════════════════════════════════════════════════
print('\n' + '='*70)
print('6. MC 2Q vs MC CUMULATIVE — direct head-to-head')
print('='*70)
# When they disagree significantly (>15pp), who's right?
for p in [2, 3, 4]:
    mask = (df['period'] == p).values
    diff = df['mc_2q'] - df['mc_cum']
    
    # 2Q more bullish (>15pp higher)
    bull_2q = mask & (diff > 0.15).values
    if bull_2q.sum() > 5:
        wr = y[bull_2q].mean()
        print(f'  Q{p} 2Q more bullish (>15pp): 2Q right={wr:.1%} (n={bull_2q.sum()})')
    
    # 2Q more bearish (>15pp lower)
    bear_2q = mask & (diff < -0.15).values
    if bear_2q.sum() > 5:
        wr = 1 - y[bear_2q].mean()
        print(f'  Q{p} 2Q more bearish (>15pp): 2Q right={wr:.1%} (n={bear_2q.sum()})')

print('\nDone.')
