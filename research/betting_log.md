# DFT Betting Log (running)

**Purpose:** forward out-of-sample record to separate two measurement streams —
1. **Signal base edge** across all clean dual-gate sweet-spot triggers (system-flagged)
2. **Realized edge** on the spots actually bet

Discretionary alpha = (2) − (1). Never conflate them. Append one section per slate, **newest on top**.

**Dual-gate sweet spot** (= the system A+) = Bad-Leader Collapse [leader win% < .40, quality gap ≥ .10] **+** Efficiency-Divergence Fade [leader eFG orange/red, variance share > 55%, margin < 10, pre-Q4] **+** VOLATILE lead class. Full detail: `dft_daily_playbook.md`.

**Grade key:** `A+` clean dual-gate trigger · `A−/B+` strong discretionary (quality gap ≥ .20 + closing capacity, leader not sub-.400) · `B` one gate clean, other soft · `C/D/F` pass-column bets taken anyway.

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
