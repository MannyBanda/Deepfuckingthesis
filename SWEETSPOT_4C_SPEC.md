# SWEETSPOT §4c SPEC — Player-Context Layer for the Sweet Spot Analyst

**Date:** 2026-07-02 · **Status:** FINAL, awaiting build go-ahead · **Code baseline:** `8b262a1`
**Research inputs (all validated & committed):**
- `research/2026-06-28_player_data_assessment.md` (data topology, D1–D4)
- `research/2026-07-02_direction2_heater_fade_killed.md` (heater-fade dead; reversion mechanism confirmed)
- `research/2026-07-02_role_carry_and_efg_amplifier_addendum.md` (star-carry=hold, role-carry=fragile candidate, eFG=gap amplifier)

---

## 1. Purpose & scope

Give the Sweet Spot Stage-2 analyst (the async Opus narration in `fireSweetSpotAlert`) per-player
context it currently cannot see, with **data-backed framing baked into the prompt**, and persist
that context on the alert row so the calibration tracker accumulates forward OOS samples for the
two candidate signals (role-carry fragility, eFG-as-gap-amplifier) automatically.

**In scope:** digest functions (inline, poll file), `fireSweetSpotAlert` signature widening
(optional param), lazy carrier-baseline fetch, Stage-2 prompt rewrite, 5 new `sweetspot_alerts`
columns, force-test v2 + diag step.

**Out of scope (explicit):** any new alert type or subtype; role-carry as a *trigger* (candidate
only, n=12–25, pending 2021–23 OOS); any gate/threshold change; Stage-1b mechanical body changes
(validated format, 0-Opus — untouched); snapshot-level digest storage; NBA (all changes live
inside WNBA-gated code + a function only WNBA invokes); `wnba_player_baselines` table (follow-on,
§9).

---

## 2. Current state (verified at `8b262a1`)

- `fireSweetSpotAlert(sql, game, league, hA, aA, ss)` @ ~650. Stage 1a atomic insert
  (`ON CONFLICT (game_id, alert_subtype) DO NOTHING`), Stage 1b mechanical ntfy, Stage 2 async
  Opus narration (`claude-opus-4-8`, max_tokens 400) that sees **only `ss` gate fields**.
- Live call site @ ~8104, gated `_ssTier === 'A' && WNBA_SS_ALERT_ON` (env flag, ships dark).
  In scope at the call: `modelSummary` (BDL-shaped via `bpa()`, **both** WNBA sub-paths),
  `game._bdlPbp` (from `parseBDLPBPServer`), `ssStandings`, `odds`.
- Force-test @ ~6384 (`?ss_force_test=1`) passes synthetic `ss` + `{id:'SS_FORCE_TEST'}` game —
  **no modelSummary/pbp**. Contract preserved via optional param (§4.2).
- `sweetspot_alerts` touchpoints: db-api schema+indexes, poll insert, force-test. No other readers.
- Data shapes (verified live):
  - `modelSummary.{home,away}.players[]` = `bpa()` rows: `{ id, full_name, position, played,
    starter, statistics: { minutes /*string*/, field_goals_made/att, three_points_made/att,
    free_throws_made/att, oreb/dreb/rebounds, assists, steals, blocks, turnovers, personal_fouls,
    points, pls_min } }`. Null→0 coercion already applied inside `bpa()` (`p.pf || 0`).
  - `game._bdlPbp.raw.shots[]` = `{ p /*player*/, tm, z /*zone*/, m /*made*/, a, q /*quarter*/,
    ctx, is3, x, y }` — per-player shot geography, quarter-filterable, already computed every poll.
- Data laws in force: BDL null=zero; stats are strings (`Number()` everywhere); `minutes` may be
  `'26'` or `'26:30'` — parse both.

## 3. Design summary

Digest is computed **lazily inside Stage 2** — never on the hot gate path (alerts fire a few
times/week; polls run every minute). One new optional parameter carries the live references in.
Everything inline in `poll-live-bdl.mjs` per the Netlify bundling law (no cross-function
`require`). ~5 functions, ~200 lines, all additive.

```
gate fires (unchanged) ──► fireSweetSpotAlert(sql, game, league, hA, aA, ss, pctx)
                                                                          └─ NEW, optional, default null
   Stage 1a insert  (gains 5 columns, all nullable)          ── unchanged semantics
   Stage 1b ntfy    (byte-identical)                          ── unchanged
   Stage 2 async:
     try { digest = ssPlayerDigest(pctx) + ssShotGeo(pctx) + lazy baselines } catch → digest=null
     prompt = current core + ssComposeCtxBlock(digest)   // null digest → prompt ≈ today's
     UPDATE row SET narration + carrier_* + player_ctx_json
```

## 4. Changes, file by file

### 4.1 `netlify/functions/poll-live-bdl.mjs` — five new inline functions (near fireSweetSpotAlert)

**F1. `ssPlayerDigest(modelSummary, leaderIsHome)`** (~55 lines)
Reduces `players[]` for both sides. Per team: total pts; top-2 scorers `{name, id, pts, share,
fga, fta, fg3a, ts /*live TS*/, pf, min, starter}`; foul-trouble list (starters with
`personal_fouls ≥ 3`); bench pts share (non-starters); minutes-load note (any starter
`min ≥ 0.9 × elapsed`). All math `Number(x)||0`; minutes parser handles `'26'`/`'26:30'`.
Returns `{leader:{...}, trailer:{...}}` keyed by side. Pure function of its input — unit-testable
via diag.

**F2. `ssShotGeo(pbp, teamAlias, playerName)`** (~25 lines)
Reduce over `pbp.raw.shots` filtered to team (and optionally player): made/att by bucket
`rim` (z rim/paint-at-rim or dist≤5), `mid` (2pt else), `three` (is3), split cumulative vs
current-quarter. Output: `{ mix: {rim,mid,three}, unsustShare }` where unsustShare = share of
made-shot points from three+mid. Quarter-filterable for free via `q`.

**F3. `ssCarrierBaseline(playerId, season)`** (~30 lines)
Lazy BDL fetch, **alert path only**: `/wnba/v1/player_stats?seasons[]={Y}&player_ids[]={id}
&per_page=100` → `{ g, ppg, tsNorm }`. Called for ≤3 players per alert (leader top-2, trailer
top-1): ≤3 API requests on a path that fires a few times per week. 8s timeout, try/catch,
failure → null (carrier classified UNKNOWN). No table, no cron change. (Graduation path to a
baselines table in §9 if we later want this per-snapshot.)

**F4. `ssClassifyCarrier(ppg)`** (~5 lines)
`ppg==null → 'UNKNOWN'` · `≥14 → 'STAR'` · `≤10 → 'ROLE'` · else `'MID'`. Thresholds from the
addendum cuts (star ≥14 n=90; role ≤10 monotone across 9/10/11).

**F5. `ssComposeCtxBlock(digest)`** (~45 lines)
Builds the prompt context block AND the conditional framing rules (§5). Returns `{ text, cols }`
where `cols` = `{ carrier_name, carrier_identity, carrier_share, carrier_ppg, ctxJson }` for the
row UPDATE. Pure function — testable with fixtures.

**Signature & call-site edits:**
- `fireSweetSpotAlert(sql, game, league, hA, aA, ss, pctx = null)` — 7th param optional →
  **force-test needs zero changes** and behaves exactly as today (null → no digest → current
  prompt shape).
- Live call site (~8104): add `, { modelSummary, pbp: game._bdlPbp }` — one line.
- Stage 2: digest assembly wrapped in its own try/catch **before** the Opus call; any failure →
  `digest = null`, narration proceeds as today. Digest can never kill the alert (Stage 1 already
  delivered) or the narration.
- Row update widens to: `SET narration_text=…, carrier_name=…, carrier_identity=…,
  carrier_share=…, carrier_ppg=…, player_ctx_json=…` (same single UPDATE, same rowId).
- `max_tokens` 400 → **500** (prompt grows ~350 tokens; response asked for 3–4 sentences now).

### 4.2 `netlify/functions/db-api.js` — schema (idempotent)

```sql
ALTER TABLE sweetspot_alerts ADD COLUMN IF NOT EXISTS carrier_name TEXT;
ALTER TABLE sweetspot_alerts ADD COLUMN IF NOT EXISTS carrier_identity TEXT;   -- STAR|MID|ROLE|UNKNOWN
ALTER TABLE sweetspot_alerts ADD COLUMN IF NOT EXISTS carrier_share REAL;      -- of leader pts at fire
ALTER TABLE sweetspot_alerts ADD COLUMN IF NOT EXISTS carrier_ppg REAL;
ALTER TABLE sweetspot_alerts ADD COLUMN IF NOT EXISTS player_ctx_json JSONB;   -- full digest audit
```
In `?action=init`. Run init after deploy. Everything else in the digest (foul trouble, shot mix,
trailer carriers, TS devs, baselines fetched) lives inside `player_ctx_json` — no column sprawl,
full audit for the calibration tracker and the forward-OOS ledger.

## 5. Stage-2 prompt — FINAL TEXT (prompt text = code; numbers below are constants)

Core (existing lines kept: matchup, gate reasons, model-vs-market) plus the context block from F5,
then the rewritten instruction. Provenance tags per prompt-rigor law.

**Context block template (F5 output; lines omitted when data absent):**
```
PLAYER CONTEXT [FACT-live]:
- {LEADER} scoring is carried by {carrier} ({share}% of team pts, {pts} pts, live TS {ts}%;
  season {ppg} ppg → {STAR|MID|ROLE} carrier{, running +{dev}pp over her season norm}).
  Shot mix: {rim}% rim / {mid}% mid / {three}% threes.
- Foul trouble: {list of starters with 3+ fouls, both teams} | none.
- {TRAILER} comeback engines: {top-2 trailer scorers w/ pts + live TS}; bench {b}% of pts.
- {TRAILER} shooting {efg}% eFG while trailing{ — at/below par: the deficit is variance, not
  quality [PRIOR-validated]}.

FRAMING RULES [PRIOR-validated unless tagged]:
- The fade thesis here is TEAM-level: quality gap first; {LEADER}'s elevated eFG amplifies it
  (gap alone ~53% comeback; gap + leader shooting hot ~61%).
- Hot shooting regresses to the shooter's own norm within the game — but points already scored
  are banked; regression alone does not hand the lead back.
- IF carrier=STAR: star-carried leads historically HOLD BETTER than average (~26% comeback vs
  ~34% base). Do NOT call {carrier}'s production a mirage; name her as the primary risk — she
  regresses to a norm that still feeds the lead. The mirage claim applies to the team-level
  variance share, not to her.
- IF carrier=ROLE: a ≤10-ppg player carrying the lead is an early-sample fragility signal
  [PRIOR-candidate, n<30] — supportive color, not a load-bearing claim.
- IF carrier=MID/UNKNOWN: no carrier framing; stick to team-level reasons.
```

**Rewritten instruction (replaces the current 3-sentence ask):**
```
Write exactly, under 110 words, no jargon, no preamble:
(1) one sentence on why {LEADER}'s lead is statistically fragile at the TEAM level (variance
    share / eFG band / quality gap);
(2) one sentence on why {TRAILER} is the better team likely to close, naming their live
    comeback engine(s);
(3) one sentence on the single biggest risk — if carrier=STAR this MUST be the star sustaining
    at her norm; include foul trouble on either side if present.
Never predict a specific player's shooting will collapse. Never contradict the framing rules.
```

Removed from current prompt: the unconditional "why {LEADER}'s lead is a mirage" ask (line 1 now
scoped to team level; per the kill-doc, player-level mirage framing is validated-false when
star-carried).

## 6. Cascading implications (traced)

| Surface | Effect |
|---|---|
| NBA path | Byte-identical. All edits: fireSweetSpotAlert (WNBA-only caller + force-test), WNBA-gated call site, WNBA-only table. |
| Poll hot path | Zero cost — digest lazy inside Stage 2 (rare). No new per-poll fetch, no snapshot change. |
| Force-test `ss_force_test=1` | Unchanged behavior (pctx defaults null). New `=2` variant (§7). |
| Dedup / Stage 1 | Untouched — insert columns are nullable, ON CONFLICT unchanged. |
| Opus budget | +1 no calls (same single Stage-2 call); ~+350 prompt / +100 output tokens per alert. |
| BDL budget | ≤3 extra requests per fired alert (lazy baselines), non-fatal. |
| db-api SELECTs | No critical-path SELECT touches these columns (law respected); JSON audit via existing row reads. |
| Calibration tracker (Phase-2 item) | Gains carrier_identity/share/ppg + ctx JSON per alert → role-carry and eFG-amp forward samples accumulate with zero extra work. Supersedes the "nightly-log fields" backlog item for SS spots (manual log still covers non-SS discretionary bets). |
| Learning/post-game agent | No reader of this table yet — no change. |
| Failure modes | Digest throw → null → today's narration. Baseline fetch fail → UNKNOWN carrier → no carrier framing. Empty players[] (ESPN-down early edge) → digest partial, lines omitted. |

## 7. Test plan (owned per Testing Ownership)

1. **Fixtures (pre-deploy):** run F1/F2/F4/F5 as pure functions against fixture rows in-sandbox:
   null `pf`/`pls_min` rows, string minutes both formats, empty `players[]`, empty `shots`,
   ROLE/STAR/UNKNOWN branches of F5. `node -c` syntax gate before commit.
2. **Force-test v2 (post-deploy):** `?ss_force_test=2` — fires the synthetic alert WITH a
   synthetic `pctx` fixture (embedded) → validates digest→prompt→narration→row round-trip
   end-to-end incl. new columns. `=1` unchanged as the null-pctx regression check.
3. **Diag step:** `?diag=1&diag_step=ss_pctx&gid={game_id}` → returns the computed digest JSON
   for a live/recent game (no alert, no ntfy) — live-shape validation on a real slate.
4. **Validation game:** first live A-fire after enable, pull row + narration, audit framings
   against the box.

## 8. Rollout

No new flag — rides `WNBA_SS_ALERT_ON` (currently dark). Sequence:
```
commit → push → sleep 60 → curl ?action=init → curl ?ss_force_test=2 → curl ?ss_force_test=1
→ curl ?diag=1&diag_step=ss_pctx&gid={live} → ss_force_clear=1
```

## 9. Follow-ons (explicitly NOT this build)

- `wnba_player_baselines` table (incremental nightly upsert + one-time backfill from the proven
  bulk pull) — only if we later want carrier context on every snapshot / in per-quarter analysis,
  or norm-based trailer-eFG dev (currently absolute-band proxy).
- 2021–2023 PBP pull → role-carry OOS. If it validates at n≥60+, role-carry graduates from
  prompt color to candidate `alert_subtype` discussion.
- NBA replication of the gap-amplifier construction on a rebuilt 1,235-game set.

## 10. LOE

| Item | Size |
|---|---|
| F1–F5 inline functions | ~200 lines |
| Signature + call site + Stage-2 wiring | ~25 lines |
| Prompt rewrite | ~40 lines (template literal) |
| db-api migration | 5 idempotent ALTERs |
| Force-test v2 + diag step | ~40 lines |
| **Total** | **~310 lines, 2 files, single session incl. validation** |
