# Phase 1 — canary × turnover fuel cuts on the FINE arena (Instrument A per Amendment 2),
# with the coarse export as the H2 "longer look" secondary. Reads outcomes.
# Prereg: research/2026-10-23_canary_turnover_fuel_PREREG.md (bars §7) + Amendments 1-3.
import json, gzip, collections, statistics as st

FINE = json.load(gzip.open('research/2026-10-23_fine_nba_canary_fires.json.gz', 'rt'))
COARSE = json.load(gzip.open('research/2026-10-23_canary_fuel_fires.json.gz', 'rt'))
SPLIT_DATE = '2026-01-14'   # A2.4
BAR_PP, HALF_PP, MIN_N = 8.0, 4.0, 40

def power(n): return 'HIGH' if n >= 200 else 'MED' if n >= 80 else 'LOW'
def mb(m): return '1-3' if m <= 3 else '4-8' if m <= 8 else '9-15' if m <= 15 else '16+'
def pct(x): return f"{100*x:5.1f}%"

# ── fine population: production-style CLEAN, ctrl margin>=1 at trigger, one row per game ──
rows = [r for r in FINE['rows'] if r['pattern'] == 'CLEAN' and r['trigger']['margin'] >= 1]
byg = {}
for r in sorted(rows, key=lambda r: (not r['tracked_proxy'], r['push']['idx'])): byg.setdefault(r['gid'], r)
POP = list(byg.values())

# proxy at the push state (A1.3 / A2.5)
BASE = FINE['base_rates']
def proxy_trailer_win(r):
    p = r['push']; h, a = p['h']['pts'], p['a']['pts']
    if h == a: return 0.5
    m = abs(h - a); minute = (720 - p['c']) // 120 * 2
    key = f"Q{p['p']}|{minute}-{minute+2}min|{mb(m)}"
    b = BASE.get(key)
    if not b or b['n'] < 20: return None
    hold = b['leader_won'] / b['n']
    trailer_is_home = r['trailer'] == r['home']
    trailer_leads = (h > a) == trailer_is_home
    return hold if trailer_leads else 1 - hold

def feats(r):
    L = r['trigger'][r['ctrl_side']]; T = r['trigger']['a' if r['ctrl_side'] == 'h' else 'h']
    P = r['push']['a' if r['ctrl_side'] == 'h' else 'h']
    f1 = L['pot'] - T['pot']
    f2 = T['to'] / T['poss'] if T['poss'] > 0 else None
    dpos = P['poss'] - T['poss']
    f3 = ((P['to'] - T['to']) / dpos - f2) if (dpos > 0 and f2 is not None) else None
    f4 = L['fta'] - T['fta']
    f5 = (T['tou'] / T['to']) if T['to'] > 0 else None
    return {'F1': f1, 'F2': f2, 'F3': f3, 'F4': f4, 'F5': f5}

for r in POP:
    r['_f'] = feats(r); r['_win'] = 1 if r['winner'] == r['trailer'] else 0; r['_proxy'] = proxy_trailer_win(r)
    r['_half'] = 'H1' if r['date'] < SPLIT_DATE else 'H2'

def terciles(pop, key):
    xs = sorted(r['_f'][key] for r in pop if r['_f'][key] is not None); n = len(xs)
    lo, hi = xs[n // 3], xs[2 * n // 3]
    def t(x): return None if x is None else ('T1' if x < lo else 'T3' if x >= hi else 'T2')
    return lo, hi, t

def cell(rs):
    n = len(rs); w = sum(r['_win'] for r in rs) / n if n else None
    pr = [r for r in rs if r['_proxy'] is not None]; e = (sum(r['_win'] - r['_proxy'] for r in pr) / len(pr)) if pr else None
    return {'n': n, 'win': w, 'edge': e, 'n_proxy': len(pr)}

def report_feature(pop, key, label, bar=True):
    lo, hi, t = terciles(pop, key)
    cells = {k: cell([r for r in pop if t(r['_f'][key]) == k]) for k in ('T1', 'T2', 'T3')}
    print(f"\n{label}  (cuts: <{lo} | {lo}..{hi} | >={hi})")
    for k in ('T1', 'T2', 'T3'):
        c = cells[k]; print(f"   {k}: n={c['n']:3d} [{power(c['n'])}]  trailer-WIN {pct(c['win'])}  edge vs proxy {c['edge']*100:+5.1f}pp (n_proxy {c['n_proxy']})")
    sep_w = (cells['T3']['win'] - cells['T1']['win']) * 100; sep_e = (cells['T3']['edge'] - cells['T1']['edge']) * 100
    mono = (cells['T1']['win'] <= cells['T2']['win'] <= cells['T3']['win']) or (cells['T1']['win'] >= cells['T2']['win'] >= cells['T3']['win'])
    halves = {}
    for hname in ('H1', 'H2'):
        hp = [r for r in pop if r['_half'] == hname]
        hc = {k: cell([r for r in hp if t(r['_f'][key]) == k]) for k in ('T1', 'T3')}
        halves[hname] = (hc['T3']['win'] - hc['T1']['win']) * 100 if hc['T1']['n'] and hc['T3']['n'] else None
        print(f"   {hname}: T1 n={hc['T1']['n']} {pct(hc['T1']['win']) if hc['T1']['n'] else '-'} | T3 n={hc['T3']['n']} {pct(hc['T3']['win']) if hc['T3']['n'] else '-'} | T3−T1 {halves[hname]:+.1f}pp" if halves[hname] is not None else f"   {hname}: insufficient")
    print(f"   T3−T1: win {sep_w:+.1f}pp | edge {sep_e:+.1f}pp | monotone {mono} | min n {min(c['n'] for c in cells.values())}")
    if bar:
        same_sign = all(v is not None and (v > 0) == (sep_w > 0) and abs(v) >= HALF_PP for v in halves.values())
        passed = abs(sep_w) >= BAR_PP and abs(sep_e) >= BAR_PP and mono and same_sign and min(c['n'] for c in cells.values()) >= MIN_N
        print(f"   BAR (8pp win AND 8pp edge, monotone, both halves ≥4pp same sign, n≥40): {'PASS' if passed else 'FAIL'}"
              f"  — direction: {'trailer wins MORE with higher ' + key if sep_w > 0 else 'trailer wins LESS with higher ' + key}")
    return cells

def headline(pop, label):
    c = cell(pop); print(f"\n{label}: n={c['n']} [{power(c['n'])}] trailer-WIN {pct(c['win'])} | mean proxy {pct(st.mean([r['_proxy'] for r in pop if r['_proxy'] is not None]))} | edge {c['edge']*100:+.1f}pp")

print("=" * 100); print("PHASE 1 — FINE ARENA (Instrument A). Population: production-style CLEAN, ctrl margin>=1 at trigger, one row per game.")
headline(POP, "ALL (primary, Amendment 3)")
headline([r for r in POP if r['tracked_proxy']], "tracked_proxy stratum")
for h in ('H1', 'H2'): headline([r for r in POP if r['_half'] == h], f"  half {h} ({'<' if h=='H1' else '>='} {SPLIT_DATE})")

print("\n-- Corrected margin-at-trigger table (prompt constant check) --")
for b in ('1-3', '4-8', '9-15', '16+'):
    c = cell([r for r in POP if mb(r['trigger']['margin']) == b]); print(f"   ctrl margin {b:>5}: n={c['n']:3d} [{power(c['n'])}] trailer-WIN {pct(c['win'])} edge {c['edge']*100:+.1f}pp")
print("-- Margin at PUSH (the bet-time state) --")
for b in ('ctrl trailing/tied', '1-3', '4-8', '9-15', '16+'):
    rs = [r for r in POP if ('ctrl trailing/tied' if r['push']['ctrl_margin'] < 1 else mb(r['push']['ctrl_margin'])) == b]
    if rs: c = cell(rs); print(f"   {b:>18}: n={c['n']:3d} [{power(c['n'])}] trailer-WIN {pct(c['win'])} edge {c['edge']*100:+.1f}pp")
print("-- Floor at trigger (cross_deep check: MC collapse + floor anchored vs dropping) --")
for lab, f in (('floor >.75', lambda r: (r['trigger']['floor'] or 0) > 0.75), ('floor .60-.75', lambda r: 0.60 <= (r['trigger']['floor'] or 0) <= 0.75), ('floor <.60', lambda r: (r['trigger']['floor'] or 0) < 0.60)):
    c = cell([r for r in POP if f(r)]); print(f"   {lab:>14}: n={c['n']:3d} [{power(c['n'])}] trailer-WIN {pct(c['win'])} edge {c['edge']*100:+.1f}pp")
print("-- Floor at PUSH --")
for lab, f in (('floor >.75', lambda r: (r['push']['floor'] or 0) > 0.75), ('floor .60-.75', lambda r: 0.60 <= (r['push']['floor'] or 0) <= 0.75), ('floor <.60', lambda r: (r['push']['floor'] or 0) < 0.60)):
    c = cell([r for r in POP if f(r)]); print(f"   {lab:>14}: n={c['n']:3d} [{power(c['n'])}] trailer-WIN {pct(c['win'])} edge {c['edge']*100:+.1f}pp")
print("-- Trigger period --")
for p in (2, 3, 4):
    c = cell([r for r in POP if r['trigger']['p'] == p]); print(f"   Q{p}: n={c['n']:3d} [{power(c['n'])}] trailer-WIN {pct(c['win'])} edge {c['edge']*100:+.1f}pp")

print("\n" + "=" * 100); print("H1 — PRE-FIRE FUEL (features at trigger)")
c1 = report_feature(POP, 'F1', "F1 net POT (leader − trailer) — PRIMARY")
c2 = report_feature(POP, 'F2', "F2 trailer TO rate — reported alongside")
print("\n" + "=" * 100); print("H2 — CLEAN-UP (trailer TO rate change, trigger → push; bet-time ≈7 possessions)")
c3 = report_feature(POP, 'F3', "F3 clean-up delta (negative = cleaned up) — PRIMARY (fine, bet-time)")
print("\n" + "=" * 100); print("DESCRIPTIVE (no bar)")
report_feature(POP, 'F4', "F4 FTA edge (leader − trailer) at trigger", bar=False)
report_feature(POP, 'F5', "F5 trailer unforced-TO share at trigger", bar=False)

print("\n" + "=" * 100); print("SECONDARY — within-bucket controls (ordering only)")
for b in ('1-3', '4-8', '9-15'):
    sub = [r for r in POP if mb(r['trigger']['margin']) == b]
    lo, hi, t = terciles(POP, 'F1')
    cs = {k: cell([r for r in sub if t(r['_f']['F1']) == k]) for k in ('T1', 'T3')}
    print(f"   F1 within margin@trigger {b}: T1 n={cs['T1']['n']} {pct(cs['T1']['win'])} | T3 n={cs['T3']['n']} {pct(cs['T3']['win'])} | Δ {(cs['T3']['win']-cs['T1']['win'])*100:+.1f}pp")
for lab, f in (('floor>.75', lambda r: (r['trigger']['floor'] or 0) > 0.75), ('floor<=.75', lambda r: (r['trigger']['floor'] or 0) <= 0.75)):
    sub = [r for r in POP if f(r)]
    for key in ('F1', 'F3'):
        lo, hi, t = terciles(POP, key); cs = {k: cell([r for r in sub if t(r['_f'][key]) == k]) for k in ('T1', 'T3')}
        print(f"   {key} within {lab}: T1 n={cs['T1']['n']} {pct(cs['T1']['win'])} | T3 n={cs['T3']['n']} {pct(cs['T3']['win'])} | Δ {(cs['T3']['win']-cs['T1']['win'])*100:+.1f}pp")

# ── coarse export: H2 longer-look secondary + hindsight gap ──
print("\n" + "=" * 100); print("COARSE EXPORT (3-min) — secondary reads")
CR = COARSE['rows']
cl_prod = [r for r in CR if r['pattern_prod'] == 'CLEAN']; cl_post = [r for r in CR if r['pattern_posthoc'] == 'CLEAN']
def cw(rs): return sum(1 for r in rs if not r['ctrl_won']) / len(rs)
print(f"   hindsight gap: production-style CLEAN n={len(cl_prod)} trailer-WIN {pct(cw(cl_prod))} | May post-hoc CLEAN n={len(cl_post)} {pct(cw(cl_post))} | overlap n={sum(1 for r in cl_prod if r['pattern_posthoc']=='CLEAN')}")
print(f"   coarse ctrl margin@trigger: " + " | ".join(f"{b} n={len([r for r in cl_prod if mb(r['trigger_margin'])==b])} {pct(cw([r for r in cl_prod if mb(r['trigger_margin'])==b]))}" for b in ('1-3','4-8','9-15','16+')))
def cf3(r):
    T = r['trig']['a'] if r['ctrl_is_home'] else r['trig']['h']; P = r['path'][r['prod_idx']]; Tp = P['a'] if r['ctrl_is_home'] else P['h']
    f2 = T['to'] / T['poss']; d = Tp['poss'] - T['poss']; return ((Tp['to'] - T['to']) / d - f2) if d > 0 else None
xs = sorted(cf3(r) for r in cl_prod if cf3(r) is not None); lo, hi = xs[len(xs)//3], xs[2*len(xs)//3]
def ct(x): return 'T1' if x < lo else 'T3' if x >= hi else 'T2'
for k in ('T1', 'T2', 'T3'):
    rs = [r for r in cl_prod if cf3(r) is not None and ct(cf3(r)) == k]; print(f"   coarse H2 (≈20-poss window) {k}: n={len(rs)} [{power(len(rs))}] trailer-WIN {pct(cw(rs))}")
print(f"   coarse H2 cuts <{lo:.3f} | ≥{hi:.3f}")
