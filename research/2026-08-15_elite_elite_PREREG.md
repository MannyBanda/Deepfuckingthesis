# PREREG — Elite-vs-Elite Stream Feasibility (v1)

**Date:** 2026-08-15 (committed before any test-surface data cut)
**PM approval:** Manny, in chat, Aug 15 2026 ("Yeah I'm good with this approach")
**Motivation:** Fade country (sub-.400 beatable leaders) structurally closes in the playoffs — by mid-September every leader is a quality leader. Elite-elite is the only candidate lane for postseason live betting. This prereg tests whether any measurable edge exists there before proposing even a log-only stream.

---

## Population

- Both teams win% ≥ .550 **as-of the state date** (strict <, per fine-arena as-of convention), each with ≥ 12 GP.
- Trailer deficit 1–9.
- Primary window: pre-Q4 (gameSec in the 750–2250s coarse-comparable window where the arena is used; full-game on the 2026 archive).
- One dedupe convention per analysis, stated in the findings doc (state-level rates by default, matching SS_STRUCT; game-level counts reported alongside).

## Instruments & contamination disclosure

**The fine arena is CONTAMINATED for H2.** The Aug 15 exploratory cut (in-chat, unregistered) that generated the fuel-inversion hypothesis was run **on the fine arena** (pool: elite-elite, gap>0, deficit 1-9 → EARNED 70.0% n=30 / TRANSIENT 36.8% n=117; ordering held in both seasons). The arena therefore cannot confirm H2 — it can only fail to contradict it.

- **Primary test surface (H1, H2):** the 2026 live archive (production snapshots, ~215+ finished games) joined to the live ML tape from `odds_history` (≤3–4 min join, same convention as the FUEL map study). This surface has not been cut for elite-elite in any form.
- **Descriptive surface (H3, H4):** fine arena, 30s grain, committed states files. Descriptive only; no promotion authority.
- Fuel on the 2026 surface uses production `computeFuelTemp` stamps where present; where absent, the arena's `earned` reconstruction convention, with the mapping stated in the findings doc. Lead-class STRUCTURAL is reported as a secondary proxy, separately, never pooled with EARNED.

## Hypotheses & bars

**H1 — gap ordering survives the market.**
On 2026 elite-elite states: trailer conversion for gap ≥ .10 exceeds gap < 0 by **≥ 10pp**, AND the gap ≥ .10 cell shows **positive edge vs the de-vig market** (primary metric, per standing rule). Both conditions required. Below n=40 states in the gap ≥ .10 cell: report ordering only, H1 is UNDERPOWERED, not passed.

**H2 — fuel inversion (the live hypothesis).**
Within 2026 elite-elite, positive gap, deficit 1–9: EARNED/structurally-built leader leads convert-against at a higher rate than TRANSIENT leads, AND the earned cell beats the de-vig market by **≥ 5pp**. Below n=25 per fuel cell: ordering only, no promotion, and the finding stays tagged EXPLORATORY regardless of direction.

**H3 — episode geometry (descriptive, no bar).**
Fine arena, 30s grain: distribution of trailing-episode duration and max depth for elite-elite vs fade-country (leader < .400, gap ≥ .15) matchups. Motivating observation (Aug 15, MIN@LV): two windows, ~90s each, max depth 3. Deliverable: duration/depth distributions + the share of episodes shorter than the current alert path's median fire latency. Informs stream *design*, not stream *existence*.

**H4 — playoff annex (descriptive, ordering only regardless of n).**
Arena split: regular-season vs playoff states, elite-elite only. Expected tiny n; no precision will be reported.

## Multiplicity & discipline

- Cells examined are the ones named above; any additional cut is labeled POST-HOC in the findings doc.
- Both-seasons rule applies to any arena-side structural claim; the 2026 surface is single-season by construction and everything from it carries a `[this season]`-class tag.
- Retractions, if any, get same-session prominence.

## Promotion rule

**Nothing ships to code from this prereg.** The best possible outcome is a *proposal* for a WATCHLIST-class, log-only elite-elite stream, which would require its own separately pre-registered spec (including fire-latency design informed by H3). No sizing authority, no tier language, no dashboard surface changes.

## Paper ledger (companion, live immediately)

`research/paper_ledger.md` — newest-on-top. Manny's discretionarily-called elite-elite (and other off-stream) spots, logged at the window with: timestamp, matchup, side, live price at call, hypothetical stake, thesis in one line. Resolved in the nightly digest pass. **Zero dollars, separate accounting from the bets table, never pooled with real-money streams.** Purpose: measure whether immersion-trained instinct carries predictive edge, on the same terms GAP_BASE measures the mechanical signal (target ~20–30 calls before any read).
