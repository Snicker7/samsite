const test = require('node:test');
const assert = require('node:assert');
const E = require('./engine.js');

test('payout scales by increment and caps at maxPerInstance', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0 };
  assert.strictEqual(E.payout(cat, 1), 0.25);
  assert.strictEqual(E.payout(cat, 4), 1.0);
  assert.strictEqual(E.payout(cat, 20), 5.0);
  assert.strictEqual(E.payout(cat, 40), 5.0);
});

test('payout honors a different increment/cap', () => {
  const cat = { rewardIncrement: 1.0, maxPerInstance: 3.0 };
  assert.strictEqual(E.payout(cat, 2), 2.0);
  assert.strictEqual(E.payout(cat, 5), 3.0);
});

test('periodKeyFor daily returns the date; weekly returns ISO week', () => {
  assert.strictEqual(E.periodKeyFor('daily', '2026-06-22'), '2026-06-22');
  // 2026-06-22 is a Monday → ISO week 26 of 2026
  assert.strictEqual(E.periodKeyFor('weekly', '2026-06-22'), '2026-W26');
  // 2026-06-21 is the Sunday of the prior ISO week (week 25)
  assert.strictEqual(E.periodKeyFor('weekly', '2026-06-21'), '2026-W25');
});

// Task 2: applyEntry + applyRefresh with integer freezes

const CAT = {
  id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0,
  freezesPerPeriod: 1, unusedFreezeBonus: 3.5,
};

test('on_time increments streak and credits the wallet', () => {
  const s0 = E.initialCatState(CAT, '2026-06-22');
  const r = E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', result: 'on_time', actor: 'a' });
  assert.strictEqual(r.state.streak, 1);
  assert.strictEqual(r.balance, 0.25);
  assert.strictEqual(r.event.type, 'entry');
  assert.strictEqual(r.event.category, 'sleep');
  assert.strictEqual(r.event.amount, 0.25);
  assert.strictEqual(r.event.balanceAfter, 0.25);
});

test('missed with a freeze preserves streak, decrements freeze, pays nothing', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezesUsedThisPeriod: 0, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 5);
  assert.strictEqual(E.freezesLeft(CAT, r.state), 0);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 1);
  assert.strictEqual(r.balance, 3.75);
  assert.strictEqual(r.event.freezeUsed, true);
});

test('missed with no freeze resets streak to 0', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.balance, 3.75);
});

test('a category with 2 freezes absorbs two misses before resetting', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  // Start with a streak of 7 so we can prove freezes preserve it.
  let s = { streak: 7, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: null };
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // first freeze preserves streak
  assert.strictEqual(E.freezesLeft(cat2, s), 1);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // second freeze preserves streak
  assert.strictEqual(E.freezesLeft(cat2, s), 0);
  const r = E.applyEntry(s, 0, cat2, { periodKey: 'k3', result: 'missed' });
  assert.strictEqual(r.state.streak, 0); // out of freezes -> reset
});

test('double-recording the same period is rejected', () => {
  const s = { streak: 1, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: '2026-06-22' };
  assert.throws(() => E.applyEntry(s, 0, CAT, { periodKey: '2026-06-22', result: 'on_time' }), /already recorded/);
});

test('refresh awards bonus when no freeze used and resets freezes', () => {
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 0, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2');
  assert.strictEqual(r.balance, 13.5);
  assert.strictEqual(r.event.type, 'bonus');
  assert.strictEqual(E.freezesLeft(CAT, r.state), 1);
  assert.strictEqual(r.state.periodStart, 'P2');
});

test('refresh gives no bonus (and no event) when a freeze was used', () => {
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 1, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2');
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});

test('refresh gives no bonus when unusedFreezeBonus is 0', () => {
  const catNoBonus = Object.assign({}, CAT, { unusedFreezeBonus: 0 });
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 0, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, catNoBonus, 'P2');
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});

test('spend subtracts from the wallet and floors at 0', () => {
  assert.strictEqual(E.applySpend(10, { amount: 4 }).balance, 6);
  assert.strictEqual(E.applySpend(3, { amount: 5 }).balance, 0);
  assert.throws(() => E.applySpend(10, { amount: 0 }), /positive/);
  const ev = E.applySpend(10, { amount: 4, note: 'snack', actor: 'a' }).event;
  assert.strictEqual(ev.type, 'spend');
  assert.strictEqual(ev.balanceAfter, 6);
});

test('deposit adds to the wallet', () => {
  const r = E.applyDeposit(10, { amount: 20, note: 'allowance', actor: 'a' });
  assert.strictEqual(r.balance, 30);
  assert.strictEqual(r.event.type, 'deposit');
  assert.strictEqual(r.event.balanceAfter, 30);
  assert.throws(() => E.applyDeposit(10, { amount: -1 }), /positive/);
});

// Task 4: category validation + defaults

test('normalizeCategory slugifies id and coerces numbers', () => {
  const c = E.normalizeCategory({
    name: 'Morning Run!', emoji: '🏃', cadence: 'daily',
    rewardIncrement: '0.50', maxPerInstance: '4', freezesPerPeriod: '2',
    freezeRefresh: 'weekly', unusedFreezeBonus: '', reminderTime: '21:00',
    checkupTime: '', active: true,
  });
  assert.strictEqual(c.id, 'morning-run');
  assert.strictEqual(c.rewardIncrement, 0.5);
  assert.strictEqual(c.maxPerInstance, 4);
  assert.strictEqual(c.freezesPerPeriod, 2);
  assert.strictEqual(c.unusedFreezeBonus, 0); // blank -> 0 (no bonus)
  assert.strictEqual(c.reminderTime, '21:00');
  assert.strictEqual(c.checkupTime, '');
});

test('normalizeCategory keeps daily/weekly/monthly freezeRefresh, clamps the rest to weekly', () => {
  const base = { name: 'X', cadence: 'daily', rewardIncrement: '1', maxPerInstance: '1', freezesPerPeriod: '1' };
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'daily' })).freezeRefresh, 'daily');
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'weekly' })).freezeRefresh, 'weekly');
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'monthly' })).freezeRefresh, 'monthly');
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'yearly' })).freezeRefresh, 'weekly');
});

test('validateCategory flags bad input', () => {
  const bad = E.normalizeCategory({ name: '', cadence: 'monthly', rewardIncrement: '-1', maxPerInstance: '0', freezesPerPeriod: '-2', freezeRefresh: 'weekly', reminderTime: '9:30', checkupTime: '' });
  const errs = E.validateCategory(bad);
  assert.ok(errs.some((e) => /name/i.test(e)));
  assert.ok(errs.some((e) => /cadence/i.test(e)));
  assert.ok(errs.some((e) => /increment/i.test(e)));
  assert.ok(errs.some((e) => /max/i.test(e)));
  assert.ok(errs.some((e) => /freeze/i.test(e)));
  assert.ok(errs.some((e) => /time/i.test(e))); // 9:30 is not a whole hour
});

test('validateCategory passes a good category', () => {
  const good = E.normalizeCategory({ name: 'Sleep', emoji: '🌙', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', freezeRefresh: 'weekly', unusedFreezeBonus: '3.5', reminderTime: '21:00', checkupTime: '09:00', active: true });
  assert.deepStrictEqual(E.validateCategory(good), []);
});

test('deriveWallet sums deposits and bonuses, subtracts spends', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'bonus', amount: 3.5, actor: 'a' },
    { type: 'spend', amount: 4, actor: 'a' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a'), 9.5);
});

test('deriveWallet adds on-time entry payouts and ignores zero-amount misses', () => {
  const rows = [
    { type: 'entry', amount: 0.25, actor: 'a', result: 'on_time' },
    { type: 'entry', amount: 0, actor: 'a', result: 'missed' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a'), 0.25);
});

test('deriveWallet floors a spend that exceeds the balance at $0', () => {
  const rows = [
    { type: 'deposit', amount: 3, actor: 'a' },
    { type: 'spend', amount: 5, actor: 'a' },
    { type: 'deposit', amount: 2, actor: 'a' },
  ];
  // 3 -> max(0, 3-5)=0 -> 0+2 = 2  (floor matters: without it this is 0)
  assert.strictEqual(E.deriveWallet(rows, 'a'), 2);
});

test('deriveWallet isolates by actor, case-insensitively', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'A@x.com' },
    { type: 'deposit', amount: 99, actor: 'b@x.com' },
    { type: 'spend', amount: 4, actor: 'a@X.COM' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a@x.com'), 6);
});

test('deriveWallet returns 0 for no matching rows', () => {
  assert.strictEqual(E.deriveWallet([], 'a'), 0);
  assert.strictEqual(E.deriveWallet([{ type: 'deposit', amount: 5, actor: 'b' }], 'a'), 0);
});

test('runningBalanceRows attaches cumulative balanceAfter for the actor only', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'deposit', amount: 99, actor: 'b' },
    { type: 'spend', amount: 4, actor: 'a' },
  ];
  const out = E.runningBalanceRows(rows, 'a');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].balanceAfter, 10);
  assert.strictEqual(out[1].balanceAfter, 6);
});

test('applySpend caps the logged amount at the available balance on overspend', () => {
  const r = E.applySpend(3, { amount: 5 });
  assert.strictEqual(r.balance, 0);
  assert.strictEqual(r.event.amount, 3); // logs what was actually deducted, not the requested 5
});

test('applySpend logs the full amount for a normal spend', () => {
  const r = E.applySpend(10, { amount: 4 });
  assert.strictEqual(r.balance, 6);
  assert.strictEqual(r.event.amount, 4);
});

// shiftDays / lastClosedPeriodKey: which period a record button writes.

test('shiftDays moves a date string across month and year boundaries', () => {
  assert.strictEqual(E.shiftDays('2026-06-22', -1), '2026-06-21');
  assert.strictEqual(E.shiftDays('2026-07-01', -1), '2026-06-30');
  assert.strictEqual(E.shiftDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(E.shiftDays('2026-03-04', -7), '2026-02-25');
  assert.strictEqual(E.shiftDays('2026-06-22', 0), '2026-06-22');
});

test('lastClosedPeriodKey for a daily category is yesterday', () => {
  // 2026-06-22 is a Monday (dow 1) … 2026-06-28 is a Sunday (dow 7).
  assert.strictEqual(E.lastClosedPeriodKey('daily', '2026-06-22', 1), '2026-06-21');
  assert.strictEqual(E.lastClosedPeriodKey('daily', '2026-06-25', 4), '2026-06-24');
  assert.strictEqual(E.lastClosedPeriodKey('daily', '2026-06-28', 7), '2026-06-27');
});

// The bug this fixes: "yesterday" mid-week still falls inside the CURRENT ISO
// week, so a Wednesday tap on a weekly card credited a week that hadn't ended.
test('lastClosedPeriodKey for a weekly category is always the previous ISO week', () => {
  // Every day of the week of 2026-06-22 (week 26) must resolve to week 25.
  const week26 = [
    ['2026-06-22', 1], ['2026-06-23', 2], ['2026-06-24', 3], ['2026-06-25', 4],
    ['2026-06-26', 5], ['2026-06-27', 6], ['2026-06-28', 7],
  ];
  week26.forEach(([date, dow]) => {
    assert.strictEqual(E.lastClosedPeriodKey('weekly', date, dow), '2026-W25');
  });
  // …and the next week rolls over to 26.
  assert.strictEqual(E.lastClosedPeriodKey('weekly', '2026-06-29', 1), '2026-W26');
});

// Review fix: weekly categories were emailed every day, and a mid-week
// check-up recorded the still-open week. Gates: reminder Sunday, checkup Monday.

test('daily categories send reminders and checkups every day', () => {
  const daily = { cadence: 'daily' };
  for (let dow = 1; dow <= 7; dow++) {
    assert.strictEqual(E.shouldSendReminder(daily, dow), true);
    assert.strictEqual(E.shouldSendCheckup(daily, dow), true);
  }
});

test('weekly categories: reminder only on Sunday (7), checkup only on Monday (1)', () => {
  const weekly = { cadence: 'weekly' };
  for (let dow = 1; dow <= 7; dow++) {
    assert.strictEqual(E.shouldSendReminder(weekly, dow), dow === 7);
    assert.strictEqual(E.shouldSendCheckup(weekly, dow), dow === 1);
  }
});

// The signed-email path passes `result` straight through from a URL, so a
// junk value must be rejected rather than silently treated as a miss.
test('applyEntry rejects a result that is neither on_time nor missed', () => {
  const s0 = E.initialCatState(CAT, '2026-06-22');
  assert.throws(
    () => E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', result: 'maybe', actor: 'a' }),
    /result must be "on_time" or "missed"/
  );
  assert.throws(
    () => E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', actor: 'a' }),
    /result must be "on_time" or "missed"/
  );
});

// Configurable miss penalty & payout floor (spec 2026-07-08)

test('payout starts the curve at minPayout and grows by the increment', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 1.0 };
  assert.strictEqual(E.payout(cat, 0), 0);
  assert.strictEqual(E.payout(cat, 1), 1.0);
  assert.strictEqual(E.payout(cat, 2), 1.25);
  assert.strictEqual(E.payout(cat, 3), 1.5);
  assert.strictEqual(E.payout(cat, 100), 5.0); // cap still wins
});

test('payout with no minPayout keeps the increment-only curve', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 0 };
  assert.strictEqual(E.payout(cat, 1), 0.25);
  assert.strictEqual(E.payout(cat, 4), 1.0);
});

test('missed with no freeze applies missPenaltyPercent to the streak', () => {
  const s = { streak: 10, periodStart: '2026-06-22', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  const at = (pct) => E.applyEntry(s, 0, Object.assign({}, CAT, { missPenaltyPercent: pct }),
    { periodKey: '2026-06-23', result: 'missed', actor: 'a' }).state.streak;
  assert.strictEqual(at(100), 0);
  assert.strictEqual(at(50), 5);
  assert.strictEqual(at(0), 10);
});

test('miss penalty rounds an odd streak up to the larger half', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  const r = E.applyEntry(s, 0, Object.assign({}, CAT, { missPenaltyPercent: 50 }),
    { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 3);
});

test('a freeze preserves the streak whatever the miss penalty is', () => {
  const s = { streak: 7, periodStart: '2026-06-22', freezesUsedThisPeriod: 0, lastRecordedKey: null };
  const r = E.applyEntry(s, 0, Object.assign({}, CAT, { missPenaltyPercent: 50 }),
    { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 7);
  assert.strictEqual(r.event.freezeUsed, true);
});

test('normalizeCategory defaults missPenaltyPercent to 100 and minPayout to 0', () => {
  const c = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1' });
  assert.strictEqual(c.missPenaltyPercent, 100);
  assert.strictEqual(c.minPayout, 0);
  const set = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', missPenaltyPercent: '50', minPayout: '1.00' });
  assert.strictEqual(set.missPenaltyPercent, 50);
  assert.strictEqual(set.minPayout, 1);
});

test('validateCategory rejects an out-of-range penalty and a floor above the cap', () => {
  const base = { name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', reminderTime: '', checkupTime: '' };
  const errsOf = (extra) => E.validateCategory(E.normalizeCategory(Object.assign({}, base, extra)));
  assert.strictEqual(errsOf({}).length, 0);
  assert.strictEqual(errsOf({ missPenaltyPercent: '', minPayout: '' }).length, 0);
  assert.ok(errsOf({ missPenaltyPercent: '101' }).some((e) => /penalty/i.test(e)));
  assert.ok(errsOf({ missPenaltyPercent: '-1' }).some((e) => /penalty/i.test(e)));
  assert.ok(errsOf({ minPayout: '-1' }).some((e) => /minimum payout/i.test(e)));
  assert.ok(errsOf({ minPayout: '6' }).some((e) => /minimum payout/i.test(e)));
});

// Freezes derived from the category, not cached in per-user state

test('freezesLeft follows the category when freezesPerPeriod is edited', () => {
  const s = { streak: 3, periodStart: 'P', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  assert.strictEqual(E.freezesLeft(Object.assign({}, CAT, { freezesPerPeriod: 1 }), s), 0);
  assert.strictEqual(E.freezesLeft(Object.assign({}, CAT, { freezesPerPeriod: 5 }), s), 4);
  // Lowering the allowance below what's already spent can't go negative.
  assert.strictEqual(E.freezesLeft(Object.assign({}, CAT, { freezesPerPeriod: 0 }), s), 0);
});

test('raising freezesPerPeriod mid-period immediately protects the next miss', () => {
  const cat1 = Object.assign({}, CAT, { freezesPerPeriod: 1 });
  let s = E.initialCatState(cat1, 'P');
  s = E.applyEntry(s, 0, cat1, { periodKey: 'k1', result: 'missed' }).state; // burns the only freeze
  assert.strictEqual(E.freezesLeft(cat1, s), 0);
  // Owner edits the category to allow 3 freezes — no rollover in between.
  const cat3 = Object.assign({}, CAT, { freezesPerPeriod: 3 });
  assert.strictEqual(E.freezesLeft(cat3, s), 2);
  const r = E.applyEntry(Object.assign({}, s, { streak: 4 }), 0, cat3, { periodKey: 'k2', result: 'missed' });
  assert.strictEqual(r.event.freezeUsed, true);
  assert.strictEqual(r.state.streak, 4);
});

test('lowering freezesPerPeriod below the spent count breaks the next miss', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  let s = E.initialCatState(cat2, 'P');
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  const cat1 = Object.assign({}, CAT, { freezesPerPeriod: 1 });
  assert.strictEqual(E.freezesLeft(cat1, s), 0);
  const r = E.applyEntry(Object.assign({}, s, { streak: 6 }), 0, cat1, { periodKey: 'k3', result: 'missed' });
  assert.strictEqual(r.event.freezeUsed, false);
  assert.strictEqual(r.state.streak, 0);
});

test('applyEntry counts freezes spent and applyRefresh clears the count', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  let s = E.initialCatState(cat2, 'P1');
  assert.strictEqual(s.freezesUsedThisPeriod, 0);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  assert.strictEqual(s.freezesUsedThisPeriod, 1);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  assert.strictEqual(s.freezesUsedThisPeriod, 2);
  const r = E.applyRefresh(s, 10, cat2, 'P2');
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
  assert.strictEqual(r.event, null); // a freeze was used — no bonus
});

test('migrateCatState converts a legacy freezeAvailable state to a spent count', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  const legacy = { streak: 4, periodStart: 'P', freezeAvailable: 1, freezeUsedThisPeriod: true, lastRecordedKey: 'k' };
  const s = E.migrateCatState(cat2, legacy);
  assert.strictEqual(s.freezesUsedThisPeriod, 1);
  assert.strictEqual(s.streak, 4);
  assert.strictEqual(s.lastRecordedKey, 'k');
  assert.strictEqual(E.freezesLeft(cat2, s), 1);
  // A state that never touched a freeze migrates to 0 spent.
  assert.strictEqual(E.migrateCatState(cat2, { streak: 0, periodStart: 'P', freezeAvailable: 2, freezeUsedThisPeriod: false, lastRecordedKey: null }).freezesUsedThisPeriod, 0);
  // Already migrated → untouched.
  assert.strictEqual(E.migrateCatState(cat2, { streak: 1, freezesUsedThisPeriod: 2 }).freezesUsedThisPeriod, 2);
});

test('mondayOf returns the ISO Monday of a date without clock arithmetic', () => {
  assert.strictEqual(E.mondayOf('2026-08-19', 3), '2026-08-17');
  assert.strictEqual(E.mondayOf('2026-08-17', 1), '2026-08-17');
  assert.strictEqual(E.mondayOf('2026-08-23', 7), '2026-08-17');
  // The 2026 fall-back Sunday, where 24h-multiple math slipped a day.
  assert.strictEqual(E.mondayOf('2026-11-01', 7), '2026-10-26');
  assert.strictEqual(E.mondayOf('2026-03-01', 7), '2026-02-23'); // crosses a month
  assert.strictEqual(E.mondayOf('2026-01-03', 6), '2025-12-29'); // crosses a year
});

// Recorded periods come from the ledger, not from a single remembered key

test('isPeriodRecorded finds any past entry for that actor + category + period', () => {
  const rows = [
    { type: 'entry', actor: 'a@x.com', category: 'sleep', periodKey: '2026-08-16', result: 'on_time' },
    { type: 'entry', actor: 'a@x.com', category: 'sleep', periodKey: '2026-08-18', result: 'missed' },
    { type: 'entry', actor: 'b@x.com', category: 'sleep', periodKey: '2026-08-17', result: 'on_time' },
    { type: 'entry', actor: 'a@x.com', category: 'chores', periodKey: '2026-08-17', result: 'on_time' },
    { type: 'bonus', actor: 'a@x.com', category: 'sleep', periodKey: '2026-08-17', amount: 3.5 },
  ];
  // The superseded period an old check-up link used to sail straight past.
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'sleep', '2026-08-16'), true);
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'sleep', '2026-08-18'), true);
  // Never recorded by this person, for this category.
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'sleep', '2026-08-17'), false);
  assert.strictEqual(E.isPeriodRecorded(rows, 'b@x.com', 'sleep', '2026-08-16'), false);
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'chores', '2026-08-16'), false);
  // Case-insensitive on the actor, like every other ledger lookup.
  assert.strictEqual(E.isPeriodRecorded(rows, 'A@X.com', 'sleep', '2026-08-16'), true);
});

test('isPeriodRecorded reopens a period once its entry row is removed', () => {
  const rows = [{ type: 'entry', actor: 'a', category: 'sleep', periodKey: '2026-08-16' }];
  assert.strictEqual(E.isPeriodRecorded(rows, 'a', 'sleep', '2026-08-16'), true);
  assert.strictEqual(E.isPeriodRecorded([], 'a', 'sleep', '2026-08-16'), false);
});

// Emoji is a real, settable field — it heads every reminder and check-up email

test('normalizeCategory keeps a trimmed emoji and validateCategory caps its length', () => {
  const base = { name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5',
    freezesPerPeriod: '1', reminderTime: '', checkupTime: '' };
  const withEmoji = (e) => E.normalizeCategory(Object.assign({}, base, { emoji: e }));
  assert.strictEqual(withEmoji('  🌙 ').emoji, '🌙');
  assert.strictEqual(withEmoji('').emoji, '');       // cleared on purpose
  assert.strictEqual(withEmoji(undefined).emoji, '');
  // A ZWJ sequence is several code units and must still pass.
  assert.strictEqual(E.validateCategory(withEmoji('👩‍👩‍👧')).length, 0);
  assert.strictEqual(E.validateCategory(withEmoji('🌙')).length, 0);
  assert.strictEqual(E.validateCategory(withEmoji('')).length, 0);
  assert.ok(E.validateCategory(withEmoji('not an emoji, an essay')).some((e) => /emoji/i.test(e)));
});

// Editing the freeze-refresh cadence is not a period ending

test('refreshAction separates a real rollover from an edited cadence', () => {
  const weekly = Object.assign({}, CAT, { freezeRefresh: 'weekly' });
  const s = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 0, freezeRefresh: 'weekly' };
  assert.strictEqual(E.refreshAction(s, weekly, '2026-08-17'), 'none');
  assert.strictEqual(E.refreshAction(s, weekly, '2026-08-24'), 'refresh');
  // Same instant, different dropdown: the calendar didn't move, the rule did.
  const monthly = Object.assign({}, CAT, { freezeRefresh: 'monthly' });
  assert.strictEqual(E.refreshAction(s, monthly, '2026-08-01'), 'rebase');
  // ...and back again, which used to pay a second time.
  const rebased = E.applyRebase(s, monthly, '2026-08-01');
  assert.strictEqual(E.refreshAction(rebased, weekly, '2026-08-17'), 'rebase');
  // A state written before the cadence was tracked adopts it without payout.
  const legacy = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 0 };
  assert.strictEqual(E.refreshAction(legacy, weekly, '2026-08-17'), 'none');
});

test('applyRebase moves the period without refreshing freezes or paying a bonus', () => {
  const monthly = Object.assign({}, CAT, { freezeRefresh: 'monthly', freezesPerPeriod: 2 });
  const s = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 2, freezeRefresh: 'weekly',
    lastRecordedKey: '2026-08-18' };
  const r = E.applyRebase(s, monthly, '2026-08-01');
  assert.strictEqual(r.periodStart, '2026-08-01');
  assert.strictEqual(r.freezeRefresh, 'monthly');
  assert.strictEqual(r.freezesUsedThisPeriod, 2); // spent stays spent — no free freezes
  assert.strictEqual(E.freezesLeft(monthly, r), 0);
  assert.strictEqual(r.streak, 3);
  assert.strictEqual(r.lastRecordedKey, '2026-08-18');
});

test('initialCatState, applyRefresh and migrateCatState all stamp the cadence', () => {
  const weekly = Object.assign({}, CAT, { freezeRefresh: 'weekly' });
  assert.strictEqual(E.initialCatState(weekly, 'P').freezeRefresh, 'weekly');
  assert.strictEqual(E.applyRefresh(E.initialCatState(weekly, 'P'), 0, weekly, 'P2').state.freezeRefresh, 'weekly');
  assert.strictEqual(E.migrateCatState(weekly, { streak: 1, freezeAvailable: 1 }).freezeRefresh, 'weekly');
});

test('escapeHtml neutralises markup for the email bodies', () => {
  assert.strictEqual(E.escapeHtml('Sleep <img src=x onerror=alert(1)>'),
    'Sleep &lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(E.escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.strictEqual(E.escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
  assert.strictEqual(E.escapeHtml('🌙'), '🌙');
  assert.strictEqual(E.escapeHtml(null), '');
  assert.strictEqual(E.escapeHtml(undefined), '');
});

// Resuming a dormant category is a fresh start, not a period ending

test('applyRestart gives a full allowance without paying the bonus', () => {
  const cat = Object.assign({}, CAT, { freezesPerPeriod: 2, unusedFreezeBonus: 3.5, freezeRefresh: 'weekly' });
  const s = { streak: 12, periodStart: '2026-08-17', freezesUsedThisPeriod: 2,
    freezeRefresh: 'weekly', lastRecordedKey: '2026-08-18' };
  const r = E.applyRestart(s, cat, '2026-12-01');
  assert.strictEqual(r.periodStart, '2026-12-01');
  assert.strictEqual(r.freezesUsedThisPeriod, 0);      // full allowance back
  assert.strictEqual(E.freezesLeft(cat, r), 2);
  assert.strictEqual(r.freezeRefresh, 'weekly');
  assert.strictEqual(r.streak, 12);                     // history is kept
  assert.strictEqual(r.lastRecordedKey, '2026-08-18');
  // Unlike applyRefresh, it returns a bare state — there is no bonus event.
  assert.strictEqual(r.event, undefined);
});

test('applyRestart and applyRebase differ on the spent count', () => {
  const weekly = Object.assign({}, CAT, { freezesPerPeriod: 2, freezeRefresh: 'weekly' });
  const monthly = Object.assign({}, weekly, { freezeRefresh: 'monthly' });
  const s = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 1, freezeRefresh: 'weekly' };
  // Cadence edit: same period, new rule — what you spent, you spent.
  assert.strictEqual(E.applyRebase(s, monthly, '2026-08-01').freezesUsedThisPeriod, 1);
  // Resuming after a dormant stretch: a genuinely new period.
  assert.strictEqual(E.applyRestart(s, weekly, '2026-12-01').freezesUsedThisPeriod, 0);
});
