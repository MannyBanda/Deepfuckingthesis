# WNBA POT Attribution Fix + Historical Backfill — Jun 10, 2026

## What shipped
1. **Forward fix** (commit 4e1/...): ESPN `turnoverPoints` is opponent-attributed (adjudication n=81: flip 17%→67% exact). Sides now swapped at the `buildSummaryFromESPN` call site, league-gated to WNBA. Phase 1 v2 overlay simplified to own-side read (`v2_src: espn+flip` → `espn`). All live consumers corrected: raw_stats_json, espn_raw_stats_json, computeServer/I1, extractXGBFeatures (feature [11]), agent prompts, display.
2. **XGB consistency finding:** WNBA XGB was trained on SR data (CORRECT attribution) via backtest-wnba — prod has been feeding it inverted pot all season. The fix REPAIRS model input consistency; no shim needed. Plausible contributor to WNBA XGB's live underperformance vs market (Jun 9 edge test).
3. **Backfill** (`?backfill_pot=1&batch&after&dry` in poll-live-bdl): swapped pot in raw_stats_json + recomputed i1/floor_score/floor_team (stored ctrl-relative i2-i5 pivoted home-relative via alias-normalized side determination, re-blended with corrected I1, re-pivoted vs new control).

## Results (universe: 7,467 WNBA snapshots)
- **6,888 corrected (92.2%)**, tagged `_pot_corrected`
- 188 already correct (post-fix rows, pot==pot_v2)
- **391 quarantined (5.2%)** on floor-parity gate — never written
- i1 parity after alias normalization: **100%** (was 72% before SR/BDL alias fix — pre-May-16 floor_team uses SR aliases)
- i1 changed in ~33% of corrected rows; control team flipped in ~4% (78 rows); mean |floor delta| ~0.04-0.05

## Safety mechanics (validated)
- Dual parity gates: I1 replica on ORIGINAL pot must reproduce stored i1; re-blend must reproduce stored floor_score (±0.011). Any miss → skip, never write. Offline-validated 100% (86/86) on live CON@TOR before deploy.
- Known gate blind spot: full-side inversion is parity-invariant (floor=max(raw,1-raw) symmetric; i1=0.5 pivot-invariant) — exactly what the alias schism caused. Fixed via SR↔BDL normalization + hard skip on unresolved aliases. Lesson: dry-run `ctrl_flips` rate is the tell (113/138 bogus vs 6/194 real).
- Idempotent: `_pot_corrected` tag + pot==pot_v2 skip. Verification sweep: 0 would-update.

## Open items
- **Quarantine class ≈ boundary/calibration snapshots** (count ~86 games × 4-5 boundaries, season-wide id spread, and tonight's boundary rows show pot==pot_v2 even pre-fix — boundary path sources pot differently than live rows). Provenance trace queued for Phase 2 session (same plumbing).
- **Alerts table intentionally untouched** (historical decision log — Manny's call, Jun 10).
- Stored xgb_win_prob historical values still reflect flipped-pot inputs — rescore_xgb_prod.py available if needed for research.
