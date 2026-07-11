# Phase 2 — WNBA Possession-State Machine: Implementation Spec
**Date:** Jun 10, 2026 · **Status:** DRAFT — awaiting Manny confirmation before build
**Predecessor:** WNBA_DATA_LAYER_V3_SPEC.md (Phase 2 architecture) · research/2026-06-10_phase4a_adjudication.md

## 1. Objective
Replace the rejected PBP-regex SCP derivation (mean **-2.47**, median 2, p90 6, 30% exact vs official) with a possession-state machine over raw BDL plays. ESPN carries no SCP; this is the only live-fidelity path. Acceptance bar (Manny, Jun 10): **median |err| ≤ 2 pts, p90 ≤ 4, per stat per team** vs `wnba_official_stats` (n=86 game-sides ×2).

Secondary outputs: POT (cross-validation vs ESPN-flipped source, now corrected), true possession counts (challenger to the FGA-OREB+TOV+0.4·FTA estimator, median err 1.6), and an origin-tagged scoring log (substrate for backlog #4 possession-level MC).

## 2. Verified input taxonomy (live recon, Jun 10 — game 24838)
Raw BDL WNBA play fields (377-play game, all plays): `game_id, order, type, text, home_score, away_score, period, clock, scoring_play (bool), score_value (int), team (object, ~98%)`.

Observed `type` values: `Offensive Rebound`, `Defensive Rebound`, shot types (`Jump Shot`, `Pullup Jump Shot`, `Driving Layup Shot`, ...), `Personal Foul`, `Shooting Foul`, `Free Throw - N of M`, `Lost Ball Turnover`, **`Bad Pass\nTurnover` (embedded newline)**, `Substitution`, `Full Timeout`.

Design affordances:
- **Type-driven classification** — rebounds and turnovers are typed events; no text regex on the primary path. Turnover match: `/turnover/i` on `type` (newline-safe).
- **`scoring_play` + `score_value`** — text-independent point crediting (incl. FTs).
- **`order`** — authoritative sequencing.
- **Running score on every play** — reconciliation invariant (§6, layer 1).
- **`team.id`** — the machine is **alias-agnostic**: home/away determined by matching `team.id` against the game's BDL home/away team ids passed by the caller. Zero alias-map dependency (May 16 aliasMap regression lesson).
- Quirks: ~2% team-less plays (period markers/timeouts → no-ops); single fetch returns the full game.

**Discovery:** `game_pbp.pbp_json` stores *parsed* output (shots/turnovers only) — **not** raw plays. Replay must fetch raw plays from BDL directly (sandbox allowlisted). See open decision D2.

## 3. Module architecture
- **Location:** `netlify/functions/lib/possession-machine.mjs` — esbuild `lib/` relative-import **verified on deploy Jun 10**.
- **Pure & stateless:** `computePossessionStats(plays, opts) → result`. Full recompute per poll (~400 plays, trivial cost); no incremental state, fully deterministic, replay = live by construction (item #7 alignment).
- **Zero imports from poll-live-bdl** (no LEAGUES, no sql, no fetch). Caller supplies everything via `opts`.

```
opts = { homeTeamId, awayTeamId, scpPreservesPot = true }
result = {
  home: { pts, pot, scp, poss, techFT }, away: { ... },
  scoringLog: [{ order, period, clock, side, value, tags: {pot, scp, tech} }],
  diagnostics: { unknownTypes: {type: count}, teamlessPlays, reconcile: { homeDelta, awayDelta } }
}
```

## 4. State machine
**State:** `possSide ('home'|'away'|null)`, origin tags `{ offTO, secondChance }`, `pendingAnd1`, `ftContext { side, origin snapshot, isTech, remaining }`, per-side accumulators.

**Possession start** (poss count increments for the gaining side): period start (first attributable event), opponent made FG (final FT of a made sequence), defensive rebound, turnover gain. **OREB extends — never starts — a possession.**

**Origin tagging on gain:** via opponent turnover → `offTO = true`. On OREB → `secondChance = true`; `offTO` preserved iff `scpPreservesPot` (default true — a TO→miss→OREB→score credits both POT and SCP; §6 layer 2 empirically validates the convention both ways).

**Point crediting:** any `scoring_play` with `score_value > 0` by the possessing side → `pts += v`; `offTO → pot += v`; `secondChance → scp += v`. FT points inherit the **possession-origin snapshot taken at the foul**, so and-1s and OREB-foul sequences tag correctly.

**Possession end (tags clear):** made FG with no pending FTs · made final FT · defensive rebound · turnover · **period end** (SCP/POT never span periods; poss closes).

## 5. Edge-case rules
| Case | Rule |
|---|---|
| And-1 | Made FG + shooting foul: FG credits immediately; possession held open for the FT under the same origin snapshot; ends after FT resolution |
| FT sequence, last FT missed | Live rebound decides: OREB → same possession, `secondChance` set; DREB → possession over |
| Putback chains (multi-OREB) | `secondChance` persists; each OREB re-extends; all subsequent points are SCP |
| Technical FT | Detected via preceding `Technical Foul` event: points credited (`techFT += v`), **never** tagged pot/scp, possession state untouched |
| Flagrant | FTs + ball retained: credit FTs under current tags; possession does **not** flip after FTs |
| Offensive foul / charge | Turnover-equivalent: possession flips, opponent gains with `offTO = true` only if type/text matches `/turnover/i` (BDL emits `Offensive Foul Turnover` variants; plain `Offensive Foul` without turnover marker → conservative no-tag flip) |
| Team rebound (team, no player) | Same as player rebound — side from `team.id` |
| Jump balls / held balls | Possession inferred from next attributable event |
| Substitution, timeout, replay review, period markers | No-ops |
| Unknown `type` | No-op + `diagnostics.unknownTypes` counter — never guess |

## 6. Acceptance harness — three validation layers
Sandbox script `research/replay_possession_machine.mjs` (imports the lib module directly — no endpoint, no Netlify timeout):
1. **Score reconciliation (per game, hard gate):** Σ credited pts per side must equal the final `home_score`/`away_score` from the play stream. Any nonzero delta = classification bug. Target: 86/86 exact.
2. **Official comparison (the bar):** SCP and POT vs `wnba_official_stats` (db-api `get_wnba_official`): **median ≤2 / p90 ≤4 per stat per side**. Must beat regex baseline (median 2, p90 6, mean -2.47) and show no systematic sign bias. Run with `scpPreservesPot` both ways; adopt the convention matching official. POT doubles as machine-vs-ESPN-flip cross-check.
3. **Possession challenger:** machine poss vs official; adopted into `poss_v2` only if median err clearly beats the estimator's 1.6 (else estimator stays — it's approved).

Game id mapping: `wnba_official_stats` rows carry BDL game ids (4a backfill source). Sequential BDL fetches with ~250ms spacing.

## 7. Unit tests (testing ownership — built WITH the module, not after)
`netlify/functions/lib/possession-machine.test.mjs`, `node --test`, synthetic fixtures per §5 row: basic exchange · TO→score (POT) · TO→miss→OREB→score (dual tag, both conventions) · and-1 · FT pair with miss+OREB · technical FT exclusion · flagrant retention · period-boundary clear · team rebound · multi-OREB chain · unknown-type no-op · teamless plays · reconciliation property on every fixture. Plus one real-game fixture (24840 CON@TOR, committed as JSON) pinned to expected outputs — the regression canary `parseBDLPBPServer` never had.
Post-deploy check: confirm no `/lib` endpoints appear (Netlify discovers top-level files only; verified pattern with _spike).

## 8. Live integration (separate commit, after acceptance passes)
WNBA branch only: call the machine alongside `parseBDLPBPServer` on the same sorted plays; `computeWNBAModelV2` takes `scp` from machine output (replacing `pbpResult._bdl.scpHome/Away` as scp_v2 source); `v2_src` annotates. **v1 untouched** — regex `_bdl` values still feed v1 paths (structRate/TP/LS consume v1 scp) until Phase 6. Failure isolation: machine throw → scp_v2 falls back to regex value + log; never blocks the poll.

## 9. Cascading implications (traced)
- scp_v2 consumers today: none live (Phase 6 training table future) — integration risk minimal.
- v1 scp consumers (TP/LS swing core via structRate, display): **unchanged** until Phase 6.
- `_bdl.potHome/scpHome` regex outputs: stay for v1; machine does NOT delete them (dead-code cleanup deferred to Phase 6 when v1 lane retires).
- Boundary snapshots: machine output flows into boundary rows like any poll — the boundary-pot provenance question (backfill quarantine finding) gets investigated during this build since the same plumbing is open.
- Phase 4b nightly harness reuses §6 layer-2 comparisons verbatim.

## 10. Open decisions (Manny)
- **D1 — tolerance:** median ≤2 / p90 ≤4 confirmed Jun 10. Re-confirm only if replay reveals a sharper achievable bar.
- **D2 — persist raw plays:** extend `game_pbp` with `raw_plays_json` going forward (~150KB/game) so future replays/debug don't depend on BDL retention. **Recommend YES** (cheap, kills a single point of failure).
- **D3 — poss source swap:** adopt machine poss into poss_v2 only on clear win vs estimator (§6 layer 3). Recommend conservative default (keep estimator unless beaten).

## 11. Build sequence
1. Module + unit tests (lib/, fixtures) — syntax-gate, `node --test` green
2. Replay harness + full 86-game acceptance run — results to `research/2026-06-XX_phase2_acceptance.md`
3. Convention/threshold findings → Manny review (D1–D3 resolved)
4. Live integration commit (§8) + one live-slate validation (scp_v2 sanity vs ESPN-era fields)
5. game_pbp raw-plays persistence if D2 approved
