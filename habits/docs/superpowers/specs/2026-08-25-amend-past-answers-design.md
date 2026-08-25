# Amend past answers — change or back-fill any recorded period

**Date:** 2026-08-25
**Status:** Approved design, pending implementation plan

## Problem

Two gaps in how answers are recorded:

1. Tapping **✅ Did it** or **❌ Missed** when last night is already recorded
   fails with a raw "period … already recorded" error. It should instead offer
   to change the answer.
2. There is no way to record or correct a **past** period from the dashboard.
   The buttons only write the last closed period, and older periods are
   reachable only through signed check-up email links — which also refuse
   already-recorded periods.

Underlying limitation: streaks and freezes are stored state with a one-step
undo snapshot (newest entry per habit only), so nothing today can rewrite an
older entry and keep the streak, freezes, payouts, and bonuses consistent.

## Decisions (made with the user)

- **Full replay.** Changing a past answer rebuilds the habit's history as if
  the corrected answer had always been true: the streak, every later entry's
  payout, and freeze usage are recomputed, and the wallet adjusts to match.
- **Gaps are fillable.** The past-date picker can both change an existing
  answer and record a period that was never answered. Unrecorded periods stay
  neutral (the streak passes over them) until filled — same as today.
- **Freezes are recomputed.** Replay re-decides which misses spent a freeze
  from calendar freeze periods and the habit's *current* settings. A change
  can flip a later miss between ❄️-protected and streak-penalized, and
  unused-freeze bonuses are re-settled (see Bonus re-settlement).
- **Replay on amend.** Normal recording keeps the stored-state fast path.
  Replay runs only when an answer is amended or an entry row is deleted.
  (Rejected: fully ledger-derived streaks — same user-visible result, much
  larger blast radius across refresh/bonus/email machinery. Rejected:
  append-only correction rows — every reader, including the sheet's Totals
  formulas, would have to learn to skip superseded rows.)

## Design

### 1. Engine: pure replay (`engine.js`, mirrored into `Code.gs`)

New pure functions, unit-tested in `engine.test.js`:

- `periodKeyDate(periodKey)` → "YYYY-MM-DD". A daily key is itself; a weekly
  key ("YYYY-Www") becomes that ISO week's Monday. Gives every entry a
  calendar position so replay can sort and bucket mixed keys (a habit whose
  cadence was edited can hold both forms).
- `freezePeriodStart(freezeRefresh, dateStr)` → the "YYYY-MM-DD" the date's
  freeze period starts on: the date itself (daily), its ISO Monday (weekly),
  or the first of its month (monthly).
- `replayCategory(cat, entries, currentPeriodStart)` — `entries` is one
  actor's entry rows for one category, any order. Sorts by
  `periodKeyDate` and re-runs the existing rules from streak 0 under the
  category's current settings:
  - on_time → streak + 1, `amount = payout(cat, streak)`;
  - missed with a freeze left in its freeze period → `freezeUsed`, amount 0;
  - missed with none left → streak scaled by `missPenaltyPercent`, amount 0.

  Returns:
  - `entries`: the corrected rows (id preserved; recomputed `freezeUsed` and
    `amount`);
  - `state`: `{ streak, freezesUsedThisPeriod, lastRecordedKey }`, where
    `freezesUsedThisPeriod` counts only misses falling in
    `currentPeriodStart`'s freeze period and `lastRecordedKey` is the
    latest period key present (or null).
- `freezeEarnedPeriods(cat, entries, currentPeriodStart, since)` — the set of
  **closed** freeze-period starts that earned the bonus (at least one entry,
  no freeze spent), and
  `bonusDelta(cat, beforeEntries, afterEntries, currentPeriodStart, since)` —
  the net unused-freeze-bonus correction implied by comparing those sets
  before and after a change. The current freeze period is live and is settled
  by the existing hourly refresh, not by replay.

### 2. Backend: `amend` action (`main.gs`)

Routed under `withLock`, dashboard token only — signed email links cannot
amend. Params: `categoryId`, `periodKey`, `result`.

Validation (friendly one-line errors):
- category exists and is active (same rule as `record`);
- `result` is `on_time` or `missed`;
- `periodKey` is well-formed for the category's cadence (real "YYYY-MM-DD"
  date, or "YYYY-Www");
- `periodKey` is **no later than `recordablePeriodKey(cat)`** — the same key
  the record buttons write. Nothing open or future is amendable, so amend
  cannot inflate a streak any further than honest recording could.

Flow:
1. `maybeRefresh(cat)`, then read the ledger once.
2. Find this actor's entry row for `periodKey`. If found with the same
   `result` → `{ ok: true, unchanged: true }` (the UI words it as "already
   recorded"). If found with a different result → rewrite that row's
   `result`. If absent → append a new entry row (timestamp now, the past
   `periodKey`; the ledger panel already displays `periodKey` as the date,
   and wallet derivation is order-independent for non-spend rows).
3. `replayCategory` over the actor's entry rows for this category. Rewrite
   any row whose `freezeUsed` or `amount` changed. Also rewrite the sheet's
   `balanceAfter` cells for this actor's rows from the earliest change
   onward — cosmetic only; the app derives balances via
   `runningBalanceRows`.
4. **Bonus re-settlement:** for closed freeze periods, compare replayed
   bonus-earned periods against what the previously recorded `freezeUsed`
   flags implied, and append **one** compensating `bonus` row for the net
   delta if nonzero (positive or negative amount; note
   "Bonus adjustment (answer changed)"). Existing bonus rows are never
   touched — they carry no period key, so they cannot be matched safely.
   *Caveat:* this assumes past periods were settled under the category's
   current `unusedFreezeBonus`; if that setting changed since, the
   adjustment uses today's value. Periods predating the habit's per-user
   state (tracked as `since` on the state blob) are exempt from
   re-settlement in both directions — nothing was ever settled there.
5. Save the replayed state merged over the live one: `streak`,
   `freezesUsedThisPeriod`, `lastRecordedKey` from replay; `periodStart`,
   `freezeRefresh`, and `since` stay as the live refresh machinery left them.
6. Return `{ ok, wallet, cat: catPublic(...), event, ripple: { entriesChanged,
   bonusDelta } }`.

### 3. Backend: replay-based delete (replaces one-step undo)

`deleteEntry` on a `type === 'entry'` row becomes: verify ownership, delete
the row, then replay the category (steps 3–5 above). This removes:

- the `state.undo` snapshot written by `doRecord`;
- the "only the most recent entry for a habit can be undone" restriction —
  any of your own entry rows becomes deletable ("clear this answer", and
  the period reopens);
- the special-cased unused-freeze-bonus give-back inside `undoEntry`
  (replay's bonus re-settlement covers it);
- the `undoable` map in `recentLedger` — `canDelete` is now simply
  "this row belongs to the requesting user".

Spend/deposit deletion is unchanged.

### 4. Backend: `catHistory` action

Token-authed; `categoryId`. Returns this actor's recorded entries for the
category: `[{ periodKey, result, freezeUsed }]`, newest first. Serves the
past-date picker (show what a chosen period currently holds) and the
accurate change-confirmation text; the dashboard's 20-row ledger window is
not enough.

### 5. Frontend (`js/app.js`, `index.html`)

- `catPublic` gains `recordedResult`: the result already on file for
  `nextPeriodKey` (read from the ledger rows `stateResponse` already
  holds), or null.
- **Card buttons.** When `recordedResult` is null, behavior is unchanged
  (`record`, with the existing miss confirm). When set: tapping the same
  answer shows a banner ("Last night is already recorded ✅ — nothing to
  change."); tapping the other answer asks
  `confirm('You recorded ✅ for last night — change it to ❌ Missed? Later
  days adjust automatically.')` and calls `amend` with `nextPeriodKey`.
- **Fix a past day.** Each card gets a collapsed "✏️ Fix a past day" ("week"
  for weekly cadence) row. Opening it fetches `catHistory` once. Daily: an
  `<input type="date">` capped at the last closed day. Weekly: a `<select>`
  of the last 12 closed ISO weeks. Beside the picker, the period's current
  answer ("currently: ✅ / ❌ / not recorded") and Did it / Missed buttons.
  Both paths call `amend` (it handles absent-row fills); changing an
  existing answer confirms first, while filling a gap skips the change
  confirm (a gap-fill miss keeps the existing miss confirm wording).
- **Feedback.** After an amend the banner reports the ripple — e.g.
  "Changed 2026-08-20 to ✅ — 3 later entries adjusted." — then
  `showDashboard(true)`.

### 6. Tests

`backend/engine.test.js` (Node `node --test`):
- `periodKeyDate` daily/weekly (incl. year-boundary weeks);
- `freezePeriodStart` daily/weekly/monthly, DST-safe via existing helpers;
- `replayCategory`: straight rebuild matches sequential `applyEntry`;
  flipping one answer cascades later payouts; freeze recompute flips a
  later miss between ❄️ and penalty; gap-fill insertion lands mid-history;
  weekly and mixed daily/weekly ordering; bonus periods reported for closed
  periods only; `missPenaltyPercent` and payout-cap interaction; id and
  unknown fields preserved on corrected rows.
- `runTests()` in `main.gs` gets a small mirror set (existing discipline).

## Deployment

`node build.js` → paste `Code.gs` → deploy. No `setup()` migration: the
sheet schema is unchanged. Old `state.undo` snapshots become inert and are
simply no longer written or read.

## Out of scope

- Amending via signed email links.
- Rewriting historical bonus rows in place (compensating row instead).
- Recomputing spends: a past change can shift the balance a later spend was
  floored against; `runningBalanceRows` already floors at $0 on read, and
  recorded spend amounts are left as recorded.
- Editing the partner's entries (ownership checks unchanged).

## Addendum (2026-08-25, post-implementation)

### The unused-freeze bonus now requires an entry

A freeze period pays its bonus only if something was actually recorded in it.
`applyRefresh` takes a `hadEntries` flag (`maybeRefresh` derives it from the
ledger with the new `periodHasEntries` helper), and `bonusDelta` compares
*earned* maps — `hasEntries(P) && !freezeSpent(P)` — instead of spent maps.
Without this, ignoring a habit for a month paid more than doing it: the bonus
became an idleness allowance, and gap-filling a frozen miss into a week nobody
had touched clawed back money that was never owed. Re-settlement follows the
same rule in both directions, so filling an on-time answer into a previously
empty closed period now pays the bonus it would have earned.

### Weekly freeze periods roll over Monday at 17:00

`currentMondayStr()` keeps returning last week's Monday until
`WEEKLY_ROLLOVER_HOUR` (17, local `TZ`) on Monday. Sunday's habit is answered
Monday morning, and at a midnight boundary that answer landed in the new week:
a miss spent the fresh week's freeze, and the old week's bonus was paid before
its last answer arrived. Only the weekly `freezeRefresh` path shifts — daily
and monthly period starts, and `recordablePeriodKey`, are unchanged.

### Late answers are appended and replayed, not applied live

An entry whose freeze period has already rolled over — every weekly answer, a
daily answer that crosses the boundary, and *every* answer on a habit with
daily `freezeRefresh` — takes the append-and-replay route instead of
`applyEntry`. The live path would spend the current period's freeze for a
period that closed days ago, and the bonus the rollover already settled would
never reconcile. Replaying puts freeze attribution back on the calendar and
lets `bonusDelta` correct what the rollover settled from an empty period; this
is also what finally pays the bonus for daily-`freezeRefresh` habits, whose
periods always settle before the answer arrives.
