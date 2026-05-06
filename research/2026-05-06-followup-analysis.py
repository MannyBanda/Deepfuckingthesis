#!/usr/bin/env python3
"""
Targeted follow-up analyses for Manny's questions.
"""
import json, random
from collections import defaultdict

random.seed(42)

with open('/tmp/raw_backtest.json') as f:
    raw_rows = json.load(f)

# ─── MC SIM (standard) ───────────────────────────────────────────────────────

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
    return round(cw/sc, 3)

def to_rates(s):
    fga=int(s.get('fga',0))or 1;fgm=int(s.get('fgm',0));fg3a=int(s.get('fg3a',0))
    fg3m=int(s.get('fg3m',0));fta=int(s.get('fta',0));ftm=int(s.get('ftm',0))
    to=int(s.get('to',0));oreb=int(s.get('oreb',0))
    po=fga+0.44*fta-oreb+to
    if po<3:po=max(fga,3)
    fg2a=fga-fg3a;fg2m=fgm-fg3m
    if fga<3:return None
    rf=fg3m/fg3a if fg3a>0 else 0.36;sw=min(0.60,fg3a/30);f3p=rf*sw+0.36*(1-sw)
    cl=lambda v:max(0,min(1,v))
    return{'toRate':cl(to/po if po>0 else 0.12),'fg3aShare':cl(fg3a/fga if fga>0 else 0.35),
           'fg3Pct':cl(f3p),'fg2Pct':cl(fg2m/fg2a if fg2a>0 else 0.50),
           'orebRate':cl(oreb/(fga-fgm) if(fga-fgm)>0 else 0.25),
           'ftaRate':min(fta/po if po>0 else 0.20,1.0),'ftPct':cl(ftm/fta if fta>0 else 0.76)}

def est_rem(hs,as_,period,csec):
    def ep(s):return int(s.get('fga',0))+0.44*int(s.get('fta',0))-int(s.get('oreb',0))+int(s.get('to',0))
    av=(ep(hs)+ep(as_))/2;el=(min(period,4)-1)*12+(12-csec/60)
    if el<1:el=1
    return max(0,round(av/el*max(0,48-el)))

# ─── BUILD GAME DATA ─────────────────────────────────────────────────────────

print("Building game data...")
games = defaultdict(list)
for row in raw_rows:
    p = row['period']
    if p < 1: continue
    ts = row.get('team_stats', {})
    if not ts or 'home' not in ts: continue
    ind = row.get('ind', {})
    if isinstance(ind, str): ind = json.loads(ind)
    ctrl = ind.get('controlTeam', '')
    if not ctrl: continue
    hA = row['home_alias']; aA = row['away_alias']
    cih = ctrl == hA; csec = row.get('clock_sec', 0) or 0
    
    mc = None
    if p >= 2:
        rp = est_rem(ts['home'], ts['away'], p, csec)
        if rp >= 1:
            hr = to_rates(ts['home']); ar = to_rates(ts['away'])
            if hr and ar:
                mc = run_mc(hr, ar, int(ts['home'].get('pts',0)), int(ts['away'].get('pts',0)), rp, 300, cih)
    
    raw_margin = row.get('margin', 0) or 0
    ctrl_margin = raw_margin * (1 if cih else -1)
    
    games[row['game_id']].append({
        'cp': row['checkpoint'], 'period': p, 'clock_sec': csec,
        'floor': ind.get('score', 0), 'mc': mc, 'ctrl': ctrl,
        'ctrl_margin': ctrl_margin, 'won': row.get('ctrl_won'),
    })

for gid in games:
    games[gid].sort(key=lambda x: (x['period'], -x['clock_sec']))

print(f"  {len(games)} games\n")

# ═══════════════════════════════════════════════════════════════════════════════
# FINDING 1: MC TRAJECTORY in Q2 and Q3 (where noise is louder)
# ═══════════════════════════════════════════════════════════════════════════════

print("="*70)
print("FINDING 1: MC TRAJECTORY VALUE BY QUARTER (Q2 and Q3 focus)")
print("="*70)

for q in [2, 3, 4]:
    for threshold in [0.70, 0.75, 0.80]:
        single = {'ok': 0, 'n': 0}
        c2 = {'ok': 0, 'n': 0}
        c3 = {'ok': 0, 'n': 0}
        
        for gid, cps in games.items():
            for i, cp in enumerate(cps):
                if cp['period'] != q or cp['mc'] is None or cp['won'] is None:
                    continue
                if cp['mc'] < threshold:
                    continue
                
                single['n'] += 1
                if cp['won']: single['ok'] += 1
                
                if i >= 1 and cps[i-1]['mc'] is not None and cps[i-1]['mc'] >= threshold:
                    c2['n'] += 1
                    if cp['won']: c2['ok'] += 1
                
                if i >= 2 and cps[i-1]['mc'] is not None and cps[i-1]['mc'] >= threshold \
                   and cps[i-2]['mc'] is not None and cps[i-2]['mc'] >= threshold:
                    c3['n'] += 1
                    if cp['won']: c3['ok'] += 1
        
        if single['n'] < 20: continue
        s_pct = single['ok']/single['n']*100
        c2_pct = c2['ok']/c2['n']*100 if c2['n'] else 0
        c3_pct = c3['ok']/c3['n']*100 if c3['n'] else 0
        lift2 = c2_pct - s_pct if c2['n'] else 0
        lift3 = c3_pct - s_pct if c3['n'] else 0
        
        print(f"  Q{q} MC≥{threshold}: single={s_pct:.1f}%(n={single['n']}) "
              f"2consec={c2_pct:.1f}%(n={c2['n']},+{lift2:.1f}pp) "
              f"3consec={c3_pct:.1f}%(n={c3['n']},+{lift3:.1f}pp)")

# ═══════════════════════════════════════════════════════════════════════════════
# FINDING 2: JOURNEY OF TEAMS THAT END MC≥0.80 AT LAST Q4 CHECKPOINT
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("FINDING 2: JOURNEY TO MC≥0.80 AT LAST Q4 — WHAT DID THEY LOOK LIKE EARLIER?")
print("="*70)

# For games where last Q4 checkpoint has MC≥0.80, trace back through Q1-Q3
q4_high = []  # games ending MC≥0.80
q4_low = []   # games ending MC<0.80

for gid, cps in games.items():
    won = cps[0]['won']
    if won is None: continue
    
    q4 = [c for c in cps if c['period'] == 4 and c['mc'] is not None]
    if not q4: continue
    
    last_mc = q4[-1]['mc']
    
    # Get MC at each quarter's last checkpoint
    q_last_mc = {}
    for q in [2, 3, 4]:
        qcps = [c for c in cps if c['period'] == q and c['mc'] is not None]
        if qcps:
            q_last_mc[q] = qcps[-1]['mc']
    
    # Get MC at each quarter's first checkpoint
    q_first_mc = {}
    for q in [2, 3, 4]:
        qcps = [c for c in cps if c['period'] == q and c['mc'] is not None]
        if qcps:
            q_first_mc[q] = qcps[0]['mc']
    
    # Get floor at each quarter end
    q_last_floor = {}
    for q in [2, 3, 4]:
        qcps = [c for c in cps if c['period'] == q]
        if qcps:
            q_last_floor[q] = qcps[-1]['floor']
    
    entry = {
        'won': won,
        'q_last_mc': q_last_mc,
        'q_first_mc': q_first_mc,
        'q_last_floor': q_last_floor,
        'last_q4_mc': last_mc,
    }
    
    if last_mc >= 0.80:
        q4_high.append(entry)
    else:
        q4_low.append(entry)

print(f"\n  Games ending MC≥0.80 at last Q4 checkpoint: {len(q4_high)}")
print(f"  Games ending MC<0.80: {len(q4_low)}")

# What did the MC≥0.80 Q4 games look like in Q2 and Q3?
print(f"\n  === Games that END MC≥0.80 in Q4 — what were they earlier? ===")
for q in [2, 3]:
    mcs = [g['q_last_mc'].get(q) for g in q4_high if q in g['q_last_mc']]
    if not mcs: continue
    
    above_80 = sum(1 for m in mcs if m >= 0.80)
    above_70 = sum(1 for m in mcs if m >= 0.70)
    above_60 = sum(1 for m in mcs if m >= 0.60)
    below_50 = sum(1 for m in mcs if m < 0.50)
    
    print(f"\n  Q{q} end MC for games that become MC≥0.80 in Q4 (n={len(mcs)}):")
    print(f"    Already ≥0.80: {above_80} ({above_80/len(mcs)*100:.1f}%)")
    print(f"    ≥0.70: {above_70} ({above_70/len(mcs)*100:.1f}%)")
    print(f"    ≥0.60: {above_60} ({above_60/len(mcs)*100:.1f}%)")
    print(f"    <0.50: {below_50} ({below_50/len(mcs)*100:.1f}%)")
    print(f"    Mean: {sum(mcs)/len(mcs):.3f}, Median: {sorted(mcs)[len(mcs)//2]:.3f}")

# Early signal: if MC≥0.70 at Q2 end, how often does it become MC≥0.80 at Q4 end?
print(f"\n  === Early predictors of Q4 MC≥0.80 ===")
for q in [2, 3]:
    for mc_early in [0.60, 0.65, 0.70, 0.75, 0.80]:
        games_above = [g for g in q4_high + q4_low if g['q_last_mc'].get(q, 0) >= mc_early]
        if not games_above: continue
        becomes_high = sum(1 for g in games_above if g['last_q4_mc'] >= 0.80)
        wins_of_high = sum(1 for g in games_above if g['last_q4_mc'] >= 0.80 and g['won'])
        
        print(f"    Q{q} end MC≥{mc_early}: {becomes_high}/{len(games_above)} become MC≥0.80 in Q4 "
              f"({becomes_high/len(games_above)*100:.1f}%), "
              f"of those {wins_of_high}/{becomes_high} win ({wins_of_high/becomes_high*100:.1f}%)" if becomes_high else "")

# Compound early signal: MC≥0.70 AND Floor≥0.60 at Q2 end
print(f"\n  === Compound early signal → Q4 outcome ===")
for q in [2, 3]:
    for mc_th, flr_th in [(0.70, 0.60), (0.75, 0.65), (0.80, 0.65), (0.70, 0.70)]:
        all_games_data = q4_high + q4_low
        qualifying = [g for g in all_games_data 
                     if g['q_last_mc'].get(q, 0) >= mc_th and g['q_last_floor'].get(q, 0) >= flr_th]
        if len(qualifying) < 20: continue
        wins = sum(1 for g in qualifying if g['won'])
        becomes_q4_high = sum(1 for g in qualifying if g['last_q4_mc'] >= 0.80)
        print(f"    Q{q} MC≥{mc_th}+Flr≥{flr_th}: {len(qualifying)} games, "
              f"{wins/len(qualifying)*100:.1f}% win, "
              f"{becomes_q4_high}/{len(qualifying)} ({becomes_q4_high/len(qualifying)*100:.1f}%) reach Q4 MC≥0.80")

# ═══════════════════════════════════════════════════════════════════════════════
# FINDING 7: FIRST FIRE vs SECOND FIRE by quarter
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("FINDING 7: FIRST FIRE vs SECOND FIRE vs THIRD FIRE by quarter")
print("="*70)

# For each game, find the 1st, 2nd, 3rd checkpoint where compound is met
for mc_th, flr_th in [(0.80, 0.65), (0.75, 0.60)]:
    print(f"\n  Compound: MC≥{mc_th}+Floor≥{flr_th}")
    
    fires_by_n = defaultdict(lambda: defaultdict(lambda: {'ok': 0, 'n': 0}))
    
    for gid, cps in games.items():
        won = cps[0]['won']
        if won is None: continue
        
        fire_count = 0
        for c in cps:
            if c['mc'] is not None and c['mc'] >= mc_th and c['floor'] >= flr_th:
                fire_count += 1
                fire_label = min(fire_count, 5)  # cap at 5+
                fires_by_n[fire_label][c['period']]['n'] += 1
                if won: fires_by_n[fire_label][c['period']]['ok'] += 1
                
                # Also track overall for this fire number
                fires_by_n[fire_label]['all']['n'] += 1
                if won: fires_by_n[fire_label]['all']['ok'] += 1
    
    for fire_n in sorted(fires_by_n.keys()):
        label = f"{fire_n}th" if fire_n > 1 else "1st"
        if fire_n == 5: label = "5th+"
        parts = []
        for q in ['all', 2, 3, 4]:
            d = fires_by_n[fire_n].get(q, {'ok': 0, 'n': 0})
            if d['n'] >= 10:
                qlabel = f"Q{q}" if isinstance(q, int) else "ALL"
                parts.append(f"{qlabel}={d['ok']}/{d['n']}({d['ok']/d['n']*100:.1f}%)")
        if parts:
            print(f"    {label} fire: {', '.join(parts)}")

# ═══════════════════════════════════════════════════════════════════════════════
# THREAD 5: Q3 STANDARD PO BY MARGIN (ctrl leading vs trailing)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("THREAD 5: Q3+ COMPOUND BY CTRL MARGIN")
print("="*70)

for q in [3, 4]:
    print(f"\n  Q{q} MC≥0.80+Floor≥0.65:")
    all_compound = []
    for gid, cps in games.items():
        for c in cps:
            if c['period'] == q and c['mc'] is not None and c['won'] is not None:
                if c['mc'] >= 0.80 and c['floor'] >= 0.65:
                    all_compound.append(c)
    
    if not all_compound: continue
    
    buckets = [
        ("trailing 6+", lambda c: c['ctrl_margin'] <= -6),
        ("trailing 1-5", lambda c: -5 <= c['ctrl_margin'] <= -1),
        ("tied/+1", lambda c: 0 <= c['ctrl_margin'] <= 1),
        ("lead 2-5", lambda c: 2 <= c['ctrl_margin'] <= 5),
        ("lead 6-10", lambda c: 6 <= c['ctrl_margin'] <= 10),
        ("lead 11-15", lambda c: 11 <= c['ctrl_margin'] <= 15),
        ("lead 16+", lambda c: c['ctrl_margin'] >= 16),
    ]
    
    for label, fn in buckets:
        sub = [c for c in all_compound if fn(c)]
        if sub:
            w = sum(1 for c in sub if c['won'])
            print(f"    {label}: {w}/{len(sub)} = {w/len(sub)*100:.1f}% (n={len(sub)})")

# ═══════════════════════════════════════════════════════════════════════════════
# BLINDSPOT 1: CLOSE GAME BACKTEST (DFT definition: margin ≤ 8)
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("BLINDSPOT 1: CLOSE GAME BACKTEST (final margin ≤ 8)")
print("="*70)

# Approximate final margin from last Q4 checkpoint margin
# (not perfect but close enough — last checkpoint is ~3min from end)

close_game_gids = set()
all_game_margins = {}

for gid, cps in games.items():
    won = cps[0]['won']
    if won is None: continue
    q4 = [c for c in cps if c['period'] == 4]
    if not q4: continue
    # Use absolute margin at last checkpoint as proxy for final margin
    last_abs_margin = abs(q4[-1]['ctrl_margin'])
    all_game_margins[gid] = last_abs_margin
    if last_abs_margin <= 8:
        close_game_gids.add(gid)

print(f"  Close games (last Q4 margin ≤ 8): {len(close_game_gids)} / {len(all_game_margins)}")

# Compound accuracy in close games only
print(f"\n  === Compound accuracy in CLOSE GAMES ONLY ===")

# First fire
for mc_th, flr_th, label in [(0.80, 0.65, "MC≥0.80+Floor≥0.65"), (0.75, 0.60, "MC≥0.75+Floor≥0.60")]:
    first_ok = 0; first_n = 0
    by_q = defaultdict(lambda: {'ok': 0, 'n': 0})
    
    for gid in close_game_gids:
        cps = games[gid]
        won = cps[0]['won']
        
        for c in cps:
            if c['mc'] is not None and c['mc'] >= mc_th and c['floor'] >= flr_th:
                first_n += 1
                if won: first_ok += 1
                by_q[c['period']]['n'] += 1
                if won: by_q[c['period']]['ok'] += 1
                break
    
    print(f"\n  {label} first fire in close games:")
    if first_n:
        print(f"    Overall: {first_ok}/{first_n} = {first_ok/first_n*100:.1f}%")
        for q in sorted(by_q.keys()):
            d = by_q[q]
            if d['n']:
                print(f"    Q{q}: {d['ok']}/{d['n']} = {d['ok']/d['n']*100:.1f}%")

# Per-checkpoint in close games
print(f"\n  === Per-checkpoint compound accuracy in CLOSE GAMES ===")
for q in [2, 3, 4]:
    compound = []
    for gid in close_game_gids:
        for c in games[gid]:
            if c['period'] == q and c['mc'] is not None and c['won'] is not None:
                if c['mc'] >= 0.80 and c['floor'] >= 0.65:
                    compound.append(c)
    
    if compound:
        w = sum(1 for c in compound if c['won'])
        print(f"  Q{q}: {w}/{len(compound)} = {w/len(compound)*100:.1f}% (n={len(compound)})")
        
        # By margin within close games
        trailing = [c for c in compound if c['ctrl_margin'] < 0]
        close_lead = [c for c in compound if 0 <= c['ctrl_margin'] <= 5]
        mod_lead = [c for c in compound if 6 <= c['ctrl_margin'] <= 8]
        
        for lbl, sub in [("trailing", trailing), ("lead 0-5", close_lead), ("lead 6-8", mod_lead)]:
            if sub:
                ws = sum(1 for c in sub if c['won'])
                print(f"    {lbl}: {ws}/{len(sub)} = {ws/len(sub)*100:.1f}%")

# Graduation vs compound in close games
print(f"\n  === Current graduation vs compound in CLOSE GAMES ===")
# Approximate graduation: 4+ checkpoints with floor≥0.58, mean floor≥0.65, no flips
grad_ok = 0; grad_n = 0
compound_ok = 0; compound_n = 0

for gid in close_game_gids:
    cps = games[gid]
    won = cps[0]['won']
    
    # Graduation simulation
    floor_readings = []; flips = 0; prev = None; graduated = False
    for c in cps:
        if c['period'] < 2: continue
        if prev and c['ctrl'] != prev: flips += 1; floor_readings = []
        prev = c['ctrl']
        floor_readings.append(c['floor'])
        mf = sum(floor_readings)/len(floor_readings)
        if len(floor_readings) >= 4 and mf >= 0.65 and flips == 0:
            graduated = True; break
        elif len(floor_readings) >= 4 and mf >= 0.65:
            graduated = True; break
    
    if graduated:
        grad_n += 1
        if won: grad_ok += 1
    
    # Compound
    for c in cps:
        if c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
            compound_n += 1
            if won: compound_ok += 1
            break

print(f"  Graduation in close games: {grad_ok}/{grad_n} = {grad_ok/grad_n*100:.1f}%" if grad_n else "  Graduation: n/a")
print(f"  Compound in close games:   {compound_ok}/{compound_n} = {compound_ok/compound_n*100:.1f}%" if compound_n else "  Compound: n/a")

# ═══════════════════════════════════════════════════════════════════════════════
# THREAD 4: WHAT MAKES FIRST FIRE WRONG? CAN WE IDENTIFY IT?
# ═══════════════════════════════════════════════════════════════════════════════

print("\n" + "="*70)
print("THREAD 4: ANATOMY OF WRONG FIRST FIRES")
print("="*70)

wrong_first_fires = []
correct_first_fires = []

for gid, cps in games.items():
    won = cps[0]['won']
    if won is None: continue
    
    for c in cps:
        if c['mc'] is not None and c['mc'] >= 0.80 and c['floor'] >= 0.65:
            entry = {
                'gid': gid,
                'period': c['period'],
                'mc': c['mc'],
                'floor': c['floor'],
                'margin': c['ctrl_margin'],
                'won': won,
            }
            
            # Get MC trajectory context at first fire
            idx = cps.index(c)
            prior_mcs = [cps[j]['mc'] for j in range(max(0, idx-3), idx) if cps[j]['mc'] is not None]
            entry['prior_mcs'] = prior_mcs
            entry['mc_rising'] = all(prior_mcs[i] < prior_mcs[i+1] for i in range(len(prior_mcs)-1)) if len(prior_mcs) >= 2 else None
            
            # Get floor trajectory
            prior_floors = [cps[j]['floor'] for j in range(max(0, idx-3), idx)]
            entry['prior_floors'] = prior_floors
            
            # Was there a ctrl flip before this?
            flips_before = 0
            prev_ctrl = None
            for j in range(idx):
                if prev_ctrl and cps[j]['ctrl'] != prev_ctrl: flips_before += 1
                prev_ctrl = cps[j]['ctrl']
            entry['flips_before'] = flips_before
            
            if won:
                correct_first_fires.append(entry)
            else:
                wrong_first_fires.append(entry)
            break

print(f"  Correct first fires: {len(correct_first_fires)}")
print(f"  Wrong first fires: {len(wrong_first_fires)}")
print(f"  First fire accuracy: {len(correct_first_fires)/(len(correct_first_fires)+len(wrong_first_fires))*100:.1f}%")

# What distinguishes wrong from correct?
print(f"\n  === WRONG first fires profile ===")
if wrong_first_fires:
    by_q = defaultdict(int)
    for f in wrong_first_fires: by_q[f['period']] += 1
    print(f"  By quarter: {dict(sorted(by_q.items()))}")
    print(f"  Avg MC: {sum(f['mc'] for f in wrong_first_fires)/len(wrong_first_fires):.3f}")
    print(f"  Avg Floor: {sum(f['floor'] for f in wrong_first_fires)/len(wrong_first_fires):.3f}")
    print(f"  Avg Margin: {sum(f['margin'] for f in wrong_first_fires)/len(wrong_first_fires):.1f}")
    print(f"  Avg flips before: {sum(f['flips_before'] for f in wrong_first_fires)/len(wrong_first_fires):.1f}")
    
    # Margin distribution
    trailing = sum(1 for f in wrong_first_fires if f['margin'] < 0)
    close = sum(1 for f in wrong_first_fires if 0 <= f['margin'] <= 5)
    moderate = sum(1 for f in wrong_first_fires if 6 <= f['margin'] <= 15)
    blowout = sum(1 for f in wrong_first_fires if f['margin'] > 15)
    print(f"  Margin: trailing={trailing}, close(0-5)={close}, moderate(6-15)={moderate}, blowout(16+)={blowout}")

print(f"\n  === CORRECT first fires profile ===")
if correct_first_fires:
    by_q = defaultdict(int)
    for f in correct_first_fires: by_q[f['period']] += 1
    print(f"  By quarter: {dict(sorted(by_q.items()))}")
    print(f"  Avg MC: {sum(f['mc'] for f in correct_first_fires)/len(correct_first_fires):.3f}")
    print(f"  Avg Floor: {sum(f['floor'] for f in correct_first_fires)/len(correct_first_fires):.3f}")
    print(f"  Avg Margin: {sum(f['margin'] for f in correct_first_fires)/len(correct_first_fires):.1f}")
    print(f"  Avg flips before: {sum(f['flips_before'] for f in correct_first_fires)/len(correct_first_fires):.1f}")

# Can we discriminate? 
print(f"\n  === Discrimination: what predicts wrong first fire? ===")

# By quarter
for q in [2, 3, 4]:
    correct_q = [f for f in correct_first_fires if f['period'] == q]
    wrong_q = [f for f in wrong_first_fires if f['period'] == q]
    if correct_q or wrong_q:
        total = len(correct_q) + len(wrong_q)
        acc = len(correct_q) / total * 100 if total else 0
        print(f"  Q{q}: {len(correct_q)}/{total} = {acc:.1f}% accurate")

# By prior flips
for flips in [0, 1, 2]:
    correct_f = [f for f in correct_first_fires if f['flips_before'] == flips]
    wrong_f = [f for f in wrong_first_fires if f['flips_before'] == flips]
    if correct_f or wrong_f:
        total = len(correct_f) + len(wrong_f)
        acc = len(correct_f) / total * 100 if total else 0
        print(f"  {flips} prior flips: {len(correct_f)}/{total} = {acc:.1f}% accurate")

flips3 = [f for f in correct_first_fires if f['flips_before'] >= 3]
wrong3 = [f for f in wrong_first_fires if f['flips_before'] >= 3]
if flips3 or wrong3:
    total = len(flips3) + len(wrong3)
    print(f"  3+ prior flips: {len(flips3)}/{total} = {len(flips3)/total*100:.1f}% accurate")

# By MC level at first fire
for mc_lo, mc_hi in [(0.80, 0.85), (0.85, 0.90), (0.90, 0.95), (0.95, 1.01)]:
    correct_m = [f for f in correct_first_fires if mc_lo <= f['mc'] < mc_hi]
    wrong_m = [f for f in wrong_first_fires if mc_lo <= f['mc'] < mc_hi]
    if correct_m or wrong_m:
        total = len(correct_m) + len(wrong_m)
        acc = len(correct_m) / total * 100 if total else 0
        print(f"  MC {mc_lo}-{mc_hi}: {len(correct_m)}/{total} = {acc:.1f}% accurate")

# By margin at first fire
for mar_lo, mar_hi, label in [(-20, -1, "trailing"), (0, 5, "lead 0-5"), 
                                (6, 10, "lead 6-10"), (11, 20, "lead 11-20"), (21, 100, "lead 21+")]:
    correct_m = [f for f in correct_first_fires if mar_lo <= f['margin'] <= mar_hi]
    wrong_m = [f for f in wrong_first_fires if mar_lo <= f['margin'] <= mar_hi]
    if correct_m or wrong_m:
        total = len(correct_m) + len(wrong_m)
        acc = len(correct_m) / total * 100 if total else 0
        print(f"  Margin {label}: {len(correct_m)}/{total} = {acc:.1f}% accurate")

print("\n\nDone.")
