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
