# Amend Past Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user change an already-recorded answer (including last night's, from the main card buttons) or back-fill any past period, with the habit's streak, freeze usage, payouts, and unused-freeze bonuses replayed to match the corrected history.

**Architecture:** A pure `replayCategory` in `engine.js` rebuilds one habit's history from its ledger entry rows under the habit's current settings. A new `amend` backend action rewrites/append the target row and calls a shared `replayAndSave` that rewrites rippled rows, appends a compensating bonus row, and stores the replayed state. `deleteEntry` on ✅/❌ rows switches to delete-then-replay, retiring the one-step undo snapshot. The frontend confirms changes on the card buttons and adds a per-card "Fix a past day/week" picker backed by a new `catHistory` action.

**Tech Stack:** Vanilla JS frontend (no framework, no build step), Google Apps Script backend generated from `main.gs` + `engine.js` via `node backend/build.js`, Node built-in test runner (`node --test`).

**Spec:** `habits/docs/superpowers/specs/2026-08-25-amend-past-answers-design.md`

## Global Constraints

- NEVER run `git commit` or `git push` — the user commits everything themselves. End every task with changes left in the working tree.
- `habits/backend/Code.gs` is GENERATED. Edit `main.gs` / `engine.js` only, then run `node build.js` from `habits/backend/`.
- `engine.js` must stay pure: no Apps Script globals (`Utilities`, `SpreadsheetApp`, …), no Node APIs, ES5 style (`var`, `function`), exports only via the existing `module.exports` block guarded by `typeof module !== 'undefined'`.
- `main.gs` is Apps Script: ES5 style, may use Apps Script globals, cannot be unit-tested in Node — its logic mirrors are asserted in its own `runTests()`.
- Frontend `js/app.js` follows its existing style: `const`/arrow functions, `$()` helper, `esc()` for every interpolated value, user-facing text as friendly one-liners.
- Comments explain why, never what.
- Run engine tests with: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
- All file paths below are relative to `/mnt/c/Users/Snic9/samsite/habits/`.

---

### Task 1: Engine period/key helpers

**Files:**
- Modify: `backend/engine.js` (add after `mondayOf`, around line 63; extend `module.exports`)
- Test: `backend/engine.test.js` (append)

**Interfaces:**
- Consumes: existing `shiftDays(dateStr, n)`, `mondayOf(dateStr, dow)`, `isoWeek(dateStr)` from `engine.js`.
- Produces (all exported):
  - `isoDow(dateStr) -> number` — ISO day-of-week 1..7 for "YYYY-MM-DD".
  - `periodKeyDate(periodKey) -> string` — "YYYY-MM-DD" for any period key (daily key passes through; weekly "YYYY-Www" becomes that ISO week's Monday).
  - `freezePeriodStart(freezeRefresh, dateStr) -> string` — first day of the freeze period containing `dateStr` (`'daily' | 'weekly' | 'monthly'`).
  - `validPeriodKey(cadence, key) -> boolean` — true when `key` is a real date ("daily") or a real ISO week for its year ("weekly").
  - `isTrueFlag(v) -> boolean` — true for `true` or any case of the string `"true"` (sheet cells round-trip booleans inconsistently).

- [ ] **Step 1: Write the failing tests**

Append to `backend/engine.test.js`:

```js
// Amend-past-answers: period/key helpers

test('periodKeyDate maps weekly keys to their ISO Monday and passes dates through', () => {
  assert.strictEqual(E.periodKeyDate('2026-06-22'), '2026-06-22');
  // 2026-06-22 is the Monday of ISO week 26 (see periodKeyFor test above)
  assert.strictEqual(E.periodKeyDate('2026-W26'), '2026-06-22');
  // ISO week 1 of 2026 starts in December 2025
  assert.strictEqual(E.periodKeyDate('2026-W01'), '2025-12-29');
});

test('periodKeyDate round-trips with isoWeek', () => {
  assert.strictEqual(E.isoWeek(E.periodKeyDate('2026-W26')), '2026-W26');
  assert.strictEqual(E.isoWeek(E.periodKeyDate('2026-W01')), '2026-W01');
});

test('freezePeriodStart buckets a date by refresh cadence', () => {
  assert.strictEqual(E.freezePeriodStart('daily', '2026-06-24'), '2026-06-24');
  assert.strictEqual(E.freezePeriodStart('weekly', '2026-06-24'), '2026-06-22'); // Wed -> Mon
  assert.strictEqual(E.freezePeriodStart('weekly', '2026-06-22'), '2026-06-22'); // Mon -> itself
  assert.strictEqual(E.freezePeriodStart('monthly', '2026-06-24'), '2026-06-01');
});

test('validPeriodKey accepts real keys and rejects malformed or impossible ones', () => {
  assert.strictEqual(E.validPeriodKey('daily', '2026-02-28'), true);
  assert.strictEqual(E.validPeriodKey('daily', '2026-02-31'), false); // not a real date
  assert.strictEqual(E.validPeriodKey('daily', '2026-W10'), false);   // wrong shape for cadence
  assert.strictEqual(E.validPeriodKey('weekly', '2026-W26'), true);
  assert.strictEqual(E.validPeriodKey('weekly', '2026-06-22'), false);
  assert.strictEqual(E.validPeriodKey('weekly', '2026-W53'), true);   // 2026 has 53 ISO weeks
  assert.strictEqual(E.validPeriodKey('weekly', '2025-W53'), false);  // 2025 has 52
});

test('isTrueFlag survives the sheet round-trip of booleans', () => {
  assert.strictEqual(E.isTrueFlag(true), true);
  assert.strictEqual(E.isTrueFlag('TRUE'), true);
  assert.strictEqual(E.isTrueFlag('true'), true);
  assert.strictEqual(E.isTrueFlag(false), false);
  assert.strictEqual(E.isTrueFlag(''), false);
  assert.strictEqual(E.isTrueFlag(undefined), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
Expected: the new tests FAIL with `E.periodKeyDate is not a function` (and similar); all pre-existing tests still pass.

- [ ] **Step 3: Implement the helpers**

In `backend/engine.js`, insert after the `mondayOf` function (after line 63):

```js
/** ISO day-of-week, 1=Mon..7=Sun, for "YYYY-MM-DD" (UTC math, DST-proof). */
function isoDow(dateStr) {
  var p = dateStr.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() || 7;
}

/**
 * Calendar date a period key sits on: a daily key is itself, a weekly key is
 * its ISO week's Monday. Gives replay a single axis to sort and bucket mixed
 * keys (a habit whose cadence was edited can hold both forms).
 */
function periodKeyDate(periodKey) {
  var m = /^(\d{4})-W(\d{2})$/.exec(String(periodKey));
  if (!m) return String(periodKey);
  // ISO week 1 is the week containing Jan 4.
  var jan4 = m[1] + '-01-04';
  var week1Monday = shiftDays(jan4, -(isoDow(jan4) - 1));
  return shiftDays(week1Monday, (Number(m[2]) - 1) * 7);
}

/** First day of the freeze period containing `dateStr`. */
function freezePeriodStart(freezeRefresh, dateStr) {
  if (freezeRefresh === 'daily') return dateStr;
  if (freezeRefresh === 'monthly') return dateStr.slice(0, 8) + '01';
  return mondayOf(dateStr, isoDow(dateStr));
}

/** Is `key` a real period key for this cadence? (Rejects 2026-02-31 and W53 in a 52-week year.) */
function validPeriodKey(cadence, key) {
  key = String(key || '');
  if (cadence === 'weekly') {
    if (!/^\d{4}-W\d{2}$/.test(key)) return false;
    return isoWeek(periodKeyDate(key)) === key;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  var p = key.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return d.toISOString().slice(0, 10) === key;
}

/** Sheet cells round-trip booleans as true/'TRUE'/'true' depending on path. */
function isTrueFlag(v) {
  return v === true || String(v).toLowerCase() === 'true';
}
```

Add to the `module.exports` block (alongside the existing entries):

```js
    isoDow: isoDow,
    periodKeyDate: periodKeyDate,
    freezePeriodStart: freezePeriodStart,
    validPeriodKey: validPeriodKey,
    isTrueFlag: isTrueFlag,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
Expected: ALL PASS.

---

### Task 2: Engine `replayCategory`

**Files:**
- Modify: `backend/engine.js` (add after `isPeriodRecorded`, around line 296; extend `module.exports`)
- Test: `backend/engine.test.js` (append)

**Interfaces:**
- Consumes: `payout(cat, streak)`, `periodKeyDate(periodKey)`, `freezePeriodStart(freezeRefresh, dateStr)` (Task 1).
- Produces (exported): `replayCategory(cat, entries, currentPeriodStart)` where `entries` is one actor's entry rows for one category (any order; each at least `{ periodKey, result }`, extra fields like `id`/`rowNumber` preserved). Returns:
  - `entries`: corrected copies sorted by period, each with recomputed boolean `freezeUsed` and numeric `amount`;
  - `state`: `{ streak: number, freezesUsedThisPeriod: number, lastRecordedKey: string|null }` — `freezesUsedThisPeriod` counts only freezes spent in the freeze period starting `currentPeriodStart`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/engine.test.js`:

```js
// Amend-past-answers: replayCategory

// Daily habit, weekly freeze refresh, 1 freeze, full miss penalty.
const RCAT = {
  id: 'sleep', cadence: 'daily', freezeRefresh: 'weekly',
  rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 0,
  freezesPerPeriod: 1, unusedFreezeBonus: 3.5, missPenaltyPercent: 100,
};
const entry = (periodKey, result) => ({ id: 'id-' + periodKey, periodKey, result });

test('replayCategory rebuilds a straight streak with growing payouts', () => {
  // Mon..Wed of ISO week 26
  const r = E.replayCategory(RCAT,
    [entry('2026-06-22', 'on_time'), entry('2026-06-23', 'on_time'), entry('2026-06-24', 'on_time')],
    '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0.5, 0.75]);
  assert.strictEqual(r.state.streak, 3);
  assert.strictEqual(r.state.lastRecordedKey, '2026-06-24');
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
});

test('replayCategory spends one freeze then penalizes the second miss', () => {
  const r = E.replayCategory(RCAT, [
    entry('2026-06-22', 'on_time'),
    entry('2026-06-23', 'missed'),
    entry('2026-06-24', 'missed'),
    entry('2026-06-25', 'on_time'),
  ], '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.freezeUsed), [false, true, false, false]);
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0, 0, 0.25]);
  assert.strictEqual(r.state.streak, 1);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 1);
});

test('replayCategory: flipping one answer cascades freezes and payouts', () => {
  // Same history as above but Tuesday corrected to on_time: Wednesday's miss
  // now gets the freeze, so Thursday continues the streak at step 3.
  const r = E.replayCategory(RCAT, [
    entry('2026-06-22', 'on_time'),
    entry('2026-06-23', 'on_time'),
    entry('2026-06-24', 'missed'),
    entry('2026-06-25', 'on_time'),
  ], '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.freezeUsed), [false, false, true, false]);
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0.5, 0, 0.75]);
  assert.strictEqual(r.state.streak, 3);
});

test('replayCategory sorts input and slots a gap-fill into place', () => {
  const r = E.replayCategory(RCAT,
    [entry('2026-06-24', 'on_time'), entry('2026-06-22', 'on_time'), entry('2026-06-23', 'on_time')],
    '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.periodKey),
    ['2026-06-22', '2026-06-23', '2026-06-24']);
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0.5, 0.75]);
});

test('replayCategory refreshes freezes at each freeze-period boundary', () => {
  // A miss in week 25 and a miss in week 26 each get their own freeze.
  const r = E.replayCategory(RCAT, [
    entry('2026-06-18', 'missed'),  // Thu, week 25
    entry('2026-06-23', 'missed'),  // Tue, week 26
  ], '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.freezeUsed), [true, true]);
  assert.strictEqual(r.state.streak, 0);
  // Only the current period's spend is live state.
  assert.strictEqual(r.state.freezesUsedThisPeriod, 1);
});

test('replayCategory counts no live freezes when the last entries are in a closed period', () => {
  const r = E.replayCategory(RCAT, [entry('2026-06-18', 'missed')], '2026-06-22');
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
});

test('replayCategory orders mixed weekly and daily keys on one calendar', () => {
  const r = E.replayCategory(RCAT,
    [entry('2026-06-22', 'on_time'), entry('2026-W25', 'on_time')],
    '2026-06-22');
  // Week 25's Monday (June 15) sorts before June 22.
  assert.deepStrictEqual(r.entries.map((e) => e.periodKey), ['2026-W25', '2026-06-22']);
  assert.strictEqual(r.state.streak, 2);
});

test('replayCategory applies missPenaltyPercent and preserves extra fields', () => {
  const half = Object.assign({}, RCAT, { missPenaltyPercent: 50, freezesPerPeriod: 0 });
  const rows = [
    { id: 'a', rowNumber: 7, periodKey: '2026-06-22', result: 'on_time' },
    { id: 'b', rowNumber: 8, periodKey: '2026-06-23', result: 'on_time' },
    { id: 'c', rowNumber: 9, periodKey: '2026-06-24', result: 'missed' },
  ];
  const r = E.replayCategory(half, rows, '2026-06-22');
  assert.strictEqual(r.state.streak, 1); // round(2 * 0.5)
  assert.strictEqual(r.entries[2].id, 'c');
  assert.strictEqual(r.entries[2].rowNumber, 9);
});

test('replayCategory of no entries is an empty state', () => {
  const r = E.replayCategory(RCAT, [], '2026-06-22');
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.state.lastRecordedKey, null);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
Expected: new tests FAIL with `E.replayCategory is not a function`.

- [ ] **Step 3: Implement `replayCategory`**

In `backend/engine.js`, insert after `isPeriodRecorded` (after line 296):

```js
/**
 * Rebuild one actor's history for one category from its ledger entry rows,
 * as if every answer had always been what the rows now say.
 *
 * Runs the same rules as applyEntry from streak 0 under the category's
 * CURRENT settings, re-deciding freeze usage from calendar freeze periods.
 * Unrecorded periods contribute nothing, matching live behavior. The freeze
 * period starting `currentPeriodStart` is still open — its spent count goes
 * into state for the live machinery; every earlier period is history.
 *
 * @param entries  one actor's entry rows for this category, any order; extra
 *                 fields (id, rowNumber, …) are preserved on the output copies
 * @returns {{entries: Array, state: {streak, freezesUsedThisPeriod, lastRecordedKey}}}
 */
function replayCategory(cat, entries, currentPeriodStart) {
  var sorted = entries.slice().sort(function (a, b) {
    var da = periodKeyDate(a.periodKey);
    var db = periodKeyDate(b.periodKey);
    return da < db ? -1 : da > db ? 1 : 0;
  });
  var streak = 0;
  var curStart = null;
  var used = 0;
  var out = [];
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    var fps = freezePeriodStart(cat.freezeRefresh, periodKeyDate(e.periodKey));
    if (fps !== curStart) { curStart = fps; used = 0; }
    var freezeUsed = false;
    var amount = 0;
    if (e.result === 'on_time') {
      streak += 1;
      amount = payout(cat, streak);
    } else if (used < (Number(cat.freezesPerPeriod) || 0)) {
      used += 1;
      freezeUsed = true;
    } else {
      var pct = cat.missPenaltyPercent == null ? 100 : cat.missPenaltyPercent;
      streak = Math.max(0, Math.round(streak * (1 - pct / 100)));
    }
    out.push(Object.assign({}, e, { freezeUsed: freezeUsed, amount: amount }));
  }
  return {
    entries: out,
    state: {
      streak: streak,
      freezesUsedThisPeriod: curStart === currentPeriodStart ? used : 0,
      lastRecordedKey: sorted.length ? String(sorted[sorted.length - 1].periodKey) : null,
    },
  };
}
```

Add to `module.exports`:

```js
    replayCategory: replayCategory,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
Expected: ALL PASS.

---

### Task 3: Engine bonus re-settlement helpers

**Files:**
- Modify: `backend/engine.js` (add after `replayCategory`; extend `module.exports`)
- Test: `backend/engine.test.js` (append)

**Interfaces:**
- Consumes: `freezePeriodStart`, `periodKeyDate`, `isTrueFlag` (Task 1), `round2`.
- Produces (both exported):
  - `freezeSpentPeriods(cat, entries, currentPeriodStart) -> object` — map of closed freeze-period start dates (`"YYYY-MM-DD"` keys, value `true`) in which some entry's `freezeUsed` flag is set. Entries in the current period are ignored.
  - `bonusDelta(cat, beforeEntries, afterEntries, currentPeriodStart) -> number` — net unused-freeze-bonus correction: `+unusedFreezeBonus` for each closed period that spent a freeze before but not after (bonus earned, never paid), `−unusedFreezeBonus` for the reverse. 0 when `unusedFreezeBonus` is not positive.

- [ ] **Step 1: Write the failing tests**

Append to `backend/engine.test.js` (reuses `RCAT` and `entry` from the Task 2 tests):

```js
// Amend-past-answers: bonus re-settlement

const fentry = (periodKey, result, freezeUsed) => ({ periodKey, result, freezeUsed });

test('freezeSpentPeriods reports closed periods with a spent freeze, skipping the live one', () => {
  const m = E.freezeSpentPeriods(RCAT, [
    fentry('2026-06-18', 'missed', true),   // week 25 — closed
    fentry('2026-06-23', 'missed', 'TRUE'), // week 26 — current, ignored
    fentry('2026-06-16', 'on_time', false),
  ], '2026-06-22');
  assert.deepStrictEqual(m, { '2026-06-15': true });
});

test('bonusDelta pays back a bonus when a corrected answer frees the freeze', () => {
  const before = [fentry('2026-06-18', 'missed', true)];
  const after = [fentry('2026-06-18', 'on_time', false)];
  assert.strictEqual(E.bonusDelta(RCAT, before, after, '2026-06-22'), 3.5);
});

test('bonusDelta claws back a bonus when a correction spends a freeze', () => {
  const before = [fentry('2026-06-18', 'on_time', false)];
  const after = [fentry('2026-06-18', 'missed', true)];
  assert.strictEqual(E.bonusDelta(RCAT, before, after, '2026-06-22'), -3.5);
});

test('bonusDelta claws back when a gap-fill miss lands in a period that had earned it', () => {
  // Before: week 25 was empty (bonus paid at rollover). After: a filled miss spends its freeze.
  assert.strictEqual(E.bonusDelta(RCAT, [], [fentry('2026-06-18', 'missed', true)], '2026-06-22'), -3.5);
});

test('bonusDelta is zero for changes inside the current period, unchanged flags, or no bonus', () => {
  const cur = [fentry('2026-06-23', 'missed', true)];
  assert.strictEqual(E.bonusDelta(RCAT, [], cur, '2026-06-22'), 0);
  const same = [fentry('2026-06-18', 'missed', true)];
  assert.strictEqual(E.bonusDelta(RCAT, same, same, '2026-06-22'), 0);
  const noBonus = Object.assign({}, RCAT, { unusedFreezeBonus: 0 });
  assert.strictEqual(E.bonusDelta(noBonus, same, [fentry('2026-06-18', 'on_time', false)], '2026-06-22'), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
Expected: new tests FAIL with `E.freezeSpentPeriods is not a function`.

- [ ] **Step 3: Implement the helpers**

In `backend/engine.js`, insert after `replayCategory`:

```js
/**
 * Closed freeze periods in which some entry spent a freeze.
 * The live system settles every closed period at rollover, paying the bonus
 * exactly when nothing in it spent a freeze — so this set is the whole story
 * of which past periods went unpaid. The current period is still open and is
 * settled later by the hourly refresh, never here.
 */
function freezeSpentPeriods(cat, entries, currentPeriodStart) {
  var m = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!isTrueFlag(e.freezeUsed)) continue;
    var fps = freezePeriodStart(cat.freezeRefresh, periodKeyDate(e.periodKey));
    if (fps === currentPeriodStart) continue;
    m[fps] = true;
  }
  return m;
}

/**
 * Net unused-freeze-bonus correction implied by a history change. Uses the
 * category's CURRENT bonus value — old bonus rows carry no period key, so they
 * are compensated in aggregate, never edited (see the design doc's caveat).
 */
function bonusDelta(cat, beforeEntries, afterEntries, currentPeriodStart) {
  if (!(cat.unusedFreezeBonus > 0)) return 0;
  var before = freezeSpentPeriods(cat, beforeEntries, currentPeriodStart);
  var after = freezeSpentPeriods(cat, afterEntries, currentPeriodStart);
  var delta = 0;
  Object.keys(before).forEach(function (p) {
    if (!after[p]) delta += cat.unusedFreezeBonus; // earned now, never paid
  });
  Object.keys(after).forEach(function (p) {
    if (!before[p]) delta -= cat.unusedFreezeBonus; // paid then, not earned now
  });
  return round2(delta);
}
```

Add to `module.exports`:

```js
    freezeSpentPeriods: freezeSpentPeriods,
    bonusDelta: bonusDelta,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test`
Expected: ALL PASS.

---

### Task 4: Backend `amend` action + shared replay writer

**Files:**
- Modify: `backend/main.gs` — add `entryRowsFor` + `replayAndSave` after `doDeleteEntry`/`walletWithout` (around line 556), add `doAmend` after them, add a route case (line 359-373), extend `runTests()` (line 803-848)
- Modify: `backend/Code.gs` — regenerate only (never edit)

**Interfaces:**
- Consumes: `replayCategory`, `bonusDelta`, `validPeriodKey`, `periodKeyDate`, `isTrueFlag`, `round2` (Tasks 1–3); existing `requireUser`, `categoryById`, `recordablePeriodKey`, `maybeRefresh`, `readLedgerRows`, `ledgerSheet`, `appendLedger`, `runningBalanceRows`, `deriveWallet`, `currentPeriodStart`, `catStateOf`, `saveCatState`, `catPublic`, `withLock`.
- Produces:
  - `entryRowsFor(rows, email, categoryId) -> Array` — references (not copies) of `rows` items with `type === 'entry'`, case-insensitive actor match, matching category.
  - `replayAndSave(email, cat, beforeEntries, excludeId) -> { wallet: number, changed: number, bonusDelta: number }` — used again by Task 5.
  - HTTP action `amend` (`categoryId`, `periodKey`, `result`, `token`) returning `{ ok, wallet, cat, event: {periodKey, result}, ripple: {entriesChanged, bonusDelta} }`, or `{ ok: true, unchanged: true, wallet }`, or `{ ok: false, error }`.

Ledger columns (1-indexed, from `createLedgerSpreadsheet`): 1 id, 2 timestamp, 3 type, 4 category, 5 periodKey, 6 result, 7 freezeUsed, 8 amount, 9 balanceAfter, 10 actor, 11 note.

- [ ] **Step 1: Add `entryRowsFor` and `replayAndSave`**

In `backend/main.gs`, insert after `walletWithout` (after line 556):

```js
// This actor's entry rows for one category, as references into `rows` so a
// caller's in-place amount fixes feed straight into the balance re-derivation.
function entryRowsFor(rows, email, categoryId) {
  var a = String(email || '').toLowerCase();
  return rows.filter(function (r) {
    return r.type === 'entry' &&
      String(r.actor || '').toLowerCase() === a &&
      String(r.category) === String(categoryId);
  });
}

// Rewrite this actor's entry rows for `cat` to the replayed history, append a
// compensating bonus row if freeze re-settlement changed anything, and store
// the replayed state. `beforeEntries` are the entry rows as recorded BEFORE
// the caller's mutation (old result/freezeUsed flags); `excludeId` keeps the
// directly-changed row out of the ripple count shown to the user. Caller holds
// the lock and has already written its mutation to the sheet.
function replayAndSave(email, cat, beforeEntries, excludeId) {
  var rows = readLedgerRows(); // post-mutation, so rowNumbers are fresh
  var mine = entryRowsFor(rows, email, cat.id);
  var curStart = currentPeriodStart(cat);
  var r = replayCategory(cat, mine, curStart);
  var sh = ledgerSheet();
  var corrected = {};
  r.entries.forEach(function (e) { corrected[String(e.id)] = e; });
  var changed = 0;
  mine.forEach(function (row) {
    var e = corrected[String(row.id)];
    if (isTrueFlag(row.freezeUsed) === e.freezeUsed && (Number(row.amount) || 0) === e.amount) return;
    sh.getRange(row.rowNumber, 7, 1, 2).setValues([[e.freezeUsed, e.amount]]);
    if (String(row.id) !== String(excludeId)) changed++;
    row.freezeUsed = e.freezeUsed;
    row.amount = e.amount;
  });
  // The stored balanceAfter column is cosmetic (the app re-derives), but keep
  // the sheet readable for humans: rewrite cells the correction shifted.
  var a = String(email || '').toLowerCase();
  var myAll = rows.filter(function (x) { return String(x.actor || '').toLowerCase() === a; });
  var rb = runningBalanceRows(rows, email);
  for (var i = 0; i < rb.length; i++) {
    if (Number(myAll[i].balanceAfter) !== rb[i].balanceAfter) {
      sh.getRange(myAll[i].rowNumber, 9).setValue(rb[i].balanceAfter);
    }
  }
  var wallet = rb.length ? rb[rb.length - 1].balanceAfter : 0;
  var delta = bonusDelta(cat, beforeEntries, r.entries, curStart);
  if (delta !== 0) {
    // A negative adjustment can push the wallet below zero; that is honest
    // accounting for money already banked, so it is not floored.
    wallet = round2(wallet + delta);
    appendLedger({
      type: 'bonus', category: cat.id, amount: delta,
      note: 'Bonus adjustment (answer changed)', actor: email, balanceAfter: wallet,
    });
  }
  var s = catStateOf(email, cat.id, cat);
  saveCatState(email, cat.id, {
    streak: r.state.streak,
    periodStart: s.periodStart,
    freezeRefresh: s.freezeRefresh,
    freezesUsedThisPeriod: r.state.freezesUsedThisPeriod,
    lastRecordedKey: r.state.lastRecordedKey,
  });
  return { wallet: wallet, changed: changed, bonusDelta: delta };
}
```

- [ ] **Step 2: Add `doAmend`**

Insert after `replayAndSave`:

```js
// Change or back-fill the answer for any closed period. Dashboard token only —
// signed email links stay single-purpose, and the same cap as doRecord's
// (nothing open or future) means amend can't inflate a streak any further
// than honest recording could.
function doAmend(p) {
  var email = requireUser(p);
  var result = p.result;
  var periodKey = String(p.periodKey || '');
  var cat = categoryById(p.categoryId);
  if (!cat) return { ok: false, error: 'unknown category' };
  if (!cat.active) return { ok: false, error: 'that habit is archived' };
  if (result !== 'on_time' && result !== 'missed') {
    return { ok: false, error: 'result must be "on_time" or "missed"' };
  }
  if (!validPeriodKey(cat.cadence, periodKey)) {
    return { ok: false, error: cat.cadence === 'weekly'
      ? 'pick a week like 2026-W33'
      : 'pick a real date (YYYY-MM-DD)' };
  }
  var latest = recordablePeriodKey(cat);
  if (periodKeyDate(periodKey) > periodKeyDate(latest)) {
    return { ok: false, error: 'that ' + (cat.cadence === 'weekly' ? 'week' : 'day') +
      ' isn\'t over yet — the latest you can record is ' + latest };
  }
  maybeRefresh(cat); // settle any pending rollover before touching history
  var rows = readLedgerRows();
  var before = entryRowsFor(rows, email, cat.id);
  var target = null;
  for (var i = 0; i < before.length; i++) {
    if (String(before[i].periodKey) === periodKey) { target = before[i]; break; }
  }
  if (target && String(target.result) === result) {
    return { ok: true, unchanged: true, wallet: deriveWallet(rows, email) };
  }
  var targetId;
  if (target) {
    ledgerSheet().getRange(target.rowNumber, 6).setValue(result);
    targetId = target.id;
  } else {
    targetId = appendLedger({
      type: 'entry', category: cat.id, periodKey: periodKey, result: result,
      freezeUsed: false, amount: 0, balanceAfter: '', actor: email,
    });
  }
  // `before` still describes pre-mutation history: an edited target's
  // in-memory copy was not touched, and an appended row is not in it.
  var out = replayAndSave(email, cat, before, targetId);
  return {
    ok: true, wallet: out.wallet, cat: catPublic(email, cat),
    event: { periodKey: periodKey, result: result },
    ripple: { entriesChanged: out.changed, bonusDelta: out.bonusDelta },
  };
}
```

- [ ] **Step 3: Route it**

In `route(p)` (line 359-373), add after the `deleteEntry` case:

```js
    case 'amend': return withLock(function () { return doAmend(p); });
```

- [ ] **Step 4: Mirror-test in `runTests()`**

In `runTests()` (before the final `if (fails.length)`), add:

```js
  // Amend-past-answers: replay + helpers (mirrors of engine.test.js cases)
  eq(periodKeyDate('2026-W26'), '2026-06-22', 'periodKeyDate weekly');
  eq(freezePeriodStart('monthly', '2026-06-24'), '2026-06-01', 'freezePeriodStart monthly');
  eq(validPeriodKey('daily', '2026-02-31'), false, 'validPeriodKey rejects fake dates');
  eq(validPeriodKey('weekly', '2026-W53'), true, 'validPeriodKey allows W53 in a 53-week year');
  var rcat = { id: 's', cadence: 'daily', freezeRefresh: 'weekly', rewardIncrement: 0.25,
    maxPerInstance: 5, minPayout: 0, freezesPerPeriod: 1, unusedFreezeBonus: 3.5, missPenaltyPercent: 100 };
  var rp = replayCategory(rcat, [
    { id: 'a', periodKey: '2026-06-22', result: 'on_time' },
    { id: 'b', periodKey: '2026-06-23', result: 'missed' },
  ], '2026-06-22');
  eq(rp.state.streak, 1, 'replay keeps streak through a frozen miss');
  eq(rp.entries[1].freezeUsed, true, 'replay spends the freeze');
  eq(bonusDelta(rcat,
    [{ periodKey: '2026-06-18', result: 'missed', freezeUsed: true }],
    [{ periodKey: '2026-06-18', result: 'on_time', freezeUsed: false }],
    '2026-06-22'), 3.5, 'bonusDelta pays back a freed freeze');
```

- [ ] **Step 5: Rebuild and verify**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test && node build.js && node --check Code.gs`
Expected: ALL tests PASS; `Wrote Code.gs (...)`; `node --check` exits clean (Apps Script's ES5 subset parses as valid JS).

---

### Task 5: Backend replay-based delete, `catHistory`, `recordedResult`

**Files:**
- Modify: `backend/main.gs` — `recentLedger` (line 194-214), `catPublicFromState`/`stateResponse` (line 422-463), `doRecord` (line 496-508), `doDeleteEntry`/`undoEntry` (line 531-596), `route` (line 359-373)
- Modify: `backend/Code.gs` — regenerate only

**Interfaces:**
- Consumes: `entryRowsFor`, `replayAndSave` (Task 4), `isTrueFlag` (Task 1).
- Produces:
  - HTTP action `catHistory` (`categoryId`, `token`) → `{ ok: true, entries: [{ periodKey, result, freezeUsed }] }`, newest period first.
  - `catPublicFromState(cat, s, entryRows)` — third parameter added; returned object gains `recordedResult: 'on_time' | 'missed' | null` (the answer on file for `nextPeriodKey`).
  - `deleteEntry` now accepts any of the user's own `entry` rows and replays; `recentLedger(mine, n)` drops its `email` parameter and marks entry rows deletable.
  - `state.undo` is no longer written or read anywhere (old snapshots become inert).

- [ ] **Step 1: Stop writing undo snapshots in `doRecord`**

In `doRecord` (line 496-508), replace:

```js
  var out = applyEntry(s, deriveWallet(rows, person), cat, { periodKey: periodKey, result: result, actor: person });
  // Snapshot what this entry changed, so it can be taken back. Only the newest
  // entry per category is undoable — this snapshot is the whole of the history.
  out.state.undo = {
    id: appendLedger(out.event),
    streak: s.streak,
    freezesUsedThisPeriod: Number(s.freezesUsedThisPeriod) || 0,
    lastRecordedKey: s.lastRecordedKey,
    periodStart: s.periodStart,
  };
  saveCatState(person, categoryId, out.state);
```

with:

```js
  var out = applyEntry(s, deriveWallet(rows, person), cat, { periodKey: periodKey, result: result, actor: person });
  appendLedger(out.event);
  saveCatState(person, categoryId, out.state);
```

- [ ] **Step 2: Simplify `recentLedger`**

Replace the whole function (line 194-214) with:

```js
// `mine` is one actor's rows from runningBalanceRows — already carrying the
// correct balanceAfter. Taking them pre-scanned keeps stateResponse to a single
// pass for the wallet and the panel together.
function recentLedger(mine, n) {
  mine = mine.slice(Math.max(0, mine.length - n));
  var names = categoryNames();
  return mine.reverse().map(function (r) {
    return {
      id: r.id,
      // Deleting an entry row replays the habit's history, so any own row goes.
      canDelete: r.type === 'spend' || r.type === 'deposit' || r.type === 'entry',
      timestamp: r.timestamp ? Utilities.formatDate(new Date(r.timestamp), TZ, 'yyyy-MM-dd HH:mm') : '',
      type: r.type, category: r.category,
      categoryName: names[r.category] || r.category,
      periodKey: r.periodKey, result: r.result,
      freezeUsed: r.freezeUsed, amount: r.amount, balanceAfter: r.balanceAfter,
      actor: r.actor, note: r.note,
    };
  });
}
```

In `stateResponse` (line 458), change the call `recentLedger(myRows, email, 20)` to `recentLedger(myRows, 20)`.

- [ ] **Step 3: Replay-based `deleteEntry`; delete `undoEntry`**

In `doDeleteEntry` (line 531-550), replace:

```js
  if (match.type === 'entry') return undoEntry(email, match, rows);
```

with:

```js
  if (match.type === 'entry') {
    var cat = categoryById(match.category);
    if (!cat) return { ok: false, error: 'unknown category' };
    var before = entryRowsFor(rows, email, cat.id);
    ledgerSheet().deleteRow(match.rowNumber);
    // replayAndSave re-reads the sheet, so the deletion's row shift is safe.
    var out = replayAndSave(email, cat, before, null);
    return { ok: true, wallet: out.wallet, cat: catPublic(email, cat) };
  }
```

Delete the entire `undoEntry` function (line 557-596, from its `// Take back a recorded entry:` comment through its closing brace).

- [ ] **Step 4: Add `catHistory` and `recordedResult`**

Insert after `doAmend`:

```js
// Everything this person has recorded for one habit — the dashboard's 20-row
// ledger window is not enough for the past-date picker.
function doCatHistory(p) {
  var email = requireUser(p);
  var cat = categoryById(p.categoryId);
  if (!cat) return { ok: false, error: 'unknown category' };
  var mine = entryRowsFor(readLedgerRows(), email, cat.id);
  mine.sort(function (a, b) {
    var da = periodKeyDate(a.periodKey);
    var db = periodKeyDate(b.periodKey);
    return da < db ? 1 : da > db ? -1 : 0;
  });
  return {
    ok: true,
    entries: mine.map(function (r) {
      return { periodKey: String(r.periodKey), result: r.result, freezeUsed: isTrueFlag(r.freezeUsed) };
    }),
  };
}
```

Add the route case after `amend`'s:

```js
    case 'catHistory': return doCatHistory(p);
```

Replace `catPublicFromState` (line 422-430) with:

```js
function catPublicFromState(cat, s, entryRows) {
  var next = recordablePeriodKey(cat);
  var recorded = null;
  (entryRows || []).forEach(function (r) {
    if (r.type === 'entry' && String(r.category) === String(cat.id) &&
        String(r.periodKey) === next) recorded = r.result;
  });
  return {
    id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
    streak: s.streak, freezeAvailable: freezesLeft(cat, s),
    lastRecordedKey: s.lastRecordedKey,
    // The answer already on file for the recordable period — the card buttons
    // switch from "record" to "change your answer?" on this.
    recordedResult: recorded,
    potential: payout(cat, s.streak + 1),
    nextPeriodKey: next,
  };
}
```

In `stateResponse` (line 451-453), pass the rows through:

```js
  var cats = active.map(function (c) {
    return catPublicFromState(c, myState[c.id] || initialCatState(c, currentPeriodStart(c)), myRows);
  });
```

(`catPublic` at line 431-433 keeps its two-argument shape; it now passes no rows, so its `recordedResult` is null — its callers' responses are followed by a full dashboard reload.)

- [ ] **Step 5: Rebuild and verify**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test && node build.js && node --check Code.gs && ! grep -n "undoEntry\|\.undo" Code.gs`
Expected: tests PASS, build clean, `node --check` clean, and the grep finds nothing (undo machinery fully gone).

---

### Task 6: Frontend — change-answer flow on the card buttons

**Files:**
- Modify: `js/app.js` — `renderCatCards` (line 109-137), `recordCat`/new helpers (line 226-243), `deleteEntry` wording (line 184-198)

**Interfaces:**
- Consumes: `state` response cats now carry `recordedResult` and `nextPeriodKey` (Task 5); backend action `amend` (Task 4); existing `api`, `banner`, `money`, `esc`, `showDashboard`, `recordCat`.
- Produces: `prettyResult(r)`, `onRecordClick(c, result, label)`, `amend(categoryId, periodKey, result)` — Task 7 reuses all three.

- [ ] **Step 1: Add `prettyResult` and `amend`**

In `js/app.js`, insert after `recordCat` (after line 243):

```js
const prettyResult = (r) => (r === 'on_time' ? '✅ Did it' : '❌ Missed');

async function amend(categoryId, periodKey, result) {
  banner('Saving…', false);
  try {
    const r = await api('amend', { categoryId, periodKey, result });
    if (!r.ok) { banner(r.error || 'Could not save', true); return; }
    if (r.unchanged) { banner('Already recorded — nothing changed.', false); return; }
    if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
    const n = (r.ripple && r.ripple.entriesChanged) || 0;
    banner('Changed ' + periodKey + ' to ' + (result === 'on_time' ? '✅' : '❌') +
      (n ? ' — ' + n + ' later ' + (n === 1 ? 'entry' : 'entries') + ' adjusted.' : '.'), false);
    showDashboard(true);
  } catch (err) { banner(err.message, true); }
}

function onRecordClick(c, result, label) {
  if (!c.recordedResult) { recordCat(c.id, result, label); return; }
  const period = c.cadence === 'weekly' ? 'last week' : 'last night';
  if (c.recordedResult === result) {
    banner('You already recorded ' + prettyResult(result) + ' for ' + period + ' — nothing to change.', false);
    return;
  }
  if (!window.confirm('You recorded ' + prettyResult(c.recordedResult) + ' for ' + period +
      ' (' + (c.nextPeriodKey || '') + '). Change it to ' + prettyResult(result) +
      '? Later entries adjust automatically.')) return;
  amend(c.id, c.nextPeriodKey, result);
}
```

- [ ] **Step 2: Route card-button clicks through `onRecordClick`**

In `renderCatCards` (line 109-137), give the button row a class and hand each card's data to the handler. Replace the two button lines inside the `card.innerHTML` template:

```js
      '<div class="row" style="margin-top:8px">' +
      '<button class="ok" data-cat="' + esc(c.id) + '" data-result="on_time">✅ Did it</button>' +
      '<button class="danger" data-cat="' + esc(c.id) + '" data-result="missed">❌ Missed</button>' +
      '</div>' +
```

with:

```js
      '<div class="row main-actions" style="margin-top:8px">' +
      '<button class="ok" data-result="on_time">✅ Did it</button>' +
      '<button class="danger" data-result="missed">❌ Missed</button>' +
      '</div>' +
```

Then replace the listener wiring after the `cats.forEach` loop:

```js
  wrap.querySelectorAll('button[data-cat]').forEach((b) => {
    b.addEventListener('click', () => recordCat(b.getAttribute('data-cat'), b.getAttribute('data-result'), b.closest('.card').querySelector('h2').textContent));
  });
```

by moving the wiring INSIDE the `cats.forEach((c) => { ... })` block, after `wrap.appendChild(card);`:

```js
    const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
    card.querySelectorAll('.main-actions button[data-result]').forEach((b) =>
      b.addEventListener('click', () => onRecordClick(c, b.getAttribute('data-result'), label)));
```

(The old `wrap.querySelectorAll('button[data-cat]')` block is removed entirely.)

- [ ] **Step 3: Update the delete confirmation for the new semantics**

In `deleteEntry` (line 184-198), replace:

```js
  const ask = isEntry
    ? 'Undo this entry? Your streak and freezes go back to what they were, and the payout is taken back.'
    : 'Remove this entry? This updates your wallet total.';
```

with:

```js
  const ask = isEntry
    ? 'Remove this answer? The period reopens, and your streak, freezes, and payouts are recomputed from the corrected history.'
    : 'Remove this entry? This updates your wallet total.';
```

- [ ] **Step 4: Syntax-check**

Run: `node --check /mnt/c/Users/Snic9/samsite/habits/js/app.js`
Expected: exits clean.

---

### Task 7: Frontend — "Fix a past day/week" picker

**Files:**
- Modify: `js/app.js` — `renderCatCards` card template + new `wireFixPast` and client date helpers
- Modify: `css/style.css` — append `.fix-past` rules

**Interfaces:**
- Consumes: `amend`, `prettyResult`, `banner`, `api`, `esc` (Task 6 / existing); backend `catHistory` (Task 5); cat fields `cadence`, `nextPeriodKey`, `recordedResult`.
- Produces: self-contained per-card UI; client helpers `shiftDays(dateStr, n)`, `isoWeek(dateStr)`, `weekKeyMonday(weekKey)` (mirrors of `engine.js`).

- [ ] **Step 1: Add the client date helpers**

In `js/app.js`, insert after the `slugify` helper (after line 12):

```js
/* Mirrors of backend period helpers (engine.js) — keep in sync. */
const shiftDays = (dateStr, n) => {
  const p = dateStr.split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isoWeek = (dateStr) => {
  const p = dateStr.split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + ('0' + weekNo).slice(-2);
};
const weekKeyMonday = (weekKey) => {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) return weekKey;
  const jan4 = m[1] + '-01-04';
  const dow = new Date(jan4 + 'T00:00:00Z').getUTCDay() || 7;
  return shiftDays(shiftDays(jan4, -(dow - 1)), (Number(m[2]) - 1) * 7);
};
```

- [ ] **Step 2: Add the collapsed picker to each card**

In `renderCatCards`, extend the `card.innerHTML` template: after the trailing `'<p class="muted">' + ... '</p>'` line, append:

```js
      '<details class="fix-past">' +
      '<summary>✏️ Fix a past ' + (c.cadence === 'weekly' ? 'week' : 'day') + '</summary>' +
      '<div class="row fix-row">' +
      (c.cadence === 'weekly'
        ? '<select class="fix-picker"></select>'
        : '<input class="fix-picker" type="date" max="' + esc(c.nextPeriodKey || '') + '" />') +
      '<button class="ok" data-fix="on_time">✅ Did it</button>' +
      '<button class="danger" data-fix="missed">❌ Missed</button>' +
      '</div>' +
      '<p class="muted fix-current"></p>' +
      '</details>';
```

And inside the same `cats.forEach` block, after the `.main-actions` wiring added in Task 6, add:

```js
    wireFixPast(card, c, label);
```

- [ ] **Step 3: Implement `wireFixPast`**

Insert after `onRecordClick`:

```js
function wireFixPast(card, c, label) {
  const det = card.querySelector('details.fix-past');
  const picker = det.querySelector('.fix-picker');
  const cur = det.querySelector('.fix-current');
  let history = null; // periodKey -> 'on_time' | 'missed'; null until first open

  if (c.cadence === 'weekly' && c.nextPeriodKey) {
    let monday = weekKeyMonday(c.nextPeriodKey);
    for (let i = 0; i < 12; i++) {
      const key = isoWeek(monday);
      picker.innerHTML += '<option value="' + esc(key) + '">' + esc(key) + '</option>';
      monday = shiftDays(monday, -7);
    }
  }

  const refreshCurrent = () => {
    const k = picker.value;
    if (!k || history === null) { cur.textContent = ''; return; }
    const r = history[k];
    cur.textContent = r
      ? 'Currently recorded: ' + prettyResult(r)
      : 'Not recorded yet.';
  };

  det.addEventListener('toggle', async () => {
    if (!det.open || history !== null) return;
    try {
      const r = await api('catHistory', { categoryId: c.id });
      if (!r.ok) { banner(r.error || 'Could not load history', true); return; }
      history = {};
      (r.entries || []).forEach((e) => { history[e.periodKey] = e.result; });
      refreshCurrent();
    } catch (err) { banner(err.message, true); }
  });
  picker.addEventListener('change', refreshCurrent);

  det.querySelectorAll('button[data-fix]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = picker.value;
      const result = b.getAttribute('data-fix');
      if (!key) {
        banner('Pick a ' + (c.cadence === 'weekly' ? 'week' : 'date') + ' first.', true);
        return;
      }
      const existing = history && history[key];
      if (existing === result) {
        banner(key + ' is already recorded as ' + prettyResult(result) + '.', false);
        return;
      }
      if (existing &&
          !window.confirm('You recorded ' + prettyResult(existing) + ' for ' + key +
            '. Change it to ' + prettyResult(result) + '? Later entries adjust automatically.')) return;
      if (!existing && result === 'missed' &&
          !window.confirm('Record a miss for "' + label + '" on ' + key + '? ' +
            'A freeze is used automatically if one was available; otherwise your streak takes the hit.')) return;
      amend(c.id, key, result);
    }));
}
```

- [ ] **Step 4: Style the picker**

Append to `css/style.css`:

```css
.fix-past {
  margin-top: 10px;
}
.fix-past summary {
  cursor: pointer;
  font-size: 14px;
  opacity: 0.75;
}
.fix-past .fix-row {
  margin-top: 8px;
}
.fix-past input[type='date'] {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 5: Syntax-check**

Run: `node --check /mnt/c/Users/Snic9/samsite/habits/js/app.js`
Expected: exits clean.

---

### Task 8: Final verification

**Files:** none new — verification only.

- [ ] **Step 1: Full test + build**

Run: `cd /mnt/c/Users/Snic9/samsite/habits/backend && node --test && node build.js && node --check Code.gs && node --check ../js/app.js`
Expected: every test passes, `Code.gs` regenerates, both syntax checks are clean.

- [ ] **Step 2: Confirm the generated file carries the new code**

Run: `grep -c "replayCategory\|doAmend\|doCatHistory\|bonusDelta" /mnt/c/Users/Snic9/samsite/habits/backend/Code.gs`
Expected: a nonzero count (all four names present in `Code.gs`).

- [ ] **Step 3: Manual smoke check of the frontend**

Serve locally: `cd /mnt/c/Users/Snic9/samsite && python3 -m http.server 8080` then open `http://localhost:8080/habits/`. Without a deployed backend the app shows its login view — verify no console errors on load and that the page renders. (End-to-end behavior needs the user to paste `Code.gs` into Apps Script and redeploy; note this in the handoff summary.)

- [ ] **Step 4: Report**

Summarize for the user: what changed, that `Code.gs` must be re-pasted and re-deployed in Apps Script (no `setup()` run needed — the sheet schema is unchanged), and that all changes are uncommitted for their review.
