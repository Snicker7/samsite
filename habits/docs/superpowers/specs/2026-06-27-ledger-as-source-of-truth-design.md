# Ledger as source of truth — removing erroneous spends/adds & live totals

**Date:** 2026-06-27
**Status:** Approved design, pending implementation plan

## Problem

Two related gaps in the Habit Builder money flow:

1. There is no way to remove an **erroneous spend or add** ("add money"). Once
   recorded, a wrong entry is stuck and the wallet stays wrong.
2. Editing the backing Google Sheet ("the tracking sheet") by hand does **not**
   update the totals. The wallet balance is stored separately in Script
   Properties, and the Sheet's `balanceAfter` column is only a write-time
   snapshot, so deleting/editing a row in the Sheet changes nothing.

## Root cause

The wallet balance is **stored** authoritatively in Script Properties
(`states[email].balance`). The ledger Sheet is a write-only log. The stored
number and the Sheet can therefore drift, and neither responds to a Sheet edit.

## Approach (chosen)

Make the **ledger Sheet the single source of truth for wallet totals.** The
wallet becomes a pure function of the ledger rows, so deleting or editing a row
— whether via a new in-app ✕ button or by hand in Google Sheets — is reflected
in the total the next time the app loads.

Considered and rejected:
- **onChange trigger** that re-sums into the stored balance: same result, but
  adds an installable trigger, re-entry guards, and a lag. More to break.
- **In-app delete only** (no Sheet editing): doesn't satisfy gap #2.

## What does and does not derive from the Sheet

- **Wallet totals: derived** from the ledger rows.
- **Streaks / freezes: not derived.** They live in Script Properties and cannot
  be reconstructed from money rows. This is fine because the only rows users
  delete are spends and adds, which never affect streaks. **Documented rule:**
  do not hand-delete ✅/❌ check-in rows in the Sheet — it will not rewind a
  streak and will desync the displayed running balance for that category's
  payouts. (The ✕ button is only offered on spend/add rows to enforce this.)

## Design

### 1. Wallet derivation (engine.js → Code.gs)

New pure function in `engine.js`, mirrored into `Code.gs`, unit-tested:

```
deriveWallet(rows, actor) -> number
```

- `rows`: ledger rows for consideration, each `{ type, amount, actor }`, in
  chronological (sheet) order.
- Replay only rows whose `actor` matches (case-insensitive): a `spend` subtracts
  its `amount` with the balance **floored at $0** (matching today's
  `applySpend`); every other type (`deposit`, `bonus`, `entry`) adds its
  `amount` (missed/freeze entries carry `amount: 0`, so contribute nothing).
- Returns the `round2` balance.

`Code.gs` changes:
- `walletOf(email)` reads all ledger rows once and returns
  `deriveWallet(rows, email)` instead of the stored balance.
- `saveWallet` is **retired** (removed, and its call sites dropped from
  `doSpend`, `doDeposit`, `doRecord`, `maybeRefresh`). The `balance` field in
  `states[email]` is no longer read or written; `cats` state is untouched.
- `doSpend` / `doDeposit` / `doRecord` compute the new row's `balanceAfter` from
  the freshly derived balance, then `appendLedger`. They return the re-derived
  wallet.
- `recentLedger` computes a **running balance per actor** cumulatively over
  **all** of that actor's rows (oldest→newest, same floor-at-$0 rule as
  `deriveWallet`), then returns the last N rows each carrying its correct
  cumulative `balanceAfter` — not a within-window sum. This keeps the app's
  Balance column correct even after manual edits (the stored snapshot column is
  no longer trusted for display).

### 2. Sheet restructure (idempotent `setup()` / migration)

`setup()` becomes idempotent and also migrates:

- **`id` column** added as the new **leading** column of the Ledger sheet. Every
  appended row gets a `Utilities.getUuid()`. A migration backfills UUIDs into
  existing rows that lack one. This `id` is what the ✕ button targets, so a
  delete survives row shifts from other edits.
  - New header order: `id, timestamp, type, category, periodKey, result,
    freezeUsed, amount, balanceAfter, actor, note`.
  - `appendLedger`, `recentLedger`, and the column indices used by
    `deriveWallet`'s read are updated for the shifted columns.
- **`Totals` tab** added: one row per allowlisted person, showing the live
  balance via formula so the Sheet itself displays each total as you edit.
  - Columns: `email, name, balance`.
  - `balance` formula (no flooring):
    `=SUMIFS(Ledger!$H:$H, Ledger!$J:$J, $A2, Ledger!$C:$C, "<>spend")
      - SUMIFS(Ledger!$H:$H, Ledger!$J:$J, $A2, Ledger!$C:$C, "spend")`
    (column letters reflect the new schema: H=amount, J=actor, C=type).
  - **Caveat:** the app caps each spend at the available balance (`applySpend` logs the amount actually deducted), so the Totals formula and the app wallet agree for all app-generated history. A *manually entered* spend row larger than the balance at that point could still make the no-floor formula read lower than the app — so don't hand-enter an overspend. Noted in a cell comment on the tab.

Migration is safe to re-run: it checks whether column A is already `id` and
whether the `Totals` tab exists before acting.

### 3. In-app ✕ delete (frontend: `habits/` and `sleepsite/`, kept identical)

- `recentLedger` already returns each row; add its `id` to the returned object.
- `renderLedger` adds a trailing cell containing a small ✕ button **only** for
  rows where `type === 'spend'` or `type === 'deposit'`. Other rows get an empty
  cell. The header/table gains the extra column.
- Click handler: confirm ("Remove this entry?") → `api('deleteEntry', { id })` →
  on `ok`, `showDashboard()` (re-renders with the re-derived total) and a
  success banner; on error, show the error banner (e.g. "ledger changed, reload").
- The ledger table needs one more `<td>`/column; adjust `habits/css/style.css`
  /`sleepsite/css/style.css` only if alignment needs it (the ✕ is a `link-btn`).

New backend action `deleteEntry(p)`:
- `requireUser(p)` → email.
- Read the Ledger; find the row whose `id === p.id`.
- Reject if not found ("entry not found — reload"), if its `actor` is not the
  requesting user ("you can only remove your own entries"), or if its `type` is
  not `spend`/`deposit` ("only spends and adds can be removed here").
- Delete that single physical row (`sheet.deleteRow(rowNumber)`).
- Return `{ ok: true, wallet: walletOf(email) }` (re-derived). The deposit's
  paired row for the partner is **left intact** — each person removes their own
  (per the product decision); the partner's wallet derives independently.

### 4. Tests

Add to `backend/engine.test.js` (Node `node:test`):
- `deriveWallet`: single deposit; deposit then spend; spend floored at $0 when it
  exceeds balance; mixed deposit/bonus/on-time-entry/missed-entry sums correctly;
  per-actor isolation (other actor's rows ignored); case-insensitive actor match;
  empty rows → 0.
- Keep `engine.js` ↔ `Code.gs` reward/derive logic mirrored (existing
  discipline).

## Deployment notes (Apps Script)

The backend is Google Apps Script, deployed by pasting `Code.gs`:
1. Paste the updated `Code.gs` into the Apps Script project.
2. Run `setup()` once — installs the (unchanged) hourly trigger **and** migrates
   the Sheet: inserts the `id` column + backfills UUIDs, and creates the
   `Totals` tab. Safe to re-run.
3. Deploy the web app as usual; the frontend (`habits/`, `sleepsite/`) needs no
   config change. `WEB_APP_URL` is unchanged.

No data migration beyond `setup()`; existing stored balances are simply ignored
once `walletOf` derives from the ledger (the ledger already records every money
event with `balanceAfter`, so derived totals match current balances).

## Out of scope

- Rewinding streaks/freezes from the Sheet.
- Editing (vs. deleting) a row from within the app — hand-edit in the Sheet for
  amount/note corrections.
- Deleting the partner's paired deposit from one person's app action.
