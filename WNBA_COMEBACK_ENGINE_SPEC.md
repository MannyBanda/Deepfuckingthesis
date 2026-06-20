# WNBA Comeback Engine Spec — Bad-Leader Collapse Reading Instrument

**Status:** Proposed — awaiting go-ahead to implement
**Date:** 2026-06-20
**Scope:** `wnba-bdl.html` (client only for Phases 1–2). No server changes, no model retrains, no new data integrations for Phase 1.
**Depends on:** existing divergence read shipped in `1dc9713` (do not re-spec — reuse `sc.fadeRead`).

---

## 1. Objective

Build the read that mirrors Manny's actual edge and replace the predictive machinery's authority with it.

**The edge (validated this session, 113-game WNBA set):** a quality team trailing a bad team whose lead is built on unsustainable shooting. The market prices the deficit off the field's comeback rate and under-adjusts for who the teams are. We harvest the gap between the line and the true comeback rate, **captured at entry** (it is a price edge, not a post-entry drift), sized with fractional Kelly, held through noise.

This is the **inverse of graduation**: when a 2–14 team builds a 12-point lead, graduation says "lead is safe." This engine says "that lead is fragile — here's the chaser, the edge, and the size."

---

## 2. Validated research the engine encodes

All figures from this session's analysis (`/tmp` caches; reproducible from db-api `get_games` + `history` + `get_odds`, `&league=wnba`).

**2.1 Quality gap is the master variable** (trailer win% − leader win%, trailing 1–9, Q2–Q3):

| gap | comeback | n |
|---|---|---|
| much worse (< −.20) | 7% | 60 |
| worse | 30% | 46 |
| even (±.05) | 41% | 39 |
| better (.05–.20) | 35% | 43 |
| much better (.20–.40) | 58% | 38 |
| dominant (> .40) | 75% | 16 |

r = 0.40 (n=242). Leader quality independently matters: among better-record trailers, **good leader (>.55) holds → 33% comeback; bad leader (<.40) → 62%.**

**2.2 Bad-leader collapse by depth** (leader <.40 win%, the core setup) — the comeback rate decays with depth but the **edge over the market grows**, then dies at 20+:

| deficit | actual comeback | market implied (live ML) | edge | median line |
|---|---|---|---|---|
| down 1–5 | 68% / 77%* | 53% | +25pp | −125 |
| down 6–9 | 56% / 57%* | 34% | +23pp | +180 |
| down 10–14 | 50% | 23% | +27pp | +450 |
| down 15–19 | 44% | 13% | +31pp | +1000 |
| down 20+ | **0–20%** | 23% | **−3pp (TRAP)** | +1600 |

(*odds-matched subset.) **Sweet spot: down ~8–18, lines +400 to +1000.** Down ≥20 is a trap (market is right; edge negative).

**2.3 The mechanism is regression, not heroics** (bad-leader collapse decomposition, half-by-half eFG vs season norm):

- Comeback games: **leader built lead at 56% eFG (9 over its 47% norm), then cratered to 42%**; trailer shot its norm both halves (53%→54%). The collapse is the *leader's* hot shooting regressing — the chaser does not need to get hot.
- Held games: leader regressed only to its norm (~46%); trailer played *below* itself (47%/46%). Losses = the chaser can't hold its own level, not failure to spike.

**2.4 Things explicitly tested and rejected as gates:**

- **Chaser shooting at/above its own norm** → NOT a buy signal. Pooled it's flat (69% vs 70%). It **inverts with depth**: shallow at/above wins (81% vs 71%) but **deep at/above collapses (17% vs 67% for below)** — n=6/12, thin but mechanically sound (a maxed-out chaser has no reversion fuel left at depth). Do not gate on it.
- **eFG-self-reversion** ("cold team bounces back") pooled → noise (36/34/37).
- **Season-prior regression** is asymmetric: apply it to the **leader** (hot = fragile = our edge), never to the trailer as a fade.
- **MC / XGB / floor win-prob** → worse than the scoreboard every quarter in WNBA (Q2 −2.4, Q3 −2.7, Q4 −3.9 pp). Demote from decision authority.

**2.5 Sizing:** full Kelly on these edges returns 33–49% of bankroll — correct math, reckless practice on n=9–60 estimates. **Quarter-Kelly → ~8–12% of roll**, which matches Manny's instinct ($5k on a +1000 at a ~$50k roll). Size off the fraction.

---

## 3. Signal stack & guardrails

**Inputs (all client-side already):**
- `leaderWinPct`, `trailerWinPct` ← `standingsCache[alias]` `{w,l}` → `w/(w+l)`, require `w+l ≥ 4`.
- `deficit`, `period`, `clock` ← `g.homePoints/awayPoints`, `g.period`, `g.clock`.
- `liveML` (trailer side) ← `cs.oddsData.homeML / awayML`.
- `fragility` (optional confirm) ← `cs.scoringComp.fadeRead` (the shipped divergence read; league-band based).

**Hard gates:**
1. **Leader must be beatable:** `leaderWinPct < 0.40`. Otherwise `NO_EDGE` ("competent leader — market is fair").
2. **Depth ceiling:** `deficit ≥ 20` → `DEAD` ("too deep; bad teams still hold 20+; edge negative").
3. **Data floor:** both records need `≥4` games, else `NO_DATA` (fall back to descriptive panels only).

**Gradients (not gates):**
- Quality gap → places the estimate within its range (bigger gap = high end).
- Fragility (`fadeRead.tier === 'STRONG'`) → confidence up (regression more certain).
- Deficit `≤ 7` → valid but flagged "short odds, small payoff."

**Explicitly NOT used as a gate:** the chaser's own shooting vs norm (§2.4 — inverts at depth).

**Output framing:** take-and-hold. The read must NOT imply a favorable post-entry drift (§2.3 short-term is a coin flip). No exit prompts on short-term swings.

---

## 4. Architecture

**Decision: inline in `wnba-bdl.html`, adjacent to `divergenceRead` (~line 3663).** The client is a single-file design with no module system; a separate file would be the anomaly. Total Phase 1 ≈ 250–300 lines (2 pure functions + 1 render section + 1 `renderCard` hook). No server module.

**Why no server work:** records, line, and composition are all already client-side. A server-side ntfy would require plumbing `standingsCache` into `poll-live-bdl.mjs` (which has no standings fetch today) — deferred to Phase 3 and optional, since Manny bets by reading, not by alert.

---

## 5. Phase 1 — The comeback read

### 5.1 `comebackProb(leaderWP, trailerWP, deficit, period, clock, fadeRead)` → object

Pure function. Returns:
```
{ tier, pLow, pHigh, pPoint, gap, drivers[] }
```

Logic:
```
if leaderWP==null || trailerWP==null            → {tier:'NO_DATA'}
if leaderWP >= 0.40                             → {tier:'NO_EDGE'}
if deficit >= 20                                → {tier:'DEAD'}

base = depthCurve(deficit):           // §2.2 bad-leader rates
  1–5:0.68 · 6–9:0.56 · 10–14:0.50 · 15–19:0.44
band = ±0.07                          // thin-sample CI, surfaced as a range

gap = trailerWP - leaderWP
lean = clamp((gap - 0.20)/0.20, -1, +1) * 0.05   // bigger gap leans high end
pPoint = clamp(base + lean, 0.10, 0.85)
if fadeRead?.tier==='STRONG': pPoint += 0.03; drivers.push('fragile lead (built on variance)')

pLow = pPoint - band; pHigh = pPoint + band

tier =
  deficit<=7                          → 'SHORT'   (valid, short odds)
  gap>0.20 && deficit 8–18            → 'STRONG'
  gap 0.10–0.20                       → 'MODERATE'
  gap<0.10                            → 'THIN'
```

### 5.2 `comebackEV(pLow, pPoint, liveML)` → object

```
implied = americanToImplied(liveML)            // +ML→100/(ML+100); −ML→(−ML)/(−ML+100)
edge    = pPoint - implied                     // report
edgeLow = pLow  - implied                       // conservative
if edge <= 0 → {verdict:'NO_VALUE'}            // market fair-or-better
decNet  = liveML>0 ? liveML/100 : 100/abs(liveML)
fullK   = (pLow*(decNet+1) - 1)/decNet          // Kelly off the LOW end (conservative)
size    = clamp(0.25*fullK, 0, 0.12)            // quarter-Kelly, hard cap 12%
return {implied, edge, edgeLow, size, line:liveML}
```

### 5.3 `renderComebackRead(id, cs, g, hA, aA)` → html

Resolves leader/trailer from current score, pulls records + line, runs §5.1–5.2, renders. Output variants:

- **STRONG/MODERATE/SHORT/THIN:**
  > **COMEBACK · {tier}**
  > {chaser} ({tw}-{tl}) chasing {leader} ({lw}-{ll}), down {d} in {Q}{ — fragile lead}
  > true ~{pPoint}% ({pLow}–{pHigh}) · line {ml} (~{implied}%) · **EDGE {edge}pp**
  > size ~{size}% of roll (¼-Kelly) · *take & hold — no exit on short swings*
- **THIN/SHORT** add a muted note: "thin gap / short odds — small or pass."
- **NO_VALUE** (edge ≤0): "line already prices the comeback — pass."
- **DEAD:** "down {d} — too deep; bad leaders hold 20+. No edge (market's right)."
- **NO_EDGE:** "{leader} is competent ({lw}-{ll}) — no quality mispricing. Pass."
- **NO_DATA:** render nothing (records unavailable); descriptive panels stand alone.

### 5.4 Insertion

`renderCard`, immediately after the HERO block (~line 1487), before the WP/XGB chart. Headline placement so the read is the first thing seen even before the Phase-2 reshape. Self-contained; references `cs.scoringComp?.fadeRead` defensively (may be null pre-PBP-fetch).

### 5.5 Helpers

`americanToImplied(ml)`, `depthCurve(d)` — small, colocated. Reuse existing `tc()`, `esc()`, `ordinal()`.

---

## 6. Phase 2 — The reshape (separate ship)

Reorder `renderCard` so the **descriptive cluster leads** and the **predictive cluster collapses to reference**:

**Promote to top (after comeback read):** `renderScoringCompSection` (3819, composition + divergence), `renderDepthAuditSection` (3523, sustainability).

**Demote into a collapsed "Reference" drawer** (reuse the existing `toggleColl` pattern): the WP/XGB chart toggle (~1487–1514), the signal pills (~1521), `renderMCStrip` (~1545), the always-on MC Cum/PBP/XGB row (~1729), MC Drivers (~1743). They keep rendering; they lose primacy.

Touches `renderCard` structure + relocates the MC/XGB call sites into the drawer body. No logic changes to the demoted functions. ~80–120 lines of reordering.

---

## 7. Phase 3 — Refinements (deferred)

- **Injury haircut:** SR injuries (server proxy `sr-data.js`) → discount `trailerWP` as *caution* (not a green light). Applied as a confidence/size reduction. Requires client fetch of injuries or a passthrough.
- **Point-differential quality:** stronger talent proxy than W/L in a young season; compute from games or extend standings fetch.
- **Team-specific fragility:** wire WNBA season eFG to client (no sync today) for "lead built above *its own* norm" precision, replacing the league-band proxy.
- **Re-run the deep at/above-vs-below split** (§2.4) once more games exist — n=6/12 is the weakest cell in the stack.
- **Optional quiet ntfy:** plumb `standingsCache` into `poll-live-bdl.mjs`, fire low-priority on STRONG setups.

---

## 8. Cascading implications

- **Server untouched (Phases 1–2).** MC/XGB/graduation/alert agent/learning agent all keep running server-side. We demote client *prominence*, not server function → low blast radius.
- **Divergence relationship:** `sc.fadeRead` (shipped) becomes the comeback engine's *fragility confirm* and remains visible in the scoring-comp section as the even-matchup tiebreaker. No duplication — the comeback read is the general engine, divergence is its leader-side input. Not folding it out of scoring-comp; reading it in.
- **`fetchStandings` season param (`'2025'`)** — VERIFY returns current-season records before trusting the engine. If BDL keys 2026 differently, the engine silently degrades to `NO_DATA`. Pre-req check.
- **`cs.oddsData` null cases:** pregame / no-odds → render the read without EV (probability + tier only), label "no live line."
- **Subscriber UX:** demoted predictive content must stay reachable (drawer), not deleted.

---

## 9. Dead code

None identified for Phase 1. Phase 2 relocates (does not delete) predictive renderers. Flag any genuinely-orphaned blocks during implementation, per standing practice.

---

## 10. Test plan (Claude owns)

`comebackProb` / `comebackEV` are pure → unit-test against this season's real spots, asserting tier/range/edge/size against known outcomes and the lines pulled this session:

| fixture | setup | expected |
|---|---|---|
| TOR over CON (2–14), down ~12 Q3 | bad leader, gap ~+.34, fragile | STRONG, edge ≥ +25pp, size ~8–10% |
| MIN over GSV (10–5), down ~8 | good leader | NO_EDGE (competent leader) |
| any down-22 vs bad leader | depth ≥20 | DEAD, no size |
| held-game profile (leader regressed to norm, trailer below) | — | tier fires but outcome=loss (sizing-gradient calibration check) |

Build fixtures from `/tmp/h_*.json` + `/tmp/o_*.json`. Syntax-gate via the HTML `<script>` extraction (`sed … | node -c`) before any commit. This is the regression net the aliasMap incident argued for.

---

## 11. Open decisions for Manny

1. **Phase-1 insert location:** top-of-card (headline, my recommendation) vs. adjacent to scoring-comp (lower disruption).
2. **`pPoint` vs range in the headline:** lead with the point estimate or the range? (I lean range-forward to keep honesty about the gradient.)
3. **Kelly conservatism:** size off `pLow` (my default) vs `pPoint`.
4. **Phase ordering:** ship Phase 1 engine first, then reshape — or reshape first so the read lands in its final home?
