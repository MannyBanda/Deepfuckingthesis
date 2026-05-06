#!/usr/bin/env python3
"""
For the 355 games where MC Cum compound held in Q4 but ctrl lost:
How many would the MC canary catch?

Canary fires when MC Cum < 0.70 OR divergence (|floor - MC|) > 0.15
Investigation produces CLEAN/WAVE/NORMALIZED/FALSE_ALARM pattern.
"""
import json, random
from collections import defaultdict

random.seed(42)

with open('/tmp/raw_backtest.json') as f:
    raw_rows = json.load(f)

# ─── MC SIM (same as all prior scripts) ──────────────────────────────────────

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

# ─── BUILD GAME DATA WITH MC CUM ─────────────────────────────────────────────

print("Building game data with MC Cum...")
games = defaultdict(list)
for row in raw_rows:
    p = row['period']
    if p < 2: continue
    ts = row.get('team_stats', {})
    if not ts or 'home' not in ts: continue
    ind = row.get('ind', {})
    if isinstance(ind, str): ind = json.loads(ind)
    ctrl = ind.get('controlTeam', '')
    if not ctrl: continue
    hA = row['home_alias']; aA = row['away_alias']
    cih = ctrl == hA; csec = row.get('clock_sec', 0) or 0
    rp = est_rem(ts['home'], ts['away'], p, csec)
    mc = None
    if rp >= 1:
        hr = to_rates(ts['home']); ar = to_rates(ts['away'])
        if hr and ar:
            mc = run_mc(hr, ar, int(ts['home'].get('pts',0)), int(ts['away'].get('pts',0)), rp, 300, cih)
    if mc is None: continue
    raw_margin = row.get('margin', 0) or 0
    ctrl_margin = raw_margin * (1 if cih else -1)
    floor = ind.get('score', 0)
    
    games[row['game_id']].append({
        'cp': row['checkpoint'], 'period': p, 'clock_sec': csec,
        'floor': floor, 'mc': mc, 'ctrl': ctrl,
        'ctrl_margin': ctrl_margin, 'won': row.get('ctrl_won'),
    })

for gid in games:
    games[gid].sort(key=lambda x: (x['period'], -x['clock_sec']))

print(f"  {len(games)} games\n")

# ─── FIND THE 355 COMPOUND LOSSES ────────────────────────────────────────────

compound_losses = []
compound_wins = []

for gid, cps in games.items():
    won = cps[0]['won']
    if won is None: continue
    
    # Did compound hold in Q4? (any Q4 checkpoint with MC≥0.80 + Floor≥0.65)
    q4_compound = [c for c in cps if c['period'] == 4 and c['mc'] >= 0.80 and c['floor'] >= 0.65]
    
    if q4_compound:
        if won:
            compound_wins.append(gid)
        else:
            compound_losses.append(gid)

print(f"Q4 compound games: {len(compound_wins)} wins, {len(compound_losses)} losses")
print(f"Compound Q4 accuracy: {len(compound_wins)}/{len(compound_wins)+len(compound_losses)} = "
      f"{len(compound_wins)/(len(compound_wins)+len(compound_losses))*100:.1f}%\n")

# ─── CANARY ANALYSIS ON LOSSES ───────────────────────────────────────────────

print("="*70)
print("CANARY COVERAGE ON COMPOUND LOSSES")
print("="*70)

# For each loss, trace the MC trajectory and check canary conditions
# Canary: MC < 0.70 OR |floor - MC| > 0.15 (divergence)
# We check AFTER the compound was first established

def analyze_canary(gid, cps, mc_threshold=0.70, div_threshold=0.15):
    """Trace canary behavior after compound establishment."""
    # Find first Q4 compound checkpoint
    compound_idx = None
    for i, c in enumerate(cps):
        if c['period'] == 4 and c['mc'] >= 0.80 and c['floor'] >= 0.65:
            compound_idx = i
            break
    
    if compound_idx is None:
        return None
    
    # Track MC trajectory after compound
    mc_after = [c['mc'] for c in cps[compound_idx:]]
    floor_after = [c['floor'] for c in cps[compound_idx:]]
    
    min_mc = min(mc_after)
    
    # Check canary conditions after compound
    canary_mc = any(m < mc_threshold for m in mc_after)
    canary_div = any(abs(mc_after[j] - floor_after[j]) > div_threshold 
                     for j in range(len(mc_after)))
    canary_combined = canary_mc or canary_div
    
    # How early does canary fire? (snapshots before end)
    canary_fire_idx = None
    for j in range(len(mc_after)):
        mc_fire = mc_after[j] < mc_threshold
        div_fire = abs(mc_after[j] - floor_after[j]) > div_threshold
        if mc_fire or div_fire:
            canary_fire_idx = j
            break
    
    snapshots_remaining = len(mc_after) - canary_fire_idx if canary_fire_idx is not None else None
    
    # What was the trigger?
    trigger = None
    if canary_fire_idx is not None:
        mc_val = mc_after[canary_fire_idx]
        flr_val = floor_after[canary_fire_idx]
        if mc_val < mc_threshold and abs(mc_val - flr_val) > div_threshold:
            trigger = 'both'
        elif mc_val < mc_threshold:
            trigger = 'mc_drop'
        else:
            trigger = 'divergence'
    
    return {
        'min_mc': min_mc,
        'canary_mc': canary_mc,
        'canary_div': canary_div,
        'canary_combined': canary_combined,
        'snapshots_remaining': snapshots_remaining,
        'trigger': trigger,
        'mc_at_compound': mc_after[0],
        'mc_trajectory': mc_after,
        'compound_period': cps[compound_idx]['period'],
    }

# Run on losses
loss_results = []
for gid in compound_losses:
    cps = games[gid]
    result = analyze_canary(gid, cps)
    if result:
        loss_results.append(result)

# Run on wins (for false positive rate)
win_results = []
for gid in compound_wins:
    cps = games[gid]
    result = analyze_canary(gid, cps)
    if result:
        win_results.append(result)

print(f"\n  Losses analyzed: {len(loss_results)}")
print(f"  Wins analyzed: {len(win_results)}")

# ─── CANARY COVERAGE RESULTS ─────────────────────────────────────────────────

print(f"\n  === Canary coverage on LOSSES ===")
mc_caught = sum(1 for r in loss_results if r['canary_mc'])
div_caught = sum(1 for r in loss_results if r['canary_div'])
combined_caught = sum(1 for r in loss_results if r['canary_combined'])
n = len(loss_results)

print(f"    MC < 0.70 fires:        {mc_caught}/{n} = {mc_caught/n*100:.1f}%")
print(f"    Divergence > 0.15:      {div_caught}/{n} = {div_caught/n*100:.1f}%")
print(f"    Combined (OR):          {combined_caught}/{n} = {combined_caught/n*100:.1f}%")
print(f"    Completely silent:      {n - combined_caught}/{n} = {(n-combined_caught)/n*100:.1f}%")

# Sweep MC thresholds
print(f"\n  === MC threshold sweep (losses caught) ===")
for th in [0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50]:
    caught = sum(1 for r in loss_results if min(r['mc_trajectory']) < th)
    # Also check false positive rate on wins
    false_pos = sum(1 for r in win_results if min(r['mc_trajectory']) < th)
    print(f"    MC < {th}: catches {caught}/{n} losses ({caught/n*100:.1f}%), "
          f"false fires on {false_pos}/{len(win_results)} wins ({false_pos/len(win_results)*100:.1f}%)")

# Combined canary on WINS (false positive rate)
print(f"\n  === False positive rate on WINS ===")
win_mc = sum(1 for r in win_results if r['canary_mc'])
win_div = sum(1 for r in win_results if r['canary_div'])
win_combined = sum(1 for r in win_results if r['canary_combined'])
nw = len(win_results)
print(f"    MC < 0.70 fires on wins:    {win_mc}/{nw} = {win_mc/nw*100:.1f}%")
print(f"    Divergence > 0.15 on wins:  {win_div}/{nw} = {win_div/nw*100:.1f}%")
print(f"    Combined fires on wins:     {win_combined}/{nw} = {win_combined/nw*100:.1f}%")

# ─── TIMING: HOW EARLY DOES CANARY FIRE? ─────────────────────────────────────

print(f"\n  === Timing: How many snapshots before game end does canary fire? ===")
loss_timings = [r['snapshots_remaining'] for r in loss_results if r['snapshots_remaining'] is not None]
win_timings = [r['snapshots_remaining'] for r in win_results if r['snapshots_remaining'] is not None]

if loss_timings:
    loss_timings.sort(reverse=True)
    print(f"  Losses (canary fires, n={len(loss_timings)}):")
    print(f"    Mean: {sum(loss_timings)/len(loss_timings):.1f} snapshots before end")
    print(f"    Median: {loss_timings[len(loss_timings)//2]}")
    print(f"    p25/p75: {loss_timings[3*len(loss_timings)//4]} / {loss_timings[len(loss_timings)//4]}")
    
    # Bucket: fires with enough time to act (5+ snapshots = ~15+ min at checkpoint, ~7.5 min at snapshot)
    early = sum(1 for t in loss_timings if t >= 5)
    late = sum(1 for t in loss_timings if t < 3)
    print(f"    Fires 5+ snaps early (actionable): {early}/{len(loss_timings)}")
    print(f"    Fires <3 snaps from end (too late): {late}/{len(loss_timings)}")

# ─── TRIGGER TYPE BREAKDOWN ──────────────────────────────────────────────────

print(f"\n  === What triggers the canary on losses? ===")
triggers = defaultdict(int)
for r in loss_results:
    if r['trigger']:
        triggers[r['trigger']] += 1
    else:
        triggers['never_fires'] += 1

for t, count in sorted(triggers.items(), key=lambda x: -x[1]):
    print(f"    {t}: {count}")

# ─── THE SILENT LOSSES: WHAT DO THEY LOOK LIKE? ──────────────────────────────

print(f"\n  === Silent losses (canary never fires) ===")
silent = [r for r in loss_results if not r['canary_combined']]
print(f"  {len(silent)} losses where combined canary never fires after compound")

if silent:
    avg_min_mc = sum(r['min_mc'] for r in silent) / len(silent)
    print(f"  Avg minimum MC after compound: {avg_min_mc:.3f}")
    print(f"  MC range: {min(r['min_mc'] for r in silent):.3f} - {max(r['min_mc'] for r in silent):.3f}")
    
    # These are games where MC stays above 0.70 AND floor stays close to MC
    # throughout Q4, but ctrl still loses. True blind spot.
    
    # What's the margin profile?
    # We need to get the actual checkpoint data for these
    print(f"\n  These are the TRUE irreducible blind spot of the compound+canary system")

# ─── NET ACCURACY WITH CANARY ─────────────────────────────────────────────────

print(f"\n" + "="*70)
print("NET SYSTEM ACCURACY: Compound + Canary")
print("="*70)

# If canary fires → investigate → exit position
# If canary doesn't fire → hold position
# 
# Scenario: compound opens position. Canary fires on some wins (false positive)
# and some losses (true positive). Net accuracy?

for mc_th in [0.75, 0.70, 0.65]:
    # Losses caught by canary
    losses_caught = sum(1 for r in loss_results if min(r['mc_trajectory']) < mc_th)
    losses_missed = n - losses_caught
    
    # Wins incorrectly flagged by canary  
    wins_flagged = sum(1 for r in win_results if min(r['mc_trajectory']) < mc_th)
    wins_held = nw - wins_flagged
    
    # If we EXIT on canary fire:
    # Correct holds (win, no canary) + correct exits (loss, canary fires)
    correct = wins_held + losses_caught
    total = nw + n
    
    # But we also lose the wins that canary incorrectly flags
    print(f"\n  MC canary < {mc_th}:")
    print(f"    Compound alone: {nw}/{total} = {nw/total*100:.1f}%")
    print(f"    + Canary EXIT:  {correct}/{total} = {correct/total*100:.1f}%")
    print(f"    Improvement:    +{(correct/total - nw/total)*100:.1f}pp")
    print(f"    Catches {losses_caught}/{n} losses, false-flags {wins_flagged}/{nw} wins")
    print(f"    Remaining losses: {losses_missed}")

print("\n\nDone.")
