# Graduation Simplification Research Findings
**Date:** May 6, 2026
**Dataset:** 1,234 games, 13,213 Q2+ checkpoints (backtest), 48 playoff games (production)

## Core Question
Does MC Cumulative eliminate the need for multi-checkpoint floor graduation?

## Key Findings

### 1. MC Trajectory Adds Marginal Lift (Q4)
| MC≥0.80 in Q4 | Accuracy | n | vs Single |
|---|---|---|---|
| Single snapshot | 95.0% | 2,579 | baseline |
| 2 consecutive | 96.0% | 2,214 | +1.0pp |
| 3 consecutive | 96.9% | 1,957 | +1.9pp |

Trajectory is noise-reduction, not signal-amplification. When signal is already strong (Q4), tracking barely helps.

### 2. Single-Checkpoint Compound Beats Graduation (Game-Level)
| Method | Accuracy | Games |
|---|---|---|
| MC≥0.90+Floor≥0.70 | **98.8%** | 685 |
| MC≥0.80+Floor≥0.65 | **97.7%** | 788 |
| MC≥0.80 alone | 96.5% | 918 |
| S-rank graduation | 92.8% | 475 |
| Floor≥0.65 alone | 90.9% | 929 |

### 3. When Compound and Graduation Disagree, Compound Wins
| Q4 Scenario | Accuracy |
|---|---|
| Compound GOOD + Grad C | **92.4%** (303) |
| Compound BAD + Grad S/A | 42.0% (112) |
| Compound GOOD + flips | **94.1%** (745) |

### 4. MC Solves the Flip Problem
A-rank-with-flips = 58.5% (biggest loss bucket). MC≥0.80 with flips = **93.3%**.

### 5. BLOWOUT CONTAMINATION (Critical)
| Q4 MC≥0.80+Floor≥0.65 | Accuracy | n |
|---|---|---|
| All checkpoints | 95.8% | 2,263 |
| Actionable (margin ≤10) | **86.6%** | 558 |
| Close (margin ≤8) | **84.0%** | 343 |
| Tight (margin ≤5) | **83.7%** | 86 |

The 95.8% headline is real but inflated by blowouts. Actionable accuracy is 84-87%.

### 6. EXIT Is a Separate Problem
MC Cum-based exit = ~53% at all thresholds. XGB EXIT stays untouched.

### 7. Hold Direction Is Noise
Flat MC across 3 holds = 74.5%. Rising = 63.1%. Declining = 62.4%. Stability IS the signal.

### 8. Q2 High-Confidence Graduation
| Q2 Condition | Accuracy | Games |
|---|---|---|
| 4 consec MC≥0.85+Floor≥0.70+lead≥5 | **89.2%** | 278 |
| 3 consec MC≥0.90+Floor≥0.70+lead≥5 | **87.0%** | 328 |

Margin gate essential in Q2 (without lead≥5, close-game accuracy ~65%).

### 9. MC Cum Blind Losses
355 games where compound held in Q4 but ctrl lost:
- 52% (185): MC NEVER dropped below 0.60 — cumulative anchoring masks collapse
- 48% (170): MC did drop — canary system would catch these
- PBP MC canary (windowed rates) catches collapses MC Cum can't see

### 10. PBP Canary Coverage (Backtest 200 Games)
| Pattern | n | Precision |
|---|---|---|
| CLEAN | 48 | 77.1% |
| WAVE | 6 | 66.7% |
| NORMALIZED | 30 | 16.7% |
| FALSE_ALARM | 78 | 17.9% |

CLEAN + XGB<0.50 = **86.7%** precision. PBP canary + XGB agreement is the collapse detection system.

## Proposed Simplified System
- **Q2 early grad:** 3-4 consecutive checkpoints MC≥0.85 + Floor≥0.70 + lead≥5
- **Q3+ standard:** First checkpoint MC≥0.80 + Floor≥0.65
- **No rank letters, no flip tracking, no mean floor, no checkpoint counting**
- **EXIT:** XGB EXIT unchanged
- **Collapse detection:** PBP MC canary unchanged
- **Margin:** Gate in Q2 only; Q3+ margin baked into MC

## What Gets Retired
- game_checkpoints graduation role (table stays for other uses)
- S/A/B/C rank assignment
- Mean floor / min floor calculations
- Flip penalties and recovery rules
- B-rank Q3_6 gate
- Graduation swap on flip
- ~500 lines of complexity → ~30 lines replacement

## Analysis Scripts
- `research/2026-05-06-graduation-compound-analysis.py`
- `research/2026-05-06-graduation-extended-analysis.py`
- `research/2026-05-06-graduation-blind-spots.py`
- `research/2026-05-06-canary-coverage-analysis.py`
