#!/usr/bin/env python3
"""
RESEARCH: Does MC Cumulative eliminate the need for multi-checkpoint graduation?

Uses raw backtest data (16,910 checkpoints, ~1,233 games) with local MC simulation.
"""

import json
import random
import math
import sys
from collections import defaultdict

random.seed(42)

# ─── LOAD DATA ────────────────────────────────────────────────────────────────

print("Loading backtest data...")
with open('/tmp/raw_backtest.json') as f:
    raw_rows = json.load(f)
print(f"  {len(raw_rows)} total rows")

# Also load the pre-computed floor/XGB data
with open('/tmp/backtest_nomc.json') as f:
    xgb_rows = json.load(f)
print(f"  {len(xgb_rows)} XGB rows (Q2+)")

# Index XGB data by (game_id, checkpoint)
xgb_index = {}
for r in xgb_rows:
    key = (r['gid'], r['cp'])
    xgb_index[key] = r

# ─── MC SIMULATION (mirrors JS exactly) ──────────────────────────────────────

def simulate_possession(rates):
    if random.random() < rates['toRate']:
        return 0
    pts = 0
    is_make = False
    if random.random() < rates['fg3aShare']:
        is_make = random.random() < rates['fg3Pct']
        if is_make:
            pts = 3
    else:
        is_make = random.random() < rates['fg2Pct']
        if is_make:
            pts = 2
    if not is_make and random.random() < rates['orebRate']:
        if random.random() < rates['fg2Pct']:
            pts = 2
    if random.random() < rates['ftaRate'] / 2:
        if random.random() < rates['ftPct']:
            pts += 1
        if random.random() < rates['ftPct']:
            pts += 1
    return pts


def run_mc_sim(home_rates, away_rates, home_score, away_score, remain_poss, sim_count=300, ctrl_is_home=True):
    ctrl_wins = 0
    for _ in range(sim_count):
        h = home_score
        a = away_score
        hp = round(remain_poss)
        ap = round(remain_poss)
        home_ball = random.random() < 0.5
        while hp > 0 or ap > 0:
            if home_ball:
                if hp > 0:
                    h += simulate_possession(home_rates)
                    hp -= 1
            else:
                if ap > 0:
                    a += simulate_possession(away_rates)
                    ap -= 1
            home_ball = not home_ball
        final = (h - a) if ctrl_is_home else (a - h)
        if final > 0:
            ctrl_wins += 1
        elif final == 0:
            ctrl_wins += 0.5
    return round(ctrl_wins / sim_count, 3)


def agg_to_mc_rates(stats):
    fga = int(stats.get('fga', 0)) or 1
    fgm = int(stats.get('fgm', 0))
    fg3a = int(stats.get('fg3a', 0))
    fg3m = int(stats.get('fg3m', 0))
    fta = int(stats.get('fta', 0))
    ftm = int(stats.get('ftm', 0))
    to = int(stats.get('to', 0))
    oreb = int(stats.get('oreb', 0))
    poss = fga + 0.44 * fta - oreb + to
    if poss < 3:
        poss = max(fga, 3)
    fg2a = fga - fg3a
    fg2m = fgm - fg3m
    if fga < 3:
        return None
    raw_fg3 = fg3m / fg3a if fg3a > 0 else 0.36
    sw = min(0.60, fg3a / 30)
    fg3_pct = raw_fg3 * sw + 0.36 * (1 - sw)
    clamp = lambda v: max(0, min(1, v))
    return {
        'toRate': clamp(to / poss if poss > 0 else 0.12),
        'fg3aShare': clamp(fg3a / fga if fga > 0 else 0.35),
        'fg3Pct': clamp(fg3_pct),
        'fg2Pct': clamp(fg2m / fg2a if fg2a > 0 else 0.50),
        'orebRate': clamp(oreb / (fga - fgm) if (fga - fgm) > 0 else 0.25),
        'ftaRate': min(fta / poss if poss > 0 else 0.20, 1.0),
        'ftPct': clamp(ftm / fta if fta > 0 else 0.76),
    }


def estimate_remaining_poss(h_stats, a_stats, period, clock_sec):
    def est(s):
        return int(s.get('fga',0)) + 0.44 * int(s.get('fta',0)) - int(s.get('oreb',0)) + int(s.get('to',0))
    hp = est(h_stats)
    ap = est(a_stats)
    avg = (hp + ap) / 2
    elapsed = (min(period, 4) - 1) * 12 + (12 - clock_sec / 60)
    if elapsed < 1:
        elapsed = 1
    remain = max(0, 48 - elapsed)
    pace = avg / elapsed
    return max(0, round(pace * remain))


# ─── COMPUTE MC CUM FOR ALL Q2+ CHECKPOINTS ─────────────────────────────────

print("\nComputing MC Cumulative for all Q2+ checkpoints...")
mc_data = {}  # (game_id, checkpoint) → mc_cum
processed = 0
skipped = 0

for row in raw_rows:
    period = row['period']
    if period < 2:
        continue

    ts = row['team_stats']
    if not ts or 'home' not in ts or 'away' not in ts:
        skipped += 1
        continue

    h_stats = ts['home']
    a_stats = ts['away']
    
    # Get ctrl team from indicators
    ind = row.get('ind', {})
    if isinstance(ind, str):
        ind = json.loads(ind)
    ctrl = ind.get('controlTeam', '')
    if not ctrl:
        skipped += 1
        continue
    
    h_alias = row['home_alias']
    a_alias = row['away_alias']
    ctrl_is_home = ctrl == h_alias

    clock_sec = row.get('clock_sec', 0) or 0

    remain = estimate_remaining_poss(h_stats, a_stats, period, clock_sec)
    if remain < 1:
        skipped += 1
        continue

    h_rates = agg_to_mc_rates(h_stats)
    a_rates = agg_to_mc_rates(a_stats)
    if not h_rates or not a_rates:
        skipped += 1
        continue

    h_pts = int(h_stats.get('pts', 0))
    a_pts = int(a_stats.get('pts', 0))
    
    mc_cum = run_mc_sim(h_rates, a_rates, h_pts, a_pts, remain, 
                        sim_count=300, ctrl_is_home=ctrl_is_home)

    key = (row['game_id'], row['checkpoint'])
    mc_data[key] = mc_cum

    processed += 1
    if processed % 2000 == 0:
        print(f"  Processed {processed}...")

print(f"  Done: {processed} MC values computed, {skipped} skipped")

# ─── BUILD UNIFIED DATASET ───────────────────────────────────────────────────

print("\nBuilding unified dataset...")

# Parse checkpoint string → (period, clock_remaining_min, is_end)
def parse_cp(cp_str):
    parts = cp_str.split('_')
    q = int(parts[0][1])
    if parts[1] == 'END':
        return q, 0.0, True
    mins = int(parts[1])
    return q, mins, False

# Build per-game checkpoint sequences
games = defaultdict(list)
for row in raw_rows:
    if row['period'] < 2:
        continue
    
    gid = row['game_id']
    cp = row['checkpoint']
    key = (gid, cp)
    
    mc_cum = mc_data.get(key)
    xgb_row = xgb_index.get(key, {})
    
    if mc_cum is None:
        continue
    
    # Get floor from indicators
    ind = row.get('ind', {})
    if isinstance(ind, str):
        ind = json.loads(ind)
    floor = ind.get('score', 0)
    ctrl = ind.get('controlTeam', '')
    
    h_alias = row['home_alias']
    a_alias = row['away_alias']
    ctrl_is_home = ctrl == h_alias
    
    # Ctrl-relative margin
    raw_margin = row.get('margin', 0) or 0
    ctrl_margin = raw_margin * (1 if ctrl_is_home else -1)
    
    period, clk_min, is_end = parse_cp(cp)
    
    games[gid].append({
        'gid': gid,
        'cp': cp,
        'period': period,
        'clk': clk_min,
        'is_end': is_end,
        'floor': floor,
        'mc_cum': mc_cum,
        'xgb_2q': xgb_row.get('w'),  # 2Q window features (for XGB pred later if needed)
        'ctrl_margin': ctrl_margin,
        'ctrl': ctrl,
        'ctrl_won': row.get('ctrl_won'),
        'final_margin': row.get('final_margin'),
    })

# Sort each game's checkpoints chronologically
for gid in games:
    games[gid].sort(key=lambda x: (x['period'], -x['clk']))

total_cps = sum(len(v) for v in games.values())
print(f"  {len(games)} games, {total_cps} checkpoints with MC + floor")

# ─── ANALYSIS A: MC TRAJECTORY vs SINGLE SNAPSHOT ────────────────────────────

print("\n" + "="*70)
print("ANALYSIS A: Does MC trajectory add value over single snapshot?")
print("="*70)

# For each Q4 checkpoint where MC ≥ 0.80, check if having 3 consecutive
# checkpoints at ≥ 0.80 before it beats a single reading.

for threshold in [0.70, 0.75, 0.80]:
    single_correct = 0
    single_total = 0
    consec3_correct = 0
    consec3_total = 0
    consec2_correct = 0
    consec2_total = 0
    
    for gid, cps in games.items():
        for i, cp in enumerate(cps):
            if cp['period'] != 4:
                continue
            if cp['mc_cum'] < threshold:
                continue
            won = cp['ctrl_won']
            if won is None:
                continue
            
            # Single snapshot
            single_total += 1
            if won:
                single_correct += 1
            
            # Check 2 consecutive (this + 1 prior)
            if i >= 1 and cps[i-1]['mc_cum'] >= threshold:
                consec2_total += 1
                if won:
                    consec2_correct += 1
            
            # Check 3 consecutive (this + 2 prior)
            if i >= 2 and cps[i-1]['mc_cum'] >= threshold and cps[i-2]['mc_cum'] >= threshold:
                consec3_total += 1
                if won:
                    consec3_correct += 1

    print(f"\n  MC Cum ≥ {threshold} in Q4:")
    print(f"    Single snapshot:  {single_correct}/{single_total} = {single_correct/single_total*100:.1f}%" if single_total else "    Single: n/a")
    print(f"    2 consecutive:    {consec2_correct}/{consec2_total} = {consec2_correct/consec2_total*100:.1f}%" if consec2_total else "    2 consec: n/a")
    print(f"    3 consecutive:    {consec3_correct}/{consec3_total} = {consec3_correct/consec3_total*100:.1f}%" if consec3_total else "    3 consec: n/a")
    if single_total and consec3_total:
        delta = (consec3_correct/consec3_total - single_correct/single_total) * 100
        print(f"    Trajectory lift:  {delta:+.1f}pp ({consec3_total}/{single_total} = {consec3_total/single_total*100:.0f}% qualify)")

# Also test across ALL quarters
print("\n  Across ALL quarters (Q2+Q3+Q4):")
for threshold in [0.70, 0.80]:
    single_ok = 0; single_n = 0
    c3_ok = 0; c3_n = 0
    
    for gid, cps in games.items():
        for i, cp in enumerate(cps):
            if cp['mc_cum'] < threshold:
                continue
            won = cp['ctrl_won']
            if won is None:
                continue
            single_n += 1
            if won:
                single_ok += 1
            if i >= 2 and cps[i-1]['mc_cum'] >= threshold and cps[i-2]['mc_cum'] >= threshold:
                c3_n += 1
                if won:
                    c3_ok += 1

    print(f"\n  MC ≥ {threshold} ALL Q:")
    print(f"    Single: {single_ok}/{single_n} = {single_ok/single_n*100:.1f}%" if single_n else "")
    print(f"    3 consec: {c3_ok}/{c3_n} = {c3_ok/c3_n*100:.1f}%" if c3_n else "")

# ─── ANALYSIS B: SINGLE-CHECKPOINT COMPOUND vs GRADUATION ────────────────────

print("\n" + "="*70)
print("ANALYSIS B: Single-checkpoint compound vs graduation ranks")
print("="*70)

# Simulate graduation ranks from floor trajectory
def compute_graduation(cps):
    """Simulate graduation from floor trajectory.
    Returns list of (cp_index, rank, flips, holds) at each checkpoint.
    """
    results = []
    floor_readings = []
    flips = 0
    ctrl_team = None
    
    MF_THRESHOLD = 0.65
    MIN_FLOOR = 0.58
    
    for i, cp in enumerate(cps):
        current_ctrl = cp['ctrl']
        
        # Track flips
        if ctrl_team is not None and current_ctrl != ctrl_team:
            flips += 1
        ctrl_team = current_ctrl
        
        floor = cp['floor']
        floor_readings.append(floor)
        
        # Mean floor
        mf = sum(floor_readings) / len(floor_readings)
        holds = sum(1 for f in floor_readings if f >= MIN_FLOOR)
        eligible = len(floor_readings)
        
        # Determine rank
        if flips == 0 and mf >= MF_THRESHOLD and all(f >= MIN_FLOOR for f in floor_readings):
            if eligible >= 8:
                rank = 'S'
            elif eligible >= 6:
                rank = 'A'
            elif eligible >= 4:
                rank = 'B'
            elif eligible >= 2:
                rank = 'C'
            else:
                rank = 'C'
        elif mf >= MF_THRESHOLD:
            if flips == 0:
                if eligible >= 6:
                    rank = 'A'
                elif eligible >= 4:
                    rank = 'B'
                elif eligible >= 2:
                    rank = 'C'
                else:
                    rank = 'C'
            elif flips == 1 and mf >= 0.55 and holds >= 2:
                rank = 'B'  # flip recovery
            else:
                rank = 'C'
        else:
            rank = 'C'
        
        results.append({
            'rank': rank,
            'flips': flips,
            'holds': holds,
            'eligible': eligible,
            'mf': mf,
        })
    
    return results

# Compute graduation + compound for each checkpoint
grad_compound = []
for gid, cps in games.items():
    grads = compute_graduation(cps)
    
    for i, cp in enumerate(cps):
        won = cp['ctrl_won']
        if won is None:
            continue
        
        g = grads[i]
        
        grad_compound.append({
            'period': cp['period'],
            'floor': cp['floor'],
            'mc_cum': cp['mc_cum'],
            'ctrl_margin': cp['ctrl_margin'],
            'rank': g['rank'],
            'flips': g['flips'],
            'holds': g['holds'],
            'eligible': g['eligible'],
            'mf': g['mf'],
            'won': won,
        })

print(f"  {len(grad_compound)} checkpoints with graduation + compound data")

# Compare graduation ranks vs compound tiers per quarter
for q in [2, 3, 4]:
    qdata = [x for x in grad_compound if x['period'] == q]
    print(f"\n  === Q{q} ({len(qdata)} checkpoints) ===")
    
    # Graduation accuracy by rank
    print(f"  Graduation ranks:")
    for rank in ['S', 'A', 'B', 'C']:
        rdata = [x for x in qdata if x['rank'] == rank]
        if rdata:
            wins = sum(1 for x in rdata if x['won'])
            print(f"    {rank}: {wins}/{len(rdata)} = {wins/len(rdata)*100:.1f}%")
    
    # A-rank with flips
    a_flips = [x for x in qdata if x['rank'] == 'A' and x['flips'] > 0]
    a_no_flips = [x for x in qdata if x['rank'] == 'A' and x['flips'] == 0]
    if a_flips:
        w = sum(1 for x in a_flips if x['won'])
        print(f"    A+flips: {w}/{len(a_flips)} = {w/len(a_flips)*100:.1f}%")
    if a_no_flips:
        w = sum(1 for x in a_no_flips if x['won'])
        print(f"    A-clean: {w}/{len(a_no_flips)} = {w/len(a_no_flips)*100:.1f}%")
    
    # Single-checkpoint compound tiers
    print(f"  Compound tiers (single checkpoint):")
    tiers = [
        ("ALL3 high", lambda x: x['mc_cum'] >= 0.70 and x['floor'] >= 0.65),
        ("MC≥0.80+flr≥0.65", lambda x: x['mc_cum'] >= 0.80 and x['floor'] >= 0.65),
        ("MC≥0.80 only", lambda x: x['mc_cum'] >= 0.80),
        ("MC≥0.70 only", lambda x: x['mc_cum'] >= 0.70),
        ("MC≥0.60+flr≥0.55", lambda x: x['mc_cum'] >= 0.60 and x['floor'] >= 0.55),
    ]
    for name, fn in tiers:
        tdata = [x for x in qdata if fn(x)]
        if tdata:
            wins = sum(1 for x in tdata if x['won'])
            print(f"    {name}: {wins}/{len(tdata)} = {wins/len(tdata)*100:.1f}%")

# ─── ANALYSIS C: OPTIMAL THRESHOLDS PER QUARTER ──────────────────────────────

print("\n" + "="*70)
print("ANALYSIS C: Optimal compound thresholds per quarter")
print("="*70)

for q in [2, 3, 4]:
    qdata = [x for x in grad_compound if x['period'] == q]
    print(f"\n  === Q{q} ===")
    
    # MC threshold sweep
    print(f"  MC Cum threshold sweep:")
    for mc_th in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]:
        hits = [x for x in qdata if x['mc_cum'] >= mc_th]
        if len(hits) >= 20:
            w = sum(1 for x in hits if x['won'])
            print(f"    MC≥{mc_th:.2f}: {w}/{len(hits)} = {w/len(hits)*100:.1f}% (n={len(hits)})")
    
    # MC + Floor compound sweep
    print(f"  MC + Floor compound:")
    for mc_th in [0.60, 0.65, 0.70, 0.75, 0.80]:
        for flr_th in [0.50, 0.55, 0.60, 0.65, 0.70]:
            hits = [x for x in qdata if x['mc_cum'] >= mc_th and x['floor'] >= flr_th]
            if len(hits) >= 20:
                w = sum(1 for x in hits if x['won'])
                print(f"    MC≥{mc_th:.2f}+Flr≥{flr_th:.2f}: {w}/{len(hits)} = {w/len(hits)*100:.1f}% (n={len(hits)})")

# ─── ANALYSIS D: MC DISCRIMINATES WITHIN A-RANK FLIPS ────────────────────────

print("\n" + "="*70)
print("ANALYSIS D: MC discrimination within A-rank-with-flips")
print("="*70)

a_flips_all = [x for x in grad_compound if x['rank'] == 'A' and x['flips'] > 0]
print(f"  Total A-rank with flips: {len(a_flips_all)}")
if a_flips_all:
    w = sum(1 for x in a_flips_all if x['won'])
    print(f"  Overall: {w}/{len(a_flips_all)} = {w/len(a_flips_all)*100:.1f}%")

for mc_th, label in [(0.80, 'MC≥0.80'), (0.70, 'MC≥0.70'), (0.60, 'MC≥0.60'), 
                      (0.50, 'MC 0.50-0.60'), (0.01, 'MC<0.50')]:
    if mc_th >= 0.50:
        subset = [x for x in a_flips_all if x['mc_cum'] >= mc_th]
    elif mc_th > 0:
        subset = [x for x in a_flips_all if 0.50 <= x['mc_cum'] < 0.60]
    else:
        subset = [x for x in a_flips_all if x['mc_cum'] < 0.50]
    if subset:
        w = sum(1 for x in subset if x['won'])
        print(f"  {label}: {w}/{len(subset)} = {w/len(subset)*100:.1f}% (n={len(subset)})")

# By quarter
for q in [3, 4]:
    print(f"\n  A-rank flips in Q{q}:")
    qdata = [x for x in a_flips_all if x['period'] == q]
    if not qdata:
        print(f"    No data")
        continue
    w = sum(1 for x in qdata if x['won'])
    print(f"    Overall: {w}/{len(qdata)} = {w/len(qdata)*100:.1f}%")
    for mc_th in [0.80, 0.70, 0.60]:
        sub = [x for x in qdata if x['mc_cum'] >= mc_th]
        if sub:
            w2 = sum(1 for x in sub if x['won'])
            print(f"    MC≥{mc_th}: {w2}/{len(sub)} = {w2/len(sub)*100:.1f}%")
    sub_low = [x for x in qdata if x['mc_cum'] < 0.50]
    if sub_low:
        w2 = sum(1 for x in sub_low if x['won'])
        print(f"    MC<0.50: {w2}/{len(sub_low)} = {w2/len(sub_low)*100:.1f}%")

# ─── ANALYSIS E: SIMPLIFIED GRADUATION ───────────────────────────────────────

print("\n" + "="*70)
print("ANALYSIS E: Can graduation simplify to first-checkpoint-above-threshold?")
print("="*70)

# For each game, find the FIRST checkpoint where compound exceeds threshold
# and check if that single decision is accurate enough

def first_above_analysis(threshold_fn, label):
    correct = 0
    total = 0
    by_q = defaultdict(lambda: {'ok': 0, 'n': 0})
    
    for gid, cps in games.items():
        found = False
        for cp in cps:
            if cp['ctrl_won'] is None:
                continue
            if not found and threshold_fn(cp):
                found = True
                total += 1
                won = cp['ctrl_won']
                if won:
                    correct += 1
                by_q[cp['period']]['n'] += 1
                if won:
                    by_q[cp['period']]['ok'] += 1
                break  # only first crossing
    
    if total == 0:
        return
    print(f"\n  {label}:")
    print(f"    Overall: {correct}/{total} = {correct/total*100:.1f}% ({total}/{len(games)} games trigger)")
    for q in sorted(by_q.keys()):
        d = by_q[q]
        print(f"    First fire Q{q}: {d['ok']}/{d['n']} = {d['ok']/d['n']*100:.1f}%")

# Test various compound thresholds
first_above_analysis(
    lambda x: x['mc_cum'] >= 0.80 and x['floor'] >= 0.65,
    "First MC≥0.80 + Floor≥0.65"
)
first_above_analysis(
    lambda x: x['mc_cum'] >= 0.75 and x['floor'] >= 0.60,
    "First MC≥0.75 + Floor≥0.60"
)
first_above_analysis(
    lambda x: x['mc_cum'] >= 0.70 and x['floor'] >= 0.55,
    "First MC≥0.70 + Floor≥0.55"
)
first_above_analysis(
    lambda x: x['mc_cum'] >= 0.80,
    "First MC≥0.80 (alone)"
)
first_above_analysis(
    lambda x: x['floor'] >= 0.65,
    "First Floor≥0.65 (alone, current system baseline)"
)

# Compare: first fire vs "best reading" in game
print("\n  --- First fire vs best reading comparison ---")
for mc_th, flr_th, label in [(0.80, 0.65, "MC≥0.80+F≥0.65"), (0.70, 0.55, "MC≥0.70+F≥0.55")]:
    first_ok = 0; first_n = 0
    any_ok = 0; any_n = 0
    
    for gid, cps in games.items():
        won = cps[0]['ctrl_won']
        if won is None:
            continue
        
        qualifying = [cp for cp in cps if cp['mc_cum'] >= mc_th and cp['floor'] >= flr_th]
        if qualifying:
            any_n += 1
            if won:
                any_ok += 1
            # First one
            first_n += 1
            if won:
                first_ok += 1
    
    if first_n:
        print(f"  {label}: first fire {first_ok}/{first_n}={first_ok/first_n*100:.1f}%, any fire {any_ok}/{any_n}={any_ok/any_n*100:.1f}%")

# ─── ANALYSIS F: MC TRAJECTORY TRACKING vs FLOOR TRAJECTORY ─────────────────

print("\n" + "="*70)
print("ANALYSIS F: Should graduation track MC instead of floor?")
print("="*70)

# Build MC-based graduation: track MC readings instead of floor
def mc_graduation(cps, mc_threshold=0.65, min_mc=0.50):
    results = []
    mc_readings = []
    ctrl_team = None
    flips = 0
    
    for cp in cps:
        current_ctrl = cp['ctrl']
        if ctrl_team is not None and current_ctrl != ctrl_team:
            flips += 1
        ctrl_team = current_ctrl
        
        mc_readings.append(cp['mc_cum'])
        mean_mc = sum(mc_readings) / len(mc_readings)
        holds = sum(1 for m in mc_readings if m >= min_mc)
        
        if flips == 0 and mean_mc >= mc_threshold:
            if len(mc_readings) >= 8:
                rank = 'S'
            elif len(mc_readings) >= 6:
                rank = 'A'
            elif len(mc_readings) >= 4:
                rank = 'B'
            else:
                rank = 'C'
        elif mean_mc >= mc_threshold:
            if flips <= 1 and holds >= 2:
                rank = 'B'
            else:
                rank = 'C'
        else:
            rank = 'C'
        
        results.append({'rank': rank, 'flips': flips, 'mean_mc': mean_mc})
    return results

# Compare floor-graduation vs MC-graduation at each checkpoint
floor_grad_results = defaultdict(lambda: {'ok': 0, 'n': 0})
mc_grad_results = defaultdict(lambda: {'ok': 0, 'n': 0})

for gid, cps in games.items():
    f_grads = compute_graduation(cps)
    m_grads = mc_graduation(cps)
    
    for i, cp in enumerate(cps):
        if cp['ctrl_won'] is None:
            continue
        won = cp['ctrl_won']
        
        fr = f_grads[i]['rank']
        mr = m_grads[i]['rank']
        
        for rank in ['S', 'A', 'B', 'C']:
            if fr == rank:
                floor_grad_results[(cp['period'], rank)]['n'] += 1
                if won:
                    floor_grad_results[(cp['period'], rank)]['ok'] += 1
            if mr == rank:
                mc_grad_results[(cp['period'], rank)]['n'] += 1
                if won:
                    mc_grad_results[(cp['period'], rank)]['ok'] += 1

print("\n  Floor-based graduation vs MC-based graduation:")
for q in [2, 3, 4]:
    print(f"\n  Q{q}:")
    for rank in ['S', 'A', 'B', 'C']:
        fk = floor_grad_results.get((q, rank), {'ok': 0, 'n': 0})
        mk = mc_grad_results.get((q, rank), {'ok': 0, 'n': 0})
        f_pct = f"{fk['ok']}/{fk['n']}={fk['ok']/fk['n']*100:.1f}%" if fk['n'] else "n/a"
        m_pct = f"{mk['ok']}/{mk['n']}={mk['ok']/mk['n']*100:.1f}%" if mk['n'] else "n/a"
        print(f"    {rank}: Floor={f_pct}  MC={m_pct}")

# ─── SUMMARY STATS ───────────────────────────────────────────────────────────

print("\n" + "="*70)
print("SUMMARY STATS")
print("="*70)

# Overall MC accuracy by threshold
for q in [2, 3, 4]:
    qdata = [x for x in grad_compound if x['period'] == q]
    print(f"\n  Q{q} MC Cum accuracy:")
    for th in [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]:
        hits = [x for x in qdata if x['mc_cum'] >= th]
        if len(hits) >= 10:
            w = sum(1 for x in hits if x['won'])
            print(f"    ≥{th:.2f}: {w}/{len(hits)} = {w/len(hits)*100:.1f}%")

print("\n\nDone. All analyses complete.")
