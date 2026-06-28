'use strict';

/* ── tiny helpers ───────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + Number(n || 0).toFixed(2);
// Mirrors the backend's slugify so the UI can detect duplicate category ids.
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const getToken = () => localStorage.getItem('ss_token') || '';
const setToken = (t) => localStorage.setItem('ss_token', t);
const clearToken = () => localStorage.removeItem('ss_token');
const configured = () =>
  window.CONFIG &&
  CONFIG.WEB_APP_URL &&
  CONFIG.WEB_APP_URL.indexOf('PASTE') === -1;

// Shown when a category call returns ok but no categories array — the tell-tale
// of the frontend talking to an old/wrong Apps Script deployment.
const STALE_BACKEND_MSG =
  '⚠️ The backend didn\'t return category data — the app may be pointed at an old deployment. Check WEB_APP_URL in js/config.js and redeploy.';

function banner(msg, isError) {
  const b = $('banner');
  b.textContent = msg;
  b.className = 'banner' + (isError ? ' error' : ' ok');
  b.hidden = !msg;
}

function setView(name) {
  ['loginView', 'checkinView', 'dashView', 'adminView'].forEach((v) => ($(v).hidden = true));
  $({ login: 'loginView', checkin: 'checkinView', dash: 'dashView', admin: 'adminView' }[name]).hidden = false;
  $('logoutBtn').hidden = !getToken();
}

/* ── JSONP client (avoids cross-origin/CORS issues with Apps Script) ──────── */
let jsonpSeq = 0;
function jsonp(params) {
  return new Promise((resolve, reject) => {
    if (!configured()) {
      reject(new Error('Backend not configured (set WEB_APP_URL in js/config.js)'));
      return;
    }
    const cb = 'ss_cb_' + ++jsonpSeq + '_' + Date.now();
    const usp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        usp.set(k, params[k]);
      }
    });
    usp.set('callback', cb);
    const script = document.createElement('script');
    let done = false;
    const cleanup = () => {
      delete window[cb];
      script.remove();
    };
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        reject(new Error('Network timeout — check your connection'));
      }
    }, 20000);
    window[cb] = (data) => {
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('Could not reach the backend'));
      }
    };
    script.src = CONFIG.WEB_APP_URL + '?' + usp.toString();
    document.body.appendChild(script);
  });
}
const api = (action, extra) => jsonp(Object.assign({ action, token: getToken() }, extra || {}));

/* ── dates ────────────────────────────────────────────────────────────────── */
function isoDate(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
function yesterdayIso() {
  return isoDate(new Date(Date.now() - 24 * 3600 * 1000));
}
function isoWeekClient(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return dt.getUTCFullYear() + '-W' + ('0' + weekNo).slice(-2);
}
// Cadence per category id, cached from the last render so recordCat can pick day vs week.
let CAT_CADENCE = {};
// Last-rendered category list, so the admin form can guard against duplicate ids.
let CAT_LIST = [];
function lastPeriodKey(categoryId) {
  const d = new Date(Date.now() - 24 * 3600 * 1000); // yesterday
  return CAT_CADENCE[categoryId] === 'weekly' ? isoWeekClient(d) : isoDate(d);
}

/* ── rendering ──────────────────────────────────────────────────────────────*/
function render(r) {
  $('whoami').textContent = r.name || r.user || '';
  $('wallet').textContent = money(r.wallet);
  $('manageBtn').hidden = false;
  renderPartner(r.partner);
  renderCatCards(r.cats || []);
  renderLedger(r.ledger || []);
}

function renderPartner(p) {
  const card = $('partnerCard');
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  $('partnerName').textContent = (p.name || 'Partner') + "'s wallet";
  $('partnerWallet').textContent = money(p.wallet);
}

function renderCatCards(cats) {
  const wrap = $('catCards');
  wrap.innerHTML = '';
  if (!cats.length) {
    wrap.innerHTML = '<div class="card"><p class="muted">No categories yet. Tap "Categories" to add one.</p></div>';
    return;
  }
  cats.forEach((c) => {
    CAT_CADENCE[c.id] = c.cadence;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h2>' + c.name + '</h2>' +
      '<div class="prow">' +
      '<div><span class="label">Streak</span><span class="pval">' + c.streak + '</span></div>' +
      '<div><span class="label">If you do it</span><span class="pval">' + money(c.potential) + '</span></div>' +
      '<div><span class="label">Freezes</span><span class="pval">' + c.freezeAvailable + '</span></div>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' +
      '<button class="ok" data-cat="' + c.id + '" data-result="on_time">✅ Did it</button>' +
      '<button class="danger" data-cat="' + c.id + '" data-result="missed">❌ Missed</button>' +
      '</div>' +
      '<p class="muted">' + (c.cadence === 'weekly' ? 'Weekly' : 'Daily') + ' • last: ' + (c.lastRecordedKey || '—') + '</p>';
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('button[data-cat]').forEach((b) => {
    b.addEventListener('click', () => recordCat(b.getAttribute('data-cat'), b.getAttribute('data-result'), b.closest('.card').querySelector('h2').textContent));
  });
}

function describe(e) {
  if (e.type === 'spend') return '🛒 ' + (e.note || 'Spent');
  if (e.type === 'deposit') return '💵 ' + (e.note || 'Added money');
  if (e.type === 'bonus') return '🎁 ' + (e.note || 'Bonus') + ' (' + (e.category || '') + ')';
  if (e.type === 'entry') {
    const tag = e.category ? ' (' + e.category + ')' : '';
    if (e.result === 'on_time') return '✅ On time' + tag;
    if (e.freezeUsed) return '❄️ Freeze used' + tag;
    return '❌ Missed' + tag;
  }
  return e.type;
}
function amountCell(e) {
  if (e.type === 'spend') return '−' + money(e.amount);
  if (e.amount > 0) return '+' + money(e.amount);
  return '';
}
function renderLedger(rows) {
  const body = $('ledger').querySelector('tbody');
  body.innerHTML = '';
  $('ledgerEmpty').hidden = rows.length > 0;
  rows.forEach((e) => {
    const tr = document.createElement('tr');
    const when = (e.periodKey || (e.timestamp || '').slice(0, 10) || '').toString();
    const canDelete = e.type === 'spend' || e.type === 'deposit';
    const del = canDelete && e.id
      ? '<button class="link-btn del" data-del="' + e.id + '" title="Remove this entry" aria-label="Remove this entry">✕</button>'
      : '';
    tr.innerHTML =
      '<td>' + when + '</td>' +
      '<td>' + describe(e) + '</td>' +
      '<td class="amt">' + amountCell(e) + '</td>' +
      '<td class="bal">' + money(e.balanceAfter) + '</td>' +
      '<td class="del-cell">' + del + '</td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('button[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteEntry(b.getAttribute('data-del'))));
}

async function deleteEntry(id) {
  if (!window.confirm('Remove this entry? This updates your wallet total.')) return;
  banner('Removing…', false);
  try {
    const r = await api('deleteEntry', { id });
    if (!r.ok) { banner(r.error || 'Could not remove', true); return; }
    banner('Entry removed.', false);
    showDashboard();
  } catch (err) { banner(err.message, true); }
}

/* ── flows ──────────────────────────────────────────────────────────────────*/
async function showDashboard() {
  setView('dash');
  banner('', false);
  try {
    const r = await api('state');
    if (!r.ok) {
      if (/authoriz/i.test(r.error || '')) {
        clearToken();
        setView('login');
        banner('Your session expired — please log in again.', true);
        return;
      }
      banner(r.error || 'Could not load data', true);
      return;
    }
    render(r);
  } catch (err) {
    banner(err.message, true);
  }
}

async function recordCat(categoryId, result, label) {
  banner('Saving…', false);
  try {
    // Record the just-closed period: yesterday for daily, last ISO week for weekly.
    const r = await api('record', { categoryId, periodKey: lastPeriodKey(categoryId), result });
    if (!r.ok) { banner(r.error || 'Could not save', true); return; }
    const e = r.event;
    if (e.result === 'on_time') banner('🎉 ' + (label || 'Done') + ' — earned ' + money(e.amount) + '.', false);
    else if (e.freezeUsed) banner('❄️ Freeze used — streak protected.', false);
    else banner('Streak reset. Fresh start 💪', false);
    showDashboard();
  } catch (err) { banner(err.message, true); }
}

async function checkinFlow(person, categoryId, periodKey, result, sig) {
  setView('checkin');
  $('checkinTitle').textContent = 'Check-in: ' + periodKey;
  $('checkinBody').textContent = result === 'on_time' ? 'Recording your on-time entry…' : 'Recording your missed entry…';
  await recordViaSig(person, categoryId, periodKey, result, sig);
}

async function recordViaSig(person, categoryId, periodKey, result, sig) {
  const params = { action: 'record', person, categoryId, periodKey, result, sig };
  $('checkinResult').hidden = false;
  $('checkinResult').textContent = 'Saving…';
  try {
    const r = await jsonp(params);
    const res = $('checkinResult');
    if (!r.ok) {
      res.textContent = /already recorded/i.test(r.error || '') ? '✅ Already recorded.' : '⚠️ ' + (r.error || 'Could not save');
    } else {
      const e = r.event;
      if (e.result === 'on_time') res.textContent = '🎉 Recorded! Earned ' + money(e.amount) + '. Wallet: ' + money(r.wallet) + '.';
      else if (e.freezeUsed) res.textContent = '❄️ Freeze used — streak protected.';
      else res.textContent = 'Streak reset. Fresh start 💪 Wallet: ' + money(r.wallet) + '.';
    }
  } catch (err) {
    $('checkinResult').textContent = '⚠️ ' + err.message;
  }
  $('checkinDoneBtn').hidden = false;
}

/* ── admin ──────────────────────────────────────────────────────────────────*/
function fillHourOptions(sel) {
  sel.innerHTML = '<option value="">off</option>';
  for (let h = 0; h < 24; h++) {
    const hh = ('0' + h).slice(-2) + ':00';
    sel.innerHTML += '<option value="' + hh + '">' + hh + '</option>';
  }
}

async function showAdmin() {
  setView('admin');
  fillHourOptions($('catReminder'));
  fillHourOptions($('catCheckup'));
  try {
    const r = await api('listCategories');
    if (!r.ok) { banner(r.error || 'Could not load categories', true); return; }
    if (!Array.isArray(r.categories)) { banner(STALE_BACKEND_MSG, true); return; }
    renderCatList(r.categories);
  } catch (err) { banner(err.message, true); }
}

function renderCatList(cats) {
  CAT_LIST = cats;
  const body = $('catList').querySelector('tbody');
  body.innerHTML = '';
  cats.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + c.name + (c.active ? '' : ' (archived)') + '</td>' +
      '<td>' + c.cadence + '</td>' +
      '<td><button class="link-btn" data-edit="' + c.id + '">edit</button>' +
      (c.active ? ' <button class="link-btn" data-arch="' + c.id + '">archive</button>' : '') + '</td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('button[data-edit]').forEach((b) =>
    b.addEventListener('click', () => editCat(cats.find((x) => x.id === b.getAttribute('data-edit')))));
  body.querySelectorAll('button[data-arch]').forEach((b) =>
    b.addEventListener('click', () => archiveCat(b.getAttribute('data-arch'))));
}

function editCat(c) {
  $('catId').value = c.id; $('catName').value = c.name;
  $('catCadence').value = c.cadence; $('catRefresh').value = c.freezeRefresh;
  $('catIncrement').value = c.rewardIncrement; $('catMax').value = c.maxPerInstance;
  $('catFreezes').value = c.freezesPerPeriod; $('catBonus').value = c.unusedFreezeBonus;
  $('catReminder').value = c.reminderTime || ''; $('catCheckup').value = c.checkupTime || '';
  $('catFormTitle').textContent = 'Editing: ' + c.name;
  $('cancelEditBtn').hidden = false;
  $('catForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Return the form to "add a new category" mode.
function resetCatForm() {
  $('catForm').reset();
  $('catId').value = '';
  $('catFormTitle').textContent = 'Add a category';
  $('cancelEditBtn').hidden = true;
  $('catFormMsg').hidden = true;
}

async function archiveCat(id) {
  try {
    const r = await api('archiveCategory', { categoryId: id });
    if (!r.ok) { banner(r.error || 'Could not archive', true); return; }
    if (!Array.isArray(r.categories)) { banner(STALE_BACKEND_MSG, true); return; }
    renderCatList(r.categories);
  } catch (err) { banner(err.message, true); }
}

/* ── wiring ─────────────────────────────────────────────────────────────────*/
function wire() {
  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('loginEmail').value.trim();
    if (!email) return;
    try {
      await jsonp({ action: 'requestLogin', email });
      $('loginMsg').hidden = false;
      $('loginMsg').textContent =
        'If that email is on the list, a login link is on its way. Check your inbox 📬';
    } catch (err) {
      banner(err.message, true);
    }
  });

  $('logoutBtn').addEventListener('click', () => {
    clearToken();
    setView('login');
    banner('Logged out.', false);
  });

  $('spendForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = $('spendAmount').value, note = $('spendNote').value;
    banner('Saving…', false);
    try {
      const r = await api('spend', { amount, note });
      if (!r.ok) { banner(r.error || 'Could not save', true); return; }
      $('spendAmount').value = ''; $('spendNote').value = '';
      banner('Spent ' + money(amount) + '.', false);
      showDashboard();
    } catch (err) { banner(err.message, true); }
  });

  $('addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = $('addAmount').value, note = $('addNote').value;
    banner('Saving…', false);
    try {
      const r = await api('deposit', { amount, note });
      if (!r.ok) { banner(r.error || 'Could not add', true); return; }
      $('addAmount').value = ''; $('addNote').value = '';
      banner('Added ' + money(amount) + ' to both wallets.', false);
      showDashboard();
    } catch (err) { banner(err.message, true); }
  });

  $('checkinDoneBtn').addEventListener('click', () => {
    if (getToken()) showDashboard();
    else setView('login');
  });

  $('manageBtn').addEventListener('click', showAdmin);
  $('backToDashBtn').addEventListener('click', showDashboard);
  $('cancelEditBtn').addEventListener('click', resetCatForm);

  $('catForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const category = {
      id: $('catId').value || undefined,
      name: $('catName').value,
      cadence: $('catCadence').value, freezeRefresh: $('catRefresh').value,
      rewardIncrement: $('catIncrement').value, maxPerInstance: $('catMax').value,
      freezesPerPeriod: $('catFreezes').value, unusedFreezeBonus: $('catBonus').value,
      reminderTime: $('catReminder').value, checkupTime: $('catCheckup').value,
      active: true,
    };
    $('catFormMsg').hidden = true;
    // Adding (no id) but a category with this name already exists → would silently
    // overwrite it. Stop and tell the user to edit it instead.
    if (!category.id && CAT_LIST.some((c) => c.id === slugify(category.name))) {
      $('catFormMsg').hidden = false;
      $('catFormMsg').textContent =
        '⚠️ A category named "' + category.name + '" already exists. Tap “edit” on it in the list above, or pick a different name.';
      return;
    }
    try {
      const r = await api('saveCategory', { category: JSON.stringify(category) });
      if (!r.ok) { $('catFormMsg').hidden = false; $('catFormMsg').textContent = '⚠️ ' + r.error; return; }
      if (!Array.isArray(r.categories)) { $('catFormMsg').hidden = false; $('catFormMsg').textContent = STALE_BACKEND_MSG; return; }
      renderCatList(r.categories);
      resetCatForm();
      banner('Category saved.', false);
    } catch (err) { banner(err.message, true); }
  });
}

/* ── boot ───────────────────────────────────────────────────────────────────*/
function boot() {
  wire();
  if (!configured()) {
    banner('⚠️ Backend not set up yet — add your Apps Script URL to js/config.js.', true);
  }
  const qp = new URLSearchParams(location.search);
  const tokenParam = qp.get('token');
  if (tokenParam) {
    setToken(tokenParam);
    history.replaceState({}, '', location.origin + location.pathname);
  }
  const periodKey = qp.get('periodKey');
  const result = qp.get('result');
  const sig = qp.get('sig');
  const person = qp.get('person');
  const categoryId = qp.get('categoryId');
  if (person && categoryId && periodKey && result && sig) {
    history.replaceState({}, '', location.origin + location.pathname);
    checkinFlow(person, categoryId, periodKey, result, sig);
    return;
  }
  if (getToken()) {
    showDashboard();
  } else {
    setView('login');
  }
}

document.addEventListener('DOMContentLoaded', boot);
