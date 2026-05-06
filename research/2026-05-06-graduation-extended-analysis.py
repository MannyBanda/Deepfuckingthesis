#!/usr/bin/env python3
"""
EXTENDED ANALYSIS: Fix graduation sim + game-level compound assessment
"""

import json
import random
from collections import defaultdict

random.seed(42)

# ─── LOAD PRE-COMPUTED MC DATA ────────────────────────────────────────────────

print("Loading data...")
with open('/tmp/raw_backtest.json') as f:
    raw_rows = json.load(f)

# Rebuild MC sim (same as main script)
def simulate_possession(rates):
    if random.random() < rates['toRate']:
        return 0
    pts = 0; is_make = False
    if random.random() < rates['fg3aShare']:
        is_make = random.random() < rates['fg3Pct']
        if is_make: pts = 3
    else:
        is_make = random.random() < rates['fg2Pct']
        if is_make: pts = 2
    if not is_make and random.random() < rates['orebRate']:
        if random.random() < rates['fg2Pct']: pts = 2
    if random.random() < rates['ftaRate'] / 2:
        if random.random() < rates['ftPct']: pts += 1
        if random.random() < rates['ftPct']: pts += 1
    return pts

def run_mc_sim(hr, ar, hs, as_, rp, sc=300, cih=True):
    cw = 0
    for _ in range(sc):
        h,a = hs,as_; hp,ap = round(rp),round(rp); hb = random.random()<0.5
        while hp>0 or ap>0:
            if hb:
                if hp>0: h += simulate_possession(hr); hp -= 1
            else:
                if ap>0: a += simulate_possession(ar); ap -= 1
            hb = not hb
        f = (h-a) if cih else (a-h)
        cw += 1 if f>0 else (0.5 if f==0 else 0)
    return round(cw/sc, 3)

def agg_to_mc_rates(s):
    fga=int(s.get('fga',0)) or 1; fgm=int(s.get('fgm',0)); fg3a=int(s.get('fg3a',0))
    fg3m=int(s.get('fg3m',0)); fta=int(s.get('fta',0)); ftm=int(s.get('ftm',0))
    to=int(s.get('to',0)); oreb=int(s.get('oreb',0))
    poss=fga+0.44*fta-oreb+to
    if poss<3: poss=max(fga,3)
    fg2a=fga-fg3a; fg2m=fgm-fg3m
    if fga<3: return None
    rfg3=fg3m/fg3a if fg3a>0 else 0.36; sw=min(0.60,fg3a/30); fg3p=rfg3*sw+0.36*(1-sw)
    cl = lambda v: max(0,min(1,v))
    return {'toRate':cl(to/poss if poss>0 else 0.12),'fg3aShare':cl(fg3a/fga if fga>0 else 0.35),
            'fg3Pct':cl(fg3p),'fg2Pct':cl(fg2m/fg2a if fg2a>0 else 0.50),
            'orebRate':cl(oreb/(fga-fgm) if (fga-fgm)>0 else 0.25),
            'ftaRate':min(fta/poss if poss>0 else 0.20,1.0),'ftPct':cl(ftm/fta if fta>0 else 0.76)}

def est_remain(hs, as_, period, csec):
    def ep(s): return int(s.get('fga',0))+0.44*int(s.get('fta',0))-int(s.get('oreb',0))+int(s.get('to',0))
    avg=(ep(hs)+ep(as_))/2; el=(min(period,4)-1)*12+(12-csec/60)
    if el<1: el=1
    return max(0, round(avg/el*max(0,48-el)))

# Build per-game data with MC
print("Computing MC + building game data...")
games = defaultdict(list)
mc_computed = 0

for row in raw_rows:
    period = row['period']
    if period < 2:
        continue
    ts = row.get('team_stats', {})
    if not ts or 'home' not in ts: continue
    ind = row.get('ind', {})
    if isinstance(ind, str): ind = json.loads(ind)
    ctrl = ind.get('controlTeam', '')
    if not ctrl: continue
    
    h_alias = row['home_alias']; a_alias = row['away_alias']
    ctrl_is_home = ctrl == h_alias
    csec = row.get('clock_sec', 0) or 0
    rp = est_remain(ts['home'], ts['away'], period, csec)
    
    mc_cum = None
    if rp >= 1:
        hr = agg_to_mc_rates(ts['home']); ar = agg_to_mc_rates(ts['away'])
        if hr and ar:
            mc_cum = run_mc_sim(hr, ar, int(ts['home'].get('pts',0)), int(ts['away'].get('pts',0)), rp, 300, ctrl_is_home)
            mc_computed += 1
    
    if mc_cum is None: continue
    
    floor = ind.get('score', 0)
    raw_margin = row.get('margin', 0) or 0
    ctrl_margin = raw_margin * (1 if ctrl_is_home else -1)
    
    games[row['game_id']].append({
        'cp': row['checkpoint'], 'period': period, 'clock_sec': csec,
        'floor': floor, 'mc_cum': mc_cum, 'ctrl': ctrl,
        'ctrl_margin': ctrl_margin, 'ctrl_won': row.get('ctrl_won'),
        'h_alias': h_alias, 'a_alias': a_alias,
    })

for gid in games:
    games[gid].sort(key=lambda x: (x['period'], -x['clock_sec']))

print(f"  {len(games)} games, {mc_computed} MC values")

# ─── PROPER GRADUATION WITH FLIP RESETS ──────────────────────────────────────

def graduation_with_resets(cps):
    """
    Production-accurate graduation: when ctrl team flips, reset ALL tracking 
    for the old team. New team starts from scratch.
    
    Returns per-checkpoint: (rank, flips_in_current_run, total_flips, holds, eligible, mf)
    """
    results = []
    current_ctrl = None
    floor_readings = []  # readings for CURRENT ctrl team only
    total_flips = 0
    run_flips = 0  # flips since last reset
    
    MF = 0.65
    MIN_F = 0.58
    
    for cp in cps:
        if current_ctrl is not None and cp['ctrl'] != current_ctrl:
            # FLIP — reset tracking for new team
            total_flips += 1
            # After flip, carry knowledge that a flip happened
            # but reset floor readings for the new team
            floor_readings = []
            run_flips += 1
        elif current_ctrl is None:
            run_flips = 0
        
        current_ctrl = cp['ctrl']
        floor_readings.append(cp['floor'])
        
        eligible = len(floor_readings)
        mf = sum(floor_readings) / eligible
        holds = sum(1 for f in floor_readings if f >= MIN_F)
        
        # S-rank: wire-to-wire, no flips, 8+ holds, all above min, mf >= threshold
        # In production, S-rank requires NO flips across the ENTIRE game
        if total_flips == 0 and mf >= MF and holds == eligible and eligible >= 8:
            rank = 'S'
        elif total_flips == 0 and mf >= MF and holds == eligible and eligible >= 6:
            rank = 'A'
        elif mf >= MF and holds >= max(2, eligible * 0.7):
            if total_flips == 0:
                if eligible >= 4:
                    rank = 'B'
                else:
                    rank = 'C'
            elif run_flips >= 1 and eligible >= 3 and mf >= 0.55 and holds >= 2:
                # B-rank recovery after flip: have enough new readings
                rank = 'B'
            else:
                rank = 'C'
        else:
            rank = 'C'
        
        results.append({
            'rank': rank,
            'total_flips': total_flips,
            'run_flips': run_flips,
            'holds': holds,
            'eligible': eligible,
            'mf': mf,
        })
    
    return results

# ─── GAME-LEVEL ANALYSIS: TERMINAL CHECKPOINT ────────────────────────────────

print("\n" + "="*70)
print("GAME-LEVEL: Terminal checkpoint accuracy")
print("="*70)
print("(Using LAST Q4 checkpoint per game as the 'decision point')")

terminal_data = []
for gid, cps in games.items():
    # Get last Q4 checkpoint
    q4_cps = [cp for cp in cps if cp['period'] == 4]
    if not q4_cps:
        continue
    terminal = q4_cps[-1]
    if terminal['ctrl_won'] is None:
        continue
    
    grads = graduation_with_resets(cps)
    terminal_grad = grads[len(cps) - len(q4_cps) + len(q4_cps) - 1]
    
    terminal_data.append({
        'gid': gid,
        'floor': terminal['floor'],
        'mc_cum': terminal['mc_cum'],
        'ctrl_margin': terminal['ctrl_margin'],
        'rank': terminal_grad['rank'],
        'flips': terminal_grad['total_flips'],
        'eligible': terminal_grad['eligible'],
        'mf': terminal_grad['mf'],
        'won': terminal['ctrl_won'],
    })

print(f"  {len(terminal_data)} games with Q4 terminal checkpoint")

# Game-level graduation accuracy
print("\n  Graduation ranks (game-level, last Q4 checkpoint):")
for rank in ['S', 'A', 'B', 'C']:
    rdata = [x for x in terminal_data if x['rank'] == rank]
    if rdata:
        w = sum(1 for x in rdata if x['won'])
        print(f"    {rank}: {w}/{len(rdata)} = {w/len(rdata)*100:.1f}%")

# A-rank with/without flips
a_w_flips = [x for x in terminal_data if x['rank'] == 'A' and x['flips'] > 0]
a_no_flips = [x for x in terminal_data if x['rank'] == 'A' and x['flips'] == 0]
if a_w_flips:
    w = sum(1 for x in a_w_flips if x['won'])
    print(f"    A+flips: {w}/{len(a_w_flips)} = {w/len(a_w_flips)*100:.1f}%")
if a_no_flips:
    w = sum(1 for x in a_no_flips if x['won'])
    print(f"    A-clean: {w}/{len(a_no_flips)} = {w/len(a_no_flips)*100:.1f}%")

# Game-level compound accuracy
print("\n  Compound tiers (game-level, last Q4 checkpoint):")
tiers = [
    ("MC≥0.90+Flr≥0.70", lambda x: x['mc_cum']>=0.90 and x['floor']>=0.70),
    ("MC≥0.80+Flr≥0.65", lambda x: x['mc_cum']>=0.80 and x['floor']>=0.65),
    ("MC≥0.80+Flr≥0.55", lambda x: x['mc_cum']>=0.80 and x['floor']>=0.55),
    ("MC≥0.70+Flr≥0.65", lambda x: x['mc_cum']>=0.70 and x['floor']>=0.65),
    ("MC≥0.70+Flr≥0.55", lambda x: x['mc_cum']>=0.70 and x['floor']>=0.55),
    ("MC≥0.80 alone", lambda x: x['mc_cum']>=0.80),
    ("MC≥0.70 alone", lambda x: x['mc_cum']>=0.70),
    ("Floor≥0.65 alone", lambda x: x['floor']>=0.65),
]
for name, fn in tiers:
    hits = [x for x in terminal_data if fn(x)]
    if hits:
        w = sum(1 for x in hits if x['won'])
        print(f"    {name}: {w}/{len(hits)} = {w/len(hits)*100:.1f}% ({len(hits)}/{len(terminal_data)} games)")

# ─── A-RANK WITH FLIPS + MC DISCRIMINATION ──────────────────────────────────

print("\n" + "="*70)
print("A-RANK FLIPS: MC discrimination (all checkpoints)")
print("="*70)

# Let me look at ALL checkpoints across all quarters, not just terminal
all_graded = []
for gid, cps in games.items():
    grads = graduation_with_resets(cps)
    for i, cp in enumerate(cps):
        if cp['ctrl_won'] is None: continue
        g = grads[i]
        all_graded.append({
            'period': cp['period'],
            'floor': cp['floor'],
            'mc_cum': cp['mc_cum'],
            'rank': g['rank'],
            'flips': g['total_flips'],
            'eligible': g['eligible'],
            'mf': g['mf'],
            'won': cp['ctrl_won'],
        })

print(f"  {len(all_graded)} total graded checkpoints")

# Distribution of ranks
for rank in ['S', 'A', 'B', 'C']:
    rd = [x for x in all_graded if x['rank'] == rank]
    if rd:
        w = sum(1 for x in rd if x['won'])
        print(f"  {rank}: {w}/{len(rd)} = {w/len(rd)*100:.1f}%")

# Check for flip-involved scenarios
flip_cps = [x for x in all_graded if x['flips'] > 0]
print(f"\n  Checkpoints with ≥1 flip: {len(flip_cps)}")
if flip_cps:
    w = sum(1 for x in flip_cps if x['won'])
    print(f"  Overall flip accuracy: {w}/{len(flip_cps)} = {w/len(flip_cps)*100:.1f}%")
    
    for rank in ['S', 'A', 'B', 'C']:
        rd = [x for x in flip_cps if x['rank'] == rank]
        if rd:
            w = sum(1 for x in rd if x['won'])
            print(f"    {rank}+flips: {w}/{len(rd)} = {w/len(rd)*100:.1f}%")
    
    # MC discrimination within flip scenarios
    print(f"\n  MC discrimination for checkpoints WITH flips:")
    for mc_th in [0.80, 0.70, 0.60, 0.50]:
        sub = [x for x in flip_cps if x['mc_cum'] >= mc_th]
        if sub:
            w = sum(1 for x in sub if x['won'])
            print(f"    MC≥{mc_th}: {w}/{len(sub)} = {w/len(sub)*100:.1f}%")
    sub_low = [x for x in flip_cps if x['mc_cum'] < 0.50]
    if sub_low:
        w = sum(1 for x in sub_low if x['won'])
        print(f"    MC<0.50: {w}/{len(sub_low)} = {w/len(sub_low)*100:.1f}%")
    
    # By quarter
    for q in [3, 4]:
        qf = [x for x in flip_cps if x['period'] == q]
        if not qf: continue
        w = sum(1 for x in qf if x['won'])
        print(f"\n  Q{q} flips: {w}/{len(qf)} = {w/len(qf)*100:.1f}%")
        for mc_th in [0.80, 0.70, 0.60]:
            sub = [x for x in qf if x['mc_cum'] >= mc_th]
            if sub:
                w2 = sum(1 for x in sub if x['won'])
                print(f"    MC≥{mc_th}: {w2}/{len(sub)} = {w2/len(sub)*100:.1f}%")
        sub_low = [x for x in qf if x['mc_cum'] < 0.50]
        if sub_low:
            w2 = sum(1 for x in sub_low if x['won'])
            print(f"    MC<0.50: {w2}/{len(sub_low)} = {w2/len(sub_low)*100:.1f}%")

# ─── GRADUATION VALUE-ADD: Does tracking add ANYTHING over single snapshot? ──

print("\n" + "="*70)
print("VALUE-ADD: Graduation tracking vs single-snapshot compound")
print("="*70)

# For games where compound says "good" but graduation says "bad" (or vice versa),
# who is right?

for q in [3, 4]:
    qdata = [x for x in all_graded if x['period'] == q]
    
    compound_good = [x for x in qdata if x['mc_cum'] >= 0.80 and x['floor'] >= 0.65]
    compound_bad = [x for x in qdata if x['mc_cum'] < 0.60 or x['floor'] < 0.50]
    
    # Compound says good but graduation says C
    disagree_compound_up = [x for x in compound_good if x['rank'] == 'C']
    disagree_compound_down = [x for x in compound_bad if x['rank'] in ['S', 'A']]
    
    print(f"\n  Q{q} disagreements:")
    if disagree_compound_up:
        w = sum(1 for x in disagree_compound_up if x['won'])
        print(f"    Compound GOOD + Grad C: {w}/{len(disagree_compound_up)} = {w/len(disagree_compound_up)*100:.1f}% → compound {'right' if w/len(disagree_compound_up)>0.65 else 'wrong'}")
    if disagree_compound_down:
        w = sum(1 for x in disagree_compound_down if x['won'])
        print(f"    Compound BAD + Grad S/A: {w}/{len(disagree_compound_down)} = {w/len(disagree_compound_down)*100:.1f}% → graduation {'right' if w/len(disagree_compound_down)>0.65 else 'wrong'}")
    
    # What about compound good BUT with flips?
    compound_good_flips = [x for x in compound_good if x['flips'] > 0]
    compound_good_clean = [x for x in compound_good if x['flips'] == 0]
    if compound_good_flips:
        w = sum(1 for x in compound_good_flips if x['won'])
        print(f"    Compound GOOD + flips: {w}/{len(compound_good_flips)} = {w/len(compound_good_flips)*100:.1f}%")
    if compound_good_clean:
        w = sum(1 for x in compound_good_clean if x['won'])
        print(f"    Compound GOOD + clean: {w}/{len(compound_good_clean)} = {w/len(compound_good_clean)*100:.1f}%")

# ─── MARGIN CONTEXT: Does compound accuracy change by game closeness? ────────

print("\n" + "="*70)
print("MARGIN CONTEXT: Compound accuracy by game closeness")
print("="*70)

for q in [3, 4]:
    qdata = [x for x in all_graded if x['period'] == q]
    compound_good = [x for x in qdata if x['mc_cum'] >= 0.80 and x['floor'] >= 0.65]
    
    if not compound_good: continue
    print(f"\n  Q{q} MC≥0.80+Floor≥0.65 by margin:")
    
    buckets = [
        ("trailing (margin<0)", lambda x: x.get('ctrl_margin', 0) < 0),
        ("close lead (0-5)", lambda x: 0 <= x.get('ctrl_margin', 0) <= 5),
        ("moderate lead (6-10)", lambda x: 6 <= x.get('ctrl_margin', 0) <= 10),
        ("comfortable (11-15)", lambda x: 11 <= x.get('ctrl_margin', 0) <= 15),
        ("blowout (16+)", lambda x: x.get('ctrl_margin', 0) >= 16),
    ]
    
    # Need to add ctrl_margin to all_graded - let me rebuild with margin
    pass

# I need ctrl_margin in all_graded - let me add it
all_graded2 = []
for gid, cps in games.items():
    grads = graduation_with_resets(cps)
    for i, cp in enumerate(cps):
        if cp['ctrl_won'] is None: continue
        g = grads[i]
        all_graded2.append({
            'period': cp['period'],
            'floor': cp['floor'],
            'mc_cum': cp['mc_cum'],
            'ctrl_margin': cp['ctrl_margin'],
            'rank': g['rank'],
            'flips': g['total_flips'],
            'mf': g['mf'],
            'won': cp['ctrl_won'],
        })

for q in [3, 4]:
    qdata = [x for x in all_graded2 if x['period'] == q]
    compound_good = [x for x in qdata if x['mc_cum'] >= 0.80 and x['floor'] >= 0.65]
    
    if not compound_good: continue
    w = sum(1 for x in compound_good if x['won'])
    print(f"\n  Q{q} MC≥0.80+Floor≥0.65 overall: {w}/{len(compound_good)} = {w/len(compound_good)*100:.1f}%")
    
    for label, fn in [
        ("trailing", lambda x: x['ctrl_margin'] < 0),
        ("close 0-5", lambda x: 0 <= x['ctrl_margin'] <= 5),
        ("lead 6-10", lambda x: 6 <= x['ctrl_margin'] <= 10),
        ("lead 11-15", lambda x: 11 <= x['ctrl_margin'] <= 15),
        ("blowout 16+", lambda x: x['ctrl_margin'] >= 16),
    ]:
        sub = [x for x in compound_good if fn(x)]
        if sub:
            w2 = sum(1 for x in sub if x['won'])
            print(f"    {label}: {w2}/{len(sub)} = {w2/len(sub)*100:.1f}%")

# ─── WHAT EXACTLY DO LOSSES LOOK LIKE? ───────────────────────────────────────

print("\n" + "="*70)
print("LOSS ANATOMY: Where compound fails at MC≥0.80+Floor≥0.65")
print("="*70)

for q in [3, 4]:
    qdata = [x for x in all_graded2 if x['period'] == q and x['mc_cum'] >= 0.80 and x['floor'] >= 0.65]
    losses = [x for x in qdata if not x['won']]
    wins = [x for x in qdata if x['won']]
    
    print(f"\n  Q{q}: {len(wins)} wins, {len(losses)} losses")
    if losses:
        avg_mc = sum(x['mc_cum'] for x in losses) / len(losses)
        avg_flr = sum(x['floor'] for x in losses) / len(losses)
        avg_mar = sum(x['ctrl_margin'] for x in losses) / len(losses)
        print(f"    Loss avg: MC={avg_mc:.3f}, Floor={avg_flr:.3f}, Margin={avg_mar:.1f}")
        
        trailing_losses = [x for x in losses if x['ctrl_margin'] < 0]
        close_losses = [x for x in losses if 0 <= x['ctrl_margin'] <= 5]
        lead_losses = [x for x in losses if x['ctrl_margin'] > 5]
        print(f"    Trailing losses: {len(trailing_losses)}, Close losses: {len(close_losses)}, Lead losses: {len(lead_losses)}")
        
        flip_losses = [x for x in losses if x['flips'] > 0]
        print(f"    Losses with flips: {len(flip_losses)}/{len(losses)}")

print("\n\nDone.")
