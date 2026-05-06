#!/usr/bin/env python3
"""
SNAPSHOT-LEVEL SUSTAINED HOLDS on 48 playoff games with MC Cum.
Tests consecutive poll holds at ~15-20 second granularity.
"""
import json
from collections import defaultdict

with open('/tmp/playoff_mc_cum_fixed.json') as f:
    results = json.load(f)

# Build per-game data with win/loss
game_data = []
for gid, d in results.items():
    label = d['label']
    winner = label.split('(')[1].split('+')[0]
    margin_str = label.split('+')[1].rstrip(')')
    final_margin = int(margin_str)
    tl = d['tl']
    if not tl: continue
    
    main_ctrl = max(set(t['ctrl'] for t in tl), key=[t['ctrl'] for t in tl].count)
    ctrl_won = main_ctrl == winner
    
    # Track ctrl flips
    flips = 0
    prev_ctrl = None
    for t in tl:
        if prev_ctrl and t['ctrl'] != prev_ctrl:
            flips += 1
        prev_ctrl = t['ctrl']
    
    game_data.append({
        'gid': gid,
        'label': label,
        'tl': tl,
        'ctrl_won': ctrl_won,
        'winner': winner,
        'main_ctrl': main_ctrl,
        'final_margin': final_margin,
        'flips': flips,
    })

print(f"{len(game_data)} playoff games loaded")
wins = sum(1 for g in game_data if g['ctrl_won'])
losses = sum(1 for g in game_data if not g['ctrl_won'])
print(f"Ctrl team won: {wins}, lost: {losses}\n")

# ═══════════════════════════════════════════════════════════════════════════════
# 1. SUSTAINED HOLD ANALYSIS — MC Cum at snapshot level
# ═══════════════════════════════════════════════════════════════════════════════

print("="*70)
print("1. SUSTAINED HOLDS: MC Cum consecutive snapshot holds")
print("="*70)

# For each game: find how many consecutive snapshots MC stays above threshold
# Test the first time N consecutive holds is reached

for mc_th in [0.70, 0.75, 0.80, 0.85]:
    print(f"\n  MC ≥ {mc_th}:")
    
    for n_holds in [1, 2, 3, 5, 8, 10, 15, 20, 30]:
        ok = 0; tot = 0
        by_q = defaultdict(lambda: {'ok': 0, 'n': 0})
        hold_minutes = []  # how many minutes into game the Nth hold occurs
        
        for g in game_data:
            tl = g['tl']
            streak = 0
            triggered = False
            
            for i, t in enumerate(tl):
                if t['mc'] is not None and t['mc'] >= mc_th:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        tot += 1
                        if g['ctrl_won']: ok += 1
                        by_q[t['per']]['n'] += 1
                        if g['ctrl_won']: by_q[t['per']]['ok'] += 1
                        
                        # Estimate minutes into game
                        # Each snapshot is ~15-20s apart, but use index position
                        # Q2 starts at game minute 12
                        q_start_min = (t['per'] - 1) * 12
                        q_snaps = len([x for x in tl if x['per'] == t['per']])
                        if q_snaps > 0:
                            q_progress = len([x for x in tl[:i+1] if x['per'] == t['per']]) / q_snaps
                            game_min = q_start_min + q_progress * 12
                            hold_minutes.append(game_min)
                        break
                else:
                    streak = 0
        
        if tot < 5: continue
        acc = ok/tot*100
        avg_min = sum(hold_minutes)/len(hold_minutes) if hold_minutes else 0
        q_parts = []
        for q in sorted(by_q.keys()):
            d = by_q[q]
            if d['n'] >= 3:
                q_parts.append(f"Q{q}={d['ok']}/{d['n']}({d['ok']/d['n']*100:.0f}%)")
        
        print(f"    {n_holds:2d} consec: {ok}/{tot} = {acc:.1f}% | "
              f"triggers {tot}/{len(game_data)} games | avg {avg_min:.1f}min | "
              f"{', '.join(q_parts)}")

# ═══════════════════════════════════════════════════════════════════════════════
# 2. COMPOUND SUSTAINED HOLDS (MC + Floor)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("2. COMPOUND SUSTAINED HOLDS: MC + Floor consecutive snapshots")
print("="*70)

for mc_th, flr_th in [(0.80, 0.65), (0.85, 0.70), (0.80, 0.60), (0.75, 0.60)]:
    print(f"\n  MC≥{mc_th} + Floor≥{flr_th}:")
    
    for n_holds in [1, 2, 3, 5, 8, 10, 15, 20]:
        ok = 0; tot = 0
        by_q = defaultdict(lambda: {'ok': 0, 'n': 0})
        hold_minutes = []
        
        for g in game_data:
            tl = g['tl']
            streak = 0
            triggered = False
            
            for i, t in enumerate(tl):
                mc_ok = t['mc'] is not None and t['mc'] >= mc_th
                flr_ok = t['flr'] is not None and t['flr'] >= flr_th
                
                if mc_ok and flr_ok:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        tot += 1
                        if g['ctrl_won']: ok += 1
                        by_q[t['per']]['n'] += 1
                        if g['ctrl_won']: by_q[t['per']]['ok'] += 1
                        
                        q_start_min = (t['per'] - 1) * 12
                        q_snaps = len([x for x in tl if x['per'] == t['per']])
                        if q_snaps > 0:
                            q_progress = len([x for x in tl[:i+1] if x['per'] == t['per']]) / q_snaps
                            game_min = q_start_min + q_progress * 12
                            hold_minutes.append(game_min)
                        break
                else:
                    streak = 0
        
        if tot < 3: continue
        acc = ok/tot*100
        avg_min = sum(hold_minutes)/len(hold_minutes) if hold_minutes else 0
        q_parts = []
        for q in sorted(by_q.keys()):
            d = by_q[q]
            if d['n'] >= 2:
                q_parts.append(f"Q{q}={d['ok']}/{d['n']}({d['ok']/d['n']*100:.0f}%)")
        
        print(f"    {n_holds:2d} consec: {ok}/{tot} = {acc:.1f}% | "
              f"{tot}/{len(game_data)} games | avg {avg_min:.1f}min | "
              f"{', '.join(q_parts)}")

# ═══════════════════════════════════════════════════════════════════════════════
# 3. HOLD TIME COMPARISON: snapshots vs checkpoints
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("3. HOW LONG (MINUTES) DO CONSECUTIVE HOLDS TAKE?")
print("="*70)

# For MC≥0.80, measure how many minutes N consecutive snapshot holds span
print("\n  MC≥0.80 — time span of N consecutive holds:")

for n_holds in [3, 5, 8, 10, 15, 20]:
    durations = []
    
    for g in game_data:
        tl = g['tl']
        streak = 0
        streak_start_idx = None
        
        for i, t in enumerate(tl):
            if t['mc'] is not None and t['mc'] >= 0.80:
                if streak == 0:
                    streak_start_idx = i
                streak += 1
                if streak == n_holds:
                    # Estimate time span
                    start_q = tl[streak_start_idx]['per']
                    end_q = t['per']
                    
                    # Rough: count snapshots between start and end
                    snap_count = n_holds
                    # Average ~15-20s per snapshot in this dataset
                    # More precise: count by quarter position
                    est_seconds = snap_count * 18  # ~18s average interval
                    durations.append(est_seconds / 60)
                    break
            else:
                streak = 0
    
    if durations:
        avg = sum(durations)/len(durations)
        print(f"    {n_holds} holds: ~{avg:.1f} min ({len(durations)} games)")

# Compare: checkpoint holds
print(f"\n  For reference at CHECKPOINT level (3-min intervals):")
print(f"    3 checkpoint holds = ~9 min")
print(f"    4 checkpoint holds = ~12 min")
print(f"    5 checkpoint holds = ~15 min")

# ═══════════════════════════════════════════════════════════════════════════════
# 4. FLIP ANALYSIS AT SNAPSHOT LEVEL
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("4. FLIP IMPACT ON SUSTAINED HOLDS (snapshot level)")
print("="*70)

# First fire with 0 flips vs 1+ flips
for mc_th, flr_th in [(0.80, 0.65)]:
    print(f"\n  MC≥{mc_th}+Floor≥{flr_th}:")
    
    for n_holds in [1, 3, 5, 10, 15]:
        zero_flip = {'ok': 0, 'n': 0}
        has_flip = {'ok': 0, 'n': 0}
        
        for g in game_data:
            tl = g['tl']
            streak = 0
            flips_so_far = 0
            prev_ctrl = None
            triggered = False
            
            for i, t in enumerate(tl):
                if prev_ctrl and t['ctrl'] != prev_ctrl:
                    flips_so_far += 1
                    streak = 0  # reset streak on flip
                prev_ctrl = t['ctrl']
                
                mc_ok = t['mc'] is not None and t['mc'] >= mc_th
                flr_ok = t['flr'] is not None and t['flr'] >= flr_th
                
                if mc_ok and flr_ok:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        bucket = zero_flip if flips_so_far == 0 else has_flip
                        bucket['n'] += 1
                        if g['ctrl_won']: bucket['ok'] += 1
                        break
                else:
                    streak = 0
        
        if zero_flip['n'] < 3 and has_flip['n'] < 3: continue
        z_pct = f"{zero_flip['ok']}/{zero_flip['n']}={zero_flip['ok']/zero_flip['n']*100:.0f}%" if zero_flip['n'] else "n/a"
        h_pct = f"{has_flip['ok']}/{has_flip['n']}={has_flip['ok']/has_flip['n']*100:.0f}%" if has_flip['n'] else "n/a"
        print(f"    {n_holds:2d} holds: 0 flips={z_pct}  |  1+ flips={h_pct}")

# How many holds does it take AFTER a flip to recover accuracy?
print(f"\n  === Post-flip recovery: holds needed after flip to restore accuracy ===")
for n_post_flip_holds in [1, 3, 5, 8, 10, 15, 20]:
    ok = 0; tot = 0
    
    for g in game_data:
        tl = g['tl']
        prev_ctrl = None
        last_flip_idx = -1
        streak = 0
        triggered = False
        
        for i, t in enumerate(tl):
            if prev_ctrl and t['ctrl'] != prev_ctrl:
                last_flip_idx = i
                streak = 0
            prev_ctrl = t['ctrl']
            
            # Only count holds AFTER at least one flip
            if last_flip_idx < 0:
                continue
            
            mc_ok = t['mc'] is not None and t['mc'] >= 0.80
            flr_ok = t['flr'] is not None and t['flr'] >= 0.65
            
            if mc_ok and flr_ok:
                streak += 1
                if streak >= n_post_flip_holds and not triggered:
                    triggered = True
                    tot += 1
                    if g['ctrl_won']: ok += 1
                    break
            else:
                streak = 0
    
    if tot >= 3:
        print(f"    {n_post_flip_holds:2d} post-flip holds: {ok}/{tot} = {ok/tot*100:.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# 5. CLOSE GAME ANALYSIS (final margin ≤ 8)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("5. CLOSE PLAYOFF GAMES (final margin ≤ 8) — SUSTAINED HOLDS")
print("="*70)

close_games = [g for g in game_data if g['final_margin'] <= 8]
print(f"  {len(close_games)} close playoff games (margin ≤ 8)")

for mc_th, flr_th in [(0.80, 0.65)]:
    print(f"\n  MC≥{mc_th}+Floor≥{flr_th} in close games:")
    
    for n_holds in [1, 3, 5, 10, 15, 20]:
        ok = 0; tot = 0
        
        for g in close_games:
            tl = g['tl']
            streak = 0
            triggered = False
            
            for t in tl:
                mc_ok = t['mc'] is not None and t['mc'] >= mc_th
                flr_ok = t['flr'] is not None and t['flr'] >= flr_th
                
                if mc_ok and flr_ok:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        tot += 1
                        if g['ctrl_won']: ok += 1
                        break
                else:
                    streak = 0
        
        if tot >= 3:
            print(f"    {n_holds:2d} holds: {ok}/{tot} = {ok/tot*100:.1f}% ({tot}/{len(close_games)} trigger)")

# ═══════════════════════════════════════════════════════════════════════════════
# 6. PER-GAME BREAKDOWN: every game's sustained hold story
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("6. PER-GAME: Max consecutive compound holds + outcome")
print("="*70)

for g in sorted(game_data, key=lambda x: x['label']):
    tl = g['tl']
    max_streak = 0
    streak = 0
    max_streak_q = None
    
    for t in tl:
        mc_ok = t['mc'] is not None and t['mc'] >= 0.80
        flr_ok = t['flr'] is not None and t['flr'] >= 0.65
        
        if mc_ok and flr_ok:
            streak += 1
            if streak > max_streak:
                max_streak = streak
                max_streak_q = t['per']
        else:
            streak = 0
    
    status = "✓" if g['ctrl_won'] else "✗"
    est_min = max_streak * 0.3  # ~18s per snapshot
    print(f"  {status} {g['label'][:45]:45s} | max streak={max_streak:3d} (~{est_min:.0f}min) Q{max_streak_q or '?'} | flips={g['flips']}")

print("\n\nDone.")
