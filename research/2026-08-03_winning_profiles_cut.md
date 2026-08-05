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

## 6. Loss-path study — losses are round trips (n=8 deduped losses — LOW; added Aug 5)

Post-fire trajectory of every deduped loss, trailer perspective:

| Row | Game | T-band | Def@fire | Best margin | Path | Final |
|---|---|---|---|---|---|---|
| #1038 | CHI>LV | green | 0 | **+12** | FLIPPED | −1 |
| #936 | PHX>GS | green | 5 | **+13** | FLIPPED | −2 |
| #736 | WSH>LV | green | 1 | **+9** | FLIPPED | −1 |
| #587 | WSH>GS (row 23, real $) | green | 1 | **+7** | FLIPPED | −6 |
| #545 | NY>DAL | green | 1 | **+12** | FLIPPED | −1 |
| #365 | CON>POR | red | 9 | −1 | never close | −3 |
| #168 | TOR>NY | green | 4 | 0 | TIED | −2 |
| #89 | POR>ATL | green | 2 | +2 | FLIPPED | −10 |

- **6/8 losses flipped to a lead post-fire; 5/8 lost by ≤2.** The fade thesis converged in 7 of 8 losses — the position died in the close, not the comeback.
- Ties to §4 flip-worth from the independent 222-game sample: cold-trailer flips revert (~50% hold), warm-trailer flips keep it (67–88%). The loss set is exactly the cold-trailer-reversion species.
- **Doctrine pivot: TRAILER_COLD is an exit modifier, not an entry gate.** Cold trailer at fire ≠ pass — they converge anyway. It means: plan to CASH when the flip comes. Warm trailer at fire = HOLD candidate through the flip. Every flipped loss passed through cash-out-profit territory before dying.
- Exception on file: #365 — warm trailer at deficit 9 (band edge, STRUCTURAL) never converged. Different disease; band-edge caution stands.
- Caveats: n=8; 60s snapshots → best margins are floors; dollar quantification of the missed exits requires the post-fire price path (#7 JUICE tape).

## 8. Backtest mirror — the multiplicity defense (524 games, run Aug 5)

Method: sandbox re-fetch of BDL PBP for all 526 harness games; checkpoint boxes rebuilt with the harness's own `reconstructCheckpoints` extracted verbatim — **fidelity 5,260/5,260 margins exact (100.00%)** vs the harness export. States: first pre-Q4 checkpoint with gap ≥.15 (as-of-date win%, GP≥10 both), deficit 1–9, FGA≥10 → **n=132 states, baseline conversion 60.6%**.

**(a) Trailer eFG temp — REPLICATED.** Warm (orange/red) 20/28 (71%) vs cold 60/104 (58%). Weaker than live's 89/63 (expected shrinkage) but direction holds at MED-HIGH power. Trailer-warm > trailer-cold is now **triple-source**: live stream, 222-game flip interaction, 524-game mirror. Validated ordering.

**(b)(c) Lead-fuel mechanism — INVERTED, KILLED.** Mirror: cold trailers with TO<4 convert **76%** vs TO≥4 **49%**; pace-controlled rate split 65/50 same direction. Earned leads fall **75%** vs transient-fed **49%**. Exact opposite of §2. Live-side rate control confirms the live pattern wasn't a clock artifact (W rate .151 vs L .105) — this is a genuine contradiction, resolved by provenance + power: n=19 post-hoc vs n=104 pre-registered. §2's mechanism reverts to logged-hypothesis status. **[SUPERSEDED same day — see §10: Manny's era check resurrected it as a 2026 regime signal.]**

**Context caveat:** leader-band gradient also flattened in the mirror (green 64% best) — the live leader-heat monotonicity may partly reflect engine selection (A/B heat gates) rather than raw edge in unselected states. This does NOT refute the A-tier dual gate (validated separately, 3/3 live); it cautions against extending leader-heat logic to unselected GAP_BASE states.

**What survives the mirror untouched:** the loss-path/round-trip finding (§6), flip-worth (§4), and therefore the **CASH-shape tip candidate (§9.3)** — those rest on the 222-game production sample and live paths, which were never at stake here.

## 9. Pre-registered next steps (updated Aug 5)

**Framing (PM directive, Aug 5): iterate, don't build.** Findings formalize take / pass / cash-out decisions onto EXISTING surfaces — narration text, ntfy tip lines, EXIT_P inputs, D-12 review copy. No new tiers, no new engines. Stream is 14-1; the goal of every item below is protecting that accuracy, not adding machinery.

1. ~~Backtest mirror~~ **COMPLETE Aug 5 — see §8.** (a) replicated; (b)(c) inverted and killed.
2. **Post-fire price path (#7 backlog, promoted):** JUICE tape analysis now quantifies the exit rule — what the round-trip losses' peaks were worth at live prices. Co-priority with the mirror; together they measure the two halves of the same doctrine (entry read + exit read).
3. **CASH-shape tip (candidate, spec required):** when an open fade position flips with a **cold** trailer, append a plain-English cash-out line to existing narration/JUICE alert copy ("trailer was cold at fire — flips like this hold ~50%; check cash-out vs breakeven"). Warm-trailer flip appends the HOLD framing. Rides existing alert surfaces + the standing EXIT_P breakeven rule. No push behavior changes, no tier changes. Go-ahead + spec before any code.
4. **HEAT_FLIP ledger stream (log-only, candidate):** hi-var 80+ states with entry price / best subsequent price / flip Y/N. Go-ahead + spec + promotion bar first.

## 10. Era check — the lead-fuel mechanism is a 2026 regime signal (added Aug 5, Manny's call)

**Why this exists:** §8 killed the lead-fuel mechanism because 2024–25 data contradicted the 2026 live stream. But that comparison changed two things at once — the season AND the selection (fired games vs all games). Manny flagged it: check all-2026 unselected before calling it coincidence. He was right.

**Method:** same state recipe as the mirror, run on all 2026 tracked games — better team (gap ≥.15, true as-of-date records, GP≥10) down 1–9, Q2–Q3, first hit per game → n=67 states, 53 cold-trailer. Pipeline notes: an initial run had a date bug (get_games ignores date params; every game stamped with the last loop date → lookahead in the records). Fixed via single-call true dates; numbers below are clean. Pot attribution verified pot==pot_v2 on all sampled June–Aug snapshots; May rows predate the v2 overlay and are excluded via the GP filter + a ≥Jun-12 sensitivity cut (results unchanged).

**Results (2026 unselected, verified era, cold-trailer n=47):**
- Leader pot ≥6 → trailer converts **18/21 (86%)** vs pot <6 → 38%
- Transient-fed lead → **70%** vs earned → **36%**
- Trailer TO ≥4 → **73%** vs TO <4 → 43%
- Excluding every engine-fired game (zero selection, full-season n=32): transient 67% vs earned 25%
- vs 2024–25 mirror (n=104): transient 49% vs earned **75%** — full inversion between seasons

**Verdict:** the between-season flip survives clean dates, attribution verification, and removal of all fired games. Not coincidence, not selection. Caveat kept honest: the eras also differ in data provenance (2026 = ESPN box stats; 2024–25 = play-by-play reconstruction) so pot definitions aren't identical — but the turnover-count split uses plain counts on both sides and inverts identically, so a real league/era component exists.

**Status: RESURRECTED as a REGIME signal, 2026-only.** A mechanism that inverts between seasons must never be hard-coded into gates. Placement per the iterate-don't-build directive: review/narration context only, with a monthly pulse line in the ledger (does the 2026 pattern persist?). If the regime flips mid-season, the pulse catches it before the bankroll does.

*No engine changes proposed or made in this session. All findings above are research-only.*
