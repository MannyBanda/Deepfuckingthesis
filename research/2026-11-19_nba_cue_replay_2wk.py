#!/usr/bin/env python3
# NBA Phase 1b WATCHLIST cue — replay of the SHIPPED predicate (c01a4d0) on the production snapshot
# tape for a date window, with the live price at the fire moment and the outcome.
#   python3 research/2026-11-19_nba_cue_replay_2wk.py --from 2026-11-05 --to 2026-11-18 [--cache DIR]
# Predicate = SS_CFG.nba.cue: gap >= .15 (strict as-of records, both >= 5 GP) · Q2-Q3 · deficit 1-9 ·
# leader eFG >= 57 (box fgm/fg3m/fga from raw_stats_json) · FIRST perception per game (the
# (game_id, alert_subtype) dedup). GAP_BASE = same without the eFG clause (the silent ledger row).
# Price = nearest odds_history row at/before the fire snapshot (<= 10 min), else nearest after (flagged);
# stale = |implied(trailer ML) - ESPN trailer WP| > .25 (the shipped ssPriceStale rule). Outcome = winner.
# Cache dir holds games.json (get_games&league=nba) and hist.json ({game_id: [snapshots]} from history&game_id).
import json, re, math, argparse, collections, urllib.request, base64, os, sys, datetime as dt
ap=argparse.ArgumentParser(); ap.add_argument('--from',dest='d0',required=True); ap.add_argument('--to',dest='d1',required=True)
ap.add_argument('--cache',default='/tmp/claude-0/-home-claude/cdcef8f5-1c49-5a47-8877-3e9e328ff72e/scratchpad/season'); ap.add_argument('--stake',type=float,default=100.0)
a=ap.parse_args()
B="https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?action="
def get(url):
    req=urllib.request.Request(url); req.add_header('Authorization','Basic '+base64.b64encode(b'manny:DFT2025!').decode())
    return json.load(urllib.request.urlopen(req,timeout=60))
G=[v for v in json.load(open(f'{a.cache}/games.json')).values() if isinstance(v,list)][0]
G={x['id']:x for x in G if str(x.get('date') or '')>='2026-10-20'}
H=json.load(open(f'{a.cache}/hist.json'))
# strict as-of records from finals (same recipe as the exploratory; production reads standings_cache ~20h old)
byday=collections.defaultdict(list)
for g in G.values():
    if g.get('winner'): byday[str(g['date'])[:10]].append(g)
rec=collections.defaultdict(lambda:[0,0]); asof={}
for d in sorted(byday):
    asof[d]={t:tuple(v) for t,v in rec.items()}
    for g in byday[d]:
        w=g['winner']; l=g['away_alias'] if w==g['home_alias'] else g['home_alias']; rec[w][0]+=1; rec[l][1]+=1
def wp(team,d):
    r=asof.get(d,{}).get(team)
    return (r[0]/sum(r),sum(r)) if r and sum(r)>=5 else (None,None)
def cs(c):
    m=re.match(r'(\d+):(\d+)',str(c or '')); return int(m.group(1))*60+int(m.group(2)) if m else None
def efg(b):
    try: return (float(b['fgm'])+0.5*float(b['fg3m']))/float(b['fga'])*100 if b and float(b.get('fga') or 0)>0 else None
    except: return None
def implied(ml):
    if ml is None: return None
    ml=float(ml); return 100/(ml+100) if ml>0 else (-ml)/((-ml)+100)
def ts(s): return dt.datetime.fromisoformat(str(s).replace('Z','+00:00'))
CUE=dict(minGap=0.15,minLeaderEfg=57,minPeriod=2,maxPeriod=3,minDeficit=1,maxDeficit=9)
fires=[]; gapbase=[]
for gid,snaps in H.items():
    g=G.get(gid)
    if not g or not g.get('winner'): continue
    d=str(g['date'])[:10]
    if not (a.d0<=d<=a.d1): continue
    hA,aA,w=g['home_alias'],g['away_alias'],g['winner']
    S=sorted(snaps,key=lambda s:((s.get('period') or 0),-(cs(s.get('clock')) or 0)))
    fired=False; based=False
    for i,s in enumerate(S):
        p=s.get('period'); c=cs(s.get('clock'))
        if not p or c is None or p<CUE['minPeriod'] or p>CUE['maxPeriod']: continue
        hp,ap_=float(s.get('home_pts') or 0),float(s.get('away_pts') or 0)
        if hp==ap_: continue
        trailer,leader=(aA,hA) if hp>ap_ else (hA,aA); dfc=abs(hp-ap_)
        if dfc<CUE['minDeficit'] or dfc>CUE['maxDeficit']: continue
        tw,tgp=wp(trailer,d); lw,lgp=wp(leader,d)
        if tw is None or lw is None: continue
        gap=tw-lw
        if gap<CUE['minGap']: continue
        raw=s.get('raw_stats_json'); raw=json.loads(raw) if isinstance(raw,str) else raw
        le=efg((raw or {}).get('home' if leader==hA else 'away'))
        e=s.get('espn_wp_home'); e=None if e is None else float(e); e=e/100 if e is not None and e>1 else e
        esp=None if e is None else (e if trailer==hA else 1-e)
        # TOUCH: did the trailer lead at any later snapshot?
        touch=False
        for t in S[i+1:]:
            th,ta=float(t.get('home_pts') or 0),float(t.get('away_pts') or 0)
            if (th>ta and trailer==hA) or (ta>th and trailer==aA): touch=True; break
        row=dict(gid=gid,date=d,matchup=f"{aA}@{hA}",trailer=trailer,leader=leader,p=p,clock=s.get('clock'),deficit=int(dfc),
                 gap=gap,tw=tw,lw=lw,tgp=tgp,lgp=lgp,leader_efg=le,espn=esp,won=(w==trailer),touch=touch,ts=s.get('ts'),
                 final=f"{int(g.get('home_pts') or 0)}-{int(g.get('away_pts') or 0)}",hA=hA,aA=aA)
        if not based: gapbase.append(row); based=True
        if not fired and le is not None and le>=CUE['minLeaderEfg']: fires.append(row); fired=True
        if fired and based: break
# price join — nearest odds_history row at/before the fire snapshot
def join_price(r):
    try: od=get(B+f"get_odds&game_id={r['gid']}").get('odds',[])
    except Exception as ex: return dict(ml=None,note=f'odds fetch failed: {ex}')
    if not od: return dict(ml=None,note='no odds rows')
    t0=ts(r['ts']); before=[o for o in od if ts(o['ts'])<=t0]; after=[o for o in od if ts(o['ts'])>t0]
    pick=before[-1] if before else (after[0] if after else None); note=''
    if pick is None: return dict(ml=None,note='no odds rows')
    age=(t0-ts(pick['ts'])).total_seconds()/60
    if before and age>10: note=f'stamp {age:.0f}m old'
    if not before: note=f'next stamp {-age:.0f}m later'
    ml=pick['home_ml'] if r['trailer']==r['hA'] else pick['away_ml']
    pre=od[0]; pre_ml=pre['home_ml'] if r['trailer']==r['hA'] else pre['away_ml']
    return dict(ml=ml,src=pick.get('source'),age_m=age,note=note,pre_ml=pre_ml,n_rows=len(od))
for r in fires: r.update(join_price(r))
def mlfmt(v): return '—' if v is None else (f"+{int(v)}" if float(v)>0 else f"{int(v)}")
def pnl(r):
    if r.get('ml') is None: return None
    ml=float(r['ml']); win=a.stake*(ml/100 if ml>0 else 100/-ml)
    return round(win,2) if r['won'] else -a.stake
print(f"NBA WATCHLIST cue replay — shipped predicate (gap>=.15, Q2-Q3, deficit 1-9, leader eFG>=57, first perception/game) · finals {a.d0}..{a.d1}")
print(f"games on tape in window: {sum(1 for gid in H if (g:=G.get(gid)) and g.get('winner') and a.d0<=str(g['date'])[:10]<=a.d1)} · GAP_BASE rows (silent): {len(gapbase)} · WATCHLIST fires (push): {len(fires)}\n")
print(f"{'date':10s} {'game':8s} {'fire':9s} {'trailer (rec)':16s} {'leader (rec)':16s} {'gap':5s} {'down':4s} {'ldr eFG':7s} {'price':6s} {'impl':5s} {'ESPN':5s} {'stale':5s} {'touch':5s} {'result':7s} {'final':8s} {'P&L':8s}")
tot=0; n_priced=0; wins=0; stale_n=0; touches=0; esp_sum=0; esp_n=0; tot_clean=0; n_clean=0; w_clean=0
for r in sorted(fires,key=lambda x:(x['date'],x['ts'])):
    imp=implied(r['ml']); st=(imp is not None and r['espn'] is not None and abs(imp-r['espn'])>0.25)
    p_=pnl(r)
    if p_ is not None: tot+=p_; n_priced+=1
    if st: stale_n+=1
    elif p_ is not None: tot_clean+=p_; n_clean+=1; w_clean+=r['won']
    wins+=r['won']; touches+=r['touch']
    if r['espn'] is not None: esp_sum+=r['espn']; esp_n+=1
    print(f"{r['date']:10s} {r['matchup']:8s} Q{r['p']} {str(r['clock']):6s} {r['trailer']+' ('+format(r['tw'],'.3f')+')':16s} {r['leader']+' ('+format(r['lw'],'.3f')+')':16s} {r['gap']:.2f}  {r['deficit']:<4d} {r['leader_efg']:5.1f}   {mlfmt(r['ml']):6s} {('—' if imp is None else format(100*imp,'.0f')+'%'):5s} {('—' if r['espn'] is None else format(100*r['espn'],'.0f')+'%'):5s} {('YES' if st else 'no'):5s} {('yes' if r['touch'] else 'no'):5s} {('WON' if r['won'] else 'lost'):7s} {r['final']:8s} {('—' if p_ is None else format(p_,'+.0f')):8s} {r.get('note','')}")
n=len(fires)
print(f"\nFIRES: {n} · trailer WON {wins}/{n} ({100*wins/n:.0f}%)" + (f" · ESPN fair avg {100*esp_sum/esp_n:.0f}%" if esp_n else '') + f" · took the lead later {touches}/{n} ({100*touches/n:.0f}%)" if n else "\nFIRES: 0")
if n_priced: print(f"P&L at the observed price, flat ${a.stake:.0f}/fire: {tot:+.0f} on {n_priced} priced fires ({100*tot/(a.stake*n_priced):+.0f}% ROI) · stale-flagged prices: {stale_n} · clean-price subset: {w_clean}/{n_clean} won, {tot_clean:+.0f} ({(100*tot_clean/(a.stake*n_clean)) if n_clean else 0:+.0f}% ROI)")
gb=len(gapbase); gw=sum(r['won'] for r in gapbase); ge=[r['espn'] for r in gapbase if r['espn'] is not None]
print(f"GAP_BASE (silent ledger, same window): {gb} rows · trailer WON {gw}/{gb} ({100*gw/gb:.0f}%)" + (f" · ESPN fair avg {100*sum(ge)/len(ge):.0f}%" if ge else '') if gb else "GAP_BASE: 0")
nb=[r for r in gapbase if r['leader_efg'] is not None and r['leader_efg']<CUE['minLeaderEfg']]
if nb: print(f"  of which leader NOT hot (eFG<57): {len(nb)} · trailer WON {sum(r['won'] for r in nb)}/{len(nb)} ({100*sum(r['won'] for r in nb)/len(nb):.0f}%) · ESPN fair avg {100*sum(r['espn'] for r in nb if r['espn'] is not None)/max(1,sum(1 for r in nb if r['espn'] is not None)):.0f}%")
print("\nPower: LOW (<80). Prices are the Odds API stamp nearest the fire moment — the NBA tape's stamps are often the PREGAME line (season audit); 'stale YES' = implied disagrees with ESPN's live fair by >25pp, the shipped flag. Read ordering, not precision.")
