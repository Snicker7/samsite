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

// Exported for Node tests; harmless no-op when pasted into Apps Script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    round2: round2,
    payout: payout,
    isoWeek: isoWeek,
    periodKeyFor: periodKeyFor,
    initialCatState: initialCatState,
    applyEntry: applyEntry,
    applyRefresh: applyRefresh,
    applySpend: applySpend,
    applyDeposit: applyDeposit,
    deriveWallet: deriveWallet,
    runningBalanceRows: runningBalanceRows,
    normalizeCategory: normalizeCategory,
    validateCategory: validateCategory,
  };
}
