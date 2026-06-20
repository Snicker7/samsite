'use strict';

/* ── tiny helpers ───────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + Number(n || 0).toFixed(2);
const getToken = () => localStorage.getItem('ss_token') || '';
const setToken = (t) => localStorage.setItem('ss_token', t);
const clearToken = () => localStorage.removeItem('ss_token');
const configured = () =>
  window.CONFIG &&
  CONFIG.WEB_APP_URL &&
  CONFIG.WEB_APP_URL.indexOf('PASTE') === -1;

function banner(msg, isError) {
  const b = $('banner');
  b.textContent = msg;
  b.className = 'banner' + (isError ? ' error' : ' ok');
  b.hidden = !msg;
}

function setView(name) {
  ['loginView', 'checkinView', 'dashView'].forEach((v) => ($(v).hidden = true));
  $({ login: 'loginView', checkin: 'checkinView', dash: 'dashView' }[name]).hidden = false;
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

/* ── rendering ──────────────────────────────────────────────────────────────*/
function render(r) {
  $('whoami').textContent = r.name || r.user || '';
  $('balance').textContent = money(r.state.balance);
  $('streak').textContent = r.state.streak;
  $('potential').textContent = money(r.potentialTonight);
  $('freeze').textContent = r.state.freezeAvailable ? '❄️ ready' : '— used';
  if (!$('nightDate').value) $('nightDate').value = yesterdayIso();
  renderPartner(r.partner);
  renderLedger(r.ledger || []);
}

function renderPartner(p) {
  const card = $('partnerCard');
  if (!p) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('partnerName').textContent = (p.name || 'Partner') + "'s status";
  $('partnerBalance').textContent = money(p.balance);
  $('partnerStreak').textContent =
    p.streak + ' night' + (p.streak === 1 ? '' : 's');
  $('partnerFreeze').textContent = p.freezeAvailable ? '❄️ ready' : '— used';
}

function describe(e) {
  if (e.type === 'spend') return '🛒 ' + (e.note || 'Spent');
  if (e.type === 'weekly_bonus') return '🎁 Unused-freeze bonus';
  if (e.type === 'night') {
    if (e.result === 'on_time') return '✅ On time';
    if (e.freezeUsed) return '❄️ Freeze used';
    return '❌ Missed';
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
    const when = (e.nightDate || (e.timestamp || '').slice(0, 10) || '').toString();
    tr.innerHTML =
      '<td>' + when + '</td>' +
      '<td>' + describe(e) + '</td>' +
      '<td class="amt">' + amountCell(e) + '</td>' +
      '<td class="bal">' + money(e.balanceAfter) + '</td>';
    body.appendChild(tr);
  });
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

async function recordDash(result) {
  const nightDate = $('nightDate').value || yesterdayIso();
  const params = { action: 'record', nightDate, result, token: getToken() };
  if (result === 'missed' && $('useFreezeChk').checked) params.useFreeze = 'true';
  banner('Saving…', false);
  try {
    const r = await jsonp(params);
    if (!r.ok) {
      banner(r.error || 'Could not save', true);
      return;
    }
    const e = r.event;
    if (e.result === 'on_time') banner('🎉 Nice! Earned ' + money(e.amount) + '.', false);
    else if (e.freezeUsed) banner('❄️ Freeze used — streak protected.', false);
    else banner('Streak reset. Fresh start tonight 💪', false);
    render(r);
  } catch (err) {
    banner(err.message, true);
  }
}

async function checkinFlow(person, nightDate, result, sig) {
  setView('checkin');
  $('checkinTitle').textContent = 'Night of ' + nightDate;

  if (result === 'on_time') {
    $('checkinBody').textContent = 'Recording your on-time night…';
    await recordViaSig(person, nightDate, 'on_time', false, sig);
    return;
  }

  // Missed: show freeze availability/streak if we're logged in as this same person.
  $('checkinBody').textContent = 'You marked last night as missed.';
  let streakNum = null;
  let freezeAvail = null;
  if (getToken()) {
    try {
      const s = await api('state');
      if (s.ok && (s.user || '').toLowerCase() === person.toLowerCase()) {
        streakNum = s.state.streak;
        freezeAvail = s.state.freezeAvailable;
      }
    } catch (e) {
      /* ignore — fall back to generic prompt */
    }
  }
  if (streakNum !== null) $('freezeStreak').textContent = streakNum;
  $('freezeChoice').hidden = false;

  if (freezeAvail === false) {
    // No freeze to use this week.
    $('freezeChoice').querySelector('p').textContent =
      'No streak freeze left this week — recording this miss will reset your streak.';
    $('useFreezeBtn').hidden = true;
    $('noFreezeBtn').textContent = 'OK, record the miss';
  }

  $('useFreezeBtn').onclick = () => recordViaSig(person, nightDate, 'missed', true, sig);
  $('noFreezeBtn').onclick = () => recordViaSig(person, nightDate, 'missed', false, sig);
}

async function recordViaSig(person, nightDate, result, useFreeze, sig) {
  const params = { action: 'record', person, nightDate, result, sig };
  if (useFreeze) params.useFreeze = 'true';
  $('freezeChoice').hidden = true;
  $('checkinResult').hidden = false;
  $('checkinResult').textContent = 'Saving…';
  try {
    const r = await jsonp(params);
    const res = $('checkinResult');
    if (!r.ok) {
      if (/already recorded/i.test(r.error || '')) {
        res.textContent = '✅ This night was already recorded.';
      } else {
        res.textContent = '⚠️ ' + (r.error || 'Could not save');
      }
    } else {
      const e = r.event;
      if (e.result === 'on_time') {
        res.textContent =
          '🎉 Recorded! Earned ' + money(e.amount) + '. Streak: ' + r.state.streak +
          ' nights. Pot: ' + money(r.state.balance) + '.';
      } else if (e.freezeUsed) {
        res.textContent =
          '❄️ Freeze used — streak protected at ' + r.state.streak + ' nights.';
      } else {
        res.textContent =
          'Streak reset to 0. Fresh start tonight 💪 Pot: ' + money(r.state.balance) + '.';
      }
    }
  } catch (err) {
    $('checkinResult').textContent = '⚠️ ' + err.message;
  }
  $('checkinDoneBtn').hidden = false; // always offer a way forward
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

  $('onTimeBtn').addEventListener('click', () => recordDash('on_time'));
  $('missedBtn').addEventListener('click', () => recordDash('missed'));

  $('spendForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = $('spendAmount').value;
    const note = $('spendNote').value;
    banner('Saving…', false);
    try {
      const r = await api('spend', { amount, note });
      if (!r.ok) {
        banner(r.error || 'Could not save', true);
        return;
      }
      $('spendAmount').value = '';
      $('spendNote').value = '';
      banner('Spent ' + money(amount) + '.', false);
      render(r);
    } catch (err) {
      banner(err.message, true);
    }
  });

  $('checkinDoneBtn').addEventListener('click', () => {
    if (getToken()) showDashboard();
    else setView('login');
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
  const nightDate = qp.get('nightDate');
  const result = qp.get('result');
  const sig = qp.get('sig');
  const person = qp.get('person');
  if (person && nightDate && result && sig) {
    // clean the action params from the URL bar but keep them for the flow
    history.replaceState({}, '', location.origin + location.pathname);
    checkinFlow(person, nightDate, result, sig);
    return;
  }
  if (getToken()) {
    showDashboard();
  } else {
    setView('login');
  }
}

document.addEventListener('DOMContentLoaded', boot);
