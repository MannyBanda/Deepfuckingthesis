# Odds Toast — Event-Driven Refresh Spec

**Files:** `v3.html` (NBA), `wnba-bdl.html` (WNBA)
**Scope:** Client-only, inline in both HTML files. No backend.
**Depends on:** the manual team-select toast (commit d06a101).
**Author:** Claude — pending Manny go-ahead before implementation.

---

## 1. Objective

Replace the blind 10s odds poll with an **event-driven** model. Odds fetch only on deliberate actions; a 30s freshness cache prevents redundant paid-API calls when toggling/swiping; a manual refresh button forces a live pull; a display-only clock shows odds staleness.

Why: the 10s `setInterval` re-fetched (1 credit live / 10 credits historical) even when the number wasn't being looked at. Odds *do* move on single possessions in Q3–Q4 (Manny), so freshness matters — but it should be driven by the user's attention, not wall-clock.

### Locked decisions
- **Fetch policy:** deliberate "I'm now looking at this" events force a fresh pull; lateral moves (toggle, swipe) reuse a <30s cache.
- **Manual refresh button** forces a fresh pull, **bypassing** the 30s buffer.
- **Freshness indicator:** a **live 1s ticking clock** ("updated 14s ago"), display-only — rewrites a DOM text node, never fetches. Rolls to "1m+ ago" past 60s. Cleared on toast close.
- Odds are **frozen between events** on a live game (accepted tradeoff). The clock + refresh button make that legible.

### Fetch policy table

| Entry point | Function | Policy |
|---|---|---|
| Alert auto-open (toast closed) | `pollAlerts` → `fireToast` | **force** |
| Manual ⚡ open | `showToast` → `fireToast` / `_manualToastView` | **force** |
| Hint accept | `acceptToastHint` → `fireToast` | **force** |
| Manual refresh button | `refreshToastOdds` | **force** |
| Team toggle | `pickToastTeam` | **gated (30s)** |
| Card swipe | `updateToastForGame` → `fireToast`/`_manualToastView` | **gated (30s)** |
| ~~10s auto-poll~~ | ~~`startToastOddsPoll`~~ | **REMOVED** |

Rationale: the live odds response contains *all* games + *both* teams, so a <30s cache fully serves toggles and swipes between live games with zero fetch. FINAL/historical responses contain both teams, so toggling a finished game is also zero-fetch.

---

## 2. New state (both files)

```js
var _oddsCache=null;        // {url, ts, games[]} — last odds-api response
var _toastClockTimer=null;  // display-only 1s ticker for "updated Ns ago"
```

Remove: `var _toastOddsTimer=null;` (replaced by `_toastClockTimer`).

---

## 3. Design

### 3.1 Freshness-gated fetch — `_getOdds(url, force)`

Extract the network call out of `renderOddsFor`. Returns cached games if fresh & same URL, else fetches and updates the cache. The URL encodes league + (live | historical-date), so the cache key is exact: same live game/league → hit; different historical date → miss; live→final switch → miss.

```js
async function _getOdds(url, force){
  if(!force && _oddsCache && _oddsCache.url===url && (Date.now()-_oddsCache.ts)<30000){
    return _oddsCache.games;
  }
  var r=await fetch(url);
  if(!r.ok){var e=await r.json().catch(function(){return{};});console.warn('[ODDS API]',e.detail||e.error);throw new Error(e.error||'HTTP '+r.status);}
  var data=await r.json();
  if(data.credits)console.log('[ODDS API]'+(data.historical?' (historical)':'')+' rem:',data.credits.remaining,'used:',data.credits.used);
  _oddsCache={url:url, ts:Date.now(), games:(data.games||[])};
  return _oddsCache.games;
}
```

### 3.2 `renderOddsFor(g, betTeam, isHome, force)` — add `force` param

The existing URL build (live vs historical) stays. Replace the inline `fetch`/parse with `var oddsGames = await _getOdds(oddsUrl, force);`. Everything downstream (match, ML extraction, sort, row render) is unchanged. At the end:
- **live game** → show the odds bar, `startOddsClock()`.
- **FINAL game** → hide the odds bar, `stopOddsClock()` (no ticker, no refresh — re-pulling a historical snapshot costs 10 credits for identical data).

```js
async function renderOddsFor(g,betTeam,isHome,force){
  _toastView={team:betTeam,isHome:isHome};
  renderToastTeams(g,isHome);
  ... build oddsUrl (unchanged) ...
  try{
    var oddsGames=await _getOdds(oddsUrl, force);
    ... match / extract / render rows (unchanged) ...
    var bar=document.getElementById('toast-odds-bar');
    if(getState(g)!=='FINAL'){ if(bar)bar.style.display='flex'; startOddsClock(); }
    else { if(bar)bar.style.display='none'; stopOddsClock(); }
  }catch(e){ ... existing catch ... }
}
```

### 3.3 The clock (display-only, never fetches)

```js
function startOddsClock(){ stopOddsClock(); _renderOddsClock(); _toastClockTimer=setInterval(_renderOddsClock,1000); }
function stopOddsClock(){ if(_toastClockTimer){clearInterval(_toastClockTimer);_toastClockTimer=null;} }
function _renderOddsClock(){
  var el=document.getElementById('toast-odds-updated'); if(!el)return;
  if(!_oddsCache||!_oddsCache.ts){el.textContent='';return;}
  var s=Math.max(0,Math.round((Date.now()-_oddsCache.ts)/1000));
  el.textContent=s<60?('updated '+s+'s ago'):('updated '+Math.floor(s/60)+'m+ ago');
}
```

The clock reads `_oddsCache.ts`. On a gated render (toggle <30s), `ts` is unchanged so the clock keeps counting from the original pull — correct, the data *is* that old. On a forced/aged fetch, `ts` resets → clock returns to "0s ago".

### 3.4 Manual refresh button

```js
function refreshToastOdds(){
  var g=games.find(function(x){return x.id===_toastGameId;});
  if(!g||!_toastView)return;
  renderOddsFor(g,_toastView.team,_toastView.isHome,true); // force
}
```

### 3.5 Markup (between `toast-teams` and `toast-odds`)

```html
<div class="toast-odds-bar" id="toast-odds-bar" style="display:none">
  <span class="toast-odds-updated" id="toast-odds-updated"></span>
  <button class="toast-odds-refresh" id="toast-odds-refresh" onclick="refreshToastOdds()" title="Refresh odds">&#8635;</button>
</div>
```

### 3.6 CSS (mirror existing toast tokens)

```css
.toast-odds-bar{display:flex;align-items:center;justify-content:space-between;padding:0 14px 6px;}
.toast-odds-updated{font-family:var(--mono);font-size:9px;color:var(--fg-dim);}
.toast-odds-refresh{background:transparent;border:1px solid var(--hairline);border-radius:var(--r-inner);color:var(--fg-tertiary);font-size:12px;line-height:1;padding:3px 8px;cursor:pointer;}
.toast-odds-refresh:active{color:var(--green);border-color:var(--green-border);}
```

---

## 4. Per-function touch points

| Function | Change | v3 | WNBA |
|---|---|---|---|
| `renderOddsFor` | add `force` param; use `_getOdds`; show/hide bar; clock | yes | yes |
| `_getOdds` | NEW | yes | yes (`?league=wnba` in caller URL, unchanged) |
| `fetchLineShop(alert, force)` | thread `force` → `renderOddsFor` | yes | yes |
| `fireToast(alert, force=true)` | thread `force`; **drop** `startToastOddsPoll`/`stopToastOddsPoll` lines | yes | yes |
| `showToast` | manual ⚡ open → force path (default) | yes | yes |
| `_manualToastView(g,gid,force)` | thread `force` (default true for open) | yes | yes |
| `pickToastTeam` | call `renderOddsFor(...false)` (gated) | yes | yes |
| `updateToastForGame` | swipe → `fireToast(latest,false)` / `_manualToastView(g,gid,false)` (gated) | yes | yes |
| `acceptToastHint` | → `fireToast(a)` (force default) | yes | yes |
| `refreshToastOdds` | NEW | yes | yes |
| `startOddsClock`/`stopOddsClock`/`_renderOddsClock` | NEW | yes | yes |
| `dismissToast` | replace `stopToastOddsPoll()` → `stopOddsClock()` | yes | yes |
| `startToastOddsPoll`/`stopToastOddsPoll` | **DELETE** | yes | yes |
| `_startManualPollIfLive` | **DELETE** (clock now started inside `renderOddsFor`) | yes | yes |

Note: the v3/WNBA `_clientGid` difference is irrelevant here — odds logic keys off the resolved game object and URL, not the alert id mapping.

---

## 5. Dead code removed

- `startToastOddsPoll()`, `stopToastOddsPoll()`, `_toastOddsTimer` — superseded by event-driven fetch + `_toastClockTimer`.
- `_startManualPollIfLive(g)` — its only job was starting the odds poll; the clock is now started inside `renderOddsFor`. Its call sites in `showToast`/`_manualToastView` drop it.

---

## 6. Cascading implications

**1st order**
- `renderOddsFor` is now the single fetch chokepoint; all callers thread `force`. Adding a defaulted last param (`force`) is backward-safe for any caller that omits it (treated as gated) — but every caller is updated explicitly per the table.
- The clock is the only remaining timer on the toast. It is display-only; if `_oddsCache` is null it renders empty (no crash).

**2nd order**
- Cross-game cache reuse (bonus): swiping between two *live* games within 30s reuses one pull (the live response holds all games). Correct and free.
- FINAL games: no clock, no refresh button, no poll. A finished game is a one-shot 10-credit pull on open; toggling teams is zero-fetch (cache hit, both teams present). This removes the prior per-toggle 10-credit waste.
- Manual refresh forces even within 30s — so the `_oddsCache.ts` resets and the clock zeroes, giving visible confirmation the pull happened.

**3rd order**
- Credit usage now scales with user attention, not wall-clock: a live-toast session drops from ~6 calls/min indefinitely to ~1 on open + 1 per refresh/aged-toggle. The manual-select feature (which widened odds access to any game) is now bounded by the buffer.
- No interaction with the alert pipeline, agent, or server — purely client display.

---

## 7. Test plan

Syntax gate (both): `node -c` on extracted `<script>`.

| # | Setup | Action | Expect |
|---|---|---|---|
| O1 | Live game, alert fires (toast closed) | auto-open | 1 fetch; clock starts "updated 0s ago" |
| O2 | O1 open | wait 8s | clock reads ~"8s ago"; **no** new fetch (network tab) |
| O3 | O1 open, <30s since pull | toggle team | **no** fetch; opposite team renders from cache; clock keeps counting |
| O4 | O1 open, >30s since pull | toggle team | fresh fetch; clock resets to 0s |
| O5 | any live odds view | tap refresh button | fresh fetch even if <30s; clock resets to 0s |
| O6 | manual ⚡ open of live game | open | force fetch; bar + clock visible |
| O7 | toast open, swipe to another live game | swipe | gated: renders new game from cache if <30s (live response has all games), else fetch |
| O8 | FINAL game | open | one historical pull; **no** clock, **no** refresh button |
| O9 | FINAL game open | toggle team | **no** fetch (both teams cached) |
| O10 | toast open | close toast | clock stops (no leftover interval) |
| O11 | rapid toggle 5× within 30s | toggle×5 | exactly 0 fetches after the first render |
| O12 (WNBA) | live WNBA game | open + toggle + refresh | same behavior; `?league=wnba` preserved |

Regression: O1–O3 confirm the alert-driven display still renders correctly and the team-select/hint behavior from d06a101 is intact.

---

## 8. Sizing & architecture

~30–40 lines net per file (add `_getOdds` + clock trio + refresh handler + markup + CSS; delete the poll trio + `_startManualPollIfLive`). Stays inline — same rationale as the prior toast work (no module boundary in single-file dashboards). No backend.

## 9. Implementation order (on go-ahead)

1. v3: state + `_getOdds` + `renderOddsFor` rewire + clock + refresh + markup + CSS
2. v3: thread `force` through callers; delete dead poll fns; `dismissToast` swap
3. Syntax gate v3 → O1–O11
4. Port to WNBA (preserve `?league=wnba`, direct `game_id`)
5. Syntax gate WNBA → O12
6. Single commit, both files → push → deploy → confirm
