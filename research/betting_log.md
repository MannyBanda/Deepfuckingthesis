# DFT Betting Log (running)

**Purpose:** forward out-of-sample record to separate two measurement streams —
1. **Signal base edge** across all clean dual-gate sweet-spot triggers (system-flagged)
2. **Realized edge** on the spots actually bet

Discretionary alpha = (2) − (1). Never conflate them. Append one section per slate, **newest on top**.

**Dual-gate sweet spot** (= the system A+) = Bad-Leader Collapse [leader win% < .40, quality gap ≥ .10] **+** Efficiency-Divergence Fade [leader eFG orange/red, variance share > 55%, margin < 10, pre-Q4] **+** VOLATILE lead class. Full detail: `dft_daily_playbook.md`.

**Grade key:** `A+` clean dual-gate trigger · `A−/B+` strong discretionary (quality gap ≥ .20 + closing capacity, leader not sub-.400) · `B` one gate clean, other soft · `C/D/F` pass-column bets taken anyway.

---

## 2026-07-20 (WNBA) — P&L **+$463.16**

4-game pre-All-Star slate. Both 7pm games fired WATCHLIST reviews with the better team down 1 — instructive pair: same tier, opposite premises, opposite outcomes. **Caesars debuts in the ledger** (line-protection split alongside bet365). Flagged stream after slate: **7-1, +$5,157.16**; unflagged speculatives hold 0-2.

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| MIN@SEA | MIN ML — staged 4 entries, 2 books | $800 | blended ~+95 (−210/−115/+122/+125) | **W** (105-102) | +$763.16 | **A / C− / A−** | WATCHLIST row 601 (leader SEA .222, eFG 71 red, gap .547) |
| WSH@GS | GS ML — 2 entries | $300 | ~+150 est | **L** (WSH 88-82) | −$300 | **C+ / A / B+** | WATCHLIST row 587 (leader WSH .500, scalps 3, gap .231) |
| NY@DAL | **PASS** (DAL, REVIEW row 545) | — | — | NY won in OT | $0 | **A (pass)** | WATCHLIST (gap .16, Bueckers out) |

### Grades

- **MIN@SEA A / C− / A−** — *Entry A:* strongest WATCHLIST shape yet bet — leader at .222 deep in the <.400 evidence band holding a 71% red-band lead, gap .547 *understated* by MIN's −.10 deflation. Regression played on script (SEA 71 → 59.8). *Sizing C−:* $800 vs the $600 lane cap, no pre-entry lane declaration. Cap-creep pattern named: $300 cap → row 20 breach at $500 → lane built at $600 → breached at $800. Each breach retroactively legitimized by a win; the win does not soften the grade. Do not resize off green P&L — that is the graduation bar's entire job. *Execution A−:* staged into SEA's Q4 variance push at improving prices, split across Caesars/bet365 to protect the line (the exact line-impact problem previously flagged, solved correctly).
- **WSH@GS C+ / A / B+** — *Entry C+:* not a donkey bet — STRONG FADE was flashing at the 03:08Z window and Friday's identical matchup converted. But three known, visible checks were skipped: leader wp .500 sits **outside the <.400 band** where all conversion evidence lives (and carried **3 elite scalps** — stamped on the row); GS's +.69 schedule inflation (league max) made the .231 gap mostly phantom; GS's own eFG was green-cold 47-53 all night — no capacity to punish the regression. The fade *landed* (WSH 66.1 → 59.8) and WSH still won on the structure underneath (final lead STRUCTURAL, var 37). Lesson canonized: **the fade grades the leader's heat, not the trailer's ability to collect.** *Sizing A:* exactly at the $300 WATCHLIST cap. *Execution B+:* ~+150 entry, no chasing GS's VOLATILE Q4 lead; hedge deliberation at +800 was premise-driven (leader-band check), declined on circumstance — the good version of the hedge instinct.
- **NY@DAL A pass** — Review row 545 fired at Q2 8:58 on a .16 gap; passed on two independent strikes: whose-variance check failed (DAL was the variance side — 59.5-63.4% eFG while even/trailing) and Bueckers out made the Bueckers-inclusive .68 wp a stale input the market had already priced. Arc validated end-to-end: DAL's heat peaked 63.4, round-tripped to 52.2, regulation ended 83-83, NY in OT. Behavioral note: FOMO named in real time and resisted without a pacifier bet — the pass IS the move.

**Triage takeaway (feeds the review-chip spec):** the five peepable discriminators between the two WATCHLIST spots were leader wp band, leader scalps, schedule-inflation badges, trailer's own eFG temp, and live-line behavior — all available at or before entry.

---

## 2026-07-18 / 07-19 (WNBA) — P&L **$0** (weekend, no bets)

| Game | Side | Stake | Result | Grade | System trigger? |
|---|---|---|---|---|---|
| WSH@GS (Jul 18) | no bet | — | GS converted as trailer (74-69) | — | WATCHLIST (gap .198, def 7) |
| LA@DAL (Jul 19) | no bet | — | DAL converted vs killer LA (gap .25) | — | WATCHLIST (killer leader) |

Both review-stream spots converted unbet — they feed WATCHLIST calibration (12/12 resolved, 75% vs 66% predicted), not the realized-edge stream.

---

## 2026-07-17 (WNBA) — P&L **+$450** *(backfilled from DB row 21)*

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| SEA@IND | IND ML live | $300 | +150 | **W** | +$450 | **A / A / A** | GAP_BASE row 435 (gap .353, SEA killer-flagged — first live-stamped killer row) |
| ATL@TOR | **PASS** | — | — | — | $0 | **A (pass)** | modest-gap no-scalp leader class; price under breakeven per addendum rule |

Entry at Q3_END down 6-8 — the textbook validated cell; beat the fire-time implied price via deficit patience. The ATL@TOR pass is the price-discipline rule working as written.

---

## 2026-07-15 (WNBA) — P&L **+$370.37** *(backfilled from DB row 20)*

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| LA@MIN | MIN ML live | $500 | −135 | **W** | +$370.37 | **A− / C / A** | WATCHLIST row 401 (gap .295, LA lead VOLATILE 61% var) |

Sized $500 over the $300 WATCHLIST cap on team-quality conviction — post-hoc codified as the **Override Lane** (top team, negative schedule inflation). Declined cash-out at Q4 2:20 up 13 (BE 97.6% vs honest ~99% = correct hold). The sizing C is the lane's origin story — and the pattern row 22's C− now escalates.

---

## 2026-07-12 (WNBA) — P&L **+$1,498.95**

First slate where the majority of action rode an above-bar band game. WATCHLIST fired on both day games. **Bankroll note: $22K (revised from $39K); sizing judged against this and the graduation stage — Manny is deliberately under-sizing while working up to right-size.**

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| SEA@WSH | WSH ML — staged entry: $500 @ +100 first, add $500 @ +160 | $1,000 | +100 / +160 | **W** (84-79) | +$1,300 | **A−** (one position) | WATCHLIST (gap .25, edge +4.6pp, SEA orange/red early) |
| NY@TOR | NY ML live | $100 | +400 | **L** (91-93) | −$100 | **B−** | WATCHLIST but gap .156 below bar; collapse NO_EDGE |

### Grades

- **WSH staged entry A−** — Entry order: +100 first after the REVIEW + dashboard check (position secured), then patience for the price to drift out, add at +160, and **declined a third $500 at +185** — a deliberate exposure cap. Above-bar spot (gap .25), plus money, total $1,000 = 4.5% of bankroll: intentionally under Kelly while trust builds. This is the graded template for staged entries going forward: secure the read, let price come to you, cap the position. Converted 84-79. (Prior B+/B− split superseded — the "add at worse price" critique had the entry order reversed.)
- **NY +400 B−** — Reasoning (Manny): NY was down 20, dashboard showed the comeback developing, entry came only after the run proved bite, at a price the market hadn't repriced. Nearly hit — tied with a minute left, NY had the last shot. Credit: confirmation-based entry timing, correct speculative-stream labeling, 0.45%-of-bankroll size. Caveats that keep it below B: the origin deficit (−20) is BANKED territory — the ATL Jun-24 shape — and gap .156 + NO_EDGE leader meant the framework saw thin; at +400 the price has to carry the whole thesis. Fine as a rare, tiny, confirmation-gated speculative; not a stream to grow.

- **CHI@DAL staged entry, B+ read / A− exit** — Gap .334 (well above bar) but CHI's lead classed STRUCTURAL — the Jun-24 POR@CHI shape that says PASS. Manny consciously overrode on a quality-conditional thesis ("a low-quality team's structure is less trustworthy than a high-quality team's variance") at deliberately reduced size ($400 = 1.8% of bankroll). Both a WATCHLIST and a **GAP_BASE ledger row** fired on this game — he bet the exact cell the ledger is accumulating, and it converted (96-91). The exit: cashed the +200 leg at $488.95 with DAL up 1 and ~1:00 left — breakeven hold probability 81.5% vs true ~60-70% → mathematically correct cash-out (contrast Jul 10: up 13 with 73 seconds, ~99% locked, sold anyway). Exit rule adopted: **judge cash-outs by breakeven probability (offer ÷ full payout) vs. honest win probability — not by feelings.** The override thesis is logged as unvalidated and feeds the team-conditional backtest.

- **IND@LV LV +380, C** — No alert fired (gap .148 sits below even the watchlist threshold), collapse NO_EDGE, fade NO FADE. The thesis — back the trailer winning the structural battle against a high-eFG leader — is the structural-underdog shape tested and killed 2026-06-21 (1-for-7; "the market prices visible structure"; the live-dog edge lives only where the trailer is the much better team, gap >.20 → 57% vs 38% implied). IND won 102-75: the sticky-lead read cashed, LV's structural +6 evaporated. Right size (0.9% bankroll), killed shape. Rule extracted by Manny himself: no buys without an alert + real gap. Day's ledger on this: flagged above-bar positions 3-for-3 (+$2,594 incl. Jul 10); unflagged speculatives 0-for-2 (−$300).

**Grading convention (adopted 2026-07-12):** staged entries on one game grade as ONE position (entry discipline, price patience, and exposure cap are part of the grade); size is judged against current bankroll ($22K) and graduation stage, not absolute dollars.

---

## 2026-07-11 (WNBA) — P&L **$0** (pass)

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| POR@ATL | **PASS** (ATL, REVIEW fired) | — | — | ATL lost 92-102 | $0 | **A (pass)** | WATCHLIST only (gap .18, POR 78.6% eFG red) |

### Grades

- **POR@ATL A pass** — First band game that didn't convert (pool now 2/3), and the discretionary filter caught it: Reese out (injury layer the system can't see), ATL on a skid including a prior loss to Portland itself — the exact leader they were trailing. Gap .18 was also below the ≥.20 discretionary bar, so system and instinct agreed this was thin. This is the alpha the bet join exists to measure: articulated pass reasoning on a losing band game.

---

## 2026-07-10 (WNBA) — P&L **+$895.84**

First live WATCHLIST night — fired on both DAL@TOR and GS@CON (Q2 band entry). No A/B tiers aligned on the slate (DAL@TOR collapse read stayed NO_EDGE all game; GS@CON edge existed only in Q1 before GS flipped the lead).

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| DAL@TOR | DAL −2.5 live (accidental — meant ML) | $500 | −115 | Cashed out @ 108-95, ~1:13 Q4 | +$278.99 | **A− read / C exit** | WATCHLIST only (gap .208, TOR red band) |
| DAL@TOR | DAL ML live | $1,000 | entry odds unlogged | Cashed out $1,616.85 | +$616.85 | **A− read / C exit** | same |
| GS@CON | **PASS** (considered GS ML −190, $2K) | — | — | GS won 79-64 | $0 | **Good pass** | WATCHLIST only; no A/B; edge gone by Q2 |

### Grades

- **DAL@TOR A− read** — Gap .208 (meets ≥.20 discretionary bar), TOR leading on 73–93% red-band eFG with variance share ~48–56% all game: the textbook mirage shape, even though mechanical tiers never aligned (collapse NO_EDGE throughout — model edge never computed on this game). Injury layer (TOR missing 2 starters) is discretionary information the system doesn't gate on. Thesis played exactly: DAL trailed most of the game, took over Q4 (84-87 down at 8:17 → won 108-95). **File under: quality gap + Q4 execution, heat-amplified.**
- **DAL@TOR C exit** — Two leaks. (1) Ticket-entry error: bet spread −2.5 when the read was ML. (2) Cashed a locked ticket: at 108-95 with ~1:13 left, −2.5 is ~99% to cash; sold $934.78 for $778.99 — $155.79 (36% of the profit) donated to the book. ML cash-out haircut unquantified (entry odds not logged — log them next time). Jun-24 leak was staking; tonight's leak is exits. Selection strong, execution leaks money.
- **GS@CON good pass** — REVIEW is not a bet call, no tier aligned, −190 live offered no measured edge, and $2K would have been far oversized. Hindsight cost ~$1,053; process was right. Refinement: the answer to "strong team, weak signal" isn't $0 or $2K — it's a small discretionary size. Binary sizing is its own leak.

---

## 2026-07-04 (WNBA) — P&L **+$1,065** (backfilled 2026-07-10)

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| GS@ATL | GSV ML live | $200 | +195 | **W** (88-83) | +$390 | **C+** (price) | No — gap ±.05, no fade shape, coll NO_EDGE all game |
| GS@ATL | GSV ML live | $300 | +225 | **W** (88-83) | +$675 | **C+** (price) | No — same |

### Grades

- **GSV C+** — Near-even teams by the numbers (gap ±.05 the whole game, seesaw lead, no eFG mirage on either side). The "GSV is top tier" conviction wasn't in the standings gap at bet time. Plus-money price plays on a coin-flip game that won — same bucket as PHX Jun 24. Size down and label honestly: this is the price/variance stream, not the quality-gap stream.

---

## 2026-06-24 (WNBA) — P&L **+$970**

| Game | Side | Stake | Odds | Result | P&L | Grade | System trigger? |
|---|---|---|---|---|---|---|---|
| MIN@WSH | MIN ML (live) | $700 (3) | +100 / +190 / +230 | **W** | +$1,140 | **A−** (disc.) | No — WSH .500 ≥ .40; lead ~75% structural |
| PHX@IND | PHX ML | $200 | +300 | **W** | +$600 | **C+** (price) | No — IND .556; both 64-69% eFG coin flip |
| ATL@GS | ATL ML (live) | $570 (5) | +425 → +1800 | **L** | −$570 | **C** (B− setup / D exec) | No — GSV .611; fade read BANKED/LATE |
| POR@CHI | POR ML | $200 | +200 | **L** | −$200 | **F** | No — CHI .294 bad leader but lead STRUCTURAL → pass |

**Clean dual-gate triggers this slate: 0.** Green P&L came entirely from the discretionary stream (MIN quality-gap read, PHX price play). System edge had no clean look — and that's fine.

### Grades

- **MIN A−** — Quality gap +.278 (largest on board). WSH propped by Citron's unsustainable individual line (28 pts, 4/5 3P, 84% TS) + FT volume, *not* a high-variance team eFG lead (WSH team eFG 46.7%, ~75% of points paint+FT). MIN cold where it regresses up (8/30 3P), closed 28-18 Q4. Read + price validated; A−, not A+, because no system trigger (leader not sub-.400, lead not eFG-elevated). **File under: quality gap + closing capacity, NOT eFG-fade.**
- **ATL C** — Setup looked right, Q4 vindicated the mechanism (26-14, 73% eFG). But gap only +.095 (GSV mid-tier, not bad), and the fade read showed BANKED (+10) then LATE at every entry. Chased +425 → +1800 into a 25-pt hole. Leak = staking, not selection.
- **PHX C+** — Coin-toss shootout, backed the worse team on the +300 price alone. Won. Higher-variance, not the sweet spot. Size down, label as price play.
- **POR F** — +.150 paper gap was a trap. CHI's lead structural (paint 56-30, rim 70% vs 41%, FT) with *cold* threes; POR was the variance team (40% 3P papering over 41% rim). Fade read = STRUCTURAL → pass. Correctly self-diagnosed.

### Net lesson
"Unsustainable" = **elevated eFG (± high variance share), on the LEADER's side** — not variance alone, not a favorable season gap alone. Added screen criterion: **"whose variance is it?"** (variance-share delta must favor the leader). POR vs ATL is the teaching pair. Leak tonight was the ATL **chase past BANKED**, not selection.
