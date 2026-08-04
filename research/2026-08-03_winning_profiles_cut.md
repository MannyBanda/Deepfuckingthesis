# 2026-08-03 — Winning Profiles Cut (#6) + Heat-Flip & Trailer-Temp Extensions

**Status:** INTERIM — live-stream findings complete; 524-game backtest mirror PENDING (pre-registered below).
**Data:** (a) 40 resolved SS rows → **28 deduped games** (20-8, 71%) with fire-time snapshot join (median join gap 0s, zero alias mismatches). (b) Production snapshot archive: **222 finished games, 18,023 snapshots** (May 15–Aug 2).
**Power convention:** HIGH 200+, MED 80–200, LOW <80. LOW = ordering only, no directive precision.

---

## 1. The winning profile at fire (live stream, n=28 deduped — LOW)

| Fire-time feature | Converts | Complement |
|---|---|---|
| Trailer band orange/red | 8/9 (89%) | trailer green 63% |
| Lead class VOLATILE | 8/9 (89%) | STRUCTURAL 50% |
| Killer cell (killer + gap .15–.30) | 6/6 | other 62% |
| Leader band (monotone) | red 78% / orange 75% | green 64% |
| Var share >55 | 3/3 | ≤55 68% |
| Dead cell: L-green + T-green | — | 60% (coin flip + juice) |

**Loss anatomy:** 7 of 8 deduped losses had a cold (green-band) trailer at fire — incl. row 23 (WSH@GS, the one real-money loss) and passes #545, #936. The engine gates only the leader's side; the trailer's capacity to capitalize is ungated and is where every failure lives. Manny's discretionary passes were already pricing this leg.

**Dedupe requirement (methodology):** WATCHLIST + GAP_BASE rows fire on the same games. All stream-level stats must dedupe to one row per game (priority EFG_FADE > WATCHLIST > GAP_BASE) or losses double-count.

## 2. Lead-fuel mechanism inside cold-trailer games (n=19 — LOW)

Question (Manny): when the trailer is cold, what state is the leader's lead in — wins vs losses?

- **Leader points-off-turnovers: WIN med 6.5 vs LOSS med 2.0. pot ≥6 → 7/7 converted; zero losses above pot 5.**
- Trailer TOs at fire: WIN med 4.5 vs LOSS med 1.0. The loss column is trailers playing clean (1–2 TO).
- Composite: transient-fed lead (var>45 OR pot≥6 OR leader red) → 9/11 (82%); earned lead at even temp → 3/8 (38%).

**Mechanism:** a cold trailer coughing the ball up trails on two fixable, self-inflicted leaks, and the leader's margin is takeaway-fed (transient). A cold trailer playing clean and still trailing has nothing to fix — the deficit is pure execution difference. Archetype loss: PHX>GS (#936) — leader cold (43.8), pot 2, trailer 1 TO. Nobody hot, nothing self-inflicted, lead fully earned.

**Doctrinal upgrade:** variance share (3PT+mid share of lead) is blind to a second transient channel — **takeaway points**. LA@DAL converted at var 20 with 13 lead points off TOs. "Whose variance is it" has only been asking about shooting variance.

**KILLED:** roster-regression framing ("no shooters never regress up") for cold trailers — GS has shooters and shot cold anyway (Manny's correction). Cold-at-fire ≠ can't-shoot. Also killed: leader paint-share hypothesis (washed to 50/69 after pts-derivation fix; the initial 64-vs-48 median was junk-row artifact).

## 3. Heat-flip study (222 games — MED/HIGH at bucket level)

State: lead ≥4, P1–P3, leader FGA ≥12. Outcome: leader relinquishes lead at any later snapshot (strict flip), separately from final loss.

- **Base rates:** mid-game leads flip 55–61% regardless. Raw 80+ eFG leads flip 51% — the naive "extreme heat flips more" hypothesis is DEAD; without the control it would have been false-confirmed.
- **Dose-response interaction (the real finding):** hi-var vs lo-var flip gap grows with heat: eFG ≤63 → +2pp; 63–80 → +12pp; **80+ → +40pp (65% vs 25%)**.
- **Lo-var 80+ (paint-fed perfection) = stickiest lead in the sample: 25% flip vs 61% base.** Extreme efficiency on a structural diet is dominance, not variance.
- Elite × var (80+, LOW cells): elite+hi-var flips 50% but elite reclaims — leader-lost only 25%. Elite+lo-var: 1/6 flip, 0/6 lost. Non-elite+hi-var: 82% flip, 55% lost (the sweet spot's home cell in the flip lens).
- **Scalp surface:** hi-var-80+ flip 65% vs final conversion 39% — the 26pp gap is exit/cash-out value, not hold value.
- Team tell (observation only): IND flipped 5/7 extreme-heat leads; LV 0/3; MIN 2/7.
- Caveat: 60s poll cadence — sub-minute flips uncounted; all flip rates are floors. Flip analysis is production-only (BDL historical has no time series); sample grows with season.

## 4. Trailer-temp interaction (222 games)

- **Leader 63–80 (n=127, MED):** monotone trailer gradient — green 47% flip → orange 60% → red 80%.
- **Leader 80+ (n=35, LOW):** trailer green 33% flip vs warm ~65%; cold trailer vs inferno leader = leader runs away (13% ever lose).
- **Leader ≤63 (n=204, HIGH): INVERTS** — trailer green 63% vs hot 53%. Cool-leader/cold-trailer = rock fight, noise flips. A hot trailer still behind a cool leader is structurally buried — heat masking a deep non-shooting deficit, already spent.
- **Pooled main effect: NULL** (trailer eFG med 45.8 flipped vs 44.9 held). **Trailer temp is an interaction term with leader heat, never a main effect.** Reconciles §1: SS fires live in gap-qualified leader-heat contexts, exactly where the gradient holds.
- **Flip-worth (thin slices, ordering):** cold-trailer flips revert (~50% convert to final win); warm-trailer flips hold (67–88%, one wobble at 63–80 red). Direct EXIT_P input: cold-trailer flip = CASH signal; warm-trailer flip = HOLD candidate.

## 5. Doctrine synthesis

**The trailer's temperature never matters by itself — it prices what the leader's state is worth.** The fade thesis has two legs: (1) leader's lead fed by transients (shooting heat OR takeaways — two channels), (2) trailer able to capitalize. The engine currently gates leg 1's shooting channel only.

Secondary: STRONG FADE went 4/4 in the live stream — hold the standing "drop fadeRead" candidate until the mirror weighs in.

## 6. Pre-registered next steps (in order)

1. **Backtest mirror (524-game historical):** within-band spots — (a) trailer eFG temp split; (b) cold-trailer sub-split on trailer TO count, pace-controlled (pot unavailable in BDL; trailer TOs are the proxy); (c) transient-vs-earned composite where reconstructable. This is the multiplicity defense; nothing ships before it.
2. **HEAT_FLIP ledger stream (log-only, candidate):** log every hi-var 80+ state with entry price / best subsequent price / flip Y/N. Requires go-ahead + spec; promotion bar pre-registered before any push behavior.
3. **TRAILER_COLD annotation (candidate):** fire-site trailer band + trailer TO context on SS rows; narration/review-triage only, never tier change. Requires go-ahead + spec.

*No engine changes proposed or made in this session. All findings above are research-only.*
