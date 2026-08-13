# Sleep Streak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared bedtime-reward tracker for a couple, hosted on GitHub Pages with a Google Apps Script backend that stores data and sends scheduled Gmail reminders.

**Architecture:** Static dashboard (GitHub Pages) ↔ Apps Script web app (state, reward logic, auth, email, time triggers). The reward logic is written as a pure-JS module shared by both the Node test suite and the Apps Script backend, so it is unit-tested outside Apps Script.

**Tech Stack:** Vanilla HTML/CSS/JS frontend; Google Apps Script (`Code.gs`) backend with `PropertiesService` (state), an auto-created Google Sheet (ledger), `MailApp` (email), and time-driven triggers; Node's built-in `node:test` for engine tests.

## Global Constraints

- Timezone: **America/Denver** (set in Apps Script project settings and as a script constant `TZ`).
- Bedtime deadline (human rule, self-reported): **9:30 PM**.
- Nightly payout: `min(0.25 × streak, 5.00)` USD; cap **$5.00**.
- Streak freeze: **1 per week**, refreshes **Sunday night**; using it preserves streak & pays $0; declining on a miss resets streak to 0.
- Weekly bonus: **$3.50** at Sunday-night rollover if the week's freeze was unused.
- Shared single pot & streak for both spouses.
- Frontend↔backend: **GET** for reads, **POST `Content-Type: text/plain`** for writes (avoid CORS preflight).
- All money rounded to cents (2 decimals).

---

### Task 1: Reward engine (pure JS) + Node tests

**Files:**
- Create: `backend/engine.js` (pure functions, no Apps Script globals)
- Test: `backend/engine.test.js`

**Interfaces:**
- Produces:
  - `nightlyPayout(streak) → number` — `min(0.25*streak, 5.00)`, 2dp.
  - `applyNight(state, {nightDate, result, useFreeze}) → {state, event}` — pure; `result` ∈ `'on_time'|'missed'`.
  - `applySpend(state, {amount, note, actor}) → {state, event}`.
  - `applyWeeklyRollover(state, newWeekStart) → {state, event|null}` — awards $3.50 if `!freezeUsedThisWeek`, then resets freeze flags & `weekStart`.
  - `initialState() → state`. State shape per spec §4 (minus `spreadsheetId`).
  - `round2(n) → number`.

- [ ] **Step 1: Write failing tests** in `backend/engine.test.js` using `node:test` + `node:assert`:

```js
const test = require('node:test');
const assert = require('node:assert');
const E = require('./engine');

test('payout escalates and caps at 5', () => {
  assert.equal(E.nightlyPayout(1), 0.25);
  assert.equal(E.nightlyPayout(4), 1.00);
  assert.equal(E.nightlyPayout(20), 5.00);
  assert.equal(E.nightlyPayout(40), 5.00);
});

test('on_time night increments streak and pays', () => {
  let s = E.initialState();
  ({ state: s } = E.applyNight(s, { nightDate: '2026-06-15', result: 'on_time' }));
  assert.equal(s.streak, 1);
  assert.equal(s.balance, 0.25);
});

test('missed without freeze resets streak', () => {
  let s = { ...E.initialState(), streak: 5, balance: 3.75 };
  ({ state: s } = E.applyNight(s, { nightDate: '2026-06-20', result: 'missed', useFreeze: false }));
  assert.equal(s.streak, 0);
  assert.equal(s.balance, 3.75);
});

test('missed with freeze preserves streak, pays nothing, consumes freeze', () => {
  let s = { ...E.initialState(), streak: 5, balance: 3.75, freezeAvailable: true };
  ({ state: s } = E.applyNight(s, { nightDate: '2026-06-20', result: 'missed', useFreeze: true }));
  assert.equal(s.streak, 5);
  assert.equal(s.balance, 3.75);
  assert.equal(s.freezeAvailable, false);
  assert.equal(s.freezeUsedThisWeek, true);
});

test('missed with freeze requested but none available resets', () => {
  let s = { ...E.initialState(), streak: 5, freezeAvailable: false };
  ({ state: s } = E.applyNight(s, { nightDate: '2026-06-20', result: 'missed', useFreeze: true }));
  assert.equal(s.streak, 0);
});

test('re-recording same night throws', () => {
  let s = E.initialState();
  ({ state: s } = E.applyNight(s, { nightDate: '2026-06-15', result: 'on_time' }));
  assert.throws(() => E.applyNight(s, { nightDate: '2026-06-15', result: 'on_time' }));
});

test('weekly rollover awards bonus when freeze unused', () => {
  let s = { ...E.initialState(), balance: 10, freezeUsedThisWeek: false };
  let ev;
  ({ state: s, event: ev } = E.applyWeeklyRollover(s, '2026-06-22'));
  assert.equal(s.balance, 13.50);
  assert.equal(s.freezeAvailable, true);
  assert.equal(s.freezeUsedThisWeek, false);
  assert.equal(s.weekStart, '2026-06-22');
  assert.equal(ev.type, 'weekly_bonus');
});

test('weekly rollover gives no bonus when freeze used', () => {
  let s = { ...E.initialState(), balance: 10, freezeUsedThisWeek: true };
  let ev;
  ({ state: s, event: ev } = E.applyWeeklyRollover(s, '2026-06-22'));
  assert.equal(s.balance, 10);
  assert.equal(s.freezeAvailable, true);
  assert.equal(ev, null);
});

test('spend subtracts and floors at 0', () => {
  let s = { ...E.initialState(), balance: 5 };
  ({ state: s } = E.applySpend(s, { amount: 2, note: 'ice cream', actor: 'sam' }));
  assert.equal(s.balance, 3);
  ({ state: s } = E.applySpend(s, { amount: 100, note: 'tv', actor: 'sam' }));
  assert.equal(s.balance, 0);
});
```

- [ ] **Step 2: Run, verify fail** — `cd backend && node --test`. Expected: FAIL (engine not found).
- [ ] **Step 3: Implement `backend/engine.js`** to satisfy the above. Use `module.exports` AND a guard so it can be pasted into Apps Script (`if (typeof module !== 'undefined') module.exports = {...}`). `applyNight` must set `lastRecordedDate`, build an `event` object `{type:'night', nightDate, result, freezeUsed, amount, balanceAfter, actor}`.
- [ ] **Step 4: Run, verify pass** — `cd backend && node --test`. Expected: PASS, all tests.
- [ ] **Step 5: Commit** — `git add backend/engine.js backend/engine.test.js && git commit -m "feat: reward engine with tests"`.

---

### Task 2: Apps Script backend

**Files:**
- Create: `backend/Code.gs` (router, storage, auth, email, triggers; embeds the engine)
- Create: `backend/README.md` (deploy steps)

**Interfaces:**
- Consumes: engine functions from Task 1 (pasted in / engine.js content prepended).
- Produces HTTP API (web app):
  - `GET ?action=state&token=…` → `{ok, state, ledger:[…recent], potentialTonight}`.
  - `POST {action:'requestLogin', email}` → emails magic link; `{ok}`.
  - `POST {action:'record', token|actionToken, nightDate, result, useFreeze}` → `{ok, state}`.
  - `POST {action:'spend', token, amount, note}` → `{ok, state}`.
- Trigger handlers: `sendEveningEmail()`, `sendMorningEmail()`, `weeklyRollover()`, `setup()` (creates ledger sheet, installs triggers, seeds allowlist), `runTests()`.

- [ ] **Step 1:** Write `backend/Code.gs`:
  - Constants: `TZ='America/Denver'`, `WEB_APP_URL` (filled after deploy), `DASHBOARD_URL`, `ALLOWLIST` (two emails).
  - Storage helpers: `getState()/saveState()` via `PropertiesService.getScriptProperties()` JSON; `getLedgerSheet()` (create spreadsheet on first run, store id in state); `appendLedger(event)`.
  - Engine: paste Task 1 `engine.js` body (or keep functions inline) — single source of logic.
  - Auth: `createToken(email)`, `verifyToken(token)`, `requestLogin(email)` (allowlist check + email link), per-day `signActionToken(nightDate,result)` / `verifyActionToken`.
  - Router: `doGet(e)`, `doPost(e)` parse `e.parameter`/`e.postData.contents`, dispatch, return `ContentService.createTextOutput(JSON).setMimeType(JSON)`.
  - Emails: `sendEveningEmail()` (balance, potential tonight = `nightlyPayout(streak+1)`, streak), `sendMorningEmail()` (✅/❌ links with action tokens to `DASHBOARD_URL`).
  - `weeklyRollover()` → `applyWeeklyRollover` + ledger.
  - `setup()` installs `ScriptApp.newTrigger` time triggers: evening 21:00, morning 09:00, weekly Sunday ~23:30 (TZ).
  - `runTests()` mirrors Task 1 assertions using `Logger.log`.
- [ ] **Step 2:** Write `backend/README.md` deploy steps: create Apps Script project → set TZ in Project Settings → paste `Code.gs` → edit constants (`ALLOWLIST`, `DASHBOARD_URL`) → Deploy as Web app (Execute as: me, Who has access: Anyone) → copy `/exec` URL into both `Code.gs` `WEB_APP_URL` and frontend config → run `setup()` once (authorize scopes) → verify with "Run > sendMorningEmail".
- [ ] **Step 3:** Manual verification checklist documented (cannot auto-test Apps Script here): run `runTests()` (logs PASS), trigger each email once.
- [ ] **Step 4: Commit** — `git add backend/Code.gs backend/README.md && git commit -m "feat: Apps Script backend"`.

---

### Task 3: Dashboard frontend

**Files:**
- Create: `index.html`, `css/style.css`, `js/app.js`, `js/config.js`

**Interfaces:**
- Consumes: web app API from Task 2. `js/config.js` exports `WEB_APP_URL`.

- [ ] **Step 1:** `js/config.js` — `const CONFIG = { WEB_APP_URL: 'PASTE_AFTER_DEPLOY' };`.
- [ ] **Step 2:** `index.html` — sections: header; **login** (email input → request link); **dashboard** (balance, streak, tonight's potential, freeze status pill, recent ledger table); **record** controls (date picker default=last night, ✅/❌, freeze checkbox shown on miss); **spend** form (amount + note). Hidden until authed.
- [ ] **Step 3:** `js/app.js`:
  - `api(action, body)` — GET builds query; writes use `fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({action,...body,token})})`.
  - On load: read `?token=` → save to `localStorage`, clean URL; read morning action params (`nightDate`,`result`,`actionToken`) → confirm/record flow with freeze prompt on miss.
  - `loadState()` renders; `record()`, `spend()`, `requestLogin()` handlers; money formatted `$0.00`.
- [ ] **Step 4:** `css/style.css` — clean, mobile-first, calming night palette; large tap targets for the morning links.
- [ ] **Step 5:** Manual test: open `index.html` locally with a deployed `WEB_APP_URL`, log in, record a night, spend, confirm balance updates.
- [ ] **Step 6: Commit** — `git add index.html css js && git commit -m "feat: dashboard frontend"`.

---

### Task 4: Project README + GitHub Pages

**Files:**
- Create: `README.md`, `.gitignore`

**Interfaces:** none.

- [ ] **Step 1:** `README.md` — what it is, the reward rules, architecture diagram, full setup order (deploy Apps Script first → paste URL into `js/config.js` & `Code.gs` → push → enable Pages on the `/sleepsite` path or repo), how to enable GitHub Pages, and where the site URL lands.
- [ ] **Step 2:** `.gitignore` — `node_modules/`, `.DS_Store`.
- [ ] **Step 3:** Document hosting as a subsection of the existing site (subfolder served by Pages).
- [ ] **Step 4: Commit** — `git add README.md .gitignore && git commit -m "docs: project readme and pages setup"`.

---

## Self-Review

- **Spec coverage:** §2 rules → Task 1 engine; §3 architecture → Tasks 2–3; §4 data model → Task 2 storage; §5 flows → Tasks 2 (server) & 3 (client); §6 files → all tasks; §7 testing → Task 1 (Node) + Task 2 (`runTests`/manual). Covered.
- **Placeholders:** `WEB_APP_URL`/`DASHBOARD_URL`/`ALLOWLIST` are intentional deploy-time config, documented in READMEs — not plan gaps.
- **Type consistency:** `applyNight/applySpend/applyWeeklyRollover/nightlyPayout/initialState/round2` names used identically across Tasks 1–2; state shape matches spec §4.
