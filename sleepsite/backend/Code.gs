/**
 * Habit Builder — Google Apps Script backend (single source of truth).
 *
 * Responsibilities: stores state + ledger, runs the reward logic, handles
 * email login, records entries / spending, and sends reminder / check-up
 * emails on an hourly time-driven trigger (emailDispatch).
 *
 * The reward logic below is identical to backend/engine.js (which has Node
 * unit tests). Keep the two in sync if you change a rule.
 *
 * Deploy: see backend/README.md.
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

// A long random string used to sign one-tap email links. Put any 40+ random chars.
var SECRET = 'CHANGE_ME_to_a_long_random_string_0123456789abcdef';

// ─────────────────────────────────────────────────────────────────────────
// REWARD ENGINE (mirror of engine.js — unit-tested there)
// ─────────────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** On-time payout for a given streak under a category's rules. */
function payout(cat, streak) {
  return round2(Math.min(cat.rewardIncrement * streak, cat.maxPerInstance));
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

function initialCatState(cat, periodStart) {
  return {
    streak: 0,
    periodStart: periodStart || null,
    freezeAvailable: cat.freezesPerPeriod,
    freezeUsedThisPeriod: false,
    lastRecordedKey: null,
  };
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
  } else if (state.freezeAvailable > 0) {
    s.freezeAvailable = state.freezeAvailable - 1;
    s.freezeUsedThisPeriod = true;
    freezeUsed = true;
  } else {
    s.streak = 0;
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
  if (cat.unusedFreezeBonus > 0 && !state.freezeUsedThisPeriod) {
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
  s.freezeAvailable = cat.freezesPerPeriod;
  s.freezeUsedThisPeriod = false;
  s.periodStart = newPeriodStart;
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

function deriveWallet(rows, actor) {
  var rb = runningBalanceRows(rows, actor);
  return rb.length ? rb[rb.length - 1].balanceAfter : 0;
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
    reminderTime: String(raw.reminderTime || '').trim(),
    checkupTime: String(raw.checkupTime || '').trim(),
    active: raw.active !== false,
  };
}

function validateCategory(cat) {
  var errs = [];
  if (!cat.id) errs.push('A name is required (used to build the id).');
  if (!cat.name) errs.push('Name is required.');
  if (cat.cadence !== 'daily' && cat.cadence !== 'weekly') errs.push('Cadence must be daily or weekly.');
  if (!(cat.rewardIncrement > 0)) errs.push('Reward increment must be a positive number.');
  if (!(cat.maxPerInstance > 0)) errs.push('Max per instance must be a positive number.');
  if (!(cat.freezesPerPeriod >= 0) || cat.freezesPerPeriod % 1 !== 0) errs.push('Freezes per period must be a whole number (0 or more).');
  if (!(cat.unusedFreezeBonus >= 0)) errs.push('Unused-freeze bonus must be 0 or more.');
  if (!isWholeHour(cat.reminderTime)) errs.push('Reminder time must be a whole hour like 21:00, or blank.');
  if (!isWholeHour(cat.checkupTime)) errs.push('Check-up time must be a whole hour like 09:00, or blank.');
  return errs;
}

// ─────────────────────────────────────────────────────────────────────────
// DATE HELPERS (all in TZ)
// ─────────────────────────────────────────────────────────────────────────
function tzDate(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}
function todayStr() {
  return tzDate(new Date());
}
function yesterdayStr() {
  return tzDate(new Date(Date.now() - 24 * 3600 * 1000));
}
function currentMondayStr() {
  var now = new Date();
  var dow = parseInt(Utilities.formatDate(now, TZ, 'u'), 10); // 1=Mon..7=Sun
  var monday = new Date(now.getTime() - (dow - 1) * 24 * 3600 * 1000);
  return tzDate(monday);
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
// states[email] = { balance:Number, cats: { [catId]: catState } }
function statesAll() {
  var raw = props().getProperty('states');
  return raw ? JSON.parse(raw) : {};
}
function saveStatesAll(m) {
  props().setProperty('states', JSON.stringify(m));
}
function personRecord(email) {
  var m = statesAll();
  if (!m[email]) { m[email] = { balance: 0, cats: {} }; saveStatesAll(m); }
  if (!m[email].cats) { m[email].cats = {}; saveStatesAll(m); }
  return m[email];
}
function walletOf(email) { return deriveWallet(readLedgerRows(), email); }
function catStateOf(email, catId, cat) {
  var m = statesAll();
  if (!m[email]) m[email] = { balance: 0, cats: {} };
  if (!m[email].cats) m[email].cats = {};
  if (!m[email].cats[catId]) {
    m[email].cats[catId] = initialCatState(cat, currentPeriodStart(cat));
    saveStatesAll(m);
  }
  return m[email].cats[catId];
}
function saveCatState(email, catId, s) {
  var m = statesAll();
  if (!m[email]) m[email] = { balance: 0, cats: {} };
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

// ─────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────
function sign(msg) {
  var raw = Utilities.computeHmacSha256Signature(msg, SECRET);
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
    case 'record': return doRecord(p);
    case 'spend': return doSpend(p);
    case 'deposit': return doDeposit(p);
    case 'deleteEntry': return doDeleteEntry(p);
    case 'listCategories': return doListCategories(p);
    case 'saveCategory': return doSaveCategory(p);
    case 'archiveCategory': return doArchiveCategory(p);
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
function catPublic(email, cat) {
  var s = catStateOf(email, cat.id, cat);
  return {
    id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
    streak: s.streak, freezeAvailable: s.freezeAvailable,
    lastRecordedKey: s.lastRecordedKey,
    potential: payout(cat, s.streak + 1),
  };
}
function stateResponse(email) {
  var cats = activeCategories().map(function (c) { return catPublic(email, c); });
  var resp = {
    ok: true, user: email, name: displayName(email),
    wallet: walletOf(email), cats: cats, ledger: recentLedger(email, 20),
  };
  var pe = partnerOf(email);
  if (pe) resp.partner = { name: displayName(pe), wallet: walletOf(pe) };
  return resp;
}
function doRecord(p) {
  var categoryId = p.categoryId;
  var periodKey = p.periodKey; // record-cadence key (day or ISO week)
  var result = p.result;
  var cat = categoryById(categoryId);
  if (!cat) return { ok: false, error: 'unknown category' };
  var person;
  var loginEmail = verifyToken(p.token);
  if (loginEmail) {
    person = loginEmail;
  } else {
    person = (p.person || '').trim().toLowerCase();
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
  ALLOWLIST.forEach(function (person) {
    var out = applyDeposit(walletOf(person), { amount: amount, note: note, actor: person });
    appendLedger(out.event);
  });
  return { ok: true, wallet: walletOf(email) };
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
function emailDispatch() {
  var hour = currentHourStr();
  var cats = activeCategories();
  cats.forEach(function (cat) {
    maybeRefresh(cat);
    if (cat.reminderTime && cat.reminderTime === hour) sendReminder(cat);
    if (cat.checkupTime && cat.checkupTime === hour) sendCheckup(cat);
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
  // The period that just closed: use yesterday's date as the reference; for a
  // weekly category periodKeyFor() collapses it to the ISO week.
  var refDate = yesterdayStr();
  var periodKey = periodKeyFor(cat.cadence, refDate);
  var btn = 'display:inline-block;padding:14px 22px;margin:6px 0;border-radius:10px;font-size:18px;text-decoration:none;color:#fff';
  ALLOWLIST.forEach(function (to) {
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
  eq(periodKeyFor('weekly', '2026-06-22'), '2026-W26', 'iso week');
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
