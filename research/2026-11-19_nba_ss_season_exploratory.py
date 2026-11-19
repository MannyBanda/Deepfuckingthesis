import json, re, math, collections
S='/tmp/nba_ss_season'  # cache dir: games.json + hist.json (history&game_id per game) pulled from db-api
H=json.load(open(f'{S}/hist.json'))
G=[v for v in json.load(open(f'{S}/games.json')).values() if isinstance(v,list)][0]
G={x['id']:x for x in G if str(x.get('date') or '')>='2026-10-20' and x.get('winner')}
# strict as-of records from finals
byday=collections.defaultdict(list)
for g in G.values(): byday[str(g['date'])[:10]].append(g)
days=sorted(byday); rec=collections.defaultdict(lambda:[0,0]); asof={}
for d in days:
    asof[d]={t:tuple(v) for t,v in rec.items()}
    for g in byday[d]:
        w=g['winner']; l=g['away_alias'] if w==g['home_alias'] else g['home_alias']
        rec[w][0]+=1; rec[l][1]+=1
def wp(team,d):
    r=asof.get(d,{}).get(team); 
    if not r or sum(r)<5: return None
    return r[0]/sum(r), sum(r)
def cs(c):
    m=re.match(r'(\d+):(\d+)',str(c or '')); return int(m.group(1))*60+int(m.group(2)) if m else None
def efg(b): return (b['fgm']+0.5*b['fg3m'])/b['fga'] if b and b.get('fga') else None
rows=[]; ss_populated=0
for gid,snaps in H.items():
    g=G.get(gid); 
    if not g: continue
    d=str(g['date'])[:10]; hA,aA,w=g['home_alias'],g['away_alias'],g['winner']
    seen=set()
    for s in sorted(snaps,key=lambda s:((s.get('period') or 0),-(cs(s.get('clock')) or 0))):
        p=s.get('period'); c=cs(s.get('clock'))
        if not p or c is None or p<2 or p>4: continue
        if p==4 and c<360: continue                       # Q4-early only (≥6:00)
        hp,ap=float(s.get('home_pts') or 0),float(s.get('away_pts') or 0)
        if hp==ap: continue
        trailer,leader=(aA,hA) if hp>ap else (hA,aA); dfc=abs(hp-ap)
        if dfc<1 or dfc>9: continue
        tw,lw=wp(trailer,d),wp(leader,d)
        if not tw or not lw: continue
        gap=tw[0]-lw[0]
        raw=s.get('raw_stats_json'); raw=json.loads(raw) if isinstance(raw,str) else raw
        lb=(raw or {}).get('home' if leader==hA else 'away'); le=efg(lb)
        e=s.get('espn_wp_home'); 
        if e is None: continue
        e=float(e); e=e/100 if e>1 else e; esp=e if trailer==hA else 1-e
        if s.get('ss_quality_gap') is not None: ss_populated+=1
        key=(gid,trailer)
        if key in seen: continue
        seen.add(key)   # first perception per game-trailer of the in-band state (any gap) → then classify
        rows.append(dict(gid=gid,date=d,matchup=g['matchup'],trailer=trailer,leader=leader,p=p,clock=s.get('clock'),deficit=dfc,gap=gap,tw=tw[0],lw=lw[0],tgp=tw[1],lgp=lw[1],
            leader_efg=le,espn=esp,won=(w==trailer),preq4=(p<4)))
print(f"in-band first perceptions (deficit 1-9, Q2–Q4 6:00, both ≥5 GP): {len(rows)} game-trailers across {len(set(r['gid'] for r in rows))} games | ss_* populated on NBA snapshots: {ss_populated}")
def cell(R):
    n=len(R)
    if not n: return None
    w=sum(r['won'] for r in R)/n; f=sum(r['espn'] for r in R)/n; se=math.sqrt(w*(1-w)/n) if 0<w<1 else 0
    return n,w,f,w-f,se
def fmt(l,R):
    c=cell(R)
    if not c: return f"  {l:50s} n=0"
    n,w,f,e,se=c; tag='HIGH' if n>=200 else 'MED' if n>=80 else 'LOW'
    return f"  {l:50s} n={n:3d} {tag:4s} trailer-WIN {100*w:5.1f}%  ESPN-fair {100*f:5.1f}%  edge {100*e:+6.1f}pp (±{100*1.96*se:.1f})"
PRE=[r for r in rows if r['preq4']]
print("\n(A) GAP STAIRCASE — pre-Q4 first perceptions, trailer-WIN vs ESPN (the market-honest read)")
for lo,hi,lbl in ((-9,-0.15,'trailer WORSE by ≥.15'),(-0.15,0.15,'EVEN (|gap|<.15)'),(0.15,0.35,'trailer BETTER .15–.35 (qualifying)'),(0.35,9,'trailer BETTER ≥.35 (strong)')):
    print(fmt(lbl,[r for r in PRE if lo<=r['gap']<hi]))
Q=[r for r in PRE if r['gap']>=0.15]
print(fmt('GAP_BASE (gap ≥ .15), all pre-Q4',Q))
for b,(lo,hi) in (('deficit 1-3',(1,3)),('deficit 4-6',(4,6)),('deficit 7-9',(7,9))): print(fmt('  '+b,[r for r in Q if lo<=r['deficit']<=hi]))
print(fmt('  Q2 fires',[r for r in Q if r['p']==2])); print(fmt('  Q3 fires',[r for r in Q if r['p']==3]))
print(fmt('GAP ≥ .15, Q4-early (≥6:00) first perceptions',[r for r in rows if r['gap']>=0.15 and not r['preq4']]))
print("\n(B) DIVERGENCE / A-tier shape — gap ≥ .15 × LEADER eFG band at first perception (pre-Q4)")
for lo,hi,lbl in ((0,0.50,'leader eFG < 50 (cold)'),(0.50,0.57,'leader eFG 50–57 (normal)'),(0.57,2,'leader eFG ≥ 57 (hot)')):
    print(fmt(lbl,[r for r in Q if r['leader_efg'] is not None and lo<=r['leader_efg']<hi]))
print(fmt('WNBA band as-is: leader eFG > 55',[r for r in Q if r['leader_efg'] is not None and r['leader_efg']>0.55]))
print(fmt('  control: EVEN gap × leader eFG ≥ 57',[r for r in PRE if abs(r['gap'])<0.15 and r['leader_efg'] is not None and r['leader_efg']>=0.57]))
print(fmt('  control: trailer WORSE × leader eFG ≥ 57',[r for r in PRE if r['gap']<=-0.15 and r['leader_efg'] is not None and r['leader_efg']>=0.57]))
print("\n(C) BEATABLE LEADER — gap ≥ .15 × leader as-of win% (pre-Q4)")
for lo,hi,lbl in ((0,0.40,'leader < .400'),(0.40,0.55,'leader .400–.550'),(0.55,2,'leader ≥ .550')):
    print(fmt(lbl,[r for r in Q if lo<=r['lw']<hi]))
print(fmt('  compound: leader < .400 × leader eFG ≥ 57',[r for r in Q if r['lw']<0.40 and r['leader_efg'] is not None and r['leader_efg']>=0.57]))
print(f"\nseason context: first qualifying date {min(r['date'] for r in Q) if Q else None}; GP at fire median trailer {sorted(r['tgp'] for r in Q)[len(Q)//2] if Q else None}, leader {sorted(r['lgp'] for r in Q)[len(Q)//2] if Q else None}")
json.dump(rows,open(f'{S}/ss_rows.json','w'))
