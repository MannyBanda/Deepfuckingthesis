# Odds Toast — Manual Team Selection Spec

**Files:** `v3.html` (NBA), `wnba-bdl.html` (WNBA)
**Scope:** Client-only. No backend, no DB, no new module. Inline in both HTML files.
**Author:** Claude (lead eng) — pending Manny go-ahead before implementation.

---

## 1. Objective

Let the toast shop odds for **any team in the active game, on request** — not only when an alert fires. The alert-driven display path is preserved exactly. The only addition is a home/away selector plus a session-persisted pick and a non-disruptive "new alert" hint.

### Locked behavioral model

| Event | Toast | Behavior |
|---|---|---|
| New SEND (any type incl. EXIT) | **Closed** | Auto-open, flash to alert team, **overwrite** session pick for that game |
| New SEND (any type incl. EXIT) | **Open**, same game | **Hint only** — no odds re-render, no overwrite |
| Tap ⚡ to open | — | Resolver: session pick → live alert team → control team → home (pre-tip) |
| Toggle home/away | Open | Render picked team, **write** session map |
| Swipe to new card | Open | New game's session pick → its alert → its control team |
| 10s live poll | Open | Re-render **current view**, not the alert |

EXIT is treated as a plain SEND everywhere — no special-casing. Rationale: odds-shopping is a buy tool (best line on a team you're about to back); there's nothing to shop on an exit. The exit's real-time value still fires via ntfy and the closed-toast auto-open.

---

## 2. Current architecture (why this is a one-line coupling)

`fetchLineShop(alert)` is the only odds renderer. It needs exactly three inputs:

1. **Game object** — `games.find(x => x.id === alert.game_id)` → home/away alias, market name, scheduled, state.
2. **Bet team + `isHome`** — derived solely from `betTeam = alert.floor_team || alert.control_team` (EXIT flips to opponent).
3. **Odds feed** — `odds-api` returns **all** games for the league; matching + ML extraction are client-side and already team-agnostic.

Input (2) is the entire coupling. `odds-api.js` needs **zero changes** — it is already game/team agnostic.

### Anchor map (verified)

| Symbol | v3.html | wnba-bdl.html | Notes |
|---|---|---|---|
| Toast markup | 454–466 | 455–467 | Identical |
| `ENTRY_TYPES` | 3666 | 3998 | Identical |
| `pollAlerts()` | 3675 | (parity) | Auto-open path |
| `renderToastHeader(alert)` | 3727 | 4057 | Add neutral variant |
| `fireToast(alert)` | 3765 | 4095 | |
| `fetchLineShop(alert)` | 3778 | 4108 | Split into core + wrapper |
| `showToast()` | 3888 | 4218 | Precedence resolver |
| `dismissToast()` | 3908 | 4238 | |
| `updateToastForGame(gid)` | 3916 | 4246 | Swipe handler |
| `startToastOddsPoll()` | 3933 | (parity) | Re-render current view |
| `stopToastOddsPoll()` | 3941 | (parity) | |
| Control-team source | `cardState[id]._allSnapshots[last].floor_team` | same | Pre-alert default |
| `tc()` pill color | — | white-team bug | See §7 |

Only divergence between files: odds URL is `FN+'odds-api'` (v3) vs `FN+'odds-api?league=wnba'` (wnba). Same patch, two files.

---

## 3. Design

### 3.1 New session state (in-memory only — dies on reload)

```js
var _toastPick = {};      // { [gameId]: {team, isHome} } — written ONLY on explicit toggle or closed-toast auto-open
var _toastView = null;    // {team, isHome} currently rendered — what the poll re-renders
var _toastPendingAlert = null; // alert awaiting user tap when hint is shown (open-toast case)
```

No localStorage. No cross-day pruning. Optional FINAL-clear deferred (cheap, not required).

### 3.2 Extract the renderer core

Split `fetchLineShop(alert)` into:

- **`renderOddsFor(g, betTeam, isHome)`** — everything from `var hA=...` onward (URL build, fetch, match, ML extract, sort, row render). No alert references. Sets `_toastView = {team:betTeam, isHome}` at entry.
- **`fetchLineShop(alert)`** — thin wrapper: resolve `g`, derive `betTeam`/`isHome` from alert (EXIT flip preserved), call `renderOddsFor(g, betTeam, isHome)`.

This is a pure extraction — alert path output is byte-identical.

### 3.3 Team toggle UI

Inject a pill row between `toast-game` (L464/465) and `toast-odds` (L465/466):

```html
<div class="toast-teams" id="toast-teams">
  <button class="toast-team-pill" id="toast-pill-away" onclick="pickToastTeam(false)"></button>
  <button class="toast-team-pill" id="toast-pill-home" onclick="pickToastTeam(true)"></button>
</div>
```

`renderToastTeams(g, activeIsHome)` fills pill text with aliases, colors via `tc()`, marks the active side. `pickToastTeam(isHome)`:

```js
function pickToastTeam(isHome){
  var g=games.find(x=>x.id===_toastGameId); if(!g)return;
  var team=isHome?(g.home?.alias):(g.away?.alias);
  _toastPick[_toastGameId]={team:team,isHome:isHome};   // session write
  renderToastTeams(g,isHome);
  renderNeutralHeader(g,team,isHome);                    // header goes neutral (see 3.5)
  renderOddsFor(g,team,isHome);
}
```

### 3.4 "New alert" hint

A dismissible strip shown when a SEND arrives for the game whose toast is already open. Inject after `toast-head`:

```html
<div class="toast-hint" id="toast-hint" style="display:none" onclick="acceptToastHint()"></div>
```

`acceptToastHint()` → `fireToast(_toastPendingAlert)` (full alert render), clears hint + pending. Hint text e.g. `New signal: BUY LAL · tap to view`.

### 3.5 Header neutral variant

`renderToastHeader(alert)` stays as-is for the alert path. Add `renderNeutralHeader(g, team, isHome)`:
- label = "Odds", dot/border = neutral (not green/amber)
- alert-info = matchup `AWAY@HOME`
- game line = `{team} odds` (no margin/floor metadata, since none applies)

When toggling **back** to the alert's own team while an alert is active, re-call `renderToastHeader(_toastAlert)` to restore the signal header.

### 3.6 Open resolver (`showToast` rewrite)

```
1. session pick exists for activeGameId  → renderNeutralHeader + renderOddsFor(pick)
2. else live SEND alert for activeGameId → fireToast(alert)   [unchanged path]
3. else control team (latest snap floor_team for active game) → neutral + renderOddsFor
4. else home alias (pre-tip, no snapshot)                     → neutral + renderOddsFor
```

The "No Alerts" dead-end branch is **removed** — every open now resolves to a renderable team.

### 3.7 Auto-open + hint (`pollAlerts` / `fireToast`)

In `pollAlerts`, when a new SEND is detected for a game (existing `newSend` logic):
- **toast closed** (`!_toastVisible`) → `fireToast(newSend)` as today, **plus** stamp `_toastPick[gid]={alert team}` (overwrite).
- **toast open, same game** → set `_toastPendingAlert=newSend`, show hint. **Do not** call `fireToast`, do not re-render odds, do not touch `_toastPick`.
- **toast open, different game** → unchanged (no auto-switch; existing behavior leaves current game in view).

### 3.8 Poll + swipe rewiring

- `startToastOddsPoll()` interval re-renders **`_toastView`**, not `_toastAlert`:
  `if(_toastVisible && _toastView) renderOddsFor(g, _toastView.team, _toastView.isHome); else stopToastOddsPoll();`
- `updateToastForGame(gid)` (swipe, fired at v3 L981) consults resolver order: session pick for new gid → its alert → its control team. Replaces current alert-only lookup.

---

## 4. Cascading implications

**1st order**
- `_toastAlert` is no longer the sole render driver; `_toastView` is. `_toastAlert` is retained only for (a) the active alert header and (b) hint-accept. Every read of `_toastAlert` in the poll path is replaced by `_toastView`.
- `fetchLineShop` callers: `fireToast` (3771/4101) and the old poll. Both rerouted — `fireToast` still calls `fetchLineShop(alert)`; poll now calls `renderOddsFor`.

**2nd order**
- Dedup/seen sets (`_seenAlertIds`, `_dismissedAlertIds`) are untouched. A hint does **not** mark the alert seen-for-toast in a way that suppresses the closed-toast auto-open later — but since the alert is already in `_seenAlertIds` once polled, re-open uses the resolver (session pick wins), which is correct.
- Swiping to a FINAL game: resolver still resolves a team (control/home) and `renderOddsFor` hits the historical odds path (FINAL branch already in the renderer). Live poll is correctly **not** started for FINAL (guard already exists in `fireToast`; replicate guard in manual open).

**3rd order**
- Multiple rapid alerts while open → only the hint updates (latest pending). No odds thrash. This is the explicit anti-whip goal.
- Session pick above alert on manual open is the **one** intentional softening of "alert display unchanged" — confirmed acceptable. Auto-open (closed) still overwrites, so a deliberately-chosen pick only persists across a live alert if the user was watching and declined the hint.

---

## 5. Dead code / cleanup

- **Remove** the "No Alerts" placeholder branch in `showToast()` (L3899–3905 / 4229–4235) — superseded by resolver step 3/4.
- `_latestSendAlert` global: still used for the badge + the `showToast` step-2 fallback. **Keep.**
- No other dead code introduced. The extraction leaves `fetchLineShop` smaller; no orphaned helpers.

---

## 6. CSS

New classes mirror existing `.toast-*` tokens (no new variables): `.toast-teams` (flex row, gap), `.toast-team-pill` (mono, border, active state uses team color + faint bg), `.toast-hint` (small green strip, tap affordance). ~12 lines each file. No change to existing toast CSS.

---

## 7. Related flag — WNBA `tc()` white-team bug

The toggle pills color via `tc()`. In `wnba-bdl.html`, `tc()` (~L495) doesn't normalize through `ESPN_ALIAS_MAP`, so 7 teams (NYL/GSV/WAS/LVA/LAS/PDX/TOY) render **white**. This feature surfaces the bug on the pills. It's the standing one-line backlog item. **Decision needed:** bundle the `tc()` fix into this commit, or ship pills with the known white-render and fix separately. (Recommend bundle — it's one line and this is the feature that exposes it.)

---

## 8. Test plan

Per testing-ownership: ship with the spec. Manual + scripted where feasible.

**Syntax gate (both files):**
`sed -n '/<script>/,/<\/script>/p' FILE | sed '1d;$d' > /tmp/check.js && node -c /tmp/check.js`

**Behavioral matrix (demo mode + live):**

| # | Setup | Action | Expect |
|---|---|---|---|
| T1 | Game with live BUY, toast closed | new SEND polls in | auto-open, alert team, `_toastPick` stamped |
| T2 | Toast open on alert team | new SEND same game | hint shows; odds unchanged; pick unchanged |
| T3 | T2 state | tap hint | full alert render, hint clears |
| T4 | Alert showing | toggle to opponent | neutral header, opponent odds, pick written |
| T5 | T4 state | wait 10s poll | still opponent odds (no snap-back) |
| T6 | T4 state | toggle back to alert team | signal header restored |
| T7 | No-alert live game | tap ⚡ | control team odds, neutral header |
| T8 | T7 + toggled to away | close, reopen ⚡ | away odds (session pick survives) |
| T9 | T8 state | reload page | back to control-team default (session cleared) |
| T10 | Toast open, pick set | swipe to other card | new game resolves own pick/alert/control |
| T11 | Pre-tip game (no snapshot) | tap ⚡ | home team odds, no crash |
| T12 | FINAL game | tap ⚡ + toggle | historical odds both teams; no live poll started |
| T13 (WNBA) | Game w/ GSV or NYL | open toast | pills colored correctly (post tc() fix) |

**Regression guard:** T1–T3 prove the alert path is unchanged. If any alert-path test diverges from current prod behavior, the extraction (§3.2) leaked.

---

## 9. Sizing & architecture call

~70–100 lines per file: state (3) + `renderOddsFor` extraction (mechanical) + 2 small UI blocks + `pickToastTeam`/`renderToastTeams`/`acceptToastHint`/`renderNeutralHeader` + resolver rewrite + poll/swipe rewiring + CSS.

**Architecture:** stays inline. Single-file dashboards have no module boundary to extract to, and the toast logic is already wholly inline. Extracting a shared toast module across two HTML files is a larger refactor with its own risk and is out of scope. No silent-debt concern at this size.

---

## 10. Implementation order (on go-ahead)

1. v3.html: state + CSS + markup + `renderOddsFor` extraction
2. v3.html: resolver + UI handlers + header variant
3. v3.html: poll/swipe/pollAlerts rewiring + dead-branch removal
4. Syntax gate v3 → behavioral matrix T1–T12
5. Port 1–3 to wnba-bdl.html (+ `?league=wnba` preserved) + optional `tc()` fix
6. Syntax gate wnba → matrix incl. T13
7. Single descriptive commit, both files staged together → push → Netlify deploy → confirm
