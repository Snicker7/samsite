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
function currentMondayStr() {
  return mondayOf(todayStr(), currentDow());
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
function recentLedger(mine, email, n) {
  mine = mine.slice(Math.max(0, mine.length - n));
  var cats = (statesAll()[email] || {}).cats || {};
  var names = categoryNames();
  var undoable = {};
  Object.keys(cats).forEach(function (k) {
    if (cats[k] && cats[k].undo && cats[k].undo.id) undoable[String(cats[k].undo.id)] = true;
  });
  return mine.reverse().map(function (r) {
    return {
      id: r.id,
      canDelete: r.type === 'spend' || r.type === 'deposit' || undoable[String(r.id)] === true,
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
    if (!s || s.freezesUsedThisPeriod == null || s.freezeRefresh == null) return true;
    if (refreshAction(s, cats[i], currentPeriodStart(cats[i])) !== 'none') return true;
  }
  return false;
}
function catPublicFromState(cat, s) {
  return {
    id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
    streak: s.streak, freezeAvailable: freezesLeft(cat, s),
    lastRecordedKey: s.lastRecordedKey,
    potential: payout(cat, s.streak + 1),
    nextPeriodKey: recordablePeriodKey(cat),
  };
}
function catPublic(email, cat) {
  return catPublicFromState(cat, catStateOf(email, cat.id, cat));
}
function stateResponse(email) {
  var active = activeCategories();
  // Freezes refresh at each category's period rollover. The hourly trigger is
  // not the only thing allowed to do it: between a boundary and the next
  // trigger run the dashboard would otherwise report — and a miss would spend —
  // the previous period's leftovers.
  if (refreshNeeded(email, active)) {
    // Re-read under the lock so a concurrent mutation isn't clobbered.
    withLock(function () {
      active.forEach(maybeRefresh);
      var mm = statesAll();
      if (ensureCatStates(mm, email, active)) saveStatesAll(mm);
    });
  }
  var rows = readLedgerRows(); // ONE sheet read serves both wallets + the ledger panel
  var myRows = runningBalanceRows(rows, email); // ...and ONE pass serves both of mine
  var myState = (statesAll()[email] || {}).cats || {};
  var cats = active.map(function (c) {
    return catPublicFromState(c, myState[c.id] || initialCatState(c, currentPeriodStart(c)));
  });
  var resp = {
    ok: true, user: email, name: displayName(email),
    wallet: myRows.length ? myRows[myRows.length - 1].balanceAfter : 0,
    cats: cats,
    ledger: recentLedger(myRows, email, 20),
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
  var s = catStateOf(person, categoryId, cat);
  var out = applyEntry(s, deriveWallet(rows, person), cat, { periodKey: periodKey, result: result, actor: person });
  // Snapshot what this entry changed, so it can be taken back. Only the newest
  // entry per category is undoable — this snapshot is the whole of the history.
  out.state.undo = {
    id: appendLedger(out.event),
    streak: s.streak,
    freezesUsedThisPeriod: Number(s.freezesUsedThisPeriod) || 0,
    lastRecordedKey: s.lastRecordedKey,
    periodStart: s.periodStart,
  };
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
  if (match.type === 'entry') return undoEntry(email, match, rows);
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
// Take back a recorded entry: drop its ledger row — which reverses the payout,
// since wallets are derived from the ledger, and reopens the period for
// re-recording — then restore the streak and freezes it consumed.
function undoEntry(email, row, rows) {
  var cat = categoryById(row.category);
  if (!cat) return { ok: false, error: 'unknown category' };
  var s = catStateOf(email, cat.id, cat);
  var u = s.undo;
  if (!u || String(u.id) !== String(row.id)) {
    return { ok: false, error: 'only the most recent entry for a habit can be undone' };
  }
  var restored = {
    streak: u.streak,
    periodStart: s.periodStart,
    // Freezes belong to a period. If that one has since rolled over they have
    // already been refreshed, so there is nothing left to give back.
    freezesUsedThisPeriod: s.periodStart === u.periodStart
      ? u.freezesUsedThisPeriod
      : s.freezesUsedThisPeriod,
    lastRecordedKey: u.lastRecordedKey,
  };
  ledgerSheet().deleteRow(row.rowNumber);
  saveCatState(email, cat.id, restored); // no `undo` — one step back, not a stack
  var wallet = walletWithout(rows, email, row.id);
  // The bonus for that period was declined because a freeze had been used. If
  // this was that freeze, and its period has since closed, the period earned
  // the bonus after all. Nothing later in it can have spent another freeze —
  // only the newest entry is undoable, so a later one would hold this slot.
  if (String(row.freezeUsed).toLowerCase() === 'true' &&
      s.periodStart !== u.periodStart &&
      Number(u.freezesUsedThisPeriod) === 0 &&
      cat.unusedFreezeBonus > 0) {
    wallet = round2(wallet + cat.unusedFreezeBonus);
    appendLedger({
      type: 'bonus', category: cat.id, amount: cat.unusedFreezeBonus,
      note: 'Unused freeze bonus (freeze undone)', actor: email, balanceAfter: wallet,
    });
  }
  return { ok: true, wallet: wallet, cat: catPublic(email, cat) };
}
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
  if (cat) restartPeriod(cat);
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
  var cats = activeCategories();
  withLock(function () {
    cats.forEach(maybeRefresh);
  });
  cats.forEach(function (cat) {
    if (cat.reminderTime && cat.reminderTime === hour && shouldSendReminder(cat, dow)) sendReminder(cat);
    if (cat.checkupTime && cat.checkupTime === hour && shouldSendCheckup(cat, dow)) sendCheckup(cat);
  });
}

// Refresh a category's freezes/bonus when its period boundary has passed.
function maybeRefresh(cat) {
  var newStart = currentPeriodStart(cat);
  ALLOWLIST.forEach(function (email) {
    var s = catStateOf(email, cat.id, cat);
    var act = refreshAction(s, cat, newStart);
    if (act === 'none') return;
    if (act === 'rebase') {
      saveCatState(email, cat.id, applyRebase(s, cat, newStart));
      return;
    }
    var out = applyRefresh(s, walletOf(email), cat, newStart);
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
  r = applyRefresh({ streak: 3, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: null }, 10, cat, 'P2');
  eq(r.balance, 13.5, 'bonus added');
  eq(r.state.freezesUsedThisPeriod, 0, 'refresh clears spent freezes');
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
  return cadence === 'weekly' ? isoWeek(dateStr) : dateStr;
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
  if (state && state.freezesUsedThisPeriod != null && state.freezeRefresh != null) return state;
  var s = Object.assign({}, state);
  if (s.freezeRefresh == null) s.freezeRefresh = cat.freezeRefresh;
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
 * @returns {{state:object, balance:number, event:(object|null)}}
 */
function applyRefresh(state, balance, cat, newPeriodStart) {
  var s = Object.assign({}, state);
  var event = null;
  if (cat.unusedFreezeBonus > 0 && !(Number(state.freezesUsedThisPeriod) || 0)) {
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
 * what makes undo work.
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
  return {
    id: raw.id ? slugify(raw.id) : slugify(raw.name),
    name: String(raw.name || '').trim(),
    emoji: String(raw.emoji || '').trim(),
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
    runningBalanceRows: runningBalanceRows,
    normalizeCategory: normalizeCategory,
    validateCategory: validateCategory,
  };
}
