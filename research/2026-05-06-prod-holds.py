#!/usr/bin/env python3
"""
PRODUCTION MC CUM — SUSTAINED HOLD ANALYSIS
48 playoff games, 6,100 snapshots at real poll granularity (~90s intervals)
MC Cum values are production-equivalent (500 sims, cap 0.75, fga>=10 gate)
"""
import json
from collections import defaultdict

with open('/tmp/prod_mc_cum_games.json') as f:
    all_games = json.load(f)

print(f"{len(all_games)} games, {sum(len(g['tl']) for g in all_games)} snapshots\n")

# ═══════════════════════════════════════════════════════════════════════════════
# 1. MC CUM SUSTAINED HOLDS — ALL GAMES
# ═══════════════════════════════════════════════════════════════════════════════

print("="*70)
print("1. MC CUM SUSTAINED HOLDS (production data, poll granularity)")
print("="*70)

for mc_th in [0.70, 0.75, 0.80, 0.85]:
    print(f"\n  MC ≥ {mc_th}:")
    
    for n_holds in [1, 2, 3, 5, 8, 10, 15, 20, 30, 40]:
        ok = 0; tot = 0
        by_q = defaultdict(lambda: {'ok': 0, 'n': 0})
        trigger_indices = []
        
        for g in all_games:
            tl = g['tl']
            streak = 0
            triggered = False
            
            for i, t in enumerate(tl):
                if t['mc'] >= mc_th:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        tot += 1
                        if g['ctrl_won']: ok += 1
                        by_q[t['per']]['n'] += 1
                        if g['ctrl_won']: by_q[t['per']]['ok'] += 1
                        trigger_indices.append(i)
                        break
                else:
                    streak = 0
        
        if tot < 3: continue
        acc = ok/tot*100
        avg_idx = sum(trigger_indices)/len(trigger_indices) if trigger_indices else 0
        # Estimate minutes: avg ~125 snaps over ~36 min of Q2-Q4 = ~0.29 min/snap
        avg_min = avg_idx * 0.29 + 12  # +12 for Q1
        q_parts = []
        for q in sorted(by_q.keys()):
            d = by_q[q]
            if d['n'] >= 2:
                q_parts.append(f"Q{q}={d['ok']}/{d['n']}({d['ok']/d['n']*100:.0f}%)")
        
        print(f"    {n_holds:2d} holds: {ok}/{tot} = {acc:.1f}% | "
              f"{tot}/{len(all_games)} trigger | ~{avg_min:.0f}min | "
              f"{', '.join(q_parts)}")

# ═══════════════════════════════════════════════════════════════════════════════
# 2. COMPOUND SUSTAINED HOLDS (MC + Floor)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("2. COMPOUND SUSTAINED HOLDS (MC + Floor, production data)")
print("="*70)

for mc_th, flr_th in [(0.80, 0.65), (0.85, 0.70), (0.80, 0.60), (0.75, 0.60)]:
    print(f"\n  MC≥{mc_th} + Floor≥{flr_th}:")
    
    for n_holds in [1, 2, 3, 5, 8, 10, 15, 20, 30]:
        ok = 0; tot = 0
        by_q = defaultdict(lambda: {'ok': 0, 'n': 0})
        trigger_indices = []
        
        for g in all_games:
            tl = g['tl']
            streak = 0
            triggered = False
            
            for i, t in enumerate(tl):
                mc_ok = t['mc'] >= mc_th
                flr_ok = t['flr'] is not None and t['flr'] >= flr_th
                
                if mc_ok and flr_ok:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        tot += 1
                        if g['ctrl_won']: ok += 1
                        by_q[t['per']]['n'] += 1
                        if g['ctrl_won']: by_q[t['per']]['ok'] += 1
                        trigger_indices.append(i)
                        break
                else:
                    streak = 0
        
        if tot < 3: continue
        acc = ok/tot*100
        avg_idx = sum(trigger_indices)/len(trigger_indices) if trigger_indices else 0
        avg_min = avg_idx * 0.29 + 12
        q_parts = []
        for q in sorted(by_q.keys()):
            d = by_q[q]
            if d['n'] >= 2:
                q_parts.append(f"Q{q}={d['ok']}/{d['n']}({d['ok']/d['n']*100:.0f}%)")
        
        print(f"    {n_holds:2d} holds: {ok}/{tot} = {acc:.1f}% | "
              f"{tot}/{len(all_games)} trigger | ~{avg_min:.0f}min | "
              f"{', '.join(q_parts)}")

# ═══════════════════════════════════════════════════════════════════════════════
# 3. TIME SPAN OF CONSECUTIVE HOLDS
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("3. TIME SPAN: How many minutes do N consecutive holds take?")
print("="*70)

# Compute actual time spans from clock strings
def clock_to_sec(clock_str):
    if not clock_str: return 0
    parts = clock_str.strip().split(' ')[-1]
    try:
        m, s = parts.split(':')
        return int(m) * 60 + int(s)
    except: return 0

def game_sec(period, clock_str):
    csec = clock_to_sec(clock_str)
    return (period - 1) * 720 + (720 - csec)

for mc_th, flr_th, label in [(0.80, 0.65, "MC≥0.80+Floor≥0.65"), (0.80, None, "MC≥0.80 only")]:
    print(f"\n  {label}:")
    
    for n_holds in [3, 5, 8, 10, 15, 20, 30]:
        durations_sec = []
        
        for g in all_games:
            tl = g['tl']
            streak = 0
            start_idx = None
            
            for i, t in enumerate(tl):
                mc_ok = t['mc'] >= mc_th
                flr_ok = True if flr_th is None else (t['flr'] is not None and t['flr'] >= flr_th)
                
                if mc_ok and flr_ok:
                    if streak == 0: start_idx = i
                    streak += 1
                    if streak == n_holds:
                        # Compute actual time span
                        start_gs = game_sec(tl[start_idx]['per'], tl[start_idx]['clock'])
                        end_gs = game_sec(t['per'], t['clock'])
                        dur = end_gs - start_gs
                        if dur >= 0:
                            durations_sec.append(dur)
                        break
                else:
                    streak = 0
        
        if durations_sec:
            avg_min = sum(durations_sec) / len(durations_sec) / 60
            med_min = sorted(durations_sec)[len(durations_sec)//2] / 60
            print(f"    {n_holds:2d} holds: avg={avg_min:.1f}min, median={med_min:.1f}min ({len(durations_sec)} games)")

# ═══════════════════════════════════════════════════════════════════════════════
# 4. FLIP ANALYSIS (production data)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("4. FLIP IMPACT ON SUSTAINED HOLDS (production data)")
print("="*70)

print("\n  MC≥0.80+Floor≥0.65 — zero flips vs 1+ flips at first fire:")
for n_holds in [1, 3, 5, 10, 15, 20]:
    zf = {'ok': 0, 'n': 0}
    hf = {'ok': 0, 'n': 0}
    
    for g in all_games:
        tl = g['tl']
        streak = 0
        flips = 0
        prev = None
        triggered = False
        
        for t in tl:
            if prev and t['ctrl'] != prev and t['ctrl'] and prev:
                flips += 1
                streak = 0
            if t['ctrl']: prev = t['ctrl']
            
            if t['mc'] >= 0.80 and t['flr'] is not None and t['flr'] >= 0.65:
                streak += 1
                if streak >= n_holds and not triggered:
                    triggered = True
                    bucket = zf if flips == 0 else hf
                    bucket['n'] += 1
                    if g['ctrl_won']: bucket['ok'] += 1
                    break
            else:
                streak = 0
    
    zf_s = f"{zf['ok']}/{zf['n']}={zf['ok']/zf['n']*100:.0f}%" if zf['n'] else "n/a"
    hf_s = f"{hf['ok']}/{hf['n']}={hf['ok']/hf['n']*100:.0f}%" if hf['n'] else "n/a"
    print(f"    {n_holds:2d} holds: 0 flips={zf_s}  |  1+ flips={hf_s}")

print("\n  Post-flip recovery (holds needed after last flip):")
for n_holds in [1, 3, 5, 8, 10, 15, 20, 30]:
    ok = 0; tot = 0
    
    for g in all_games:
        tl = g['tl']
        prev = None
        last_flip_idx = -1
        streak = 0
        triggered = False
        
        for i, t in enumerate(tl):
            if prev and t['ctrl'] != prev and t['ctrl'] and prev:
                last_flip_idx = i
                streak = 0
            if t['ctrl']: prev = t['ctrl']
            
            if last_flip_idx < 0: continue
            
            if t['mc'] >= 0.80 and t['flr'] is not None and t['flr'] >= 0.65:
                streak += 1
                if streak >= n_holds and not triggered:
                    triggered = True
                    tot += 1
                    if g['ctrl_won']: ok += 1
                    break
            else:
                streak = 0
    
    if tot >= 3:
        print(f"    {n_holds:2d} post-flip holds: {ok}/{tot} = {ok/tot*100:.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# 5. CLOSE GAMES (final margin ≤ 8)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("5. CLOSE GAMES (margin ≤ 8) — SUSTAINED HOLDS")
print("="*70)

close = [g for g in all_games if g['final_margin'] <= 8]
print(f"  {len(close)} close playoff games")

for mc_th, flr_th, label in [(0.80, 0.65, "MC≥0.80+Floor≥0.65"), (0.75, 0.60, "MC≥0.75+Floor≥0.60")]:
    print(f"\n  {label} in close games:")
    for n_holds in [1, 3, 5, 10, 15, 20]:
        ok = 0; tot = 0
        
        for g in close:
            tl = g['tl']
            streak = 0
            triggered = False
            
            for t in tl:
                if t['mc'] >= mc_th and t['flr'] is not None and t['flr'] >= flr_th:
                    streak += 1
                    if streak >= n_holds and not triggered:
                        triggered = True
                        tot += 1
                        if g['ctrl_won']: ok += 1
                        break
                else:
                    streak = 0
        
        if tot >= 3:
            print(f"    {n_holds:2d} holds: {ok}/{tot} = {ok/tot*100:.1f}% ({tot}/{len(close)} trigger)")

# ═══════════════════════════════════════════════════════════════════════════════
# 6. FIRST FIRE BY QUARTER + SECOND/THIRD FIRES
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("6. Nth COMPOUND FIRE BY QUARTER (production data)")
print("="*70)

for mc_th, flr_th in [(0.80, 0.65)]:
    print(f"\n  MC≥{mc_th}+Floor≥{flr_th}, 5 consecutive holds required:")
    
    fires_by_n = defaultdict(lambda: defaultdict(lambda: {'ok': 0, 'n': 0}))
    
    for g in all_games:
        tl = g['tl']
        fire_count = 0
        streak = 0
        
        for t in tl:
            if t['mc'] >= mc_th and t['flr'] is not None and t['flr'] >= flr_th:
                streak += 1
                if streak == 5:  # every 5th consecutive hold = one "fire"
                    fire_count += 1
                    fn = min(fire_count, 5)
                    fires_by_n[fn][t['per']]['n'] += 1
                    if g['ctrl_won']: fires_by_n[fn][t['per']]['ok'] += 1
                    fires_by_n[fn]['all']['n'] += 1
                    if g['ctrl_won']: fires_by_n[fn]['all']['ok'] += 1
                    streak = 0  # reset for next fire
            else:
                streak = 0
    
    for fn in sorted(fires_by_n.keys()):
        lbl = f"{fn}st" if fn == 1 else f"{fn}nd" if fn == 2 else f"{fn}rd" if fn == 3 else f"{fn}th+"
        parts = []
        for q in ['all', 2, 3, 4]:
            d = fires_by_n[fn].get(q, {'ok': 0, 'n': 0})
            if d['n'] >= 2:
                ql = f"Q{q}" if isinstance(q, int) else "ALL"
                parts.append(f"{ql}={d['ok']}/{d['n']}({d['ok']/d['n']*100:.0f}%)")
        if parts:
            print(f"    {lbl:>4} fire: {', '.join(parts)}")

# ═══════════════════════════════════════════════════════════════════════════════
# 7. Q3 COMPOUND BY MARGIN
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("7. Q3+ COMPOUND BY CTRL MARGIN (production data, 5+ holds)")
print("="*70)

# Per-checkpoint accuracy (not first-fire, all qualifying checkpoints)
for q in [2, 3, 4]:
    compound = []
    for g in all_games:
        # Find checkpoints where 5+ consecutive compound holds have been achieved
        streak = 0
        for t in g['tl']:
            if t['per'] != q: 
                if t['per'] > q: break
                if t['mc'] >= 0.80 and t['flr'] is not None and t['flr'] >= 0.65:
                    streak += 1
                else:
                    streak = 0
                continue
            if t['mc'] >= 0.80 and t['flr'] is not None and t['flr'] >= 0.65:
                streak += 1
                if streak >= 5:
                    compound.append({'mar': t['mar'], 'won': g['ctrl_won']})
            else:
                streak = 0
    
    if not compound: continue
    w = sum(1 for c in compound if c['won'])
    print(f"\n  Q{q} (compound held 5+ polls, all checkpoints): {w}/{len(compound)} = {w/len(compound)*100:.1f}%")
    
    for label, fn in [
        ("trailing", lambda c: c['mar'] < 0),
        ("tied/+1", lambda c: 0 <= c['mar'] <= 1),
        ("lead 2-5", lambda c: 2 <= c['mar'] <= 5),
        ("lead 6-10", lambda c: 6 <= c['mar'] <= 10),
        ("lead 11-15", lambda c: 11 <= c['mar'] <= 15),
        ("lead 16+", lambda c: c['mar'] >= 16),
    ]:
        sub = [c for c in compound if fn(c)]
        if sub:
            ws = sum(1 for c in sub if c['won'])
            print(f"    {label}: {ws}/{len(sub)} = {ws/len(sub)*100:.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# 8. PER-GAME VIEW
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("8. PER-GAME: Max consecutive compound holds (MC≥0.80+Floor≥0.65)")
print("="*70)

for g in sorted(all_games, key=lambda x: x['label']):
    tl = g['tl']
    max_streak = 0; streak = 0; max_q = None
    
    for t in tl:
        if t['mc'] >= 0.80 and t['flr'] is not None and t['flr'] >= 0.65:
            streak += 1
            if streak > max_streak:
                max_streak = streak
                max_q = t['per']
        else:
            streak = 0
    
    # Compute actual time for max streak
    # Find the actual start/end of the longest streak
    best_start = best_end = 0
    streak = 0; start = 0
    for i, t in enumerate(tl):
        if t['mc'] >= 0.80 and t['flr'] is not None and t['flr'] >= 0.65:
            if streak == 0: start = i
            streak += 1
            if streak > best_end - best_start:
                best_start = start; best_end = start + streak
        else:
            streak = 0
    
    dur_min = 0
    if best_end > best_start and best_start < len(tl) and best_end - 1 < len(tl):
        s_gs = game_sec(tl[best_start]['per'], tl[best_start]['clock'])
        e_gs = game_sec(tl[best_end-1]['per'], tl[best_end-1]['clock'])
        dur_min = (e_gs - s_gs) / 60
    
    status = "✓" if g['ctrl_won'] else "✗"
    print(f"  {status} {g['label'][:45]:45s} | streak={max_streak:3d} ({dur_min:.1f}min) Q{max_q or '?'} | flips={g['flips']}")

def game_sec(period, clock_str):
    csec = 0
    if clock_str:
        parts = clock_str.strip().split(' ')[-1]
        try:
            m, s = parts.split(':')
            csec = int(m) * 60 + int(s)
        except: pass
    return (period - 1) * 720 + (720 - csec)

print("\n\nDone.")
