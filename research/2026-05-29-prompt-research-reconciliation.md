# Agent Prompt ↔ Research Reconciliation Audit

**Date:** May 29, 2026
**Author:** Manny + Claude
**Status:** Findings report. Source-of-truth for the agent prompt rewrite. NO code changed.
**Trigger:** Rigor audit of "which validated findings actually deserve prompt real estate," prompted by
the realization (May 29) that our measurement has graded a strawman policy ("bet every fire") rather than
the two-stage confluence-then-odds bet actually placed.

## Scope reconciled

**Research corpus (all read in full):**
- `2026-05-17-wnba-signal-margin-analysis.md` — Findings 1–13 (OOF-clean, 526 games / 5,260 checkpoints)
- `2026-05-05-windowed-xgb-mc-cum-findings.md` — NBA windowed XGB + MC Cum (1,233 games)
- `2026-05-06-graduation-simplification-findings.md` — compound graduation (1,234 games)
- `2026-05-08-wnba-prompt-backtests.md` — WNBA BUY structure (312 games)
- `2026-05-08-wnba-architecture-research.md`
- `2026-05-28-wnba-canary-profitability.md` — newest, NOT shipped (576 games)
- `AGENT_DIVERGENCE_SPEC.md` (May 13) — the spec that authorized failure-profile + divergence context

**Implementation reconciled against:** `netlify/functions/poll-live-bdl.mjs` `buildV2AgentPrompt` +
divergence/failure-profile classification block (lines ~7869–7993, ~742–905).

---

## Executive summary

There is **one root cause** behind most of the high-severity findings, and it is not "old numbers."

> **ROOT CAUSE: margin-unconditioned (or leading-conditioned) win rates are quoted to the agent to justify
> TRAILING BUY decisions.** A BUY only ever happens when the control team is trailing — base rate ~35% — yet
> the prompt repeatedly cites numbers measured across all margins (heavily leading, base rate ~81%) as if they
> applied to the trailing slice. The May-17 doc's Finding 2 is explicit that everything must be conditioned on
> margin direction or you get exactly this artifact. We did not propagate that discipline into the prompt.

Every high-severity item below is a surface of that one error. Eight discrepancy classes, ranked by severity:

| Class | What | Severity |
|---|---|---|
| A | Prompt contradicts clean research (failure-profile 72%; "functionally ~80%") | **SEVERE** |
| B | Prompt contradicts itself within one BUY evaluation | **SEVERE** |
| C | Implementation drifted from its own spec (`mcOnlyFailure` carve-out is unspecced) | **SEVERE** |
| D | Newest evidence elevates MC; prompt demotes it ("ignore low MC") | HIGH |
| E | Calibration honesty — XGB headline AUC is backtest 0.798, production is 0.668 | HIGH |
| F | Graduation blowout-contamination corrected for NBA, not WNBA | MODERATE |
| G | Propagation gap — validated WNBA indicator-count finding absent | MODERATE |
| H | Orphan figures — numbers shown as fact with no traceable source | MODERATE |

---

## Class A — Prompt contradicts clean research

### A1. The failure-profile 72% (the headline)
**Prompt (lines 772, 828):** "Floor≥0.65 + MC<0.60 + XGB≥0.60 = 72% ctrl WR … XGB is the discriminator, not MC.
Do NOT suppress on MC disagreement alone." (43-checkpoint sample = n=18 / n=25.)

**Clean research (`2026-05-17` Findings 4 & 12):**
- XGB HIGH + MC LOW, **trailing** = **38.8%** (n=49).
- BUY zone XGB≥0.60 + MC<0.50, **trail 1–9** = **40.6%** (n=69).
- Finding 12 explicitly: this "informs agent language, **not** mechanical thresholds."

**Wilson 95% CIs on the prompt's own split:** 72% (n=18) → [49%, 87%]; 44% (n=25) → [27%, 63%]. The two
intervals **overlap from 49–63%** — the "XGB is the discriminator" separation may not be a real effect. And the
true trailing value (38.8–40.6%) sits at the *bottom* of that band, not 72%.

**Why 72% ≠ 40%:** the 72% population is margin-unconditioned (any margin, MC<0.60) — a blend of leading games
(~81% base) and the trailing slice that BUY actually lives in (~40%). Root cause, surface 1.

### A2. "A Q4 XGB of 0.60 is functionally ~80%"
**Prompt (line 898, WNBA BUY block):** "Windowed XGB underestimates at 0.55–0.75 — actual WR 10–20pp higher …
A Q4 XGB of 0.60 is functionally ~80%."

**Problem:** the "underestimates by 10–20pp" calibration finding is an **all-games / leading-weighted** result.
It is applied here to inflate a **trailing** Q4 read. Trailing-conditioned data says Q4 XGB 0.55–0.70 ≈ 33–43%
(`2026-05-08` 2E: 33.3%; `2026-05-17` F5 Q3+Q4 trailing buckets: ~39–43%). "Functionally ~80%" at trailing XGB
0.60 is unsupported by any trailing measurement. Root cause, surface 2.

---

## Class B — Prompt contradicts itself

Within a **single Q4 trailing BUY**, the agent simultaneously receives three mutually exclusive instructions:

| Line | Says |
|---|---|
| 772 / 828 | "XGB≥0.60 + low MC = 72% — trust XGB over MC, **do NOT suppress**." |
| 774 | "XGB≥0.60 + ctrl trailing 5+ = **82% LOSS rate** (n=17) — elevate scrutiny." |
| 822 | "Q4: MC ≫ XGB. MC wins disagreements **78%** — **trust MC over XGB**." |

772 says lean XGB and don't suppress; 822 says lean MC; 774 says this exact profile loses 82%. The most
emphatic instruction ("do NOT suppress") is the one the data supports least. These were written at different
research vintages (May 13 divergence, May 16 failure-split, May 17 hierarchy) and never reconciled.

---

## Class C — Implementation drifted from its own spec

**`AGENT_DIVERGENCE_SPEC.md` (May 13)** defines `_failureProfile` as a **single flag**:
`floor≥0.65 AND (MC<0.60 OR XGB<0.50) → failureProfile = true` → "For BUY/BWC: SUPPRESS." No carve-out. Low MC
with floor high is treated as *part of the failure*, citing 44% WR.

**Live code (lines 7879–7889)** added an unspecced third branch:
```
MC<0.60 AND XGB<0.50  → failureProfile   (suppress)
MC<0.60 AND XGB≥0.50  → mcOnlyFailure     ← NOT IN SPEC: "don't suppress, 72%, DFT thesis"
XGB<0.50 AND MC≥0.60  → failureProfile   (suppress)
```
The `mcOnlyFailure` branch **inverts the spec's intent** for the low-MC case and is the carrier of the A1 72%
text. It entered post-spec (May 16, commit 44eacfc) and was contradicted by the May-17 OOF doc one day later.

**Threshold mismatch on top:** the cited evidence is XGB **≥0.60**; the flag fires `mcOnlyFailure` at XGB
**≥0.50**. The 0.50–0.60 band gets the favorable 72% framing it was never measured to support.

**Cross-league leak:** line 842 ports the WNBA-derived "don't suppress on low MC when XGB≥0.60" onto **NBA**,
which `2026-05-17` line 291 explicitly warns against ("these are WNBA-specific findings").

---

## Class D — Newest evidence elevates MC; the prompt demotes it

**Prompt (lines 831, 842, both leagues):** "In BUY territory, low MC is expected … MC re-penalizes the deficit
on top of [floor + XGB]. Do NOT suppress BUY alerts based on low MC when XGB confirms (≥0.60)." I.e. MC is
treated as redundant margin echo.

**Two independent, recent sources say MC movement is informative for trailing teams:**
- `2026-05-17` **Finding 10** (production): trailing-team discrimination AUC — **MC Cum 0.880** > XGB 0.758 >
  Floor 0.532. (Small sample, ~5 games — directional.)
- `2026-05-28` canary profitability (576 games): the discriminator that makes the trailing BUY profitable is
  **MC Cum dipping <0.50** (53% win, +31% modeled ROI) vs MC *holding* ≥0.65 (20% win — a FADE signal). Pure
  outcome data, n=531, no odds dependency.

The two newest analyses both say MC's *behavior* carries the trailing signal. The prompt's "ignore low MC"
framing is the opposite. (Note: canary BUY = buy the beneficiary of a leader's collapse, a different setup than
DFT BUY = buy the structurally-dominant team while trailing — so this is a strong directional tension, not a
literal A=B contradiction. It should reshape, not just delete, the MC framing.)

---

## Class E — Calibration honesty (backtest vs production)

**Prompt headlines XGB as (lines 472, 817):** "OOF AUC 0.798, Q4 0.871."

**Production reality (`2026-05-17` Finding 6, re-scored, 27 games):** XGB **0.668** overall; MC Cum **0.748**
leads XGB **every quarter** (Q2 .690/.645, Q3 .745/.596, Q4 .808/.726). Finding 7: XGB's directional accuracy
(80.4%) is only 0.9pp above a zero-skill "always >0.50" baseline; MC's separation gap is ~2× XGB's.

The agent is told XGB's best-case backtest credential without the production caveat — and production says MC,
not XGB, is the stronger live signal. (Finding 8 correctly notes XGB *measures structure not wins*, so AUC
under-credits it on variance losses — but that nuance is not what the headline "0.798" conveys.)

---

## Class F — Graduation blowout-contamination asymmetry

`2026-05-06` Finding 5: the headline compound accuracy (MC≥0.80+Floor≥0.65 Q4 = 95.8%) is **blowout-inflated**;
**actionable (margin ≤10) = 86.6%, close (≤8) = 84%.**

- **NBA** prompt tiers use the deflated figure: CONFIRMED **86%** (line 857) ≈ actionable 86.6%. ✓ honest.
- **WNBA** prompt tiers (line 857, 861): CONFIRMED **90.9%**, LOCKED **94.8%** (n=153 from `2026-05-08` 2A).
  These are not stated to be actionable/blowout-filtered. Likely carry the same contamination the NBA side
  corrected for. Verify and deflate for parity.

---

## Class G — Propagation gap: validated WNBA finding absent

`2026-05-08` 2D, WNBA indicator-count when trailing: **2 indicators = 41.7% (sweet spot)**, 1 = 35.4%,
**0 = 11.1% (hard suppress)**, 3+ = 28.6% (n=7, unreliable).

- **NBA** BUY block (line 900) wires count guidance: "3+ ctrl indicators (45.6%) > ≤2 (36.6%)."
- **WNBA** BUY block (lines 892–898) wires deficit, power pairs, I3 inversion, opp kills, Q4 gates — but **NOT
  indicator count.** Risk: WNBA inherits NBA's "more indicators = better" heuristic, which is **inverted** for
  WNBA (3+ is actually unreliable; 2 is the peak). Add WNBA count guidance explicitly.

---

## Class H — Orphan figures (no traceable source in the corpus)

| Figure | Where | Issue |
|---|---|---|
| Q4 "XGB 0.55+ = **63.6%** viable" | lines 779, 897 | Not derivable from its own adjacent table (≥0.70=58.8%, 0.45–0.70=42.9%); not in any doc. Appears twice. |
| Q3 disagreement "**65% vs 60%**" | line 821 | Does not map to `2026-05-17` F3 (Q3 overall MC 58.8/XGB 58.2) or `2026-05-05` (NBA). |
| XGB "OOF AUC **0.798**" | lines 472, 817 | Final validated model is **0.807–0.809** (`2026-05-17` F11). Cited ~1pt low. |
| Header "**526-game** WNBA backtest" | line 892 | But the figures under it (I2+I3 n=67, 38.6%, 17.6%) are the **312-game** `2026-05-08` doc. Source mislabel. |

---

## Completeness check — every finding vs the prompt

`2026-05-17` doc, Findings 1–13:

| # | Finding | In prompt? | Status |
|---|---|---|---|
| 1 | AUC by quarter (XGB Q2-Q3, MC Q4) | Yes (820–822) | ✓ consistent |
| 2 | MC margin echo 95.4% | Partial | ⚠ used to justify "ignore MC" (Class D) |
| 3 | Disagreement (Q4 MC 78.3%, Q3 lead XGB 81%) | Yes (822) | ✓ but contradicts 772 (Class B) |
| 4 | Compound states (both-high 91.4%; BUY zone 40.6%) | Yes (829) for both-high; **40.6% NOT used** — 72% used instead | ✗ Class A1 |
| 5 | OOF bucket ramps | Partial (BUY calib) | ✓ mostly |
| 6 | Production MC 0.748 > XGB 0.668 | No | ✗ Class E |
| 7 | Directional accuracy misleading | Implicit | ✓ prompt doesn't over-rely |
| 8 | XGB measures structure not wins | Yes (817) | ✓ |
| 9 | Production XGB buckets | No | informs only |
| 10 | Trailing production MC 0.880 > XGB | No | ✗ Class D |
| 11 | Year drift not the gap | n/a | not a prompt assertion |
| 12 | Game-level trailing, XGB ramp 62.5% | Partial | ⚠ 62.5% n=16; language only |
| 13 | Floor breakdown DEFERRED | Consistent (floor narrative-only WNBA) | ✓ |

Other docs: `2026-05-05` (NBA hierarchy) ✓ wired; `2026-05-06` graduation ✓ wired (Class F caveat);
`2026-05-08` BUY structure ✓ wired (Class G gap on count); `2026-05-28` canary — **not shipped** (queued, see
backlog detection item); `AGENT_DIVERGENCE_SPEC` — **drifted** (Class C).

---

## Implications for the prompt rewrite (direction)

1. **The rewrite is consolidation + correction, not new research.** The correct, margin-conditioned, OOF-clean
   numbers already exist in `2026-05-17` (F2, F4, F12) and `2026-05-08`. Propagate them; delete the contradictions.
2. **Collapse three overlapping voices into one BUY-trust block** (failure-profile + trust-hierarchy +
   BUY-calibration), margin-conditioned and league-split. One source of truth per decision.
3. **Resolve the MC-vs-XGB stance.** Pick the rule the data supports: in trailing Q4, MC ≥ XGB (F3, F10), and
   MC *movement* is informative (canary). Retire "ignore low MC."
4. **Kill `mcOnlyFailure` or re-derive it.** Either remove the unspecced carve-out (revert to spec) or re-justify
   it on trailing-conditioned data — which currently puts it at ~40%, not 72%.
5. **Add production-calibration honesty** for XGB (0.668 prod vs 0.798 backtest; MC stronger live).
6. **Parity fixes:** deflate WNBA graduation tiers for blowouts (Class F); add WNBA indicator-count (Class G);
   purge orphan figures (Class H).

## Open items for fresh-data validation (Step 2)

Put fresh-game numbers (post-May-17, games neither analysis saw) on:
- the corrected BUY-trust block (trailing-conditioned WR by XGB×MC×quarter),
- the WNBA graduation tiers actionable-filtered,
- the canary MC-dip discriminator at production resolution,
- the 87% halftime Floor+MC primer (queued, n unverified) before any wiring.
