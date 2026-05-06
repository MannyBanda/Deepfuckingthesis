#!/usr/bin/env python3
"""
BLIND SPOT ANALYSIS: Questions we should be asking.
"""

import json
import random
from collections import defaultdict

random.seed(42)

with open('/tmp/raw_backtest.json') as f:
    raw_rows = json.load(f)

# ─── MC FUNCTIONS (same as before) ───────────────────────────────────────────

def sim_poss(r):
    if random.random()<r['toRate']: return 0
    p=0;im=False
    if random.random()<r['fg3aShare']:
        im=random.random()<r['fg3Pct']
        if im: p=3
    else:
        im=random.random()<r['fg2Pct']
        if im: p=2
    if not im and random.random()<r['orebRate']:
        if random.random()<r['fg2Pct']: p=2
    if random.random()<r['ftaRate']/2:
        if random.random()<r['ftPct']: p+=1
        if random.random()<r['ftPct']: p+=1
    return p

def run_mc(hr,ar,hs,as_,rp,sc=300,cih=True):
    cw=0
    for _ in range(sc):
        h,a=hs,as_;hp,ap=round(rp),round(rp);hb=random.random()<0.5
        while hp>0 or ap>0:
            if hb:
                if hp>0: h+=sim_poss(hr);hp-=1
            else:
                if ap>0: a+=sim_poss(ar);ap-=1
            hb=not hb
        f=(h-a) if cih else (a-h)
        cw+=1 if f>0 else (0.5 if f==0 else 0)
    return round(cw/sc,3)

def to_rates(s):
    fga=int(s.get('fga',0))or 1;fgm=int(s.get('fgm',0));fg3a=int(s.get('fg3a',0))
    fg3m=int(s.get('fg3m',0));fta=int(s.get('fta',0));ftm=int(s.get('ftm',0))
    to=int(s.get('to',0));oreb=int(s.get('oreb',0))
    po=fga+0.44*fta-oreb+to
    if po<3:po=max(fga,3)
    f2a=fga-fg3a;f2m=fgm-fg3m
    if fga<3:return None
    rf=fg3m/fg3a if fg3a>0 else 0.36;sw=min(0.60,fg3a/30);f3p=rf*sw+0.36*(1-sw)
    cl=lambda v:max(0,min(1,v))
    return{'toRate':cl(to/po if po>0 else 0.12),'fg3aShare':cl(fg3a/fga if fga>0 else 0.35),
           'fg3Pct':cl(f3p),'fg2Pct':cl(f2m/f2a if f2a>0 else 0.50),
           'orebRate':cl(oreb/(fga-fgm) if(fga-fgm)>0 else 0.25),
           'ftaRate':min(fta/po if po>0 else 0.20,1.0),'ftPct':cl(ftm/fta if fta>0 else 0.76)}

def est_rem(hs,as_,p,cs):
    def ep(s):return int(s.get('fga',0))+0.44*int(s.get('fta',0))-int(s.get('oreb',0))+int(s.get('to',0))
    av=(ep(hs)+ep(as_))/2;el=(min(p,4)-1)*12+(12-cs/60)
    if el<1:el=1
    return max(0,round(av/el*max(0,48-el)))

print("Building game data...")
games = defaultdict(list)
for row in raw_rows:
    p=row['period']
    if p<1: continue  # include Q1 for trajectory
    ts=row.get('team_stats',{})
    if not ts or 'home' not in ts: continue
    ind=row.get('ind',{})
    if isinstance(ind,str): ind=json.loads(ind)
    ctrl=ind.get('controlTeam','')
    if not ctrl: continue
    hA=row['home_alias'];aA=row['away_alias']
    cih=ctrl==hA;csec=row.get('clock_sec',0) or 0
    
    mc=None
    if p>=2:
        rp=est_rem(ts['home'],ts['away'],p,csec)
        if rp>=1:
            hr=to_rates(ts['home']);ar=to_rates(ts['away'])
            if hr and ar:
                mc=run_mc(hr,ar,int(ts['home'].get('pts',0)),int(ts['away'].get('pts',0)),rp,300,cih)
    
    raw_margin=row.get('margin',0) or 0
    ctrl_margin=raw_margin*(1 if cih else -1)
    
    games[row['game_id']].append({
        'cp':row['checkpoint'],'period':p,'clock_sec':csec,
        'floor':ind.get('score',0),'mc':mc,'ctrl':ctrl,
        'ctrl_margin':ctrl_margin,'won':row.get('ctrl_won'),
        'hA':hA,'aA':aA,
    })

for gid in games:
    games[gid].sort(key=lambda x:(x['period'],-x['clock_sec']))

print(f"  {len(games)} games")

# ═══════════════════════════════════════════════════════════════════════════════
# BLIND SPOT 1: BLOWOUT CONTAMINATION
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLIND SPOT 1: BLOWOUT CONTAMINATION")
print("="*70)
print("Strip blowouts, measure ACTIONABLE accuracy only")

for q in [3, 4]:
    print(f"\n  Q{q} MC≥0.80+Floor≥0.65:")
    all_cps = []
    for gid, cps in games.items():
        for c in cps:
            if c['period']==q and c['mc'] is not None and c['won'] is not None:
                if c['mc']>=0.80 and c['floor']>=0.65:
                    all_cps.append(c)
    
    w_all = sum(1 for c in all_cps if c['won'])
    print(f"    ALL: {w_all}/{len(all_cps)} = {w_all/len(all_cps)*100:.1f}%")
    
    # Actionable = margin ≤ 10 (market still playable)
    act = [c for c in all_cps if abs(c['ctrl_margin']) <= 10]
    if act:
        w = sum(1 for c in act if c['won'])
        print(f"    Actionable (|margin|≤10): {w}/{len(act)} = {w/len(act)*100:.1f}% ({len(act)} cps)")
    
    # Close = margin ≤ 8
    close = [c for c in all_cps if abs(c['ctrl_margin']) <= 8]
    if close:
        w = sum(1 for c in close if c['won'])
        print(f"    Close (|margin|≤8): {w}/{len(close)} = {w/len(close)*100:.1f}% ({len(close)} cps)")
    
    # Tight = margin ≤ 5
    tight = [c for c in all_cps if abs(c['ctrl_margin']) <= 5]
    if tight:
        w = sum(1 for c in tight if c['won'])
        print(f"    Tight (|margin|≤5): {w}/{len(tight)} = {w/len(tight)*100:.1f}% ({len(tight)} cps)")
    
    # For comparison: what does S-rank graduation look like in close games?
    # (approximate S-rank as: no flips, 8+ readings, all above 0.58)
    
    # And: MC≥0.90+Floor≥0.70 in close games
    act90 = [c for c in all_cps if abs(c['ctrl_margin'])<=10 and c['mc']>=0.90 and c['floor']>=0.70]
    if act90:
        w = sum(1 for c in act90 if c['won'])
        print(f"    Actionable + MC≥0.90+Floor≥0.70: {w}/{len(act90)} = {w/len(act90)*100:.1f}% ({len(act90)} cps)")

# Game-level: strip blowout games entirely
print("\n  Game-level (filter to close games — final margin ≤ 10):")
for q_min in [2, 3]:
    label = "Q2+" if q_min == 2 else "Q3+"
    ok = 0; tot = 0; ok_close = 0; tot_close = 0
    for gid, cps in games.items():
        won = cps[0]['won']
        if won is None: continue
        fmar = cps[0].get('ctrl_margin', 0)  # not final margin, need to get it
        # Use last checkpoint margin as proxy for game closeness
        last_q4 = [c for c in cps if c['period'] == 4]
        if not last_q4: continue
        last_margin = abs(last_q4[-1]['ctrl_margin'])
        
        for c in cps:
            if c['period'] >= q_min and c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
                tot += 1
                if won: ok += 1
                if last_margin <= 10:
                    tot_close += 1
                    if won: ok_close += 1
                break
    
    if tot:
        print(f"    {label} compound: ALL={ok}/{tot} ({ok/tot*100:.1f}%), "
              f"Close games={ok_close}/{tot_close} ({ok_close/tot_close*100:.1f}%)" if tot_close else "")

# ═══════════════════════════════════════════════════════════════════════════════
# BLIND SPOT 2: EXIT SYMMETRY
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLIND SPOT 2: EXIT — Does compound work for position monitoring?")
print("="*70)

# After position opens (compound met), track what happens:
# - Does compound STAY above threshold? → HOLD
# - Does compound DROP below threshold? → potential EXIT
# - What MC level predicts actual loss?

print("\n  Post-confirmation trajectory analysis:")
print("  (After first compound checkpoint, track subsequent readings)")

for q_trigger in [3]:
    decline_outcomes = defaultdict(lambda: {'ok': 0, 'n': 0})
    hold_outcomes = defaultdict(lambda: {'ok': 0, 'n': 0})
    
    for gid, cps in games.items():
        won = cps[0]['won']
        if won is None: continue
        
        # Find first compound trigger
        trigger_idx = None
        for i, c in enumerate(cps):
            if c['period'] >= q_trigger and c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
                trigger_idx = i
                break
        
        if trigger_idx is None: continue
        
        # Track subsequent checkpoints
        min_mc_after = 1.0
        min_floor_after = 1.0
        for j in range(trigger_idx + 1, len(cps)):
            c = cps[j]
            if c['mc'] is None: continue
            min_mc_after = min(min_mc_after, c['mc'])
            min_floor_after = min(min_floor_after, c['floor'])
        
        # Bucket by lowest MC after trigger
        if min_mc_after >= 0.80:
            bucket = 'MC stayed ≥0.80'
        elif min_mc_after >= 0.70:
            bucket = 'MC dipped to 0.70-0.80'
        elif min_mc_after >= 0.60:
            bucket = 'MC dipped to 0.60-0.70'
        elif min_mc_after >= 0.50:
            bucket = 'MC dipped to 0.50-0.60'
        else:
            bucket = 'MC collapsed <0.50'
        
        decline_outcomes[bucket]['n'] += 1
        if won: decline_outcomes[bucket]['ok'] += 1
    
    print(f"\n  Q{q_trigger}+ trigger, then track lowest MC after:")
    for bucket in ['MC stayed ≥0.80', 'MC dipped to 0.70-0.80', 'MC dipped to 0.60-0.70',
                    'MC dipped to 0.50-0.60', 'MC collapsed <0.50']:
        d = decline_outcomes.get(bucket, {'ok': 0, 'n': 0})
        if d['n']:
            print(f"    {bucket}: {d['ok']}/{d['n']} = {d['ok']/d['n']*100:.1f}%")

# EXIT threshold analysis
print("\n  What MC EXIT threshold catches losses without killing wins?")
for q_trigger in [3]:
    for exit_th in [0.40, 0.45, 0.50, 0.55, 0.60]:
        correct_exits = 0  # MC dropped, team lost (good exit)
        premature_exits = 0  # MC dropped, team won (bad exit)
        held_and_won = 0  # MC stayed, team won
        left_hanging = 0  # MC stayed, team lost
        
        for gid, cps in games.items():
            won = cps[0]['won']
            if won is None: continue
            
            trigger_idx = None
            for i, c in enumerate(cps):
                if c['period'] >= q_trigger and c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
                    trigger_idx = i
                    break
            if trigger_idx is None: continue
            
            # Did MC drop below exit_th after trigger?
            mc_dropped = False
            for j in range(trigger_idx + 1, len(cps)):
                if cps[j]['mc'] is not None and cps[j]['mc'] < exit_th:
                    mc_dropped = True
                    break
            
            if mc_dropped:
                if not won: correct_exits += 1
                else: premature_exits += 1
            else:
                if won: held_and_won += 1
                else: left_hanging += 1
        
        total = correct_exits + premature_exits + held_and_won + left_hanging
        exit_acc = correct_exits / (correct_exits + premature_exits) * 100 if (correct_exits + premature_exits) > 0 else 0
        print(f"    EXIT<{exit_th}: fires={correct_exits+premature_exits}, "
              f"exit_acc={exit_acc:.1f}%, "
              f"premature={premature_exits}, left_hanging={left_hanging}, "
              f"total_damage={premature_exits+left_hanging}")

# ═══════════════════════════════════════════════════════════════════════════════
# BLIND SPOT 3: TRIGGER TIMING — WHEN DO POSITIONS OPEN?
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLIND SPOT 3: WHEN DO POSITIONS OPEN?")
print("="*70)

# For each system, track the checkpoint where PO fires
trigger_timing = defaultdict(list)

for gid, cps in games.items():
    won = cps[0]['won']
    if won is None: continue
    
    # System 1: Current graduation (approximate)
    floor_readings = []; flips = 0; prev_ctrl = None
    for c in cps:
        if c['period'] < 2: continue
        if prev_ctrl and c['ctrl'] != prev_ctrl:
            flips += 1; floor_readings = []
        prev_ctrl = c['ctrl']
        floor_readings.append(c['floor'])
        mf = sum(floor_readings) / len(floor_readings)
        if len(floor_readings) >= 4 and mf >= 0.65:
            trigger_timing['grad'].append({'period': c['period'], 'clk': c['clock_sec'], 'won': won,
                                           'margin': c['ctrl_margin']})
            break
    
    # System 2: Q3+ compound
    for c in cps:
        if c['period'] >= 3 and c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
            trigger_timing['q3_compound'].append({'period': c['period'], 'clk': c['clock_sec'], 'won': won,
                                                   'margin': c['ctrl_margin']})
            break
    
    # System 3: Q2 high + Q3 standard
    triggered = False
    q2 = [c for c in cps if c['period'] == 2]
    streak = 0
    for c in q2:
        if c['mc'] is not None and c['mc'] >= 0.85 and c['floor'] >= 0.70 and c['ctrl_margin'] >= 5:
            streak += 1
            if streak >= 3:
                trigger_timing['q2high_q3std'].append({'period': 2, 'clk': c['clock_sec'], 'won': won,
                                                        'margin': c['ctrl_margin']})
                triggered = True
                break
        else:
            streak = 0
    if not triggered:
        for c in cps:
            if c['period'] >= 3 and c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
                trigger_timing['q2high_q3std'].append({'period': c['period'], 'clk': c['clock_sec'], 'won': won,
                                                        'margin': c['ctrl_margin']})
                break

for name in ['grad', 'q3_compound', 'q2high_q3std']:
    data = trigger_timing[name]
    if not data: continue
    
    by_q = defaultdict(int)
    for d in data: by_q[d['period']] += 1
    
    avg_margin = sum(d['margin'] for d in data) / len(data)
    
    # "Minutes into game" for each trigger
    mins = []
    for d in data:
        game_min = (d['period'] - 1) * 12 + (12 - d['clk'] / 60) if d['clk'] else d['period'] * 12
        mins.append(game_min)
    mins.sort()
    
    w = sum(1 for d in data if d['won'])
    
    print(f"\n  {name}: {len(data)} triggers, {w/len(data)*100:.1f}% accuracy")
    print(f"    By quarter: {dict(sorted(by_q.items()))}")
    print(f"    Avg trigger time: {sum(mins)/len(mins):.1f} min into game")
    print(f"    p25/p50/p75 trigger: {mins[len(mins)//4]:.1f} / {mins[len(mins)//2]:.1f} / {mins[3*len(mins)//4]:.1f} min")
    print(f"    Avg margin at trigger: {avg_margin:.1f}")

    # Early triggers (Q2-early Q3) vs late triggers
    early = [d for d in data if d['period'] <= 2 or (d['period'] == 3 and d.get('clk', 0) >= 360)]
    late = [d for d in data if d['period'] >= 4 or (d['period'] == 3 and d.get('clk', 0) < 360)]
    if early:
        we = sum(1 for d in early if d['won'])
        print(f"    Early (≤Q3 6min): {we}/{len(early)} = {we/len(early)*100:.1f}%")
    if late:
        wl = sum(1 for d in late if d['won'])
        print(f"    Late (Q3 6min+): {wl}/{len(late)} = {wl/len(late)*100:.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# BLIND SPOT 4: NEVER-TRIGGERED GAMES
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLIND SPOT 4: NEVER-TRIGGERED GAMES")
print("="*70)

never_triggered = []
for gid, cps in games.items():
    won = cps[0]['won']
    if won is None: continue
    
    triggered = False
    for c in cps:
        if c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
            triggered = True
            break
    
    if not triggered:
        # Characterize the game
        max_mc = max((c['mc'] for c in cps if c['mc'] is not None), default=0)
        max_floor = max(c['floor'] for c in cps)
        max_margin = max(c['ctrl_margin'] for c in cps)
        min_margin = min(c['ctrl_margin'] for c in cps)
        flips = 0
        prev = None
        for c in cps:
            if prev and c['ctrl'] != prev: flips += 1
            prev = c['ctrl']
        
        never_triggered.append({
            'gid': gid, 'won': won, 'max_mc': max_mc, 'max_floor': max_floor,
            'max_margin': max_margin, 'min_margin': min_margin, 'flips': flips,
        })

print(f"  {len(never_triggered)} games never trigger MC≥0.80+Floor≥0.65")
if never_triggered:
    winners = [g for g in never_triggered if g['won']]
    losers = [g for g in never_triggered if not g['won']]
    print(f"  Winners: {len(winners)}, Losers: {len(losers)}")
    
    if winners:
        print(f"\n  Winners we MISS ({len(winners)} games):")
        print(f"    Avg max MC: {sum(g['max_mc'] for g in winners)/len(winners):.3f}")
        print(f"    Avg max floor: {sum(g['max_floor'] for g in winners)/len(winners):.3f}")
        print(f"    Avg flips: {sum(g['flips'] for g in winners)/len(winners):.1f}")
        # How close did they get?
        close_misses = [g for g in winners if g['max_mc'] >= 0.70 and g['max_floor'] >= 0.55]
        print(f"    Close misses (MC≥0.70+Floor≥0.55): {len(close_misses)}")
        far_misses = [g for g in winners if g['max_mc'] < 0.60 or g['max_floor'] < 0.45]
        print(f"    Far misses (MC<0.60 or Floor<0.45): {len(far_misses)}")
    
    if losers:
        print(f"\n  Correctly AVOIDED losers ({len(losers)} games):")
        print(f"    Avg max MC: {sum(g['max_mc'] for g in losers)/len(losers):.3f}")
        print(f"    Avg max floor: {sum(g['max_floor'] for g in losers)/len(losers):.3f}")
        print(f"    Avg flips: {sum(g['flips'] for g in losers)/len(losers):.1f}")

    # What % of CTRL team wins does the compound miss?
    total_ctrl_wins = sum(1 for gid, cps in games.items() if cps[0].get('won'))
    print(f"\n  Coverage: compound triggers for {total_ctrl_wins - len(winners)}/{total_ctrl_wins} ctrl wins "
          f"({(total_ctrl_wins - len(winners))/total_ctrl_wins*100:.1f}%)")

# ═══════════════════════════════════════════════════════════════════════════════
# BLIND SPOT 5: MC CUM FAILURE ANATOMY
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLIND SPOT 5: MC CUM CONFIDENT-BUT-WRONG — FAILURE ANATOMY")
print("="*70)

# Games where MC≥0.80+Floor≥0.65 at some Q4 checkpoint but ctrl LOST
q4_losses = []
for gid, cps in games.items():
    won = cps[0]['won']
    if won is None or won: continue
    
    q4 = [c for c in cps if c['period'] == 4 and c['mc'] is not None]
    compound_q4 = [c for c in q4 if c['mc'] >= 0.80 and c['floor'] >= 0.65]
    
    if compound_q4:
        # Track MC trajectory across the game
        mc_trajectory = [(c['period'], c['clock_sec'], c['mc'], c['floor'], c['ctrl_margin']) 
                         for c in cps if c['mc'] is not None]
        
        peak_mc = max(c['mc'] for c in cps if c['mc'] is not None)
        min_mc_q4 = min(c['mc'] for c in q4) if q4 else None
        peak_margin = max(c['ctrl_margin'] for c in cps)
        last_margin = cps[-1]['ctrl_margin']
        
        # Did MC ever drop below 0.60 after being at 0.80+?
        hit_80 = False
        dropped_after = False
        for c in cps:
            if c['mc'] is not None:
                if c['mc'] >= 0.80: hit_80 = True
                if hit_80 and c['mc'] < 0.60: dropped_after = True
        
        q4_losses.append({
            'gid': gid,
            'peak_mc': peak_mc,
            'min_mc_q4': min_mc_q4,
            'peak_margin': peak_margin,
            'last_margin': last_margin,
            'dropped_after': dropped_after,
            'trajectory': mc_trajectory,
            'n_compound_q4': len(compound_q4),
        })

print(f"  {len(q4_losses)} games where compound held in Q4 but ctrl lost")
if q4_losses:
    print(f"  Peak MC avg: {sum(g['peak_mc'] for g in q4_losses)/len(q4_losses):.3f}")
    print(f"  Peak margin avg: {sum(g['peak_margin'] for g in q4_losses)/len(q4_losses):.1f}")
    print(f"  Last margin avg: {sum(g['last_margin'] for g in q4_losses)/len(q4_losses):.1f}")
    
    dropped = [g for g in q4_losses if g['dropped_after']]
    print(f"\n  MC dropped below 0.60 after being at 0.80+: {len(dropped)}/{len(q4_losses)} ({len(dropped)/len(q4_losses)*100:.1f}%)")
    never_dropped = [g for g in q4_losses if not g['dropped_after']]
    print(f"  MC NEVER dropped below 0.60 (stayed confident): {len(never_dropped)}/{len(q4_losses)} ({len(never_dropped)/len(q4_losses)*100:.1f}%)")
    
    if never_dropped:
        print(f"\n  The 'blind' losses (MC stayed ≥0.60 throughout):")
        print(f"    These are blowout reversals MC Cum fundamentally cannot see")
        print(f"    Peak margin: {sum(g['peak_margin'] for g in never_dropped)/len(never_dropped):.1f}")
        print(f"    Last margin: {sum(g['last_margin'] for g in never_dropped)/len(never_dropped):.1f}")
    
    # How many had min_mc_q4 < various thresholds?
    print(f"\n  Minimum MC in Q4 for these losses:")
    for th in [0.80, 0.70, 0.60, 0.50]:
        below = [g for g in q4_losses if g['min_mc_q4'] is not None and g['min_mc_q4'] < th]
        print(f"    Dropped below {th}: {len(below)}/{len(q4_losses)}")

    # Print a few trajectories
    print(f"\n  Sample loss trajectories (first 5):")
    for g in q4_losses[:5]:
        traj_str = " → ".join([f"Q{t[0]}({t[2]:.2f}|m{t[4]:+.0f})" for t in g['trajectory'][-6:]])
        print(f"    gid={g['gid']}: peak_m={g['peak_margin']:+.0f}, last_m={g['last_margin']:+.0f}, "
              f"dropped={g['dropped_after']}")
        print(f"      {traj_str}")

# ═══════════════════════════════════════════════════════════════════════════════
# BLIND SPOT 6: HOLD DIRECTION — DOES TRAJECTORY WITHIN WINDOW MATTER?
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLIND SPOT 6: HOLD DIRECTION — Rising vs Declining")
print("="*70)

for q in [3, 4]:
    rising = {'ok': 0, 'n': 0}
    flat = {'ok': 0, 'n': 0}
    declining = {'ok': 0, 'n': 0}
    
    for gid, cps in games.items():
        won = cps[0]['won']
        if won is None: continue
        
        qcps = [c for c in cps if c['period'] == q and c['mc'] is not None]
        if len(qcps) < 3: continue
        
        # Look at 3-checkpoint windows where all are above compound threshold
        for i in range(2, len(qcps)):
            c0, c1, c2 = qcps[i-2], qcps[i-1], qcps[i]
            
            if all(c['mc'] >= 0.80 and c['floor'] >= 0.65 for c in [c0, c1, c2]):
                mc_trend = c2['mc'] - c0['mc']
                
                if mc_trend > 0.05:
                    rising['n'] += 1
                    if won: rising['ok'] += 1
                elif mc_trend < -0.05:
                    declining['n'] += 1
                    if won: declining['ok'] += 1
                else:
                    flat['n'] += 1
                    if won: flat['ok'] += 1
    
    print(f"\n  Q{q} — 3 consecutive compound holds, MC trend:")
    for label, data in [('Rising (+5pp+)', rising), ('Flat (±5pp)', flat), ('Declining (-5pp+)', declining)]:
        if data['n']:
            print(f"    {label}: {data['ok']}/{data['n']} = {data['ok']/data['n']*100:.1f}%")

# Also test: what about floor trend while MC holds?
print("\n  Floor trend while MC holds ≥0.80:")
for q in [3, 4]:
    floor_rising = {'ok': 0, 'n': 0}
    floor_declining = {'ok': 0, 'n': 0}
    
    for gid, cps in games.items():
        won = cps[0]['won']
        if won is None: continue
        
        qcps = [c for c in cps if c['period'] == q and c['mc'] is not None]
        if len(qcps) < 3: continue
        
        for i in range(2, len(qcps)):
            c0, c1, c2 = qcps[i-2], qcps[i-1], qcps[i]
            if all(c['mc'] >= 0.80 for c in [c0, c1, c2]):
                floor_trend = c2['floor'] - c0['floor']
                if floor_trend > 0.05:
                    floor_rising['n'] += 1
                    if won: floor_rising['ok'] += 1
                elif floor_trend < -0.05:
                    floor_declining['n'] += 1
                    if won: floor_declining['ok'] += 1
    
    print(f"\n  Q{q}:")
    if floor_rising['n']:
        print(f"    Floor rising: {floor_rising['ok']}/{floor_rising['n']} = {floor_rising['ok']/floor_rising['n']*100:.1f}%")
    if floor_declining['n']:
        print(f"    Floor declining: {floor_declining['ok']}/{floor_declining['n']} = {floor_declining['ok']/floor_declining['n']*100:.1f}%")

# ═══════════════════════════════════════════════════════════════════════════════
# BONUS: COMPOUND-ONLY SYSTEM — NO GRADUATION, NO CHECKPOINTS, JUST THRESHOLDS
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BONUS: PURE THRESHOLD SYSTEM — What if we just trust the signals?")
print("="*70)

# At each checkpoint, independently classify:
# STRONG: MC≥0.80+Floor≥0.65 → HOLD/OPEN
# MODERATE: MC≥0.65+Floor≥0.55 → WATCH
# WEAK: MC<0.50 or Floor<0.40 → EXIT/AVOID
# 
# No history, no tracking, just current state.

print("\n  Per-checkpoint classification accuracy:")
for q in [2, 3, 4]:
    states = defaultdict(lambda: {'ok': 0, 'n': 0})
    for gid, cps in games.items():
        for c in cps:
            if c['period'] != q or c['mc'] is None or c['won'] is None: continue
            
            if c['mc'] >= 0.80 and c['floor'] >= 0.65:
                state = 'STRONG'
            elif c['mc'] >= 0.65 and c['floor'] >= 0.55:
                state = 'MODERATE'
            elif c['mc'] >= 0.50 and c['floor'] >= 0.40:
                state = 'NEUTRAL'
            else:
                state = 'WEAK'
            
            states[state]['n'] += 1
            if c['won']: states[state]['ok'] += 1
    
    print(f"\n  Q{q}:")
    for state in ['STRONG', 'MODERATE', 'NEUTRAL', 'WEAK']:
        d = states.get(state, {'ok': 0, 'n': 0})
        if d['n']:
            print(f"    {state}: {d['ok']}/{d['n']} = {d['ok']/d['n']*100:.1f}%")

print("\n\nDone.")
