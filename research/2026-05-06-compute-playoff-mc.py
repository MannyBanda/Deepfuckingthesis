#!/usr/bin/env python3
"""Compute MC Cum on production playoff snapshots — FIXED score source."""
import json, random
random.seed(42)

with open('/tmp/all_playoff_snapshots.json') as f:
    all_data = json.load(f)

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

def parse_clock(time_str):
    if not time_str: return 0
    parts = time_str.strip().split(' ')
    clock_part = parts[-1]
    try:
        mm, ss = clock_part.split(':')
        return int(mm)*60 + int(ss)
    except:
        return 0

results = {}
total_computed = 0

for gid, gdata in all_data.items():
    label = gdata['label']
    rows = gdata['rows']
    
    # Extract home/away from label: "AWAY@HOME DATE ..."
    matchup = label.split(' ')[0]
    away_alias, home_alias = matchup.split('@')
    
    game_timeline = []
    
    for r in rows:
        period = r.get('period', 0)
        if period < 2: continue
        if r.get('source') != 'server': continue
        
        rsj = r.get('raw_stats_json')
        if not rsj: continue
        if isinstance(rsj, str): rsj = json.loads(rsj)
        
        home_stats = rsj.get('home', {})
        away_stats = rsj.get('away', {})
        if not home_stats.get('fga'): continue
        
        floor_team = r.get('floor_team', '')
        floor = r.get('floor_score')
        xgb = r.get('xgb_win_prob')
        mc_pbp = r.get('mc_win_prob')
        mc_cum_stored = r.get('mc_cum_win_prob')
        
        # Scores from snapshot top level
        h_pts = int(r.get('home_pts', 0) or 0)
        a_pts = int(r.get('away_pts', 0) or 0)
        
        ctrl = floor_team
        if not ctrl: continue
        cih = (ctrl == home_alias)
        
        csec = parse_clock(r.get('clock', ''))
        rp = est_rem(home_stats, away_stats, period, csec)
        if rp < 1: continue
        
        hr = to_rates(home_stats)
        ar = to_rates(away_stats)
        if not hr or not ar: continue
        
        mc_cum = run_mc(hr, ar, h_pts, a_pts, rp, 300, cih)
        total_computed += 1
        
        ctrl_margin = (h_pts - a_pts) if cih else (a_pts - h_pts)
        
        game_timeline.append({
            'per': period,
            'mc': mc_cum,
            'mc_stored': float(mc_cum_stored) if mc_cum_stored is not None else None,
            'pbp': float(mc_pbp) if mc_pbp is not None else None,
            'flr': float(floor) if floor is not None else None,
            'xgb': float(xgb) if xgb is not None else None,
            'ctrl': ctrl,
            'mar': ctrl_margin,
        })
    
    if game_timeline:
        results[gid] = {'label': label, 'home': home_alias, 'away': away_alias, 'tl': game_timeline}

print(f"Computed {total_computed} MC Cum values across {len(results)} games\n")

# Print summary sorted by date
for gid, d in sorted(results.items(), key=lambda x: x[1]['label']):
    tl = d['tl']
    mc_vals = [t['mc'] for t in tl]
    # Get winner from label
    winner_info = d['label'].split('(')[1].rstrip(')')
    winner_team = winner_info.split('+')[0]
    
    # Did ctrl team win?
    main_ctrl = max(set(t['ctrl'] for t in tl), key=[t['ctrl'] for t in tl].count)
    ctrl_won = main_ctrl == winner_team
    
    avg_mc = sum(mc_vals)/len(mc_vals)
    q4_mc = [t['mc'] for t in tl if t['per'] == 4]
    avg_q4 = sum(q4_mc)/len(q4_mc) if q4_mc else 0
    
    status = "✓" if ctrl_won else "✗"
    print(f"  {status} {d['label'][:42]:42s} ctrl={main_ctrl:3s} | MC avg={avg_mc:.3f} | Q4 MC={avg_q4:.3f}")

with open('/tmp/playoff_mc_cum_fixed.json', 'w') as f:
    json.dump(results, f)
