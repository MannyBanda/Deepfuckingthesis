import json, numpy as np
from collections import defaultdict

cps=json.load(open('/tmp/wnba_mc_checkpoints.json'))
games=defaultdict(list)
for r in cps: games[r['game_id']].append(r)
for g in games: games[g].sort(key=lambda r:r['gs'])

# ---------- ODDS PROXY: fit P(buy-team wins | deficit, game_sec) from outcomes ----------
# buy-team = the trailing beneficiary. At a canary fire, ctrl(=leader) margin>0, we buy the OPPONENT (down `margin`).
# Fit fair win prob for a team down D points with T seconds left, from all checkpoints.
# Use logistic-ish empirical grid: P(ctrl_won | margin, gs). Then buy-team prob = 1 - P(leader wins).
# Build a simple calibrated lookup by (signed margin bucket, period).
def fair_ctrl_winprob(margin, period, table):
    key=(period, int(round(margin)))
    # nearest-margin fallback within period
    if key in table: return table[key]
    cands=[(abs(m-margin),p) for (pp,m),p in table.items() if pp==period]
    if not cands: return None
    cands.sort(); return cands[0][1]

# build table from ALL checkpoints (n=6336): P(ctrl_won) by (period, margin)
agg=defaultdict(lambda:[0,0])
for r in cps:
    k=(r['period'], int(round(r['margin'])))
    agg[k][0]+=r['ctrl_won']; agg[k][1]+=1
table={k:(v[0]/v[1]) for k,v in agg.items() if v[1]>=8}  # need >=8 samples

def american_from_prob(p):
    p=min(max(p,0.01),0.99)
    dec=1/p
    return (dec-1)*100 if dec>=2 else -100/(dec-1)
def dec_from_american(ml):
    return 1+ml/100 if ml>0 else 1+100/abs(ml)

# ---------- RECONSTRUCT CANARY FIRES ----------
# Canary fire: first checkpoint where ctrl LEADING (margin>0) and mc_win < 0.70.
# Buy = trailing opponent. Outcome buy_won = (ctrl_won==0). cum_min_window = min mc_cum over next up-to-2 cps.
events=[]
for gid,cs in games.items():
    fire=None
    for i,r in enumerate(cs):
        if r['margin']>0 and r['mc_win'] is not None and r['mc_win']<0.70:
            fire=(i,r); break
    if fire is None: continue
    i,r=fire
    buy_won = 1-r['ctrl_won']
    # MC Cum confirmation depth: min mc_cum over fire..fire+2
    win=[cs[j]['mc_cum'] for j in range(i, min(i+3,len(cs)))]
    cum_min=min(win)
    # also mc_cum at fire
    cum_at=r['mc_cum']
    # FAIR odds for buy team = 1 - fair_ctrl_winprob(leader margin)
    fcw=fair_ctrl_winprob(r['margin'], r['period'], table)
    buy_fair = (1-fcw) if fcw is not None else None
    ml = american_from_prob(buy_fair) if buy_fair is not None else None
    events.append({'gid':gid,'cp':r['cp'],'period':r['period'],'lead_margin':r['margin'],
                   'mc_win':r['mc_win'],'cum_at':cum_at,'cum_min':cum_min,
                   'buy_won':buy_won,'buy_fair':buy_fair,'ml':ml})

print('Total games:', len(games), '| canary fires:', len(events))
real=[e for e in events if e['buy_won']==1]
print('Buy-team WON (collapse landed): {}/{} = {:.0f}%  [base rate]'.format(len(real),len(events),len(real)/len(events)*100))
print()

# ---------- EV ENGINE (fair odds, then shade for vig) ----------
STAKE=1000
VIG=0.045  # shave decimal payout ~4.5% to approximate book hold on the bet you actually get
def ev(name, subset, shade=True):
    subset=[e for e in subset if e['ml'] is not None]
    if not subset: print('  {:<46} no bets'.format(name)); return
    n=len(subset); wins=sum(e['buy_won'] for e in subset)
    pnl=0
    for e in subset:
        d=dec_from_american(e['ml'])
        if shade: d=1+(d-1)*(1-VIG)   # haircut the win payout
        pnl += STAKE*(d-1) if e['buy_won'] else -STAKE
    be=np.mean([e['buy_fair'] for e in subset])*100
    print('  {:<46} n={:<4} WR={:>3.0f}%  avgFairProb={:>4.1f}%  P&L ${:>+8,.0f}  ROI {:>+6.1f}%'.format(
        name, n, wins/n*100, be, pnl, pnl/(n*STAKE)*100))

print('=== EV (fair odds from outcome model, payout shaded {:.0f}% for vig) ===  STAKE=$1000'.format(VIG*100))
ev('ALL canary fires', events)
print()
print('  -- + plus-money filter (you only bet +150 or better = fair prob <= 40%) --')
plus=[e for e in events if e['ml'] is not None and e['ml']>=150]
ev('Canary + bet only when >= +150', plus)
print()
print('  -- + MC Cum confirmation (deep co-dip) --')
for T in [0.40,0.45,0.50]:
    sub=[e for e in events if e['cum_min'] is not None and e['cum_min']<T]
    ev('Canary + MC Cum dips <{:.2f} (next 2 cps)'.format(T), sub)
print()
print('  -- COMBINED: plus-money AND MC Cum confirmation --')
for T in [0.45,0.50]:
    sub=[e for e in events if e['ml'] is not None and e['ml']>=150 and e['cum_min'] is not None and e['cum_min']<T]
    ev('Canary + >=+150 + MC Cum<{:.2f}'.format(T), sub)
print()
print('  -- REJECT bucket: MC Cum holds (noise filter) --')
sub=[e for e in events if e['cum_min'] is not None and e['cum_min']>=0.65]
ev('Canary + MC Cum holds >=0.65 (should be weak)', sub)

# save events for artifact
json.dump(events, open('/tmp/wnba_canary_events_scale.json','w'))
