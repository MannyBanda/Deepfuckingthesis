import gzip, json, collections, math, statistics
R='/home/claude/dft/research/'
F=json.load(gzip.open(R+'2026-10-31_mc_trailer_buy_fires.json.gz')); fires=[r for r in F['rows'] if r['threshold']==0.55]
D=json.load(gzip.open(R+'2026-10-23_fine_nba_states.json.gz')); G={g['gid']:g for g in D['games'] if g['walk']['ok']}
mB=lambda m: '1-3' if m<=3 else '4-8' if m<=8 else '9-15' if m<=15 else '16+'
key=lambda st: f"Q{st['p']}|{(720-st['c'])//120*2}-{(720-st['c'])//120*2+2}min|{mB(abs(st['h']['pts']-st['a']['pts']))}"
mins=lambda st: (4-st['p'])*12+st['c']/60
# ── TOUCH base table: from each Q3+ state, does the trailer LEAD at any later regulation state? ──
base=collections.defaultdict(lambda:[0,0,0])  # n, touched, won
touch_of={}  # (gid, idx) -> (touched, mins_to_touch, max_lead_gained)
for gid,g in G.items():
    S=g['states']; w=g['winner']
    for i,st in enumerate(S):
        if st['p']<3 or st['p']>4: continue
        m=st['h']['pts']-st['a']['pts']
        if m==0 or abs(m)>9 or (st['p']==4 and st['c']<60): continue
        tr='a' if m>0 else 'h'
        touched=False; tmin=None; best=-abs(m)
        for t in S[i+1:]:
            mm=t['h']['pts']-t['a']['pts']; lead=(-mm) if tr=='a' else mm
            best=max(best,lead)
            if lead>0: touched=True; tmin=mins(st)-mins(t); break
        touch_of[(gid,i)]=(touched,tmin,best)
        b=base[key(st)]; b[0]+=1; b[1]+=touched; b[2]+= (w==(g['home'] if tr=='h' else g['away']))
def fairT(st): b=base[key(st)]; return b[1]/b[0] if b[0] else None
def fairW(st): b=base[key(st)]; return b[2]/b[0] if b[0] else None
# attach to fires
for r in fires:
    g=G[r['gid']]; st=g['states'][r['idx']]
    t=touch_of.get((r['gid'],r['idx']))
    r['touched'],r['mins_to_touch'],r['best_lead']=t if t else (None,None,None)
    r['fair_touch']=fairT(st); r['fair_win']=fairW(st)
    # features at fire
    S=g['states']; trs=r['trailer_side']; lds='h' if trs=='a' else 'a'
    ep=lambda b: b['fga']+0.44*b['fta']-b['oreb']+b['to']
    j=r['idx']-1
    while j>=0 and (ep(S[r['idx']]['h'])-ep(S[j]['h']))+(ep(S[r['idx']]['a'])-ep(S[j]['a']))<20: j-=1
    j=max(j,0)
    T,L=st[trs],st[lds]; Tw={k:st[trs][k]-S[j][trs][k] for k in st[trs]}; Lw={k:st[lds][k]-S[j][lds][k] for k in st[lds]}
    efg=lambda b: (b['fgm']+0.5*b['fg3m'])/b['fga'] if b['fga'] else None
    poss=lambda b: b['fga']+0.44*b['fta']-b['oreb']+b['to']
    pd=st['pd']; P=lambda name,side: pd[('h' if side=='h' else 'a')+name]
    r['f']={
      'deficit':r['deficit'],'mins_left':r['mins_left'],'mc':r['mc'],'ctrl_floor':st['floor'] if st['floor'] is not None else None,
      'trailer_holds_floor':1 if r['floor_is_trailer'] else 0,
      'T_cum_eFG':efg(T),'L_cum_eFG':efg(L),'eFG_gap_cum':(efg(T) or 0)-(efg(L) or 0),
      'T_win_eFG':efg(Tw),'L_win_eFG':efg(Lw),'eFG_gap_win':(efg(Tw) or 0)-(efg(Lw) or 0),
      'L_cum_3P%':L['fg3m']/L['fg3a'] if L['fg3a'] else None,'L_cum_3PA_share':L['fg3a']/L['fga'] if L['fga'] else None,
      'L_win_3P%':Lw['fg3m']/Lw['fg3a'] if Lw['fg3a'] else None,'T_win_3P%':Tw['fg3m']/Tw['fg3a'] if Tw['fg3a'] else None,
      'T_cum_TOrate':T['to']/poss(T) if poss(T) else None,'L_cum_TOrate':L['to']/poss(L) if poss(L) else None,
      'T_win_TO':Tw['to'],'L_win_TO':Lw['to'],'T_win_FTA':Tw['fta'],'L_win_FTA':Lw['fta'],
      'T_cum_FTArate':T['fta']/T['fga'] if T['fga'] else None,'L_cum_FTArate':L['fta']/L['fga'] if L['fga'] else None,
      'T_cum_OREB':T['oreb'],'L_cum_OREB':L['oreb'],'T_cum_AST':T['ast'],'L_cum_AST':L['ast'],
      'netPOT_T':P('POT',trs)-P('POT',lds),'paint_gap_T':P('Paint',trs)-P('Paint',lds),
      'L_bigLead':P('BigLead',lds),'T_unforcedTO':P('TOu',trs),'L_unforcedTO':P('TOu',lds),
      'r6_T':pd.get('r6'+trs),'r6_L':pd.get('r6'+lds),
    }
def cell(RR,outcome='touched',fair='fair_touch'):
    n=len(RR);
    if not n: return None
    w=sum(1 for x in RR if x[outcome])/n; f=sum(x[fair] for x in RR)/n; se=math.sqrt(w*(1-w)/n) if 0<w<1 else 0
    return n,w,f,w-f,se
def fmt(l,RR,o='touched',fa='fair_touch'):
    c=cell(RR,o,fa)
    if not c: return f"  {l:40s} n=0"
    n,w,f,e,se=c; tag='HIGH' if n>=200 else 'MED' if n>=80 else 'LOW'
    return f"  {l:40s} n={n:4d} {tag:4s} rate {100*w:5.1f}%  fair {100*f:5.1f}%  edge {100*e:+6.1f}pp (±{100*1.96*se:.1f})"
print("═══ 1. TOUCH THE LEAD (trailer leads at any later regulation state) — primary fires vs base rate for the same period×clock×deficit cell ═══")
print(fmt('all fires — TOUCH',fires)); print(fmt('all fires — WIN (for reference)',fires,'trailer_won','fair_win'))
for h in ('H1','H2'): print(fmt(f'half {h} — TOUCH',[r for r in fires if r['half']==h]))
for b in ('1-3','4-6','7-9'): print(fmt(f'deficit {b} — TOUCH',[r for r in fires if r['deficit_band']==b]))
print(" base touch rates (all Q3+ states, not just fires) by deficit bucket at Q3 open vs Q4:")
for k in sorted(base):
    if base[k][0]>=200 and ('Q3|0-2' in k or 'Q4|0-2' in k or 'Q3|10-12' in k or 'Q4|8-10' in k): print(f"    {k:22s} n={base[k][0]:5d} touch {100*base[k][1]/base[k][0]:4.0f}%  win {100*base[k][2]/base[k][0]:4.0f}%")
tt=[r['mins_to_touch'] for r in fires if r['touched']]
print(f"\n time from fire to first lead (touchers): median {statistics.median(tt):.1f} game-min, p25 {sorted(tt)[len(tt)//4]:.1f}, p75 {sorted(tt)[3*len(tt)//4]:.1f} | touched-then-LOST: {sum(1 for r in fires if r['touched'] and not r['trailer_won'])} of {sum(1 for r in fires if r['touched'])} touchers")
bl=[r['best_lead'] for r in fires if not r['touched']]
print(f" non-touchers: got within median {statistics.median([-x for x in bl]):.0f} pts of the lead (best lead-gained p75 {sorted(bl)[3*len(bl)//4]:+d})")

print("\n═══ 2. VARIABLE SCAN at the fire (EXPLORATORY — ~30 variables × terciles; expect ±8pp cells by chance; both-halves agreement is the only filter) ═══")
names=[k for k in fires[0]['f'] if sum(1 for r in fires if r['f'].get(k) is not None)>=600]
res=[]
for nm in names:
    V=[r for r in fires if r['f'].get(nm) is not None]; V.sort(key=lambda r:r['f'][nm]); k=len(V)//3
    ters=[V[:k],V[k:2*k],V[2*k:]]
    for o,fa,lbl in (('touched','fair_touch','TOUCH'),('trailer_won','fair_win','WIN')):
        cs=[cell(t,o,fa) for t in ters]; edges=[c[3] for c in cs]; sep=max(edges)-min(edges)
        # both-halves sign agreement for top-vs-bottom tercile
        def sepH(h):
            a=[r for r in ters[0] if r['half']==h]; b=[r for r in ters[2] if r['half']==h]
            ca,cb=cell(a,o,fa),cell(b,o,fa); return (cb[3]-ca[3]) if ca and cb else None
        s1,s2=sepH('H1'),sepH('H2'); agree = s1 is not None and s2 is not None and (s1>0)==(s2>0) and abs(s1)>=0.04 and abs(s2)>=0.04
        res.append((sep,nm,lbl,edges,[c[0] for c in cs],[round(ters[0][-1]['f'][nm],3),round(ters[1][-1]['f'][nm],3)],agree,s1,s2))
res.sort(reverse=True)
print(f"{'variable':18s} {'out':5s} {'tercile edges lo/mid/hi (pp)':30s} {'cuts':20s} {'halves top-vs-bot':18s} agree")
for sep,nm,lbl,e,ns,cuts,agree,s1,s2 in res[:24]:
    print(f"{nm:18s} {lbl:5s} {100*e[0]:+5.1f} / {100*e[1]:+5.1f} / {100*e[2]:+5.1f}      {str(cuts):20s} {100*(s1 or 0):+5.1f} / {100*(s2 or 0):+5.1f}    {'YES' if agree else '-'}")
print(f"\n variables scanned: {len(names)} × 2 outcomes × 3 terciles = {len(names)*6} cells; cells with |edge| ≥ 8pp: {sum(1 for sep,nm,lbl,e,*_ in res for x in e if abs(x)>=0.08)}; variables with both-halves agreement ≥4pp same sign: {sum(1 for x in res if x[6])} of {len(res)}")
json.dump([{k:v for k,v in r.items()} for r in fires],open('/tmp/mc_trailer_buy_fires_touch.json','w'))
