# House Chores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared and assignable household chores with flat pay per claim, daily/weekly/monthly/once cadences, and a penalty pot: unclaimed periods drain wallets, and whoever finally does the chore collects the pot.

**Architecture:** Chores are categories with `kind: 'chore'`, reusing the ledger, wallets, admin form, reminders, and delete machinery. Two new ledger row types (`claim`, positive; `penalty`, negative) flow through the existing `deriveWallet` untouched. A per-chore (not per-user) `choreStates` blob tracks `since` and `sweepFrom`; an hourly/on-demand sweep appends penalty rows for closed unclaimed periods. Chore periods are independent — no streak replay; corrections are claim-row deletion plus re-claim.

**Tech Stack:** Vanilla JS frontend (no build), Google Apps Script backend generated from `main.gs` + `engine.js` via `node build.js`, Node built-in test runner.

**Spec:** `habits/docs/superpowers/specs/2026-08-25-house-chores-design.md`

## Global Constraints

- NEVER run `git commit` or `git push` — the user commits. Leave every change in the working tree.
- `habits/backend/Code.gs` is GENERATED — edit `main.gs`/`engine.js`, then `node build.js` from `habits/backend/`.
- `engine.js` stays pure ES5 (no Node/Apps Script globals), exports only via the guarded `module.exports`. `main.gs` is ES5 Apps Script.
- Syntax check for Code.gs: `node --input-type=commonjs --check < Code.gs` (the bare `node --check Code.gs` cannot run on this Node version).
- Comments explain why, never what. Frontend `app.js`: const/arrows, `esc()` on anything interpolated into innerHTML.
- Tests: `cd /mnt/c/Users/Snic9/samsite/.claude/worktrees/amend-past-answers/habits/backend && node --test` (currently 81 pass).
- Ledger sheet columns (1-indexed): 1 id, 2 timestamp, 3 type, 4 category, 5 periodKey, 6 result, 7 freezeUsed, 8 amount, 9 balanceAfter, 10 actor, 11 note.
- All paths relative to `/mnt/c/Users/Snic9/samsite/.claude/worktrees/amend-past-answers/habits/`.
- Habits must behave exactly as before: every habit-only code path (streak state, refresh, check-ups, record/amend) must operate on `kind === 'habit'` categories only.

---

### Task 1: Engine — chore cadences and category model

**Files:**
- Modify: `backend/engine.js` (`periodKeyFor` ~line 38, `validPeriodKey` ~line 93, `normalizeCategory`/`validateCategory` ~line 519-560, `module.exports`)
- Test: `backend/engine.test.js` (append)

**Interfaces:**
- Consumes: existing `slugify`, `num`, `isWholeHour`, `isoWeek`, `validPeriodKey` internals.
- Produces (exported):
  - `periodKeyFor(cadence, dateStr)` also handles `'monthly'` → `"YYYY-MM"` and `'once'` → `"once"`.
  - `validPeriodKey(cadence, key)` also handles `'monthly'` (real month) and `'once'` (only `"once"`).
  - `claimablePeriodKey(cat, dateStr) -> string` — the CURRENT period for a chore: the date itself (daily), `isoWeek(dateStr)` (weekly), `dateStr.slice(0, 7)` (monthly), `"once"`.
  - `normalizeCategory(raw)` returns a chore shape when `raw.kind === 'chore'`: `{ id, name, emoji, kind: 'chore', cadence, value, assignee, dueDate, reminderTime, active }`; habit shapes gain `kind: 'habit'` and are otherwise byte-identical to today.
  - `validateCategory(cat)` branches on `kind` — chores validate value/assignee/dueDate; habits keep today's rules unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `backend/engine.test.js`:

```js
// House chores: cadences and category model

test('periodKeyFor handles monthly and once', () => {
  assert.strictEqual(E.periodKeyFor('monthly', '2026-08-25'), '2026-08');
  assert.strictEqual(E.periodKeyFor('once', '2026-08-25'), 'once');
});

test('validPeriodKey handles monthly and once', () => {
  assert.strictEqual(E.validPeriodKey('monthly', '2026-08'), true);
  assert.strictEqual(E.validPeriodKey('monthly', '2026-13'), false);
  assert.strictEqual(E.validPeriodKey('monthly', '2026-08-25'), false);
  assert.strictEqual(E.validPeriodKey('once', 'once'), true);
  assert.strictEqual(E.validPeriodKey('once', '2026-08-25'), false);
});

test('claimablePeriodKey is the CURRENT period per cadence', () => {
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'daily' }, '2026-08-25'), '2026-08-25');
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'weekly' }, '2026-06-24'), '2026-W26');
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'monthly' }, '2026-08-25'), '2026-08');
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'once' }, '2026-08-25'), 'once');
});

test('normalizeCategory builds a chore shape and defaults habits to kind habit', () => {
  const chore = E.normalizeCategory({
    kind: 'chore', name: 'Dishes', emoji: '🧹', cadence: 'daily',
    value: '2', assignee: 'SNIC9004@GMAIL.COM', dueDate: '',
    reminderTime: '19:00',
  });
  assert.strictEqual(chore.kind, 'chore');
  assert.strictEqual(chore.id, 'dishes');
  assert.strictEqual(chore.value, 2);
  assert.strictEqual(chore.assignee, 'snic9004@gmail.com');
  assert.strictEqual(chore.dueDate, '');
  assert.strictEqual(chore.active, true);
  assert.strictEqual(chore.rewardIncrement, undefined);

  const habit = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: 0.25, maxPerInstance: 5, freezesPerPeriod: 1 });
  assert.strictEqual(habit.kind, 'habit');
  assert.strictEqual(habit.rewardIncrement, 0.25);
});

test('validateCategory: chore rules', () => {
  const base = { id: 'shed', name: 'Shed', emoji: '', kind: 'chore', cadence: 'once', value: 5, assignee: '', dueDate: '2026-09-30', reminderTime: '' };
  assert.deepStrictEqual(E.validateCategory(base), []);
  assert.ok(E.validateCategory(Object.assign({}, base, { value: 0 })).some((e) => /value/i.test(e)));
  assert.ok(E.validateCategory(Object.assign({}, base, { cadence: 'yearly' })).some((e) => /cadence/i.test(e)));
  assert.ok(E.validateCategory(Object.assign({}, base, { dueDate: '2026-02-31' })).some((e) => /due date/i.test(e)));
  // A due date only makes sense for once-cadence
  assert.ok(E.validateCategory(Object.assign({}, base, { cadence: 'daily', dueDate: '2026-09-30' })).some((e) => /due date/i.test(e)));
  assert.ok(E.validateCategory(Object.assign({}, base, { assignee: 'not-an-email' })).some((e) => /assignee/i.test(e)));
  // Habit validation unchanged
  assert.ok(E.validateCategory(E.normalizeCategory({ name: 'x', cadence: 'daily' })).some((e) => /increment/i.test(e)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Users/Snic9/samsite/.claude/worktrees/amend-past-answers/habits/backend && node --test`
Expected: new tests FAIL (`claimablePeriodKey is not a function`, chore normalize/validate mismatches); the 81 pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `periodKeyFor` (engine.js ~38) replace the body:

```js
function periodKeyFor(cadence, dateStr) {
  if (cadence === 'weekly') return isoWeek(dateStr);
  if (cadence === 'monthly') return String(dateStr).slice(0, 7);
  if (cadence === 'once') return 'once';
  return dateStr;
}
```

In `validPeriodKey` (engine.js ~93), insert before the daily fallthrough:

```js
  if (cadence === 'monthly') {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
  }
  if (cadence === 'once') return key === 'once';
```

After `validPeriodKey`, add:

```js
/**
 * The period a chore claim targets RIGHT NOW. Chores are logged the day
 * they're done, so this is the current period — unlike habits, which record
 * the last closed one.
 */
function claimablePeriodKey(cat, dateStr) {
  return periodKeyFor(cat.cadence, dateStr);
}
```

Rework `normalizeCategory` to branch first:

```js
function normalizeCategory(raw) {
  raw = raw || {};
  if (raw.kind === 'chore') {
    var cadence = raw.cadence === 'weekly' || raw.cadence === 'monthly' || raw.cadence === 'once'
      ? raw.cadence : (raw.cadence === 'daily' ? 'daily' : String(raw.cadence || ''));
    return {
      id: raw.id ? slugify(raw.id) : slugify(raw.name),
      name: String(raw.name || '').trim(),
      emoji: String(raw.emoji || '').trim(),
      kind: 'chore',
      cadence: cadence,
      value: num(raw.value, NaN),
      assignee: String(raw.assignee || '').trim().toLowerCase(),
      dueDate: String(raw.dueDate || '').trim(),
      reminderTime: String(raw.reminderTime || '').trim(),
      active: raw.active !== false,
    };
  }
  return {
    // ...existing habit object literal, unchanged, plus this one line:
    kind: 'habit',
    // (keep every existing field exactly as it is today)
  };
}
```

(Implement by adding `kind: 'habit',` into the existing return object — do not retype the habit fields.)

Rework `validateCategory` to branch:

```js
function validateCategory(cat) {
  var errs = [];
  if (cat.emoji.length > MAX_EMOJI_LENGTH) errs.push('Emoji must be a single symbol.');
  if (!cat.id) errs.push('A name is required (used to build the id).');
  if (!cat.name) errs.push('Name is required.');
  if (cat.kind === 'chore') {
    if (cat.cadence !== 'daily' && cat.cadence !== 'weekly' && cat.cadence !== 'monthly' && cat.cadence !== 'once') {
      errs.push('Chore cadence must be daily, weekly, monthly, or once.');
    }
    if (!(cat.value > 0)) errs.push('Chore value must be a positive number.');
    if (cat.assignee && !/^[^@\s]+@[^@\s]+$/.test(cat.assignee)) errs.push('Assignee must be an email address, or blank for either of you.');
    if (cat.dueDate) {
      if (cat.cadence !== 'once') errs.push('A due date only applies to one-time chores.');
      else if (!validPeriodKey('daily', cat.dueDate)) errs.push('Due date must be a real date like 2026-09-30.');
    }
    if (!isWholeHour(cat.reminderTime)) errs.push('Reminder time must be a whole hour like 21:00, or blank.');
    return errs;
  }
  // ...existing habit checks, unchanged...
  return errs;
}
```

Add to `module.exports`: `claimablePeriodKey: claimablePeriodKey,`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Users/Snic9/samsite/.claude/worktrees/amend-past-answers/habits/backend && node --test`
Expected: ALL PASS.

---

### Task 2: Engine — claim/pot/sweep pure helpers

**Files:**
- Modify: `backend/engine.js` (add after `claimablePeriodKey`; extend `module.exports`)
- Test: `backend/engine.test.js` (append)

**Interfaces:**
- Consumes: `round2`, `isoWeek`, `shiftDays`, `periodKeyDate` (weekly Monday), `claimablePeriodKey`.
- Produces (all exported):
  - `isChoreClaimed(rows, categoryId, periodKey) -> boolean` — a `claim` row exists for that chore+period, ANY actor.
  - `chorePotFor(rows, categoryId, periodKey) -> number` — `round2` of −(sum of that chore+period's `penalty` row amounts); 0 when none.
  - `outstandingChorePeriods(rows, categoryId) -> [{periodKey, pot}]` — periods with penalty rows but no claim row, oldest first.
  - `nextChorePeriodKey(cadence, key) -> string` — the following period: daily `shiftDays(key, 1)`; weekly next ISO week (Monday + 7 days); monthly next month.
  - `chorePenaltyAmounts(cat, allowlist) -> [{actor, amount}]` — the drain for one unclaimed period: shared → `−round2(value/2)` per allowlisted person; assigned → one `−value` on the assignee.
  - `chorePayout(cat, pot) -> number` — `value + pot` for shared, `value` for assigned.

- [ ] **Step 1: Write the failing tests**

```js
// House chores: claim/pot/sweep helpers

const CHORE = { id: 'dishes', name: 'Dishes', kind: 'chore', cadence: 'daily', value: 2, assignee: '', dueDate: '', active: true };
const ACHORE = Object.assign({}, CHORE, { id: 'trash', assignee: 'a@x.com' });
const crow = (type, periodKey, actor, amount) => ({ type, category: 'dishes', periodKey, actor, amount });

test('isChoreClaimed sees any actor and only claim rows', () => {
  const rows = [crow('claim', '2026-08-24', 'b@x.com', 2), crow('penalty', '2026-08-23', 'a@x.com', -1)];
  assert.strictEqual(E.isChoreClaimed(rows, 'dishes', '2026-08-24'), true);
  assert.strictEqual(E.isChoreClaimed(rows, 'dishes', '2026-08-23'), false);
  assert.strictEqual(E.isChoreClaimed(rows, 'other', '2026-08-24'), false);
});

test('chorePotFor sums penalties, outstandingChorePeriods lists unclaimed penalized periods', () => {
  const rows = [
    crow('penalty', '2026-08-22', 'a@x.com', -1), crow('penalty', '2026-08-22', 'b@x.com', -1),
    crow('penalty', '2026-08-23', 'a@x.com', -1), crow('penalty', '2026-08-23', 'b@x.com', -1),
    crow('claim', '2026-08-23', 'b@x.com', 4),
  ];
  assert.strictEqual(E.chorePotFor(rows, 'dishes', '2026-08-22'), 2);
  assert.strictEqual(E.chorePotFor(rows, 'dishes', '2026-08-21'), 0);
  assert.deepStrictEqual(E.outstandingChorePeriods(rows, 'dishes'), [{ periodKey: '2026-08-22', pot: 2 }]);
});

test('nextChorePeriodKey steps each cadence', () => {
  assert.strictEqual(E.nextChorePeriodKey('daily', '2026-08-31'), '2026-09-01');
  assert.strictEqual(E.nextChorePeriodKey('weekly', '2026-W26'), '2026-W27');
  assert.strictEqual(E.nextChorePeriodKey('weekly', '2026-W53'), '2027-W01');
  assert.strictEqual(E.nextChorePeriodKey('monthly', '2026-12'), '2027-01');
});

test('chorePenaltyAmounts: shared halves, assigned full', () => {
  assert.deepStrictEqual(E.chorePenaltyAmounts(CHORE, ['a@x.com', 'b@x.com']),
    [{ actor: 'a@x.com', amount: -1 }, { actor: 'b@x.com', amount: -1 }]);
  assert.deepStrictEqual(E.chorePenaltyAmounts(ACHORE, ['a@x.com', 'b@x.com']),
    [{ actor: 'a@x.com', amount: -2 }]);
});

test('chorePayout: shared collects the pot, assigned only the value', () => {
  assert.strictEqual(E.chorePayout(CHORE, 2), 4);
  assert.strictEqual(E.chorePayout(CHORE, 0), 2);
  assert.strictEqual(E.chorePayout(ACHORE, 2), 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test` — new tests FAIL with `not a function`.

- [ ] **Step 3: Implement**

```js
/* ── house chores ──────────────────────────────────────────────────────── */

/** One claim per period per CHORE, whoever made it. */
function isChoreClaimed(rows, categoryId, periodKey) {
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type === 'claim' && String(r.category) === String(categoryId) &&
        String(r.periodKey) === String(periodKey)) return true;
  }
  return false;
}

/** What an unclaimed period has drained so far — the amount a late claim collects. */
function chorePotFor(rows, categoryId, periodKey) {
  var pot = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type === 'penalty' && String(r.category) === String(categoryId) &&
        String(r.periodKey) === String(periodKey)) pot -= Number(r.amount) || 0;
  }
  return round2(pot);
}

/** Penalized periods still waiting for a doer, oldest first. */
function outstandingChorePeriods(rows, categoryId) {
  var seen = {};
  var keys = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type !== 'penalty' || String(r.category) !== String(categoryId)) continue;
    var k = String(r.periodKey);
    if (!seen[k]) { seen[k] = true; keys.push(k); }
  }
  var out = [];
  keys.sort();
  for (var j = 0; j < keys.length; j++) {
    if (!isChoreClaimed(rows, categoryId, keys[j])) {
      out.push({ periodKey: keys[j], pot: chorePotFor(rows, categoryId, keys[j]) });
    }
  }
  return out;
}

/** The period after `key` — lets the sweep walk closed periods in order. */
function nextChorePeriodKey(cadence, key) {
  if (cadence === 'weekly') return isoWeek(shiftDays(periodKeyDate(key), 7));
  if (cadence === 'monthly') {
    var y = Number(key.slice(0, 4));
    var m = Number(key.slice(5, 7)) + 1;
    if (m > 12) { m = 1; y++; }
    return y + '-' + ('0' + m).slice(-2);
  }
  return shiftDays(key, 1);
}

/** The drain one unclaimed period costs: half each when shared, all on the assignee. */
function chorePenaltyAmounts(cat, allowlist) {
  if (cat.assignee) return [{ actor: cat.assignee, amount: -round2(cat.value) }];
  var half = -round2(cat.value / 2);
  return allowlist.map(function (a) { return { actor: a, amount: half }; });
}

/** A claim's worth: shared chores recover the pot, assigned ones never do. */
function chorePayout(cat, pot) {
  return cat.assignee ? round2(cat.value) : round2(cat.value + pot);
}
```

Exports: `isChoreClaimed`, `chorePotFor`, `outstandingChorePeriods`, `nextChorePeriodKey`, `chorePenaltyAmounts`, `chorePayout`.

- [ ] **Step 4: Run tests to verify they pass** — `node --test`, ALL PASS.

---

### Task 3: Backend — chore state, penalty sweep, category split

**Files:**
- Modify: `backend/main.gs` — storage helpers near `statesAll` (~line 64), `activeCategories` (~line 108), `stateResponse` (~line 453), `emailDispatch` (~line 842), `doSaveCategory` (~line 764), `doUnarchiveCategory`, `doRecord`/`doAmend` kind guards
- Modify: `backend/Code.gs` — regenerate only

**Interfaces:**
- Consumes: Task 1-2 engine helpers; existing `props`, `withLock`, `readLedgerRows`, `appendLedger`, `todayStr`, `deriveWallet`.
- Produces:
  - `choreStatesAll()` / `saveChoreStates(m)` — Script Property `choreStates`: `{ [catId]: { since, sweepFrom } }`.
  - `choreStateOf(cat)` — returns the entry, creating `{ since: claimablePeriodKey(cat, todayStr()), sweepFrom: <same> }` if absent.
  - `activeHabits()` / `activeChores()` — kind-filtered active categories (a category without `kind` counts as a habit).
  - `sweepNeeded()` / `sweepChores(getRows)` — appends penalty rows for closed unclaimed periods and advances `sweepFrom`; once-cadence fires a single penalty after `dueDate` (sweepFrom `'once'` → `'done'`). Runs only over active chores; caller holds the lock.
  - `doRecord`/`doAmend` reject chore categories with 'chores are claimed, not answered — use its card on the dashboard'.

- [ ] **Step 1: Storage + kind splits**

After `saveStatesAll` add:

```js
// Chore bookkeeping is per-CHORE, not per-user: a period is done once, by
// whoever did it. { [catId]: { since, sweepFrom } } — `since` floors
// back-claims, `sweepFrom` is the first period the penalty sweep still owes
// a look. Both are period keys in the chore's own cadence.
function choreStatesAll() {
  var raw = props().getProperty('choreStates');
  return raw ? JSON.parse(raw) : {};
}
function saveChoreStates(m) {
  props().setProperty('choreStates', JSON.stringify(m));
}
function choreStateOf(cat) {
  var m = choreStatesAll();
  if (!m[cat.id]) {
    var cur = claimablePeriodKey(cat, todayStr());
    m[cat.id] = { since: cur, sweepFrom: cur };
    saveChoreStates(m);
  }
  return m[cat.id];
}
```

Replace `activeCategories`'s single use pattern: keep `activeCategories()` as-is, and add:

```js
// A category written before chores existed has no kind — it is a habit.
function isHabit(c) { return c.kind !== 'chore'; }
function activeHabits() { return activeCategories().filter(isHabit); }
function activeChores() { return activeCategories().filter(function (c) { return !isHabit(c); }); }
```

Then change the habit-only call sites to `activeHabits()`: `stateResponse` (`var active = activeCategories();` → `activeHabits()`), and in `emailDispatch` the `cats` used for `maybeRefresh`/`sendCheckup` (reminders are handled in Task 5). Also guard `doRecord` and `doAmend` right after their `categoryById` lookup:

```js
  if (!isHabit(cat)) return { ok: false, error: 'chores are claimed, not answered — use its card on the dashboard' };
```

- [ ] **Step 2: The sweep**

Add after `choreStateOf`:

```js
// Cheap pre-check so stateResponse doesn't take the lock every load.
function sweepNeeded() {
  var chores = activeChores();
  if (!chores.length) return false;
  var m = choreStatesAll();
  var today = todayStr();
  for (var i = 0; i < chores.length; i++) {
    var cat = chores[i];
    var s = m[cat.id];
    if (!s) return true;
    if (cat.cadence === 'once') {
      if (cat.dueDate && today > cat.dueDate && s.sweepFrom !== 'done') return true;
    } else if (s.sweepFrom < claimablePeriodKey(cat, today)) {
      return true;
    }
  }
  return false;
}

// Charge every closed, unclaimed period since the last sweep. Caller holds
// the lock. `getRows` is a lazy memoized reader (same pattern as maybeRefresh)
// — appended penalty rows are also pushed into the memo so a claim that
// follows in the same request sees its pot.
function sweepChores(getRows) {
  var chores = activeChores();
  if (!chores.length) return;
  var m = choreStatesAll();
  var today = todayStr();
  var dirty = false;
  chores.forEach(function (cat) {
    var s = m[cat.id];
    if (!s) { var cur0 = claimablePeriodKey(cat, today); s = m[cat.id] = { since: cur0, sweepFrom: cur0 }; dirty = true; }
    if (cat.cadence === 'once') {
      if (cat.dueDate && today > cat.dueDate && s.sweepFrom !== 'done') {
        if (!isChoreClaimed(getRows(), cat.id, 'once')) applyChorePenalty(cat, 'once', getRows());
        s.sweepFrom = 'done';
        dirty = true;
      }
      return;
    }
    var cur = claimablePeriodKey(cat, today);
    var key = s.sweepFrom;
    var guard = 0;
    while (key < cur && guard++ < 400) {
      if (!isChoreClaimed(getRows(), cat.id, key)) applyChorePenalty(cat, key, getRows());
      key = nextChorePeriodKey(cat.cadence, key);
    }
    if (key !== s.sweepFrom) { s.sweepFrom = key; dirty = true; }
  });
  if (dirty) saveChoreStates(m);
}

// One period's drain: append the penalty rows and keep the in-memory ledger
// in step so later pot math in this request is right.
function applyChorePenalty(cat, periodKey, rows) {
  chorePenaltyAmounts(cat, ALLOWLIST).forEach(function (p) {
    var ev = {
      type: 'penalty', category: cat.id, periodKey: periodKey,
      amount: p.amount, actor: p.actor,
      balanceAfter: round2(deriveWallet(rows, p.actor) + p.amount),
      note: 'Unclaimed: ' + cat.name,
    };
    var id = appendLedger(ev);
    rows.push({ id: id, timestamp: new Date(), type: 'penalty', category: cat.id, periodKey: periodKey, result: '', freezeUsed: false, amount: p.amount, balanceAfter: ev.balanceAfter, actor: p.actor, note: ev.note });
  });
}
```

Wire it in: in `emailDispatch`, inside the existing `withLock(function () { cats.forEach(maybeRefresh); })` block, add a lazy reader and `sweepChores`:

```js
  withLock(function () {
    cats.forEach(maybeRefresh);
    var rows = null;
    sweepChores(function () { if (rows === null) rows = readLedgerRows(); return rows; });
  });
```

In `stateResponse`, extend the existing `refreshNeeded` gate so the locked block also sweeps:

```js
  if (refreshNeeded(email, active) || sweepNeeded()) {
    withLock(function () {
      active.forEach(maybeRefresh);
      var rows0 = null;
      sweepChores(function () { if (rows0 === null) rows0 = readLedgerRows(); return rows0; });
      var mm = statesAll();
      if (ensureCatStates(mm, email, active)) saveStatesAll(mm);
    });
  }
```

- [ ] **Step 3: Category lifecycle**

In `doSaveCategory`, after `saveCategories(list)` succeeds, initialize/reset chore state:

```js
  if (!isHabit(cat)) {
    var cm = choreStatesAll();
    var prev = idx >= 0 ? list[idx] : null; // note: list[idx] is already the NEW cat — capture the OLD one before overwriting
    // A cadence change invalidates period-key bookkeeping — restart at the
    // current period rather than penalizing under a mismatched key format.
    if (!cm[cat.id] || (oldCadence && oldCadence !== cat.cadence)) {
      var cur = claimablePeriodKey(cat, todayStr());
      cm[cat.id] = { since: (cm[cat.id] && cm[cat.id].since) || cur, sweepFrom: cur };
      saveChoreStates(cm);
    }
  }
```

Concretely: capture `var oldCadence = idx >= 0 ? list[idx].cadence : null;` BEFORE the `list[idx] = cat;` assignment, and place this block after `saveCategories(list)`. Also mirror the existing edit-preservation rules for chores: when editing (`idx >= 0`) and `raw.emoji == null` keep the stored emoji, `raw.active == null` keep stored active (the existing lines already do this — verify they run for chores too, they are kind-agnostic).

In `doUnarchiveCategory`, the existing `if (cat) restartPeriod(cat);` is habit logic — make it:

```js
  if (cat && isHabit(cat)) restartPeriod(cat);
  if (cat && !isHabit(cat) && cat.cadence !== 'once') {
    // The archived stretch owes nothing — resume sweeping at the current period.
    var cm = choreStatesAll();
    var s = cm[cat.id] || { since: claimablePeriodKey(cat, todayStr()) };
    s.sweepFrom = claimablePeriodKey(cat, todayStr());
    cm[cat.id] = s;
    saveChoreStates(cm);
  }
```

- [ ] **Step 4: Rebuild and verify**

Run: `cd .../habits/backend && node --test && node build.js && node --input-type=commonjs --check < Code.gs`
Expected: 81+new tests pass (engine untouched in this task — count unchanged from Task 2), build + syntax clean.

---

### Task 4: Backend — claim action and claim-row deletion

**Files:**
- Modify: `backend/main.gs` — `route` (~line 367), new `doClaim` after `doCatHistory`, `doDeleteEntry` (~line 561), `recentLedger` (~line 206)
- Modify: `backend/Code.gs` — regenerate only

**Interfaces:**
- Consumes: Task 2-3 helpers; existing `requireUser`, `categoryById`, `readLedgerRows`, `appendLedger`, `deriveWallet`, `withLock`.
- Produces: HTTP action `claim` (`categoryId`, optional `periodKey`, `token`) → `{ ok, wallet, event: { periodKey, amount, pot } }` or `{ ok: false, error }`. `deleteEntry` accepts own `claim` rows (delete + un-archive once-chores). `recentLedger` marks `claim` rows deletable.

- [ ] **Step 1: `doClaim`**

Route case (inside `route`, after `catHistory`): `case 'claim': return withLock(function () { return doClaim(p); });`

```js
// "I did it" — claim the current period, or back-claim a penalized past one.
function doClaim(p) {
  var email = requireUser(p);
  var cat = categoryById(p.categoryId);
  if (!cat) return { ok: false, error: 'unknown chore' };
  if (isHabit(cat)) return { ok: false, error: 'that\'s a habit — record it with its ✅/❌ buttons' };
  if (!cat.active) return { ok: false, error: 'that chore is archived' };
  if (cat.assignee && cat.assignee !== email) {
    return { ok: false, error: 'that chore is assigned to ' + displayName(cat.assignee) };
  }
  var s = choreStateOf(cat);
  var current = claimablePeriodKey(cat, todayStr());
  var periodKey = p.periodKey ? String(p.periodKey) : current;
  if (!validPeriodKey(cat.cadence, periodKey)) {
    return { ok: false, error: 'that isn\'t a valid period for this chore' };
  }
  if (periodKey > current) return { ok: false, error: 'that period hasn\'t started yet' };
  if (cat.cadence !== 'once' && periodKey < s.since) {
    return { ok: false, error: 'this chore only started being tracked in ' + s.since };
  }
  var rows = null;
  var getRows = function () { if (rows === null) rows = readLedgerRows(); return rows; };
  sweepChores(getRows); // a back-claim's pot must be settled before it pays out
  if (isChoreClaimed(getRows(), cat.id, periodKey)) {
    return { ok: false, error: 'already done — ' + periodKey + ' is claimed' };
  }
  var pot = chorePotFor(getRows(), cat.id, periodKey);
  var amount = chorePayout(cat, pot);
  var wallet = round2(deriveWallet(getRows(), email) + amount);
  appendLedger({
    type: 'claim', category: cat.id, periodKey: periodKey,
    amount: amount, actor: email, balanceAfter: wallet,
  });
  if (cat.cadence === 'once') {
    var list = categoriesAll();
    for (var i = 0; i < list.length; i++) if (list[i].id === cat.id) list[i].active = false;
    saveCategories(list); // done is done — the card disappears
  }
  return { ok: true, wallet: wallet, event: { periodKey: periodKey, amount: amount, pot: pot } };
}
```

- [ ] **Step 2: Deleting a claim**

In `doDeleteEntry`, add a branch before the final spend/deposit fallthrough (mirroring the `entry` branch's position):

```js
  if (match.type === 'claim') {
    var ccat = categoryById(match.category);
    ledgerSheet().deleteRow(match.rowNumber);
    // A once-chore was archived by its claim; taking the claim back reopens it.
    if (ccat && !isHabit(ccat) && ccat.cadence === 'once') {
      var clist = categoriesAll();
      for (var ci = 0; ci < clist.length; ci++) if (clist[ci].id === ccat.id) clist[ci].active = true;
      saveCategories(clist);
    }
    return { ok: true, wallet: walletWithout(rows, email, match.id) };
  }
```

(The existing ownership check earlier in `doDeleteEntry` already restricts this to the claimant's own rows. Penalty rows keep falling through to "that row can't be removed here".)

In `recentLedger`, extend `canDelete`: `r.type === 'spend' || r.type === 'deposit' || r.type === 'entry' || r.type === 'claim'`.

- [ ] **Step 3: Rebuild and verify**

Run: `node --test && node build.js && node --input-type=commonjs --check < Code.gs` — all clean.

---

### Task 5: Backend — dashboard payload, admin data, reminders, runTests

**Files:**
- Modify: `backend/main.gs` — `stateResponse` (~line 453), `doListCategories` (~line 760), `emailDispatch`/`sendReminder` (~line 842-905), `runTests()`
- Modify: `backend/Code.gs` — regenerate only

**Interfaces:**
- Produces:
  - `stateResponse` adds `chores`: array of `{ id, name, emoji, kind: 'chore', cadence, value, assignee, assigneeName, dueDate, claimablePeriodKey, claimedBy, outstanding }` — `claimedBy` is the claimant's display name for the current period or null; `outstanding` from `outstandingChorePeriods` filtered to `periodKey >= since` (`once` chores use the pot on their single period instead). Existing `cats` (habits) unchanged.
  - `doListCategories` adds `people: [{ email, name }]` for the assignee dropdown.
  - Chore reminders: sent at `reminderTime` while the current period (or the once-chore) is unclaimed — to the assignee only, or both when shared; body shows value and outstanding pot total.

- [ ] **Step 1: `stateResponse` chores payload**

After the existing `cats` mapping, add (one ledger read is already available — reuse `rows`):

```js
  var chores = activeChores().map(function (c) {
    var st = choreStateOf(c);
    var current = claimablePeriodKey(c, todayStr());
    var claimant = null;
    for (var i = 0; i < rows.length; i++) {
      var r0 = rows[i];
      if (r0.type === 'claim' && String(r0.category) === c.id && String(r0.periodKey) === current) {
        claimant = displayName(String(r0.actor || '').toLowerCase());
      }
    }
    var outstanding = outstandingChorePeriods(rows, c.id).filter(function (o) {
      return c.cadence === 'once' || o.periodKey >= st.since;
    });
    return {
      id: c.id, name: c.name, emoji: c.emoji, kind: 'chore', cadence: c.cadence,
      value: c.value, assignee: c.assignee, assigneeName: c.assignee ? displayName(c.assignee) : '',
      dueDate: c.dueDate || '', claimablePeriodKey: current,
      claimedBy: claimant, outstanding: outstanding,
    };
  });
  resp.chores = chores;
```

(Place the mapping before `resp` is built, or attach after — either way `resp.chores` is set. `rows` here is the `readLedgerRows()` result `stateResponse` already holds.)

- [ ] **Step 2: `doListCategories` people**

```js
function doListCategories(p) {
  requireUser(p);
  return {
    ok: true, categories: categoriesAll(),
    people: ALLOWLIST.map(function (e) { return { email: e, name: displayName(e) }; }),
  };
}
```

- [ ] **Step 3: Chore reminders**

In `emailDispatch`, after the habit reminder/checkup loop, add:

```js
  activeChores().forEach(function (cat) {
    if (cat.reminderTime && cat.reminderTime === hour) sendChoreReminder(cat);
  });
```

And implement (near `sendReminder`):

```js
function sendChoreReminder(cat) {
  var rows = readLedgerRows();
  var current = claimablePeriodKey(cat, todayStr());
  if (isChoreClaimed(rows, cat.id, current)) return; // done — no nag
  var pot = 0;
  outstandingChorePeriods(rows, cat.id).forEach(function (o) { pot = round2(pot + o.pot); });
  var to = cat.assignee ? [cat.assignee] : ALLOWLIST;
  var subject = (cat.emoji || '🧹') + ' ' + cat.name + ' — ' + money(cat.value) + ' on the line';
  var html =
    '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
    '<h2>' + escapeHtml(cat.emoji || '🧹') + ' ' + escapeHtml(cat.name) + '</h2>' +
    '<p>Doing it pays <b>' + money(cat.value) + '</b>.' +
    (pot > 0 ? ' A pot of <b>' + money(pot) + '</b> is waiting from missed ' + (cat.cadence === 'once' ? 'time' : 'periods') + '.' : '') +
    (cat.dueDate ? '</p><p>Due by <b>' + escapeHtml(cat.dueDate) + '</b>.' : '') + '</p></div>';
  to.forEach(function (addr) { MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html }); });
}
```

- [ ] **Step 4: `runTests()` mirrors**

Add before the final `if (fails.length)`:

```js
  // House chores mirrors
  var chore = { id: 'd', kind: 'chore', cadence: 'daily', value: 2, assignee: '' };
  eq(claimablePeriodKey(chore, '2026-08-25'), '2026-08-25', 'chore claims today');
  eq(claimablePeriodKey({ cadence: 'monthly' }, '2026-08-25'), '2026-08', 'monthly claim key');
  eq(chorePayout(chore, 2), 4, 'shared late claim collects the pot');
  eq(chorePayout({ kind: 'chore', value: 2, assignee: 'a@x' }, 2), 2, 'assigned claim never collects the pot');
  eq(chorePenaltyAmounts(chore, ['a', 'b']).length, 2, 'shared penalty drains both');
  eq(nextChorePeriodKey('monthly', '2026-12'), '2027-01', 'monthly period walk crosses the year');
```

- [ ] **Step 5: Rebuild and verify** — `node --test && node build.js && node --input-type=commonjs --check < Code.gs`, all clean.

---

### Task 6: Frontend — admin form for chores

**Files:**
- Modify: `index.html` (admin `catForm`, ~line 107-184)
- Modify: `js/app.js` (`showAdmin` ~line where `listCategories` is called, `editCat`, `resetCatForm`, `catForm` submit)

**Interfaces:**
- Consumes: `listCategories` response now carries `people` (Task 5); `saveCategory` accepts chore fields (Task 1 normalize).
- Produces: a kind selector that toggles habit/chore field groups; chore fields `catValue`, `catAssignee`, `catDueDate`; `catCadence` gains monthly/once options when kind=chore.

- [ ] **Step 1: HTML**

In `index.html`'s `catForm`, insert after the name field:

```html
          <div class="field">
            <label class="field-label" for="catKind">Type</label>
            <select id="catKind">
              <option value="habit">Habit — you each build a streak</option>
              <option value="chore">Chore — one of you does it, they get paid</option>
            </select>
          </div>
```

Wrap the existing habit-only fields (`catIncrement`/`catMax` grid, `catMinPayout`, the payout hint, freezes, `catBonus`, `catMissPenalty`, and the `catCheckup` half of the email grid) in `<div id="habitFields">…</div>`. Add after it:

```html
          <div id="choreFields" hidden>
            <div class="grid2">
              <div class="field">
                <label class="field-label" for="catValue">Value per claim ($)</label>
                <input id="catValue" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="2.00" />
              </div>
              <div class="field">
                <label class="field-label" for="catAssignee">Who does it</label>
                <select id="catAssignee"><option value="">Either of you</option></select>
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="catDueDate">Due date (one-time chores)</label>
              <input id="catDueDate" type="date" />
              <p class="hint">Miss it and the value drains from the wallet(s) — whoever finally does it collects the pot (shared chores only).</p>
            </div>
          </div>
```

Change the cadence select to carry all four options with kind-scoped classes:

```html
            <select id="catCadence">
              <option value="daily">Every day</option>
              <option value="weekly">Once a week</option>
              <option value="monthly" class="chore-cadence" hidden>Once a month</option>
              <option value="once" class="chore-cadence" hidden>One time</option>
            </select>
```

- [ ] **Step 2: app.js wiring**

In `showAdmin`, after `renderCatList(r.categories)`, populate the assignee dropdown:

```js
    const asel = $('catAssignee');
    asel.innerHTML = '<option value="">Either of you</option>';
    (r.people || []).forEach((p) => {
      asel.innerHTML += '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>';
    });
```

Add a kind-toggle helper and wire it (in `wire()` or `showAdmin`):

```js
function applyKindToForm(kind) {
  const chore = kind === 'chore';
  $('habitFields').hidden = chore;
  $('choreFields').hidden = !chore;
  document.querySelectorAll('#catCadence option.chore-cadence').forEach((o) => { o.hidden = !chore; });
  if (!chore && ($('catCadence').value === 'monthly' || $('catCadence').value === 'once')) {
    $('catCadence').value = 'daily';
  }
  // Hidden habit fields must not block submit while adding a chore.
  document.querySelectorAll('#habitFields input').forEach((i) => { i.required = !chore && i.dataset.req === '1'; });
}
```

One-time setup in `wire()`: tag the habit inputs that are required today so the toggle can restore them —

```js
  document.querySelectorAll('#habitFields input[required]').forEach((i) => { i.dataset.req = '1'; });
  $('catKind').addEventListener('change', () => applyKindToForm($('catKind').value));
```

`resetCatForm` ends with `applyKindToForm($('catKind').value = 'habit');` — reset to habit mode. `editCat(c)` starts with `$('catKind').value = c.kind === 'chore' ? 'chore' : 'habit'; applyKindToForm($('catKind').value);` and, for chores, fills `$('catValue').value = c.value; $('catAssignee').value = c.assignee || ''; $('catDueDate').value = c.dueDate || ''; $('catCadence').value = c.cadence; $('catReminder').value = c.reminderTime || '';` (skip the habit-field fills for chores — guard the existing lines with `if (c.kind !== 'chore') { ...existing fills... }`).

The `catForm` submit handler builds the object by kind:

```js
    const kind = $('catKind').value;
    const category = kind === 'chore'
      ? {
          id: $('catId').value || undefined, kind: 'chore',
          name: $('catName').value, emoji: $('catEmoji').value,
          cadence: $('catCadence').value, value: $('catValue').value,
          assignee: $('catAssignee').value, dueDate: $('catDueDate').value,
          reminderTime: $('catReminder').value,
        }
      : { /* existing habit object literal, unchanged */ };
```

- [ ] **Step 3: Verify** — `node --check js/app.js` clean.

---

### Task 7: Frontend — chore cards and ledger rendering

**Files:**
- Modify: `js/app.js` — `render` (~line 92), new `renderChoreCards`, `describe` (~line ~139), `deleteEntry` wording untouched
- Modify: `css/style.css` (append)

**Interfaces:**
- Consumes: `state` response `chores` array (Task 5 shape); `claim` action (Task 4); existing `banner`, `money`, `esc`, `setBusy`/`inFlight`, `showDashboard`.
- Produces: chores section on the dashboard; `describe` renders `claim` (🧹) and `penalty` (⚠️) rows.

- [ ] **Step 1: `describe` cases**

In `describe(e)` add before the `entry` branch:

```js
  if (e.type === 'claim') return '🧹 Did it: ' + esc(e.categoryName || e.category);
  if (e.type === 'penalty') return '⚠️ ' + esc(e.note || ('Unclaimed: ' + (e.categoryName || e.category)));
```

(`amountCell` already renders negative amounts as `−$x.xx`.)

- [ ] **Step 2: Chore cards**

In `render(r)` add `renderChoreCards(r.chores || []);` after `renderCatCards`. Add a `<div id="choreCards"></div>` to `index.html` right after `<div id="catCards"></div>`. Implement:

```js
function renderChoreCards(chores) {
  const wrap = $('choreCards');
  wrap.innerHTML = '';
  chores.forEach((c) => {
    const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
    const who = c.assignee ? esc(c.assigneeName) : 'either of you';
    const cadence = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', once: 'One-time' }[c.cadence] || c.cadence;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h2>' + (c.emoji ? esc(c.emoji) + ' ' : '🧹 ') + esc(c.name) + '</h2>' +
      '<div class="prow">' +
      '<div><span class="label">Worth</span><span class="pval">' + money(c.value) + '</span></div>' +
      '<div><span class="label">Who</span><span class="pval">' + who + '</span></div>' +
      (c.dueDate ? '<div><span class="label">Due</span><span class="pval">' + esc(c.dueDate) + '</span></div>' : '') +
      '</div>' +
      (c.claimedBy
        ? '<p class="chore-done">✓ ' + esc(c.claimedBy) + (c.cadence === 'daily' ? ', today' : '') + '</p>'
        : '<div class="row" style="margin-top:8px"><button class="ok" data-claim>✋ I did it</button></div>') +
      '<p class="muted">' + cadence + (c.cadence === 'once' ? '' : ' • this period: ' + esc(c.claimablePeriodKey)) + '</p>' +
      (c.outstanding.length
        ? '<details class="catch-up"><summary>💰 Catch up — ' + c.outstanding.length +
          ' missed, ' + money(c.outstanding.reduce((s, o) => s + o.pot, 0)) + ' in the pot</summary>' +
          c.outstanding.map((o) =>
            '<div class="row catch-row"><span class="muted">' + esc(o.periodKey) + '</span>' +
            '<button class="ok" data-claim-past="' + esc(o.periodKey) + '">Claim ' +
            money(c.assignee ? c.value : c.value + o.pot) + '</button></div>').join('') +
          '</details>'
        : '');
    wrap.appendChild(card);
    const claim = async (periodKey) => {
      if (inFlight) return;
      setBusy(true);
      banner('Saving…', false);
      try {
        const r = await api('claim', periodKey ? { categoryId: c.id, periodKey } : { categoryId: c.id });
        if (!r.ok) { banner(r.error || 'Could not claim', true); return; }
        if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
        banner('🧹 ' + label + ' — +' + money(r.event.amount) +
          (r.event.pot > 0 ? ' (includes the ' + money(r.event.pot) + ' pot)' : '') + '.', false);
        await showDashboard(true);
      } catch (err) { banner(err.message, true); } finally { setBusy(false); }
    };
    const btn = card.querySelector('button[data-claim]');
    if (btn) btn.addEventListener('click', () => claim(null));
    card.querySelectorAll('button[data-claim-past]').forEach((b) =>
      b.addEventListener('click', () => claim(b.getAttribute('data-claim-past'))));
  });
}
```

Note: `setBusy` selects `#catCards button, #ledger button` — extend that selector to `'#catCards button, #choreCards button, #ledger button'`.

The claim button for assigned chores that aren't yours: the backend rejects with a clear error, and the UI shows the card without hiding the button only for the assignee — implement by comparing nothing client-side (the client doesn't know its own email); instead the backend-provided error banner covers the rare mis-tap. (Documented simplification.)

- [ ] **Step 3: CSS**

Append to `css/style.css`:

```css
.chore-done {
  margin: 8px 0 0;
  font-weight: 600;
}
.catch-up {
  margin-top: 10px;
}
.catch-up summary {
  cursor: pointer;
  font-size: 14px;
  opacity: 0.8;
}
.catch-up .catch-row {
  margin-top: 8px;
  justify-content: space-between;
  align-items: center;
}
```

- [ ] **Step 4: Verify** — `node --check js/app.js` clean.

---

### Task 8: Verification

- [ ] **Step 1:** `cd .../habits/backend && node --test && node build.js && node --input-type=commonjs --check < Code.gs && node --check ../js/app.js` — all clean.
- [ ] **Step 2:** Extend the simulation harness (scratchpad `sim/`) with chore scenarios: on-time shared claim pays value; unclaimed daily period sweeps −value/2 each; late back-claim collects pot+value (shared) and value-only (assigned); assigned miss drains the assignee alone; double-claim rejected; assignee enforcement; once-chore with due date — claim archives, delete un-archives, overdue penalty then late claim; monthly key walk; habits regression (all prior scenarios still pass).
- [ ] **Step 3:** Report: all changes uncommitted; deploy = paste `Code.gs` + redeploy (no `setup()`; `choreStates` property is created lazily).
