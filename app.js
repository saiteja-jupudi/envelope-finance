import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, arrayUnion, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmt = n => INR.format(Math.round(n || 0));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const mkey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
const shiftKey = (k, n) => { const [y, m] = k.split('-').map(Number); return mkey(new Date(y, m - 1 + n, 1)); };
const label = (k, short) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: short ? 'short' : 'long', year: 'numeric' }); };
const monShort = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' }); };
const daysIn = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const short = v => v >= 1e5 ? '₹' + (v / 1e5).toFixed(v % 1e5 ? 1 : 0) + 'L' : v >= 1e3 ? '₹' + Math.round(v / 1e3) + 'k' : '₹' + Math.round(v);
const uid = () => 'e' + Math.random().toString(36).slice(2, 9);
const DEFAULTS = ['Rent / EMI', 'Groceries', 'Bills & utilities', 'Fuel & transport', 'Eating out', 'Household', 'Health', 'Shopping', 'Miscellaneous'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint32Array(6)), n => CODE_CHARS[n % CODE_CHARS.length]).join('');

function show(id) { for (const v of ['authView', 'onboardView', 'setupView', 'appView']) $('#' + v).hidden = v !== id; $('#fab').hidden = true; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }
function status(msg) { const s = $('#status'); s.textContent = msg || ''; s.hidden = !msg; }
function msg(el, text, ok) { el.textContent = text || ''; el.hidden = !text; el.className = ok ? 'ok' : 'err'; }

/* ---------- Firebase ---------- */
if (!firebaseConfig || !firebaseConfig.apiKey) { show('setupView'); throw new Error('Missing firebaseConfig in config.js'); }
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let fs;
try { fs = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { fs = getFirestore(fbApp); }

const AUTH_ERR = {
  'auth/invalid-credential': 'Email or password is wrong.',
  'auth/wrong-password': 'Email or password is wrong.',
  'auth/user-not-found': 'Email or password is wrong.',
  'auth/invalid-email': 'That email address doesn\'t look right.',
  'auth/missing-email': 'Enter your email address.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/missing-password': 'Enter your password.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No internet connection. Check it and try again.',
};
const authErr = e => AUTH_ERR[e && e.code] || 'Something went wrong. Try again.';

/* ---------- state ---------- */
let me = null, hid = null, household = null;
let months = {}, txns = [], loadedM = false, loadedT = false, unsubs = [];
let THIS = mkey(new Date());
let cur = THIS, view = 'month', filterEnv = 'all', addEnv = null, planDraft = null, armed = null, armTimer = null;
const hhRef = () => doc(fs, 'households', hid);
const myName = () => (me && (me.displayName || (household && household.memberNames && household.memberNames[me.uid]))) || 'You';

/* ---------- auth screens ---------- */
let authMode = 'signin';
function setAuthMode(m) {
  authMode = m;
  $('#f-name').hidden = m !== 'signup';
  $('#f-pass').hidden = m === 'forgot';
  $('#a-pass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('#authLead').textContent = { signin: 'Sign in to your shared budget.', signup: 'Create your account. Use at least 6 characters for the password.', forgot: 'Enter your email and we\'ll send a link to set a new password.' }[m];
  $('#authSubmit').textContent = { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset link' }[m];
  $('#toForgot').hidden = m !== 'signin';
  $('#toSwitch').textContent = m === 'signin' ? 'New here? Create an account' : 'Back to sign in';
  msg($('#authMsg'), '');
}
$('#toForgot').addEventListener('click', () => setAuthMode('forgot'));
$('#toSwitch').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#a-email').value.trim(), pass = $('#a-pass').value, name = $('#a-name').value.trim(), m = $('#authMsg'), b = $('#authSubmit');
  b.disabled = true;
  try {
    if (authMode === 'signin') await signInWithEmailAndPassword(auth, email, pass);
    else if (authMode === 'signup') {
      if (!name) { msg(m, 'Enter your name so your partner sees who logged a spend.'); return; }
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(fs, 'users', cred.user.uid), { name, email }, { merge: true });
      enterApp(cred.user);
    } else {
      if (!email) { msg(m, 'Enter your email address.'); return; }
      await sendPasswordResetEmail(auth, email);
      msg(m, 'If an account exists for that email, a reset link is on its way. Check spam too.', true);
    }
  } catch (err) { msg(m, authErr(err)); }
  finally { b.disabled = false; }
});

/* ---------- onboarding ---------- */
$('#createHH').addEventListener('click', async () => {
  const b = $('#createHH'), m = $('#onboardMsg'); b.disabled = true; msg(m, '');
  try {
    const ref = doc(collection(fs, 'households')), code = newCode(), name = myName();
    const batch = writeBatch(fs);
    batch.set(ref, { name: 'Our home', inviteCode: code, createdBy: me.uid, members: [me.uid], memberNames: { [me.uid]: name }, createdAt: serverTimestamp() });
    batch.set(doc(fs, 'invites', code), { householdId: ref.id, createdBy: me.uid });
    batch.set(doc(fs, 'users', me.uid), { householdId: ref.id, name }, { merge: true });
    await batch.commit();
    openHousehold(ref.id);
    setTimeout(() => toast('Household created. Share code ' + code + ' from the account menu.'), 400);
  } catch (err) { msg(m, 'Could not create the household. Check your connection and try again.'); console.error(err); }
  finally { b.disabled = false; }
});
$('#joinHH').addEventListener('click', async () => {
  const code = $('#joinCode').value.trim().toUpperCase(), b = $('#joinHH'), m = $('#onboardMsg');
  if (code.length !== 6) return msg(m, 'The code has 6 letters and numbers.');
  b.disabled = true; msg(m, '');
  try {
    const inv = await getDoc(doc(fs, 'invites', code));
    if (!inv.exists()) { msg(m, 'No household has that code. Check it with your partner.'); return; }
    const id = inv.data().householdId, name = myName();
    await updateDoc(doc(fs, 'households', id), { members: arrayUnion(me.uid), ['memberNames.' + me.uid]: name, joinCode: code });
    await setDoc(doc(fs, 'users', me.uid), { householdId: id, name }, { merge: true });
    openHousehold(id);
    setTimeout(() => toast('You joined the household.'), 400);
  } catch (err) { msg(m, 'Could not join. The household may already have 4 members, or the connection dropped.'); console.error(err); }
  finally { b.disabled = false; }
});
$('#onboardOut').addEventListener('click', () => signOut(auth));

/* ---------- session ---------- */
async function enterApp(user) {
  me = user;
  let snap;
  try { snap = await getDoc(doc(fs, 'users', user.uid)); } catch { snap = null; }
  const h = snap && snap.exists() && snap.data().householdId;
  if (h) openHousehold(h);
  else { $('#hello').textContent = 'Welcome, ' + (user.displayName || 'there'); show('onboardView'); }
}
function stopSubs() { unsubs.forEach(u => u()); unsubs = []; }
function openHousehold(id) {
  stopSubs(); hid = id; months = {}; txns = []; loadedM = loadedT = false; household = null;
  show('appView'); render();
  const onErr = e => { console.error(e); status(e.code === 'permission-denied' ? 'You no longer have access to this household.' : 'Lost the connection to your data. Reopen the app to reconnect.'); };
  unsubs.push(onSnapshot(hhRef(), s => { household = s.exists() ? s.data() : null; render(); }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'households', id, 'months'), s => {
    months = {}; s.forEach(d => months[d.id] = d.data()); loadedM = true; render();
  }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'households', id, 'txns'), s => {
    txns = []; s.forEach(d => { const x = d.data(); if (x.month && typeof x.amount === 'number') txns.push({ id: d.id, ...x }); }); loadedT = true; render();
  }, onErr));
}
onAuthStateChanged(auth, user => {
  stopSubs(); closeSheets();
  if (!user) { me = null; hid = null; setAuthMode('signin'); show('authView'); return; }
  if (me && me.uid === user.uid && hid) return;
  enterApp(user);
});
function updateOnline() { if (!navigator.onLine) status('You\'re offline. Spends you add are kept on this phone and sync when you\'re back online.'); else status(''); }
addEventListener('online', updateOnline); addEventListener('offline', updateOnline);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { const t = mkey(new Date()); if (t !== THIS) { if (cur === THIS) cur = t; THIS = t; } render(); } });

/* ---------- calculations ---------- */
function stats(k) {
  const plan = months[k] || null, env = (plan && plan.envelopes) || [];
  const t = txns.filter(x => x.month === k);
  const ids = new Set(env.map(e => e.id));
  const byEnv = {}; let unplanned = 0;
  for (const x of t) { if (ids.has(x.envelopeId)) byEnv[x.envelopeId] = (byEnv[x.envelopeId] || 0) + x.amount; else unplanned += x.amount; }
  return { plan, env, t, byEnv, unplanned, budget: env.reduce((s, e) => s + (+e.limit || 0), 0), spent: t.reduce((s, x) => s + x.amount, 0), salary: plan ? +plan.salary || 0 : 0 };
}
const dayFrac = k => k < THIS ? 1 : k > THIS ? 0 : new Date().getDate() / daysIn(k);
const prevPlanKey = k => Object.keys(months).filter(x => x < k).sort().pop() || null;
const allKeys = () => [...new Set([...Object.keys(months), ...txns.map(x => x.month)])].sort();
const whoName = u => !u ? '' : u === (me && me.uid) ? 'you' : ((household && household.memberNames && household.memberNames[u]) || 'partner');

/* ---------- render ---------- */
function render() {
  if ($('#appView').hidden) return;
  $('#mlabel').textContent = label(cur);
  $('#acctBtn').textContent = (myName()[0] || '?').toUpperCase();
  for (const [id, v] of [['tab-month', 'month'], ['tab-trends', 'trends']]) { const b = $('#' + id); b.classList.toggle('on', view === v); b.setAttribute('aria-selected', view === v); }
  if (view === 'month') renderMonth(); else renderTrends();
  $('#fab').hidden = !(view === 'month' && months[cur]);
}

function envStatus(e, spent, frac) {
  const lim = +e.limit || 0, pct = lim ? spent / lim : (spent > 0 ? 2 : 0);
  if (spent > lim) return { cls: 'over', pill: 'Over by ' + fmt(spent - lim) };
  if (pct >= .85) return { cls: 'warn', pill: 'Almost empty' };
  if (frac > 0 && frac < 1 && pct > frac + .15 && pct > .3) return { cls: 'warn', pill: 'Ahead of pace' };
  return { cls: '', pill: '' };
}

function renderMonth() {
  const main = $('#main');
  if (!(loadedM && loadedT)) { main.innerHTML = `<div class="empty"><h2>Opening your envelopes</h2><p>This month's salary, envelope limits and every spend you both log will appear here.</p></div>`; return; }
  const s = stats(cur);
  if (!s.plan) {
    const prev = prevPlanKey(cur);
    main.innerHTML = `<div class="empty"><h2>No envelopes for ${label(cur)} yet</h2>
      <p>When salary comes in, enter it and set a limit for each envelope. Then log each spend against an envelope, and the balance updates on both phones.</p>
      <div class="row">${prev ? `<button class="btn primary" data-act="copy" data-k="${prev}">Copy ${label(prev, true)} envelopes</button>` : ''}<button class="btn ${prev ? '' : 'primary'}" data-act="fresh">${prev ? 'Start from scratch' : 'Set up envelopes'}</button></div>
    </div>${s.t.length ? ledgerHTML(s) : ''}`;
    return;
  }
  const frac = dayFrac(cur), left = s.budget - s.spent, pct = s.budget ? Math.min(100, s.spent / s.budget * 100) : 0;
  const overN = s.env.filter(e => (s.byEnv[e.id] || 0) > (+e.limit || 0)).length;
  const paceTxt = cur === THIS ? `Day ${new Date().getDate()} of ${daysIn(cur)} · ${Math.round(frac * 100)}% of the month gone, ${Math.round(s.budget ? s.spent / s.budget * 100 : 0)}% of the budget spent` : cur < THIS ? 'Month closed' : 'Upcoming month';
  let html = `<section class="summary">
    <div class="left"><span class="label">Left in envelopes</span><span class="num ${left < 0 ? 'neg' : ''}">${fmt(left)}</span><span class="sub">${fmt(s.spent)} spent of ${fmt(s.budget)} budgeted</span></div>
    <div><span class="meter ${s.spent > s.budget ? 'over' : ''}"><i style="width:${pct}%"></i>${frac > 0 && frac < 1 ? `<b class="pace" style="left:calc(${frac * 100}% - 1px)" title="Where spending would be at an even pace"></b>` : ''}</span>
    <p class="pacenote">${paceTxt}</p></div>
    <dl class="facts">
      <div><dt>Salary</dt><dd>${fmt(s.salary)}</dd></div>
      <div><dt>Not in envelopes</dt><dd class="${s.salary - s.budget < 0 ? 'neg' : ''}">${fmt(s.salary - s.budget)}</dd></div>
      <div><dt>Salary left after spends</dt><dd class="${s.salary - s.spent < 0 ? 'neg' : ''}">${fmt(s.salary - s.spent)}</dd></div>
      <div><dt>Envelopes over limit</dt><dd class="${overN ? 'neg' : ''}">${overN} of ${s.env.length}</dd></div>
    </dl>
    <button class="btn" data-act="edit" style="align-self:flex-start">Edit salary & envelopes</button>
  </section>
  <section><div class="sechead"><h2>Envelopes</h2><span class="label">Tap one to log a spend</span></div><div class="envs">`;
  for (const e of s.env) {
    const sp = s.byEnv[e.id] || 0, lim = +e.limit || 0, st = envStatus(e, sp, frac), w = lim ? Math.min(100, sp / lim * 100) : (sp ? 100 : 0);
    html += `<button class="env ${st.cls}" data-act="addto" data-env="${esc(e.id)}">
      <span class="name">${esc(e.name)}</span>
      <span class="rest">${sp > lim ? '−' + fmt(sp - lim) : fmt(lim - sp)}</span>
      <span class="of">${sp > lim ? 'over' : 'left'} · ${fmt(sp)} of ${fmt(lim)}</span>
      <span class="meter ${st.cls === 'over' ? 'over' : ''}"><i style="width:${w}%"></i></span>
      ${st.pill ? `<span class="pill ${st.cls}">${st.pill}</span>` : ''}
    </button>`;
  }
  if (s.unplanned > 0) html += `<div class="env over"><span class="name">Removed envelopes</span><span class="rest">${fmt(s.unplanned)}</span><span class="of">spent from envelopes no longer in this month's plan</span></div>`;
  html += `</div></section>${ledgerHTML(s)}`;
  main.innerHTML = html;
}

function ledgerHTML(s) {
  const names = Object.fromEntries(s.env.map(e => [e.id, e.name]));
  const used = [...new Set(s.t.map(x => x.envelopeId))];
  if (filterEnv !== 'all' && !used.includes(filterEnv)) filterEnv = 'all';
  const list = s.t.filter(x => filterEnv === 'all' || x.envelopeId === filterEnv).sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0));
  let h = `<section><div class="sechead"><h2>Spends</h2><span class="label">${s.t.length} logged</span></div>`;
  if (!s.t.length) return h + `<p class="quiet">Nothing logged for ${label(cur)} yet. Use “+ Add spend” after each purchase.</p></section>`;
  if (used.length > 1) {
    h += `<div class="chips"><button class="chip ${filterEnv === 'all' ? 'on' : ''}" data-act="filter" data-env="all">All</button>`;
    for (const id of used) h += `<button class="chip ${filterEnv === id ? 'on' : ''}" data-act="filter" data-env="${esc(id)}">${esc(names[id] || (s.t.find(x => x.envelopeId === id) || {}).envelopeName || 'Removed')}</button>`;
    h += '</div>';
  }
  const groups = {}; for (const x of list) (groups[x.date] = groups[x.date] || []).push(x);
  h += '<div class="ledger">';
  for (const d of Object.keys(groups)) {
    const dt = new Date(d + 'T00:00:00'), tot = groups[d].reduce((a, x) => a + x.amount, 0);
    h += `<div class="day"><div class="label dayhead"><span>${dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span><span class="mono">${fmt(tot)}</span></div>`;
    for (const x of groups[d]) {
      const en = names[x.envelopeId] || x.envelopeName || 'Removed envelope', who = whoName(x.by);
      h += `<div class="tx"><div class="what"><div class="note">${esc(x.note || en)}</div><div class="meta">${x.note ? esc(en) + ' · ' : ''}${who ? 'by ' + esc(who) : ''}</div></div>
        <span class="amt">${fmt(x.amount)}</span><button class="del ${armed === x.id ? 'arm' : ''}" data-act="del" data-id="${esc(x.id)}">${armed === x.id ? 'Confirm' : 'Delete'}</button></div>`;
    }
    h += '</div>';
  }
  return h + '</div></section>';
}

/* ---------- trends ---------- */
function nice(max, n) { const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw))); const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw); return { step, top: step * Math.ceil(max / step) }; }

function renderTrends() {
  const main = $('#main');
  if (!(loadedM && loadedT)) { renderMonth(); return; }
  const keys = allKeys().filter(k => k <= cur).slice(-12);
  if (!keys.length) { main.innerHTML = `<div class="empty"><h2>No months to compare yet</h2><p>Trends fill in once you've set up a month and logged some spends. Each month becomes a bar here.</p></div>`; return; }
  const data = keys.map(k => ({ k, ...stats(k) }));
  const planned = data.filter(d => d.plan);
  const avgSpent = data.reduce((a, d) => a + d.spent, 0) / data.length;
  const avgSaved = planned.length ? planned.reduce((a, d) => a + (d.salary - d.spent), 0) / planned.length : 0;
  const overMonths = planned.filter(d => d.spent > d.budget).length;
  const overBy = {};
  for (const d of planned) for (const e of d.env) { const o = (d.byEnv[e.id] || 0) - (+e.limit || 0); if (o > 0) { const n = e.name.trim(); overBy[n] = (overBy[n] || 0) + o; } }
  const worst = Object.entries(overBy).sort((a, b) => b[1] - a[1])[0];
  let h = `<div class="tiles">
    <div class="tile"><div class="label">Avg spent / month</div><div class="v">${fmt(avgSpent)}</div></div>
    <div class="tile"><div class="label">Avg salary saved</div><div class="v ${avgSaved < 0 ? 'neg' : ''}">${fmt(avgSaved)}</div></div>
    <div class="tile"><div class="label">Months over budget</div><div class="v ${overMonths ? 'neg' : ''}">${overMonths} of ${planned.length}</div></div>
    <div class="tile"><div class="label">Most overspent</div><div class="v ${worst ? 'neg' : ''}" style="font-size:1rem">${worst ? esc(worst[0]) + '<br>' + fmt(worst[1]) : 'None yet'}</div></div>
  </div>
  <section class="panel"><div class="sechead"><h2>Budget vs spent by month</h2></div><div id="barChart" class="chart"></div>
    <div class="legend"><span><i style="background:var(--accent-soft)"></i>Budgeted</span><span><i style="background:var(--accent)"></i>Spent</span><span><i style="background:var(--over)"></i>Spent, over budget</span></div></section>
  <section class="panel"><div class="sechead"><h2>${label(cur)}: running total</h2></div><div id="cumChart" class="chart"></div>
    <div class="legend"><span><i style="background:var(--accent)"></i>Spent so far</span><span><i style="border-top:2px dashed var(--ink);height:0"></i>Budget</span><span><i style="border-top:2px dotted var(--muted);height:0"></i>Even pace</span></div></section>`;
  const tk = planned.slice(-6);
  if (tk.length) {
    const names = []; for (const d of [...tk].reverse()) for (const e of d.env) { const n = e.name.trim(); if (!names.some(x => x.toLowerCase() === n.toLowerCase())) names.push(n); }
    h += `<section class="panel"><div class="sechead"><h2>Envelopes month by month</h2><span class="label">spent / limit</span></div><div class="tablewrap"><table><thead><tr><th>Envelope</th>${tk.map(d => `<th>${label(d.k, true)}</th>`).join('')}<th>Avg</th></tr></thead><tbody>`;
    for (const n of names) {
      let sum = 0, c = 0; h += `<tr><td>${esc(n)}</td>`;
      for (const d of tk) {
        const e = d.env.find(x => x.name.trim().toLowerCase() === n.toLowerCase());
        if (!e) { h += '<td><small>—</small></td>'; continue; }
        const sp = d.byEnv[e.id] || 0; sum += sp; c++;
        h += `<td class="${sp > (+e.limit || 0) ? 'o' : ''}">${fmt(sp)}<small>${fmt(e.limit)}</small></td>`;
      }
      h += `<td>${fmt(c ? sum / c : 0)}</td></tr>`;
    }
    h += '</tbody></table></div></section>';
  }
  main.innerHTML = h;
  barChart($('#barChart'), data); cumChart($('#cumChart'), cur);
}

function barChart(el, data) {
  const W = Math.max(260, el.clientWidth), H = 210, pL = 48, pR = 6, pT = 12, pB = 26, iw = W - pL - pR, ih = H - pT - pB;
  const max = Math.max(1, ...data.map(d => Math.max(d.budget, d.spent))); const { step, top } = nice(max, 4);
  const y = v => pT + ih - (v / top) * ih, bw = iw / data.length, every = bw < 26 ? 2 : 1;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Monthly budget compared with spending">`;
  for (let v = 0; v <= top + 1e-6; v += step) s += `<line class="grid" x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pL - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`;
  data.forEach((d, i) => {
    const cx = pL + i * bw + bw / 2, bW = Math.min(30, bw * .72), sw = bW * .55;
    if (d.budget > 0) s += `<rect class="bud" x="${cx - bW / 2}" y="${y(d.budget)}" width="${bW}" height="${pT + ih - y(d.budget)}" rx="3"/>`;
    if (d.spent > 0) s += `<rect class="${d.budget > 0 && d.spent > d.budget ? 'spo' : 'sp'}" x="${cx - sw / 2}" y="${y(d.spent)}" width="${sw}" height="${pT + ih - y(d.spent)}" rx="2"><title>${label(d.k, true)}: ${fmt(d.spent)} of ${fmt(d.budget)}</title></rect>`;
    if ((data.length - 1 - i) % every === 0) s += `<text class="ax${d.k === cur ? ' cur' : ''}" x="${cx}" y="${H - 8}" text-anchor="middle">${monShort(d.k)}</text>`;
  });
  el.innerHTML = s + '</svg>';
}

function cumChart(el, k) {
  const st = stats(k), N = daysIn(k), last = k < THIS ? N : k > THIS ? 0 : new Date().getDate();
  if (!st.budget && !st.spent) { el.innerHTML = '<p class="quiet">No budget or spends for this month yet.</p>'; el.style.minHeight = '0'; return; }
  el.style.minHeight = '';
  const daily = Array(N + 1).fill(0); for (const x of st.t) { const d = +x.date.slice(8, 10); if (d >= 1 && d <= N) daily[d] += x.amount; }
  const cum = [0]; for (let d = 1; d <= N; d++) cum[d] = cum[d - 1] + daily[d];
  const W = Math.max(260, el.clientWidth), H = 210, pL = 48, pR = 14, pT = 16, pB = 26, iw = W - pL - pR, ih = H - pT - pB;
  const max = Math.max(1, st.budget, cum[Math.max(last, 0)] || 0); const { step, top } = nice(max * 1.05, 4);
  const x = d => pL + (d / N) * iw, y = v => pT + ih - (v / top) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Running total of spending this month">`;
  for (let v = 0; v <= top + 1e-6; v += step) s += `<line class="grid" x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pL - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`;
  for (const d of [1, 10, 20, N]) s += `<text class="ax" x="${x(d)}" y="${H - 8}" text-anchor="middle">${d}</text>`;
  if (st.budget) s += `<line class="budl" x1="${pL}" x2="${W - pR}" y1="${y(st.budget)}" y2="${y(st.budget)}"/><line class="pacel" x1="${x(0)}" y1="${y(0)}" x2="${x(N)}" y2="${y(st.budget)}"/>`;
  if (last > 0) {
    let p = `M${x(0)},${y(0)}`; for (let d = 1; d <= last; d++) p += ` L${x(d)},${y(cum[d])}`;
    s += `<path class="area" d="${p} L${x(last)},${y(0)} Z"/><path class="line" d="${p}"/>`;
    const v = cum[last], ex = x(last), ey = y(v), o = st.budget && v > st.budget, flip = ex > W - 90;
    s += `<circle class="dot ${o ? 'o' : ''}" cx="${ex}" cy="${ey}" r="5"/><text class="vl" x="${flip ? ex - 8 : ex + 8}" y="${Math.max(pT + 10, ey - 8)}" text-anchor="${flip ? 'end' : 'start'}">${fmt(v)}</text>`;
  }
  el.innerHTML = s + '</svg>';
}

/* ---------- sheets ---------- */
function openSheet(id) { $('#backdrop').hidden = false; $('#' + id).hidden = false; }
function closeSheets() { $('#backdrop').hidden = true; for (const id of ['addSheet', 'planSheet', 'acctSheet']) $('#' + id).hidden = true; }

function openAdd(envId) {
  const s = stats(cur); if (!s.plan) return;
  addEnv = envId || (s.env.some(e => e.id === addEnv) ? addEnv : s.env[0] && s.env[0].id);
  $('#addTitle').textContent = 'Add a spend · ' + label(cur, true);
  const N = daysIn(cur), t = todayISO(), d = $('#add-date');
  d.min = cur + '-01'; d.max = cur + '-' + pad(N);
  d.value = t.startsWith(cur) ? t : (cur < THIS ? cur + '-' + pad(N) : cur + '-01');
  $('#add-amount').value = ''; $('#add-note').value = ''; $('#add-err').hidden = true;
  renderPick(s); openSheet('addSheet'); setTimeout(() => $('#add-amount').focus(), 60);
}
function renderPick(s) {
  $('#add-envs').innerHTML = s.env.map(e => {
    const left = (+e.limit || 0) - (s.byEnv[e.id] || 0);
    return `<button type="button" class="${e.id === addEnv ? 'on' : ''}" data-pick="${esc(e.id)}" aria-pressed="${e.id === addEnv}">${esc(e.name)}<small>${left < 0 ? '−' + fmt(-left) : fmt(left)}</small></button>`;
  }).join('');
}
$('#add-envs').addEventListener('click', ev => { const b = ev.target.closest('[data-pick]'); if (!b) return; addEnv = b.dataset.pick; renderPick(stats(cur)); });
$('#add-save').addEventListener('click', () => {
  const amt = parseFloat($('#add-amount').value), date = $('#add-date').value, err = $('#add-err');
  const s = stats(cur), e = s.env.find(x => x.id === addEnv);
  const fail = m => { err.textContent = m; err.hidden = false; };
  if (!(amt > 0)) return fail('Enter an amount above zero.');
  if (!e) return fail('Pick an envelope.');
  if (!date || !date.startsWith(cur)) return fail('Pick a date in ' + label(cur) + '.');
  // Not awaited: Firestore applies the write locally at once and syncs when online.
  setDoc(doc(collection(fs, 'households', hid, 'txns')), { month: cur, envelopeId: e.id, envelopeName: e.name, amount: Math.round(amt * 100) / 100, note: $('#add-note').value.trim(), date, by: me.uid, at: Date.now() })
    .catch(x => { console.error(x); toast('That spend could not be saved. Add it again.'); });
  closeSheets();
  const left = (+e.limit || 0) - ((s.byEnv[e.id] || 0) + amt);
  toast(left < 0 ? `Saved. ${e.name} is over by ${fmt(-left)}` : `Saved. ${fmt(left)} left in ${e.name}`);
});

function openPlan(mode, fromKey) {
  const base = mode === 'copy' ? months[fromKey] : mode === 'edit' ? months[cur] : null;
  planDraft = { salary: base ? base.salary : '', envelopes: base ? base.envelopes.map(e => ({ ...e })) : DEFAULTS.map(n => ({ id: uid(), name: n, limit: '' })) };
  $('#planTitle').textContent = (mode === 'edit' ? 'Edit ' : 'Set up ') + label(cur) + ' envelopes';
  $('#plan-salary').value = planDraft.salary; $('#plan-err').hidden = true;
  renderPlanRows(); openSheet('planSheet');
}
function renderPlanRows() {
  $('#plan-rows').innerHTML = planDraft.envelopes.map((e, i) => `<div class="prow"><input id="pn-${e.id}" data-i="${i}" data-f="name" type="text" maxlength="40" value="${esc(e.name)}" placeholder="Envelope name" aria-label="Envelope name"><input id="pl-${e.id}" data-i="${i}" data-f="limit" type="number" inputmode="decimal" min="0" step="1" value="${esc(e.limit)}" placeholder="Limit" aria-label="Limit"><button type="button" data-rm="${i}" aria-label="Remove envelope">×</button></div>`).join('');
  updateAlloc();
}
function updateAlloc() {
  const sal = +$('#plan-salary').value || 0, tot = planDraft.envelopes.reduce((a, e) => a + (+e.limit || 0), 0), rem = sal - tot;
  $('#plan-alloc').innerHTML = `Allocated <b>${fmt(tot)}</b> of <b>${fmt(sal)}</b> · ${rem >= 0 ? 'Unallocated' : 'Over-allocated by'} <b class="${rem < 0 ? 'neg' : ''}">${fmt(Math.abs(rem))}</b>`;
}
$('#plan-rows').addEventListener('input', ev => { const t = ev.target; if (t.dataset.i == null) return; planDraft.envelopes[+t.dataset.i][t.dataset.f] = t.value; updateAlloc(); });
$('#plan-rows').addEventListener('click', ev => { const b = ev.target.closest('[data-rm]'); if (!b) return; planDraft.envelopes.splice(+b.dataset.rm, 1); renderPlanRows(); });
$('#plan-salary').addEventListener('input', updateAlloc);
$('#plan-addrow').addEventListener('click', () => { const e = { id: uid(), name: '', limit: '' }; planDraft.envelopes.push(e); renderPlanRows(); $('#pn-' + e.id).focus(); });
$('#plan-save').addEventListener('click', () => {
  const fail = m => { const err = $('#plan-err'); err.textContent = m; err.hidden = false; };
  const envs = planDraft.envelopes.map(e => ({ id: e.id, name: String(e.name).trim(), limit: Math.round(+e.limit || 0) })).filter(e => e.name || e.limit);
  if (!envs.length) return fail('Add at least one envelope.');
  if (envs.some(e => !e.name)) return fail('Give every envelope a name.');
  const seen = new Set(); for (const e of envs) { const n = e.name.toLowerCase(); if (seen.has(n)) return fail(`“${e.name}” appears twice. Use different names.`); seen.add(n); }
  setDoc(doc(fs, 'households', hid, 'months', cur), { salary: Math.round(+$('#plan-salary').value || 0), envelopes: envs, updatedAt: Date.now(), by: me.uid })
    .catch(x => { console.error(x); toast('Envelopes could not be saved. Try again.'); });
  closeSheets(); toast('Envelopes saved for ' + label(cur, true));
});

/* ---------- account ---------- */
$('#acctBtn').addEventListener('click', () => {
  $('#acctWho').textContent = myName() + ' · ' + (me.email || '');
  const names = household && household.memberNames ? Object.entries(household.memberNames).map(([u, n]) => n + (u === me.uid ? ' (you)' : '')) : [];
  $('#acctMembers').textContent = names.length > 1 ? names.join(', ') : (names[0] || '') + ' — waiting for your partner to join';
  $('#acctCode').textContent = (household && household.inviteCode) || '—';
  msg($('#acctMsg'), ''); openSheet('acctSheet');
});
$('#copyCode').addEventListener('click', async () => {
  const c = $('#acctCode').textContent;
  try { await navigator.clipboard.writeText(c); toast('Code copied'); }
  catch { const r = document.createRange(); r.selectNodeContents($('#acctCode')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});
$('#acctReset').addEventListener('click', async () => {
  try { await sendPasswordResetEmail(auth, me.email); msg($('#acctMsg'), 'Reset link sent to ' + me.email + '. Check spam too.', true); }
  catch (e) { msg($('#acctMsg'), authErr(e)); }
});
$('#acctOut').addEventListener('click', () => { closeSheets(); signOut(auth); });

/* ---------- events ---------- */
$('#main').addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
  if (a === 'addto') openAdd(b.dataset.env);
  else if (a === 'copy') openPlan('copy', b.dataset.k);
  else if (a === 'fresh') openPlan('fresh');
  else if (a === 'edit') openPlan('edit');
  else if (a === 'filter') { filterEnv = b.dataset.env; render(); }
  else if (a === 'del') {
    const id = b.dataset.id;
    if (armed !== id) { armed = id; clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; render(); }, 3500); render(); return; }
    armed = null; clearTimeout(armTimer);
    deleteDoc(doc(fs, 'households', hid, 'txns', id)).catch(() => toast('Could not delete. Try again.'));
    toast('Spend deleted');
  }
});
$('#fab').addEventListener('click', () => openAdd());
$('#backdrop').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
$('#prev').addEventListener('click', () => { cur = shiftKey(cur, -1); filterEnv = 'all'; render(); });
$('#next').addEventListener('click', () => { cur = shiftKey(cur, 1); filterEnv = 'all'; render(); });
$('#mlabel').addEventListener('click', () => { cur = THIS; filterEnv = 'all'; render(); });
$('#tab-month').addEventListener('click', () => { view = 'month'; render(); });
$('#tab-trends').addEventListener('click', () => { view = 'trends'; render(); });
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (view === 'trends') render(); }, 150); });

updateOnline();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
