# Ledger as Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Google Sheet ledger the single source of truth for wallet totals, add an in-app ✕ to delete erroneous spends/adds, and a live `Totals` tab — so editing the Sheet (by hand or via the button) updates the totals.

**Architecture:** Wallet balance becomes a pure function of the ledger rows (`deriveWallet`), replayed per person with spends floored at $0. `Code.gs` derives the wallet on every read instead of storing it. The Sheet gains a leading `id` column (for targeted deletes) and a `Totals` tab (live SUMIFS). The frontend adds a ✕ on spend/deposit rows calling a new `deleteEntry` action.

**Tech Stack:** Vanilla JS frontend (JSONP), Google Apps Script backend (`Code.gs`), pure shared logic in `backend/engine.js` with Node `node:test` unit tests.

## Global Constraints

- `backend/engine.js` and `backend/Code.gs` share identical reward/derive logic — **any logic change must be mirrored into both**. `engine.js` is the Node-tested source of truth; `Code.gs` carries a hand-kept copy.
- `habits/` (deployed) and `sleepsite/` frontends are **byte-identical** — every `index.html` / `js/app.js` / `css/style.css` edit must be applied to **both** directories.
- Apps Script (`Code.gs`, `setup()`, `deleteEntry`) cannot run under Node; verify its pure logic via the mirrored `engine.js` tests and the in-script `runTests()`, then by manual deploy. Only `engine.js` changes get a real red/green test cycle.
- **Do not run `git commit` or `git push`.** Each task ends by staging (`git add`); the user commits manually.
- Ledger column order after migration (0-based): `0 id, 1 timestamp, 2 type, 3 category, 4 periodKey, 5 result, 6 freezeUsed, 7 amount, 8 balanceAfter, 9 actor, 10 note` (11 columns).
- Money rounding uses the existing `round2`.

---

### Task 1: `deriveWallet` / `runningBalanceRows` pure functions (engine.js)

**Files:**
- Modify: `sleepsite/backend/engine.js` (add functions + exports near the existing `applyDeposit` / module.exports block)
- Test: `sleepsite/backend/engine.test.js` (append tests)

**Interfaces:**
- Consumes: existing `round2` in `engine.js`.
- Produces:
  - `runningBalanceRows(rows, actor) -> Array<row & {balanceAfter:number}>` — keeps only rows whose `actor` matches `actor` (case-insensitive), in input order; for each, `spend` subtracts `amount` floored at 0, every other type adds `amount`; attaches the cumulative `balanceAfter`.
  - `deriveWallet(rows, actor) -> number` — the last `balanceAfter` from `runningBalanceRows`, or `0` if none.
  - Each `row` is `{ type:string, amount:number, actor:string, ... }` (extra fields preserved).

- [ ] **Step 1: Write the failing tests**

Append to `sleepsite/backend/engine.test.js`:

```javascript
test('deriveWallet sums deposits and bonuses, subtracts spends', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'bonus', amount: 3.5, actor: 'a' },
    { type: 'spend', amount: 4, actor: 'a' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a'), 9.5);
});

test('deriveWallet adds on-time entry payouts and ignores zero-amount misses', () => {
  const rows = [
    { type: 'entry', amount: 0.25, actor: 'a', result: 'on_time' },
    { type: 'entry', amount: 0, actor: 'a', result: 'missed' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a'), 0.25);
});

test('deriveWallet floors a spend that exceeds the balance at $0', () => {
  const rows = [
    { type: 'deposit', amount: 3, actor: 'a' },
    { type: 'spend', amount: 5, actor: 'a' },
    { type: 'deposit', amount: 2, actor: 'a' },
  ];
  // 3 -> max(0, 3-5)=0 -> 0+2 = 2  (floor matters: without it this is 0)
  assert.strictEqual(E.deriveWallet(rows, 'a'), 2);
});

test('deriveWallet isolates by actor, case-insensitively', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'A@x.com' },
    { type: 'deposit', amount: 99, actor: 'b@x.com' },
    { type: 'spend', amount: 4, actor: 'a@X.COM' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a@x.com'), 6);
});

test('deriveWallet returns 0 for no matching rows', () => {
  assert.strictEqual(E.deriveWallet([], 'a'), 0);
  assert.strictEqual(E.deriveWallet([{ type: 'deposit', amount: 5, actor: 'b' }], 'a'), 0);
});

test('runningBalanceRows attaches cumulative balanceAfter for the actor only', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'deposit', amount: 99, actor: 'b' },
    { type: 'spend', amount: 4, actor: 'a' },
  ];
  const out = E.runningBalanceRows(rows, 'a');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].balanceAfter, 10);
  assert.strictEqual(out[1].balanceAfter, 6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sleepsite/backend/`
Expected: FAIL — `E.deriveWallet is not a function` (and `runningBalanceRows`).

- [ ] **Step 3: Implement the functions**

In `sleepsite/backend/engine.js`, after `applyDeposit` (before the `module.exports` block), add:

```javascript
/**
 * Replay a single actor's ledger rows (in order), flooring spends at $0, and
 * attach the running balance to each. Non-spend rows add their amount.
 * @returns {Array} the actor's rows, each with a numeric balanceAfter.
 */
function runningBalanceRows(rows, actor) {
  var a = String(actor || '').toLowerCase();
  var bal = 0;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.actor || '').toLowerCase() !== a) continue;
    var amt = Number(r.amount) || 0;
    bal = r.type === 'spend' ? round2(Math.max(0, bal - amt)) : round2(bal + amt);
    var copy = Object.assign({}, r);
    copy.balanceAfter = bal;
    out.push(copy);
  }
  return out;
}

/** Current wallet balance for an actor, derived from their ledger rows. */
function deriveWallet(rows, actor) {
  var rb = runningBalanceRows(rows, actor);
  return rb.length ? rb[rb.length - 1].balanceAfter : 0;
}
```

Then add both to `module.exports` (alphabetical-ish, alongside the others):

```javascript
    applyDeposit: applyDeposit,
    deriveWallet: deriveWallet,
    runningBalanceRows: runningBalanceRows,
    normalizeCategory: normalizeCategory,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sleepsite/backend/`
Expected: PASS — all tests (17 existing + 6 new = 23).

- [ ] **Step 5: Stage (user commits)**

```bash
git add sleepsite/backend/engine.js sleepsite/backend/engine.test.js
# Do NOT commit — tell the user Task 1 is staged and ready to commit.
```

---

### Task 2: Mirror derive logic into Code.gs and make `walletOf` derive

**Files:**
- Modify: `sleepsite/backend/Code.gs` — add mirrored `runningBalanceRows`/`deriveWallet`; add `readLedgerRows()`; rewrite `walletOf`; retire `saveWallet`; update `recentLedger`; drop `saveWallet` calls in `doSpend`/`doDeposit`/`doRecord`/`maybeRefresh`; extend `runTests()`.

**Interfaces:**
- Consumes: `deriveWallet`, `runningBalanceRows` (mirrored from Task 1); existing `ledgerSheet`, `round2`, `TZ`.
- Produces:
  - `readLedgerRows() -> Array<{rowNumber, id, timestamp, type, category, periodKey, result, freezeUsed, amount, balanceAfter, actor, note}>` — every ledger row as an object (used by `walletOf`, `recentLedger`, and Task 4's `deleteEntry`). Assumes the migrated 11-column schema (Task 3); on the *old* 10-column sheet `id` is `''` and columns shift — Task 3 runs `setup()` before this is exercised in production, and `runTests()` here uses synthetic rows, so ordering across tasks is safe.

- [ ] **Step 1: Mirror the pure functions into Code.gs**

In `sleepsite/backend/Code.gs`, in the "REWARD ENGINE (mirror of engine.js)" section, right after `applyDeposit` (ends ~line 167), add the **exact same** two functions as Task 1 Step 3 (`runningBalanceRows` and `deriveWallet`). (Copy verbatim — they use only `round2`, which exists in `Code.gs`.)

- [ ] **Step 2: Add `readLedgerRows()` and rewrite `walletOf` to derive**

In the STORAGE section, replace the existing `walletOf` (currently `function walletOf(email){ return personRecord(email).balance || 0; }`, ~line 262) with a reader + derive. Add `readLedgerRows` near `recentLedger`:

```javascript
// All ledger rows as objects (post-migration 11-column schema).
function readLedgerRows() {
  var sh = ledgerSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 11).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    out.push({
      rowNumber: i + 2,
      id: r[0], timestamp: r[1], type: r[2], category: r[3], periodKey: r[4],
      result: r[5], freezeUsed: r[6], amount: r[7], balanceAfter: r[8],
      actor: r[9], note: r[10],
    });
  }
  return out;
}
```

Replace `walletOf`:

```javascript
function walletOf(email) { return deriveWallet(readLedgerRows(), email); }
```

- [ ] **Step 3: Retire `saveWallet` and its callers**

- Delete the `saveWallet` function (~lines 263-268).
- In `doSpend`: remove the `saveWallet(email, out.balance);` line. (`appendLedger(out.event)` stays; the response already returns `out.balance`, which now equals the freshly derived balance because `applySpend` was computed from `walletOf(email)`.)
- In `doDeposit`: remove the `saveWallet(person, out.balance);` line inside the `ALLOWLIST.forEach`.
- In `doRecord`: remove the `saveWallet(person, out.balance);` line.
- In `maybeRefresh`: change the bonus branch from `{ out.event.actor = email; saveWallet(email, out.balance); appendLedger(out.event); }` to `{ out.event.actor = email; appendLedger(out.event); }`.

(Leave `personRecord`/`catStateOf`/`saveCatState` untouched — streak state still lives in Script Properties. The now-unused `balance` field in `states[email]` is simply ignored.)

- [ ] **Step 4: Make `recentLedger` show derived running balances**

Replace the body of `recentLedger(email, n)` so the Balance column is correct after manual edits. It must compute the cumulative balance over **all** of that actor's rows, then return the last `n`:

```javascript
function recentLedger(email, n) {
  var rows = readLedgerRows();
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

(Note: this returns `id` for the frontend ✕ button — Task 5.)

- [ ] **Step 5: Extend `runTests()` with a derive check**

In `runTests()`, before the `if (fails.length)` line, add:

```javascript
  var L = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'spend', amount: 4, actor: 'a' },
    { type: 'deposit', amount: 99, actor: 'b' },
  ];
  eq(deriveWallet(L, 'a'), 6, 'deriveWallet a');
  eq(deriveWallet(L, 'b'), 99, 'deriveWallet b');
  eq(runningBalanceRows(L, 'a').length, 2, 'rbr count');
```

- [ ] **Step 6: Sanity-check the mirror against engine.js**

Run: `node --test sleepsite/backend/`
Expected: PASS (unchanged — this proves the engine.js copy the mirror was taken from is still green; Code.gs itself is verified later via Apps Script `runTests()` in Task 6 deploy).

- [ ] **Step 7: Stage (user commits)**

```bash
git add sleepsite/backend/Code.gs
# Do NOT commit — tell the user Task 2 is staged.
```

---

### Task 3: Sheet migration — `id` column + `Totals` tab (idempotent `setup()`)

**Files:**
- Modify: `sleepsite/backend/Code.gs` — `ledgerSheet()` header for new sheets, `appendLedger`, and `setup()` (add migration helpers).

**Interfaces:**
- Consumes: `props()`, `ledgerSheet()`, `ALLOWLIST`, `displayName`, `Utilities.getUuid`.
- Produces: a migrated Sheet — Ledger with a leading `id` column (UUIDs backfilled), plus a `Totals` tab. Safe to re-run.

- [ ] **Step 1: New ledgers get the `id` header**

In `ledgerSheet()`, update the header row written for a freshly created spreadsheet to lead with `id`:

```javascript
    ss.getSheets()[0].appendRow([
      'id', 'timestamp', 'type', 'category', 'periodKey', 'result',
      'freezeUsed', 'amount', 'balanceAfter', 'actor', 'note',
    ]);
```

- [ ] **Step 2: `appendLedger` writes a UUID id first**

Replace `appendLedger`:

```javascript
function appendLedger(ev) {
  ledgerSheet().appendRow([
    Utilities.getUuid(), new Date(), ev.type, ev.category || '', ev.periodKey || '',
    ev.result || '', ev.freezeUsed === true, ev.amount || 0,
    ev.balanceAfter, ev.actor || '', ev.note || '',
  ]);
}
```

- [ ] **Step 3: Add migration helpers**

Add near `setup()`:

```javascript
// Insert a leading "id" column + backfill UUIDs if the sheet predates it.
function migrateLedgerIdColumn() {
  var sh = ledgerSheet();
  var header = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  if (header[0] === 'id') return; // already migrated
  sh.insertColumnBefore(1);
  sh.getRange(1, 1).setValue('id');
  var last = sh.getLastRow();
  for (var row = 2; row <= last; row++) {
    sh.getRange(row, 1).setValue(Utilities.getUuid());
  }
}

// Create/refresh a Totals tab with a live SUMIFS balance per allowlisted person.
function ensureTotalsTab() {
  var ss = SpreadsheetApp.openById(props().getProperty('ledgerId'));
  var sh = ss.getSheetByName('Totals');
  if (!sh) sh = ss.insertSheet('Totals');
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([['email', 'name', 'balance']]);
  for (var i = 0; i < ALLOWLIST.length; i++) {
    var r = i + 2;
    var formula =
      '=SUMIFS(Ledger!$H:$H,Ledger!$J:$J,$A' + r + ',Ledger!$C:$C,"<>spend")' +
      '-SUMIFS(Ledger!$H:$H,Ledger!$J:$J,$A' + r + ',Ledger!$C:$C,"spend")';
    sh.getRange(r, 1).setValue(ALLOWLIST[i]);
    sh.getRange(r, 2).setValue(displayName(ALLOWLIST[i]));
    sh.getRange(r, 3).setFormula(formula);
  }
  sh.getRange(ALLOWLIST.length + 3, 1).setValue(
    'Live totals: credits minus spends (does not floor at $0). Edit/delete rows in the Ledger tab to correct.'
  );
}
```

Note: the SUMIFS references a sheet named `Ledger`. The default first sheet of a `SpreadsheetApp.create('Habit Builder Ledger')` is named `Sheet1`. In `ensureTotalsTab`, before building formulas, rename the data sheet to `Ledger` for stable references:

```javascript
  var data = ss.getSheets()[0];
  if (data.getName() !== 'Totals' && data.getName() !== 'Ledger') data.setName('Ledger');
```

(Place that right after obtaining `ss`, before `getSheetByName('Totals')`.)

- [ ] **Step 4: Call the migration from `setup()`**

In `setup()`, after `ledgerSheet();` and before the `Logger.log`, add:

```javascript
  migrateLedgerIdColumn();
  ensureTotalsTab();
```

- [ ] **Step 5: Stage (user commits)**

```bash
git add sleepsite/backend/Code.gs
# Do NOT commit — tell the user Task 3 is staged. (Verified on deploy in Task 6.)
```

---

### Task 4: `deleteEntry` backend action

**Files:**
- Modify: `sleepsite/backend/Code.gs` — add `doDeleteEntry`, register it in `route`.

**Interfaces:**
- Consumes: `requireUser`, `readLedgerRows`, `ledgerSheet`, `walletOf`.
- Produces: action `deleteEntry` — params `{ token, id }`; deletes the requesting user's own `spend`/`deposit` row by `id`; returns `{ ok:true, wallet }` (re-derived) or `{ ok:false, error }`.

- [ ] **Step 1: Implement `doDeleteEntry`**

Add after `doDeposit` (or near the other `do*` handlers):

```javascript
function doDeleteEntry(p) {
  var email = requireUser(p);
  var id = p.id;
  if (!id) return { ok: false, error: 'missing id' };
  var rows = readLedgerRows();
  var match = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { match = rows[i]; break; }
  }
  if (!match) return { ok: false, error: 'entry not found — reload and try again' };
  if (String(match.actor).toLowerCase() !== String(email).toLowerCase()) {
    return { ok: false, error: 'you can only remove your own entries' };
  }
  if (match.type !== 'spend' && match.type !== 'deposit') {
    return { ok: false, error: 'only spends and adds can be removed here' };
  }
  ledgerSheet().deleteRow(match.rowNumber);
  return { ok: true, wallet: walletOf(email) };
}
```

- [ ] **Step 2: Register the route**

In `route(p)`, add the case alongside the others:

```javascript
    case 'deleteEntry': return doDeleteEntry(p);
```

- [ ] **Step 3: Stage (user commits)**

```bash
git add sleepsite/backend/Code.gs
# Do NOT commit — tell the user Task 4 is staged.
```

---

### Task 5: In-app ✕ button (frontend — `habits/` AND `sleepsite/`)

**Files:**
- Modify: `habits/js/app.js` AND `sleepsite/js/app.js` — `renderLedger` (add ✕ cell + handler), new `deleteEntry` flow.
- Modify (only if alignment needs it): `habits/css/style.css` AND `sleepsite/css/style.css`.

**Interfaces:**
- Consumes: backend `deleteEntry` (Task 4); `recentLedger` now returns `id` (Task 2 Step 4); existing `api`, `banner`, `showDashboard`, `describe`, `amountCell`, `money`.
- Produces: ✕ buttons on spend/deposit rows that delete and refresh.

- [ ] **Step 1: Add the delete flow + ✕ cell in `renderLedger`**

In **both** `habits/js/app.js` and `sleepsite/js/app.js`, replace the `renderLedger` function with:

```javascript
function renderLedger(rows) {
  const body = $('ledger').querySelector('tbody');
  body.innerHTML = '';
  $('ledgerEmpty').hidden = rows.length > 0;
  rows.forEach((e) => {
    const tr = document.createElement('tr');
    const when = (e.periodKey || (e.timestamp || '').slice(0, 10) || '').toString();
    const canDelete = e.type === 'spend' || e.type === 'deposit';
    const del = canDelete && e.id
      ? '<button class="link-btn del" data-del="' + e.id + '" title="Remove this entry" aria-label="Remove this entry">✕</button>'
      : '';
    tr.innerHTML =
      '<td>' + when + '</td>' +
      '<td>' + describe(e) + '</td>' +
      '<td class="amt">' + amountCell(e) + '</td>' +
      '<td class="bal">' + money(e.balanceAfter) + '</td>' +
      '<td class="del-cell">' + del + '</td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('button[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteEntry(b.getAttribute('data-del'))));
}

async function deleteEntry(id) {
  if (!window.confirm('Remove this entry? This updates your wallet total.')) return;
  banner('Removing…', false);
  try {
    const r = await api('deleteEntry', { id });
    if (!r.ok) { banner(r.error || 'Could not remove', true); return; }
    banner('Entry removed.', false);
    showDashboard();
  } catch (err) { banner(err.message, true); }
}
```

- [ ] **Step 2: (If needed) style the ✕ cell**

If the ✕ column looks cramped, add to **both** `habits/css/style.css` and `sleepsite/css/style.css`:

```css
.ledger .del-cell { text-align: right; width: 1%; white-space: nowrap; }
.ledger .del { color: #b00020; padding: 0 6px; }
```

- [ ] **Step 3: Verify the two frontends are still identical**

Run: `diff habits/js/app.js sleepsite/js/app.js && diff habits/css/style.css sleepsite/css/style.css && echo IDENTICAL`
Expected: `IDENTICAL`.

- [ ] **Step 4: Stage (user commits)**

```bash
git add habits/js/app.js sleepsite/js/app.js habits/css/style.css sleepsite/css/style.css
# Do NOT commit — tell the user Task 5 is staged.
```

---

### Task 6: Deploy + manual verification (Apps Script)

**Files:** none (operational).

This task is the user's, since it touches the live Apps Script project and Sheet. Provide these steps to the user:

- [ ] **Step 1:** Paste the updated `sleepsite/backend/Code.gs` into the Apps Script project (replace all).
- [ ] **Step 2:** Run `runTests()` in the Apps Script editor → check the execution log shows `ALL PASS ✅` (now includes the `deriveWallet` checks).
- [ ] **Step 3:** Run `setup()` once → confirm the Ledger sheet gained a leading `id` column with UUIDs backfilled, and a `Totals` tab now shows each person's live balance.
- [ ] **Step 4:** Re-deploy the web app (new version) so `doGet` serves the new actions. `WEB_APP_URL` is unchanged; no frontend config edit.
- [ ] **Step 5:** In the app: confirm the wallet total matches the `Totals` tab; click ✕ on a test spend → it disappears and the wallet rises by that amount; delete a row by hand in the Sheet → reload the app → total reflects it.
- [ ] **Step 6:** Push the static site (`habits/`, `sleepsite/`) per your normal deploy.

---

## Self-Review Notes

- **Spec coverage:** wallet derivation (Task 1–2), `saveWallet` retirement (Task 2), running-balance display (Task 2 Step 4), `id` column + `Totals` tab migration (Task 3), `deleteEntry` own-spend/deposit-only (Task 4), ✕ on spend/deposit rows in both frontends (Task 5), deploy/migrate notes (Task 6). All spec sections mapped.
- **Type consistency:** `deriveWallet(rows, actor)` / `runningBalanceRows(rows, actor)` signatures identical across engine.js, Code.gs, and call sites; `recentLedger` returns `id`; `deleteEntry` consumes `{ id }`. Column indices (id=0/A, amount=7/H, actor=9/J, type=2/C) consistent between `readLedgerRows` and the `Totals` SUMIFS.
- **Streaks not derived** — enforced by ✕ only on spend/deposit and documented for hand-edits (spec "out of scope").
