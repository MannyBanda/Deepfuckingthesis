# SWEETSPOT TIER B & C SPEC — Earned-in-Replay Tier Ladder

**Date:** 2026-07-02 · **Status:** FINAL, awaiting build go-ahead · **Baseline:** `163f091` (§4c live)
**Fulfills:** SWEETSPOT_ENGINE_SPEC.md §"A/B tiering (LOCKED)" — *"B deferred until the replay
earns its threshold"* — and §"C tier — Q4 collapse-only (DEFERRED, post-A/B)". The replay is done
(two layers below); thresholds are now earned, and one candidate tier was **rejected** by it.

---

## 1. The replay (evidence base)

**Layer 1 — research corpus** [BACKTEST, 720 games; halftime, deficit 1–9, gap ≥ .10, n=121,
base 52.9%]. Leader/trailer team-eFG dev vs own season norm as the analog of the prod fade/class
reads:

| Cell | Comeback | n | Reading |
|---|---|---|---|
| A-analog: Ld ≥ +.08 & Td ≤ 0 (both clean) | 64.7% | 17 | current A territory |
| **B1: Ld +.04..+.08 & Td ≤ 0 (fade soft)** | **70.0%** | 10 | one-soft, holds |
| **B2: Ld ≥ +.08 & 0 < Td < Ld (variance soft)** | **56.2%** | 32 | one-soft, holds |
| **POOLED B (one clean / one soft)** | **59.5%** | **42** | between base and A ✓ |
| NO-HEAT: Ld < +.04 | 40.8% | 49 | correctly excluded |
| B-cells WITHOUT gap (sanity) | 21.6% | 74 | gap gate is non-negotiable |

**No-heat by gap size (the B-GAP kill):** gap≥.10 → 40.8% (49) · ≥.20 → 37.9% (29) · ≥.25 →
36.4% (22) · ≥.30 → 37.5% (16). **Flat/degrading.** The pooled-gap rise with gap size (52.9→62%)
is heat correlation, not gap magnitude. A no-amplifier auto-push tier is a ~40% cell — NOT earned.

**Layer 2 — prod replay** [PROD, 8 games since ss_ columns populate (2026-06-28), 7 gap spots;
sanity only]. Yielded (a) the live enum vocabulary — fade: STRONG FADE / **LEAN FADE** / NO FADE /
NO EDGE / EVEN; class: VOLATILE / **MIXED** / STRUCTURAL / EVEN; collapse: STRONG / SHORT /
NO_EDGE / NO_QUALITY_EDGE / DEAD — and (b) the motivating anecdote **and its refutation**:
DAL@CON (gap .37, deficit 6–8, collapse STRONG, model edge +.19, fade=NO FADE → tier None,
trailer won). Layer 1 shows that cell runs ~38–43%: the spot was a survivor of a losing class and
the +.19 model edge is presumptively **collapse_true overstatement where heat is absent** —
consistent with the fadeRead-reframe finding. It becomes a ledger row, not a push.

## 2. Tier definitions

**A — unchanged.** Pristine dual-gate, live since today (`WNBA_SS_ALERT_ON=1`).

**B — one clean / one soft (PUSH, ships dark behind `WNBA_SS_B_ON`).** All A conditions
(edge > 0, pre-Q4, deficit ≤ 9, collapse ∈ {STRONG, SHORT}) with exactly one gate softened,
both reads still leader-keyed (trailer-variance trap remains excluded by construction):
- **B1 (fade soft):** `fadeTier === 'LEAN FADE'` AND `leadClass === 'VOLATILE'`
- **B2 (variance soft):** `fadeTier === 'STRONG FADE'` AND `leadClass === 'MIXED'`
Prior ~59.5% [BT n=42, LOW-MED power — ordering reliable, point estimate soft]. Mechanical,
0-Opus, NOT Opus-suppressable (per original tiered-authority design). §4c player-context digest
runs for B exactly as for A.
- Subtype: `EFG_FADE_SOFT` (distinct subtype → dedup index works unchanged; A can still fire
  later on the same game as an upgrade).
- **A-suppresses-B:** if an A row already exists for the game, skip B (indexed SELECT on the
  rare fire path). B-then-A is allowed (upgrade push).
- Push: priority 4 (A is 5). Body prefix `SWEET SPOT B` + one added clause: `Soft gate: {which}.
  Base-rate tier — size down.` Kelly display: **1/8-Kelly** (half of A's 1/4) pending PM call.

**C / ledger subtypes — rows only, NO push (`ntfy_sent=false`), behind `WNBA_SS_LEDGER_ON`):**
- **`GAP_BASE`:** collapse ∈ {STRONG, SHORT} + deficit ≤ 9 + pre-Q4 + edge > 0, fade/class
  failing both A and B shapes. The no-amplifier LOCKED spot — ~40% cell whose *model calibration*
  (`collapse_true` vs realized) is the open question the ledger answers. Also auto-logs the
  CON-style spots Manny tracks manually (serves the nightly-log ritual for this class).
- **`Q4_COLLAPSE`:** period = 4, deficit 10–15, collapse ∈ {STRONG, SHORT}, edge > 0. The
  original C intent (down-13-in-Q4), zero validated cell + "Q4 nearly dead" prior → **log-first;
  the push (and its Opus-suppress machinery) is deferred until this ledger earns it**, exactly as
  B just earned its threshold. One row per game per subtype (dedup index handles it).

Graduation bar (both ledger subtypes): ≥30 rows AND realized rate within 5pp of `collapse_true`
mean → propose promotion; miscalibration confirmed → recalibrate `collapse_true` in that cell or
retire the subtype.

## 3. Implementation map (~80–100 lines, 1 file, no schema changes)

- **Gate block (~8080):** after the A evaluation, evaluate B1/B2 shape → `_ssTier='B'` +
  `_ssSubtype='EFG_FADE_SOFT'`; else evaluate ledger shapes → in-memory subtype for a
  **row-only insert path**. `ss_alert_tier` snapshot column already TEXT (holds 'B').
- **`fireSweetSpotAlert`:** accepts `ss.subtype` (already does) + tier-aware body/priority; a
  `ledgerOnly` flag on `ss` skips Stage 1b ntfy + Stage 2 narration but keeps Stage 1a insert +
  Stage 1.5 digest (carrier context on ledger rows too — free forward OOS for role-carry in
  GAP_BASE spots). A-suppress check before B insert.
- **Flags:** `WNBA_SS_B_ON`, `WNBA_SS_LEDGER_ON` (both default off, ship dark).
- **db-api:** none — columns and dedup index already support everything.
- **NBA:** byte-identical (same WNBA-gated block).

## 4. Test plan

- Fixtures: B1/B2/neither shape classification; A-suppress logic; ledgerOnly path (insert, no
  ntfy call).
- `ss_force_test=3` → synthetic B (LEAN FADE + VOLATILE) end-to-end incl. pctx; `=4` → synthetic
  GAP_BASE ledger row (assert `ntfy_sent=false`, digest present, no push).
- Replay-parity: re-run the Layer-2 prod pull after deploy; assert the DAL@CON snapshots
  classify as GAP_BASE (not B), LV@NY spots classify as none.
- First live B fire = validation game (audit vs box, same as A).

## 5. Rollout

```
commit → push → sleep 60 → ss_force_test=3 → ss_force_test=4 → ss_force_clear=1
→ set WNBA_SS_LEDGER_ON=1 (silent, safe immediately) → observe 1 slate
→ set WNBA_SS_B_ON=1 when ready
```

## 6. PM decisions

| # | Decision | Rec |
|---|---|---|
| D-1 | B Kelly display fraction | 1/8-Kelly |
| D-2 | A-suppresses-B / B-then-A upgrade allowed | yes / yes |
| D-3 | GAP_BASE as ledger-only (not push) despite covering the manual CON pattern | yes — the 40% cell + calibration question; ledger graduates it if the line truly cushions |
| D-4 | Q4_COLLAPSE deficit band 10–15 | yes (10–15; >15 is DEAD territory) |
| D-5 | Ledger graduation bar (n≥30, ±5pp calibration) | as stated |


---

# AMENDMENT 1 (2026-07-02, same session) — Volume Frontier: B3 cell + WATCHLIST tier

**Trigger:** PM volume review — A+B halftime-only counts (8.2%) understated live volume, and the
manual dashboard workflow (~2 finds/week, high precision) is the system's best expansion asset.

## A1.1 The measured frontier (720 games, first qualifying checkpoint of Q1/Q2/Q3-end)

| Config | Games | Win% |
|---|---|---|
| A+B shape, halftime only | 8.2% | 61.0% |
| **A+B shape, any checkpoint** | **20.0%** | **59.0%** |
| + B3 mid-heat cell | 21.2% | 58.8% |
| + deficit 1–12 | 22.2% | 56.2% (rejected: −3pp) |
| + gap ≥ .05 | 23.5% | 56.2% (rejected: −3pp) |
| all relaxations | 28.2% | 53.2% (rejected: barely above band) |
| **Band entry gap ≥ .15 (WATCHLIST)** | **27.5%** | **58.6%** |

**Volume correction:** live A+B expectation is ~1 alert per 1–2 slates (any-checkpoint ≈ 20%
shape-level, trimmed by line/edge gates), not the 1–2/month implied by halftime-only counts.

## A1.2 B3 — mid-heat cell (added to Tier B)

`fadeTier === 'LEAN FADE'` AND `leadClass === 'MIXED'` (research analog: Ld .04–.08 &
0 < Td < Ld). Honest note: this is **both gates one step soft** — a deliberate relaxation of the
original "one clean / one soft" rule, priced by the frontier at **−0.2pp pooled for +6% volume**
(the cheapest volume on the board). Same subtype `EFG_FADE_SOFT`, same push shape; the
soft-gate body clause names both: `Soft gates: fade + variance (one step each).` Everything else
in §2-B unchanged (leader-keyed, edge > 0, deficit ≤ 9, pre-Q4, A-suppresses-B, 1/8-Kelly).

## A1.3 WATCHLIST — attention-routing tier (PUSH, dark behind `WNBA_SS_WATCHLIST_ON`)

**Philosophy:** Manny is the high-precision discretionary filter; the system's job is ensuring he
never misses a band game, not replacing his judgment. Not a bet signal — a review cue.

- **Trigger:** first poll with `gap ≥ .15` AND deficit 1–9 AND period ∈ {2, 3} AND standings
  available. One per game (subtype `WATCHLIST`, dedup index).
- **Push:** ntfy priority 2, single line, explicitly non-directive:
  `REVIEW: {trailer} down {N} to {leader} (gap {g}). Leader eFG {x}% ({band}), class {cls}. Check dashboard.`
- **No Opus.** Stage 1.5 digest **runs** (carrier cols + ctx JSON on every watchlist row) —
  band-scale carrier ledger is exactly the forward-OOS feed role-carry graduation needs, at ≤3
  BDL calls per ~daily fire.
- **Ordering:** watchlist typically precedes A/B (band entry before gates align); A/B fire
  normally after a watchlist (upgrade). If A/B somehow fired first, suppress watchlist (same
  existing-row check as A-suppresses-B).
- **Prior:** band gap ≥ .15 pools 58.6% [BT n=198] — quality of the *pool*, not a bet claim.

## A1.4 Follow-on unlocked: formalize the discretionary layer

Once watchlist + ledger rows accumulate, join `research/betting_log.md` bets against stored gate
states per game → measure which cells Manny's manual bets land in and what features separate his
takes from his passes within the band. Promotable features become future tier candidates — the
"mine Manny's alpha" loop. (Research task, own hypothesis doc, not this build.)

## A1.5 Deltas to §3–§6

- **§3 LOE:** +~30 lines → **~110–130 total**, still 1 file, no schema changes. New flag
  `WNBA_SS_WATCHLIST_ON`.
- **§4 tests:** fixtures for B3 shape + watchlist trigger/dedup/suppress; `ss_force_test=5` →
  synthetic WATCHLIST (assert priority-2 push shape + digest + no narration).
- **§5 rollout:** unchanged sequence + `set WNBA_SS_WATCHLIST_ON=1` may precede B (independent
  flags; watchlist is the lowest-risk enable).
- **§6 PM decisions added:** D-6 watchlist copy/priority (rec: as A1.3) · D-7 digest on watchlist
  rows (rec: yes) · D-8 late-Q1 watchlist eligibility (rec: no for v1, Q2+ only; revisit if the
  ledger shows Q1-qualifying games converting) · D-9 B3 inclusion despite two-soft deviation
  (rec: yes — frontier-priced at ~free).


---

# AMENDMENT 2 (2026-07-02, same session) — Push Copy Standard (plain English, terms in full)

**Trigger:** PM directive — alerts must be clear plain English, most important information first,
every term stated in full (e.g. "quality gap", never bare "gap"). This is the project's alert-body
law applied rigorously; the LIVE A body currently violates it. Copy is code: templates below are
verbatim build targets.

## A2.1 Principles

1. **Title carries the action + price** — the one glance that matters on a lock screen.
2. **Body order: WHY → NUMBERS → SIZE** (the what is already in the title).
3. **Every metric glossed on first use;** percentages, never decimals (35%, not .353).
4. **Quality gap is always shown as both win rates** ("wins 71% of games vs 35%"), with the label.
5. Internal vocab (collapse tier, band colors, lead class enums) never appears raw in a push.

## A2.2 Term standard (applies to all tiers + Stage-2 narration)

| Internal | Push copy |
|---|---|
| gap | "quality gap" + both win rates spelled out |
| eFG / band | "effective FG (shooting efficiency)"; band → "running red-hot"/"running hot" |
| variance share | "{X}% of their lead comes from hot shooting rather than structure" |
| collapseTrue, pLow–pHigh | "model true win chance ~{X}% (range {lo}–{hi}%)" |
| impliedBest | "the market prices them at {X}%" |
| edge | "+{X}-point edge (model vs market win probability)" |
| kellySize | "~{X}% of bankroll (quarter-Kelly)" / "(eighth-Kelly — half of A sizing)" |
| bestML/bestBook | "+{ML} at {Book} (consensus +{ML})" |
| window | "valid while the deficit stays single digits, before Q4" |

## A2.3 Verbatim templates (build targets — replaces Stage 1b body at ~810)

**A** — title: `SWEET SPOT A — Back {TRAILER} +{ML} ({Book})`
```
Back {TRAILER} ({W}-{L}) down {N} to {LEADER} ({W}-{L}), Q{P} {clock}.
WHY: {LEADER}'s lead is built on hot shooting — {efg}% effective FG (shooting efficiency),
and {var}% of their lead comes from that heat rather than structure. {TRAILER} is the far
better team: wins {tw}% of games vs {LEADER}'s {lw}% (quality gap).
NUMBERS: model true win chance for {TRAILER} ~{ct}% (range {lo}–{hi}%) vs the market's {imp}%
— a +{edge}-point edge. Best price +{ML} at {Book} (consensus +{cML}).
SIZE: ~{k}% of bankroll (quarter-Kelly). Valid while the deficit stays single digits, before Q4.
```

**B** — title: `SWEET SPOT B — Back {TRAILER} +{ML} ({Book})`
Same as A, plus after WHY: `TIER B: {one gate is a step soft: {shooting-heat read moderate |
lead-mix read moderate} | both reads a step soft} — confidence a notch below A.`
SIZE line: `~{k}% of bankroll (eighth-Kelly — half of A sizing).`

**WATCHLIST** — title: `REVIEW — {TRAILER} down {N} to {LEADER} (not a bet call)`
```
{TRAILER} is the much better team — wins {tw}% of games vs {LEADER}'s {lw}% (quality gap) —
and trails by {N} in Q{P}. {LEADER} shooting {efg}% effective FG{ — running hot}.
System gates haven't aligned for a bet; worth a dashboard look.
```

**Stage-2 narration prompt (§4c) — add one instruction line:** `State every metric in full plain
English on first use — say "quality gap" and "effective field-goal percentage", never bare "gap"
or "eFG"; use percentages, not decimals.`

## A2.4 Scope & deltas

- **A-body retrofit included in this build** (copy-only change to the live path, no flag; the
  live A alert adopts the standard the moment B/C ships).
- §4 tests: force-tests 1/2/3/5 assert the new copy shape (title contains price+book; body
  contains "quality gap" and "effective FG"; no raw band colors or "pp"/"1/4-Kelly" jargon).
- LOE: +~15 lines (template literals) → **~125–145 total**, unchanged elsewhere.
- **PM decision D-10:** approve templates verbatim or edit wording before build.


## A2.5 Push budget (dedup & frequency — explicit)

**Never per poll.** Every subtype inserts `ON CONFLICT DO NOTHING` against the unique index
`(game_id, alert_subtype)` — **one fire per game per type for the game's lifetime**, enforced
atomically at the DB (no re-fire on later re-qualification; proven live via the force-test
stale-row block this session).

Per-game arithmetic: WATCHLIST = 1 push (no narration) · B = 2 (WHAT + WHY) · A = 2 ·
ledger subtypes = 0, ever. Suppression: A ⟶ suppresses B; A/B ⟶ suppress WATCHLIST.
Max stack (full escalation watchlist → B → A-upgrade): 5 pushes per game — rare; typical
triggering game: 1–3. Slate expectation (4 games): ~2–4 pushes/night total.

**PM decision D-11:** B keeps its second (WHY narration) push like A, or single-push?
Rec: keep two-push parity — B is an actionable bet signal; the WHY is where sizing judgment
lives. Revisit if B volume feels noisy after a few weeks live.
