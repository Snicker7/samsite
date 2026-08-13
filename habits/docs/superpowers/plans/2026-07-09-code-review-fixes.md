# Code-Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding from the 2026-07-09 code review: the weekly check-up email bug, missing locking, client-supplied period keys, repeated ledger reads, UX gaps (miss confirm, record-date label, redundant check-ups, unarchive, table headers), engine↔Code.gs mirroring, dead code, and token accumulation.

**Architecture:** `backend/Code.gs` becomes a **generated file**, built by concatenating `backend/main.gs` (Apps Script glue: config, storage, router, emails) with `backend/engine.js` (pure, node-tested reward logic). All fixes then land in exactly one source file each. New testable logic (email day-of-week gates) goes in `engine.js`; Apps-Script-only fixes (locks, storage, router) go in `main.gs`; UX fixes go in `index.html` / `js/app.js` / `css/style.css`.

**Tech Stack:** Google Apps Script (ES5 in `.gs` files), vanilla JS frontend, `node --test` for the engine, plain Node script for the build.

## Global Constraints

- **NEVER run `git commit` or `git push`** — the user commits themselves. Each task ends with a "checkpoint" step that lists the files ready for the user to commit, then STOP and wait.
- All `.gs` code is **ES5** (`var`, no arrow functions, no template literals) — match the existing style.
- After Task 1, **never edit `backend/Code.gs` directly**. Edit `main.gs`/`engine.js`, then run `node backend/build.js`.
- `cd backend && node --test` must pass at the end of every task.
- Working directory for all paths below: `/mnt/c/Users/Snic9/samsite/sleepsite`.
- The pending miss-penalty/floor feature (spec `docs/superpowers/specs/2026-07-08-configurable-miss-penalty-and-floor-design.md`) is **out of scope** — do not implement it here.

---

### Task 1: Build pipeline — Code.gs generated from main.gs + engine.js

**Files:**
- Create: `backend/main.gs` (extracted from `Code.gs`)
- Create: `backend/build.js`
- Regenerate: `backend/Code.gs`
- Modify: `README.md` ("Changing the rules" section), `backend/README.md`

**Interfaces:**
- Consumes: current `backend/Code.gs` (lines 14–32 = CONFIG, lines 34–239 = engine mirror, lines 241–end = glue), current `backend/engine.js`.
- Produces: `node backend/build.js` writes `backend/Code.gs` = banner + `main.gs` + `engine.js`. Every later task edits `main.gs` or `engine.js` and reruns the build.

- [x] **Step 1: Create `backend/main.gs`**

Copy from the current `backend/Code.gs`:
- the CONFIG section (from `var TZ = 'America/Denver';` through the `var SECRET = …` line, including their comment banners), then
- everything from the `// DATE HELPERS (all in TZ)` section banner to the end of the file (`runTests` inclusive).

Do **not** copy the engine mirror (the section from the `// REWARD ENGINE (mirror of engine.js …)` banner through `validateCategory` and its closing `}` — i.e., `round2`, `payout`, `isoWeek`, `periodKeyFor`, `initialCatState`, `applyEntry`, `applyRefresh`, `applySpend`, `applyDeposit`, `runningBalanceRows`, `deriveWallet`, `slugify`, `num`, `isWholeHour`, `normalizeCategory`, `validateCategory`). Those come from `engine.js` at build time.

Put this banner at the very top of `main.gs`:

```js
/**
 * Habit Builder — Apps Script glue (config, storage, HTTP router, emails).
 *
 * The reward rules live in engine.js (unit-tested with `node --test`).
 * Code.gs is GENERATED from main.gs + engine.js by `node build.js` —
 * edit those two files, never Code.gs.
 */
```

- [x] **Step 2: Create `backend/build.js`**

```js
#!/usr/bin/env node
/** Builds Code.gs from main.gs + engine.js. Run after editing either. */
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const banner = [
  '/**',
  ' * Habit Builder — Google Apps Script backend.',
  ' *',
  ' * GENERATED FILE — do not edit directly.',
  ' * Edit backend/main.gs (Apps Script glue) or backend/engine.js (reward',
  ' * logic, unit-tested), then run:  node backend/build.js',
  ' * Deploy: paste this whole file into the Apps Script editor.',
  ' */',
  '',
  '',
].join('\n');

const out = banner + read('main.gs') + '\n' + read('engine.js');
fs.writeFileSync(path.join(__dirname, 'Code.gs'), out);
console.log('Wrote Code.gs (' + out.length + ' chars)');
```

(The `module.exports` guard at the bottom of `engine.js` is already a documented no-op inside Apps Script, so it is safe to include verbatim.)

- [x] **Step 3: Run the build**

Run: `node backend/build.js`
Expected: `Wrote Code.gs (…… chars)`

- [x] **Step 4: Verify the generated file**

Run:
```bash
grep -c "function applyEntry" backend/Code.gs   # expect 1
grep -c "function doGet" backend/Code.gs        # expect 1
grep -c "function payout" backend/Code.gs       # expect 1
grep -c "GENERATED FILE" backend/Code.gs        # expect 1
cd backend && node --test
```
Expected: counts exactly as commented; all engine tests pass. If any function count is 2, the engine mirror was left inside `main.gs` — remove it.

- [x] **Step 5: Update the READMEs**

In `README.md`, replace the "Changing the rules" paragraph's mirroring instruction ("Then mirror the change into `backend/Code.gs` …") with:

```markdown
Then regenerate the deployable file (never edit `Code.gs` by hand):

​```bash
node backend/build.js
​```

and paste the new `backend/Code.gs` into the Apps Script editor.
```

Also update the project-layout tree in `README.md` to list `backend/main.gs` ("Apps Script glue — source") and mark `Code.gs` as "generated — paste into Apps Script". In `backend/README.md`, add one line near the top: "`Code.gs` is generated by `node build.js` from `main.gs` + `engine.js` — edit those instead."

- [x] **Step 6: Checkpoint — ready for user commit**

Files: `backend/main.gs`, `backend/build.js`, `backend/Code.gs`, `README.md`, `backend/README.md`. Tell the user this is a pure restructuring (no behavior change) and STOP for their commit.

---

### Task 2: Engine — day-of-week email gates (TDD)

**Files:**
- Modify: `backend/engine.js` (new functions + exports)
- Test: `backend/engine.test.js`
- Regenerate: `backend/Code.gs`

**Interfaces:**
- Produces: `shouldSendReminder(cat, dow)` and `shouldSendCheckup(cat, dow)` — `cat` is a category object (only `cadence` is read), `dow` is ISO day-of-week `1=Mon … 7=Sun`, returns boolean. Task 5 wires these into `emailDispatch`.

- [x] **Step 1: Write the failing tests**

Append to `backend/engine.test.js`:

```js
// Review fix: weekly categories were emailed every day, and a mid-week
// check-up recorded the still-open week. Gates: reminder Sunday, checkup Monday.

test('daily categories send reminders and checkups every day', () => {
  const daily = { cadence: 'daily' };
  for (let dow = 1; dow <= 7; dow++) {
    assert.strictEqual(E.shouldSendReminder(daily, dow), true);
    assert.strictEqual(E.shouldSendCheckup(daily, dow), true);
  }
});

test('weekly categories: reminder only on Sunday (7), checkup only on Monday (1)', () => {
  const weekly = { cadence: 'weekly' };
  for (let dow = 1; dow <= 7; dow++) {
    assert.strictEqual(E.shouldSendReminder(weekly, dow), dow === 7);
    assert.strictEqual(E.shouldSendCheckup(weekly, dow), dow === 1);
  }
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test`
Expected: the two new tests FAIL with `E.shouldSendReminder is not a function`.

- [x] **Step 3: Implement in `backend/engine.js`**

Insert after `periodKeyFor` (keep ES5 style):

```js
/**
 * Email day-of-week gates (dow: 1=Mon..7=Sun, ISO).
 * Weekly categories get one reminder (Sunday, last day of the ISO week) and
 * one check-up (Monday, right after the week closes). Daily: every day.
 * Sending a weekly check-up mid-week would record the still-open week.
 */
function shouldSendReminder(cat, dow) {
  return cat.cadence !== 'weekly' || dow === 7;
}
function shouldSendCheckup(cat, dow) {
  return cat.cadence !== 'weekly' || dow === 1;
}
```

Add to the `module.exports` block:

```js
    shouldSendReminder: shouldSendReminder,
    shouldSendCheckup: shouldSendCheckup,
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test`
Expected: ALL PASS.

- [x] **Step 5: Rebuild**

Run: `node backend/build.js && grep -c "function shouldSendCheckup" backend/Code.gs`
Expected: build succeeds; grep prints `1`.

- [x] **Step 6: Checkpoint — ready for user commit**

Files: `backend/engine.js`, `backend/engine.test.js`, `backend/Code.gs`. STOP for user commit.

---

### Task 3: Server-computed periodKey (backend + frontend)

**Files:**
- Modify: `backend/main.gs` (`doRecord`, `catPublic`)
- Modify: `js/app.js` (remove client date math; show record target)
- Regenerate: `backend/Code.gs`

**Interfaces:**
- Consumes: `periodKeyFor(cadence, dateStr)`, `yesterdayStr()` (both already exist).
- Produces: `catPublic` gains `nextPeriodKey` (string, the just-closed period the record buttons will write). Task 6 must preserve this field; Task 7's card label reads `c.nextPeriodKey`.

- [x] **Step 1: Backend — `doRecord` ignores the client key on the token path**

In `backend/main.gs`, replace the top of `doRecord` (everything before `if (ALLOWLIST.indexOf(person) === -1)`) with:

```js
function doRecord(p) {
  var categoryId = p.categoryId;
  var result = p.result;
  var cat = categoryById(categoryId);
  if (!cat) return { ok: false, error: 'unknown category' };
  var person, periodKey;
  var loginEmail = verifyToken(p.token);
  if (loginEmail) {
    person = loginEmail;
    // Dashboard path: the SERVER decides which period is being recorded
    // (the just-closed one, in TZ), so device clocks/timezones can't skew
    // entries and arbitrary keys can't inflate streaks.
    periodKey = periodKeyFor(cat.cadence, yesterdayStr());
  } else {
    person = (p.person || '').trim().toLowerCase();
    periodKey = p.periodKey; // signed email links carry a server-issued key
    if (!verifyActionSig(person, categoryId, periodKey, result, p.sig)) {
      return { ok: false, error: 'not authorized' };
    }
  }
```

The rest of the function (`ALLOWLIST` check onward) is unchanged — it already uses the local `periodKey` variable.

- [x] **Step 2: Backend — expose the record target in `catPublic`**

Add one field to the object returned by `catPublic` in `backend/main.gs`:

```js
    potential: payout(cat, s.streak + 1),
    nextPeriodKey: periodKeyFor(cat.cadence, yesterdayStr()),
```

- [x] **Step 3: Frontend — drop client date math, label the record target**

In `js/app.js`:

1. Delete the now-dead helpers: `isoDate`, `yesterdayIso`, `isoWeekClient`, `lastPeriodKey`, and the `CAT_CADENCE` variable (keep `CAT_LIST`). Also delete the `CAT_CADENCE[c.id] = c.cadence;` line in `renderCatCards`.
2. In `recordCat`, stop sending `periodKey`:

```js
    const r = await api('record', { categoryId, result });
```

3. In `renderCatCards`, replace the bottom muted line of the card template with one that names the period the buttons will record:

```js
      '<p class="muted">' + (c.cadence === 'weekly' ? 'Weekly' : 'Daily') +
      ' • records ' + (c.nextPeriodKey || '—') + ' • last: ' + (c.lastRecordedKey || '—') + '</p>';
```

- [x] **Step 4: Verify**

Run: `node backend/build.js && cd backend && node --test`
Expected: build OK, ALL PASS.
Run: `grep -n "isoWeekClient\|lastPeriodKey\|CAT_CADENCE\|yesterdayIso" js/app.js`
Expected: no matches.

- [x] **Step 5: Checkpoint — ready for user commit**

Files: `backend/main.gs`, `backend/Code.gs`, `js/app.js`. Note for the user: after this lands, the deployed backend and frontend should be updated together (old frontend + new backend still works — the extra `periodKey` param is simply ignored). STOP for user commit.

---

### Task 4: LockService, token cleanup, dead code

**Files:**
- Modify: `backend/main.gs`
- Regenerate: `backend/Code.gs`

**Interfaces:**
- Produces: `withLock(fn)` — acquires the script lock, runs `fn`, always releases; returns `fn()`'s result. **Never nest `withLock` calls** (Apps Script locks are not reentrant). Used by `route` here, by `emailDispatch` in Task 5, and by `stateResponse` in Task 6. Also `cleanupTokens()` (called from `emailDispatch` in Task 5's rewrite; wire a temporary call here).

- [x] **Step 1: Add `withLock` and `cleanupTokens` to `backend/main.gs`**

Insert above the HTTP ROUTER section:

```js
// ─────────────────────────────────────────────────────────────────────────
// CONCURRENCY + HOUSEKEEPING
// ─────────────────────────────────────────────────────────────────────────
// Serializes read-modify-write sections (states blob, ledger rows) so two
// simultaneous requests can't double-record or clobber each other's saves.
// NOTE: not reentrant — never call withLock inside withLock.
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Login tokens live 90 days; expired ones were only deleted if someone tried
// to use them. Sweep hourly so Script Properties don't accumulate forever.
function cleanupTokens() {
  var all = props().getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('token:') !== 0) return;
    try {
      var t = JSON.parse(all[k]);
      if (t.expires < Date.now()) props().deleteProperty(k);
    } catch (e) {
      props().deleteProperty(k); // unparseable token record — junk
    }
  });
}
```

- [x] **Step 2: Wrap every mutating action in `route`**

Replace `route` in `backend/main.gs` with:

```js
function route(p) {
  switch (p.action) {
    case 'requestLogin': return requestLogin(p.email);
    case 'state': return stateResponse(requireUser(p));
    case 'record': return withLock(function () { return doRecord(p); });
    case 'spend': return withLock(function () { return doSpend(p); });
    case 'deposit': return withLock(function () { return doDeposit(p); });
    case 'deleteEntry': return withLock(function () { return doDeleteEntry(p); });
    case 'listCategories': return doListCategories(p);
    case 'saveCategory': return withLock(function () { return doSaveCategory(p); });
    case 'archiveCategory': return withLock(function () { return doArchiveCategory(p); });
    default: return { ok: true, name: 'Habit Builder API' };
  }
}
```

- [x] **Step 3: Call `cleanupTokens` from the hourly trigger**

Add `cleanupTokens();` as the first line of `emailDispatch` (Task 5 rewrites this function and keeps the call).

- [x] **Step 4: Remove dead code**

Still in `backend/main.gs`:

1. Delete the entire unused `personRecord` function.
2. Wallets are ledger-derived now, so drop the legacy `balance` field: in `catStateOf` and `saveCatState`, change both occurrences of `m[email] = { balance: 0, cats: {} };` to `m[email] = { cats: {} };`.
3. Update the storage comment above `statesAll` to:

```js
// states[email] = { cats: { [catId]: catState } }
// (older blobs may carry a leftover `balance` field — ignored; wallets are
//  derived from the ledger)
```

- [x] **Step 5: Verify**

Run: `node backend/build.js && cd backend && node --test`
Expected: build OK, ALL PASS.
Run: `grep -c "personRecord\|balance: 0" backend/main.gs`
Expected: `0`.

- [x] **Step 6: Checkpoint — ready for user commit**

Files: `backend/main.gs`, `backend/Code.gs`. STOP for user commit.

---

### Task 5: Email dispatch — weekly gates + skip answered check-ups

**Files:**
- Modify: `backend/main.gs` (`emailDispatch`, `sendCheckup`)
- Regenerate: `backend/Code.gs`

**Interfaces:**
- Consumes: `shouldSendReminder` / `shouldSendCheckup` (Task 2), `withLock` / `cleanupTokens` (Task 4).

- [x] **Step 1: Rewrite `emailDispatch`**

Replace it in `backend/main.gs` with:

```js
// Runs hourly. Sends reminders + check-ups for categories scheduled this hour,
// and performs freeze/bonus refresh when a category's period has rolled over.
// Weekly categories are gated to one reminder (Sun) + one check-up (Mon) —
// a mid-week check-up would record the still-open week.
function emailDispatch() {
  cleanupTokens();
  var hour = currentHourStr();
  var dow = parseInt(Utilities.formatDate(new Date(), TZ, 'u'), 10); // 1=Mon..7=Sun
  var cats = activeCategories();
  withLock(function () {
    cats.forEach(maybeRefresh);
  });
  cats.forEach(function (cat) {
    if (cat.reminderTime && cat.reminderTime === hour && shouldSendReminder(cat, dow)) sendReminder(cat);
    if (cat.checkupTime && cat.checkupTime === hour && shouldSendCheckup(cat, dow)) sendCheckup(cat);
  });
}
```

- [x] **Step 2: Skip check-ups that were already answered**

In `sendCheckup`, add two lines at the top of the per-recipient loop:

```js
  ALLOWLIST.forEach(function (to) {
    var s = catStateOf(to, cat.id, cat);
    if (s.lastRecordedKey === periodKey) return; // already recorded — no nag
```

(The rest of the loop body is unchanged; `s` is new — the loop previously didn't read state.)

- [x] **Step 3: Verify**

Run: `node backend/build.js && cd backend && node --test`
Expected: build OK, ALL PASS.
Run: `grep -n "shouldSendReminder\|shouldSendCheckup" backend/main.gs`
Expected: exactly the two call sites in `emailDispatch` (definitions live in `engine.js`).

- [x] **Step 4: Checkpoint — ready for user commit**

Files: `backend/main.gs`, `backend/Code.gs`. STOP for user commit.

---

### Task 6: One ledger read per request

**Files:**
- Modify: `backend/main.gs` (`stateResponse`, `recentLedger` → `recentLedgerFromRows`, new `ensureCatStates` + `catPublicFromState`, `doDeposit`)
- Regenerate: `backend/Code.gs`

**Interfaces:**
- Consumes: `withLock` (Task 4); `deriveWallet(rows, actor)`, `runningBalanceRows(rows, actor)` (engine).
- Produces: `recentLedgerFromRows(rows, email, n)` (same output as old `recentLedger` but takes pre-read rows); `catPublicFromState(cat, s)` (same shape as `catPublic`, **including `nextPeriodKey`** from Task 3); `ensureCatStates(m, email, cats)` → boolean "added any". `catPublic(email, cat)` remains as a thin wrapper (still used by `doRecord`).

- [x] **Step 1: Convert `recentLedger` to take pre-read rows**

Replace it in `backend/main.gs` with (only the first two lines change — no internal `readLedgerRows` call):

```js
function recentLedgerFromRows(rows, email, n) {
  var mine = runningBalanceRows(rows, email); // each carries correct balanceAfter
  mine = mine.slice(Math.max(0, mine.length - n));
  return mine.reverse().map(function (r) {
    return {
      id: r.id,
      timestamp: r.timestamp ? Utilities.formatDate(new Date(r.timestamp), TZ, 'yyyy-MM-dd HH:mm') : '',
      type: r.type, category: r.category, periodKey: r.periodKey, result: r.result,
      freezeUsed: r.freezeUsed, amount: r.amount, balanceAfter: r.balanceAfter,
      actor: r.actor, note: r.note,
    };
  });
}
```

- [x] **Step 2: Split `catPublic` and batch the states blob**

Replace `catPublic` with:

```js
// Make sure m[email].cats has a state for every cat; returns true if it added any.
function ensureCatStates(m, email, cats) {
  if (!m[email]) m[email] = { cats: {} };
  if (!m[email].cats) m[email].cats = {};
  var added = false;
  cats.forEach(function (cat) {
    if (!m[email].cats[cat.id]) {
      m[email].cats[cat.id] = initialCatState(cat, currentPeriodStart(cat));
      added = true;
    }
  });
  return added;
}
function catPublicFromState(cat, s) {
  return {
    id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
    streak: s.streak, freezeAvailable: s.freezeAvailable,
    lastRecordedKey: s.lastRecordedKey,
    potential: payout(cat, s.streak + 1),
    nextPeriodKey: periodKeyFor(cat.cadence, yesterdayStr()),
  };
}
function catPublic(email, cat) {
  return catPublicFromState(cat, catStateOf(email, cat.id, cat));
}
```

- [x] **Step 3: Rewrite `stateResponse` — one ledger read, one states read**

```js
function stateResponse(email) {
  var rows = readLedgerRows(); // ONE sheet read serves both wallets + the ledger panel
  var active = activeCategories();
  var m = statesAll();
  if (ensureCatStates(m, email, active)) {
    // Rare path (first sight of a new category): re-read under the lock so a
    // concurrent mutation isn't clobbered by this save.
    withLock(function () {
      m = statesAll();
      ensureCatStates(m, email, active);
      saveStatesAll(m);
    });
  }
  var cats = active.map(function (c) { return catPublicFromState(c, m[email].cats[c.id]); });
  var resp = {
    ok: true, user: email, name: displayName(email),
    wallet: deriveWallet(rows, email), cats: cats,
    ledger: recentLedgerFromRows(rows, email, 20),
  };
  var pe = partnerOf(email);
  if (pe) resp.partner = { name: displayName(pe), wallet: deriveWallet(rows, pe) };
  return resp;
}
```

- [x] **Step 4: `doDeposit` — one read instead of three**

```js
// Add-money: credit BOTH allowlisted people the FULL amount each.
function doDeposit(p) {
  var email = requireUser(p); // must be logged in to initiate
  var amount = Number(p.amount);
  var note = p.note || '';
  if (!(amount > 0)) return { ok: false, error: 'amount must be positive' };
  var rows = readLedgerRows();
  var walletAfter = 0;
  ALLOWLIST.forEach(function (person) {
    var out = applyDeposit(deriveWallet(rows, person), { amount: amount, note: note, actor: person });
    appendLedger(out.event);
    if (person === email) walletAfter = out.balance;
  });
  return { ok: true, wallet: walletAfter };
}
```

- [x] **Step 5: Verify**

Run: `node backend/build.js && cd backend && node --test`
Expected: build OK, ALL PASS.
Run: `grep -n "recentLedger\b" backend/main.gs`
Expected: no remaining callers of the old name (only `recentLedgerFromRows`).
Also check: `grep -c "readLedgerRows" backend/main.gs` should show calls only in `stateResponse`, `doRecord`'s `walletOf`, `doSpend`'s `walletOf`, `doDeposit`, `doDeleteEntry` (i.e., one read per request path).

- [x] **Step 6: Checkpoint — ready for user commit**

Files: `backend/main.gs`, `backend/Code.gs`. STOP for user commit.

---

### Task 7: Frontend UX — miss confirm, instant wallet, unarchive, headers

**Files:**
- Modify: `backend/main.gs` (new `unarchiveCategory` action)
- Modify: `js/app.js`, `index.html`, `css/style.css`
- Regenerate: `backend/Code.gs`

**Interfaces:**
- Consumes: `withLock` (Task 4), `c.nextPeriodKey` (Task 3), `r.wallet` returned by `record`/`spend`/`deposit`/`deleteEntry`.
- Produces: backend action `unarchiveCategory` (params: `token`, `categoryId`) → `{ ok, categories }`.

- [x] **Step 1: Backend — `unarchiveCategory`**

In `backend/main.gs`, add below `doArchiveCategory`:

```js
function doUnarchiveCategory(p) {
  requireUser(p);
  var id = p.categoryId;
  var list = categoriesAll();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].active = true;
  saveCategories(list);
  return { ok: true, categories: list };
}
```

And add the route case (with the others, before `default`):

```js
    case 'unarchiveCategory': return withLock(function () { return doUnarchiveCategory(p); });
```

Run `node backend/build.js`.

- [x] **Step 2: Frontend — confirm before recording a miss**

In `js/app.js`, at the top of `recordCat` (before the banner line):

```js
async function recordCat(categoryId, result, label) {
  if (result === 'missed' &&
      !window.confirm('Record a miss for "' + (label || 'this habit') + '"? ' +
        'A freeze is used automatically if you have one; otherwise your streak takes the hit.')) {
    return;
  }
  banner('Saving…', false);
```

- [x] **Step 3: Frontend — instant wallet updates**

The backend already returns the new wallet on every mutation; show it immediately instead of waiting ~1–2s for the dashboard refetch. Insert `if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);` right after each `if (!r.ok) …` guard in these four places (keep the existing `showDashboard()` calls — they refresh the ledger panel):

- `recordCat` (before the result-banner if/else)
- the `spendForm` submit handler
- the `addForm` submit handler
- `deleteEntry` (before `banner('Entry removed.', false);`)

- [x] **Step 4: Frontend — unarchive button**

In `renderCatList` in `js/app.js`, replace the actions cell so archived rows get an unarchive button:

```js
      '<td><button class="link-btn" data-edit="' + c.id + '">edit</button> ' +
      (c.active
        ? '<button class="link-btn" data-arch="' + c.id + '">archive</button>'
        : '<button class="link-btn" data-unarch="' + c.id + '">unarchive</button>') + '</td>';
```

Generalize the archive helper (replace `archiveCat`) and wire both button kinds:

```js
async function setCatActive(id, action) { // 'archiveCategory' | 'unarchiveCategory'
  try {
    const r = await api(action, { categoryId: id });
    if (!r.ok) { banner(r.error || 'Could not update', true); return; }
    if (!Array.isArray(r.categories)) { banner(STALE_BACKEND_MSG, true); return; }
    renderCatList(r.categories);
  } catch (err) { banner(err.message, true); }
}
```

```js
  body.querySelectorAll('button[data-arch]').forEach((b) =>
    b.addEventListener('click', () => setCatActive(b.getAttribute('data-arch'), 'archiveCategory')));
  body.querySelectorAll('button[data-unarch]').forEach((b) =>
    b.addEventListener('click', () => setCatActive(b.getAttribute('data-unarch'), 'unarchiveCategory')));
```

- [x] **Step 5: Table headers**

In `index.html`, give both tables a `<thead>`:

```html
<table id="ledger" class="ledger">
  <thead><tr><th>Date</th><th>Activity</th><th class="amt">Amount</th><th class="bal">Balance</th><th></th></tr></thead>
  <tbody></tbody>
</table>
```

```html
<table id="catList" class="ledger">
  <thead><tr><th>Name</th><th>Cadence</th><th></th></tr></thead>
  <tbody></tbody>
</table>
```

In `css/style.css`, add after the `.ledger td` rules (the existing `.ledger .amt` / `.ledger .bal` right-alignment already applies to the `th` cells via their classes):

```css
.ledger th {
  padding: 6px;
  text-align: left;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
```

- [x] **Step 6: Verify**

Run: `node backend/build.js && cd backend && node --test`
Expected: build OK, ALL PASS.
Open `index.html` served locally (`python3 -m http.server` from `sleepsite/`) and confirm: login view renders, tables show headers, no console errors (API calls will fail against the placeholder config — that's expected; we're checking for JS syntax/reference errors only).

- [x] **Step 7: Checkpoint — ready for user commit**

Files: `backend/main.gs`, `backend/Code.gs`, `js/app.js`, `index.html`, `css/style.css`. STOP for user commit.

---

### Task 8: End-to-end verification + deployment handoff

**Files:** none (verification only)

- [x] **Step 1: Full local verification**

```bash
cd backend && node --test          # all engine tests pass
node build.js                      # regenerate one last time
git -C .. status                   # confirm only intended files changed
grep -c "function " Code.gs        # sanity: file is intact, non-empty
```
Expected: ALL PASS; `Code.gs` regenerated with no diff (already current).

- [x] **Step 2: Hand the user the deployment checklist**

Present exactly this list (these are the user's actions, not yours):

1. **Apps Script:** paste the new `backend/Code.gs` over the old one **in the editor** (re-add your real `SECRET` — the repo copy ships a placeholder), run `runTests` (expect "ALL PASS ✅" in the log), then **Deploy → Manage deployments → Edit → New version**. A plain save is not enough for web apps.
2. **Frontend:** copy `index.html`, `js/app.js`, `css/style.css` into `../habits/` per the README, then commit + push yourself.
3. **Smoke test on the live dashboard:** log in → record an on-time entry (wallet updates instantly, card shows "records <date>") → tap Missed on a test category (confirm dialog appears; cancel it) → spend and add money → remove the test spend → Categories: archive then unarchive one.
4. **Email gating check:** for a weekly category with a check-up time, the check-up should now arrive **only on Monday**; answered periods stop re-emailing.

- [x] **Step 3: Note remaining known-limitations (not fixed by design)**

Tell the user these were consciously deferred: full undo for streak entries (only spends/deposits are deletable; misses now confirm first), auto-recording a miss for never-answered periods, and rate-limiting `requestLogin`. The miss-penalty/floor feature has an approved spec awaiting its own implementation plan.
