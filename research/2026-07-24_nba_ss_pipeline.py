import json, base64, urllib.request, time
B="https://poetic-starlight-aa8938.netlify.app/.netlify/functions/backtest-nba-snapshots"
auth=base64.b64encode(b"manny:DFT2025!").decode()
rows=[]; off=0
while True:
    url=f"{B}?phase=export_xgb&limit=2000&offset={off}"
    r=urllib.request.Request(url, headers={"Authorization":"Basic "+auth})
    d=json.load(urllib.request.urlopen(r, timeout=120))
    if 'error' in d: print("ERR",d['error']); break
    rows+=d['rows']; print(off, len(d['rows']), 'total', d['total'], flush=True)
    if not d['has_more']: break
    off+=2000; time.sleep(0.5)
json.dump(rows, open('bt_rows.json','w'))
print("SAVED", len(rows))
import json, urllib.request, time
KEY="ee78e074-2f89-4ee5-807a-181fc324398c"
def get(u):
    r=urllib.request.Request(u, headers={"Authorization":KEY})
    return json.load(urllib.request.urlopen(r, timeout=90))
games=[]; cursor=None
while True:
    u=f"https://api.balldontlie.io/nba/v1/games?seasons[]=2025&per_page=100"
    if cursor: u+=f"&cursor={cursor}"
    d=get(u); games+=d['data']
    cursor=d.get('meta',{}).get('next_cursor')
    print(len(games), 'cursor', cursor, flush=True)
    if not cursor: break
    time.sleep(0.25)
json.dump(games, open('bdl_2025.json','w'))
print("SAVED", len(games))
import json, collections
bt=json.load(open('bt_rows.json')); bdl=json.load(open('bdl_2025.json'))
rs=[g for g in bdl if not g.get('postseason') and g.get('status')=='Final']
rs.sort(key=lambda g:(g['date'], g['id']))

# ── as-of ledger: strictly pre-game, within-season, RS only ──
rec=collections.defaultdict(lambda:[0,0])   # alias -> [w,l]
asof={}                                      # game_id -> {alias:(w,l)}
for g in rs:
    h=g['home_team']['abbreviation']; a=g['visitor_team']['abbreviation']
    asof[g['id']]={h:tuple(rec[h]), a:tuple(rec[a])}
    hs,vs=g['home_team_score'],g['visitor_team_score']
    if hs>vs: rec[h][0]+=1; rec[a][1]+=1
    else:     rec[a][0]+=1; rec[h][1]+=1

meta={g['id']:g for g in rs}
def wp(t):
    w,l=t; n=w+l
    return (w/n if n else None), n

def efg(s):
    fga=s.get('fga') or 0
    return ((s.get('fgm') or 0)+0.5*(s.get('fg3m') or 0))/fga if fga else None

spots=[]
for r in bt:
    gid=r['game_id']
    if gid not in meta or gid not in asof: continue
    cp=r['checkpoint']
    m=r['margin']; fm=r['final_margin']
    if m is None or fm is None or m==0: continue
    h,a=r['home_alias'], r['away_alias']
    led=asof[gid]
    if h not in led or a not in led: continue
    hwp,hgp=wp(led[h]); awp,agp=wp(led[a])
    if hwp is None or awp is None: continue
    if hgp<4 or agp<4: continue                      # min GP gate
    trailer = h if m<0 else a                        # margin = home-away
    leader  = a if m<0 else h
    twp = hwp if trailer==h else awp
    lwp = hwp if leader==h else awp
    deficit = abs(m)
    twon = (fm>0) if trailer==h else (fm<0)
    ts=r.get('team_stats') or {}
    lead_efg = efg(ts.get('home') if leader==h else ts.get('away') or {})
    tr_efg   = efg(ts.get('home') if trailer==h else ts.get('away') or {})
    ind=r.get('ind') or {}
    spots.append(dict(gid=gid, date=meta[gid]['date'], cp=cp, period=r['period'],
        trailer=trailer, leader=leader, twp=twp, lwp=lwp, gap=twp-lwp,
        deficit=deficit, twon=bool(twon), floor=ind.get('score'),
        ctrl=ind.get('controlTeam'), tier=(r.get('conv') or {}).get('tier'),
        lead_efg=lead_efg, tr_efg=tr_efg, tgp=(hgp if trailer==h else agp),
        lgp=(hgp if leader==h else agp)))
json.dump(spots, open('spots.json','w'))
print('spot-rows',len(spots),'games',len(set(s["gid"] for s in spots)))
print('by cp:',collections.Counter(s['cp'] for s in spots).most_common(4))
import json, collections, math
S=json.load(open('spots.json'))
def wil(k,n):
    if not n: return (0,0)
    p=k/n; z=1.96; d=1+z*z/n
    c=(p+z*z/(2*n))/d; m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return (100*(c-m),100*(c+m))
def rate(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    lo,hi=wil(k,n)
    return f"{100*k/n:5.1f}%  n={n:<4} [{lo:.0f}-{hi:.0f}]" if n else "  --   n=0"
def pw(label,rows): print(f"  {label:<26}{rate(rows)}")

print("="*66); print("E1 — BASE SIGNAL, deficit 1-9, RS 2025-26 (n=1,172 games)"); print("="*66)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9]
    print(f"\n{cp}   (in-band spots: {len(band)}, = distinct games)")
    pw("ALL trailers", band)
    pw("WORSE-team trailer (gap<0)", [s for s in band if s['gap']<0])
    pw("BETTER-team trailer (gap>0)",[s for s in band if s['gap']>0])
    for lo,hi,lab in [(.10,9,'gap >= .10'),(.15,9,'gap >= .15'),(.20,9,'gap >= .20'),(.30,9,'gap >= .30')]:
        pw("  "+lab, [s for s in band if s['gap']>=lo])
print("\n"+"="*66); print("PUBLISHED BENCHMARKS: Q3_END worse 22% -> better 58% (gap-cond)")
print("                     all-better-trailers 47.3% (Jul-23 re-cut)"); print("="*66)
import json, math
S=json.load(open('spots.json'))
def wil(k,n):
    if not n: return (0,0)
    p=k/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d
    m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-m),100*(c+m))
def rate(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    if not n: return "  --    n=0"
    lo,hi=wil(k,n); return f"{100*k/n:5.1f}%  n={n:<4} [{lo:.0f}-{hi:.0f}]"

print("="*70); print("E2 — MECHANICAL 2x2: production floor gate vs quality-gap gate")
print("BUY gate = floor>=0.65 AND control team IS the trailer"); print("="*70)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9 and s['floor'] is not None]
    print(f"\n{cp}  (n={len(band)} games in band)")
    buy = lambda s: s['floor']>=0.65 and s['ctrl']==s['trailer']
    gap = lambda s: s['gap']>0
    cells=[("BOTH gates",       [s for s in band if buy(s) and gap(s)]),
           ("BUY only (floor)", [s for s in band if buy(s) and not gap(s)]),
           ("GAP only",         [s for s in band if not buy(s) and gap(s)]),
           ("NEITHER",          [s for s in band if not buy(s) and not gap(s)])]
    for lab,rows in cells: print(f"   {lab:<20}{rate(rows)}")
    print(f"   {'-- marginals --':<20}")
    print(f"   {'floor gate ON':<20}{rate([s for s in band if buy(s)])}")
    print(f"   {'gap gate ON':<20}{rate([s for s in band if gap(s)])}")
    print(f"   {'base (all in band)':<20}{rate(band)}")

print("\n"+"="*70); print("Floor gate sensitivity (better-team trailers only, gap>0)"); print("="*70)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9 and s['floor'] is not None and s['gap']>0]
    print(f"\n{cp}")
    for lo in [0.0,0.50,0.55,0.60,0.65,0.70]:
        sub=[s for s in band if s['ctrl']==s['trailer'] and s['floor']>=lo] if lo>0 else band
        lab=f"floor>={lo:.2f} & ctrl=trailer" if lo>0 else "no floor gate"
        print(f"   {lab:<28}{rate(sub)}")
import json, math, statistics as st
S=json.load(open('spots.json'))
def wil(k,n):
    if not n: return (0,0)
    p=k/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d
    m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-m),100*(c+m))
def rate(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    if not n: return "  --    n=0"
    lo,hi=wil(k,n); return f"{100*k/n:5.1f}%  n={n:<4} [{lo:.0f}-{hi:.0f}]"

print("="*72); print("CONFOUND CHECK — is the floor lift just selecting bigger gaps?"); print("="*72)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9 and s['floor'] is not None and s['gap']>0]
    on =[s for s in band if s['floor']>=0.65 and s['ctrl']==s['trailer']]
    off=[s for s in band if not(s['floor']>=0.65 and s['ctrl']==s['trailer'])]
    print(f"\n{cp}: mean gap  floor-gate ON {st.mean(s['gap'] for s in on):.3f} (n={len(on)})  "
          f"vs OFF {st.mean(s['gap'] for s in off):.3f} (n={len(off)})")
    print(f"        mean deficit ON {st.mean(s['deficit'] for s in on):.1f}  vs OFF {st.mean(s['deficit'] for s in off):.1f}")
    print("   -- floor gate WITHIN gap strata --")
    for lo,hi,lab in [(0,.15,'gap .00-.15'),(.15,.30,'gap .15-.30'),(.30,9,'gap >= .30')]:
        st_=[s for s in band if lo<=s['gap']<hi]
        y=[s for s in st_ if s['floor']>=0.65 and s['ctrl']==s['trailer']]
        n_=[s for s in st_ if not(s['floor']>=0.65 and s['ctrl']==s['trailer'])]
        print(f"     {lab:<12} floor ON {rate(y)}   | OFF {rate(n_)}")

print("\n"+"="*72); print("E5 — DEFICIT BAND (better-team trailers, gap>0)"); print("="*72)
for cp in ['Q2_END','Q3_END']:
    print(f"\n{cp}")
    for lo,hi in [(1,3),(4,6),(7,9),(10,15)]:
        sub=[s for s in S if s['cp']==cp and lo<=s['deficit']<=hi and s['gap']>0]
        print(f"   down {lo}-{hi:<3}{rate(sub)}")

print("\n"+"="*72); print("E5 — WHOSE VARIANCE proxy: leader eFG at checkpoint (in-band, gap>0)"); print("="*72)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9 and s['gap']>0 and s['lead_efg']]
    q=sorted(s['lead_efg'] for s in band); n=len(q)
    t1,t2=q[n//3],q[2*n//3]
    print(f"\n{cp}  (tertiles at eFG {t1:.3f} / {t2:.3f})")
    print(f"   leader eFG LOW  (cold) {rate([s for s in band if s['lead_efg']<t1])}")
    print(f"   leader eFG MID         {rate([s for s in band if t1<=s['lead_efg']<t2])}")
    print(f"   leader eFG HIGH (hot)  {rate([s for s in band if s['lead_efg']>=t2])}")
import json, math
S=json.load(open('spots.json'))
def wil(k,n):
    if not n: return (0,0)
    p=k/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d
    m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-m),100*(c+m))
def rate(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    if not n: return "   --   n=0  "
    lo,hi=wil(k,n); return f"{100*k/n:5.1f}% n={n:<3} [{lo:.0f}-{hi:.0f}]"

print("="*74)
print("E2b — DECISIVE: does floor add anything WITHIN deficit strata? (gap>0)")
print("="*74)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9 and s['floor'] is not None and s['gap']>0]
    print(f"\n{cp}")
    print(f"   {'deficit':<10}{'floor gate ON':<24}{'floor gate OFF':<24}delta")
    for lo,hi in [(1,3),(4,6),(7,9)]:
        st_=[s for s in band if lo<=s['deficit']<=hi]
        y=[s for s in st_ if s['floor']>=0.65 and s['ctrl']==s['trailer']]
        n_=[s for s in st_ if not(s['floor']>=0.65 and s['ctrl']==s['trailer'])]
        dy=100*sum(1 for r in y if r['twon'])/len(y) if y else None
        dn=100*sum(1 for r in n_ if r['twon'])/len(n_) if n_ else None
        d=f"{dy-dn:+.1f}pp" if dy is not None and dn is not None else "  --"
        print(f"   down {lo}-{hi:<5}{rate(y):<24}{rate(n_):<24}{d}")

print("\n"+"="*74)
print("Floor as CONTINUOUS predictor within band (gap>0), deficit-matched 1-9")
print("="*74)
for cp in ['Q2_END','Q3_END']:
    band=[s for s in S if s['cp']==cp and 1<=s['deficit']<=9 and s['floor'] is not None and s['gap']>0]
    # trailer-relative floor: floor if ctrl==trailer else 1-floor
    for s in band: s['tfloor']=s['floor'] if s['ctrl']==s['trailer'] else 1-s['floor']
    q=sorted(s['tfloor'] for s in band); n=len(q); t1,t2=q[n//3],q[2*n//3]
    print(f"\n{cp}  trailer-relative floor tertiles at {t1:.2f} / {t2:.2f}")
    print(f"   LOW  {rate([s for s in band if s['tfloor']<t1])}")
    print(f"   MID  {rate([s for s in band if t1<=s['tfloor']<t2])}")
    print(f"   HIGH {rate([s for s in band if s['tfloor']>=t2])}")
import json
bt=json.load(open('bt_rows.json')); spots=json.load(open('spots.json'))
row={(r['game_id'],r['checkpoint']):r for r in bt}
marg={}  # (gid,cp)->margin for trajectory
for r in bt: marg[(r['game_id'],r['checkpoint'])]=r['margin']

out=[]
for s in spots:
    r=row.get((s['gid'],s['cp']))
    if not r: continue
    ts=r.get('team_stats') or {}; pbp=r.get('pbp') or {}; ind=r.get('ind') or {}; conv=r.get('conv') or {}
    h,a=r['home_alias'],r['away_alias']
    L,T=s['leader'],s['trailer']
    def side(x): return 'h' if x==h else 'a'
    def st(x,k): return ((ts.get('home' if x==h else 'away') or {}).get(k)) or 0
    f=dict(s)
    # leader variance-composition proxies
    lp=st(L,'pts')
    f['l_3share']= 3*st(L,'fg3m')/lp if lp else None       # share of leader pts from 3
    f['l_ftshare']= st(L,'ftm')/lp if lp else None
    f['l_paint']  = pbp.get(side(L)+'Paint'); f['t_paint']=pbp.get(side(T)+'Paint')
    lr_a,lr_m = pbp.get(side(L)+'RimA'), pbp.get(side(L)+'RimM')
    f['l_rimpct'] = (lr_m/lr_a) if lr_a else None
    tr_a,tr_m = pbp.get(side(T)+'RimA'), pbp.get(side(T)+'RimM')
    f['t_rimpct'] = (tr_m/tr_a) if tr_a else None
    tfgm=st(T,'fgm')
    f['t_astrate']= st(T,'ast')/tfgm if tfgm else None      # trailer assisted rate (structure)
    f['l_to']=st(L,'to'); f['t_to']=st(T,'to')
    # lead class: leader biggest lead vs current deficit
    lbig=pbp.get(side(L)+'BigLead')
    f['l_biglead']=lbig
    f['lead_decay']=(lbig - s['deficit']) if lbig is not None else None   # >0 = lead off its peak
    # trailer-relative indicators (ind values are control-relative won=1/even=.5/lost=0)
    ctrl=ind.get('controlTeam')
    inv = (ctrl!=T)
    for k in ('I1','I2','I3','I4','I5'):
        v=ind.get(k)
        f['t'+k]= (1-v if inv else v) if v is not None else None
    f['tfloor']= (ind.get('score') if ctrl==T else (1-ind['score'] if ind.get('score') is not None else None))
    f['conv_tier']=conv.get('tier'); f['ctrl_is_trailer']=(ctrl==T)
    # trajectory: deficit compression Q2_END -> Q3_END (only meaningful for Q3_END spots)
    if s['cp']=='Q3_END':
        m2=marg.get((s['gid'],'Q2_END'))
        if m2 is not None:
            # deficit from trailer's perspective at Q2_END (trailer fixed as of Q3)
            d2 = -m2 if T==h else m2
            f['deficit_q2']=d2
            f['compress']= d2 - s['deficit']    # >0 trailer closing, <0 falling behind
    out.append(f)
json.dump(out,open('feat.json','w'))
print('featured spots',len(out))
import json, math
F=json.load(open('feat.json'))
def wil(k,n):
    p=k/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d
    m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-m),100*(c+m))
def rate(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    if not n: return "  --   n=0"
    lo,hi=wil(k,n); return f"{100*k/n:5.1f}% n={n:<4}[{lo:.0f}-{hi:.0f}]"
def P(lab,rows): print(f"   {lab:<34}{rate(rows)}")

for CP in ['Q2_END','Q3_END']:
    B=[f for f in F if f['cp']==CP and 1<=f['deficit']<=9 and f['gap']>0]
    print("="*70); print(f"{CP} — better-trailer in-band, n={len(B)}, base {rate(B)}"); print("="*70)

    print("\n A. LEADER LEAD COMPOSITION (whose-variance proxies)")
    x=[f for f in B if f['l_3share'] is not None]
    q=sorted(f['l_3share'] for f in x); t1,t2=q[len(q)//3],q[2*len(q)//3]
    P(f"leader 3pt-share LOW <{t1:.2f}",[f for f in x if f['l_3share']<t1])
    P(f"leader 3pt-share MID",[f for f in x if t1<=f['l_3share']<t2])
    P(f"leader 3pt-share HIGH >={t2:.2f}",[f for f in x if f['l_3share']>=t2])
    x=[f for f in B if f['l_ftshare'] is not None]
    q=sorted(f['l_ftshare'] for f in x); t1,t2=q[len(q)//3],q[2*len(q)//3]
    P(f"leader FT-share HIGH >={t2:.2f}",[f for f in x if f['l_ftshare']>=t2])
    x=[f for f in B if f['l_rimpct'] is not None]
    q=sorted(f['l_rimpct'] for f in x); t1,t2=q[len(q)//3],q[2*len(q)//3]
    P(f"leader rim% LOW (<{t1:.2f})",[f for f in x if f['l_rimpct']<t1])
    P(f"leader rim% HIGH (>={t2:.2f})",[f for f in x if f['l_rimpct']>=t2])

    print("\n B. LEAD CLASS (peak vs decayed)")
    x=[f for f in B if f['lead_decay'] is not None]
    P("AT-PEAK lead (decay <=2)",[f for f in x if f['lead_decay']<=2])
    P("DECAYED 3-7 off peak",[f for f in x if 3<=f['lead_decay']<=7])
    P("DECAYED 8+ off peak",[f for f in x if f['lead_decay']>=8])

    print("\n C. TRAILER STRUCTURE")
    x=[f for f in B if f['t_astrate'] is not None]
    q=sorted(f['t_astrate'] for f in x); t1,t2=q[len(q)//3],q[2*len(q)//3]
    P(f"trailer ast-rate HIGH >={t2:.2f}",[f for f in x if f['t_astrate']>=t2])
    P(f"trailer ast-rate LOW <{t1:.2f}",[f for f in x if f['t_astrate']<t1])
    x=[f for f in B if f['t_rimpct'] is not None]
    q=sorted(f['t_rimpct'] for f in x); t1,t2=q[len(q)//3],q[2*len(q)//3]
    P(f"trailer rim% HIGH >={t2:.2f}",[f for f in x if f['t_rimpct']>=t2])
    P("TO diff: leader TOs >= trailer+3",[f for f in B if f['l_to']-f['t_to']>=3])

    print("\n D. TRAILER-RELATIVE INDICATORS")
    for k,nm in [('tI3','I3 shot quality'),('tI4','I4 lineup/control'),('tI1','I1 possession'),('tI2','I2 rim/foul')]:
        P(f"trailer WON {nm}",[f for f in B if f.get(k)==1])
    P("trailer won BOTH I3+I4",[f for f in B if f.get('tI3')==1 and f.get('tI4')==1])
    P("trailer won I3, gap>=.15",[f for f in B if f.get('tI3')==1 and f['gap']>=.15])

    if CP=='Q3_END':
        print("\n E. TRAJECTORY (Q2->Q3 deficit compression)")
        x=[f for f in B if f.get('compress') is not None]
        P("COMPRESSING (closed 3+)",[f for f in x if f['compress']>=3])
        P("FLAT (-2..+2)",[f for f in x if -2<=f['compress']<=2])
        P("EXPANDING (fell 3+)",[f for f in x if f['compress']<=-3])
        P("was in-band at Q2 too",[f for f in x if f.get('deficit_q2') is not None and 1<=f['deficit_q2']<=9])
    print()
import json, math
F=json.load(open('feat.json'))
def wil(k,n):
    p=k/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d
    m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-m),100*(c+m))
def r_(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    if not n: return None,0,""
    lo,hi=wil(k,n); return 100*k/n,n,f"[{lo:.0f}-{hi:.0f}]"
def P(lab,rows):
    p,n,ci=r_(rows); print(f"   {lab:<44}{p:5.1f}% n={n:<4}{ci}" if n else f"   {lab:<44}  -- n=0")

# candidate compound gates, mechanism-motivated only
GATES={
 "gap>=.30 alone":                         lambda f: f['gap']>=.30,
 "gap>=.30 + deficit<=6":                  lambda f: f['gap']>=.30 and f['deficit']<=6,
 "gap>=.20 + trailer won I4":              lambda f: f['gap']>=.20 and f.get('tI4')==1,
 "gap>=.20 + tfloor>=.45":                 lambda f: f['gap']>=.20 and (f.get('tfloor') or 0)>=.45,
 "gap>=.15 + I3&I4 won":                   lambda f: f['gap']>=.15 and f.get('tI3')==1 and f.get('tI4')==1,
 "gap>0 + tfloor>=.45 + deficit<=6":       lambda f: (f.get('tfloor') or 0)>=.45 and f['deficit']<=6,
 "gap>=.30 + tfloor>=.40":                 lambda f: f['gap']>=.30 and (f.get('tfloor') or 0)>=.40,
 "gap>=.20 + leader FTshare>=.16":         lambda f: f['gap']>=.20 and (f.get('l_ftshare') or 0)>=.16,
 "gap>=.20 + won I4 + deficit<=6":         lambda f: f['gap']>=.20 and f.get('tI4')==1 and f['deficit']<=6,
}
for CP in ['Q2_END','Q3_END']:
    B=[f for f in F if f['cp']==CP and 1<=f['deficit']<=9 and f['gap']>0]
    p,n,ci=r_(B)
    print("="*72); print(f"{CP} compounds — base {p:.1f}% n={n}"); print("="*72)
    for lab,g in GATES.items(): P(lab,[f for f in B if g(f)])
    print()

# date-split stability for the promising cells (first vs second half of season)
print("="*72); print("STABILITY CHECK — split at 2026-01-15 (early vs late season)"); print("="*72)
CHECKS=[
 ("Q2_END","gap>=.30",lambda f: f['gap']>=.30),
 ("Q2_END","gap>=.20 + won I4",lambda f: f['gap']>=.20 and f.get('tI4')==1),
 ("Q2_END","I3&I4 both won",lambda f: f.get('tI3')==1 and f.get('tI4')==1),
 ("Q2_END","tfloor>=.45 + deficit<=6",lambda f: (f.get('tfloor') or 0)>=.45 and f['deficit']<=6),
 ("Q3_END","gap>=.30",lambda f: f['gap']>=.30),
 ("Q3_END","tfloor HIGH (>=.47)",lambda f: (f.get('tfloor') or 0)>=.47),
]
for cp,lab,g in CHECKS:
    B=[f for f in F if f['cp']==cp and 1<=f['deficit']<=9 and f['gap']>0 and g(f)]
    e=[f for f in B if f['date']<'2026-01-15']; l=[f for f in B if f['date']>='2026-01-15']
    pe,ne,_=r_(e); pl,nl,_=r_(l)
    print(f"   {cp} {lab:<28} early {pe or 0:5.1f}%/n={ne:<3} late {pl or 0:5.1f}%/n={nl}")
import json, collections
bdl=json.load(open('bdl_2025.json'))
rs=[g for g in bdl if not g.get('postseason') and g.get('status')=='Final']
rs.sort(key=lambda g:(g['date'], g['id']))
# rolling result history per team, strictly pre-game
hist=collections.defaultdict(list)   # alias -> list of (1/0 win, margin_for_team)
form={}                              # game_id -> {alias: {'l10':wp,'l15':wp,'net15':avg margin,'n':gp}}
for g in rs:
    h=g['home_team']['abbreviation']; a=g['visitor_team']['abbreviation']
    d={}
    for t in (h,a):
        hh=hist[t]
        def wp(k):
            s=hh[-k:] if len(hh)>=1 else []
            return (sum(x[0] for x in s)/len(s), len(s)) if s else (None,0)
        l10,n10=wp(10); l15,n15=wp(15)
        net15=(sum(x[1] for x in hh[-15:])/min(len(hh),15)) if hh else None
        d[t]=dict(l10=l10,n10=n10,l15=l15,n15=n15,net15=net15)
    form[g['id']]=d
    hs,vs=g['home_team_score'],g['visitor_team_score']
    hist[h].append((1 if hs>vs else 0, hs-vs))
    hist[a].append((1 if vs>hs else 0, vs-hs))
json.dump({str(k):v for k,v in form.items()}, open('form.json','w'))
print('form ledger built for',len(form),'games')
import json, math
F=json.load(open('feat.json')); FORM=json.load(open('form.json'))
def wil(k,n):
    p=k/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d
    m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-m),100*(c+m))
def r_(rows):
    n=len(rows); k=sum(1 for r in rows if r['twon'])
    if not n: return None,0,""
    lo,hi=wil(k,n); return 100*k/n,n,f"[{lo:.0f}-{hi:.0f}]"
def P(lab,rows):
    p,n,ci=r_(rows); print(f"   {lab:<40}{(f'{p:5.1f}% n={n:<4}{ci}') if n else '  -- n=0'}")

# attach form gap (L15 wp diff, trailer minus leader) + form-net gap
X=[]
for f in F:
    fm=FORM.get(str(f['gid']))
    if not fm or f['trailer'] not in fm or f['leader'] not in fm: continue
    t,l=fm[f['trailer']],fm[f['leader']]
    if t['n15']<8 or l['n15']<8: continue     # need >=8 recent games each
    f=dict(f)
    f['fgap15']=t['l15']-l['l15']
    f['fgap10']=(t['l10']-l['l10']) if (t['l10'] is not None and l['l10'] is not None) else None
    f['ngap15']=(t['net15']-l['net15']) if (t['net15'] is not None and l['net15'] is not None) else None
    X.append(f)

for CP in ['Q2_END','Q3_END']:
    B=[f for f in X if f['cp']==CP and 1<=f['deficit']<=9]
    print("="*72); p,n,ci=r_( [f for f in B if f['gap']>0]); print(f"{CP}  (season-gap>0 base: {p:.1f}% n={n})"); print("="*72)
    print(" A. FORM GAP ALONE (L15 wp diff) — all trailers in band")
    P("form-gap < 0 (worse recent form)",[f for f in B if f['fgap15']<0])
    P("form-gap > 0",[f for f in B if f['fgap15']>0])
    P("form-gap >= .20",[f for f in B if f['fgap15']>=.20])
    P("form-gap >= .30",[f for f in B if f['fgap15']>=.30])
    print(" B. SEASON vs FORM — independence check (in-band)")
    P("season>0 & form>0 (agree)",[f for f in B if f['gap']>0 and f['fgap15']>0])
    P("season>0 & form<=0 (stale gap)",[f for f in B if f['gap']>0 and f['fgap15']<=0])
    P("season<=0 & form>0 (rising)",[f for f in B if f['gap']<=0 and f['fgap15']>0])
    print(" C. THE HEADLINE CELL, form-refined")
    hc=[f for f in B if f['gap']>=.30 and f['deficit']<=6]
    P("gap>=.30 & deficit<=6 (baseline)",hc)
    P("  + form-gap > 0",[f for f in hc if f['fgap15']>0])
    P("  + form-gap >= .15",[f for f in hc if f['fgap15']>=.15])
    P("  + form-gap <= 0 (stale)",[f for f in hc if f['fgap15']<=0])
    print(" D. FORM-NET (net rating proxy, L15 avg margin diff)")
    q=[f for f in B if f['ngap15'] is not None]
    P("ngap >= +8 pts",[f for f in q if f['ngap15']>=8])
    P("ngap +4..8",[f for f in q if 4<=f['ngap15']<8])
    P("ngap <= 0",[f for f in q if f['ngap15']<=0])
    P("ngap>=8 & deficit<=6",[f for f in q if f['ngap15']>=8 and f['deficit']<=6])
    print()
