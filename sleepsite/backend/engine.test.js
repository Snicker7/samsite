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
  const s = { streak: 5, periodStart: '2026-06-22', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 5);
  assert.strictEqual(r.state.freezeAvailable, 0);
  assert.strictEqual(r.state.freezeUsedThisPeriod, true);
  assert.strictEqual(r.balance, 3.75);
  assert.strictEqual(r.event.freezeUsed, true);
});

test('missed with no freeze resets streak to 0', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezeAvailable: 0, freezeUsedThisPeriod: false, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.balance, 3.75);
});

test('a category with 2 freezes absorbs two misses before resetting', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  // Start with a streak of 7 so we can prove freezes preserve it.
  let s = { streak: 7, periodStart: 'P', freezeAvailable: 2, freezeUsedThisPeriod: false, lastRecordedKey: null };
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // first freeze preserves streak
  assert.strictEqual(s.freezeAvailable, 1);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // second freeze preserves streak
  assert.strictEqual(s.freezeAvailable, 0);
  const r = E.applyEntry(s, 0, cat2, { periodKey: 'k3', result: 'missed' });
  assert.strictEqual(r.state.streak, 0); // out of freezes -> reset
});

test('double-recording the same period is rejected', () => {
  const s = { streak: 1, periodStart: 'P', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: '2026-06-22' };
  assert.throws(() => E.applyEntry(s, 0, CAT, { periodKey: '2026-06-22', result: 'on_time' }), /already recorded/);
});

test('refresh awards bonus when no freeze used and resets freezes', () => {
  const s = { streak: 3, periodStart: 'P1', freezeAvailable: 0, freezeUsedThisPeriod: false, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2');
  assert.strictEqual(r.balance, 13.5);
  assert.strictEqual(r.event.type, 'bonus');
  assert.strictEqual(r.state.freezeAvailable, 1);
  assert.strictEqual(r.state.periodStart, 'P2');
});

test('refresh gives no bonus (and no event) when a freeze was used', () => {
  const s = { streak: 3, periodStart: 'P1', freezeAvailable: 0, freezeUsedThisPeriod: true, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2');
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});

test('refresh gives no bonus when unusedFreezeBonus is 0', () => {
  const catNoBonus = Object.assign({}, CAT, { unusedFreezeBonus: 0 });
  const s = { streak: 3, periodStart: 'P1', freezeAvailable: 1, freezeUsedThisPeriod: false, lastRecordedKey: 'k' };
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
