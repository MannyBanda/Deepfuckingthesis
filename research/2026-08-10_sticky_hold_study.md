# 2026-08-10 — STICKY HOLD Study — DIRECTIONALLY STRONG, UNDERPOWERED, NOT PROMOTED

**Pre-registered** (chat, PM go): sticky = EARNED fuel + trailer period-green +
trailer TO <4, in-band (lead 1-9), computed per computeFuelTemp semantics on the
211-game 2026 archive. Primary unit = first sticky state per game. Outcome =
lead HOLDS. Bar: hold edge >= +8pp vs best-price implied at n >= 40, OOS
ordering intact.

## Phase 1 — hold rates (28 sticky games; 40 sticky states of 767 in-band)
- All sticky: HOLDS 64.3% (n=28) vs non-sticky in-band 61.7% (n=128) — nothing overall.
- **Gap >= .15 (dog leader): sticky HOLDS 58.3% (n=12) vs non-sticky 33.3% (n=24)** —
  the tag's entire value concentrates where the leader is priced as a dog.
- All 28 first-sticky states are pre-Q4 (Q2-dominant). OOS dog cell unstable:
  40.0% (n=5) derive -> 71.4% (n=7) validate.

## Phase 2 — vs market (odds joined <=4min for all 28)
- All sticky: HOLDS 64.3% vs 48.0% implied -> **+16.3pp** (n=28)
- Dog leader (gap >= .15): HOLDS 58.3% vs 31.9% implied -> **+26.4pp** (n=12)
- Leader at plus money: HOLDS 46.7% vs 29.9% implied -> +16.7pp (n=15)
- Consistent with Aug 6 addendum (+12pp, different state recipe).

## Caveats (why NOT PROMOTED despite the numbers)
1. **n >= 40 bar is unreachable this season** — 28 sticky games exist, period.
2. OOS ordering NOT intact in the money cell (40 -> 71 across halves).
3. Team concentration: WSH (4) + CON (3) = 7 of 12 dog-cell states.
4. The dog cell was spotted before Phase 2 priced it — pre-registration limits
   but does not eliminate selection-on-signal at this n.

## Disposition
NOT PROMOTED to any betting stream. Forward paths:
(a) STICKY_HOLD log-only ledger stream (GAP_BASE mechanics, no push, no bets)
    to accumulate forward n passively — needs spec + PM go.
(b) Manual watch starting now: STICKY chip already renders client-side; PM logs
    discretionary reads in the bets ledger with a STICKY tag (zero code).
(c) NBA arena requires NBA-recalibrated period bands — transfer risk, parked.

---

# PHASE 3 ADDENDUM (Aug 10) — 2025 HISTORICAL REPLICATION: FAILED

**Data:** cached sr_summary per-period stats (203-game stratified 2025 sample,
zero SR API hits, via new read-only export_states phase) + full BDL 2025
schedule (312 finals) for unbiased as-of records. States at end-Q1/Q2/Q3
boundaries, band mapped to next quarter, exact computeFuelTemp parity.

**Calibration control PASSED — the sample can see real signals:** the
triple-confirmed gap edge replicates a FOURTH time: trailer WINS 60.0% at
gap >= +.15 (n=30) vs 35.1% neutral (n=57) vs 20.4% at gap <= -.15 (n=54);
monotone again at end-Q2/Q3 (50/34/15). The instrument works.

**Sticky result in the same instrument — INVERTED:**
- All sticky band 1-9 (first per game): HOLDS 46.4% (n=28) vs non-sticky 70.0% (n=100)
- Dog-leader sticky: HOLDS **22.2%** (n=9) vs 2026's 58.3% (n=12)
- Pooled dog cell: 42.9% (n=21); separation vs pooled non-sticky dog ~0pp
- Pre-registered bar: FAILED all three legs (n 21<40; hold 42.9<55; sep ~0<15)
- 10+ leads (PM request): zero sticky states exist at 10+; non-sticky 10+
  HOLDS 91.7% (n=168) [stratified sample inflates this — margin-bucket bias]

**Verdict: dog-cell sticky edge FAILS replication with a passing calibration
control -> the 2026 +26.4pp reads as small-sample selection noise (12 states,
WSH/CON-concentrated, OOS-unstable). RULED OUT for any betting stream.**
STICKY_HOLD ledger build: KILLED (no Amendment scope). Manual watch may
continue as zero-cost observation only. Revisit bar: forward 2026 sticky dog
states n >= 25 with holds >= 60% reopens the question; nothing less.
