#!/usr/bin/env python3
# NBA 2026-27 season audit — regenerates every number in research/2026-10-31_nba_season_audit_FINDINGS.md
# Usage: DFT_AUTH='manny:...' python3 research/2026-10-31_nba_season_audit.py [--since 2026-10-20] [--cache DIR]
# Pulls: get_alerts, get_games, get_auto_analyses (grouped), history&game_id (per game, cached), get_learnings.
# Sections: (1) mechanical layer at quarter boundaries vs priors, (2) Opus FWP vs ESPN/XGB/MC same-moment,
# (3) every pushed stream, agent decisions, ranks, exit timing, arcs (invalidation bug corrected), cost,
# (4) pregame-stamp check. Read-only. No DB writes.
import os, sys, json, re, base64, time, argparse, collections, statistics, urllib.request
from concurrent.futures import ThreadPoolExecutor
ap=argparse.ArgumentParser(); ap.add_argument('--since',default='2026-10-20'); ap.add_argument('--cache',default='/tmp/dft_audit'); ap.add_argument('--league',default='nba')
args=ap.parse_args(); os.makedirs(args.cache,exist_ok=True)
B='https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api'
AUTH='Basic '+base64.b64encode(os.environ.get('DFT_AUTH','manny:DFT2025!').encode()).decode()
def get(q,tries=3):
    for t in range(tries):
        try:
            r=urllib.request.Request(f'{B}?{q}',headers={'Authorization':AUTH})
            with urllib.request.urlopen(r,timeout=90) as f: return json.loads(f.read().decode())
        except Exception as e:
            if t==tries-1: return {'_err':str(e)}
            time.sleep(2)
L=args.league
al=[a for a in get(f'action=get_alerts&league={L}&limit=5000').get('alerts',[]) if str(a.get('date',''))>=args.since]
games={g['id']:g for g in [v for v in get(f'action=get_games&league={L}&limit=1000').values() if isinstance(v,list)][0]}
ids=[g for g,v in games.items() if str(v.get('date',''))>=args.since and v.get('winner')]
aa=[]
for i in range(0,len(ids),40):
    r=get(f'action=get_auto_analyses&league={L}&game_ids='+','.join(ids[i:i+40]))
    for k,v in r.items():
        if isinstance(v,dict):
            for rows in v.values():
                if isinstance(rows,list): aa+=rows
cache=f'{args.cache}/hist_{L}.json'; H=json.load(open(cache)) if os.path.exists(cache) else {}
def pull(gid):
    r=get(f'action=history&game_id={gid}'); return gid,(r.get('snapshots') if isinstance(r,dict) else None)
with ThreadPoolExecutor(8) as ex:
    for gid,s in ex.map(pull,[i for i in ids if i not in H]):
        if s is not None: H[gid]=s
json.dump(H,open(cache,'w'))
print(f"tape: {len(ids)} games, {len(al)} alert rows, {sum(len(v) for v in H.values())} snapshots, {len(aa)} auto-analyses\n")
# ═══ SECTION 1: mechanical layer ═══
def clock_sec(c):
    m=re.match(r'(\d+):(\d+)',str(c or '')); return int(m.group(1))*60+int(m.group(2)) if m else None
def auc(pairs):
    # pairs of (score, label)
    pos=[s for s,l in pairs if l]; neg=[s for s,l in pairs if not l]
    if not pos or not neg: return None
    wins=0.0
    for p in pos:
        for n in neg: wins+= 1 if p>n else 0.5 if p==n else 0
    return wins/(len(pos)*len(neg))
def brier(pairs): return sum((s-(1 if l else 0))**2 for s,l in pairs)/len(pairs) if pairs else None

# Per game: pick the snapshot nearest each quarter boundary (end of Q1/Q2/Q3, and Q4 6:00) — "boundary" = first snapshot in next period
def boundary_snaps(snaps):
    out={}
    bp=sorted(snaps,key=lambda s:(s['period'] or 0, -(clock_sec(s['clock']) or 0)))
    for lbl,period in (('Q2',2),('Q3',3),('Q4',4)):
        cands=[s for s in bp if s['period']==period]
        if cands: out[lbl]=cands[0]  # first snapshot of that period ≈ previous quarter's end
    mid=[s for s in bp if s['period']==4 and (clock_sec(s['clock']) or 0)<=360]
    if mid: out['Q4_6']=mid[0]
    return out

rows=[]
for gid,snaps in H.items():
    g=games.get(gid); 
    if not g or not g.get('winner'): continue
    hA,aA,w=g['home_alias'],g['away_alias'],g['winner']
    for lbl,s in boundary_snaps(snaps).items():
        hp,ap=float(s.get('home_pts') or 0),float(s.get('away_pts') or 0)
        home_lead=hp-ap
        ft=s.get('floor_team'); fs=s.get('floor_score')
        xgb=s.get('xgb_win_prob'); mc=s.get('mc_cum_win_prob'); espn=s.get('espn_wp_home')
        # control-relative: is floor team the home team?
        rows.append(dict(gid=gid,lbl=lbl,period=s['period'],clock=s['clock'],home_lead=home_lead,
            ft=ft,fs=float(fs) if fs is not None else None,
            xgb=float(xgb) if xgb is not None else None, mc=float(mc) if mc is not None else None,
            espn=float(espn)/100 if espn is not None and float(espn)>1 else (float(espn) if espn is not None else None),
            ft_won=(ft==w) if ft and ft!='Neither' else None, home_won=(w==hA), margin_abs=abs(home_lead)))

print(f"boundary states: {len(rows)} across {len(set(r['gid'] for r in rows))} games\n")
print("MECHANICAL LAYER vs backtest priors (control-relative; xgb/mc are P(floor team wins))")
print(f"{'cut':14s} {'n':>4s}  {'floor>=.65 acc':>14s} {'xgb AUC':>8s} {'mc AUC':>7s} {'espn AUC':>8s}  {'mc>.70 acc (prior Q2 76/Q3 85/Q4 92)':>38s}  {'xgb Brier':>9s} {'mc Brier':>8s}")
for lbl in ('Q2','Q3','Q4','Q4_6'):
    R=[r for r in rows if r['lbl']==lbl and r['ft_won'] is not None]
    fl=[r for r in R if r['fs'] is not None and r['fs']>=0.65]
    fl_acc=sum(r['ft_won'] for r in fl)/len(fl) if fl else None
    xp=[(r['xgb'],r['ft_won']) for r in R if r['xgb'] is not None]
    mp=[(r['mc'],r['ft_won']) for r in R if r['mc'] is not None]
    ep=[(r['espn'],r['home_won']) for r in R if r['espn'] is not None]
    mh=[r for r in R if r['mc'] is not None and r['mc']>=0.70]
    mh_acc=sum(r['ft_won'] for r in mh)/len(mh) if mh else None
    f=lambda v,d=3: ('-' if v is None else f"{v:.{d}f}")
    print(f"{lbl:14s} {len(R):4d}  {f(fl_acc,2):>6s} (n={len(fl):3d})  {f(auc(xp)):>8s} {f(auc(mp)):>7s} {f(auc(ep)):>8s}  {f(mh_acc,2):>6s} (n={len(mh):3d})                   {f(brier(xp)):>9s} {f(brier(mp)):>8s}")

# close games only (|lead|<=8 at the cut) — the known failure mode
print("\nCLOSE GAMES ONLY (|margin| <= 8 at the cut):")
for lbl in ('Q3','Q4','Q4_6'):
    R=[r for r in rows if r['lbl']==lbl and r['ft_won'] is not None and r['margin_abs']<=8]
    fl=[r for r in R if r['fs'] is not None and r['fs']>=0.65]
    xp=[(r['xgb'],r['ft_won']) for r in R if r['xgb'] is not None]; mp=[(r['mc'],r['ft_won']) for r in R if r['mc'] is not None]
    mh=[r for r in R if r['mc'] is not None and r['mc']>=0.70]
    f=lambda v,d=3: ('-' if v is None else f"{v:.{d}f}")
    print(f"  {lbl:6s} n={len(R):3d} | floor>=.65 acc {f(sum(r['ft_won'] for r in fl)/len(fl) if fl else None,2)} (n={len(fl)}) | xgb AUC {f(auc(xp))} | mc AUC {f(auc(mp))} | mc>=.70 acc {f(sum(r['ft_won'] for r in mh)/len(mh) if mh else None,2)} (n={len(mh)})")

# Q4 disagreement: MC vs XGB — prior says MC right 87%
print("\nQ4 MC-vs-XGB DISAGREEMENT (prior: MC right 87%):")
R=[r for r in rows if r['lbl'] in ('Q4','Q4_6') and r['ft_won'] is not None and r['xgb'] is not None and r['mc'] is not None]
dis=[r for r in R if (r['xgb']>=0.5)!=(r['mc']>=0.5)]
mc_right=sum(((r['mc']>=0.5)==r['ft_won']) for r in dis)
print(f"  n={len(dis)} disagreements of {len(R)} | MC right {mc_right}/{len(dis)}")

# Opus FWP calibration (auto analyses): parse 'CHA 44% / DET 56%'
print("\nOPUS AUTO-ANALYSIS FWP (the 2,500-tok calibration call) vs XGB at the same moment:")
fw=[]
for a in aa:
    g=games.get(a['game_id']); 
    if not g or not g.get('winner'): continue
    m=re.match(r'([A-Z]{2,4})\s+(\d+)%\s*/\s*([A-Z]{2,4})\s+(\d+)%', str(a.get('fwp') or ''))
    if not m: continue
    t1,p1,t2,p2=m.group(1),int(m.group(2)),m.group(3),int(m.group(4))
    # control-relative: fwp for control team
    ct=a.get('control_team'); p=p1/100 if ct==t1 else p2/100 if ct==t2 else None
    if p is None: continue
    # nearest snapshot xgb/mc at that period/clock
    snaps=H.get(a['game_id'],[])
    cs=clock_sec(a['clock']); best=None
    for s in snaps:
        if s['period']==a['period'] and s.get('xgb_win_prob') is not None:
            d=abs((clock_sec(s['clock']) or 0)-(cs or 0))
            if best is None or d<best[0]: best=(d,s)
    xg=mc=None
    if best and best[0]<=90:
        s=best[1]; same=(s.get('floor_team')==ct)
        xg=float(s['xgb_win_prob']) if s.get('xgb_win_prob') is not None else None
        mc=float(s['mc_cum_win_prob']) if s.get('mc_cum_win_prob') is not None else None
        if not same and xg is not None: xg=1-xg
        if not same and mc is not None: mc=1-mc
    fw.append(dict(period=a['period'],p=p,won=(g['winner']==ct),xgb=xg,mc=mc,conv=a.get('conviction_tier')))
print(f"  n={len(fw)} parsed FWPs of {len(aa)} analyses")
for per in (1,2,3,'all'):
    R=[r for r in fw if per=='all' or r['period']==per]
    if not R: continue
    pp=[(r['p'],r['won']) for r in R]; xp=[(r['xgb'],r['won']) for r in R if r['xgb'] is not None]; mp=[(r['mc'],r['won']) for r in R if r['mc'] is not None]
    f=lambda v,d=3: ('-' if v is None else f"{v:.{d}f}")
    print(f"  trigger Q{per}: n={len(R):3d} | Opus FWP AUC {f(auc(pp))} Brier {f(brier(pp))} | XGB same-moment AUC {f(auc(xp))} Brier {f(brier(xp))} (n={len(xp)}) | MC AUC {f(auc(mp))} Brier {f(brier(mp))} (n={len(mp)})")
# calibration buckets for Opus
print("  Opus FWP calibration buckets (control team):")
for lo,hi in ((0,0.4),(0.4,0.55),(0.55,0.7),(0.7,0.85),(0.85,1.01)):
    R=[r for r in fw if lo<=r['p']<hi]
    if R: print(f"    {lo:.2f}-{min(hi,1):.2f}: n={len(R):3d} said {sum(r['p'] for r in R)/len(R)*100:.0f}% → won {sum(r['won'] for r in R)/len(R)*100:.0f}%")
print("  Conviction tier (mechanical, at the Opus trigger) → control team won:")
for t in ('DOMINANT','STRONG','MODEST','CONDITIONAL','NO ENTRY'):
    R=[r for r in fw if r['conv']==t]
    if R: print(f"    {t:12s} n={len(R):3d} won {sum(r['won'] for r in R)/len(R)*100:.0f}%")


# ═══ SECTION 2: Opus vs ESPN/XGB/MC same moment ═══
fw=[]
for a in aa:
    g=games.get(a['game_id'])
    if not g or not g.get('winner'): continue
    m=re.match(r'([A-Z]{2,4})\s+(\d+)%\s*/\s*([A-Z]{2,4})\s+(\d+)%', str(a.get('fwp') or ''))
    if not m: continue
    t1,p1,t2,p2=m.group(1),int(m.group(2)),m.group(3),int(m.group(4))
    ct=a.get('control_team'); p=p1/100 if ct==t1 else p2/100 if ct==t2 else None
    if p is None: continue
    snaps=H.get(a['game_id'],[]); cs=clock_sec(a['clock']); best=None
    for s in snaps:
        if s['period']==a['period'] and s.get('espn_wp_home') is not None:
            d=abs((clock_sec(s['clock']) or 0)-(cs or 0))
            if best is None or d<best[0]: best=(d,s)
    if not best or best[0]>120: continue
    s=best[1]; ct_home=(ct==g['home_alias'])
    e=float(s['espn_wp_home']); e=e/100 if e>1 else e; espn=e if ct_home else 1-e
    same=(s.get('floor_team')==ct)
    xg=s.get('xgb_win_prob'); mc=s.get('mc_cum_win_prob')
    xg=None if xg is None else (float(xg) if same else 1-float(xg))
    mc=None if mc is None else (float(mc) if same else 1-float(mc))
    hp,ap=float(s.get('home_pts') or 0),float(s.get('away_pts') or 0)
    cm=(hp-ap) if ct_home else (ap-hp)
    fw.append(dict(period=a['period'],p=p,espn=espn,xgb=xg,mc=mc,won=(g['winner']==ct),conv=a.get('conviction_tier'),cmargin=cm,ct=ct,gid=a['game_id']))
print(f"matched moments: n={len(fw)}")
print("\nHEAD-TO-HEAD at the SAME moment (control-relative P(win)); ESPN = free scoreboard+clock baseline")
print(f"{'trigger':10s} {'n':>4s} | {'Opus AUC':>8s} {'Brier':>6s} | {'ESPN AUC':>8s} {'Brier':>6s} | {'XGB AUC':>7s} {'Brier':>6s} | {'MC AUC':>6s} {'Brier':>6s}")
for per in (2,3,4,'all'):
    R=[r for r in fw if per=='all' or r['period']==per]
    if not R: continue
    P=[(r['p'],r['won']) for r in R]; E=[(r['espn'],r['won']) for r in R]
    X=[(r['xgb'],r['won']) for r in R if r['xgb'] is not None]; M=[(r['mc'],r['won']) for r in R if r['mc'] is not None]
    lbl=f"end Q{per-1}" if per!='all' else 'all'
    print(f"{lbl:10s} {len(R):4d} | {f(auc(P)):>8s} {f(brier(P)):>6s} | {f(auc(E)):>8s} {f(brier(E)):>6s} | {f(auc(X)):>7s} {f(brier(X)):>6s} | {f(auc(M)):>6s} {f(brier(M)):>6s}")
print("\nSame, CLOSE moments only (control team within ±8):")
for per in (2,3,4):
    R=[r for r in fw if r['period']==per and abs(r['cmargin'])<=8]
    if not R: continue
    P=[(r['p'],r['won']) for r in R]; E=[(r['espn'],r['won']) for r in R]; X=[(r['xgb'],r['won']) for r in R if r['xgb'] is not None]; M=[(r['mc'],r['won']) for r in R if r['mc'] is not None]
    print(f"end Q{per-1:<4d} {len(R):4d} | {f(auc(P)):>8s} {f(brier(P)):>6s} | {f(auc(E)):>8s} {f(brier(E)):>6s} | {f(auc(X)):>7s} {f(brier(X)):>6s} | {f(auc(M)):>6s} {f(brier(M)):>6s}")
print("\nWhere Opus and ESPN DISAGREE on the favorite (one >50%, other <50%):")
D=[r for r in fw if (r['p']>=0.5)!=(r['espn']>=0.5)]
print(f"  n={len(D)} | Opus right {sum((r['p']>=0.5)==r['won'] for r in D)} | ESPN right {sum((r['espn']>=0.5)==r['won'] for r in D)}")
print("\nCONVICTION TIER controlled for scoreboard (control team's margin at the trigger):")
for t in ('DOMINANT','STRONG','MODEST','CONDITIONAL'):
    for lo,hi,lb in ((-99,0,'trailing'),(0,8,'lead 0-8'),(8,99,'lead 9+')):
        R=[r for r in fw if r['conv']==t and lo<r['cmargin']<=hi] if lb!='trailing' else [r for r in fw if r['conv']==t and r['cmargin']<=0]
        if R: print(f"  {t:12s} {lb:9s} n={len(R):3d} won {100*sum(r['won'] for r in R)/len(R):3.0f}%  (ESPN said {100*sum(r['espn'] for r in R)/len(R):3.0f}%, Opus said {100*sum(r['p'] for r in R)/len(R):3.0f}%)")


# ═══ SECTION 3: streams, agent, arcs, cost ═══
EXIT_LIKE={'EXIT','TRACKING_INVALIDATED','XGB_INVALIDATED'}
STRESS={'MC_COLLAPSE'}
def ml2p(ml):
    ml=float(ml); return 100/(ml+100) if ml>0 else (-ml)/((-ml)+100)
def pnl(ml,win,stake=100):
    ml=float(ml); return (stake*(ml/100) if ml>0 else stake*(100/(-ml))) if win else -stake
def clock_sec(c):
    m=re.match(r'(\d+):(\d+)',str(c or '')); return int(m.group(1))*60+int(m.group(2)) if m else 0
def gt(a): return (a.get('period') or 0)*720+(720-clock_sec(a.get('clock')))
rows=[]
for a in al:
    g=games.get(a['game_id'])
    if not g or not g.get('winner'): continue
    team=a.get('position_team') or a.get('control_team')
    won=(g['winner']==team)
    t=a['alert_type']
    correct = (not won) if t in EXIT_LIKE else won
    rows.append(dict(a, team=team, won=won, correct=correct, matchup=g['matchup'], sent=(a.get('ntfy_sent') is True), gt=gt(a)))
print(f"scored rows: {len(rows)} of {len(al)} season rows ({len(set(r['game_id'] for r in rows))} games)\n")

# ── 1. VOLUME & COST ──
nights=len(set(str(r['date'])[:10] for r in rows))
print(f"── VOLUME ({nights} slate nights) ──")
c=collections.Counter(r['alert_type'] for r in rows); s=collections.Counter(r['alert_type'] for r in rows if r['sent'])
agent_calls=collections.Counter()
for r in rows:
    t=r['alert_type']; d=r.get('agent_decision')
    if t=='AUTO_ANALYSIS':
        agent_calls['AUTO_ANALYSIS calibration Opus (2.5k tok)']+=1
        if not (d=='SUPPRESS' and 'position gate' in str(r.get('agent_reasoning') or '')): agent_calls['AUTO_ANALYSIS position-update agent']+=1
    elif t=='XGB_INVALIDATED': agent_calls['XGB_INVALIDATED narrative']+=1
    elif d in ('SEND','SUPPRESS','DOWNGRADE','FALLBACK_SEND','FALLBACK_DROP'): agent_calls['alert agent (routeV2Alert)']+=1
for t,n in c.most_common(): print(f"  {t:22s} rows {n:4d}  pushed {s[t]:4d}")
print(f"  pushes/night ≈ {sum(s.values())/nights:.0f}")
print("  Opus calls by path (season):")
for k,v in agent_calls.most_common(): print(f"    {k:42s} {v:4d}  (≈{v/nights:.0f}/night)")

# ── 2. EVERY PUSHED STREAM scored ──
print("\n── PUSHED STREAMS (what hit your phone) — correct = team won (exit-types: team lost) ──")
print(f"{'type':22s} {'n':>4s} {'correct':>8s} {'win%':>5s}  {'priced':>6s} {'flat-$100 ROI':>13s} {'implied→real':>13s}")
for t,_ in c.most_common():
    R=[r for r in rows if r['alert_type']==t and r['sent']]
    if not R: continue
    cor=sum(r['correct'] for r in R)
    P=[r for r in R if r.get('ml') not in (None,0) and t not in EXIT_LIKE]
    roi=f"{100*sum(pnl(r['ml'],r['won']) for r in P)/(100*len(P)):+.1f}%" if P else '-'
    imp=f"{100*sum(ml2p(r['ml']) for r in P)/len(P):.0f}%→{100*sum(r['won'] for r in P)/len(P):.0f}%" if P else '-'
    print(f"{t:22s} {len(R):4d} {cor:8d} {100*cor/len(R):4.0f}%  {len(P):6d} {roi:>13s} {imp:>13s}")

# ── 3. AGENT VALUE per type ──
print("\n── AGENT DECISIONS per type (routeV2Alert path) — 'correct' as above ──")
print(f"{'type':22s} {'SEND':>12s} {'DOWNGRADE':>12s} {'SUPPRESS':>12s} {'XGB_SUPPRESS':>13s}")
tot=collections.Counter()
for t in ['BUY','BWC_EDGE','POSITION_OPEN','POSITION_SAFE','POSITION_RECOVERING','VALUE','EXIT','THESIS_ALIVE','TRACKING']:
    cells=[]
    for d in ('SEND','DOWNGRADE','SUPPRESS','XGB_SUPPRESS'):
        R=[r for r in rows if r['alert_type']==t and r.get('agent_decision')==d]
        cells.append(f"{sum(r['correct'] for r in R)}/{len(R)}" if R else '-')
        tot[(d,'c')]+=sum(r['correct'] for r in R); tot[(d,'n')]+=len(R)
    print(f"{t:22s} {cells[0]:>12s} {cells[1]:>12s} {cells[2]:>12s} {cells[3]:>13s}")
print(f"{'ALL':22s} "+' '.join(f"{tot[(d,'c')]}/{tot[(d,'n')]} ({100*tot[(d,'c')]/max(1,tot[(d,'n')]):.0f}%)".rjust(12 if d!='XGB_SUPPRESS' else 13) for d in ('SEND','DOWNGRADE','SUPPRESS','XGB_SUPPRESS')))
sup=[r for r in rows if r.get('agent_decision')=='SUPPRESS' and r['alert_type']!='AUTO_ANALYSIS']
print(f"  Agent SUPPRESS (non-AUTO): {len(sup)} rows → would-have-been-wrong {sum(not r['correct'] for r in sup)} (saves), would-have-been-right {sum(r['correct'] for r in sup)} (missed)")
xs=[r for r in rows if r.get('agent_decision')=='XGB_SUPPRESS']
print(f"  XGB gate SUPPRESS: {len(xs)} rows → saves {sum(not r['correct'] for r in xs)}, missed {sum(r['correct'] for r in xs)}")

# ── 4. POSITION_OPEN by rank vs priors ──
print("\n── POSITION_OPEN by graduation rank (priors: CONFIRMED 86% / RECOVERING 73% / LOCKED 92%) ──")
po=[r for r in rows if r['alert_type']=='POSITION_OPEN' and r['sent']]
for rk in ('CONFIRMED','RECOVERING','LOCKED',None):
    R=[r for r in po if r.get('graduation_rank')==rk]
    if R:
        close=[r for r in R if abs(float(r.get('margin') or 0))<=8]
        print(f"  {str(rk):11s} n={len(R):3d} won {100*sum(r['won'] for r in R)/len(R):3.0f}% | at margin ≤8: {sum(r['won'] for r in close)}/{len(close)} | margin >8: {sum(r['won'] for r in R)-sum(r['won'] for r in close)}/{len(R)-len(close)}")
P=[r for r in po if r.get('ml') not in (None,0)]
if P: print(f"  priced n={len(P)}: avg ML {sum(float(r['ml']) for r in P)/len(P):+.0f}, implied {100*sum(ml2p(r['ml']) for r in P)/len(P):.0f}% → won {100*sum(r['won'] for r in P)/len(P):.0f}%, flat-$100 ROI {100*sum(pnl(r['ml'],r['won']) for r in P)/(100*len(P)):+.1f}%")

# ── 5. EXIT-class quality ──
print("\n── EXIT-CLASS (pushed): correct = position team LOST ──")
for t in ('EXIT','TRACKING_INVALIDATED','XGB_INVALIDATED','MC_COLLAPSE'):
    R=[r for r in rows if r['alert_type']==t and r['sent']]
    if R:
        lost=sum(not r['won'] for r in R)
        print(f"  {t:21s} n={len(R):3d} team lost {lost} ({100*lost/len(R):.0f}%) | avg margin at fire {sum(float(r.get('margin') or 0) for r in R)/len(R):+.1f}")

# ── 6. ARCS — nightly convention, with the invalidation-name bug CORRECTED ──
print("\n── POSITION ARCS (nightly convention; terminal = last non-TRACKING pushed alert) ──")
HOLD={'POSITION_OPEN','BWC_EDGE','POSITION_SAFE','POSITION_RECOVERING','AUTO_ANALYSIS','MC_COLLAPSE'}
byk=collections.defaultdict(list)
for r in rows:
    if r['sent'] or (r.get('ntfy_sent') is None and r.get('agent_decision') not in ('SUPPRESS','FALLBACK_DROP')): byk[(r['game_id'],r['team'])].append(r)
arcs=[]
for (gid,team),L in byk.items():
    L=sorted(L,key=lambda r:r['gt']); nt=[r for r in L if r['alert_type']!='TRACKING']
    if not nt: continue
    term=nt[-1]
    won=term['won']
    corr_fixed = (not won) if term['alert_type'] in EXIT_LIKE else won
    corr_buggy = (not won) if term['alert_type'] in {'EXIT','TRACKING_INVALIDATED'} else won   # nightly's list misses XGB_INVALIDATED
    arcs.append(dict(gid=gid,team=team,matchup=term['matchup'],terminal=term['alert_type'],won=won,fixed=corr_fixed,buggy=corr_buggy,
        arc='standalone_buy' if all(r['alert_type'] in ('BUY','XGB_INVALIDATED') for r in nt) else 'lifecycle', n=len(nt), tmargin=float(term.get('margin') or 0)))
print(f"  arcs {len(arcs)} | CORRECT scoring: {sum(a['fixed'] for a in arcs)}/{len(arcs)} = {100*sum(a['fixed'] for a in arcs)/len(arcs):.0f}% | nightly's (bugged) scoring: {sum(a['buggy'] for a in arcs)}/{len(arcs)} = {100*sum(a['buggy'] for a in arcs)/len(arcs):.0f}%")
for at in ('lifecycle','standalone_buy'):
    A=[a for a in arcs if a['arc']==at]; print(f"  {at:15s} n={len(A):3d} correct {100*sum(a['fixed'] for a in A)/max(1,len(A)):.0f}%")
print("  by terminal type:")
for t,n in collections.Counter(a['terminal'] for a in arcs).most_common():
    A=[a for a in arcs if a['terminal']==t]; print(f"    {t:21s} n={len(A):3d} correct {100*sum(a['fixed'] for a in A)/len(A):3.0f}%")
close=[a for a in arcs if abs(a['tmargin'])<=8 and a['terminal'] in HOLD|{'BUY','VALUE','THESIS_ALIVE'}]
print(f"  hold/entry-type terminals at margin ≤8: {sum(a['fixed'] for a in close)}/{len(close)} = {100*sum(a['fixed'] for a in close)/max(1,len(close)):.0f}%  (≥9: {sum(a['fixed'] for a in arcs if a not in close and a['terminal'] in HOLD|{'BUY','VALUE','THESIS_ALIVE'})}/{len([a for a in arcs if a not in close and a['terminal'] in HOLD|{'BUY','VALUE','THESIS_ALIVE'}])})")
# conflicts / flips
gteams=collections.defaultdict(set)
for a in arcs: gteams[a['gid']].add(a['team'])
conf=[g for g,t in gteams.items() if len(t)>1]
print(f"  games with arcs on BOTH teams (conflicting signals): {len(conf)} of {len(gteams)}")
fb=[r for r in rows if r.get('is_flip_buy')]
print(f"  flip-BUY rows: {len(fb)} | won {sum(r['won'] for r in fb)}")
_lr=get(f'action=get_learnings&league={L}&limit=30'); learn=_lr.get('learnings') if isinstance(_lr,dict) and isinstance(_lr.get('learnings'),list) else []
print("\n── NIGHTLY LEARNINGS (as stored by post-game-agent, bugged scorer) ──")
for l in sorted(learn,key=lambda x:str(x['date'])):
    if str(l['date'])>='2026-10-20': print(f"  {str(l['date'])[:10]} arcs {l.get('alerts_scored')} acc {l.get('accuracy_overall')} agent_acc {l.get('agent_accuracy')} games {l.get('games_analyzed')}")


# ═══ SECTION 4: pregame-stamp check ═══
R=[r for r in rows if r['alert_type']=='POSITION_OPEN' and r['sent'] and r.get('ml') not in (None,0) and float(r.get('margin') or 0)>=9]
pos=[r for r in R if float(r['ml'])>0]
print(f"\nPOSITION_OPEN leading by 9+ with a PLUS-money ML stamp on the leader: {len(pos)}/{len(R)}  (pregame line carried as live)")
for r in sorted(pos,key=lambda r:float(r['ml']),reverse=True)[:10]:
    print(f"  {str(r['date'])[5:10]} {r['matchup']:8s} {r['team']:4s} Q{r['period']} {str(r['clock']):>5s} up {r['margin']} ML {float(r['ml']):+.0f} -> {'WIN' if r['won'] else 'LOSS'}")
