# Sleep Streak — Design Spec

**Date:** 2026-06-18
**Owner:** Sam & wife (shared)
**Goal:** A responsible-bedtime tracker that rewards being in bed with screens off by **9:30 PM** (America/Denver).

---

## 1. Overview

A small web app that tracks a **shared** nightly bedtime goal for a couple, accumulates a money reward for consecutive successes, and nudges via two daily emails. Hosted as a subsection of the existing site on GitHub Pages, with a free Google Apps Script backend that stores data and sends email natively from Gmail.

It is an honor-system tracker: state only changes when a night is explicitly recorded.

## 2. Reward Rules (authoritative)

- **The goal:** in bed, screens off, by 9:30 PM local (America/Denver).
- **Per-person, independent tracking.** Each spouse has their own balance, streak, weekly freeze, and bonus — the money is personal, spent individually. Each person logs in with their own email and records their own night. (The shared bedtime is a couple's habit, but accountability and reward are individual: if one stays up late, only that person's streak breaks.)
- **Nightly payout on an on-time night:** `0.25 × streak` dollars, where `streak` is the count of consecutive successful nights *including the night being recorded*. Capped at **$5.00**.
  - Night 1 → $0.25, night 2 → $0.50, … night 20 → $5.00, night 21+ → $5.00 (held at cap).
- **Streak freeze:** exactly **1 available per week**, refreshing **Sunday night**.
  - On a **missed** night, if a freeze is available it is **used automatically**: streak/payout level is **preserved**, **$0** paid that night, freeze consumed for the week. (No choice — there is no benefit to declining.)
  - If no freeze is available on a missed night, the streak **resets to 0**.
- **Weekly bonus:** if the week's freeze is **unused** at the Sunday-night rollover, add **$3.50** to the pot.
- **Balance:** accumulates over time. A **Spend** action subtracts an arbitrary amount (with a note), logged to the ledger.

### Worked example
Successes Mon–Fri → streak 1..5, payouts $0.25,$0.50,$0.75,$1.00,$1.25 (pot $3.75). Sat missed, freeze used → streak stays 5, $0, freeze consumed. Sun success → streak 6 → $1.50. Sunday rollover: freeze was used this week → no $3.50 bonus; freeze refreshes for next week.

## 3. Architecture

Three components, each with one responsibility.

```
┌──────────────────────────┐      HTTPS (GET reads / POST writes)      ┌─────────────────────────────┐
│  Dashboard (GitHub Pages)│ ───────────────────────────────────────► │  Backend (Google Apps Script)│
│  /sleepsite/ on the site │ ◄─────────────────────────────────────── │  web app: doGet / doPost     │
│  HTML/CSS/vanilla JS      │             JSON responses                │  state + ledger + logic      │
└──────────────────────────┘                                           │  time triggers: 9am,9pm,Sun  │
                                                                        │  sends Gmail natively         │
                                                                        └─────────────────────────────┘
```

- **Dashboard** — static page; shows balance, current streak, tonight's potential payout, freeze status, recent ledger; buttons to **record a night** and to **spend**. Login by email (magic link).
- **Backend (Apps Script)** — single source of truth. Owns all reward logic, storage, auth, email. Deployed as a web app ("execute as me / anyone").
- **Mailer** — same Apps Script project's **time-driven triggers** send the 9 PM and 9 AM emails and run the Sunday-night rollover. Email sent natively via `MailApp`/`GmailApp` (no SMTP, no app password).

### CORS note
GitHub Pages → Apps Script is cross-origin. To avoid unsupported preflight, the dashboard uses **GET** for reads and **POST with `Content-Type: text/plain`** (JSON encoded in the body) for writes — both are "simple requests." Apps Script returns JSON via `ContentService`.

## 4. Data model

**Per-person state** (Apps Script `PropertiesService`, one `states` blob keyed by email):
```json
{
  "you@example.com": {
    "balance": 0.00,
    "streak": 0,
    "weekStart": "2026-06-15",         // Monday of current freeze-week (local)
    "freezeAvailable": true,
    "freezeUsedThisWeek": false,
    "lastRecordedDate": "2026-06-17"   // the night date last recorded
  },
  "spouse@example.com": { ... }
}
```
The ledger spreadsheet id is stored in its own `ledgerId` property (global, not per person).

**Ledger** (auto-created Google Sheet, append-only): one row per event, the
`actor` column holds the person's email so each person's view is filtered to
their own rows.
Columns: `timestamp, type, nightDate, result, freezeUsed, amount, balanceAfter, actor, note`
Event `type` ∈ {`night`, `spend`, `weekly_bonus`}.

**Auth** (`PropertiesService`): `allowlist` = the two emails; `token:<token>` → `{email, expires}` (≈90-day tokens).

## 5. Key flows

**Record a night** (`POST record`): inputs `nightDate`, `result` (on_time | missed), optional `useFreeze`, and the `person` (whose night). Auth is either a login token (identifies the person) *or* a signed action token from that person's morning email (`HMAC(person|nightDate|result)`), so a link records only for the person it was sent to.
1. Reject if `nightDate` already recorded (idempotent).
2. `on_time` → `streak += 1`; `payout = min(0.25*streak, 5.00)`; `balance += payout`.
3. `missed` + freeze available → freeze **auto-used**: streak unchanged; payout 0; consume freeze.
4. `missed` + no freeze → `streak = 0`; payout 0.
5. Append ledger row; update state; return new state.

**Spend** (`POST spend`): inputs `amount`, `note`, auth. `balance -= amount` (floor at 0 / warn if over), ledger row.

**Login** (`POST requestLogin` → email link): email in allowlist → create token → email link `…/sleepsite/?token=XYZ`. Dashboard stores token in `localStorage`.

**State / transparency** (`GET action=state`): returns the caller's `state`, `name`, ledger, and `potentialTonight`, plus a read-only `partner` `{name, balance, streak, freezeAvailable}` so each spouse can see the other's streak, freeze status, and balance. (Optional `NAMES` map gives friendly display names.)

**9 PM email** (trigger): one personalized email **per person** with *their* **balance**, **tonight's potential payout** (`min(0.25*(streak+1), 5.00)`), and **streak length**.

**9 AM email** (trigger): one personalized email **per person** — "Were *you* in bed on time last night?" — with two one-tap links carrying that person's signed action token: ✅ on-time and ❌ missed. The ❌ link lands on a page offering the freeze (if available).

**Sunday-night rollover** (trigger, ~11 PM Sun): for **each person**, if `!freezeUsedThisWeek` → `balance += 3.50` (ledger `weekly_bonus` filed under that person); then `freezeAvailable=true`, `freezeUsedThisWeek=false`, advance `weekStart`.

## 6. Components / files

- `index.html` — dashboard markup.
- `css/style.css` — styling (match parent site's look where reasonable).
- `js/app.js` — fetch wrapper (GET/POST text/plain), render state, record/spend/login UI, handle `?token=` and morning action links.
- `backend/Code.gs` — Apps Script: router (`doGet`/`doPost`), reward engine (pure functions), storage helpers, email builders, trigger handlers, setup function.
- `backend/README.md` — deploy steps (create project, paste, set allowlist, deploy web app, install triggers, paste web-app URL into `js/app.js` config).
- `README.md` — project overview + GitHub Pages enablement.

## 7. Testing

- **Reward engine** is pure functions; test in Apps Script with a `runTests()` function covering: escalation & cap, miss-reset, freeze-preserve, weekly bonus when unused, no-bonus when used, idempotent re-record, week rollover.
- Manual: deploy, exercise record/spend/login and both emails via "Run trigger now".

## 8. Decisions & assumptions

- **Per-person** balance/streak/freeze/bonus (money is personal). Each records their own night; a missed night affects only that person's streak.
- Unrecorded nights cause **no** state change; the morning email is the prompt. Pending nights can be recorded later from the dashboard.
- Timezone fixed to **America/Denver**; set in Apps Script project settings + script constant.
- Deadline 9:30 PM is the human rule; the app doesn't auto-detect — you self-report via the morning link.

## 9. Out of scope (YAGNI)

Push notifications, screen-time auto-detection, multi-week analytics/charts, viewing the partner's full ledger or spending detail (only their streak/freeze/balance are shared), accounts beyond the two allowlisted emails.
