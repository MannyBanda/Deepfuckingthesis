# Agent Prompt Rewrite — Provenance-Tagged Canonical BUY-Trust Block

**Date:** May 29, 2026
**Status:** SPEC — awaiting approval before implementation. NO code changed.
**Files touched:** `netlify/functions/poll-live-bdl.mjs` ONLY (`buildV2AgentPrompt` + `formatSonnetPrompt`).
**Net change:** text-only. ~6 sections consolidated into 1; ~4 orphan figures purged; graduation deflated.
**Blast radius (verified):** `failureProfile`/`mcOnlyFailure`/`xgbMcClass`/`xgbMcGap` are referenced ONLY in
prompt text (771, 772, 810) and their computation (7869–7993). No SQL INSERT, no db-api, no dashboard, no
learning agent. **No DB migration. No schema change. No state-machine change.** The mechanical flags and gates
are untouched; only the strings they route to change.
**Source of truth:** `research/2026-05-29-prompt-research-reconciliation.md`,
`research/2026-05-29-step2-oos-validation-and-n-register.md`.

---

## Decisions locked (Manny, May 29)

1. `mcOnlyFailure` stays a **state-detector**; rewrite only the text it triggers (option 1a).
2. Collapse the overlapping/contradicting sections into **one canonical BUY-trust block**, margin-conditioned,
   league-split.
3. **Provenance tag is the primary instrument**, n-cutoff is one input to it. n-lines: **HIGH ≥200 / MED 80–200
   / LOW <80.**

---

## The provenance model (core of the rewrite)

Every quantitative claim is graded on **two axes**, not one:
- **Power** — is the estimate statistically stable (n)?
- **Transfer** — was it measured in a context that matches production? (backtest 2.5-min checkpoints vs prod
  30–60s cadence; SR-trained `pf` vs BDL `pf`=0; clean OOF vs re-scored prod; reconstructed MC vs prod engine.)

What degrades under *either* small-n or a transfer shift is the **calibrated magnitude**. What survives both is
the **ordering / structural relationship**. So both failure modes collapse to one prescription: don't assert the
magnitude as production fact; always keep the ordering.

**Four tags, with explicit agent license:**

| Tag | Meaning | Agent license |
|---|---|---|
| `[OP]` | Operating point — a mechanical threshold the system acts on | State as an exact boundary ("the gate is X"), never as a win rate |
| `[FACT:prod]` | Production-validated AND n≥200 | May present to the subscriber as their win probability |
| `[PRIOR:backtest]` | Well-powered (n≥80) but backtest / checkpoint-granularity | Reason from it; do NOT quote to the subscriber as their probability; carries the transfer caveat |
| `[STRUCTURAL]` | Low-power (n<80) OR known poor transfer | Ordering/relationship only — no magnitude, **no directive verb** |

**Decision tree per number:** mechanical threshold → `[OP]`. Else descriptive WR → prod-validated & n≥200 →
`[FACT:prod]`; backtest & n≥80 → `[PRIOR:backtest]`; n<80 or poor-transfer → `[STRUCTURAL]`.

**Consequence to state in the prompt:** the `[FACT:prod]` bucket is **currently empty** — no DFT figure is both
production-validated and well-powered. The agent must be told this so it never dresses a backtest prior as the
bettor's probability.

---

## Per-number disposition (cutoffs ≥200/80–200/<80 applied)

| Claim | n | Transfer | Tag | Treatment |
|---|---|---|---|---|
| Both-high consensus 91.4% | 2,440 | backtest cp | `[PRIOR]` | keep, tagged |
| Q4 all-3-high 95.9% (NBA) | 2,213 | backtest cp | `[PRIOR]` | keep, tagged |
| MC-underestimate Q4 (89.2/93.3%) | 300/423 | backtest cp | `[PRIOR]` | keep, tagged |
| Q4 MC≫XGB 78% | 299 | backtest cp | `[PRIOR]` | keep, tagged |
| Trust ordering (Q2-3 XGB≥MC; Q4 MC≥XGB) | — | robust | `[STRUCTURAL]` | keep as ordering |
| WNBA graduation CONFIRMED | 517/300 | backtest, reconstr. MC | `[PRIOR]` | **deflate → 85.7% all / 81% actionable / 77% close** |
| WNBA graduation LOCKED | 373/122 | backtest | `[PRIOR]` | 94.4% all / 88.5% actionable |
| NBA graduation tiers (86/73/92%) | 1,234g | backtest cp | `[PRIOR]` | keep, tagged |
| BUY suppress gates (Q4 XGB<0.45, Q3<0.35) | 117/124 | operating | `[OP]` | state as boundary, not WR |
| trail-depth ordering (1-4 > 5-9 > 10+) | ~197/63/2 | backtest cp | `[STRUCTURAL]` | keep ordering; drop 38.6/23.8/0 magnitudes |
| ctrl I3 won vs lost (WNBA inversion) | 166/17 | backtest cp | `[STRUCTURAL]` | keep the inversion *argument*; drop 39.2/17.6 |
| I2+I3 anchor vs I1+I3 trap | 67/23 | backtest cp | `[STRUCTURAL]` | keep ordering; drop 44.8/26.1 |
| opp-I2 kill vs opp-I1 | 61/87 | backtest cp | `[STRUCTURAL]` | keep ordering; drop magnitudes |
| failure-profile 72% / 44% | 18/25 | backtest cp | `[STRUCTURAL]` | **strip both numbers + "do NOT suppress" directive** |
| XGB≥0.70 deepest trailing 62.5% | 16 | backtest cp | `[STRUCTURAL]` | keep "high XGB while trailing is a positive structural read"; drop 62.5 |
| EXIT floor<0.55=100% / 0.70+=66.7% | 8/24 | backtest cp | `[STRUCTURAL]` | keep "low floor confirms EXIT, high floor does not deny it"; drop 100/66.7 |
| Divergence cells (66/57 WNBA; 92/50 NBA) | unknown/cell | backtest | `[STRUCTURAL]` until n verified | keep direction; **verify n before any magnitude** |
| "0.55+ viable 63.6%" | none | — | ORPHAN | **delete** |
| Q3 "65% vs 60%" | none | — | ORPHAN | **delete** |
| ALIGNED 83% / 90% | unknown | — | ORPHAN until verified | **delete or verify** |
| XGB "OOF AUC 0.798" | 5,260 | — | drift | **correct → 0.807**; add prod caveat (Class E) |

---

## Change set

### Change 1 — Consolidate into one canonical BUY-trust block (`buildV2AgentPrompt`)

**REMOVE** the following fragments (they become the new block or are deleted):
- 771–772 (failureProfile / mcOnlyFailure text)
- 773–774 (XGB warnings)
- 775–787 (BUY CALIBRATION, both leagues)
- 810 (divergence)
- 814–843 (SIGNAL TRUST HIERARCHY, both leagues)
- 892–905 (BUY EVIDENCE, both leagues)

**REPLACE** with one block, structure below. Mechanical flags (`failureProfile`, `mcOnlyFailure`, `xgbMcClass`)
still gate which lines render — only the strings change.

The block is league-split in code (`ctx.league === 'wnba' ? <WNBA> : <NBA>`). Both full strings below. The
tag legend, signal roles, disagreement order, and the BUY EV/suppression frame are parallel across leagues
(repeated in each branch, since each branch is its own template string); the structural specifics differ.

#### WNBA full block

```
SIGNAL EVIDENCE — each item is tagged by epistemic status. Read the tags before you weigh anything:
  [OP]    = operating point: a boundary where the SYSTEM mechanically acts. Exact line, NOT a probability.
  [PRIOR] = a backtest estimate. Well-powered, but measured on 2.5-min backtest checkpoints, and production
            runs DIFFERENTLY (e.g. XGB backtest AUC 0.81 collapses to ~0.67 in production). Reason FROM it;
            do NOT state it to the subscriber as their win probability.
  [STRUCT]= an ordering / structural relationship only. The DIRECTION is reliable; the number is not. Use it
            to read which way the game leans — never as a magnitude and never as a hard directive.
  No DFT figure is currently a production-validated probability you may present to the subscriber as fact.
  When in doubt about a number's status, treat it as [STRUCT].

SIGNAL ROLES [STRUCT]:
  MC Cum — reads margin trajectory and late-game uncertainty. Strongest single signal in Q4.
  XGB — reads STRUCTURE, not wins: windowed box-score quality, independent of the score. A HIGH XGB while a
        team is TRAILING is a positive structural read — the strongest tell available in BUY territory. It
        does not promise a win; it says the underlying play is sound.
  Floor — narrative / context only in WNBA. When floor disagrees with MC+XGB, floor is the one that is wrong.

DISAGREEMENT ORDER [STRUCT]:  Q2–Q3: XGB ≥ MC > Floor.   Q4: MC ≥ XGB > Floor.
  [PRIOR] When MC and XGB disagree in Q4, it resolves toward MC (~78%, backtest cp).
  [PRIOR] Both signals high together is the strongest state in the system (~91%, backtest cp) — reason from
          it; do not quote it as a number.

══ BUY — the control team is TRAILING. READ THIS BEFORE YOU CONSIDER SUPPRESSING. ══
  A BUY is a PLUS-MONEY STRUCTURAL play, and its value lives in the PRICE, not the binary outcome. The market
  prices a trailing team off the scoreboard. A structurally dominant team that is trailing is therefore
  MISPRICED — its true win probability is higher than its deficit-inflated moneyline implies. That gap is the
  entire edge.
  A LOW WIN RATE IS EXPECTED HERE AND IS NOT, BY ITSELF, A REASON TO SUPPRESS. A 40% win rate at +160
  (≈38% implied) is profitable. BUYs are among the most profitable signals in the entire system precisely
  because they win less than half the time at prices that overpay for the deficit. ([PRIOR, MODELED ODDS]
  confirmed-BUY cuts have run ~53–58% at plus-money in backtest — strongly +EV — but treat the ROI as modeled,
  not fact.) Suppressing a structurally valid BUY because the win rate "looks like a coin flip" is the single
  most expensive mistake you can make: it destroys the edge the whole product exists to capture.

  SUPPRESS a BUY ONLY when ONE of these is clearly true:
    1. [OP] A mechanical gate is breached: Q4 XGB < 0.45, or Q3 XGB < 0.35. Below the gate the structural case
       is genuinely gone — not merely uncertain.
    2. [STRUCT] STRUCTURAL DEATH: the team has lost its structural core — in WNBA, lost I3 (the 30% anchor) —
       AND the opponent's edge is structural, not variance (opponent controls perimeter/FT: opp I2). Both
       conditions, not one.
    3. Deep + late: trailing 10+ in Q4, where the deficit (not the structure) has become the binding constraint.
  In EVERY other case the DEFAULT is SEND with calibrated framing. Uncertainty is the NORMAL state of a good
  BUY. Do not require a coin-flip to resolve before sending. Your job is to surface a real structural
  mispricing and frame it honestly — state the deficit, the structural case, and that this is a plus-money
  thesis the subscriber enters on PRICE — NOT to predict the winner.

  STRUCTURAL CASE [STRUCT] (use for framing and for the rare suppress, never as magnitudes):
    Deficit: shallow (1–4) is the sweet spot; mid (5–9) is live; deep (10+) needs an exceptional case.
    Anchor: I2+I3 (perimeter/FT access + shot quality) is the WNBA BUY core. I1+I3 (disruption only) is a trap.
            Losing I3 is structural death in WNBA — it is the 30% anchor, NOT recoverable cold shooting. Do
            NOT import NBA's "trailing on cold shooting = buy the variance" logic; in WNBA a lost I3 means the
            offensive foundation is gone.
    Opponent: opp controlling perimeter/FT (opp I2) blocks the comeback path; opp disruption (opp I1) is
            survivable.
    A high XGB while trailing is the strongest positive structural tell in this region — weight it.

EXIT [STRUCT]: a LOW floor at EXIT confirms it; a HIGH floor does NOT deny it (floor anchors stale data).
```

#### NBA full block

```
SIGNAL EVIDENCE — each item is tagged by epistemic status. Read the tags before you weigh anything:
  [OP]    = operating point: a boundary where the SYSTEM mechanically acts. Exact line, NOT a probability.
  [PRIOR] = a backtest estimate. Well-powered, but measured on backtest checkpoints; production runs
            DIFFERENTLY. Reason FROM it; do NOT state it to the subscriber as their win probability.
  [STRUCT]= an ordering / structural relationship only. The DIRECTION is reliable; the number is not.
  No DFT figure is currently a production-validated probability you may present to the subscriber as fact.
  When in doubt about a number's status, treat it as [STRUCT].

SIGNAL ROLES [STRUCT]:
  MC Cum — best single probability signal; reads margin trajectory and late-game uncertainty.
  XGB — reads STRUCTURE, not wins: 2Q-windowed box-score quality. A high XGB while trailing is a positive
        structural read, not a promise of a win.
  Floor — cumulative indicators; anchors stale early-game data, least reliable late.

DISAGREEMENT ORDER [STRUCT]:  Q2: Floor ≈ XGB > MC.   Q3: MC ≈ XGB > Floor.   Q4: MC ≥ XGB > Floor.
  [PRIOR] Q4 all-three-high ~96% (backtest cp). MC 70–80% ≈ 75% actual, MC > 70% ≈ 92% (backtest cp).
          Reason from these; do not quote them.

══ BUY — the control team is TRAILING. READ THIS BEFORE YOU CONSIDER SUPPRESSING. ══
  A BUY is a PLUS-MONEY STRUCTURAL play, and its value lives in the PRICE, not the binary outcome. The market
  prices a trailing team off the scoreboard; a structurally dominant team that is trailing is MISPRICED — its
  true win probability exceeds its deficit-inflated moneyline. That gap is the edge.
  A LOW WIN RATE IS EXPECTED HERE AND IS NOT, BY ITSELF, A REASON TO SUPPRESS. A 40% win rate at +160 is
  profitable. BUYs are among the most profitable signals in the system precisely because they win less than
  half the time at prices that overpay for the deficit. Suppressing a structurally valid BUY because the win
  rate "looks like a coin flip" destroys the edge the product exists to capture.

  SUPPRESS a BUY ONLY when ONE of these is clearly true:
    1. [OP] A mechanical gate is breached: Q4 XGB < 0.45, or Q3 XGB < 0.45.
    2. [STRUCT] STRUCTURAL DEATH: the team has lost its structural core (NBA: lost I1+I2, physical dominance)
       AND the opponent's edge is structural (opp I1/I2: disruption or paint), not variance.
    3. Deep + late: trailing deep in Q4 where the deficit is the binding constraint.
  In EVERY other case the DEFAULT is SEND with calibrated framing. Uncertainty is the NORMAL state of a good
  BUY. Your job is to surface a structural mispricing and frame it honestly — deficit, structural case, and
  that this is a plus-money thesis entered on PRICE — NOT to predict the winner.

  STRUCTURAL CASE [STRUCT]:
    Deficit: 1–7 is the sweet spot; deeper deficits need a stronger structural case.
    Anchor: I1+I2 (physical dominance while trailing) is the NBA BUY core. I3+I4 is the WORST pair (the BWC
            killer combo). NBA I3-INVERSION is OPPOSITE WNBA: a team trailing while WINNING shot quality is
            losing for reasons shooting can't fix; a team trailing BECAUSE of cold shooting (lost I3) is
            exactly the variance the thesis exploits — that is a BUY, not a death.
    Opponent: opp I1 (disruption) or opp I2 (paint) are structural threats; opp winning I3 only = variance,
            thesis intact.
    A high XGB while trailing is the strongest positive structural tell in this region — weight it most in Q4.

EXIT [STRUCT]: a LOW MC Cum at EXIT confirms it; a high MC Cum reconsiders (MC anchors better than floor here).
```

### Change 2 — `mcOnlyFailure` text → ordering-only (1a)
The rewrite above already routes `mcOnlyFailure` to the `[STRUCT]` BUY language (no 72%, no "do NOT suppress").
**This dissolves the XGB≥0.50-vs-≥0.60 threshold mismatch** — with no magnitude anchored to a threshold, the
mismatch is moot. `failureProfile` (both-low) keeps a suppress lean but as `[STRUCT]` ("both models disagree
with floor → genuine erosion, elevate suppression"), no fabricated WR.

### Change 3 — Graduation deflation (852–861)
- WNBA CONFIRMED: `90.9%` → "85.7% overall / **81% at actionable margins ≤10, 77% in close games** `[PRIOR]`".
- WNBA LOCKED: `94.8%` → "94.4% overall / 88.5% actionable `[PRIOR]`".
- Add one line: "These are backtest, checkpoint-granularity; ~42% of 'confirmed' games are blowouts that inflate
  the headline. The actionable figure is the honest one for a live position."
- NBA tiers already use actionable-deflated 86% — tag `[PRIOR]`, leave values.

### Change 4 — Orphan purge / corrections
- Delete `63.6%` (779/897), `65% vs 60%` (821), `ALIGNED 83%/90%` (480/825) unless n produced.
- `0.798` → `0.807` (472/817) and append the Class E prod caveat to XGB's headline.

### Change 5 — `formatSonnetPrompt` parity (~5050–5092)
- Divergence lines (~5072/5074): same `[STRUCT]` + verify-n treatment as Change 1's divergence.
- Failure-profile block (~5083–5086): already lacks the 72% — align wording to the new `[STRUCT]` BUY language.
- Signal line (~5050): add the same tag legend (compact form).

---

## Cascading implications (1st / 2nd / 3rd order)

- **DB / schema:** none. Flags are prompt-only (verified). No INSERT/migration.
- **Learning agent:** none — post-hoc arc scorer, reads outcomes not prompt text.
- **State machine / gates / EXIT:** untouched — `[OP]` boundaries are unchanged; we only stop *describing* them
  as win rates.
- **Subscriber UX (2nd order):** alert bodies will (a) frame BUYs honestly as plus-money / price-driven rather
  than quoting a win probability, (b) stop quoting false-precise WRs, (c) give more honest graduation reassurance
  (81% not 91%). Net: more calibrated bodies without losing the signal.
  **Over-suppression risk (the one to watch):** removing the 72% crutch could make the agent gun-shy on BUYs —
  the worst outcome, since BUYs are plus-money and among the most profitable signals even at <50% win.
  **Mitigation is built into the block, not left to inference:** the BUY section leads with the EV frame ("value
  is in the price; low win rate is expected and NOT a suppress reason"), names an explicit SEND-DEFAULT, and
  constrains suppression to THREE concrete conditions ([OP] gate breach / structural death / deep-and-late).
  Suppress is the exception; SEND-with-framing is the rule. The `[OP]` gates still anchor the genuine hard-no
  zone mechanically. First live slate after merge: watch BUY SEND-rate — if it drops vs the prior baseline, push
  the framing harder, not softer.
- **Betting value (3rd order):** removes a documented bad incentive (taking ~40%-win BUYs because the prompt said
  72%). Expected to reduce losing BUY sends in the sparse region; graduation reassurance better calibrated.
- **Cross-prompt drift:** Change 5 keeps `buildV2AgentPrompt` and `formatSonnetPrompt` in sync; spec lists both.

## Dead code
- No flags become unused (all still route text). `xgbMcGap`/`xgbMcClass` still consumed by the divergence line.
- Removed: the orphan interpolations (63.6/65-60/ALIGNED) and the 72/44 literals — string deletions only.
- `AGENT_DIVERGENCE_SPEC.md` should be marked superseded-in-part by this spec (doc hygiene, not code).

## Test plan
1. `node -c` on the extracted script block before push (HTML method N/A — this is .mjs).
2. `?diag=1` smoke (steps 0–6) to confirm prompt builds without throwing on null signals.
3. **Before/after scenario table** — render the prompt for these ctx fixtures and diff:
   - WNBA BUY, floor 0.70, MC 0.45, XGB 0.62 (the mcOnlyFailure case) → expect: no "72%", no "do NOT suppress",
     `[STRUCT]` BUY language present.
   - WNBA POSITION_OPEN CONFIRMED, margin +6 → expect 81% actionable, not 90.9%.
   - WNBA POSITION_OPEN, margin +18 (blowout) → expect headline framing acknowledges blowout inflation.
   - Q4 trailing XGB 0.40 → expect `[OP]` suppress-gate language.
   - All-high consensus → expect `[PRIOR]` 91% with "don't quote as probability".
4. Validate against one known post-May-18 game (e.g. NY@POR f1592a78, variance loss) — confirm the rendered
   BUY-trust text reads sensibly against the actual arc.

## Open items (compute-before-merge)
- **Divergence cell n** (66/57 WNBA, 92/50 NBA): produce per-cell n; if ≥80 → `[PRIOR]` with magnitude, else keep
  `[STRUCT]` direction only. (Blocks giving those numbers magnitudes.)
- **ALIGNED 83/90 n:** verify or leave deleted.
- **WNBA Q2-early 89.6% provenance:** confirm it's WNBA-derived, not NBA-borrowed.

---

## ADDENDUM — Comprehensive prompt-surface scope (May 29, full codebase audit)

**Why this exists:** Changes 1–5 were scoped to two functions in one file. A full audit — every file that calls
Anthropic, every prompt-building function, every phrasing of the diseased numbers (not just the keyword set) —
shows the BUY-trust / trust-hierarchy / graduation / floor-narrative content is duplicated across **FIVE distinct
Opus call sites in THREE files**. Several diseased numbers are phrased differently than the original grep caught
(e.g. "82.1%", "2% comeback", "89% actual", "0% win rate", "wrong 80%"), so the orphan/`[STRUCT]` inventory is
larger than the n-register's. **Implementing only Changes 1–5 would leave 3 of 5 agents contradicting the
rewritten 2.** This addendum is the real surface. It is a scope expansion past what was approved — see Q1.

### The five Opus call sites (every prompt the BUY-trust changes concern)

| # | File · function | Opus call | Carries diseased content? | In original spec? |
|---|---|---|---|---|
| 1 | `poll-live-bdl.mjs` · `buildV2AgentPrompt` (639) | **alert reasoning agent** (live SEND/SUPPRESS) | YES — failure-profile 72/44, trust hier (814), graduation 90.9/94.8, BUY calib, divergence, 0.798, 95.9 | YES (Changes 1–4) |
| 2 | `poll-live-bdl.mjs` · `getSonnetSystemPrompt` (429) | **auto-analysis system prompt** | YES — own trust hier (469), 95%WR/19%loss (563), 0.798/0.871 (458/472), Q4 all-3 (576) | NO — found in 1st addendum |
| 3 | `poll-live-bdl.mjs` · `formatSonnetPrompt` (5007) | **auto-analysis user prompt** | YES — divergence (5078/5080), scoreboard CONFIRMED (5058) | YES (Change 5) |
| 4 | `analyze.js` · inline system prompt (≈420–512) | **client manual ⚡Analyze** (Opus 4.6) | YES — trust hier (500): "MC right 82.1%", "Q4 BUY 2% comeback / ≥0.70 viable 75%", "BUY 1–9", "compound MC≥0.85+XGB≥0.60", floor "narrative only" | **NO — entirely missing from spec** |
| 5 | `post-game-agent.mjs` · inline WNBA block (≈95–107) | **nightly learning agent** | YES — "floor wrong 80%", "Q4 BUY XGB<0.45 = 2% win", "XGB gates Q2<0.45/Q3<0.45/Q4<0.70" | **NO — entirely missing from spec** |

Also: `pregame-agent.mjs` L922 ("BUY trailing max 1–9, trail 10+ = 0% win rate") — a sixth, minor touch. NOT a
live alert path but feeds pre-game thesis; low priority, flag-only.

### Consistency requirement (why partial scope is unsafe)
Sites 1, 2, 4, 5 each independently assert a **SIGNAL TRUST HIERARCHY** and a **floor-narrative** stance. If the
rewrite tags/​corrects site 1 but not 2/4/5, then: the live agent reads the calibrated `[PRIOR]`/`[STRUCT]`
framing, while the auto-analysis (2,3), the client's manual analysis (4), and the nightly learning agent (5) keep
asserting the old false-precise numbers. The learning agent (5) is the worst case — it would *grade tonight's
arcs using the very framing we just declared wrong*, then write "learnings" that reinforce it. **The five sites
must move together or the system disagrees with itself across paths.**

### Newly-surfaced diseased numbers (beyond the n-register)
| Site | String | Disposition |
|---|---|---|
| 4 (analyze 500) | "MC right 82.1% when disagreeing with floor" | `[PRIOR]` (matches F-line; verify n) |
| 4 (analyze 509) | "Q4 BUY … 2% comeback. XGB ≥ 0.70 viable (75%)" | 75% is n=17 → `[STRUCT]`; "2%" is the <0.45 gate → `[OP]` |
| 4 (analyze 510) | "BUY trailing 1–9 max" | `[OP]` boundary |
| 4 (analyze 511) | "Compound establishment MC ≥ 0.85 + XGB ≥ 0.60" | `[OP]` — **note: 0.85 here vs 0.80 in graduation (site 1 L857). Reconcile.** |
| 5 (postgame 99) | "Floor wrong 80% of the time" | `[STRUCT]` (floor narrative-only — keep stance, drop %) |
| 5 (postgame 102) | "Q4 BUY XGB<0.45 = 2% win rate" | `[OP]` gate |
| 5 (postgame 106) | "XGB gates Q2<0.45, Q3<0.45, Q4<0.70" | `[OP]` — canonical WNBA gate set; reconcile vs site 1's 0.35 numbers |
| 6 (pregame 922) | "trail 10+ = 0% win rate" (n=2) | `[STRUCT]` — drop the 0% |

### Gate-set reconciliation (MUST resolve — appears across sites)
The WNBA BUY XGB gates are stated THREE different ways across the codebase:
- Site 1 L899: "Q2<0.35=31%, Q3<0.35=27%, Q4<0.45=20.5%"
- Site 4/5: "Q2<0.45, Q3<0.45, Q4<0.70"
- Memory/PK: "Q2<0.45, Q3<0.45, Q4<0.70"
These are not all the same gate. The canonical block needs ONE `[OP]` gate set per league, sourced from the
actual mechanical gate the code enforces (grep the real `xgbBuyGate`/threshold constant — do NOT trust the prompt
text). **Open item: confirm the enforced gate values from code before writing the `[OP]` lines.**

### Revised change set (supersedes Changes 1–5 scope)
- **Change 1–4** (site 1) — as written.
- **Change 5** (site 3) — as written.
- **Change 6 (NEW):** site 2 `getSonnetSystemPrompt` — rewrite its trust hierarchy + scoreboard + 0.798 to match.
- **Change 7 (NEW):** site 4 `analyze.js` — rewrite its trust hierarchy + BUY block; add tag legend.
- **Change 8 (NEW):** site 5 `post-game-agent.mjs` — rewrite WNBA learning block; this one is highest-leverage
  for correctness because it writes the learnings that feed back into our own understanding.
- **Change 9 (NEW, flag-only):** site 6 `pregame-agent.mjs` L922 — drop "0%"; low priority.
- **Change 10 (NEW):** reconcile the gate set and the 0.80-vs-0.85 compound threshold across all sites against
  enforced code constants.

### Cross-file cascade additions
- **analyze.js (site 4)** is a SEPARATE Netlify function (client ⚡Analyze). Editing it does not affect poll. But
  it must be deployed in the same push or the client analysis contradicts the agent.
- **post-game-agent.mjs (site 5)** runs nightly 11:45pm MST. If rewritten mid-slate, tonight's learnings use new
  framing — desirable, but note the discontinuity in the learnings table (pre/post-rewrite rows differ in basis).
- **Biglead-SHAP magnitudes (Q2)** still out of scope per recommendation (ii) — they live at sites 1, 2, 3 and a
  trajectory helper; leaving them verbatim is consistent ONLY if we don't tag the surrounding block in a way that
  implies they're tagged too. Flag inline: "scoreboard conviction numbers pending separate audit."

### Questions (unchanged + sharpened)
**Q1 — Scope:** approve the expanded 5-site (Changes 1–10) pass? Recommended — partial scope makes the learning
agent grade arcs by the framing we just rejected.
**Q2 — Biglead-SHAP magnitudes:** leave verbatim + queue separate audit (recommended ii), or tag now (i)?
**Q3 (NEW) — Enforced gate values:** OK for me to grep the real mechanical gate constants from code to source the
`[OP]` lines, rather than copying any prompt's stated gates? (This is read-only; no behavior change.)

### RESOLVED — enforced gate ground truth (from code, line 8020–8045)
Grepped the real mechanical constants. **The prompts' stated gates are WRONG vs the engine** — this is bigger
than orphan numbers; prompts describe mechanics the code does not enforce.

**Real enforced BUY gate (`buyXgbFloor`, L8028) — the ONLY correct `[OP]` numbers:**
| League | Q2 | Q3 | Q4 |
|---|---|---|---|
| WNBA | 0.45 | 0.45 | **0.55** (comment: lowered from 0.70 — two suppressed BUYs won) |
| NBA | 0.40 | 0.45 | 0.60 |
- BWC gate: flat XGB < 0.40. POSITION_SAFE gate: XGB < 0.50.
- **Prompt vs reality:** prompts variously claim WNBA Q4 "<0.45" (site 1 L899) or "<0.70" (site 4/5) — both wrong;
  enforced is **0.55**. Every `[OP]` gate line must be sourced from this table, NOT prompt text.

**Compound establishment = 0.80 everywhere in code** (L2986/2990, L852/853). The **"MC ≥ 0.85" in analyze.js
(site 4 L511) is a straight BUG** — contradicts the enforced 0.80, not an alternate valid threshold. Change 7
must correct 0.85 → 0.80.

### NEW FINDING — gates are env-flagged (BLOCKS `[OP]` framing)
The entire BUY/BWC XGB gate block is wrapped in `XGB_GATES_ENABLED === 'true'` (L8020). **If that env var is not
set in production, NONE of these gates fire** — the agent's reasoning is the only suppressor. This changes how
`[OP]` lines should be written:
- If gates ON: state them as hard system boundaries ("the system auto-suppresses below X").
- If gates OFF: they are NOT operating points — they're advisory thresholds the agent itself must apply, which
  changes the `[OP]` lines into `[STRUCT]`-with-recommended-action.
**Q4 (NEW, BLOCKING): is `XGB_GATES_ENABLED` set to 'true' in prod Netlify env?** Cannot be grepped — Manny must
confirm. The `[OP]` vs advisory framing depends entirely on this.

### NEW FINDING — late-game gate may already be MC, not XGB
The invalidation gate at L8980 is `_xgbGateByQ = { 2: 0.40 }` with comment "Q3/Q4 now use MC Cum" and an
`_invUseMC` path gating at MC Cum 0.30. So for INVALIDATION (not initial BUY), Q3/Q4 is MC-based. The BUY-entry
gate (8028) is still XGB-tiered, but EXIT/invalidation has migrated to MC. Any prompt line describing a "Q4 XGB
EXIT gate" is describing deprecated mechanics. **Scope note:** the EXIT `[STRUCT]` line in Change 1 should say MC
Cum is the late-game invalidation signal, not XGB — align to L8980 reality.

### Spec status
With this addendum the spec covers: 5 live Opus sites + 1 minor (pregame), the enforced-gate ground truth, the
0.85 bug, the env-flag dependency, and the EXIT-gate migration. **Remaining blockers before implementation: Q1
(scope), Q2 (biglead), Q4 (env flag). Q3 is self-resolved (yes, source from code — done above).**

### RESOLUTIONS (Manny, May 29) — ALL BLOCKERS CLEARED
- **Q1 → APPROVED.** Full 5-site pass (Changes 1–10). Move all sites together.
- **Q2 → LEAVE VERBATIM.** Biglead-SHAP "95% WR / 19% loss / 86.9% n=84" untouched; queue separate audit. Do NOT
  tag the surrounding block in a way that implies these are tagged. Add inline flag: "scoreboard conviction
  numbers pending separate audit."
- **Q4 → GATES ON.** `XGB_GATES_ENABLED='true'` in prod. `[OP]` lines stand as hard system boundaries ("the
  system auto-suppresses below X"), sourced from the enforced-gate table (WNBA Q4 0.55 / Q1–3 0.45; NBA Q4 0.60 /
  Q3 0.45 / Q2 0.40). Late-game INVALIDATION uses MC Cum (L8980) — EXIT `[STRUCT]` line reflects MC, not XGB.
- **Q3 → self-resolved.** Gate values sourced from code, not prompt text.

**Status: CLEARED FOR IMPLEMENTATION.**
