# MC Agent Prompt Changes

## Four Agents That Need MC Awareness

1. **Alert Reasoning Agent** (~line 481) — decides SEND/SUPPRESS/DOWNGRADE on every alert
2. **Auto-Analysis Sonnet** (~line 300) — structural analysis at quarter transitions
3. **Post-Game Learning Agent** (post-game-agent.mjs) — scores alert arcs, evaluates system accuracy
4. **Client Analysis** (analyze.js) — on-demand structural analysis from dashboard

---

## 1. Alert Reasoning Agent (highest impact)

### A. Replace VULNERABILITY WARNING section (~line 553-558)

**Remove:**
```
VULNERABILITY WARNING (fired earlier this game):
  ${team} flagged as vulnerable at Q${period} ${clock}
  PBP 15-possession window: ${score}% — opponent dominated recent possessions
  XGB at warning: ${xgb}% | Margin at warning: ${margin}
  This means the structural shift was detected BEFORE cumulative indicators caught up.
  Weight heavily for EXIT/BWC_EDGE/POSITION_SAFE decisions.
```

**Replace with:**
```
MC STRUCTURAL INVESTIGATION${pattern ? ' — ' + pattern : ' (active)'}:
  Triggered Q${trigger_period} ${trigger_clock} when ${ctrl_team} led by ${trigger_margin}.
  Floor at trigger: ${trigger_floor} | XGB at trigger: ${trigger_xgb}%
  Canary MC at trigger: ${trigger_mc}% (20-possession PBP window)
  Current MC win prob: ${current_mc}%
  Verdicts: ${verdicts.join(' → ')}
  Pattern: ${pattern || 'classifying...'}
```

### B. Replace VULNERABILITY rule (~line 290/770)

**Remove the VULNERABILITY rule block entirely.**

**Add these three rules:**

```
- MC_COLLAPSE: Fires mechanically when MC structural investigation reaches CLEAN
  pattern — possession rates since trigger show SUSTAINED deterioration that never
  normalized. 72.6% precision on 197 backtest games, 100% on production playoffs.

  WHEN MC_COLLAPSE APPEARS IN priorAlerts OR MC STRUCTURAL INVESTIGATION ABOVE:
  The cumulative floor and XGB are ANCHORED to early-game data. They do NOT reflect
  what is happening RIGHT NOW. MC computes rates from actual possessions since the
  trigger fired — this is the most current structural read in the system.

  Trust hierarchy when MC_COLLAPSE is active:
    MC pattern > XGB > Floor > Graduation badge

  Per alert type:
    EXIT: MC_COLLAPSE CONFIRMS the exit — the collapse was real and sustained.
          Reference MC in body: "Post-trigger rates show sustained collapse since
          Q${trigger_period} ${trigger_clock}."
    BWC_EDGE: SUPPRESS or add CRITICAL RISK line. The position is structurally
              compromised — floor is lying due to cumulative anchoring.
    POSITION_SAFE: SUPPRESS. Cannot reassure subscriber about a position where
                   MC detected sustained structural collapse.
    POSITION_OPEN: DOWNGRADE. Graduation badge may be stale — MC says the
                   structural edge that powered graduation is eroding.
    BUY (on opponent): If MC_COLLAPSE is on the ctrl team AND the opponent
                       independently qualifies as BUY, this is the highest-
                       conviction entry signal. The structural flip is confirmed
                       by MC before floor and XGB catch up.

- MC WAVE: Oscillating collapse. Rates collapsed, recovered, collapsed again.
  60% precision — RISK signal, NOT confirmed collapse.

  Per alert type:
    BWC_EDGE: SEND with prominent RISK line: "MC detected oscillating structural
              shift — rates collapsed then partially recovered. Position contested."
    POSITION_SAFE: DOWNGRADE — cannot fully reassure. "MC investigation shows
                   oscillating control — structural edge is contested."
    EXIT: Does NOT confirm exit by itself. Mention WAVE as context — "MC flagged
          oscillation but collapse is not sustained."
    BUY: Not affected — WAVE is about ctrl team degradation, not opponent quality.

- MC NORMALIZED: Investigation triggered but rates RECOVERED. This is a
  CONFIDENCE signal — the system investigated a potential collapse and cleared it.
  86-91% ctrl team survives.

  Per alert type:
    POSITION_SAFE: Reference as POSITIVE — "MC structural investigation triggered
                   at Q${trigger_period} but rates normalized. Dip was temporary,
                   structural hold validated."
    BWC_EDGE: Reference as reassurance — "MC investigated and cleared."
    EXIT: MC NORMALIZED argues AGAINST exit — the structural shift was noise.
          If EXIT fires alongside MC NORMALIZED, note the contradiction.
```

### C. Update STRUCTURAL STRESS CHECK (~line 184-190)

The stress override currently says "rolling window disagrees with cumulative floor." MC is a much stronger version of this signal.

**Add after the existing stress check:**
```
  MC STRUCTURAL INVESTIGATION overrides the rolling window stress check when active.
  MC CLEAN pattern = strongest possible stress signal — sustained possession-level
  collapse detected. This is NOT the rolling window (which averages recent quarters).
  MC tracks post-trigger rates from the exact moment deterioration was detected.
  If MC pattern is CLEAN or WAVE, treat as COLLAPSING/SHIFT combined read regardless
  of what the standard combined_read says.
  If MC pattern is NORMALIZED, treat as REINFORCING — the system tested the thesis
  under pressure and it held.
```

### D. Update ANCHORED FLOOR CHECK (~line 293)

**Add:**
```
  MC STRUCTURAL INVESTIGATION is the definitive answer to floor anchoring. When MC
  is active and shows CLEAN/WAVE pattern, the floor IS anchored — MC proved it by
  showing post-trigger rates have deteriorated while cumulative floor remained high.
  Do not independently diagnose anchoring when MC has already measured it.
```

### E. Update cumulative anchoring references throughout

Lines ~89, ~104, ~109, ~116, ~182, ~186 all reference "cumulative anchoring" as a risk the agent should watch for. With MC active, the agent doesn't need to GUESS about anchoring — MC has measured it.

**Add global instruction near top of prompt (~line 481):**
```
MC TRUST HIERARCHY:
When MC STRUCTURAL INVESTIGATION is active (see section below), it provides the
most current structural read in the system. MC computes rates from actual recent
possessions — it is immune to the cumulative anchoring that affects floor and XGB.
- MC CLEAN/WAVE = floor and XGB are PROVEN stale. Don't trust them over MC.
- MC NORMALIZED = floor and XGB are VALIDATED. The system tested for collapse
  and found the structural edge intact. Trust cumulative signals with confidence.
- MC not active = use standard floor/XGB/rolling window analysis as before.
```

---

## 2. Auto-Analysis Sonnet (~line 300)

The auto-analysis prompt already references cumulative anchoring as a known problem (~line 143: "WARNING: Rolling window DISAGREES with cumulative floor"). MC should appear in the context data it receives.

### Changes:

**Add MC section to formatSonnetPrompt (~line 3987):**

After the XGB section and before CLOSING, add:

```
${ctx.mcInvestigation?.active ? `
MONTE CARLO STRUCTURAL INVESTIGATION:
  Status: ${ctx.mcInvestigation.pattern || 'Active — classifying'}
  Triggered: Q${ctx.mcInvestigation.trigger_period} ${ctx.mcInvestigation.trigger_clock}
  (${ctx.mcInvestigation.ctrl_team} led by ${ctx.mcInvestigation.trigger_margin} at trigger)
  Floor at trigger: ${ctx.mcInvestigation.trigger_floor?.toFixed(2)}
  XGB at trigger: ${(ctx.mcInvestigation.trigger_xgb * 100).toFixed(0)}%
  Current MC: ${ctx.mcInvestigation.current_mc != null
    ? (ctx.mcInvestigation.current_mc * 100).toFixed(1) + '%' : 'investigating'}
  Verdicts: ${ctx.mcInvestigation.verdicts?.join(' → ') || 'none yet'}

  MC runs 500 simulations using only post-trigger possession rates. It is immune
  to cumulative anchoring. When MC and floor/XGB disagree, MC reflects current
  reality and floor/XGB reflect stale early-game data.
  CLEAN = sustained collapse. WAVE = oscillating. NORMALIZED = noise, hold.
` : ''}
```

**Add to SONNET_SYSTEM_PROMPT (~line 301) instructions:**

```
When MC STRUCTURAL INVESTIGATION is provided:
- If CLEAN: your FWP should DECREASE significantly regardless of floor. The floor
  is anchored. State this explicitly: "Floor reads ${floor} but MC post-trigger
  rates show sustained collapse — structural edge is eroding faster than
  cumulative indicators reflect."
- If WAVE: flag as risk factor in RISK section. "MC detected oscillating rates —
  structural control is contested."
- If NORMALIZED: reference as positive in NARRATIVE. "MC investigated a potential
  structural shift and cleared it — recent possession rates recovered."
- If still classifying: note in RISK section as developing situation.
```

---

## 3. Post-Game Learning Agent (post-game-agent.mjs)

### Changes:

**Update arc scoring to handle MC_COLLAPSE:**

MC_COLLAPSE should be treated like VULNERABILITY was — a confirmed structural signal. In the arc, MC_COLLAPSE appearing before an EXIT means "the system detected the collapse early." MC_COLLAPSE appearing without a subsequent EXIT means "the system detected the collapse but didn't exit."

**Add to the analysis prompt (~line 511):**

```
- MC_COLLAPSE alerts fire mechanically when the Monte Carlo structural investigation
  detects a sustained collapse (CLEAN pattern — post-trigger possession rates never
  normalized). These replace the old VULNERABILITY alerts. When evaluating an arc:
  - MC_COLLAPSE → EXIT fired → team lost: SYSTEM WORKED. The MC early warning
    was correct and the exit protected the position.
  - MC_COLLAPSE fired → NO EXIT → team lost: LEFT_HANGING failure — the system
    detected the collapse but didn't act on it fast enough.
  - MC_COLLAPSE fired → team WON: FALSE_ALARM — MC predicted collapse but the
    team recovered. This is expected ~27% of the time (72.6% precision).
  - No MC_COLLAPSE → team lost from a lead: SILENT MISS — MC didn't trigger.
    Analyze whether the PBP canary should have fired (was there a 20-possession
    window where rates deteriorated?).
```

---

## 4. Client Analysis (analyze.js)

Lower priority. The client analysis doesn't currently receive VULNERABILITY context. When MC ships:

**Add MC to the context data sent from the dashboard:**

The dashboard should send `lt.mc` state to analyze.js when requesting analysis. analyze.js adds it to the prompt the same way auto-analysis does.

This is a follow-up — the server-side auto-analysis handles the critical path. Client analysis is on-demand and less time-sensitive.

---

## Summary of All Changes

| Agent | What Changes | Priority |
|-------|-------------|----------|
| Alert Reasoning | Replace VULN WARNING → MC INVESTIGATION section | P0 |
| Alert Reasoning | Replace VULN rule → MC_COLLAPSE/WAVE/NORMALIZED rules | P0 |
| Alert Reasoning | Add MC TRUST HIERARCHY global instruction | P0 |
| Alert Reasoning | Update STRUCTURAL STRESS CHECK for MC override | P0 |
| Alert Reasoning | Update ANCHORED FLOOR CHECK for MC | P0 |
| Alert Reasoning | Update all "cumulative anchoring" diagnostic refs | P1 |
| Auto-Analysis | Add MC section to formatSonnetPrompt | P0 |
| Auto-Analysis | Add MC instructions to SONNET_SYSTEM_PROMPT | P0 |
| Post-Game Agent | Add MC_COLLAPSE to arc scoring rules | P1 |
| Client Analysis | Pass MC state, add to prompt | P2 (follow-up) |

**~85 lines of prompt changes total across all agents.**
