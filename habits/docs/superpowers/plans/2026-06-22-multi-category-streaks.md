# Multi-Category Streaks + Add-Money Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the single hard-coded "Sleep Streak" into a configurable multi-category streak engine (any category with its own rules, freezes, cadence, bonus, and emails) plus an Add-money action that credits both people's shared wallet by the full amount.

**Architecture:** All reward rules become per-**category** config objects edited in an in-app admin UI and stored in Apps Script Properties. The pure engine in `backend/engine.js` is parameterized by a category's rules and operates on a per-category state slice while crediting a single shared per-person wallet. `backend/Code.gs` mirrors the engine and adds routes (`record` w/ categoryId, `spend`, `deposit`, `listCategories`, `saveCategory`, `archiveCategory`) and one hourly `emailDispatch` trigger. The frontend (`index.html`, `js/app.js`) renders a wallet card, one record-card per active category, an Add-money form, and a Categories admin view.

**Tech Stack:** Vanilla JS (no framework), Google Apps Script backend, JSONP transport, `node --test` for engine unit tests. Deployed as a subfolder copy to `../sleep/` (samsite repo → GitHub Pages).

## Global Constraints

- **Single source of truth for rules:** all reward logic lives in `backend/engine.js` (unit-tested) and is mirrored verbatim into `backend/Code.gs`. Never let the two diverge in behavior.
- **No new dependencies, no build step, no framework.** Vanilla JS only; `var`/ES5-compatible style in `engine.js` and `Code.gs` (Apps Script runs them; `engine.js` is also `require`d by Node tests).
- **Shared wallet:** balance is a single number per person, separate from category state. Categories never hold balance.
- **Add-money credits the FULL amount to EACH allowlisted person** (not split).
- **Whole-hour email times only** (`"HH:00"`, or blank = off).
- **Git policy:** the repo owner runs all `git commit`/`git push`. Where a step says "Stage", run only the listed `git add` and stop — do **not** commit or push.
- **Money math:** always pass values through `round2()`; balances floor at $0 on spend.
- **Currency/UI copy:** money formatted as `$0.00`; categories identified by `emoji` + `name`.

---

## File Structure

- `backend/engine.js` — **Modify.** Replace file-level constants with category-parameterized pure functions: `round2`, `payout`, `periodKeyFor`, `isoWeek`, `initialCatState`, `applyEntry`, `applyRefresh`, `applySpend`, `applyDeposit`, `validateCategory`.
- `backend/engine.test.js` — **Modify.** Extend `node --test` coverage for the parameterized engine.
- `backend/Code.gs` — **Modify.** Mirror the engine; migrate state to per-category; add category storage + CRUD routes; add `deposit` route; generalize `record`/`spend`/`state`; replace 3 email triggers with one `emailDispatch`.
- `index.html` — **Modify.** Add wallet card, per-category record cards container, Add-money form, Categories admin view, nav between dash/admin.
- `js/app.js` — **Modify.** Render per-category cards + wallet, Add-money flow, category CRUD UI, generalized check-in flow carrying `categoryId`.
- `css/style.css` — **Modify.** Minor styles for category cards / admin form (reuse existing classes where possible).
- `README.md` — **Modify.** Document categories, add-money, the hourly dispatcher, and the new deploy copy list.

---

### Task 1: Parameterized payout + period keys (engine)

**Files:**
- Modify: `backend/engine.js`
- Test: `backend/engine.test.js`

**Interfaces:**
- Produces:
  - `round2(n) -> number`
  - `payout(cat, streak) -> number` where `cat = {rewardIncrement:number, maxPerInstance:number}`
  - `isoWeek(dateStr) -> string` (e.g. `"2026-W25"`), `dateStr` is `"YYYY-MM-DD"`
  - `periodKeyFor(cadence, dateStr) -> string` where `cadence ∈ {"daily","weekly"}` (daily → `dateStr`, weekly → `isoWeek(dateStr)`)

- [ ] **Step 1: Write the failing tests**

Add to `backend/engine.test.js` (keep existing `require` line; add cases):

```js
const test = require('node:test');
const assert = require('node:assert');
const E = require('./engine.js');

test('payout scales by increment and caps at maxPerInstance', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0 };
  assert.strictEqual(E.payout(cat, 1), 0.25);
  assert.strictEqual(E.payout(cat, 4), 1.0);
  assert.strictEqual(E.payout(cat, 20), 5.0);
  assert.strictEqual(E.payout(cat, 40), 5.0);
});

test('payout honors a different increment/cap', () => {
  const cat = { rewardIncrement: 1.0, maxPerInstance: 3.0 };
  assert.strictEqual(E.payout(cat, 2), 2.0);
  assert.strictEqual(E.payout(cat, 5), 3.0);
});

test('periodKeyFor daily returns the date; weekly returns ISO week', () => {
  assert.strictEqual(E.periodKeyFor('daily', '2026-06-22'), '2026-06-22');
  // 2026-06-22 is a Monday → ISO week 26 of 2026
  assert.strictEqual(E.periodKeyFor('weekly', '2026-06-22'), '2026-W26');
  // 2026-06-21 is the Sunday of the prior ISO week (week 25)
  assert.strictEqual(E.periodKeyFor('weekly', '2026-06-21'), '2026-W25');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test`
Expected: FAIL — `E.payout is not a function` (and `periodKeyFor`).

- [ ] **Step 3: Implement in `backend/engine.js`**

At the top of `engine.js`, **remove** `DAILY_STEP`, `PAYOUT_CAP`, `WEEKLY_BONUS` constants and `nightlyPayout`. Keep `round2`. Add:

```js
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** On-time payout for a given streak under a category's rules. */
function payout(cat, streak) {
  return round2(Math.min(cat.rewardIncrement * streak, cat.maxPerInstance));
}

/** ISO-8601 week string, e.g. "2026-W26", for a "YYYY-MM-DD" date. */
function isoWeek(dateStr) {
  var p = dateStr.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  var day = d.getUTCDay() || 7; // 1=Mon..7=Sun
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + ('0' + weekNo).slice(-2);
}

/** Record-cadence key used to dedupe entries within a period. */
function periodKeyFor(cadence, dateStr) {
  return cadence === 'weekly' ? isoWeek(dateStr) : dateStr;
}
```

- [ ] **Step 4: Update the exports block** at the bottom of `engine.js`

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    round2: round2,
    payout: payout,
    isoWeek: isoWeek,
    periodKeyFor: periodKeyFor,
    // (more added in later tasks)
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test`
Expected: PASS for the three new tests. (Old `nightlyPayout` tests will fail — they're rewritten in Task 2/3; if any remain, delete the obsolete ones now.)

- [ ] **Step 6: Stage changes**

```bash
git add backend/engine.js backend/engine.test.js
```

---

### Task 2: `applyEntry` + `applyRefresh` with integer freezes and optional bonus (engine)

**Files:**
- Modify: `backend/engine.js`
- Test: `backend/engine.test.js`

**Interfaces:**
- Consumes: `round2`, `payout` (Task 1).
- Produces:
  - `initialCatState(cat, periodStart) -> {streak, periodStart, freezeAvailable, freezeUsedThisPeriod, lastRecordedKey}`
  - `applyEntry(state, balance, cat, input) -> {state, balance, event}` where `input = {periodKey, result, actor}`, `result ∈ {"on_time","missed"}`; throws on missing `periodKey`, bad `result`, or `state.lastRecordedKey === periodKey`.
  - `applyRefresh(state, balance, cat, newPeriodStart) -> {state, balance, event|null}`
  - `event` for entries: `{type:'entry', category, periodKey, result, freezeUsed, amount, balanceAfter, actor}`; for refresh bonus: `{type:'bonus', category, amount, note, actor, balanceAfter}`.
- `cat` fields used: `id`, `rewardIncrement`, `maxPerInstance`, `freezesPerPeriod`, `unusedFreezeBonus`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/engine.test.js`:

```js
const CAT = {
  id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0,
  freezesPerPeriod: 1, unusedFreezeBonus: 3.5,
};

test('on_time increments streak and credits the wallet', () => {
  const s0 = E.initialCatState(CAT, '2026-06-22');
  const r = E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', result: 'on_time', actor: 'a' });
  assert.strictEqual(r.state.streak, 1);
  assert.strictEqual(r.balance, 0.25);
  assert.strictEqual(r.event.type, 'entry');
  assert.strictEqual(r.event.category, 'sleep');
  assert.strictEqual(r.event.amount, 0.25);
  assert.strictEqual(r.event.balanceAfter, 0.25);
});

test('missed with a freeze preserves streak, decrements freeze, pays nothing', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 5);
  assert.strictEqual(r.state.freezeAvailable, 0);
  assert.strictEqual(r.state.freezeUsedThisPeriod, true);
  assert.strictEqual(r.balance, 3.75);
  assert.strictEqual(r.event.freezeUsed, true);
});

test('missed with no freeze resets streak to 0', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezeAvailable: 0, freezeUsedThisPeriod: false, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.balance, 3.75);
});

test('a category with 2 freezes absorbs two misses before resetting', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  // Start with a streak of 7 so we can prove freezes preserve it.
  let s = { streak: 7, periodStart: 'P', freezeAvailable: 2, freezeUsedThisPeriod: false, lastRecordedKey: null };
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // first freeze preserves streak
  assert.strictEqual(s.freezeAvailable, 1);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // second freeze preserves streak
  assert.strictEqual(s.freezeAvailable, 0);
  const r = E.applyEntry(s, 0, cat2, { periodKey: 'k3', result: 'missed' });
  assert.strictEqual(r.state.streak, 0); // out of freezes -> reset
});

test('double-recording the same period is rejected', () => {
  const s = { streak: 1, periodStart: 'P', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: '2026-06-22' };
  assert.throws(() => E.applyEntry(s, 0, CAT, { periodKey: '2026-06-22', result: 'on_time' }), /already recorded/);
});

test('refresh awards bonus when no freeze used and resets freezes', () => {
  const s = { streak: 3, periodStart: 'P1', freezeAvailable: 0, freezeUsedThisPeriod: false, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2');
  assert.strictEqual(r.balance, 13.5);
  assert.strictEqual(r.event.type, 'bonus');
  assert.strictEqual(r.state.freezeAvailable, 1);
  assert.strictEqual(r.state.periodStart, 'P2');
});

test('refresh gives no bonus (and no event) when a freeze was used', () => {
  const s = { streak: 3, periodStart: 'P1', freezeAvailable: 0, freezeUsedThisPeriod: true, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2');
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});

test('refresh gives no bonus when unusedFreezeBonus is 0', () => {
  const catNoBonus = Object.assign({}, CAT, { unusedFreezeBonus: 0 });
  const s = { streak: 3, periodStart: 'P1', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, catNoBonus, 'P2');
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test`
Expected: FAIL — `E.applyEntry is not a function`.

- [ ] **Step 3: Implement in `backend/engine.js`**

```js
function initialCatState(cat, periodStart) {
  return {
    streak: 0,
    periodStart: periodStart || null,
    freezeAvailable: cat.freezesPerPeriod,
    freezeUsedThisPeriod: false,
    lastRecordedKey: null,
  };
}

/**
 * Record one entry for a category. Credits the shared wallet `balance`.
 * @returns {{state:object, balance:number, event:object}}
 */
function applyEntry(state, balance, cat, input) {
  var periodKey = input.periodKey;
  var result = input.result;
  var actor = input.actor || '';
  if (!periodKey) throw new Error('periodKey is required');
  if (result !== 'on_time' && result !== 'missed') {
    throw new Error('result must be "on_time" or "missed"');
  }
  if (state.lastRecordedKey === periodKey) {
    throw new Error('period ' + periodKey + ' already recorded');
  }
  var s = Object.assign({}, state);
  var amount = 0;
  var freezeUsed = false;
  if (result === 'on_time') {
    s.streak = state.streak + 1;
    amount = payout(cat, s.streak);
    balance = round2(balance + amount);
  } else if (state.freezeAvailable > 0) {
    s.freezeAvailable = state.freezeAvailable - 1;
    s.freezeUsedThisPeriod = true;
    freezeUsed = true;
  } else {
    s.streak = 0;
  }
  s.lastRecordedKey = periodKey;
  var event = {
    type: 'entry',
    category: cat.id,
    periodKey: periodKey,
    result: result,
    freezeUsed: freezeUsed,
    amount: amount,
    balanceAfter: balance,
    actor: actor,
  };
  return { state: s, balance: balance, event: event };
}

/**
 * Period rollover: award the unused-freeze bonus (if configured and earned),
 * then refresh freezes for the new period.
 * @returns {{state:object, balance:number, event:(object|null)}}
 */
function applyRefresh(state, balance, cat, newPeriodStart) {
  var s = Object.assign({}, state);
  var event = null;
  if (cat.unusedFreezeBonus > 0 && !state.freezeUsedThisPeriod) {
    balance = round2(balance + cat.unusedFreezeBonus);
    event = {
      type: 'bonus',
      category: cat.id,
      amount: cat.unusedFreezeBonus,
      note: 'Unused freeze bonus',
      actor: 'system',
      balanceAfter: balance,
    };
  }
  s.freezeAvailable = cat.freezesPerPeriod;
  s.freezeUsedThisPeriod = false;
  s.periodStart = newPeriodStart;
  return { state: s, balance: balance, event: event };
}
```

Add `initialCatState`, `applyEntry`, `applyRefresh` to the `module.exports` block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test`
Expected: PASS (all Task 2 tests).

- [ ] **Step 5: Stage changes**

```bash
git add backend/engine.js backend/engine.test.js
```

---

### Task 3: `applySpend` + `applyDeposit` on the shared wallet (engine)

**Files:**
- Modify: `backend/engine.js`
- Test: `backend/engine.test.js`

**Interfaces:**
- Consumes: `round2` (Task 1).
- Produces:
  - `applySpend(balance, input) -> {balance, event}` where `input = {amount, note, actor}`; throws if `amount <= 0`; floors at 0; event `{type:'spend', amount, note, actor, balanceAfter}`.
  - `applyDeposit(balance, input) -> {balance, event}` where `input = {amount, note, actor}`; throws if `amount <= 0`; event `{type:'deposit', amount, note, actor, balanceAfter}`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/engine.test.js`:

```js
test('spend subtracts from the wallet and floors at 0', () => {
  assert.strictEqual(E.applySpend(10, { amount: 4 }).balance, 6);
  assert.strictEqual(E.applySpend(3, { amount: 5 }).balance, 0);
  assert.throws(() => E.applySpend(10, { amount: 0 }), /positive/);
  const ev = E.applySpend(10, { amount: 4, note: 'snack', actor: 'a' }).event;
  assert.strictEqual(ev.type, 'spend');
  assert.strictEqual(ev.balanceAfter, 6);
});

test('deposit adds to the wallet', () => {
  const r = E.applyDeposit(10, { amount: 20, note: 'allowance', actor: 'a' });
  assert.strictEqual(r.balance, 30);
  assert.strictEqual(r.event.type, 'deposit');
  assert.strictEqual(r.event.balanceAfter, 30);
  assert.throws(() => E.applyDeposit(10, { amount: -1 }), /positive/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test`
Expected: FAIL — `E.applySpend`/`E.applyDeposit` signature mismatch or not a function.

- [ ] **Step 3: Implement in `backend/engine.js`** (replace the old `applySpend` that took `state`)

```js
function applySpend(balance, input) {
  var requested = round2(input.amount);
  if (!(requested > 0)) throw new Error('spend amount must be positive');
  var newBalance = round2(Math.max(0, balance - requested));
  var event = {
    type: 'spend',
    amount: requested,
    note: input.note || '',
    actor: input.actor || '',
    balanceAfter: newBalance,
  };
  return { balance: newBalance, event: event };
}

function applyDeposit(balance, input) {
  var requested = round2(input.amount);
  if (!(requested > 0)) throw new Error('deposit amount must be positive');
  var newBalance = round2(balance + requested);
  var event = {
    type: 'deposit',
    amount: requested,
    note: input.note || '',
    actor: input.actor || '',
    balanceAfter: newBalance,
  };
  return { balance: newBalance, event: event };
}
```

Add both to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test`
Expected: PASS.

- [ ] **Step 5: Stage changes**

```bash
git add backend/engine.js backend/engine.test.js
```

---

### Task 4: Category validation + defaults (engine)

**Files:**
- Modify: `backend/engine.js`
- Test: `backend/engine.test.js`

**Interfaces:**
- Produces:
  - `normalizeCategory(raw) -> cat` — coerces/normalizes a raw form object into a clean category with numeric fields and a slugified `id`.
  - `validateCategory(cat) -> string[]` — returns an array of human-readable error messages (empty array = valid).
- Category shape: `{id, name, emoji, cadence, rewardIncrement, maxPerInstance, freezesPerPeriod, freezeRefresh, unusedFreezeBonus, reminderTime, checkupTime, active}`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/engine.test.js`:

```js
test('normalizeCategory slugifies id and coerces numbers', () => {
  const c = E.normalizeCategory({
    name: 'Morning Run!', emoji: '🏃', cadence: 'daily',
    rewardIncrement: '0.50', maxPerInstance: '4', freezesPerPeriod: '2',
    freezeRefresh: 'weekly', unusedFreezeBonus: '', reminderTime: '21:00',
    checkupTime: '', active: true,
  });
  assert.strictEqual(c.id, 'morning-run');
  assert.strictEqual(c.rewardIncrement, 0.5);
  assert.strictEqual(c.maxPerInstance, 4);
  assert.strictEqual(c.freezesPerPeriod, 2);
  assert.strictEqual(c.unusedFreezeBonus, 0); // blank -> 0 (no bonus)
  assert.strictEqual(c.reminderTime, '21:00');
  assert.strictEqual(c.checkupTime, '');
});

test('validateCategory flags bad input', () => {
  const bad = E.normalizeCategory({ name: '', cadence: 'monthly', rewardIncrement: '-1', maxPerInstance: '0', freezesPerPeriod: '-2', freezeRefresh: 'weekly', reminderTime: '9:30', checkupTime: '' });
  const errs = E.validateCategory(bad);
  assert.ok(errs.some((e) => /name/i.test(e)));
  assert.ok(errs.some((e) => /cadence/i.test(e)));
  assert.ok(errs.some((e) => /increment/i.test(e)));
  assert.ok(errs.some((e) => /max/i.test(e)));
  assert.ok(errs.some((e) => /freeze/i.test(e)));
  assert.ok(errs.some((e) => /time/i.test(e))); // 9:30 is not a whole hour
});

test('validateCategory passes a good category', () => {
  const good = E.normalizeCategory({ name: 'Sleep', emoji: '🌙', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', freezeRefresh: 'weekly', unusedFreezeBonus: '3.5', reminderTime: '21:00', checkupTime: '09:00', active: true });
  assert.deepStrictEqual(E.validateCategory(good), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test`
Expected: FAIL — `E.normalizeCategory is not a function`.

- [ ] **Step 3: Implement in `backend/engine.js`**

```js
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function num(v, dflt) {
  var n = Number(v);
  return isNaN(n) ? dflt : n;
}

/** Whole-hour "HH:00" or "" (off). */
function isWholeHour(t) {
  return t === '' || /^([01]\d|2[0-3]):00$/.test(t);
}

function normalizeCategory(raw) {
  raw = raw || {};
  return {
    id: raw.id ? slugify(raw.id) : slugify(raw.name),
    name: String(raw.name || '').trim(),
    emoji: String(raw.emoji || '').trim(),
    cadence: raw.cadence === 'weekly' ? 'weekly' : (raw.cadence === 'daily' ? 'daily' : String(raw.cadence || '')),
    rewardIncrement: num(raw.rewardIncrement, NaN),
    maxPerInstance: num(raw.maxPerInstance, NaN),
    freezesPerPeriod: num(raw.freezesPerPeriod, NaN),
    freezeRefresh: raw.freezeRefresh === 'daily' ? 'daily' : 'weekly',
    unusedFreezeBonus: raw.unusedFreezeBonus === '' || raw.unusedFreezeBonus == null ? 0 : num(raw.unusedFreezeBonus, 0),
    reminderTime: String(raw.reminderTime || '').trim(),
    checkupTime: String(raw.checkupTime || '').trim(),
    active: raw.active !== false,
  };
}

function validateCategory(cat) {
  var errs = [];
  if (!cat.id) errs.push('A name is required (used to build the id).');
  if (!cat.name) errs.push('Name is required.');
  if (cat.cadence !== 'daily' && cat.cadence !== 'weekly') errs.push('Cadence must be daily or weekly.');
  if (!(cat.rewardIncrement > 0)) errs.push('Reward increment must be a positive number.');
  if (!(cat.maxPerInstance > 0)) errs.push('Max per instance must be a positive number.');
  if (!(cat.freezesPerPeriod >= 0) || cat.freezesPerPeriod % 1 !== 0) errs.push('Freezes per period must be a whole number (0 or more).');
  if (!(cat.unusedFreezeBonus >= 0)) errs.push('Unused-freeze bonus must be 0 or more.');
  if (!isWholeHour(cat.reminderTime)) errs.push('Reminder time must be a whole hour like 21:00, or blank.');
  if (!isWholeHour(cat.checkupTime)) errs.push('Check-up time must be a whole hour like 09:00, or blank.');
  return errs;
}
```

Add `normalizeCategory` and `validateCategory` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test`
Expected: PASS. Confirm the full suite is green: all Tasks 1–4 tests pass.

- [ ] **Step 5: Stage changes**

```bash
git add backend/engine.js backend/engine.test.js
```

---

### Task 5: Mirror engine + per-category state model into `Code.gs`

**Files:**
- Modify: `backend/Code.gs`

**Interfaces:**
- Consumes: the finalized engine functions (Tasks 1–4), pasted verbatim.
- Produces (Apps Script globals): `payout`, `isoWeek`, `periodKeyFor`, `initialCatState`, `applyEntry`, `applyRefresh`, `applySpend`, `applyDeposit`, `normalizeCategory`, `validateCategory`; storage helpers `walletOf(email)`, `saveWallet(email, n)`, `catStateOf(email, catId, cat)`, `saveCatState(email, catId, s)`, `categoriesAll()`, `saveCategories(list)`, `activeCategories()`.

> Code.gs is not unit-tested by Node; verify via the in-editor `runTests()` (Step 4) and later manual deploy.

- [ ] **Step 1: Replace the REWARD ENGINE section of `Code.gs`**

Delete the current constants (`DAILY_STEP`, `PAYOUT_CAP`, `WEEKLY_BONUS`), `nightlyPayout`, `initialState`, `applyNight`, `applySpend`, `applyWeeklyRollover`. Paste the **exact bodies** of `round2`, `payout`, `isoWeek`, `periodKeyFor`, `initialCatState`, `applyEntry`, `applyRefresh`, `applySpend`, `applyDeposit`, `slugify`, `num`, `isWholeHour`, `normalizeCategory`, `validateCategory` from `engine.js` (Tasks 1–4). Omit the `module.exports` block (no-op in Apps Script but cleaner to drop).

- [ ] **Step 2: Replace the STORAGE section** (state model migration)

Replace `statesAll`/`loadState`/`saveState`/`publicState` with a wallet + per-category model:

```js
// states[email] = { balance:Number, cats: { [catId]: catState } }
function statesAll() {
  var raw = props().getProperty('states');
  return raw ? JSON.parse(raw) : {};
}
function saveStatesAll(m) {
  props().setProperty('states', JSON.stringify(m));
}
function personRecord(email) {
  var m = statesAll();
  if (!m[email]) { m[email] = { balance: 0, cats: {} }; saveStatesAll(m); }
  if (!m[email].cats) { m[email].cats = {}; saveStatesAll(m); }
  return m[email];
}
function walletOf(email) { return personRecord(email).balance || 0; }
function saveWallet(email, n) {
  var m = statesAll();
  if (!m[email]) m[email] = { balance: 0, cats: {} };
  m[email].balance = round2(n);
  saveStatesAll(m);
}
function catStateOf(email, catId, cat) {
  var m = statesAll();
  if (!m[email]) m[email] = { balance: 0, cats: {} };
  if (!m[email].cats[catId]) {
    m[email].cats[catId] = initialCatState(cat, currentPeriodStart(cat));
    saveStatesAll(m);
  }
  return m[email].cats[catId];
}
function saveCatState(email, catId, s) {
  var m = statesAll();
  if (!m[email]) m[email] = { balance: 0, cats: {} };
  m[email].cats[catId] = s;
  saveStatesAll(m);
}
```

- [ ] **Step 3: Add the category store + helpers**

```js
function categoriesAll() {
  var raw = props().getProperty('categories');
  return raw ? JSON.parse(raw) : [];
}
function saveCategories(list) {
  props().setProperty('categories', JSON.stringify(list));
}
function categoryById(id) {
  var list = categoriesAll();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function activeCategories() {
  return categoriesAll().filter(function (c) { return c.active; });
}
// Period start for the category's freezeRefresh cadence (a "YYYY-MM-DD").
function currentPeriodStart(cat) {
  return cat.freezeRefresh === 'daily' ? todayStr() : currentMondayStr();
}
```

- [ ] **Step 4: Rewrite `runTests()` in `Code.gs`** to exercise the new engine

```js
function runTests() {
  var fails = [];
  function eq(a, b, m) { if (a !== b) fails.push(m + ' (got ' + a + ', want ' + b + ')'); }
  var cat = { id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0, freezesPerPeriod: 1, unusedFreezeBonus: 3.5 };
  eq(payout(cat, 1), 0.25, 'payout d1');
  eq(payout(cat, 20), 5.0, 'payout cap');
  eq(periodKeyFor('weekly', '2026-06-22'), '2026-W26', 'iso week');
  var r = applyEntry(initialCatState(cat, 'P'), 0, cat, { periodKey: '2026-06-15', result: 'on_time' });
  eq(r.state.streak, 1, 'streak inc'); eq(r.balance, 0.25, 'pay d1');
  r = applyRefresh({ streak: 3, periodStart: 'P', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: null }, 10, cat, 'P2');
  eq(r.balance, 13.5, 'bonus added');
  eq(applySpend(3, { amount: 5 }).balance, 0, 'spend floors');
  eq(applyDeposit(10, { amount: 20 }).balance, 30, 'deposit adds');
  if (fails.length) Logger.log('TEST FAILURES:\n' + fails.join('\n'));
  else Logger.log('ALL PASS ✅');
  return fails;
}
```

(Run `runTests` in the Apps Script editor during deploy; expect `ALL PASS ✅`.)

- [ ] **Step 5: Stage changes**

```bash
git add backend/Code.gs
```

---

### Task 6: Ledger category column + generalized `record`/`spend`/`state` + `deposit` routes (`Code.gs`)

**Files:**
- Modify: `backend/Code.gs`

**Interfaces:**
- Consumes: storage helpers (Task 5), engine (Task 5).
- Produces routes: `state`, `record` (now requires `categoryId`), `spend`, `deposit`; response `state` payload now `{wallet:Number, cats:[{...catState, id, name, emoji, cadence, potential, freezeAvailable}], partner}`.

- [ ] **Step 1: Add the `category` column to the ledger**

In `ledgerSheet()` header row, insert `'category'`:

```js
ss.getSheets()[0].appendRow([
  'timestamp', 'type', 'category', 'periodKey', 'result',
  'freezeUsed', 'amount', 'balanceAfter', 'actor', 'note',
]);
```

Update `appendLedger(ev)` to write the new columns:

```js
function appendLedger(ev) {
  ledgerSheet().appendRow([
    new Date(), ev.type, ev.category || '', ev.periodKey || '',
    ev.result || '', ev.freezeUsed === true, ev.amount || 0,
    ev.balanceAfter, ev.actor || '', ev.note || '',
  ]);
}
```

Update `recentLedger(email, n)` column indices (actor moved to index 8):

```js
function recentLedger(email, n) {
  var sh = ledgerSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 10).getValues();
  var mine = rows.filter(function (r) { return String(r[8]).toLowerCase() === email; });
  mine = mine.slice(Math.max(0, mine.length - n));
  return mine.reverse().map(function (r) {
    return {
      timestamp: r[0] ? Utilities.formatDate(new Date(r[0]), TZ, 'yyyy-MM-dd HH:mm') : '',
      type: r[1], category: r[2], periodKey: r[3], result: r[4], freezeUsed: r[5],
      amount: r[6], balanceAfter: r[7], actor: r[8], note: r[9],
    };
  });
}
```

> Note in README (Task 12): existing ledger sheets must be re-created or have the `category` column inserted; simplest is to let `setup()` create a fresh ledger after clearing `ledgerId`.

- [ ] **Step 2: Rewrite `stateResponse(email)`** to return wallet + per-category state

```js
function catPublic(email, cat) {
  var s = catStateOf(email, cat.id, cat);
  return {
    id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
    streak: s.streak, freezeAvailable: s.freezeAvailable,
    lastRecordedKey: s.lastRecordedKey,
    potential: payout(cat, s.streak + 1),
  };
}
function stateResponse(email) {
  var cats = activeCategories().map(function (c) { return catPublic(email, c); });
  var resp = {
    ok: true, user: email, name: displayName(email),
    wallet: walletOf(email), cats: cats, ledger: recentLedger(email, 20),
  };
  var pe = partnerOf(email);
  if (pe) resp.partner = { name: displayName(pe), wallet: walletOf(pe) };
  return resp;
}
```

- [ ] **Step 3: Rewrite `doRecord(p)`** to require `categoryId` and use the signed link including category

```js
function doRecord(p) {
  var categoryId = p.categoryId;
  var periodKey = p.periodKey; // record-cadence key (day or ISO week)
  var result = p.result;
  var cat = categoryById(categoryId);
  if (!cat) return { ok: false, error: 'unknown category' };
  var person;
  var loginEmail = verifyToken(p.token);
  if (loginEmail) {
    person = loginEmail;
  } else {
    person = (p.person || '').trim().toLowerCase();
    if (!verifyActionSig(person, categoryId, periodKey, result, p.sig)) {
      return { ok: false, error: 'not authorized' };
    }
  }
  if (ALLOWLIST.indexOf(person) === -1) return { ok: false, error: 'unknown person' };
  var s = catStateOf(person, categoryId, cat);
  var out = applyEntry(s, walletOf(person), cat, { periodKey: periodKey, result: result, actor: person });
  saveCatState(person, categoryId, out.state);
  saveWallet(person, out.balance);
  appendLedger(out.event);
  return { ok: true, user: person, wallet: out.balance, cat: catPublic(person, cat), event: out.event };
}
```

- [ ] **Step 4: Rewrite `doSpend(p)` and add `doDeposit(p)`**

```js
function doSpend(p) {
  var email = requireUser(p);
  var out = applySpend(walletOf(email), { amount: Number(p.amount), note: p.note || '', actor: email });
  saveWallet(email, out.balance);
  appendLedger(out.event);
  return { ok: true, wallet: out.balance, event: out.event };
}
// Add-money: credit BOTH allowlisted people the FULL amount each.
function doDeposit(p) {
  var email = requireUser(p); // must be logged in to initiate
  var amount = Number(p.amount);
  var note = p.note || '';
  ALLOWLIST.forEach(function (person) {
    var out = applyDeposit(walletOf(person), { amount: amount, note: note, actor: person });
    saveWallet(person, out.balance);
    appendLedger(out.event);
  });
  return { ok: true, wallet: walletOf(email) };
}
```

- [ ] **Step 5: Update the signature helpers** to include `categoryId`

```js
function actionSig(person, categoryId, periodKey, result) {
  return sign(person + '|' + categoryId + '|' + periodKey + '|' + result);
}
function verifyActionSig(person, categoryId, periodKey, result, sig) {
  return !!sig && sig === actionSig(person, categoryId, periodKey, result);
}
```

- [ ] **Step 6: Update the `route(p)` switch** to add `deposit` (and category routes from Task 7)

```js
function route(p) {
  switch (p.action) {
    case 'requestLogin': return requestLogin(p.email);
    case 'state': return stateResponse(requireUser(p));
    case 'record': return doRecord(p);
    case 'spend': return doSpend(p);
    case 'deposit': return doDeposit(p);
    case 'listCategories': return doListCategories(p);
    case 'saveCategory': return doSaveCategory(p);
    case 'archiveCategory': return doArchiveCategory(p);
    default: return { ok: true, name: 'Streaks API' };
  }
}
```

- [ ] **Step 7: Stage changes**

```bash
git add backend/Code.gs
```

---

### Task 7: Category CRUD routes (`Code.gs`)

**Files:**
- Modify: `backend/Code.gs`

**Interfaces:**
- Consumes: `categoriesAll`, `saveCategories`, `normalizeCategory`, `validateCategory`, `requireUser` (Tasks 4–5).
- Produces routes: `doListCategories(p)`, `doSaveCategory(p)`, `doArchiveCategory(p)`.

- [ ] **Step 1: Implement the CRUD handlers**

```js
function doListCategories(p) {
  requireUser(p);
  return { ok: true, categories: categoriesAll() };
}
function doSaveCategory(p) {
  requireUser(p);
  var raw = p.category ? (typeof p.category === 'string' ? JSON.parse(p.category) : p.category) : p;
  var cat = normalizeCategory(raw);
  var errs = validateCategory(cat);
  if (errs.length) return { ok: false, error: errs.join(' ') };
  var list = categoriesAll();
  var idx = -1;
  for (var i = 0; i < list.length; i++) if (list[i].id === cat.id) idx = i;
  if (idx >= 0) {
    // preserve active unless explicitly provided
    list[idx] = cat;
  } else {
    list.push(cat);
  }
  saveCategories(list);
  return { ok: true, categories: list };
}
function doArchiveCategory(p) {
  requireUser(p);
  var id = p.categoryId;
  var list = categoriesAll();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].active = false;
  saveCategories(list);
  return { ok: true, categories: list };
}
```

- [ ] **Step 2: Verify in the Apps Script editor (manual)**

After deploy (Task 12), run in the editor console or via the dashboard: create a category, list it, archive it. Expected: `listCategories` returns it, `active:false` after archive. (No automated test — Apps Script.)

- [ ] **Step 3: Stage changes**

```bash
git add backend/Code.gs
```

---

### Task 8: Hourly email dispatcher (`Code.gs`)

**Files:**
- Modify: `backend/Code.gs`

**Interfaces:**
- Consumes: `activeCategories`, `catStateOf`, `applyRefresh`, `actionSig`, `payout`, `currentPeriodStart`, date helpers.
- Produces: `emailDispatch()` (hourly trigger), `currentHourStr()`, generalized `setup()`.

- [ ] **Step 1: Add `currentHourStr()` and replace the three email functions with one dispatcher**

```js
function currentHourStr() {
  return Utilities.formatDate(new Date(), TZ, 'HH') + ':00';
}

// Runs hourly. Sends reminders + check-ups for categories scheduled this hour,
// and performs freeze/bonus refresh when a category's period has rolled over.
function emailDispatch() {
  var hour = currentHourStr();
  var cats = activeCategories();
  cats.forEach(function (cat) {
    maybeRefresh(cat);
    if (cat.reminderTime && cat.reminderTime === hour) sendReminder(cat);
    if (cat.checkupTime && cat.checkupTime === hour) sendCheckup(cat);
  });
}

// Refresh a category's freezes/bonus when its period boundary has passed.
function maybeRefresh(cat) {
  var newStart = currentPeriodStart(cat);
  ALLOWLIST.forEach(function (email) {
    var s = catStateOf(email, cat.id, cat);
    if (s.periodStart !== newStart) {
      var out = applyRefresh(s, walletOf(email), cat, newStart);
      saveCatState(email, cat.id, out.state);
      if (out.event) { out.event.actor = email; saveWallet(email, out.balance); appendLedger(out.event); }
    }
  });
}
```

- [ ] **Step 2: Implement `sendReminder(cat)` and `sendCheckup(cat)`**

```js
function sendReminder(cat) {
  ALLOWLIST.forEach(function (to) {
    var s = catStateOf(to, cat.id, cat);
    var potential = payout(cat, s.streak + 1);
    var subject = (cat.emoji || '🔥') + ' ' + cat.name + ' — ' + money(potential) + ' on the line';
    var html =
      '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
      '<h2>' + (cat.emoji || '🔥') + ' ' + cat.name + '</h2>' +
      '<p>Doing it earns <b>you</b> <b>' + money(potential) + '</b>.</p>' +
      '<ul><li>Streak: <b>' + s.streak + '</b></li>' +
      '<li>Freezes left: <b>' + s.freezeAvailable + '</b></li></ul></div>';
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
  });
}

function sendCheckup(cat) {
  // The period that just closed: yesterday for daily, last week for weekly.
  var refDate = cat.cadence === 'weekly' ? yesterdayStr() : yesterdayStr();
  var periodKey = periodKeyFor(cat.cadence, refDate);
  var btn = 'display:inline-block;padding:14px 22px;margin:6px 0;border-radius:10px;font-size:18px;text-decoration:none;color:#fff';
  ALLOWLIST.forEach(function (to) {
    var base = DASHBOARD_URL + '?person=' + encodeURIComponent(to) +
      '&categoryId=' + encodeURIComponent(cat.id) + '&periodKey=' + encodeURIComponent(periodKey);
    var yesUrl = base + '&result=on_time&sig=' + actionSig(to, cat.id, periodKey, 'on_time');
    var noUrl = base + '&result=missed&sig=' + actionSig(to, cat.id, periodKey, 'missed');
    var subject = 'Did you do ' + cat.name + '? ' + (cat.emoji || '');
    var html =
      '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
      '<h2>' + (cat.emoji || '☀️') + ' ' + cat.name + ' — ' + periodKey + '</h2>' +
      '<p><a href="' + yesUrl + '" style="' + btn + ';background:#2e7d32">✅ Yes</a></p>' +
      '<p><a href="' + noUrl + '" style="' + btn + ';background:#b00020">❌ No</a></p>' +
      '<p style="color:#666;font-size:13px">If you miss and still have a freeze, it\'s used automatically.</p></div>';
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
  });
}
```

- [ ] **Step 3: Replace `setup()` triggers** (remove the 3 fixed email triggers; install one hourly dispatcher)

```js
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('emailDispatch').timeBased().everyHours(1).create();
  ledgerSheet();
  Logger.log('Setup complete. Hourly emailDispatch installed; ledger ready.');
  return 'setup complete';
}
```

Delete the now-unused `sendEveningEmail`, `sendMorningEmail`, `weeklyRollover`.

- [ ] **Step 4: Stage changes**

```bash
git add backend/Code.gs
```

---

### Task 9: Frontend — wallet card, per-category record cards, Add-money, ledger (`index.html`, `js/app.js`, `css/style.css`)

**Files:**
- Modify: `index.html`, `js/app.js`, `css/style.css`

**Interfaces:**
- Consumes: backend `state` response `{wallet, cats:[...], partner, ledger}` and `record`/`spend`/`deposit` routes (Tasks 6–7).
- Produces: rendering of wallet + dynamic category cards; `recordCat(catId, result)`; Add-money submit; `describe`/`amountCell` handling `entry|bonus|spend|deposit`.

- [ ] **Step 1: Update the dashboard markup in `index.html`**

Replace the single balance/streak `stats` block and the static "Record a night" card with a wallet card + a dynamic container, and add an Add-money form. Inside `#dashView`:

```html
<div class="stats">
  <div class="stat big">
    <span class="label">Your wallet</span>
    <span id="wallet" class="value">$0.00</span>
  </div>
</div>

<div class="card partner" id="partnerCard" hidden>
  <h2>👀 <span id="partnerName">Partner</span></h2>
  <div class="prow">
    <div><span class="label">Wallet</span><span id="partnerWallet" class="pval">$0.00</span></div>
  </div>
</div>

<div id="catCards"></div>

<div class="card">
  <h2>Spend</h2>
  <form id="spendForm" class="row">
    <input id="spendAmount" type="number" min="0.01" step="0.01" placeholder="Amount" required />
    <input id="spendNote" type="text" placeholder="What for?" />
    <button type="submit">Spend</button>
  </form>
</div>

<div class="card">
  <h2>Add money</h2>
  <p class="muted">Adds the full amount to <b>both</b> wallets (mad money).</p>
  <form id="addForm" class="row">
    <input id="addAmount" type="number" min="0.01" step="0.01" placeholder="Amount" required />
    <input id="addNote" type="text" placeholder="Note (optional)" />
    <button type="submit">Add money</button>
  </form>
</div>

<div class="card">
  <h2>Recent activity</h2>
  <table id="ledger" class="ledger"><tbody></tbody></table>
  <p id="ledgerEmpty" class="muted" hidden>Nothing yet.</p>
</div>
```

Add a nav button to the topbar (next to logout) for the admin view (used in Task 10):

```html
<button id="manageBtn" class="link-btn" hidden>Categories</button>
```

- [ ] **Step 2: Update rendering in `js/app.js`**

Replace `render`, `renderPartner`, `describe`, `amountCell`:

```js
function render(r) {
  $('whoami').textContent = r.name || r.user || '';
  $('wallet').textContent = money(r.wallet);
  $('manageBtn').hidden = false;
  renderPartner(r.partner);
  renderCatCards(r.cats || []);
  renderLedger(r.ledger || []);
}

function renderPartner(p) {
  const card = $('partnerCard');
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  $('partnerName').textContent = (p.name || 'Partner') + "'s wallet";
  $('partnerWallet').textContent = money(p.wallet);
}

function renderCatCards(cats) {
  const wrap = $('catCards');
  wrap.innerHTML = '';
  if (!cats.length) {
    wrap.innerHTML = '<div class="card"><p class="muted">No categories yet. Tap “Categories” to add one.</p></div>';
    return;
  }
  cats.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h2>' + (c.emoji || '🔥') + ' ' + c.name + '</h2>' +
      '<div class="prow">' +
      '<div><span class="label">Streak</span><span class="pval">' + c.streak + '</span></div>' +
      '<div><span class="label">If you do it</span><span class="pval">' + money(c.potential) + '</span></div>' +
      '<div><span class="label">Freezes</span><span class="pval">' + c.freezeAvailable + '</span></div>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' +
      '<button class="ok" data-cat="' + c.id + '" data-result="on_time">✅ Did it</button>' +
      '<button class="danger" data-cat="' + c.id + '" data-result="missed">❌ Missed</button>' +
      '</div>' +
      '<p class="muted">' + (c.cadence === 'weekly' ? 'Weekly' : 'Daily') + ' • last: ' + (c.lastRecordedKey || '—') + '</p>';
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('button[data-cat]').forEach((b) => {
    b.addEventListener('click', () => recordCat(b.getAttribute('data-cat'), b.getAttribute('data-result'), b.closest('.card').querySelector('h2').textContent));
  });
}

function describe(e) {
  if (e.type === 'spend') return '🛒 ' + (e.note || 'Spent');
  if (e.type === 'deposit') return '💵 ' + (e.note || 'Added money');
  if (e.type === 'bonus') return '🎁 ' + (e.note || 'Bonus') + ' (' + (e.category || '') + ')';
  if (e.type === 'entry') {
    const tag = e.category ? ' (' + e.category + ')' : '';
    if (e.result === 'on_time') return '✅ On time' + tag;
    if (e.freezeUsed) return '❄️ Freeze used' + tag;
    return '❌ Missed' + tag;
  }
  return e.type;
}
function amountCell(e) {
  if (e.type === 'spend') return '−' + money(e.amount);
  if (e.amount > 0) return '+' + money(e.amount);
  return '';
}
```

Update `renderLedger`'s "when" to prefer `periodKey`:

```js
const when = (e.periodKey || (e.timestamp || '').slice(0, 10) || '').toString();
```

- [ ] **Step 3: Add `recordCat`, Add-money submit, and remove the old night handlers**

Replace `recordDash` with `recordCat`, and remove the `onTimeBtn`/`missedBtn`/`nightDate` wiring (those elements are gone):

```js
async function recordCat(categoryId, result, label) {
  banner('Saving…', false);
  try {
    // Record the just-closed period: yesterday for daily, last ISO week for weekly.
    const r = await api('record', { categoryId, periodKey: lastPeriodKey(categoryId), result });
    if (!r.ok) { banner(r.error || 'Could not save', true); return; }
    const e = r.event;
    if (e.result === 'on_time') banner('🎉 ' + (label || 'Done') + ' — earned ' + money(e.amount) + '.', false);
    else if (e.freezeUsed) banner('❄️ Freeze used — streak protected.', false);
    else banner('Streak reset. Fresh start 💪', false);
    showDashboard();
  } catch (err) { banner(err.message, true); }
}
```

For the period key the dashboard records, use yesterday for daily and last ISO week for weekly. Add helpers near the date helpers:

```js
function isoWeekClient(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return dt.getUTCFullYear() + '-W' + ('0' + weekNo).slice(-2);
}
// We need the category cadence to pick day vs week; cache it from the last state render.
let CAT_CADENCE = {};
function lastPeriodKey(categoryId) {
  const d = new Date(Date.now() - 24 * 3600 * 1000); // yesterday
  return CAT_CADENCE[categoryId] === 'weekly' ? isoWeekClient(d) : isoDate(d);
}
```

In `renderCatCards`, record each cadence: at the top of the `cats.forEach`, add `CAT_CADENCE[c.id] = c.cadence;`.

Wire Add-money in `wire()` and update Spend to use the new response (`r.wallet`):

```js
$('spendForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = $('spendAmount').value, note = $('spendNote').value;
  banner('Saving…', false);
  try {
    const r = await api('spend', { amount, note });
    if (!r.ok) { banner(r.error || 'Could not save', true); return; }
    $('spendAmount').value = ''; $('spendNote').value = '';
    banner('Spent ' + money(amount) + '.', false);
    showDashboard();
  } catch (err) { banner(err.message, true); }
});

$('addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = $('addAmount').value, note = $('addNote').value;
  banner('Saving…', false);
  try {
    const r = await api('deposit', { amount, note });
    if (!r.ok) { banner(r.error || 'Could not add', true); return; }
    $('addAmount').value = ''; $('addNote').value = '';
    banner('Added ' + money(amount) + ' to both wallets.', false);
    showDashboard();
  } catch (err) { banner(err.message, true); }
});
```

Remove the now-dead lines in `wire()`: `$('onTimeBtn')...`, `$('missedBtn')...`.

- [ ] **Step 4: Add minimal CSS** to `css/style.css` (only if cards need spacing; reuse `.prow`/`.card`)

```css
#catCards .card .prow { margin-top: 4px; }
```

- [ ] **Step 5: Manual verification (after Task 12 deploy)**

Log in; create a category (Task 10); confirm a card appears, "Did it" credits the wallet, Spend debits it, Add-money raises both wallets, and the ledger shows the category. (No automated test — DOM/JSONP.)

- [ ] **Step 6: Stage changes**

```bash
git add index.html js/app.js css/style.css
```

---

### Task 10: Frontend — Categories admin view (`index.html`, `js/app.js`)

**Files:**
- Modify: `index.html`, `js/app.js`

**Interfaces:**
- Consumes: `listCategories`, `saveCategory`, `archiveCategory` routes (Task 7).
- Produces: `adminView` section; `showAdmin()`, `renderCatList(cats)`, save/archive handlers; nav wiring.

- [ ] **Step 1: Add the admin section markup to `index.html`** (after `#dashView`)

```html
<section id="adminView" class="card" hidden>
  <div class="row" style="justify-content:space-between">
    <h2>Categories</h2>
    <button id="backToDashBtn" class="link-btn">← Dashboard</button>
  </div>
  <table id="catList" class="ledger"><tbody></tbody></table>

  <h3>Add / edit a category</h3>
  <form id="catForm">
    <input type="hidden" id="catId" />
    <div class="row"><input id="catName" placeholder="Name (e.g. Exercise)" required />
      <input id="catEmoji" placeholder="Emoji 🏋️" maxlength="4" /></div>
    <div class="row">
      <label class="muted">Cadence
        <select id="catCadence"><option value="daily">daily</option><option value="weekly">weekly</option></select>
      </label>
      <label class="muted">Freeze refresh
        <select id="catRefresh"><option value="weekly">weekly</option><option value="daily">daily</option></select>
      </label>
    </div>
    <div class="row">
      <input id="catIncrement" type="number" step="0.01" min="0.01" placeholder="Reward per streak ($)" required />
      <input id="catMax" type="number" step="0.01" min="0.01" placeholder="Max per instance ($)" required />
    </div>
    <div class="row">
      <input id="catFreezes" type="number" step="1" min="0" placeholder="Freezes per period" required />
      <input id="catBonus" type="number" step="0.01" min="0" placeholder="Unused-freeze bonus ($) — 0 = none" />
    </div>
    <div class="row">
      <label class="muted">Reminder <select id="catReminder"></select></label>
      <label class="muted">Check-up <select id="catCheckup"></select></label>
    </div>
    <button type="submit">Save category</button>
  </form>
  <p id="catFormMsg" class="muted" hidden></p>
</section>
```

- [ ] **Step 2: Add view switching** in `js/app.js` `setView`

```js
function setView(name) {
  ['loginView', 'checkinView', 'dashView', 'adminView'].forEach((v) => ($(v).hidden = true));
  $({ login: 'loginView', checkin: 'checkinView', dash: 'dashView', admin: 'adminView' }[name]).hidden = false;
  $('logoutBtn').hidden = !getToken();
}
```

- [ ] **Step 3: Populate the hour dropdowns and admin flow** in `js/app.js`

```js
function fillHourOptions(sel) {
  sel.innerHTML = '<option value="">off</option>';
  for (let h = 0; h < 24; h++) {
    const hh = ('0' + h).slice(-2) + ':00';
    sel.innerHTML += '<option value="' + hh + '">' + hh + '</option>';
  }
}

async function showAdmin() {
  setView('admin');
  fillHourOptions($('catReminder'));
  fillHourOptions($('catCheckup'));
  try {
    const r = await api('listCategories');
    if (!r.ok) { banner(r.error || 'Could not load categories', true); return; }
    renderCatList(r.categories || []);
  } catch (err) { banner(err.message, true); }
}

function renderCatList(cats) {
  const body = $('catList').querySelector('tbody');
  body.innerHTML = '';
  cats.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (c.emoji || '') + ' ' + c.name + (c.active ? '' : ' (archived)') + '</td>' +
      '<td>' + c.cadence + '</td>' +
      '<td><button class="link-btn" data-edit="' + c.id + '">edit</button>' +
      (c.active ? ' <button class="link-btn" data-arch="' + c.id + '">archive</button>' : '') + '</td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('button[data-edit]').forEach((b) =>
    b.addEventListener('click', () => editCat(cats.find((x) => x.id === b.getAttribute('data-edit')))));
  body.querySelectorAll('button[data-arch]').forEach((b) =>
    b.addEventListener('click', () => archiveCat(b.getAttribute('data-arch'))));
}

function editCat(c) {
  $('catId').value = c.id; $('catName').value = c.name; $('catEmoji').value = c.emoji || '';
  $('catCadence').value = c.cadence; $('catRefresh').value = c.freezeRefresh;
  $('catIncrement').value = c.rewardIncrement; $('catMax').value = c.maxPerInstance;
  $('catFreezes').value = c.freezesPerPeriod; $('catBonus').value = c.unusedFreezeBonus;
  $('catReminder').value = c.reminderTime || ''; $('catCheckup').value = c.checkupTime || '';
}

async function archiveCat(id) {
  try {
    const r = await api('archiveCategory', { categoryId: id });
    if (!r.ok) { banner(r.error || 'Could not archive', true); return; }
    renderCatList(r.categories || []);
  } catch (err) { banner(err.message, true); }
}
```

- [ ] **Step 4: Wire the admin form + nav** in `wire()`

```js
$('manageBtn').addEventListener('click', showAdmin);
$('backToDashBtn').addEventListener('click', showDashboard);

$('catForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const category = {
    id: $('catId').value || undefined,
    name: $('catName').value, emoji: $('catEmoji').value,
    cadence: $('catCadence').value, freezeRefresh: $('catRefresh').value,
    rewardIncrement: $('catIncrement').value, maxPerInstance: $('catMax').value,
    freezesPerPeriod: $('catFreezes').value, unusedFreezeBonus: $('catBonus').value,
    reminderTime: $('catReminder').value, checkupTime: $('catCheckup').value,
    active: true,
  };
  $('catFormMsg').hidden = true;
  try {
    const r = await api('saveCategory', { category: JSON.stringify(category) });
    if (!r.ok) { $('catFormMsg').hidden = false; $('catFormMsg').textContent = '⚠️ ' + r.error; return; }
    $('catForm').reset(); $('catId').value = '';
    renderCatList(r.categories || []);
    banner('Category saved.', false);
  } catch (err) { banner(err.message, true); }
});
```

- [ ] **Step 5: Manual verification (after Task 12 deploy)**

Create a daily category and a weekly one; edit one; archive one; confirm archived categories disappear from the dashboard but remain in the list marked "(archived)". (No automated test.)

- [ ] **Step 6: Stage changes**

```bash
git add index.html js/app.js
```

---

### Task 11: Generalized check-in flow from signed email links (`js/app.js`)

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: signed link params `person, categoryId, periodKey, result, sig` (Task 8 emails) and the `record` route (Task 6).
- Produces: updated `boot()` param parsing, `checkinFlow(person, categoryId, periodKey, result, sig)`, `recordViaSig(...)`.

- [ ] **Step 1: Update `boot()` to parse the category link params**

Replace the action-link block in `boot()`:

```js
const nightDate = qp.get('periodKey');
const result = qp.get('result');
const sig = qp.get('sig');
const person = qp.get('person');
const categoryId = qp.get('categoryId');
if (person && categoryId && nightDate && result && sig) {
  history.replaceState({}, '', location.origin + location.pathname);
  checkinFlow(person, categoryId, nightDate, result, sig);
  return;
}
```

- [ ] **Step 2: Update `checkinFlow` and `recordViaSig`** to carry `categoryId` + `periodKey`

```js
async function checkinFlow(person, categoryId, periodKey, result, sig) {
  setView('checkin');
  $('checkinTitle').textContent = 'Check-in: ' + periodKey;
  $('checkinBody').textContent = result === 'on_time' ? 'Recording your on-time entry…' : 'Recording your missed entry…';
  await recordViaSig(person, categoryId, periodKey, result, sig);
}

async function recordViaSig(person, categoryId, periodKey, result, sig) {
  const params = { action: 'record', person, categoryId, periodKey, result, sig };
  $('checkinResult').hidden = false;
  $('checkinResult').textContent = 'Saving…';
  try {
    const r = await jsonp(params);
    const res = $('checkinResult');
    if (!r.ok) {
      res.textContent = /already recorded/i.test(r.error || '') ? '✅ Already recorded.' : '⚠️ ' + (r.error || 'Could not save');
    } else {
      const e = r.event;
      if (e.result === 'on_time') res.textContent = '🎉 Recorded! Earned ' + money(e.amount) + '. Wallet: ' + money(r.wallet) + '.';
      else if (e.freezeUsed) res.textContent = '❄️ Freeze used — streak protected.';
      else res.textContent = 'Streak reset. Fresh start 💪 Wallet: ' + money(r.wallet) + '.';
    }
  } catch (err) {
    $('checkinResult').textContent = '⚠️ ' + err.message;
  }
  $('checkinDoneBtn').hidden = false;
}
```

- [ ] **Step 3: Manual verification (after deploy)**

Trigger `sendCheckup` for a test category from the Apps Script editor; tap ✅ in the email; confirm the check-in screen records it and the wallet updates. (No automated test.)

- [ ] **Step 4: Stage changes**

```bash
git add js/app.js
```

---

### Task 12: Deploy copy + README + full verification

**Files:**
- Modify: `README.md`
- Copy: `index.html`, `css/style.css`, `js/app.js`, `js/config.js` → `../sleep/`

**Interfaces:** none (integration/deploy).

- [ ] **Step 1: Run the full engine test suite**

Run: `cd backend && node --test`
Expected: all tests PASS (Tasks 1–4).

- [ ] **Step 2: Update `README.md`**

- Retitle from "Sleep Streak" to a multi-category streak tracker; describe categories, per-category rules, the shared wallet, Add-money (full amount to both), and the hourly `emailDispatch`.
- Update "Changing the rules": rules now live in the in-app **Categories** admin UI (stored in Script Properties), not in code; `engine.js` only changes for new *mechanics*.
- Note the **ledger migration**: after deploying the new `Code.gs`, clear the `ledgerId` Script Property (or delete the old sheet) and re-run `setup()` so the ledger gets the new `category` column.
- Update the deploy copy block to include `js/app.js`, `index.html`, `css/style.css`, `js/config.js`.

- [ ] **Step 3: Deploy the backend (manual, per `backend/README.md`)**

Paste the new `Code.gs` into the Apps Script editor, run `runTests` (expect `ALL PASS ✅`), clear `ledgerId`, run `setup` (installs the hourly `emailDispatch`, recreates the ledger).

- [ ] **Step 4: Copy the frontend into the deployed subfolder**

```bash
cp index.html      ../sleep/index.html
cp css/style.css   ../sleep/css/style.css
cp js/app.js       ../sleep/js/app.js
cp js/config.js    ../sleep/js/config.js
```

- [ ] **Step 5: Manual end-to-end check**

Open the dashboard, log in, create a daily and a weekly category, record on-time/missed for each, Spend, Add-money (verify both wallets rise by the full amount), archive a category, and confirm the ledger shows category-tagged rows. Verify a check-up email link records correctly.

- [ ] **Step 6: Stage changes** (the repo owner commits + pushes)

```bash
git add README.md ../sleep/index.html ../sleep/css/style.css ../sleep/js/app.js ../sleep/js/config.js
git add backend/Code.gs backend/engine.js backend/engine.test.js index.html js/app.js css/style.css
```

---

## Self-Review Notes

- **Spec coverage:** categories w/ all rule fields (Tasks 4,7,10); cadence daily/weekly (Tasks 1,2,6,8); integer freezes (Task 2); optional/zero bonus (Tasks 2,4); shared wallet (Tasks 3,5,6,9); Add-money full-to-both (Tasks 3,6,9); hourly dispatcher + per-category reminder/check-up + signed links w/ categoryId (Task 8,11); admin UI CRUD (Tasks 7,10); ledger category column (Task 6); deploy/migration (Task 12). All spec sections mapped.
- **Type consistency:** `applyEntry(state, balance, cat, input) -> {state, balance, event}`, `applyRefresh(...) -> {state, balance, event|null}`, `applySpend/applyDeposit(balance, input) -> {balance, event}` used identically in engine, tests, and Code.gs. State fields `streak, periodStart, freezeAvailable, freezeUsedThisPeriod, lastRecordedKey` consistent across tasks. `actionSig(person, categoryId, periodKey, result)` consistent in Code.gs (Task 6) and email links (Task 8) and frontend (Task 11).
- **Migration risk called out:** ledger column change requires clearing `ledgerId` and re-running `setup()` (Task 12 Step 2/3); existing per-person `states` blob shape changes — note in README that balances reset on this migration (acceptable for a 2-person honor-system app; mention in Task 12 README step).
