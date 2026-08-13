# Multi-Category Streaks + Add-Money — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorming), ready for implementation plan
**Supersedes the single hard-coded streak in:** `2026-06-18-sleep-streak-design.md`

## Summary

Turn the single hard-coded "Sleep Streak" into a **general, configurable
multi-category streak engine**. A *category* (sleep, exercise, chores,
cleaning, or anything) is a first-class, editable object with its own bonus
curve, freeze count, reset/compilation cadence, reward increment, per-instance
max, customizable unused-freeze bonus (including none), and its own reminder +
check-up emails. Add a new **Add money** action that credits **both** people's
shared personal wallet by the **full amount each**, so personal/"mad" money can
be deposited and then recorded through the existing **Spend** feature.

## Decisions (from brainstorming)

1. **Category config:** full **in-app admin UI** — either allowlisted person can
   add/edit/archive categories live (persisted in Script Properties, no
   redeploy needed).
2. **Balance model:** **one shared personal wallet per person.** Every category's
   payout, the unused-freeze bonus, and add-money all credit this single
   balance; Spend debits it. Balance lives on the *person*, not the category.
   (This reconciles an earlier "separate balance per category" answer — the
   shared wallet was chosen when the trade-off was made concrete, and is what we
   build.)
3. **Cadence semantics:** a category's `cadence` (`daily` | `weekly`) controls
   **how often one entry is recorded**. Daily → record once per day, streak
   counts days. Weekly → record once per week, streak counts weeks.
4. **Add-money semantics:** adding `$X` credits **each** person's wallet by the
   **full `$X`** (not split), logging a `deposit` event in each person's ledger.
5. **Unused-freeze bonus is per-category and optional:** any amount, or `0`/blank
   for **no bonus and no bonus event**.
6. **Emails:** one **hourly dispatcher** trigger sends per-category reminder and
   check-up emails at configured **whole-hour** times (blank = off). This keeps
   unlimited categories within Apps Script's trigger limit.

## Architecture & Data Model

### Category (config object)

Created/edited in the admin UI, stored in Script Properties as a list.

| Field | Meaning | Example |
|---|---|---|
| `id`, `name`, `emoji` | identity (unique `id`) | `exercise`, "Exercise", 🏋️ |
| `cadence` | `daily` or `weekly` — how often one entry is recorded | `daily` |
| `rewardIncrement` | $ added per streak level | `0.25` |
| `maxPerInstance` | cap on a single on-time payout | `5.00` |
| `freezesPerPeriod` | freezes allowed before a miss resets the streak (`0` = strict) | `1` |
| `freezeRefresh` | when freezes refresh & the bonus is evaluated | `weekly` (Sun night) |
| `unusedFreezeBonus` | $ paid at refresh if no freeze used; `0`/blank = none | `3.50` |
| `reminderTime` | whole-hour local time for the reminder email; blank = off | `21:00` |
| `checkupTime` | whole-hour local time for the check-up email; blank = off | `09:00` |
| `active` | archived categories stop prompting/emailing but keep history | `true` |

### State

Moves from one blob-per-person to **per person × per category**:

```
states[email][categoryId] = {
  streak, weekStart (period start),
  freezeAvailable (integer count), freezeUsedThisPeriod (bool),
  lastRecordedDate (periodKey last recorded)
}
```

**Balance is NOT in category state** — a single `balance` per person (the shared
wallet) is credited/debited by all events.

### Ledger

Gains a `category` column. Every row names its tracker; spend/add-money rows on
the wallet show `—`.

## Generalized Engine (`engine.js`, mirrored into `Code.gs`)

Pure functions parameterized by a category's rules instead of file-level
constants. Same logic, operating on a per-category state slice while crediting
the person's shared wallet.

- **`applyEntry(state, wallet, cat, input)`** (replaces `applyNight`)
  - `input.result` ∈ `on_time` | `missed`; `input.periodKey` is the day
    (`2026-06-22`) for daily cadence or the ISO week (`2026-W25`) for weekly.
  - Guard: if `state.lastRecordedDate === periodKey`, reject ("already
    recorded") so a period can't be double-counted.
  - **on_time:** `streak += 1`; `payout = min(rewardIncrement × streak,
    maxPerInstance)`; wallet `balance += payout`.
  - **missed, freeze left:** decrement `freezeAvailable`, mark used, preserve
    streak, $0.
  - **missed, no freeze:** `streak = 0`, $0.
  - Returns new state slice, new wallet balance, and event
    `{type:'entry', category, result, freezeUsed, amount, balanceAfter, actor}`.
- **`applyRefresh(state, wallet, cat, newPeriodStart)`** (replaces
  `applyWeeklyRollover`), runs on the category's `freezeRefresh` cadence
  - If `unusedFreezeBonus > 0` **and** no freeze used this period → wallet
    `balance += unusedFreezeBonus` (a `bonus` event). Otherwise no event.
  - Reset `freezeAvailable = freezesPerPeriod`, clear used flag, advance period.
- **`applySpend(wallet, input)`** — debits the shared wallet, floors at $0
  (`spend` event). Unchanged behavior.
- **`applyDeposit(wallet, input)`** — credits the shared wallet (`deposit`
  event). The backend calls it once per allowlisted person so both get the full
  amount.

**Freezes generalized:** from a boolean to an integer count
(`freezeAvailable`), decremented on auto-use and reset to `freezesPerPeriod` on
refresh, so a category can allow 0, 1, or several freezes per period.

## Emails (hourly dispatcher)

One `emailDispatch` time-trigger runs **hourly**. Each run computes the current
local `HH:00` and, for every **active** category:

- **Reminder** (at `reminderTime`): "[emoji] [name] by [time] earns you $X" —
  mirrors today's evening email per category, showing that category's streak,
  potential payout, and freeze count.
- **Check-up** (at `checkupTime`): one-tap ✅/❌ buttons for the just-closed
  period, using the existing signed-link mechanism, now signing
  `person|categoryId|periodKey|result` (HMAC).
- **Freeze refresh / bonus**: folded into the dispatcher on each category's
  `freezeRefresh` cadence, so all email + rollover work stays on a single
  trigger (well under Apps Script's ~20-trigger limit).

Times are whole hours (UI dropdown 12 AM–11 PM); blank disables that email.

## Frontend

### Dashboard (records & money)

- **Wallet card**: your single personal balance; partner's balance read-only.
- **One record-card per active category**: streak, freeze count, potential
  payout, ✅ On-time / ❌ Missed buttons. Daily defaults the date to the last
  open day; weekly shows the current/just-closed week.
- **Spend** (unchanged): debits your wallet, floors at $0.
- **Add money** (new): amount + note → credits **both** wallets by the full
  amount each; logs a `deposit` event in each person's ledger.
- **Recent activity**: ledger shows the category column.

### Admin UI (new "Categories" view; either person)

- List categories with edit/archive.
- Form with every rule field above (name, emoji, cadence, increment,
  max/instance, freezes/period, freeze-refresh cadence, unused-freeze bonus incl.
  0/none, reminder hour, check-up hour, active).
- Backend validates (positive numbers, valid whole-hour times, unique `id`);
  archived categories keep history but stop prompting/emailing.

## Backend routes (added)

- `deposit` — add-money, loops the allowlist applying `applyDeposit`.
- `listCategories`, `saveCategory`, `archiveCategory` — auth-gated by login
  token like existing actions; categories persisted in Script Properties.
- `emailDispatch` hourly trigger replaces the three fixed email triggers.
- Existing `record` / `spend` / `state` generalize to carry `categoryId` and
  return per-category state plus the shared wallet.

## Testing

`engine.test.js` extends to cover the parameterized engine:

- increment/cap math at and beyond the per-instance max,
- freeze-count decrement on miss and reset on refresh,
- daily vs weekly `periodKey` double-record guard,
- zero-bonus and zero-freeze categories,
- `applySpend` flooring at $0,
- `applyDeposit` crediting the wallet (and the backend crediting both people the
  full amount).

Run with `node --test` in `backend/`, then mirror engine changes into `Code.gs`.

## Out of scope

- Per-category wallets (explicitly rejected in favor of the shared wallet).
- Minute-level email precision (whole-hour only).
- Changing the JSONP transport, login/allowlist model, or deployment flow.
