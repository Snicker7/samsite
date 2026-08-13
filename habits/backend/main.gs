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
  var now = new Date();
  var monday = new Date(now.getTime() - (currentDow() - 1) * 24 * 3600 * 1000);
  return tzDate(monday);
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
  if (!m[email].cats[catId]) {
    m[email].cats[catId] = initialCatState(cat, currentPeriodStart(cat));
    saveStatesAll(m);
  }
  return m[email].cats[catId];
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
// Period start for the category's freezeRefresh cadence (a "YYYY-MM-DD").
function currentPeriodStart(cat) {
  if (cat.freezeRefresh === 'daily') return todayStr();
  if (cat.freezeRefresh === 'monthly') return currentMonthStr();
  return currentMondayStr();
}

function ledgerSheet() {
  var id = props().getProperty('ledgerId');
  var ss = null;
  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Habit Builder Ledger');
    var first = ss.getSheets()[0];
    first.setName('Ledger');
    first.appendRow([
      'id', 'timestamp', 'type', 'category', 'periodKey', 'result',
      'freezeUsed', 'amount', 'balanceAfter', 'actor', 'note',
    ]);
    props().setProperty('ledgerId', ss.getId());
  }
  return ss.getSheetByName('Ledger') || ss.getSheets()[0];
}
function appendLedger(ev) {
  ledgerSheet().appendRow([
    Utilities.getUuid(), new Date(), ev.type, ev.category || '', ev.periodKey || '',
    ev.result || '', ev.freezeUsed === true, ev.amount || 0,
    ev.balanceAfter, ev.actor || '', ev.note || '',
  ]);
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
function recentLedgerFromRows(rows, email, n) {
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
function requestLogin(email) {
  email = (email || '').trim().toLowerCase();
  if (ALLOWLIST.indexOf(email) === -1) return { ok: true }; // don't reveal allowlist
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
  var added = false;
  cats.forEach(function (cat) {
    if (!m[email].cats[cat.id]) {
      m[email].cats[cat.id] = initialCatState(cat, currentPeriodStart(cat));
      added = true;
    }
  });
  return added;
}
function catPublicFromState(cat, s) {
  return {
    id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
    streak: s.streak, freezeAvailable: s.freezeAvailable,
    lastRecordedKey: s.lastRecordedKey,
    potential: payout(cat, s.streak + 1),
    nextPeriodKey: recordablePeriodKey(cat),
  };
}
function catPublic(email, cat) {
  return catPublicFromState(cat, catStateOf(email, cat.id, cat));
}
function stateResponse(email) {
  var rows = readLedgerRows(); // ONE sheet read serves both wallets + the ledger panel
  var active = activeCategories();
  var m = statesAll();
  if (ensureCatStates(m, email, active)) {
    // Rare path (first sight of a new category): re-read under the lock so a
    // concurrent mutation isn't clobbered by this save.
    withLock(function () {
      m = statesAll();
      ensureCatStates(m, email, active);
      saveStatesAll(m);
    });
  }
  var cats = active.map(function (c) { return catPublicFromState(c, m[email].cats[c.id]); });
  var resp = {
    ok: true, user: email, name: displayName(email),
    wallet: deriveWallet(rows, email), cats: cats,
    ledger: recentLedgerFromRows(rows, email, 20),
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
  var s = catStateOf(person, categoryId, cat);
  var out = applyEntry(s, walletOf(person), cat, { periodKey: periodKey, result: result, actor: person });
  saveCatState(person, categoryId, out.state);
  appendLedger(out.event);
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
  if (match.type !== 'spend' && match.type !== 'deposit') {
    return { ok: false, error: 'only spends and adds can be removed here' };
  }
  ledgerSheet().deleteRow(match.rowNumber);
  return { ok: true, wallet: walletOf(email) };
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
  for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].active = true;
  saveCategories(list);
  return { ok: true, categories: list };
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
    if (s.periodStart !== newStart) {
      var out = applyRefresh(s, walletOf(email), cat, newStart);
      saveCatState(email, cat.id, out.state);
      if (out.event) { out.event.actor = email; appendLedger(out.event); }
    }
  });
}

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
  // Ask about the period that just closed — the same one the dashboard buttons
  // write, so a check-up answer and a dashboard tap can't land on different keys.
  var periodKey = recordablePeriodKey(cat);
  var btn = 'display:inline-block;padding:14px 22px;margin:6px 0;border-radius:10px;font-size:18px;text-decoration:none;color:#fff';
  ALLOWLIST.forEach(function (to) {
    var s = catStateOf(to, cat.id, cat);
    if (s.lastRecordedKey === periodKey) return; // already recorded — no nag
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
  var missState = { streak: 10, periodStart: 'P', freezeAvailable: 0, freezeUsedThisPeriod: false, lastRecordedKey: null };
  eq(applyEntry(missState, 0, cat, { periodKey: 'K', result: 'missed' }).state.streak, 0, 'miss default resets');
  eq(applyEntry(missState, 0, { id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0, freezesPerPeriod: 1, missPenaltyPercent: 50 },
    { periodKey: 'K', result: 'missed' }).state.streak, 5, 'miss penalty halves');
  eq(periodKeyFor('weekly', '2026-06-22'), '2026-W26', 'iso week');
  eq(lastClosedPeriodKey('daily', '2026-06-25', 4), '2026-06-24', 'daily records yesterday');
  eq(lastClosedPeriodKey('weekly', '2026-06-25', 4), '2026-W25', 'weekly records last week');
  var r = applyEntry(initialCatState(cat, 'P'), 0, cat, { periodKey: '2026-06-15', result: 'on_time' });
  eq(r.state.streak, 1, 'streak inc'); eq(r.balance, 0.25, 'pay d1');
  r = applyRefresh({ streak: 3, periodStart: 'P', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: null }, 10, cat, 'P2');
  eq(r.balance, 13.5, 'bonus added');
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
