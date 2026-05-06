# Graduation System Backup — Pre-Simplification

**Date:** 2026-05-06
**Commit:** dec7deb5b385e1b271ce5ee91290251d41cbf9b2 (dec7deb)
**Reason:** Backing up current multi-checkpoint graduation system before simplification to compound-threshold model (MC Cum + Floor).

## What This Preserves

The full checkpoint graduation system as shipped and validated against 1,235 games:

### poll-live-bdl.mjs (~8,148 lines)
- `checkpointGraduation()` — S/A/B/C rank assignment from floor trajectory
- `game_checkpoints` table writes (atomic INSERT ON CONFLICT DO NOTHING)
- Catch-up loop for missed checkpoints
- Graduation swap on control flip
- B-rank Q3_6 gate
- Mean floor (MF=0.65), min floor (0.58) thresholds
- Flip penalties and recovery rules
- PO_ACTIVE sentinel for race-safe graduation
- BWC Death clearing checkpoint/graduation state
- Graduation rank in alert context + agent prompts

### db-api.js (~2,713 lines)
- `game_checkpoints` table schema + queries
- `get_checkpoints` endpoint
- Graduation rank in alert/snapshot queries

### post-game-agent.mjs (~726 lines)
- Arc scoring using graduation rank
- Graduation context in learning agent prompts

### v3.html (~3,928 lines)
- Graduation rank display in snapshot history
- grad_rank column rendering

### Validation Results (at time of backup)
- S-rank: 85.6% (wire-to-wire)
- A-rank clean: ~80%
- A-rank with flips: 58.5% (94 games — biggest loss bucket)
- B-rank: 77.2% (Q3_6 gate validated)
- Overall competitive: 77% / full: 85.8%

### Why We're Replacing It
MC Cum single-checkpoint compound (MC≥0.80 + Floor≥0.65) produces 95.8% accuracy at Q4 checkpoint level (84-87% in actionable/close games), beating S-rank graduation by 5pp while covering 66% more games. Multi-checkpoint floor tracking adds negative value when MC Cum is available. See `research/2026-05-06-graduation-simplification-findings.md` for full analysis.
