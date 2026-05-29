import json, numpy as np
from collections import defaultdict

rows=json.load(open('/tmp/wnba_cp_export.json'))

# Group by game, order by game_sec
games=defaultdict(list)
for r in rows: games[r['game_id']].append(r)
for g in games: games[g].sort(key=lambda r:r['game_sec'])

TOTAL_SEC=2400.0  # WNBA 40 min
rng=np.random.default_rng(42)
NSIM=1000

def poss_est(fga,fta,tov,oreb):
    # standard possession estimate
    return max(1.0, fga + 0.44*fta - oreb + tov)

def team_box(r, side):  # side 'h' or 'a'
    return dict(fgm=r[side+'_fgm'],fga=r[side+'_fga'],fg3m=r[side+'_fg3m'],
                ftm=r[side+'_ftm'],fta=r[side+'_fta'],tov=r[side+'_tov'],oreb=r[side+'_oreb'])

def points(b): return 2*(b['fgm']-b['fg3m']) + 3*b['fg3m'] + b['ftm']

def rates_from_box(b):
    """per-possession: P(make 3), P(make 2), expected FT pts/poss, PPP"""
    p=poss_est(b['fga'],b['fta'],b['tov'],b['oreb'])
    p3=b['fg3m']/p
    p2=(b['fgm']-b['fg3m'])/p
    ftpp=b['ftm']/p
    p3=min(max(p3,0),0.6); p2=min(max(p2,0),0.8)
    if p3+p2>0.95:
        s=0.95/(p3+p2); p3*=s; p2*=s
    return p3,p2,ftpp,p

def sim_winprob(ctrl_margin, ctrl_rates, opp_rates, rem_sec, ctrl_pace, opp_pace, nsim=NSIM):
    # remaining possessions per team from pace (poss/sec) * rem_sec
    Rc=int(round(max(0.0, ctrl_pace*rem_sec)))
    Ro=int(round(max(0.0, opp_pace*rem_sec)))
    if Rc==0 and Ro==0:
        return 1.0 if ctrl_margin>0 else (0.0 if ctrl_margin<0 else 0.5)
    Rc=min(Rc,80); Ro=min(Ro,80)
    def sim_team(rates,R):
        if R==0: return np.zeros(nsim)
        p3,p2,ftpp,_=rates
        u=rng.random((nsim,R))
        pts=np.where(u<p3,3.0,np.where(u<p3+p2,2.0,0.0))
        return pts.sum(axis=1)+ftpp*R
    cp=sim_team(ctrl_rates,Rc); op=sim_team(opp_rates,Ro)
    final=ctrl_margin+cp-op
    return float((final>0).mean() + 0.5*(final==0).mean())

out=[]
for gid,cps in games.items():
    prev=None
    for r in cps:
        ctrl_home = r['ctrl_is_home']
        cb=team_box(r,'h' if ctrl_home else 'a')
        ob=team_box(r,'a' if ctrl_home else 'h')
        gs=r['game_sec']; rem=TOTAL_SEC-gs
        # cumulative rates & pace
        c_p3c=rates_from_box(cb); o_p3c=rates_from_box(ob)
        c_pace=c_p3c[3]/gs; o_pace=o_p3c[3]/gs
        mc_cum=sim_winprob(r['margin'], c_p3c, o_p3c, rem, c_pace, o_pace)
        # windowed: delta vs previous checkpoint (same ctrl orientation needed)
        mc_win=mc_cum
        if prev is not None:
            pcb=team_box(prev,'h' if prev['ctrl_is_home'] else 'a')
            pob=team_box(prev,'a' if prev['ctrl_is_home'] else 'h')
            # only valid if ctrl team unchanged between checkpoints (else window orientation breaks)
            if prev['ctrl_team']==r['ctrl_team']:
                dcb={k:cb[k]-pcb[k] for k in cb}
                dob={k:ob[k]-pob[k] for k in ob}
                dt=gs-prev['game_sec']
                if poss_est(dcb['fga'],dcb['fta'],dcb['tov'],dcb['oreb'])>=2 and poss_est(dob['fga'],dob['fta'],dob['tov'],dob['oreb'])>=2 and dt>0:
                    cw=rates_from_box(dcb); ow=rates_from_box(dob)
                    cwp=cw[3]/dt; owp=ow[3]/dt
                    mc_win=sim_winprob(r['margin'], cw, ow, rem, cwp, owp)
        out.append({'game_id':gid,'cp':r['cp_label'],'period':r['period'],'gs':gs,
                    'ctrl':r['ctrl_team'],'ctrl_home':ctrl_home,'margin':r['margin'],
                    'ctrl_won':r['ctrl_won'],'floor':r['floor'],
                    'mc_cum':round(mc_cum,4),'mc_win':round(mc_win,4)})
        prev=r

json.dump(out, open('/tmp/wnba_mc_checkpoints.json','w'))
print('Computed MC for', len(out), 'checkpoints across', len(games), 'games')
# sanity: MC cum calibration vs outcome
import numpy as np
arr=out
for lo,hi in [(0.0,0.3),(0.3,0.5),(0.5,0.7),(0.7,0.9),(0.9,1.01)]:
    sub=[r for r in arr if lo<=r['mc_cum']<hi]
    if sub:
        wr=np.mean([r['ctrl_won'] for r in sub])
        print('  MC cum [{:.1f},{:.1f}): n={:<5} ctrl_won={:.2f} (calibration check)'.format(lo,hi,len(sub),wr))
