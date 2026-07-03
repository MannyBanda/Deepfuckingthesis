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
