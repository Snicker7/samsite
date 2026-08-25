# House chores — shared, assignable, penalty-pot chores

**Date:** 2026-08-25
**Status:** Approved design, pending implementation plan
**Builds on:** 2026-08-25-amend-past-answers-design.md (ledger-replay corrections,
`since` boundaries, period-key machinery)

## Problem

The app models habits: per-person streaks both partners track independently.
Household chores don't fit — the dishes get done once, by whoever does them,
and that person should get the credit. Chores also need schedules habits don't
have (monthly, one-time) and a consequence when nobody does them.

## Decisions (made with the user)

- **Flat pay per claim.** A chore has a fixed dollar `value`; whoever claims a
  period gets it. No streaks, freezes, or bonuses.
- **Cadences: daily, weekly, monthly, once.** Monthly is a new period type
  ("YYYY-MM"). `once` is a single claimable period for special jobs ("clean
  out the shed") with an optional due date.
- **Claims target the current period** (today / this week / this month), not
  the last closed one — chores are logged the day they're done.
- **Penalty pot.** A period that ends unclaimed drains wallets into a pot:
  - *Shared chore* (either person may do it): **half the value from each**
    wallet. Whoever later back-claims the period collects **pot + value**
    (for a $2 chore, the late doer nets +$3 over their own −$1; the other
    person stays −$1).
  - *Assigned chore* (one owner): the assignee alone loses the **full
    value**, unrecoverable — a late claim pays the value only (netting zero
    for that period).
  - *Once with a due date*: passing the due date unclaimed fires the same
    rules a single time. No due date → no penalty, it just waits.
- **One-time chores auto-archive on claim** (they're done); deleting the
  claim un-archives them.

## Design

### 1. Category model (`engine.js` normalize/validate, admin form)

Categories gain `kind: 'habit' | 'chore'` (existing rows normalize to
`'habit'`). Chores use: `name`, `emoji`, `kind: 'chore'`, `cadence`
(`daily | weekly | monthly | once`), `value` (> 0), `assignee` (`''` =
either, else an allowlisted email), `dueDate` (`'YYYY-MM-DD'`, once-cadence
only, optional), `reminderTime`, `active`. Habit-only fields are neither
required nor stored for chores; validation branches on `kind` (habits keep
their existing rules and their daily/weekly-only cadence). A non-empty
`assignee` must be one of the two allowlisted people — the pure engine can't
see the allowlist, so `doSaveCategory` enforces it. A category's `kind` is
immutable after creation: editing an existing id whose stored kind differs
from the incoming one is rejected (archive it and create a new one instead)
— habit and chore state machinery would otherwise replay against ledger
rows the other kind wrote.

The admin form gets a kind selector that toggles which field groups show;
assignee is a dropdown of the two allowlisted people plus "either".

### 2. Period keys (`engine.js`)

- `periodKeyFor` gains `monthly` → `"YYYY-MM"`; `once` → the literal key
  `"once"`.
- `periodKeyDate` maps `"YYYY-MM"` to its first day; `validPeriodKey`
  accepts real months for monthly and only `"once"` for once.
- New `claimablePeriodKey(cat, todayStr)` — the **current** period (today /
  current ISO week / current month / `"once"`), unlike habits'
  `recordablePeriodKey` which is the last closed one.

### 3. Ledger rows

Two new row types, both flowing through the existing `deriveWallet` (which
sums any non-spend row's amount):

- `claim` — a claimed chore period: `category`, `periodKey`, `actor` (the
  claimant), positive `amount` (value, plus pot for a late shared claim).
- `penalty` — an unclaimed period's drain: `category`, `periodKey`, `actor`
  (the wallet charged), **negative** `amount`, note "Unclaimed: <chore>".

`recentLedger` renders both (🧹 for claims, ⚠️ for penalties) and marks
`claim` rows deletable by their claimant. Penalty rows are not deletable.

### 4. Claim action (`main.gs`, `claim`)

Token-auth; params `categoryId`, optional `periodKey` (defaults to the
claimable period; a past key ≤ current back-claims through the picker; must
be ≥ the chore's `since`). Validations: chore kind, active, well-formed key,
assignee-only for assigned chores. One claim per period per **chore** —
checked across both actors from the ledger.

Payout written on the claim row:
- pot = −(sum of that chore+period's penalty rows) (0 when claimed on time —
  a claimed period is never swept).
- shared chore → `value + pot`; assigned chore → `value`.

Once-cadence: on success, archive the chore.

Chore periods are independent (no streak cascade), so **no replay is
needed**: `deleteEntry` on a `claim` row verifies ownership, deletes the
row (wallet re-derives), and un-archives a once-chore. `amend` rejects
chore categories ("chores are claimed, not answered — use its card").

For a recurring chore, the reopened period is claimable again at plain
value: the sweep does not retro-penalize it immediately, but it isn't
exempt going forward either — `deleteEntry` rewinds the chore's
`sweepFrom` back to the reopened period (when it precedes the current
`sweepFrom`), so the next sweep pass re-evaluates it and penalizes it again
if it's still unclaimed once its period closes.

For a once-chore, deleting its claim reactivates it, and if its `dueDate`
has already passed, the sweep fires its single penalty on the reopened
chore (recoverable — a re-claim collects the pot). This supersedes the
earlier "no retro-penalizing" wording for the once case.

### 5. Penalty sweep (hourly trigger + on-demand)

A per-chore (not per-user) state blob `choreStates` in Script Properties:
`{ [catId]: { since, lastSweptKey } }`, `since` = the claimable period at
chore creation (periods before it are never penalized and not
back-claimable).

Sweep, run from the hourly trigger and before claim/state reads (mirroring
`maybeRefresh`): for each active chore, walk closed periods from
`lastSweptKey` forward; any with no claim row gets penalty rows appended —
shared: −value/2 to each allowlisted wallet; assigned: −value to the
assignee — then advance `lastSweptKey`. Once-cadence: a single sweep fires
when `dueDate` is set, has passed, and no claim exists (recorded via
`lastSweptKey: 'once'`). Wallets may go negative (consistent with bonus
adjustments). Archived chores are skipped; a re-activated chore resumes
sweeping from the current period (its `lastSweptKey` advances without
penalizing the archived gap, like `restartPeriod`).

### 6. Dashboard (`app.js`, `index.html`)

`stateResponse` cats gain `kind`; chore entries also carry `value`,
`assignee`, `claimablePeriodKey`, `claimedBy` (name, if the current period
is claimed), and `outstanding`: closed unclaimed periods ≥ since with their
pot amounts.

The dashboard renders chores in their own section: name/emoji, value,
assignee tag ("either of you" / a name), current status ("✋ I did it"
button, or "✓ Sierra, today"), and — when `outstanding` is non-empty — a
collapsed "Catch up" list: each period with its pot ("2026-08-23 · collect
$4") and a claim button. The claim button hides for assigned chores that
aren't yours. Once-chores show the due date and disappear on claim
(archived).

### 7. Emails

`reminderTime` works for chores: sent only while the current period (or the
once-chore) is unclaimed, to the assignee (or both for shared), showing the
value and any outstanding pot ("🧹 Dishes — $2 on the line, $4 pot waiting").
No check-up emails or signed one-tap links in v1.

### 8. Tests

Engine (`engine.test.js`): monthly/once key handling in
`periodKeyFor`/`periodKeyDate`/`validPeriodKey`; `claimablePeriodKey` all
four cadences; chore normalize/validate branches (value required, assignee
allowlisted-or-empty, dueDate only for once); pot arithmetic helper(s).
`runTests()` mirrors a subset. The Apps-Script-stub simulation harness
(scratchpad) gains scenarios: on-time claim; unclaimed sweep shared and
assigned; late claim collects pot (shared) or value only (assigned); once
with due date lifecycle incl. delete-unarchive; assignee enforcement;
double-claim rejection; archived chores don't penalize.

## Out of scope (v1)

- Signed email one-tap claim links.
- Splitting a chore's value between simultaneous doers.
- Recurring due-date escalation (pot grows once per period, not daily).
