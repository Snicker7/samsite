/**
 * Habit Builder — Google Apps Script backend.
 *
 * GENERATED FILE — do not edit directly.
 * Edit backend/main.gs (Apps Script glue) or backend/engine.js (reward
 * logic, unit-tested), then run:  node backend/build.js
 * Deploy: paste this whole file into the Apps Script editor.
 */

/**
 * Habit Builder — Apps Script glue (config, storage, HTTP router, emails).
 *
 * The reward rules live in engine.js (unit-tested with `node --test`).
 * Code.gs is GENERATED from main.gs + engine.js by `node build.js` —
 * edit those two files, never Code.gs.
 */

// ─────────────────────────────────────────────────────────────────────────
// CONFIG — edit these before deploying.
// ─────────────────────────────────────────────────────────────────────────
var TZ = 'America/Denver';

// Hour (local) at which a weekly freeze period hands over on Monday. Sunday's
// habit is answered Monday morning; settling at midnight would spend the new
// week's freeze on it and pay the old week's bonus before the answer arrived.
var WEEKLY_ROLLOVER_HOUR = 17;

// The two people who may log in (lowercase). Reminder emails go to both.
var ALLOWLIST = ['snic9004@gmail.com', 'sierra.author@gmail.com'];

// Optional display names. Falls back to the part before "@" if not listed.
var NAMES = {
  'snic9004@gmail.com': 'Sam',
  'sierra.author@gmail.com': 'Sierra',
};

// Where the dashboard lives (used in email links).
var DASHBOARD_URL = 'https://samnichols.dev/habits/';

// NOTE: the key that signs one-tap email links is NOT configured here — it is
// generated once and kept in Script Properties (see ensureSecret), so this
// file never carries a secret into the public repo.

// ─────────────────────────────────────────────────────────────────────────
// DATE HELPERS (all in TZ)
// ─────────────────────────────────────────────────────────────────────────
function tzDate(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}
function todayStr() {
  return tzDate(new Date());
}
// ISO day-of-week in TZ: 1=Mon..7=Sun.
function currentDow() {
  return parseInt(Utilities.formatDate(new Date(), TZ, 'u'), 10);
}
// Hour of day in TZ, 0..23.
function currentHourInt() {
  return parseInt(Utilities.formatDate(new Date(), TZ, 'HH'), 10);
}
// The weekly freeze period in force right now — see WEEKLY_ROLLOVER_HOUR.
function currentMondayStr() {
  var monday = mondayOf(todayStr(), currentDow());
  if (currentDow() === 1 && currentHourInt() < WEEKLY_ROLLOVER_HOUR) return shiftDays(monday, -7);
  return monday;
}
// The period a record button writes right now — see lastClosedPeriodKey.
function recordablePeriodKey(cat) {
  return lastClosedPeriodKey(cat.cadence, todayStr(), currentDow());
}
// First day of the current month, e.g. "2026-06-01" — stable across the month.
function currentMonthStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-01');
}

// ─────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────
function props() {
  return PropertiesService.getScriptProperties();
}
// states[email] = { cats: { [catId]: catState } }
// (older blobs may carry a leftover `balance` field — ignored; wallets are
//  derived from the ledger)
function statesAll() {
  var raw = props().getProperty('states');
  return raw ? JSON.parse(raw) : {};
}
function saveStatesAll(m) {
  props().setProperty('states', JSON.stringify(m));
}
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
function walletOf(email) { return deriveWallet(readLedgerRows(), email); }
function catStateOf(email, catId, cat) {
  var m = statesAll();
  if (!m[email]) m[email] = { cats: {} };
  if (!m[email].cats) m[email].cats = {};
  var s = m[email].cats[catId];
  if (s) {
    var migrated = migrateCatState(cat, s);
    if (migrated === s) return s;
    s = migrated;
  } else {
    s = initialCatState(cat, currentPeriodStart(cat));
  }
  m[email].cats[catId] = s;
  saveStatesAll(m);
  return s;
}
function saveCatState(email, catId, s) {
  var m = statesAll();
  if (!m[email]) m[email] = { cats: {} };
  if (!m[email].cats) m[email].cats = {};
  m[email].cats[catId] = s;
  saveStatesAll(m);
}

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
// A category written before chores existed has no kind — it is a habit.
function isHabit(c) { return c.kind !== 'chore'; }
function activeHabits() { return activeCategories().filter(isHabit); }
function activeChores() { return activeCategories().filter(function (c) { return !isHabit(c); }); }
// id -> display name, so history reads "Bedtime" after a rename instead of the
// slug it was first created under.
function categoryNames() {
  var m = {};
  categoriesAll().forEach(function (c) { m[c.id] = c.name; });
  return m;
}
// Period start for the category's freezeRefresh cadence (a "YYYY-MM-DD").
function currentPeriodStart(cat) {
  if (cat.freezeRefresh === 'daily') return todayStr();
  if (cat.freezeRefresh === 'monthly') return currentMonthStr();
  return currentMondayStr();
}

function ledgerSheet() {
  var id = props().getProperty('ledgerId');
  // No ledger configured yet -> first run, create one. A ledger that IS
  // configured but won't open is an outage, not a first run: creating a
  // replacement would overwrite ledgerId and strand every entry ever written.
  // Wallets are derived from the ledger, so both balances would silently read
  // $0 and would not come back when the spreadsheet did. Fail loudly instead.
  var ss = id ? openLedgerOrThrow(id) : createLedgerSpreadsheet();
  return ss.getSheetByName('Ledger') || ss.getSheets()[0];
}
function openLedgerOrThrow(id) {
  var ss = null;
  var why = '';
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    why = ' (' + ((e && e.message) || e) + ')';
  }
  if (!ss) {
    throw new Error(
      'The ledger spreadsheet could not be opened' + why + '. Nothing was changed. ' +
      'Restore it from Drive\'s trash, or point the ledgerId Script Property at the ' +
      'right spreadsheet. To deliberately start a new, empty ledger, clear ledgerId ' +
      'and re-run setup().'
    );
  }
  return ss;
}
function createLedgerSpreadsheet() {
  var ss = SpreadsheetApp.create('Habit Builder Ledger');
  var first = ss.getSheets()[0];
  first.setName('Ledger');
  first.appendRow([
    'id', 'timestamp', 'type', 'category', 'periodKey', 'result',
    'freezeUsed', 'amount', 'balanceAfter', 'actor', 'note',
  ]);
  props().setProperty('ledgerId', ss.getId());
  return ss;
}
function appendLedger(ev) {
  var id = Utilities.getUuid();
  ledgerSheet().appendRow([
    id, new Date(), ev.type, ev.category || '', ev.periodKey || '',
    ev.result || '', ev.freezeUsed === true, ev.amount || 0,
    ev.balanceAfter, ev.actor || '', ev.note || '',
  ]);
  return id;
}
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
      canDelete: r.type === 'spend' || r.type === 'deposit' || r.type === 'entry' || r.type === 'claim',
      timestamp: r.timestamp ? Utilities.formatDate(new Date(r.timestamp), TZ, 'yyyy-MM-dd HH:mm') : '',
      type: r.type, category: r.category,
      categoryName: names[r.category] || r.category,
      periodKey: r.periodKey, result: r.result,
      freezeUsed: r.freezeUsed, amount: r.amount, balanceAfter: r.balanceAfter,
      actor: r.actor, note: r.note,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────
// The one-tap email links are HMAC-signed. The key lives in Script Properties,
// never in this file — this repo is published by GitHub Pages, so a key checked
// in here would let anyone forge "✅ Yes" links for either person.
// Generated on first use; `setup()` also primes it. To carry over an existing
// key, set the `SECRET` Script Property by hand before deploying (otherwise
// one-tap links in already-sent emails stop verifying).
function ensureSecret() {
  var s = props().getProperty('SECRET');
  if (!s) {
    s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props().setProperty('SECRET', s);
  }
  return s;
}
function sign(msg) {
  var raw = Utilities.computeHmacSha256Signature(msg, ensureSecret());
  return raw
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
}
function actionSig(person, categoryId, periodKey, result) {
  return sign(person + '|' + categoryId + '|' + periodKey + '|' + result);
}
function verifyActionSig(person, categoryId, periodKey, result, sig) {
  return !!sig && sig === actionSig(person, categoryId, periodKey, result);
}
function newToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}
// Anyone who knows the /exec URL can call requestLogin. Without a throttle a
// loop over it drains the account's daily MailApp quota (~100 messages on a
// consumer account), which silently blocks the real login emails.
var LOGIN_COOLDOWN_MS = 5 * 60 * 1000;

function loginAllowed(email) {
  return withLock(function () {
    var key = 'login:' + email;
    var last = Number(props().getProperty(key) || 0);
    if (Date.now() - last < LOGIN_COOLDOWN_MS) return false;
    props().setProperty(key, String(Date.now()));
    return true;
  });
}

function requestLogin(email) {
  email = (email || '').trim().toLowerCase();
  if (ALLOWLIST.indexOf(email) === -1) return { ok: true }; // don't reveal allowlist
  // Same answer either way, so a caller can't probe the cooldown any more than
  // they can probe the allowlist.
  if (!loginAllowed(email)) return { ok: true };
  var token = newToken();
  props().setProperty(
    'token:' + token,
    JSON.stringify({ email: email, expires: Date.now() + 90 * 24 * 3600 * 1000 })
  );
  var link = DASHBOARD_URL + '?token=' + token;
  MailApp.sendEmail({
    to: email,
    subject: 'Your Habit Builder login link',
    htmlBody:
      '<p>Tap to open your Habit Builder dashboard (valid 90 days on this device):</p>' +
      '<p><a href="' + link + '" style="font-size:18px">Open Habit Builder →</a></p>',
  });
  return { ok: true };
}
function verifyToken(token) {
  if (!token) return null;
  var raw = props().getProperty('token:' + token);
  if (!raw) return null;
  var t = JSON.parse(raw);
  if (t.expires < Date.now()) {
    props().deleteProperty('token:' + token);
    return null;
  }
  return t.email;
}

// ─────────────────────────────────────────────────────────────────────────
// CONCURRENCY + HOUSEKEEPING
// ─────────────────────────────────────────────────────────────────────────
// Serializes read-modify-write sections (states blob, ledger rows) so two
// simultaneous requests can't double-record or clobber each other's saves.
// NOTE: not reentrant — never call withLock inside withLock.
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Login tokens live 90 days; expired ones were only deleted if someone tried
// to use them. Sweep hourly so Script Properties don't accumulate forever.
function cleanupTokens() {
  var all = props().getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('token:') !== 0) return;
    try {
      var t = JSON.parse(all[k]);
      if (t.expires < Date.now()) props().deleteProperty(k);
    } catch (e) {
      props().deleteProperty(k); // unparseable token record — junk
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP ROUTER (JSONP-friendly: every call works as a GET with ?callback=)
// ─────────────────────────────────────────────────────────────────────────
function doGet(e) {
  return handle(e.parameter || {});
}
function doPost(e) {
  var p = {};
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    p = e.parameter || {};
  }
  return handle(p);
}
function handle(p) {
  var result;
  try {
    result = route(p);
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  var json = JSON.stringify(result);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + json + ')').setMimeType(
      ContentService.MimeType.JAVASCRIPT
    );
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
function route(p) {
  switch (p.action) {
    case 'requestLogin': return requestLogin(p.email);
    case 'state': return stateResponse(requireUser(p));
    case 'record': return withLock(function () { return doRecord(p); });
    case 'spend': return withLock(function () { return doSpend(p); });
    case 'deposit': return withLock(function () { return doDeposit(p); });
    case 'deleteEntry': return withLock(function () { return doDeleteEntry(p); });
    case 'amend': return withLock(function () { return doAmend(p); });
    case 'catHistory': return doCatHistory(p);
    case 'claim': return withLock(function () { return doClaim(p); });
    case 'listCategories': return doListCategories(p);
    case 'saveCategory': return withLock(function () { return doSaveCategory(p); });
    case 'archiveCategory': return withLock(function () { return doArchiveCategory(p); });
    case 'unarchiveCategory': return withLock(function () { return doUnarchiveCategory(p); });
    default: return { ok: true, name: 'Habit Builder API' };
  }
}
function requireUser(p) {
  var email = verifyToken(p.token);
  if (!email) throw new Error('not authorized — please log in again');
  return email;
}
function displayName(email) {
  if (NAMES && NAMES[email]) return NAMES[email];
  return (email || '').split('@')[0];
}
function partnerOf(email) {
  for (var i = 0; i < ALLOWLIST.length; i++) {
    if (ALLOWLIST[i] !== email) return ALLOWLIST[i];
  }
  return null;
}
// Make sure m[email].cats has a state for every cat; returns true if it added any.
function ensureCatStates(m, email, cats) {
  if (!m[email]) m[email] = { cats: {} };
  if (!m[email].cats) m[email].cats = {};
  var changed = false;
  cats.forEach(function (cat) {
    var s = m[email].cats[cat.id];
    if (!s) {
      m[email].cats[cat.id] = initialCatState(cat, currentPeriodStart(cat));
      changed = true;
      return;
    }
    var migrated = migrateCatState(cat, s);
    if (migrated !== s) {
      m[email].cats[cat.id] = migrated;
      changed = true;
    }
  });
  return changed;
}

// True when this user has a category whose period has rolled over, whose state
// is missing, or whose state predates the derived-freeze shape — i.e. when
// stateResponse must take the lock and write.
function refreshNeeded(email, cats) {
  var m = statesAll();
  for (var i = 0; i < cats.length; i++) {
    var s = m[email] && m[email].cats && m[email].cats[cats[i].id];
    if (!s || s.freezesUsedThisPeriod == null || s.freezeRefresh == null || s.since == null) return true;
    if (refreshAction(s, cats[i], currentPeriodStart(cats[i])) !== 'none') return true;
  }
  return false;
}
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
function catPublic(email, cat) {
  return catPublicFromState(cat, catStateOf(email, cat.id, cat));
}
function stateResponse(email) {
  var active = activeHabits();
  // Freezes refresh at each category's period rollover. The hourly trigger is
  // not the only thing allowed to do it: between a boundary and the next
  // trigger run the dashboard would otherwise report — and a miss would spend —
  // the previous period's leftovers.
  if (refreshNeeded(email, active) || sweepNeeded()) {
    // Re-read under the lock so a concurrent mutation isn't clobbered.
    withLock(function () {
      active.forEach(maybeRefresh);
      var rows0 = null;
      sweepChores(function () { if (rows0 === null) rows0 = readLedgerRows(); return rows0; });
      var mm = statesAll();
      if (ensureCatStates(mm, email, active)) saveStatesAll(mm);
    });
  }
  var rows = readLedgerRows(); // ONE sheet read serves both wallets + the ledger panel
  var myRows = runningBalanceRows(rows, email); // ...and ONE pass serves both of mine
  var myState = (statesAll()[email] || {}).cats || {};
  var cats = active.map(function (c) {
    return catPublicFromState(c, myState[c.id] || initialCatState(c, currentPeriodStart(c)), myRows);
  });
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
  var resp = {
    ok: true, user: email, name: displayName(email),
    wallet: myRows.length ? myRows[myRows.length - 1].balanceAfter : 0,
    cats: cats,
    chores: chores,
    ledger: recentLedger(myRows, 20),
  };
  var pe = partnerOf(email);
  if (pe) resp.partner = { name: displayName(pe), wallet: deriveWallet(rows, pe) };
  return resp;
}
function doRecord(p) {
  var categoryId = p.categoryId;
  var result = p.result;
  var cat = categoryById(categoryId);
  if (!cat) return { ok: false, error: 'unknown category' };
  if (!isHabit(cat)) return { ok: false, error: 'chores are claimed, not answered — use its card on the dashboard' };
  // Archiving stops the prompting and the emails; a link sent before it was
  // archived must not still pay into the wallet.
  if (!cat.active) return { ok: false, error: 'that habit is archived' };
  var person, periodKey;
  var loginEmail = verifyToken(p.token);
  if (loginEmail) {
    person = loginEmail;
    // Dashboard path: the SERVER decides which period is being recorded
    // (the just-closed one, in TZ), so device clocks/timezones can't skew
    // entries and arbitrary keys can't inflate streaks.
    periodKey = recordablePeriodKey(cat);
  } else {
    person = (p.person || '').trim().toLowerCase();
    periodKey = p.periodKey; // signed email links carry a server-issued key
    if (!verifyActionSig(person, categoryId, periodKey, result, p.sig)) {
      return { ok: false, error: 'not authorized' };
    }
  }
  if (ALLOWLIST.indexOf(person) === -1) return { ok: false, error: 'unknown person' };
  maybeRefresh(cat); // a miss must spend this period's freezes, not last one's
  var rows = readLedgerRows(); // read after the refresh, so any bonus row is in it
  // The ledger, not state's most-recent key, decides whether this period is
  // already spoken for — otherwise an old signed check-up link credits a period
  // that a later entry has already superseded.
  if (isPeriodRecorded(rows, person, categoryId, periodKey)) {
    return { ok: false, error: 'period ' + periodKey + ' already recorded' };
  }
  var entryFps = freezePeriodStart(cat.freezeRefresh, periodKeyDate(periodKey));
  if (entryFps !== currentPeriodStart(cat)) {
    // A late answer: its freeze period already rolled over, so the live path
    // would spend the wrong period's freeze and the settled bonus would never
    // reconcile. Append and replay instead — the same self-correcting route
    // an amend gap-fill takes.
    var before = entryRowsFor(rows, person, categoryId);
    var lateId = appendLedger({
      type: 'entry', category: cat.id, periodKey: periodKey, result: result,
      freezeUsed: false, amount: 0, balanceAfter: '', actor: person,
    });
    var late = replayAndSave(person, cat, before, lateId);
    var le = late.entry || {};
    return {
      ok: true, user: person, wallet: late.wallet, cat: catPublic(person, cat),
      event: { type: 'entry', category: cat.id, periodKey: periodKey, result: result,
        freezeUsed: le.freezeUsed === true, amount: Number(le.amount) || 0 },
    };
  }
  var s = catStateOf(person, categoryId, cat);
  var out = applyEntry(s, deriveWallet(rows, person), cat, { periodKey: periodKey, result: result, actor: person });
  appendLedger(out.event);
  saveCatState(person, categoryId, out.state);
  return { ok: true, user: person, wallet: out.balance, cat: catPublic(person, cat), event: out.event };
}
function doSpend(p) {
  var email = requireUser(p);
  var out = applySpend(walletOf(email), { amount: Number(p.amount), note: p.note || '', actor: email });
  appendLedger(out.event);
  return { ok: true, wallet: out.balance, event: out.event };
}
// Add-money: credit BOTH allowlisted people the FULL amount each.
function doDeposit(p) {
  var email = requireUser(p); // must be logged in to initiate
  var amount = Number(p.amount);
  var note = p.note || '';
  if (!(amount > 0)) return { ok: false, error: 'amount must be positive' };
  var rows = readLedgerRows();
  var walletAfter = 0;
  ALLOWLIST.forEach(function (person) {
    var out = applyDeposit(deriveWallet(rows, person), { amount: amount, note: note, actor: person });
    appendLedger(out.event);
    if (person === email) walletAfter = out.balance;
  });
  return { ok: true, wallet: walletAfter };
}
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
  if (match.type === 'entry') {
    var cat = categoryById(match.category);
    if (!cat) return { ok: false, error: 'unknown category' };
    // Settle any pending rollover first — replaying against a stale period start pays the closed week's bonus twice. (Appends only, so match.rowNumber stays valid.)
    maybeRefresh(cat);
    var before = entryRowsFor(rows, email, cat.id);
    ledgerSheet().deleteRow(match.rowNumber);
    // replayAndSave re-reads the sheet, so the deletion's row shift is safe.
    var out = replayAndSave(email, cat, before, null);
    return { ok: true, wallet: out.wallet, cat: catPublic(email, cat) };
  }
  if (match.type === 'claim') {
    var ccat = categoryById(match.category);
    ledgerSheet().deleteRow(match.rowNumber);
    // A once-chore was archived by its claim; taking the claim back reopens it.
    if (ccat && !isHabit(ccat) && ccat.cadence === 'once') {
      var clist = categoriesAll();
      for (var ci = 0; ci < clist.length; ci++) if (clist[ci].id === ccat.id) clist[ci].active = true;
      saveCategories(clist);
    }
    // The sweep only walks forward from sweepFrom — without rewinding it here,
    // claiming then un-claiming a period the sweep has already passed would
    // dodge its penalty forever, and the period would never show as
    // outstanding again either.
    if (ccat && !isHabit(ccat) && ccat.cadence !== 'once') {
      var cm2 = choreStatesAll();
      var s2 = cm2[ccat.id];
      if (s2 && String(match.periodKey) < s2.sweepFrom) {
        s2.sweepFrom = String(match.periodKey);
        saveChoreStates(cm2);
      }
    }
    return { ok: true, wallet: walletWithout(rows, email, match.id) };
  }
  if (match.type !== 'spend' && match.type !== 'deposit') {
    return { ok: false, error: 'that row can\'t be removed here' };
  }
  ledgerSheet().deleteRow(match.rowNumber);
  return { ok: true, wallet: walletWithout(rows, email, match.id) };
}
// The wallet as it stands once `id` is gone, computed from the rows we already
// read. Wallets stay derived from the ledger — never cached — so the only thing
// worth avoiding is reading the same sheet twice in one request.
function walletWithout(rows, email, id) {
  return deriveWallet(rows.filter(function (r) { return String(r.id) !== String(id); }), email);
}
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
  // Corrections land on the in-memory rows first; the sheet is touched once, at
  // the end, with a single ranged write instead of up to three calls per
  // rippled row — Apps Script charges for the round trips, not the cells.
  var minRow = 0;
  var maxRow = 0;
  function touch(rowNumber) {
    if (!minRow || rowNumber < minRow) minRow = rowNumber;
    if (rowNumber > maxRow) maxRow = rowNumber;
  }
  var changed = 0;
  mine.forEach(function (row) {
    var e = corrected[String(row.id)];
    if (isTrueFlag(row.freezeUsed) === e.freezeUsed && (Number(row.amount) || 0) === e.amount) return;
    if (String(row.id) !== String(excludeId)) changed++;
    row.freezeUsed = e.freezeUsed;
    row.amount = e.amount;
    touch(row.rowNumber);
  });
  // The stored balanceAfter column is cosmetic (the app re-derives), but keep
  // the sheet readable for humans: rewrite cells the correction shifted.
  var a = String(email || '').toLowerCase();
  var myAll = rows.filter(function (x) { return String(x.actor || '').toLowerCase() === a; });
  var rb = runningBalanceRows(rows, email);
  for (var i = 0; i < rb.length; i++) {
    if (Number(myAll[i].balanceAfter) !== rb[i].balanceAfter) {
      myAll[i].balanceAfter = rb[i].balanceAfter;
      touch(myAll[i].rowNumber);
    }
  }
  if (minRow) {
    // rows[] is every sheet row from 2 down, so rows[n - 2] is sheet row n.
    // Rows inside the span that nothing touched are written back as they are.
    var values = [];
    for (var n = minRow; n <= maxRow; n++) {
      var src = rows[n - 2];
      values.push([isTrueFlag(src.freezeUsed), Number(src.amount) || 0, Number(src.balanceAfter) || 0]);
    }
    sh.getRange(minRow, 7, values.length, 3).setValues(values);
  }
  var wallet = rb.length ? rb[rb.length - 1].balanceAfter : 0;
  // catStateOf runs the migration, so s.since is always populated by here.
  var s = catStateOf(email, cat.id, cat);
  var delta = bonusDelta(cat, beforeEntries, r.entries, curStart, s.since);
  if (delta !== 0) {
    // A negative adjustment can push the wallet below zero; that is honest
    // accounting for money already banked, so it is not floored.
    wallet = round2(wallet + delta);
    appendLedger({
      type: 'bonus', category: cat.id, amount: delta,
      note: 'Bonus adjustment (answer changed)', actor: email, balanceAfter: wallet,
    });
  }
  saveCatState(email, cat.id, {
    streak: r.state.streak,
    periodStart: s.periodStart,
    freezeRefresh: s.freezeRefresh,
    freezesUsedThisPeriod: r.state.freezesUsedThisPeriod,
    lastRecordedKey: r.state.lastRecordedKey,
    since: s.since,
  });
  return {
    wallet: wallet, changed: changed, bonusDelta: delta,
    entry: excludeId != null ? corrected[String(excludeId)] || null : null,
  };
}
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
  if (!isHabit(cat)) return { ok: false, error: 'chores are claimed, not answered — use its card on the dashboard' };
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
  var ae = out.entry || {};
  return {
    ok: true, wallet: out.wallet, cat: catPublic(email, cat),
    event: { periodKey: periodKey, result: result,
      freezeUsed: ae.freezeUsed === true, amount: Number(ae.amount) || 0 },
    ripple: { entriesChanged: out.changed, bonusDelta: out.bonusDelta },
  };
}
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
function doListCategories(p) {
  requireUser(p);
  return {
    ok: true, categories: categoriesAll(),
    people: ALLOWLIST.map(function (e) { return { email: e, name: displayName(e) }; }),
  };
}
function doSaveCategory(p) {
  requireUser(p);
  var raw = p.category ? (typeof p.category === 'string' ? JSON.parse(p.category) : p.category) : p;
  var cat = normalizeCategory(raw);
  var errs = validateCategory(cat);
  if (errs.length) return { ok: false, error: errs.join(' ') };
  // The pure engine can't see ALLOWLIST, so this allowlist check belongs to
  // the glue, not validateCategory.
  if (!isHabit(cat) && cat.assignee && ALLOWLIST.indexOf(cat.assignee) === -1) {
    return { ok: false, error: 'assignee must be one of the two of you' };
  }
  var list = categoriesAll();
  var idx = -1;
  for (var i = 0; i < list.length; i++) if (list[i].id === cat.id) idx = i;
  var oldCadence = idx >= 0 ? list[idx].cadence : null;
  if (idx >= 0) {
    // Each kind's state machinery (streak state vs. choreStates) replays
    // against the ledger under assumptions the other kind's rows would
    // corrupt — a category's kind is fixed for its lifetime.
    var oldKind = list[idx].kind === 'chore' ? 'chore' : 'habit';
    var newKind = isHabit(cat) ? 'habit' : 'chore';
    if (oldKind !== newKind) {
      return { ok: false, error: 'a category can\'t change between habit and chore — archive it and create a new one' };
    }
    // The admin form carries only the fields it renders. Anything it omits
    // keeps its stored value — otherwise every edit wiped the emoji and
    // un-archived an archived category.
    if (raw.emoji == null) cat.emoji = list[idx].emoji || '';
    if (raw.active == null) cat.active = list[idx].active !== false;
    // A period that has already ended must be settled under the cadence that
    // was in force when it ended. Without this the rebase below — which is
    // right to refuse payment for an *edit* — also swallows the real rollover.
    if (list[idx].active && cat.freezeRefresh !== list[idx].freezeRefresh) {
      maybeRefresh(list[idx]);
    }
    list[idx] = cat;
  } else {
    list.push(cat);
  }
  saveCategories(list);
  if (!isHabit(cat)) {
    var cm = choreStatesAll();
    if (oldCadence && oldCadence !== cat.cadence) {
      // The stored `since` is a period key in the OLD cadence's format
      // (e.g. a date vs. "YYYY-MM" vs. "YYYY-Www") — doClaim's lexicographic
      // `periodKey < since` floor and stateResponse's outstanding filter both
      // compare it against NEW-format keys, so preserving it silently
      // mismatches (a daily->monthly edit bricks claiming all month; a
      // daily->weekly edit disables the floor entirely). Restart both at the
      // current period instead.
      var cur = claimablePeriodKey(cat, todayStr());
      cm[cat.id] = { since: cur, sweepFrom: cur };
      saveChoreStates(cm);
    } else if (!cm[cat.id]) {
      var cur2 = claimablePeriodKey(cat, todayStr());
      cm[cat.id] = { since: cur2, sweepFrom: cur2 };
      saveChoreStates(cm);
    }
  }
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
function doUnarchiveCategory(p) {
  requireUser(p);
  var id = p.categoryId;
  var list = categoriesAll();
  var cat = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) { list[i].active = true; cat = list[i]; }
  }
  saveCategories(list);
  // Archived categories are skipped by maybeRefresh, so the stored period start
  // is however old the archive is. Left alone, the next refresh reads that gap
  // as one period ending and pays an unused-freeze bonus for weeks the habit
  // wasn't running. Resume in the current period instead, unpaid.
  if (cat && isHabit(cat)) restartPeriod(cat);
  if (cat && !isHabit(cat) && cat.cadence !== 'once') {
    // The archived stretch owes nothing — resume sweeping at the current period.
    var cm = choreStatesAll();
    var s = cm[cat.id] || { since: claimablePeriodKey(cat, todayStr()) };
    s.sweepFrom = claimablePeriodKey(cat, todayStr());
    cm[cat.id] = s;
    saveChoreStates(cm);
  }
  return { ok: true, categories: list };
}
// Move everyone's state for this category into the current period without
// settling the previous one. Caller holds the lock.
function restartPeriod(cat) {
  var newStart = currentPeriodStart(cat);
  ALLOWLIST.forEach(function (email) {
    var s = catStateOf(email, cat.id, cat);
    if (s.periodStart === newStart && s.freezeRefresh === cat.freezeRefresh) return;
    saveCatState(email, cat.id, applyRestart(s, cat, newStart));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// EMAILS (time-driven triggers)
// ─────────────────────────────────────────────────────────────────────────
function money(n) {
  return '$' + Number(n).toFixed(2);
}

function currentHourStr() {
  return Utilities.formatDate(new Date(), TZ, 'HH') + ':00';
}

// Runs hourly. Sends reminders + check-ups for categories scheduled this hour,
// and performs freeze/bonus refresh when a category's period has rolled over.
// Weekly categories are gated to one reminder (Sun) + one check-up (Mon) —
// a mid-week check-up would record the still-open week.
function emailDispatch() {
  cleanupTokens();
  var hour = currentHourStr();
  var dow = currentDow();
  var cats = activeHabits();
  withLock(function () {
    cats.forEach(maybeRefresh);
    var rows = null;
    sweepChores(function () { if (rows === null) rows = readLedgerRows(); return rows; });
  });
  cats.forEach(function (cat) {
    if (cat.reminderTime && cat.reminderTime === hour && shouldSendReminder(cat, dow)) sendReminder(cat);
    if (cat.checkupTime && cat.checkupTime === hour && shouldSendCheckup(cat, dow)) sendCheckup(cat);
  });
  activeChores().forEach(function (cat) {
    if (cat.reminderTime && cat.reminderTime === hour) sendChoreReminder(cat);
  });
}

// Refresh a category's freezes/bonus when its period boundary has passed.
function maybeRefresh(cat) {
  var newStart = currentPeriodStart(cat);
  // One sheet read serves the whole loop: each actor's rows are independent, so
  // a bonus appended for one person can't change what the next one is owed.
  // Deferred because maybeRefresh runs on every record/amend/delete and only an
  // actual rollover needs the ledger at all.
  var rows = null;
  var getRows = function () { if (rows === null) rows = readLedgerRows(); return rows; };
  ALLOWLIST.forEach(function (email) {
    var s = catStateOf(email, cat.id, cat);
    var act = refreshAction(s, cat, newStart);
    if (act === 'none') return;
    if (act === 'rebase') {
      saveCatState(email, cat.id, applyRebase(s, cat, newStart));
      return;
    }
    var hadEntries = periodHasEntries(cat, entryRowsFor(getRows(), email, cat.id), s.periodStart);
    var out = applyRefresh(s, deriveWallet(getRows(), email), cat, newStart, hadEntries);
    saveCatState(email, cat.id, out.state);
    if (out.event) { out.event.actor = email; appendLedger(out.event); }
  });
}

function sendReminder(cat) {
  ALLOWLIST.forEach(function (to) {
    var s = catStateOf(to, cat.id, cat);
    var potential = payout(cat, s.streak + 1);
    var subject = (cat.emoji || '🔥') + ' ' + cat.name + ' — ' + money(potential) + ' on the line';
    var heading = escapeHtml(cat.emoji || '🔥') + ' ' + escapeHtml(cat.name);
    var html =
      '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
      '<h2>' + heading + '</h2>' +
      '<p>Doing it earns <b>you</b> <b>' + money(potential) + '</b>.</p>' +
      '<ul><li>Streak: <b>' + s.streak + '</b></li>' +
      '<li>Freezes left: <b>' + freezesLeft(cat, s) + '</b></li></ul></div>';
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
  });
}

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

function sendCheckup(cat) {
  // Ask about the period that just closed — the same one the dashboard buttons
  // write, so a check-up answer and a dashboard tap can't land on different keys.
  var periodKey = recordablePeriodKey(cat);
  var btn = 'display:inline-block;padding:14px 22px;margin:6px 0;border-radius:10px;font-size:18px;text-decoration:none;color:#fff';
  var rows = readLedgerRows();
  ALLOWLIST.forEach(function (to) {
    if (isPeriodRecorded(rows, to, cat.id, periodKey)) return; // already recorded — no nag
    var base = DASHBOARD_URL + '?person=' + encodeURIComponent(to) +
      '&categoryId=' + encodeURIComponent(cat.id) + '&periodKey=' + encodeURIComponent(periodKey);
    var yesUrl = base + '&result=on_time&sig=' + actionSig(to, cat.id, periodKey, 'on_time');
    var noUrl = base + '&result=missed&sig=' + actionSig(to, cat.id, periodKey, 'missed');
    var subject = 'Did you do ' + cat.name + '? ' + (cat.emoji || '');
    var html =
      '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
      '<h2>' + escapeHtml(cat.emoji || '☀️') + ' ' + escapeHtml(cat.name) +
      ' — ' + escapeHtml(periodKey) + '</h2>' +
      '<p><a href="' + yesUrl + '" style="' + btn + ';background:#2e7d32">✅ Yes</a></p>' +
      '<p><a href="' + noUrl + '" style="' + btn + ';background:#b00020">❌ No</a></p>' +
      '<p style="color:#666;font-size:13px">If you miss and still have a freeze, it\'s used automatically.</p></div>';
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
  });
}

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
  var data = ss.getSheets()[0];
  if (data.getName() !== 'Totals' && data.getName() !== 'Ledger') data.setName('Ledger');
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

// ─────────────────────────────────────────────────────────────────────────
// SETUP — run once after pasting + configuring.
// ─────────────────────────────────────────────────────────────────────────
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('emailDispatch').timeBased().everyHours(1).create();
  ensureSecret(); // mint the email-link signing key if this project has none
  ledgerSheet();
  migrateLedgerIdColumn();
  ensureTotalsTab();
  Logger.log('Setup complete. Hourly emailDispatch installed; ledger ready.');
  return 'setup complete';
}

// ─────────────────────────────────────────────────────────────────────────
// TESTS — run manually; check the execution log for "ALL PASS".
// ─────────────────────────────────────────────────────────────────────────
function runTests() {
  var fails = [];
  function eq(a, b, m) { if (a !== b) fails.push(m + ' (got ' + a + ', want ' + b + ')'); }
  var cat = { id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0, freezesPerPeriod: 1, unusedFreezeBonus: 3.5 };
  eq(payout(cat, 1), 0.25, 'payout d1');
  eq(payout(cat, 20), 5.0, 'payout cap');
  var floored = { rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 1.0 };
  eq(payout(floored, 1), 1.0, 'payout floor start');
  eq(payout(floored, 3), 1.5, 'payout floor growth');
  var missState = { streak: 10, periodStart: 'P', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  eq(applyEntry(missState, 0, cat, { periodKey: 'K', result: 'missed' }).state.streak, 0, 'miss default resets');
  eq(applyEntry(missState, 0, { id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0, freezesPerPeriod: 1, missPenaltyPercent: 50 },
    { periodKey: 'K', result: 'missed' }).state.streak, 5, 'miss penalty halves');
  eq(periodKeyFor('weekly', '2026-06-22'), '2026-W26', 'iso week');
  eq(lastClosedPeriodKey('daily', '2026-06-25', 4), '2026-06-24', 'daily records yesterday');
  eq(lastClosedPeriodKey('weekly', '2026-06-25', 4), '2026-W25', 'weekly records last week');
  var r = applyEntry(initialCatState(cat, 'P'), 0, cat, { periodKey: '2026-06-15', result: 'on_time' });
  eq(r.state.streak, 1, 'streak inc'); eq(r.balance, 0.25, 'pay d1');
  r = applyRefresh({ streak: 3, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: null }, 10, cat, 'P2', true);
  eq(r.balance, 13.5, 'bonus added');
  eq(r.state.freezesUsedThisPeriod, 0, 'refresh clears spent freezes');
  r = applyRefresh({ streak: 3, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: null }, 10, cat, 'P2', false);
  eq(r.balance, 10, 'no bonus for a period with no entries');
  // Freezes track the category, so editing freezesPerPeriod takes effect now.
  var spentOne = { streak: 4, periodStart: 'P', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  eq(freezesLeft({ freezesPerPeriod: 1 }, spentOne), 0, 'freezesLeft at the old allowance');
  eq(freezesLeft({ freezesPerPeriod: 3 }, spentOne), 2, 'freezesLeft after raising the allowance');
  eq(migrateCatState({ freezesPerPeriod: 2 },
    { streak: 4, freezeAvailable: 1, freezeUsedThisPeriod: true }).freezesUsedThisPeriod, 1, 'legacy state migrates');
  eq(mondayOf('2026-11-01', 7), '2026-10-26', 'mondayOf across the DST fallback');
  var led = [{ type: 'entry', actor: 'a@x', category: 'sleep', periodKey: 'P1' }];
  eq(isPeriodRecorded(led, 'a@x', 'sleep', 'P1'), true, 'ledger sees a recorded period');
  eq(isPeriodRecorded(led, 'a@x', 'sleep', 'P0'), false, 'ledger clears an unrecorded period');
  eq(isPeriodRecorded([], 'a@x', 'sleep', 'P1'), false, 'removing the row reopens the period');
  eq(applySpend(3, { amount: 5 }).balance, 0, 'spend floors');
  eq(applyDeposit(10, { amount: 20 }).balance, 30, 'deposit adds');
  var L = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'spend', amount: 4, actor: 'a' },
    { type: 'deposit', amount: 99, actor: 'b' },
  ];
  eq(deriveWallet(L, 'a'), 6, 'deriveWallet a');
  eq(deriveWallet(L, 'b'), 99, 'deriveWallet b');
  eq(runningBalanceRows(L, 'a').length, 2, 'rbr count');
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
  eq(periodHasEntries(rcat, [{ periodKey: '2026-06-23' }], '2026-06-22'), true, 'periodHasEntries finds the week');
  eq(periodHasEntries(rcat, [{ periodKey: '2026-06-18' }], '2026-06-22'), false, 'periodHasEntries skips other weeks');
  // House chores mirrors
  var chore = { id: 'd', kind: 'chore', cadence: 'daily', value: 2, assignee: '' };
  eq(claimablePeriodKey(chore, '2026-08-25'), '2026-08-25', 'chore claims today');
  eq(claimablePeriodKey({ cadence: 'monthly' }, '2026-08-25'), '2026-08', 'monthly claim key');
  eq(chorePayout(chore, 2), 4, 'shared late claim collects the pot');
  eq(chorePayout({ kind: 'chore', value: 2, assignee: 'a@x' }, 2), 2, 'assigned claim never collects the pot');
  eq(chorePenaltyAmounts(chore, ['a', 'b']).length, 2, 'shared penalty drains both');
  eq(nextChorePeriodKey('monthly', '2026-12'), '2027-01', 'monthly period walk crosses the year');
  if (fails.length) Logger.log('TEST FAILURES:\n' + fails.join('\n'));
  else Logger.log('ALL PASS ✅');
  return fails;
}

/**
 * Sleep Streak — reward engine (pure functions).
 *
 * No Apps Script or Node globals are used here, so this file is shared by:
 *   - the Node test suite (engine.test.js), and
 *   - the Apps Script backend (Code.gs includes this logic).
 *
 * All rules live here so there is exactly one source of truth.
 */

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * On-time payout for a given streak under a category's rules.
 * `minPayout` starts the curve (streak 1 pays it); each further step adds one
 * increment. Blank/0 means "start at the increment", i.e. the original curve.
 */
function payout(cat, streak) {
  if (streak <= 0) return 0;
  var start = cat.minPayout > 0 ? cat.minPayout : cat.rewardIncrement;
  return round2(Math.min(start + (streak - 1) * cat.rewardIncrement, cat.maxPerInstance));
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
  if (cadence === 'weekly') return isoWeek(dateStr);
  if (cadence === 'monthly') return String(dateStr).slice(0, 7);
  if (cadence === 'once') return 'once';
  return dateStr;
}

/** "YYYY-MM-DD" shifted by n days (UTC math, so DST can't skew it). */
function shiftDays(dateStr, n) {
  var p = dateStr.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The ISO Monday of the week containing `dateStr`, as "YYYY-MM-DD".
 *
 * Takes the day-of-week as an argument rather than subtracting 24-hour
 * multiples from a timestamp: an hour of DST shift is enough to push that
 * arithmetic onto the wrong calendar day, which silently starts a new freeze
 * period (and pays a second unused-freeze bonus).
 *
 * @param dateStr  "YYYY-MM-DD" in the app timezone
 * @param dow      ISO day-of-week for dateStr, 1=Mon..7=Sun
 */
function mondayOf(dateStr, dow) {
  return shiftDays(dateStr, -(dow - 1));
}

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
  // A monthly chore key ("YYYY-MM") needs a calendar date too, so it sorts and
  // buckets on the same axis as daily/weekly keys instead of falling through
  // to the "return as-is" case below.
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodKey))) return periodKey + '-01';
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
  if (cadence === 'monthly') {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
  }
  if (cadence === 'once') return key === 'once';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  var p = key.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return d.toISOString().slice(0, 10) === key;
}

/**
 * The period a chore claim targets RIGHT NOW. Chores are logged the day
 * they're done, so this is the current period — unlike habits, which record
 * the last closed one.
 */
function claimablePeriodKey(cat, dateStr) {
  return periodKeyFor(cat.cadence, dateStr);
}

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

/** Sheet cells round-trip booleans as true/'TRUE'/'true' depending on path. */
function isTrueFlag(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

/**
 * The most recently *closed* period — the one a record button may write.
 * Daily: yesterday. Weekly: the ISO week of the last Sunday.
 *
 * Weekly cannot just use yesterday: mid-week that still lands inside the
 * current, unfinished week, so tapping "Did it" on a Wednesday would credit a
 * week that hasn't happened yet (and then suppress Monday's check-up, which
 * skips any period already recorded).
 *
 * @param cadence  'daily' | 'weekly'
 * @param dateStr  today as "YYYY-MM-DD" in the app timezone
 * @param dow      ISO day-of-week for dateStr, 1=Mon..7=Sun
 */
function lastClosedPeriodKey(cadence, dateStr, dow) {
  if (cadence !== 'weekly') return shiftDays(dateStr, -1);
  return isoWeek(shiftDays(dateStr, -dow)); // dow days back is always a Sunday
}

/**
 * Email day-of-week gates (dow: 1=Mon..7=Sun, ISO).
 * Weekly categories get one reminder (Sunday, last day of the ISO week) and
 * one check-up (Monday, right after the week closes). Daily: every day.
 * Sending a weekly check-up mid-week would record the still-open week.
 */
function shouldSendReminder(cat, dow) {
  return cat.cadence !== 'weekly' || dow === 7;
}
function shouldSendCheckup(cat, dow) {
  return cat.cadence !== 'weekly' || dow === 1;
}

function initialCatState(cat, periodStart) {
  return {
    streak: 0,
    periodStart: periodStart || null,
    // The cadence `periodStart` was computed under. Without it, editing the
    // freeze-refresh dropdown looks exactly like a period ending.
    freezeRefresh: cat.freezeRefresh,
    freezesUsedThisPeriod: 0,
    lastRecordedKey: null,
    // Settlement began with this state; periods before it were never
    // settled, so bonus re-settlement must skip them.
    since: periodStart || null,
  };
}

/**
 * What this category's freeze period needs on this tick.
 *
 *   'none'    — still inside the same period
 *   'refresh' — the period ended: reset freezes, pay any unused-freeze bonus
 *   'rebase'  — the freeze-refresh *cadence* was edited, so the stored period
 *               start describes a rule that no longer applies. Move to the new
 *               one without paying: no time passed. Scoring this as a period
 *               ending let anyone mint the bonus by toggling week ⇄ month.
 */
function refreshAction(state, cat, newPeriodStart) {
  var was = state.freezeRefresh;
  if (was != null && was !== cat.freezeRefresh) return 'rebase';
  return state.periodStart === newPeriodStart ? 'none' : 'refresh';
}

/** Adopt the new cadence's period. Freezes already spent stay spent. */
function applyRebase(state, cat, newPeriodStart) {
  var s = Object.assign({}, state);
  s.periodStart = newPeriodStart;
  s.freezeRefresh = cat.freezeRefresh;
  return s;
}

/**
 * Begin a fresh freeze period without settling the one before it: full
 * allowance back, no unused-freeze bonus. For a category resuming after a
 * dormant stretch — the periods it sat out archived earned nothing, and
 * scoring the gap as one long period paid a bonus for weeks it wasn't running.
 * Streak and last-recorded key are history and are kept.
 */
function applyRestart(state, cat, newPeriodStart) {
  var s = Object.assign({}, state);
  s.freezesUsedThisPeriod = 0;
  s.periodStart = newPeriodStart;
  s.freezeRefresh = cat.freezeRefresh;
  // The pre-archive periods were never fully settled, so bonus re-settlement
  // must not reach back past the restart and pay for them now.
  s.since = newPeriodStart;
  return s;
}

/**
 * Freezes still available this period.
 *
 * Derived rather than stored: state records how many freezes were *spent*,
 * which is a fact about what happened, while the allowance lives on the
 * category and can be edited at any time. Storing the remainder instead made
 * an edit to `freezesPerPeriod` invisible until the next period rollover.
 */
function freezesLeft(cat, state) {
  var spent = Number(state.freezesUsedThisPeriod) || 0;
  return Math.max(0, (Number(cat.freezesPerPeriod) || 0) - spent);
}

/**
 * Bring a state blob written before freezes were derived up to the new shape.
 * The spent count is recovered from the stored remainder; exact unless the
 * category's allowance was edited during the period being migrated.
 */
function migrateCatState(cat, state) {
  if (state && state.freezesUsedThisPeriod != null && state.freezeRefresh != null && state.since != null) return state;
  var s = Object.assign({}, state);
  if (s.freezeRefresh == null) s.freezeRefresh = cat.freezeRefresh;
  // One-time amnesty for pre-existing habits: everything before the
  // migration-time period is exempt from re-settlement. A rare legitimately-
  // settled clawback/payback is forgone, but that's the safe direction.
  if (s.since == null) s.since = s.periodStart || null;
  if (s.freezesUsedThisPeriod != null) return s;
  var left = Number(s.freezeAvailable);
  s.freezesUsedThisPeriod = isNaN(left)
    ? 0
    : Math.max(0, (Number(cat.freezesPerPeriod) || 0) - left);
  delete s.freezeAvailable;
  delete s.freezeUsedThisPeriod;
  return s;
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
  } else if (freezesLeft(cat, state) > 0) {
    s.freezesUsedThisPeriod = (Number(state.freezesUsedThisPeriod) || 0) + 1;
    freezeUsed = true;
  } else {
    // No freeze left: the penalty decides how much of the streak survives.
    var pct = cat.missPenaltyPercent == null ? 100 : cat.missPenaltyPercent;
    s.streak = Math.max(0, Math.round(state.streak * (1 - pct / 100)));
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
 *
 * `hadEntries` gates the bonus: a period nobody recorded shouldn't pay for
 * "not needing" a freeze — otherwise ignoring a habit for a month earns more
 * than doing it, and the bonus becomes an idleness allowance.
 *
 * @returns {{state:object, balance:number, event:(object|null)}}
 */
function applyRefresh(state, balance, cat, newPeriodStart, hadEntries) {
  var s = Object.assign({}, state);
  var event = null;
  if (cat.unusedFreezeBonus > 0 && hadEntries && !(Number(state.freezesUsedThisPeriod) || 0)) {
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
  s.freezesUsedThisPeriod = 0;
  s.periodStart = newPeriodStart;
  s.freezeRefresh = cat.freezeRefresh;
  return { state: s, balance: balance, event: event };
}

function applySpend(balance, input) {
  var requested = round2(input.amount);
  if (!(requested > 0)) throw new Error('spend amount must be positive');
  var applied = round2(Math.min(requested, Math.max(0, balance)));
  var newBalance = round2(balance - applied);
  var event = {
    type: 'spend',
    amount: applied,
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

/**
 * Has this actor already recorded this category's period?
 *
 * Answered from the ledger, which holds every entry ever written. State's
 * `lastRecordedKey` remembers only the most recent period, so a signed
 * check-up link for an older one sailed past it and credited a period that had
 * already been superseded. Deleting an entry row reopens its period, which is
 * what lets an answer be cleared and re-recorded.
 */
function isPeriodRecorded(rows, actor, categoryId, periodKey) {
  var a = String(actor || '').toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type !== 'entry') continue;
    if (String(r.actor || '').toLowerCase() !== a) continue;
    if (String(r.category) !== String(categoryId)) continue;
    if (String(r.periodKey) === String(periodKey)) return true;
  }
  return false;
}

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

/** Does any entry fall inside the freeze period starting `periodStart`? */
function periodHasEntries(cat, entries, periodStart) {
  for (var i = 0; i < entries.length; i++) {
    if (freezePeriodStart(cat.freezeRefresh, periodKeyDate(entries[i].periodKey)) === periodStart) return true;
  }
  return false;
}

/**
 * Closed freeze periods that earned the unused-freeze bonus: at least one
 * entry, and no freeze spent. Mirrors what applyRefresh pays at rollover, so
 * comparing two of these maps says exactly what re-settlement owes.
 *
 * @param since  optional "YYYY-MM-DD"; periods before it predate the state
 *               and were never settled, so they're excluded either way.
 */
function freezeEarnedPeriods(cat, entries, currentPeriodStart, since) {
  var has = {};
  var spent = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var fps = freezePeriodStart(cat.freezeRefresh, periodKeyDate(e.periodKey));
    if (fps === currentPeriodStart) continue;
    if (since && fps < since) continue;
    has[fps] = true;
    if (isTrueFlag(e.freezeUsed)) spent[fps] = true;
  }
  var out = {};
  Object.keys(has).forEach(function (p) {
    if (!spent[p]) out[p] = true;
  });
  return out;
}

/**
 * Net unused-freeze-bonus correction implied by a history change. Uses the
 * category's CURRENT bonus value — old bonus rows carry no period key, so they
 * are compensated in aggregate, never edited (see the design doc's caveat).
 * Earning a period requires at least one entry in it as well as an unspent
 * freeze, so gap-filling an answer into a period that was empty (and therefore
 * paid nothing) never claws anything back. Periods predating the state's
 * `since` were never settled, so they are exempt in both directions.
 */
function bonusDelta(cat, beforeEntries, afterEntries, currentPeriodStart, since) {
  if (!(cat.unusedFreezeBonus > 0)) return 0;
  var before = freezeEarnedPeriods(cat, beforeEntries, currentPeriodStart, since);
  var after = freezeEarnedPeriods(cat, afterEntries, currentPeriodStart, since);
  var delta = 0;
  Object.keys(after).forEach(function (p) {
    if (!before[p]) delta += cat.unusedFreezeBonus; // earned now, never paid
  });
  Object.keys(before).forEach(function (p) {
    if (!after[p]) delta -= cat.unusedFreezeBonus; // paid then, not earned now
  });
  return round2(delta);
}

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

/** Neutralise markup for anything interpolated into an HTML email body. */
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Task 4 helpers (not exported)
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
    id: raw.id ? slugify(raw.id) : slugify(raw.name),
    name: String(raw.name || '').trim(),
    emoji: String(raw.emoji || '').trim(),
    kind: 'habit',
    cadence: raw.cadence === 'weekly' ? 'weekly' : (raw.cadence === 'daily' ? 'daily' : String(raw.cadence || '')),
    rewardIncrement: num(raw.rewardIncrement, NaN),
    maxPerInstance: num(raw.maxPerInstance, NaN),
    freezesPerPeriod: num(raw.freezesPerPeriod, NaN),
    freezeRefresh: raw.freezeRefresh === 'daily' || raw.freezeRefresh === 'monthly' ? raw.freezeRefresh : 'weekly',
    unusedFreezeBonus: raw.unusedFreezeBonus === '' || raw.unusedFreezeBonus == null ? 0 : num(raw.unusedFreezeBonus, 0),
    missPenaltyPercent: raw.missPenaltyPercent === '' || raw.missPenaltyPercent == null ? 100 : num(raw.missPenaltyPercent, 100),
    minPayout: raw.minPayout === '' || raw.minPayout == null ? 0 : num(raw.minPayout, 0),
    reminderTime: String(raw.reminderTime || '').trim(),
    checkupTime: String(raw.checkupTime || '').trim(),
    active: raw.active !== false,
  };
}

// Long enough for a ZWJ sequence like 👩‍👩‍👧 (11 code units), short enough that
// it can't take over an email subject line.
var MAX_EMOJI_LENGTH = 16;

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
  if (cat.cadence !== 'daily' && cat.cadence !== 'weekly') errs.push('Cadence must be daily or weekly.');
  if (!(cat.rewardIncrement > 0)) errs.push('Reward increment must be a positive number.');
  if (!(cat.maxPerInstance > 0)) errs.push('Max per instance must be a positive number.');
  if (!(cat.freezesPerPeriod >= 0) || cat.freezesPerPeriod % 1 !== 0) errs.push('Freezes per period must be a whole number (0 or more).');
  if (!(cat.unusedFreezeBonus >= 0)) errs.push('Unused-freeze bonus must be 0 or more.');
  if (!(cat.missPenaltyPercent >= 0 && cat.missPenaltyPercent <= 100)) errs.push('Miss penalty must be between 0 and 100 percent.');
  if (!(cat.minPayout >= 0)) errs.push('Minimum payout must be 0 or more.');
  else if (cat.minPayout > cat.maxPerInstance) errs.push('Minimum payout cannot exceed the max per instance.');
  if (!isWholeHour(cat.reminderTime)) errs.push('Reminder time must be a whole hour like 21:00, or blank.');
  if (!isWholeHour(cat.checkupTime)) errs.push('Check-up time must be a whole hour like 09:00, or blank.');
  return errs;
}

// Exported for Node tests; harmless no-op when pasted into Apps Script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    round2: round2,
    payout: payout,
    isoWeek: isoWeek,
    periodKeyFor: periodKeyFor,
    shiftDays: shiftDays,
    lastClosedPeriodKey: lastClosedPeriodKey,
    mondayOf: mondayOf,
    isoDow: isoDow,
    periodKeyDate: periodKeyDate,
    freezePeriodStart: freezePeriodStart,
    validPeriodKey: validPeriodKey,
    claimablePeriodKey: claimablePeriodKey,
    isChoreClaimed: isChoreClaimed,
    chorePotFor: chorePotFor,
    outstandingChorePeriods: outstandingChorePeriods,
    nextChorePeriodKey: nextChorePeriodKey,
    chorePenaltyAmounts: chorePenaltyAmounts,
    chorePayout: chorePayout,
    isTrueFlag: isTrueFlag,
    shouldSendReminder: shouldSendReminder,
    shouldSendCheckup: shouldSendCheckup,
    initialCatState: initialCatState,
    refreshAction: refreshAction,
    applyRebase: applyRebase,
    applyRestart: applyRestart,
    escapeHtml: escapeHtml,
    freezesLeft: freezesLeft,
    migrateCatState: migrateCatState,
    applyEntry: applyEntry,
    applyRefresh: applyRefresh,
    applySpend: applySpend,
    applyDeposit: applyDeposit,
    deriveWallet: deriveWallet,
    isPeriodRecorded: isPeriodRecorded,
    replayCategory: replayCategory,
    periodHasEntries: periodHasEntries,
    freezeEarnedPeriods: freezeEarnedPeriods,
    bonusDelta: bonusDelta,
    runningBalanceRows: runningBalanceRows,
    normalizeCategory: normalizeCategory,
    validateCategory: validateCategory,
  };
}
