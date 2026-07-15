# SWEETSPOT_NARRATION_V2 — context parity + Fable + price ladder

**Date:** 2026-07-13 · **Status:** PROPOSED — awaiting PM decisions D-1..D-8 + build go-ahead

## 1. Motivation (PHX@MIN, Jul 13)

The A-tier narration for PHX@MIN (row 304) was accurate and rule-compliant but not
compelling — because it structurally cannot be. The Stage-2 prompt hands the model six
numbers (gap, eFG, band, variance share, model prob, edge) plus carrier context and asks
for three sentences restating them. Opus 4.8 executed the restatement well; there is
nothing else it could have said. Meanwhile the alert reasoning agent and auto-analysis
receive the full data stack. The narration agent is the poorest-fed agent in the system
and it writes the only prose Manny reads at bet time.

**The latency budget (PM insight, empirically confirmed tonight):** SS alerts —
especially higher tiers — fire when the bet is NOT yet actionable. PHX@MIN fired Q1 0:45
at -310 (edge +0.4pp, no value); the actionable price (+135) arrived a quarter-plus
later. Fire-time and bet-time are different moments, so narration speed is nearly
worthless and narration quality is the whole game. This licenses: (a) a much richer
prompt, (b) Fable 5 at high effort, (c) deferred delivery (§5).

## 2. Context parity — what the rich agents get that narration doesn't

Blocks to add to the narration prompt, reusing the existing formatter functions
(implementation must lift `formatSonnetPrompt`-family builders, not rebuild):

| Block | Source in scope at fire site | Why it earns its place in a bettor push |
|---|---|---|
| Per-quarter scoring flow | `quarter_data` boundaries | "How the lead was built" — Q1 three-barrage vs steady grind is the fade's texture |
| Shot-type variance decomposition | server scoring comp (already computes varShare) | 3PT vs mid vs rim split behind the variance share number |
| Sustainability tiers (both teams) | `sust_json` on snapshot | Leader FRAGILE/UNSUSTAINABLE is the fade thesis in one word; trailer LOCKED IN is the closer case |
| I1-I5 + control read | `computeServer()` output | Which structural levers the trailer actually owns (ctrl-relative) |
| TP (trailer path) / LS (leader safety) | poll-cycle locals | TP BLOCK is a 95% veto — narration must never talk past it |
| XGB + top SHAP drivers | snapshot xgb fields + shap | The structural model's read + its top 3 named drivers |
| MC Cum + trust hierarchy line | `lt.mc` / snapshot | Quarter-appropriate weight (Q4: MC > XGB > floor) |
| Season records + carrier ctx | already present | keep |
| Price ladder | NEW — §3 | fire-time price vs actionable price |
| Team profiles | TEAM_PROFILES_SPEC.md (companion, builds first) | archetype, tier splits, form, H2H — the "erased a halftime deficit vs PHX in June" sentence |

**Exclusions (state explicitly in prompt-builder comments):** floor score is NOT passed
— WNBA floor is narrative-only and wrong 80% vs MC+XGB when they disagree; in a
bettor-facing push it adds contradiction risk and zero value. eFG-heat language stays
descriptive (the fade gates are the leader's band/vshare — locked signal is quality gap
+ deficit + line; do not let the prompt imply eFG-heat is independently predictive).

## 3. Price ladder (mechanical, server-computed — the model NEVER does this math)

At fire, compute from `collapse_true` (model p) and the captured line:

- `edgeNow` = p − implied(lineUsed)
- `probeLine` = the ML where edge = PROBE_EDGE (+10pp): solve implied = p − 0.10
- `fullLine` = the ML where edge = FULL_EDGE (+20pp): solve implied = p − 0.20
- Row 304 fixture (p=.76): probe at -196 or longer, full size at -127 or longer

Passed to the prompt as pre-formatted plain-English lines, e.g. for row 304 (p=.76):
"At the captured price (-310) the edge is +0.4 points — below the bet bar. Probe
territory at {probeLine} or longer; full tier size at {fullLine} or longer." Threshold
mapping at p=.76: +3pp→-270 · +8pp→-213 · +15pp→-156 · +20pp→-127 · +30pp→+117.
(Original spec text showed -175/+115 for +3/+8 — wrong math, corrected Jul 13.)
Thresholds are D-3 — PM sets PROBE_EDGE and FULL_EDGE; ladder renders in sizing
language (probe = small skin-in stake; full = up to the tier cap, A=$1,400). The narration's job is to weave the ladder into
the price-guidance sentence, not to compute it. This converts the alert from a snapshot
into a price target, matching how the position is actually traded (tonight: declined
-310, entered +135/+120/+105).

## 4. Model — Fable 5 at high effort (D-1)

First Fable call site in DFT. **Smoke test PASSED (Jul 14, test-fable.mjs — kept as a
permanent harness).** Operative facts for the request builder:
- Model `claude-fable-5`, effort via `output_config: {effort: 'high'}` — Opus 4.8
  accepts the IDENTICAL shape, so fallback = swap the model string, nothing else.
- Fable prepends a thinking block (empty by default) before text: extraction MUST
  filter `content` for `type === 'text'` — never index `content[0]`.
- Measured latency on a narration-shaped prompt: 10.7s Fable high / 8.4s Opus (the
  §5 45s timeout has ~4x headroom; same-cycle is the common case by a wide margin).
- max_tokens 2500 (thinking tokens bill as output; observed 93 thinking + ~350 text).
- Cost ~$0.03/narration at A+B volume — negligible.

**Fallback triggers (retry once on `claude-opus-4-8`, same prompt):** 4xx/5xx, timeout,
AND `stop_reason === 'refusal'` — refusals return HTTP 200 (smoke-test finding; betting
content didn't trip classifiers and shouldn't, but a refusal must never pass silently as
an empty narration). Narration must degrade, never die silently.

## 5. Timing architecture — deferred narration (D-4, recommendation: next-cycle pickup)

Fable at high effort may take 30-90s. The current Stage-2 call is awaited inside the
poll cycle (Netlify: 120s configured, ~60s effective; unawaited promises die at handler
return — hotfix learning #3). Inline await risks the poll budget on multi-game slates.

**Option A — same-cycle tail sweep (RECOMMENDED; amended Jul 13 after PM latency
challenge — original "top of cycle" placement would have starved polling behind a slow
model call):** Stage-1 mechanical push fires exactly as today. Row inserts with
`narration_text` NULL + `narration_attempts` 0 (new column via init). At the END of the
same poll cycle — after all snapshot/alert/state work has committed — a narration sweep
claims at most ONE pending A/B row (attempts < 3, oldest first), builds the rich prompt,
and calls Fable under a hard timeout (AbortController, min(remaining budget − 5s, 45s)).
Common case: narration starts ~5-20s post-fire in the same invocation. Timeout/failure →
attempts++, next cycle retries at ITS tail; attempt 3 switches to `claude-opus-4-8`
(fast) so narration always lands by ~T+3min worst case. DB lock row (PENDING sentinel)
before the slow call guards concurrent cron invocations per house rule. The heartbeat is
never blocked; nothing dies unawaited at handler return.

**Option B — background function:** 15-min budget, but internal Netlify-to-Netlify
calls historically 401 (the `_headers` scoping to `/*.html` may have fixed this —
UNVERIFIED). More moving parts for latency nobody needs. Rejected unless A hits a wall.

## 6. Output contract (D-5)

Four parts, ≤170 words total (ntfy body; lock screens truncate but the dashboard/push
detail shows all), plain English, every metric named in full on first use. **Word budget
(PM Jul 14, supersedes <=170):** prompt gives Fable a RANGE — "aim for 150-190 words so
relevant info fits; 200 is a hard cap." Fixture asserts <=200 on dry-runs. Overshooting
the old 170 line is fine; clipping relevant context to hit it is not:

1. Why the lead is fragile at the TEAM level — now with texture (how it was built,
   quarter flow, shot-type split, leader sust tier).
2. Why the trailer closes — structural levers they own (I-reads, TP, sust, XGB drivers),
   naming live comeback engines when carrier ctx present.
3. **Price guidance** — the ladder verbatim-adjacent: current edge, actionable price,
   strong price. If edge is already above bar, say so plainly.
4. The single biggest risk — STAR carrier rule unchanged (sustaining at her norm, never
   predicting collapse); foul trouble if present; TP CONTESTED/BLOCK must surface here.

Carried rules: never re-decide (A/B is mechanical), never contradict FRAMING RULES,
never predict a specific player's shooting collapse, team names throughout.

## 7. TEAM_PROFILES integration (D-6 — resolved per PM: spec now, build together)

**SHIPPED upstream (Jul 14, commit 6428c2d).** The narration prompt's TEAM CONTEXT
section is one call: `composeTeamContext(hA, aA, league)` — already loaded per cycle via
`ensureTeamCtx`, already injected into the agent + auto-analysis prompts, degradation
internal (returns `''` on missing/stale/wrong-league/unloaded; >36h staleness note
self-appends; 30/30 fixtures in research/team_ctx_fixtures.mjs). Narration gets context
parity with the rich agents for free. The smoke test confirmed the payoff: Fable folded
the L5 [OPPONENTS_HOT] tag from this block into the invalidation paragraph unprompted.

## 8. Testing

- **Prompt-assembly fixtures** (`research/ss_narration_fixtures.mjs`, pinned-copy
  pattern): section presence/order, price-ladder math (row 304 as the regression case:
  p=.76, line -310 → edge +0.4pp, actionable ≈ -175, strong ≈ +115), jargon banlist on
  all mechanical lines, exclusion assertions (no floor score in prompt).
- **Fable smoke test** before wiring (API shape + fallback path + latency measurement).
- **Dry-run mode:** `?ss_narrate_test=<rowId>` re-narrates a historical row without
  pushing (log-only) — validates the full pipeline on row 304 before any live fire.

## 9. Decisions for PM

- **D-1** APPROVED (PM Jul 13): Fable 5 high effort + Opus 4.8 fallback
- **D-2** APPROVED (PM Jul 13) with amendment: TEAM CONTEXT sourced live via companion TEAM_PROFILES spec (not deferred)
- **D-3** APPROVED (PM Jul 13): PROBE_EDGE = +10pp, FULL_EDGE = +20pp — ladder renders as probe price / full-tier-size price (A cap $1,400)
- **D-4** APPROVED (PM Jul 13): same-cycle tail sweep + hard timeout + next-cycle retry
- **D-5** APPROVED (PM Jul 13): ≤170 words, 4 parts with price guidance
- **D-6** RESOLVED (PM Jul 13): TEAM_PROFILES specced as companion, builds first
- **D-7** APPROVED (PM Jul 13): A+B both; WATCHLIST/ledger still never narrate
- **D-8** APPROVED (PM Jul 13): `narration_attempts` via init

## 10. Rollout

Build off-slate behind `WNBA_SS_NARRATE_V2=1`. Dry-run on row 304 → compare v1 vs v2
narration side by side with PM → enable live → first-fire observation night → spec to
`specs/shipped`.

## D-9 (OPEN — PM directive Jul 14): no-position game briefs

PM: "for spots like this [WSH@TOR] tell me there is no position but still give me the
context we're building — H2H, team profiles." Note this CANNOT attach to existing fires:
WSH@TOR fires nothing (gap .089 — no A/B/WATCHLIST), and D-7 keeps WATCHLIST silent. It
is a new trigger surface with its own, simpler output contract:

**Brief contract (3 parts, ~90-word target / 110 ceiling, plain English):** (1) explicit
lead: "No position — nothing here qualifies" + the one-line reason (gap too thin / wrong
shape); (2) the season lens: both identities via profile reads, H2H, form heat; (3) what
would change it: "the system speaks up if <trailer-shape> falls behind by 1-9 with the
gap holding." Never price guidance, never a lean — context without action implication.

**APPROVED (PM Jul 14): (a) AND (b) both ship.**
- (b) Auto-brief at first live poll of each WNBA game, flag `WNBA_GAME_BRIEF_ON=1` —
  the reference-able history stream. Persisted as `sweetspot_alerts` rows with
  `alert_subtype='GAME_BRIEF'` (existing per-game dedup PK = auto once-per-game;
  fade-specific columns null like ledger rows; text in `narration_text`) — readable via
  `get_sweetspot_alerts`, dashboard-renderable later.
- (a) On-demand: `?ss_brief=<gameId>` on the poll function (diag-style early-exit param,
  no full poll cycle). Regenerates with current score/period line when live, REPLACES the
  stored `narration_text`, re-pushes. Works whether or not the auto-brief already fired.
- (c) rejected unless (b) proves noisy.
Brief word budget: ~90-word target, 120 hard cap (briefs stay shorter than fire narrations).

---

## D-12 AMENDMENT — WATCHLIST REVIEW NARRATION (PM go Jul 15, 2026)

**Decision:** WATCHLIST rows narrate via the tail sweep — but through a dedicated REVIEW
contract, never the fade prompt. Rationale: WATCHLIST spots are where Manny's discretionary
selection edge operates; they need the richest context. The naive fix (widening the sweep
scope) would have mislabeled reviews as B-tier fires and forced sizing language onto
NO EDGE rows with `edge/collapse_true NULL`.

**Contract (`ssBuildWatchlistPrompt`, pure, fixture-extracted):** 4 parts, 150-190 target /
200 cap. (1) mandated lead "Review only — no system bet call." + what cleared (gap,
deficit); (2) live texture + lead composition; (3) what's missing for a fire — model cites
the row's mechanical reads against the ssClassifyTier ladder stated verbatim in the prompt
(positive edge + collapse STRONG/SHORT + fade STRONG/LEAN FADE + class VOLATILE/MIXED,
pre-Q4, deficit ≤9), never invents thresholds — then the live price stated as PLAIN FACT
(PM call: line included; zero edge/value claim, zero sizing, no ladder block); (4) biggest
discretionary risk (STAR carrier rule carried).

**Plumbing:** flag `WNBA_SS_NARRATE_WATCHLIST` (ship dark; sub-flag of V2, inert without it).
Sweep claims WATCHLIST only when no A/B row is pending (A/B narration latency unchanged),
with a 2h `created_at` recency window (flag turn-on must not drain the season's 9 stale
rows one push per cycle) and `game_id <> 'SS_FORCE_TEST'` (mode-5 forced tests must not
auto-push). Push priority 2, matching the mechanical review cue. Title uses "vs" — leader/
trailer anchors are not home/away (verdict-strip row-anchoring lesson). `?ss_narrate_test`
dry-run routes by subtype. Fixtures: +18 cases (50/50), golden shape = live row 401
(Jul 15 MIN/LA: gap +.30, VOLATILE 61%, fade NO EDGE, edge NULL, -222/69%).

**Rollout:** dry-run row 401 → review output → set `WNBA_SS_NARRATE_WATCHLIST=1` in Netlify.
