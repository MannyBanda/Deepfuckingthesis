#!/usr/bin/env python3
"""Re-score all WNBA production snapshots with current model + WINDOWED features."""
import json, math, time, base64, urllib.request
from collections import defaultdict

AUTH = 'Basic ' + base64.b64encode(b'manny:DFT2025!').decode()
BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api'
MODEL_PATH = 'netlify/functions/xgb-model-wnba.json'
PERIOD_SECS = 600

ALIAS_MAP = {'LVA':'LV','NYL':'NY','GSV':'GS','WAS':'WSH','LAS':'LA','PDX':'POR','TOY':'TOR'}
def norm(a): return ALIAS_MAP.get(a, a)

# BDL short keys that map to the stat fields we need
STAT_KEYS = ['fgm','fga','fg3m','fg3a','ftm','fta','oreb','stl','blk','to','pot','ast','fd']

def fetch(params):
    req = urllib.request.Request(f'{BASE}?{params}', headers={'Authorization': AUTH})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

with open(MODEL_PATH) as f:
    model = json.load(f)

def sigmoid(x):
    if x > 30: return 1.0
    if x < -30: return 0.0
    return 1.0 / (1.0 + math.exp(-x))

def predict_tree(tree, fvec):
    idx = 0
    s, c, l, r, w = tree['s'], tree['c'], tree['l'], tree['r'], tree['w']
    while l[idx] != -1:
        fval = fvec[s[idx]] if s[idx] < len(fvec) else 0
        idx = l[idx] if fval < c[idx] else r[idx]
    return w[idx]

def predict_xgb(fvec):
    base_logit = math.log(model['base_score'] / (1 - model['base_score']))
    total = base_logit
    for tree in model['trees']:
        total += predict_tree(tree, fvec)
    return sigmoid(total)

def n(v): return float(v) if v is not None else 0.0
def safepct(num, den): return num / den if den > 0 else 0.0

def parse_raw_stats(raw_side):
    """Extract numeric stats from raw_stats_json home/away."""
    return {
        'fgm': n(raw_side.get('fgm')), 'fga': n(raw_side.get('fga')),
        'fg3m': n(raw_side.get('fg3m')), 'fg3a': n(raw_side.get('fg3a')),
        'ftm': n(raw_side.get('ftm')), 'fta': n(raw_side.get('fta')),
        'oreb': n(raw_side.get('oreb')), 'stl': n(raw_side.get('stl')),
        'blk': n(raw_side.get('blk')), 'tov': n(raw_side.get('to')),
        'pot': n(raw_side.get('pot')), 'ast': n(raw_side.get('ast')),
        'pf': n(raw_side.get('fd') or raw_side.get('pf') or raw_side.get('fouls') or 0),
        'bigLead': n(raw_side.get('bigLead')),
    }

def diff_stats(curr, prev):
    """Diff two cumulative stat dicts to get per-period stats."""
    return {k: curr.get(k, 0) - prev.get(k, 0) for k in curr if k != 'bigLead'}

def weighted_agg(window_qs):
    """Apply cross-fade weights to list of (weight, stats_dict) pairs."""
    agg = {}
    for w, d in window_qs:
        for k, v in d.items():
            agg[k] = agg.get(k, 0) + v * w
    return agg

# ── Pull games and snapshots ──
print('Pulling games...')
games_resp = fetch('action=get_games&league=wnba')
game_list = [g for g in games_resp.get('games', []) if g.get('winner')]
print(f'  {len(game_list)} finished games')

print('Pulling snapshots...')
games_data = {}
for g in game_list:
    gid = g['id']
    try:
        h = fetch(f'action=history&game_id={gid}&league=wnba')
        snaps = h.get('snapshots', [])
        games_data[gid] = {'snaps': snaps, 'winner': g['winner'],
                           'home': g.get('home_alias',''), 'away': g.get('away_alias','')}
        print(f'  {g.get("date")} {g.get("away_alias")}@{g.get("home_alias")}: {len(snaps)}')
    except Exception as e:
        print(f'  Error {gid}: {e}')
    time.sleep(0.3)

# ── Process each game ──
rows = []
for gid, gd in games_data.items():
    snaps = gd['snaps']
    winner = gd['winner']; home = gd['home']; away = gd['away']
    if not snaps: continue

    # Parse raw stats for every snapshot
    parsed = []
    for s in snaps:
        raw = s.get('raw_stats_json')
        if not raw: parsed.append(None); continue
        if isinstance(raw, str): raw = json.loads(raw)
        if 'home' not in raw or 'away' not in raw: parsed.append(None); continue
        parsed.append({'home': parse_raw_stats(raw['home']), 'away': parse_raw_stats(raw['away']),
                       'period': s.get('period', 1) or 1, 'clock': s.get('clock', '10:00'),
                       'hp': s.get('home_pts', 0) or 0, 'ap': s.get('away_pts', 0) or 0})

    # Find quarter boundary snapshots (last snapshot of each period)
    boundaries = {}  # period -> index of last snapshot in that period
    for i, p in enumerate(parsed):
        if p is None: continue
        q = p['period']
        # Track last snap seen for each period
        if q not in boundaries or True:  # always update to get latest
            boundaries[q] = i
    # Also find first snap of each period (for boundary diff)
    first_of_period = {}
    for i, p in enumerate(parsed):
        if p is None: continue
        q = p['period']
        if q not in first_of_period:
            first_of_period[q] = i

    # Compute per-quarter stat diffs using boundary snapshots
    # Q1 stats = cumulative at end of Q1
    # Q2 stats = cumulative at end of Q2 - cumulative at end of Q1
    q_stats = {}  # period -> {home: {...}, away: {...}}

    # Q1: use the last Q1 snapshot's cumulative stats
    if 1 in boundaries and parsed[boundaries[1]]:
        b = parsed[boundaries[1]]
        q_stats[1] = {'home': dict(b['home']), 'away': dict(b['away'])}

    # For Q2, Q3: diff from previous period's end
    for q in [2, 3]:
        if q in boundaries and (q-1) in boundaries and parsed[boundaries[q]] and parsed[boundaries[q-1]]:
            curr = parsed[boundaries[q]]
            prev = parsed[boundaries[q-1]]
            q_stats[q] = {
                'home': diff_stats(curr['home'], prev['home']),
                'away': diff_stats(curr['away'], prev['away']),
            }

    # Per-quarter max margins (for windowed biglead)
    q_max_home = {}; q_max_away = {}
    for p in parsed:
        if p is None: continue
        q = p['period']
        margin = p['hp'] - p['ap']
        q_max_home[q] = max(q_max_home.get(q, 0), max(margin, 0))
        q_max_away[q] = max(q_max_away.get(q, 0), max(-margin, 0))

    # ── Score each Q2+ snapshot ──
    for i, s in enumerate(snaps):
        if parsed[i] is None: continue
        p = parsed[i]
        period = p['period']
        if period < 2: continue

        floor_team = s.get('floor_team')
        if not floor_team: continue

        ctrl_norm = norm(floor_team)
        ctrl_is_home = ctrl_norm == norm(home)
        ctrl_won = 1 if ctrl_norm == norm(winner) else 0
        flip = 1 if ctrl_is_home else -1

        # ── Compute WINDOWED stats ──
        clock = p['clock'] or '10:00'
        parts = clock.split(':')
        clk_sec = int(float(parts[0])) * 60 + (int(float(parts[1])) if len(parts) > 1 and parts[1] else 0)
        completion = max(0, min(1, (PERIOD_SECS - clk_sec) / PERIOD_SECS))

        # Partial current quarter: diff from last boundary
        prev_q = period - 1
        if prev_q in boundaries and parsed[boundaries[prev_q]]:
            prev_p = parsed[boundaries[prev_q]]
            partial_home = diff_stats(p['home'], prev_p['home'])
            partial_away = diff_stats(p['away'], prev_p['away'])
        else:
            partial_home = dict(p['home'])
            partial_away = dict(p['away'])

        # Build window quarters
        wq_home = []; wq_away = []
        if period == 2:
            if 1 in q_stats:
                wq_home.append((max(0, 1.0 - completion), q_stats[1]['home']))
                wq_away.append((max(0, 1.0 - completion), q_stats[1]['away']))
            wq_home.append((1.0, partial_home))
            wq_away.append((1.0, partial_away))
        elif period == 3:
            if 2 in q_stats:
                wq_home.append((1.0, q_stats[2]['home']))
                wq_away.append((1.0, q_stats[2]['away']))
            wq_home.append((1.0, partial_home))
            wq_away.append((1.0, partial_away))
        elif period >= 4:
            if 2 in q_stats:
                wq_home.append((max(0, 1.0 - completion), q_stats[2]['home']))
                wq_away.append((max(0, 1.0 - completion), q_stats[2]['away']))
            if 3 in q_stats:
                wq_home.append((1.0, q_stats[3]['home']))
                wq_away.append((1.0, q_stats[3]['away']))
            wq_home.append((1.0, partial_home))
            wq_away.append((1.0, partial_away))

        wH = weighted_agg(wq_home)
        wA = weighted_agg(wq_away)

        wHFGA = wH.get('fga', 0); wAFGA = wA.get('fga', 0)
        if wHFGA < 5 or wAFGA < 5: continue  # insufficient volume

        wCtrl = wH if ctrl_is_home else wA
        wOpp = wA if ctrl_is_home else wH

        # ── Windowed biglead (per-quarter max margin cross-fade) ──
        qmc = q_max_home if ctrl_is_home else q_max_away
        qmo = q_max_away if ctrl_is_home else q_max_home
        wbl_qs = []
        if period == 2: wbl_qs = [(max(0, 1-completion), 1), (1.0, 2)]
        elif period == 3: wbl_qs = [(1.0, 2), (1.0, 3)]
        elif period >= 4: wbl_qs = [(max(0, 1-completion), 2), (1.0, 3), (1.0, 4)]
        w_ctrl_bl = 0; w_opp_bl = 0
        for wt, wq in wbl_qs:
            if wt > 0.1:
                w_ctrl_bl = max(w_ctrl_bl, qmc.get(wq, 0))
                w_opp_bl = max(w_opp_bl, qmo.get(wq, 0))
        windowed_bl = w_ctrl_bl - w_opp_bl

        # ── Ctrl-relative margin ──
        ctrl_margin = (p['hp'] - p['ap']) * flip

        # ── 13 features (matching extractXGBFeaturesWNBA) ──
        wCtrlFGA = max(wCtrl.get('fga', 1), 1)
        wOppFGA = max(wOpp.get('fga', 1), 1)
        features = [
            windowed_bl,                                                                    # [0]
            (wCtrl.get('stl',0)+wCtrl.get('blk',0)) - (wOpp.get('stl',0)+wOpp.get('blk',0)),  # [1] disruption
            wCtrl.get('ast',0) - wOpp.get('ast',0),                                        # [2] ast
            wCtrl.get('oreb',0) - wOpp.get('oreb',0),                                      # [3] oreb
            safepct(wCtrl.get('stl',0), wCtrl.get('tov',0)) - safepct(wOpp.get('stl',0), wOpp.get('tov',0)),  # [4] to_ratio
            wCtrl.get('ftm',0) - wOpp.get('ftm',0),                                        # [5] ftm
            safepct(wCtrl.get('ast',0), max(wCtrl.get('fgm',0),1)) - safepct(wOpp.get('ast',0), max(wOpp.get('fgm',0),1)),  # [6] ast_ratio
            wCtrl.get('pf',0) - wOpp.get('pf',0),                                          # [7] pf
            wCtrl.get('blk',0) - wOpp.get('blk',0),                                        # [8] blk
            wCtrl.get('fta',0) - wOpp.get('fta',0),                                        # [9] fta
            safepct(wCtrl.get('fgm',0)+0.5*wCtrl.get('fg3m',0), wCtrlFGA) - safepct(wOpp.get('fgm',0)+0.5*wOpp.get('fg3m',0), wOppFGA),  # [10] efg
            wCtrl.get('pot',0) - wOpp.get('pot',0),                                        # [11] pot
            windowed_bl - ctrl_margin,                                                       # [12] erosion
        ]

        xgb_new = predict_xgb(features)
        rows.append({
            'xgb_new': xgb_new,
            'xgb_old': float(s['xgb_win_prob']) if s.get('xgb_win_prob') is not None else None,
            'floor': float(s.get('floor_score', 0)),
            'mc_cum': float(s['mc_cum_win_prob']) if s.get('mc_cum_win_prob') is not None else None,
            'window': float(s['window_score']) if s.get('window_score') is not None else None,
            'period': period, 'margin': ctrl_margin, 'ctrl_won': ctrl_won, 'game_id': gid,
        })

print(f'\nRe-scored (windowed): {len(rows)} Q2+ snapshots')
print(f'Ctrl won: {sum(r["ctrl_won"] for r in rows)}/{len(rows)} ({round(sum(r["ctrl_won"] for r in rows)/len(rows)*100,1)}%)')

with open('/tmp/wnba_rescored_v2.json', 'w') as f:
    json.dump(rows, f)

# ── AUC ──
def compute_auc(preds, labels):
    if len(set(labels)) < 2: return None
    pairs = sorted(zip(preds, labels), key=lambda x: -x[0])
    tp = fp = prev_tp = prev_fp = 0; auc = 0.0; prev_score = float('inf')
    pos = sum(labels); neg = len(labels) - pos
    if pos == 0 or neg == 0: return 0.5
    for score, label in pairs:
        if score != prev_score:
            auc += (fp - prev_fp) * (tp + prev_tp) / 2.0
            prev_tp, prev_fp = tp, fp; prev_score = score
        if label: tp += 1
        else: fp += 1
    auc += (fp - prev_fp) * (tp + prev_tp) / 2.0
    return round(auc / (pos * neg), 4)

def brier(preds, labels):
    return round(sum((p - l)**2 for p, l in zip(preds, labels)) / len(preds), 4)

print('\n' + '='*70)
print('PRODUCTION WNBA — RE-SCORED XGB (WINDOWED) vs STORED SIGNALS')
print('='*70)

print(f'\n{"Signal":>12} {"n":>6} {"AUC":>8} {"Brier":>8} {"Dir Acc":>8}')
print('-' * 50)
for name, key in [('XGB (wind)', 'xgb_new'), ('XGB (old)', 'xgb_old'), ('Floor', 'floor'), ('MC Cum', 'mc_cum'), ('Window', 'window')]:
    subset = [(r[key], r['ctrl_won']) for r in rows if r[key] is not None]
    if len(subset) < 20: continue
    preds, labels = zip(*subset)
    auc = compute_auc(list(preds), list(labels))
    br = brier(list(preds), list(labels))
    da = round(sum(1 for p, l in zip(preds, labels) if (p > 0.5) == (l == 1)) / len(preds) * 100, 1)
    print(f'{name:>12} {len(preds):>6} {auc:>8} {br:>8} {da:>7}%')

print(f'\n{"Signal":>12} {"Qtr":>4} {"n":>6} {"AUC":>8} {"Brier":>8}')
print('-' * 48)
for qtr in [2, 3, 4]:
    for name, key in [('XGB (wind)', 'xgb_new'), ('MC Cum', 'mc_cum'), ('Floor', 'floor'), ('Window', 'window')]:
        subset = [(r[key], r['ctrl_won']) for r in rows if r['period'] == qtr and r[key] is not None]
        if len(subset) < 20: continue
        preds, labels = zip(*subset)
        auc = compute_auc(list(preds), list(labels))
        br = brier(list(preds), list(labels))
        print(f'{name:>12} Q{qtr:>2} {len(preds):>6} {auc:>8} {br:>8}')

print(f'\n{"Signal":>12} {"Context":>20} {"n":>6} {"AUC":>8} {"Base WR":>8}')
print('-' * 62)
for ctx_label, ctx_cond in [('ALL', lambda r: True), ('Ctrl LEADING', lambda r: r['margin']>0),
    ('Ctrl TRAILING', lambda r: r['margin']<0), ('Close |m|<=8', lambda r: abs(r['margin'])<=8),
    ('Trail 1-9', lambda r: -9<=r['margin']<0)]:
    sa = [r for r in rows if ctx_cond(r)]
    if len(sa) < 15: continue
    bwr = round(sum(r['ctrl_won'] for r in sa)/len(sa)*100,1)
    for name, key in [('XGB (wind)', 'xgb_new'), ('MC Cum', 'mc_cum'), ('Floor', 'floor')]:
        sub = [(r[key], r['ctrl_won']) for r in sa if r[key] is not None]
        if len(sub) < 15: continue
        p2, l2 = zip(*sub)
        auc = compute_auc(list(p2), list(l2))
        print(f'{name:>12} {ctx_label:>20} {len(sub):>6} {auc:>8} {bwr:>7}%')

# Bucket
print('\n' + '='*70)
print('XGB (WINDOWED RE-SCORED) BUCKET ACCURACY')
print('='*70)
buckets = [(0,0.3),(0.3,0.4),(0.4,0.5),(0.5,0.6),(0.6,0.7),(0.7,0.8),(0.8,0.9),(0.9,1.01)]
print(f'\n{"Bucket":>12} {"ALL":>18} {"LEADING":>18} {"TRAILING":>18}')
print('-' * 70)
for lo, hi in buckets:
    label = f'{lo:.1f}-{hi:.1f}' if hi<=1 else f'>={lo:.1f}'
    parts = {}
    for ctx, cond in [('ALL', lambda r: True), ('LEAD', lambda r: r['margin']>0), ('TRAIL', lambda r: r['margin']<0)]:
        sub = [r for r in rows if lo<=r['xgb_new']<hi and cond(r)]
        if sub: parts[ctx] = f'{round(sum(r["ctrl_won"] for r in sub)/len(sub)*100,1):>5.1f}% (n={len(sub):>3})'
        else: parts[ctx] = f'{"—":>14}'
    print(f'{label:>12} {parts["ALL"]:>18} {parts["LEAD"]:>18} {parts["TRAIL"]:>18}')

# Sanity: May 15+ old vs new
print('\n=== SANITY: May 15+ old vs new ===')
may15 = set()
for g in game_list:
    if g.get('date','') >= '2026-05-15': may15.add(g['id'])
lr = [r for r in rows if r['game_id'] in may15 and r['xgb_old'] is not None]
if lr:
    diffs = [abs(r['xgb_new'] - r['xgb_old']) for r in lr]
    print(f'n={len(lr)}, mean|diff|={sum(diffs)/len(diffs):.4f}, max|diff|={max(diffs):.4f}')
    old_auc = compute_auc([r['xgb_old'] for r in lr], [r['ctrl_won'] for r in lr])
    new_auc = compute_auc([r['xgb_new'] for r in lr], [r['ctrl_won'] for r in lr])
    print(f'Old AUC: {old_auc}, New (windowed) AUC: {new_auc}')

