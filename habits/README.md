# 🌱 Habit Builder

A small, free web app that rewards a couple for keeping streaks across **multiple
categories** — sleep, exercise, chores, cleaning, or any category you create.
Each category has its own rules; all rewards flow into your single personal wallet.

## The rules

**Each person has their own independent wallet, and their own streak/freeze state
per category.** You each record your own entries.

Each category defines:

- **name** and an optional **emoji** — both head the habit's card and its emails
- **streak** — consecutive on-time entries
- **freeze count** — how many misses you can absorb before your streak breaks
- **reward increment** — what each streak step adds to the payout
- **minimum payout** — what a streak of 1 pays; blank means "start at the reward increment"
- **max per instance** — the payout cap for a single entry
- **miss penalty percent** — how much of the streak a freeze-less miss costs (default 100 = full reset)
- **cadence** — `daily` or `weekly` (how often you record one entry)
- **freeze-refresh cadence** — `daily`, `weekly`, or `monthly` (when freezes reset; independent of how often you record, so a daily task can refresh its freezes weekly or monthly)
- **unused-freeze bonus** — set to 0 for none

How entries work:

- On-time entry pays `minPayout + rewardIncrement × (streak − 1)`, capped at
  `maxPerInstance`. With no `minPayout` set that is the original
  `rewardIncrement × streak`.
- On a miss, a freeze is **auto-used** if you have one (streak preserved, $0 earned
  that period). With no freeze left, the streak drops to
  `round(streak × (1 − missPenaltyPercent / 100))` — at the default 100% that is a
  full reset to 0.
- At freeze-refresh, freezes reset; if no freeze was used and the bonus is > 0,
  the bonus is paid.
- Each period can be recorded **once**, checked against the ledger — so a
  check-up email that's still sitting in your inbox can't be tapped twice.
- Freezes remaining are derived from the category, not stored: state records how
  many you have *spent* this period. Raising or lowering **freeze count** in the
  Categories admin UI therefore takes effect on the next miss, not at the next
  refresh.

**Shared wallet:** all categories pay into your single personal wallet. **Spend**
debits it. **Add money** credits **both** people's wallets by the **full amount
each** — useful for mad-money / personal spending you want to record symmetrically.

**Undo:** the ✕ in *Recent activity* takes back the most recent entry for a
habit — the streak and freezes go back to what they were and the payout is
reversed, which is the way out of a misclicked ❌. Only the newest entry per
habit is undoable, and only your own. Undoing the one freeze a period spent
pays that period's unused-freeze bonus, even if the period has since closed.

**Full transparency:** the dashboard shows a read-only panel with your partner's
wallet balance (you can't spend or record for them).

**Wallets are always derived from the ledger**, never stored — a balance can't
drift from the entries that produced it, and correcting the sheet corrects the
wallet. The cost is one sheet read per dashboard load, which grows with your
history (~2,000 rows a year for two people on a daily habit). If it ever gets
slow, the answer is a periodic checkpoint row, not a cached balance.

> Tip: set the optional `NAMES` map in `Code.gs` (email → name) so the dashboard
> shows "Sam" / "Alex" instead of the email prefix.

## Categories

Tap **Categories** on the dashboard to add, edit, or archive categories live.
Settings are stored in Apps Script Properties — no redeploy needed. Either
allowlisted person can manage them.

Archived categories keep their history but stop prompting and emailing — and
stop accepting entries, including from check-up links already in your inbox.
Unarchiving resumes in the current period with a full freeze allowance — the
stretch spent archived earns no unused-freeze bonus. Changing the
**freeze-refresh cadence** settles any period that had already ended, then
re-bases, so an edit neither pays a bonus nor loses one you were owed.

## How it's built

Three free pieces:

| Piece | Job | Lives in |
| --- | --- | --- |
| **Dashboard** | The page you see: wallet, streaks, record an entry, spend, add money | `../habits/{index.html, css/, js/}` → GitHub Pages |
| **Backend** | Stores data, runs the rules, login, records entries | `backend/Code.gs` → Google Apps Script |
| **Mailer** | Sends reminder + check-up emails; handles freeze/bonus refresh | Apps Script hourly trigger (`emailDispatch`) |

The dashboard talks to Apps Script with JSONP, which sidesteps cross-origin
(CORS) problems.

```
Dashboard (GitHub Pages)  ──►  Apps Script web app  ──►  Gmail + Google Sheet ledger
```

One **hourly** `emailDispatch` trigger handles everything: per active category, it
sends a reminder email at that category's `reminderTime` and a one-tap check-up
email at its `checkupTime` (whole-hour times; blank = off), and performs the
freeze/bonus refresh at each category's period rollover.

## Setup order

Do these in order. Budget ~15 minutes.

1. **Know your dashboard URL.** If you host this as a subfolder of your site repo
   (recommended), it'll be:
   `https://<your-username>.github.io/<your-site-repo>/habits/`
   (or `https://<your-domain>/habits/` if you use a custom domain).

2. **Deploy the backend.** Follow [`backend/README.md`](backend/README.md):
   create the Apps Script project, paste `Code.gs`, set `ALLOWLIST` and
   `DASHBOARD_URL` (the URL from step 1), deploy as a Web app, and copy the
   `/exec` URL. There is no `SECRET` to fill in — the signing key is generated
   into Script Properties on first use.

3. **Wire the backend URL into the frontend.** Open `../habits/js/config.js` and
   paste the `/exec` URL into `WEB_APP_URL`.

4. **Publish the dashboard** (see next section), then in Apps Script run
   **`setup`** once to install the hourly trigger and create the ledger.

5. **Test.** Open your dashboard URL, log in by email, click the link Gmail sends,
   and record an entry.

## Migration note (upgrading from single-streak)

The ledger gained a `category` column and state moved to `{balance, cats}`.
After deploying the new `Code.gs`:

1. Clear the `ledgerId` Script Property. (Deleting the spreadsheet is *not*
   enough — a configured-but-unreadable ledger is treated as an outage and
   reported, not silently replaced. Clearing the property is what says
   "start a new one on purpose".)
2. Re-run `setup()` — this recreates the ledger with the new columns and installs
   the hourly trigger (replacing the old three fixed triggers).

Existing wallet balances are preserved (the old per-person `balance` carries into
the new shared wallet). Old per-person streak/freeze state is dropped (categories
are new and must be created in the Categories admin UI).

## Publishing (live at samnichols.dev/habits)

The dashboard is a subfolder of the `samsite` repo
(`github.com/snicker7/samsite`, served at `samnichols.dev`):

```
samsite/habits/{index.html, css/, js/}   ← the frontend, served
samsite/habits/{backend/, docs/}         ← backend, tests, docs (not served)
```

**Edit `habits/` directly.** There is no copy step and no second copy of the
frontend to keep in sync — `habits/` *is* the source. Commit and push, and it's
live at `https://samnichols.dev/habits/` within ~1 minute. `DASHBOARD_URL` in
`main.gs` is already set to this URL.

`backend/`, `docs/`, and this README are the pieces that are **not** served:
the Apps Script backend, its unit tests, and the design docs. They are kept out
of the published site by `exclude:` in the repo-root `_config.yml` — without
that, GitHub Pages would serve `backend/Code.gs` at
`samnichols.dev/habits/backend/Code.gs`. **Anything else you add under
`habits/` is public**, so put non-public files in `backend/` or `docs/`, or add
them to the exclude list.

## "Hiding" the URL — what's actually possible

GitHub Pages serves every file publicly; it **cannot** gate a path by email on
its own. Two layers handle privacy:

1. **App-level (already in place):** the page shows only a login box, and login
   works **only** for the two allowlisted emails, at most one login email per
   address every five minutes (otherwise anyone with the `/exec` URL could loop
   the endpoint and drain the daily Gmail send quota). No one else can see balances or
   streaks or record/spend anything. The page also has `noindex,nofollow` so it
   won't show up in search, and it isn't linked from your site nav.

2. **True URL gating (optional, free) — Cloudflare Access:** to stop the page from
   even *loading* for anyone else, put the site behind Cloudflare Zero Trust:
   - Add `samnichols.dev` to a (free) Cloudflare account and point DNS there.
   - Zero Trust → Access → Applications → **Self-hosted**, path
     `samnichols.dev/habits*`.
   - Policy: **Allow** emails `snic9004@gmail.com`, `sierra.author@gmail.com`
     (one-time PIN login). Everyone else gets blocked before the page loads.

   This is the only way to truly hide the URL while staying on GitHub Pages.

## Keep secrets out of the public repo

GitHub Pages repos are usually **public**. Therefore:

- **The email-link signing key is never in the code.** `ensureSecret()` mints it
  into Script Properties on first use, so there is nothing to redact before
  committing and nothing to re-enter after pasting `Code.gs`. Treat the `SECRET`
  Script Property like a password: it signs the one-tap ✅/❌ links, so anyone who
  learns it can record entries as either of you.
- `ALLOWLIST` and `DASHBOARD_URL` **are** committed in `backend/main.gs`. They're
  not secrets, but they do expose two email addresses to anyone reading the repo.
  `_config.yml` keeps `backend/` off the published site; the repo itself is
  still public. Blank them out here and set them in the editor if you'd rather
  not publish the addresses.
- `js/config.js`'s `WEB_APP_URL` is fine to be public (it's a public endpoint,
  and writes require a login token or a signed link).

(Unrelated, but worth doing: a GitHub personal-access token was found in a
plaintext file in your workspace earlier — revoke/rotate it on GitHub.)

## Shipping a change

### Which kind of change is it?

| You want to change… | What to do | Deploy needed? |
|---|---|---|
| Reward amounts, freeze counts, cadence, reminder times, add/archive a category | **Categories** admin UI in the app | No — takes effect immediately |
| How the dashboard looks or behaves | `index.html`, `css/style.css`, `js/app.js` | Push to GitHub only |
| Reward *mechanics*, storage, email, routes | `backend/engine.js` or `backend/main.gs` | Apps Script redeploy only |
| Anything crossing the API boundary (new action, changed params or response) | Both | **Backend first**, then push |

Most changes are the first row. Reach for code only when the admin UI can't
express what you want.

### Frontend-only change

1. Edit `index.html`, `css/style.css`, or `js/app.js`.
2. Preview locally:

   ```bash
   cd habits && python3 -m http.server 8000
   ```

   Open <http://localhost:8000/>. The API is JSONP, so there is no CORS problem
   from localhost — the page talks to the **real, live backend**. Anything you
   record locally is a real entry in the real ledger. Use a throwaway category,
   or delete the entry with the ✕ in *Recent activity* when you're done.
3. Commit and push. Live at <https://samnichols.dev/habits/> within ~1 minute.
4. Hard-refresh (Ctrl/Cmd-Shift-R) — the Pages CDN will otherwise serve you the
   old `app.js` for a few minutes.

### Backend-only change

1. Edit `backend/engine.js` (reward math) or `backend/main.gs` (routes, storage,
   email, auth). **Never edit `Code.gs`** — it is generated and your edits will
   be overwritten.
2. Test, then build:

   ```bash
   cd habits/backend
   node --test .      # expect: pass 53 (or more, if you added tests)
   node build.js      # regenerates Code.gs from main.gs + engine.js
   ```

   Add a test to `engine.test.js` first when the change is to reward logic —
   that's the part with real branching, and it's the only part testable outside
   Apps Script.
3. Copy **all** of `backend/Code.gs` and paste it over the `Code.gs` contents in
   the Apps Script editor (<https://script.google.com>), replacing everything.
4. **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**

   > ⚠️ Do **not** use *New deployment*. That mints a **different `/exec` URL**
   > and the live dashboard keeps talking to the old one. *Manage deployments*
   > keeps the URL stable, which is what `js/config.js` depends on.

   Saving the file in the editor is **not** enough — web apps serve the last
   deployed version, not the last saved one. Skipping this step is the single
   most common reason a change "didn't do anything."
5. Verify: run **`runTests`** from the editor's function dropdown → **Execution
   log** → expect `ALL PASS ✅`. Then reload the dashboard and exercise the path
   you changed.
6. Re-run **`setup`** only if you changed triggers or the ledger sheet's shape.
   It is safe to re-run; it does not clear data.

### Changes that cross the API boundary

Deploy the **backend first, then push the frontend.** The two are not versioned
together — Pages serves the new frontend to both of you within a minute of the
push, while Apps Script serves whatever version was last deployed.

The asymmetry is what makes the order matter:

- **New backend + old frontend** — fine. The backend ignores parameters it no
  longer needs (`doRecord` drops any client-supplied `periodKey`), so the old
  page keeps working until it's replaced.
- **Old backend + new frontend** — broken. The new page calls actions that don't
  exist yet and omits parameters the old backend still requires.

If you see the ⚠️ *"backend didn't return category data"* banner in the app, this
is exactly what happened: the frontend is newer than the deployed backend. Finish
step 4 above.

### Rolling back

Apps Script keeps every deployed version. **Manage deployments → ✏️ edit →
Version →** pick the previous one **→ Deploy**. The `/exec` URL is unchanged, so
the frontend needs no edit. Roll the frontend back with a normal `git revert` and
push. Data is never affected by either — it lives in Script Properties and the
Ledger sheet.

### If the app says the ledger can't be opened

Every wallet balance is replayed from the Ledger sheet, so the app refuses to
run rather than carry on against an empty one. Nothing is lost and nothing is
written while it's in that state. Either restore the spreadsheet from Drive's
trash, or set the `ledgerId` Script Property to the right spreadsheet id — the
balances come back on the next load.

## Project layout

```
samsite/
├─ _config.yml            # keeps backend/, docs/, README.md off the site
└─ habits/                # THE DASHBOARD — served at samnichols.dev/habits/
   ├─ index.html
   ├─ css/style.css
   ├─ js/{app.js, config.js}   # config.js ← paste WEB_APP_URL here
   ├─ README.md           # this file — not served
   ├─ backend/            # not served
   │  ├─ Code.gs          # generated — paste into Apps Script
   │  ├─ main.gs          # Apps Script glue — source
   │  ├─ engine.js        # reward logic (unit-tested)
   │  ├─ engine.test.js   # node --test
   │  ├─ build.js         # generates Code.gs from main.gs + engine.js
   │  └─ README.md        # backend deploy steps
   └─ docs/superpowers/   # design specs + implementation plans — not served
```
