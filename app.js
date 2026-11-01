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

function show(id) { for (const v of ['authView', 'onboardView', 'setupView', 'appView']) $('#' + v).hidden = v !== id; $('#fabs').hidden = true; }
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
let requests = [], seenReq = new Map(), payees = {};
const members = () => (household && household.members) || [];
const partnerIds = () => members().filter(u => me && u !== me.uid);
const partnerLabel = () => { const p = partnerIds(); return p.length ? p.map(u => whoName(u)).join(' or ') : 'your partner'; };
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
  stopSubs(); hid = id; months = {}; txns = []; requests = []; seenReq = new Map(); loadedM = loadedT = false; household = null;
  show('appView'); render();
  const onErr = e => { console.error(e); status(e.code === 'permission-denied' ? 'You no longer have access to this household.' : 'Lost the connection to your data. Reopen the app to reconnect.'); };
  unsubs.push(onSnapshot(hhRef(), s => { household = s.exists() ? s.data() : null; render(); }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'households', id, 'months'), s => {
    months = {}; s.forEach(d => months[d.id] = d.data()); loadedM = true; render();
  }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'households', id, 'txns'), s => {
    txns = []; s.forEach(d => { const x = d.data(); if (x.month && typeof x.amount === 'number') txns.push({ id: d.id, ...x }); }); loadedT = true; render();
  }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'households', id, 'requests'), s => {
    const next = []; s.forEach(d => { const r = d.data(); if (Array.isArray(r.changes)) next.push({ id: d.id, ...r }); });
    for (const r of next) {
      const prev = seenReq.get(r.id);
      if (prev === 'pending' && r.status !== 'pending' && r.requestedBy === me.uid)
        toast(`${cap(whoName(r.decidedBy))} ${r.status === 'approved' ? 'approved' : 'declined'} your limit request`);
      seenReq.set(r.id, r.status);
    }
    requests = next; render();
  }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'households', id, 'payees'), s => {
    payees = {}; s.forEach(d => payees[d.id] = d.data());
  }, onErr));
  setTimeout(checkPending, 600);
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
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
// Envelopes are either for spending or for saving/investing. An envelope without an explicit
// type is treated as savings when its name says so (chit fund, SIP, RD, FD, PPF, gold...).
const SAVE_RE = /chit|\bsips?\b|saving|invest|mutual|\bmf\b|\brd\b|\bfd\b|ppf|nps|gold|emergency fund|stock|equity/i;
const MARKET_RE = /\bsips?\b|mutual|\bmf\b|stock|share|equity|nps|gold/i;
const isSave = e => !!e && (e.type ? e.type === 'save' : SAVE_RE.test(e.name || ''));

function stats(k) {
  const plan = months[k] || null, env = (plan && plan.envelopes) || [];
  const t = txns.filter(x => x.month === k);
  const byId = Object.fromEntries(env.map(e => [e.id, e]));
  const byEnv = {}; let unplanned = 0, saved = 0, spent = 0;
  for (const x of t) {
    const e = byId[x.envelopeId];
    if (e) byEnv[e.id] = (byEnv[e.id] || 0) + x.amount; else unplanned += x.amount;
    if (e && isSave(e)) saved += x.amount; else spent += x.amount;
  }
  const spendEnv = env.filter(e => !isSave(e)), saveEnv = env.filter(isSave);
  const sumLimits = list => list.reduce((a, e) => a + (+e.limit || 0), 0);
  return {
    plan, env, spendEnv, saveEnv, t, byEnv, unplanned,
    budget: sumLimits(spendEnv), spent, saveTarget: sumLimits(saveEnv), saved, total: spent + saved,
    salary: plan ? +plan.salary || 0 : 0,
  };
}
// Running total for a savings envelope: one-time opening balance + every payment into it, all months.
function fundTotal(e) {
  const f = household && household.funds && household.funds[e.id];
  const opening = f ? +f.opening || 0 : 0, n = e.name.trim().toLowerCase();
  const contributed = txns.filter(x => x.envelopeId === e.id || (x.envelopeName || '').trim().toLowerCase() === n).reduce((a, x) => a + x.amount, 0);
  return { opening, contributed, total: opening + contributed };
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
  $('#fabs').hidden = !(view === 'month' && months[cur]);
  $('#fabPay').hidden = cur !== THIS;
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
    main.innerHTML = approvalsHTML() + `<div class="empty"><h2>No envelopes for ${label(cur)} yet</h2>
      <p>When salary comes in, enter it and set a limit for each envelope. Then log each spend against an envelope, and the balance updates on both phones.</p>
      <div class="row">${prev ? `<button class="btn primary" data-act="copy" data-k="${prev}">Copy ${label(prev, true)} envelopes</button>` : ''}<button class="btn ${prev ? '' : 'primary'}" data-act="fresh">${prev ? 'Start from scratch' : 'Set up envelopes'}</button></div>
    </div>${s.t.length ? ledgerHTML(s) : ''}`;
    return;
  }
  const frac = dayFrac(cur), left = s.budget - s.spent, pct = s.budget ? Math.min(100, s.spent / s.budget * 100) : 0;
  const overN = s.spendEnv.filter(e => (s.byEnv[e.id] || 0) > (+e.limit || 0)).length;
  const unalloc = s.salary - s.budget - s.saveTarget;
  const paceTxt = cur === THIS ? `Day ${new Date().getDate()} of ${daysIn(cur)} · ${Math.round(frac * 100)}% of the month gone, ${Math.round(s.budget ? s.spent / s.budget * 100 : 0)}% of the budget spent` : cur < THIS ? 'Month closed' : 'Upcoming month';
  let html = approvalsHTML() + `<section class="summary">
    <div class="left"><span class="label">Left to spend</span><span class="num ${left < 0 ? 'neg' : ''}">${fmt(left)}</span><span class="sub">${fmt(s.spent)} spent of ${fmt(s.budget)} budgeted for spending</span></div>
    <div><span class="meter ${s.spent > s.budget ? 'over' : ''}"><i style="width:${pct}%"></i>${frac > 0 && frac < 1 ? `<b class="pace" style="left:calc(${frac * 100}% - 1px)" title="Where spending would be at an even pace"></b>` : ''}</span>
    <p class="pacenote">${paceTxt}</p></div>
    <dl class="facts">
      <div><dt>Salary</dt><dd>${fmt(s.salary)}</dd></div>
      <div><dt>Saved &amp; invested</dt><dd class="pos">${fmt(s.saved)} <small>of ${fmt(s.saveTarget)}</small></dd></div>
      <div><dt>Not allocated</dt><dd class="${unalloc < 0 ? 'neg' : ''}">${fmt(unalloc)}</dd></div>
      <div><dt>Salary left now</dt><dd class="${s.salary - s.total < 0 ? 'neg' : ''}">${fmt(s.salary - s.total)}</dd></div>
      <div><dt>Envelopes over limit</dt><dd class="${overN ? 'neg' : ''}">${overN} of ${s.spendEnv.length}</dd></div>
      <div><dt>Emergency overrides</dt><dd>${overridesUsed(cur)} of ${rules().overridesPerMonth}</dd></div>
    </dl>
    <button class="btn" data-act="edit" style="align-self:flex-start">Edit salary & envelopes</button>
  </section>
  <section><div class="sechead"><h2>Spending</h2><span class="label">Tap one to log a spend</span></div><div class="envs">`;
  for (const e of s.spendEnv) {
    const sp = s.byEnv[e.id] || 0, lim = +e.limit || 0, st = envStatus(e, sp, frac), w = lim ? Math.min(100, sp / lim * 100) : (sp ? 100 : 0);
    html += `<button class="env ${st.cls}" style="--c:${envColor(s, e)}" data-act="addto" data-env="${esc(e.id)}">
      <span class="name">${esc(e.name)} <span class="cap">(${fmt(lim)})</span></span>
      <span class="of">${fmt(sp)} spent out of ${fmt(lim)}</span>
      <span class="bal"><small>Balance:</small> ${sp > lim ? '−' + fmt(sp - lim) : fmt(lim - sp)}</span>
      <span class="meter ${st.cls === 'over' ? 'over' : ''}"><i style="width:${w}%"></i></span>
      ${st.pill ? `<span class="pill ${st.cls}">${st.pill}</span>` : ''}
    </button>`;
  }
  if (s.unplanned > 0) html += `<div class="env over"><span class="name">Removed envelopes</span><span class="rest">${fmt(s.unplanned)}</span><span class="of">spent from envelopes no longer in this month's plan</span></div>`;
  html += `</div></section>`;

  if (s.saveEnv.length) {
    html += `<section><div class="sechead"><h2>Savings &amp; investments</h2><button class="link" data-act="funds">Opening balances</button></div><div class="envs">`;
    for (const e of s.saveEnv) {
      const sv = s.byEnv[e.id] || 0, tgt = +e.limit || 0, w = tgt ? Math.min(100, sv / tgt * 100) : (sv ? 100 : 0);
      const ft = fundTotal(e), mkt = MARKET_RE.test(e.name), verb = mkt ? 'invested' : 'saved', done = tgt > 0 && sv >= tgt;
      html += `<button class="env save${done ? ' done' : ''}" style="--c:${envColor(s, e)}" data-act="addto" data-env="${esc(e.id)}">
        <span class="name">${esc(e.name)} <span class="cap">(${fmt(tgt)})</span></span>
        <span class="of">${fmt(sv)} ${verb} out of ${fmt(tgt)}</span>
        <span class="bal"><small>Still to ${mkt ? 'invest' : 'save'}:</small> ${fmt(Math.max(0, tgt - sv))}</span>
        <span class="meter"><i style="width:${w}%"></i></span>
        <span class="total"><small>${mkt ? 'Invested to date (not market value)' : 'Saved to date'}</small><b>${fmt(ft.total)}</b></span>
        ${done ? `<span class="pill done">${sv > tgt ? 'Target reached +' + fmt(sv - tgt) : 'Target reached'}</span>` : ''}
      </button>`;
    }
    html += `</div></section>`;
  } else {
    html += `<p class="quiet">Tip: mark chit funds, SIPs or RDs as <b>Save</b> in “Edit salary &amp; envelopes” to track them as savings, with a running total.</p>`;
  }
  html += ledgerHTML(s);
  main.innerHTML = html;
}

function approvalsHTML() {
  const pend = requests.filter(r => r.status === 'pending').sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  if (!pend.length) return '';
  let h = `<section class="approvals"><div class="sechead"><h2>Waiting for approval</h2><span class="label">${pend.length}</span></div>`;
  for (const r of pend) {
    const mine = r.requestedBy === me.uid;
    const lines = r.changes.map(c => `<li><b>${esc(c.name)}</b> <span class="mono">${fmtRule(c, c.from)} → ${fmtRule(c, c.to)}</span> <span class="up">+${fmtRule(c, c.to - c.from)}</span></li>`).join('');
    h += `<div class="appr ${mine ? 'mine' : ''}">
      <p class="who">${mine ? 'You asked ' + esc(partnerLabel()) : esc(cap(whoName(r.requestedBy))) + ' asks to raise'} · ${label(r.month, true)}</p>
      <ul>${lines}</ul>${r.reason ? `<p class="reason">“${esc(r.reason)}”</p>` : ''}
      <div class="row">${mine
        ? `<button class="btn small" data-act="rq-cancel" data-id="${esc(r.id)}">Withdraw request</button>`
        : `<button class="btn primary small" data-act="rq-approve" data-id="${esc(r.id)}">Approve</button><button class="btn small" data-act="rq-decline" data-id="${esc(r.id)}">Decline</button>`}</div>
    </div>`;
  }
  return h + '</section>';
}

function decideRequest(id, approve) {
  const r = requests.find(x => x.id === id);
  if (!r || r.status !== 'pending' || r.requestedBy === me.uid) return;
  const batch = writeBatch(fs);
  if (approve) {
    const envChanges = r.changes.filter(c => c.kind !== 'rule'), ruleChanges = r.changes.filter(c => c.kind === 'rule');
    if (envChanges.length) {
      const plan = months[r.month];
      const envs = plan ? plan.envelopes.map(e => ({ ...e })) : [];
      for (const c of envChanges) {
        const e = envs.find(x => x.id === c.envelopeId);
        if (e) e.limit = Math.max(+e.limit || 0, c.to); else envs.push({ id: c.envelopeId, name: c.name, limit: c.to });
      }
      batch.set(doc(fs, 'households', hid, 'months', r.month), { salary: plan ? plan.salary || 0 : 0, envelopes: envs, updatedAt: Date.now(), by: me.uid });
    }
    if (ruleChanges.length) {
      const upd = {}; for (const c of ruleChanges) upd['rules.' + c.key] = c.to;
      batch.update(hhRef(), upd);
    }
  }
  batch.update(doc(fs, 'households', hid, 'requests', id), { status: approve ? 'approved' : 'declined', decidedBy: me.uid, decidedAt: Date.now() });
  batch.commit().catch(x => { console.error(x); toast('Could not save your answer. Try again.'); });
  toast(approve ? 'Approved. The new limits apply now.' : 'Declined. The limits stay as they were.');
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
      const title = x.note || x.payeeName || en;
      const meta = [title !== en ? en : '', x.payeeName && title !== x.payeeName ? x.payeeName : '', x.via === 'upi' ? 'UPI' : '', who ? 'by ' + who : ''].filter(Boolean).map(esc).join(' · ');
      const savingTx = isSave(s.env.find(v => v.id === x.envelopeId));
      h += `<div class="tx"><div class="what"><div class="note">${esc(title)}${savingTx ? ' <span class="pill done">Saving</span>' : ''}${x.override ? ' <span class="pill warn">Override</span>' : ''}</div><div class="meta">${meta}${x.override && x.overrideReason ? '<br>Reason: ' + esc(x.overrideReason) : ''}</div></div>
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
  const avgSaved = data.reduce((a, d) => a + d.saved, 0) / data.length;
  const overMonths = planned.filter(d => d.spent > d.budget).length;
  const overBy = {};
  for (const d of planned) for (const e of d.spendEnv) { const o = (d.byEnv[e.id] || 0) - (+e.limit || 0); if (o > 0) { const n = e.name.trim(); overBy[n] = (overBy[n] || 0) + o; } }
  const worst = Object.entries(overBy).sort((a, b) => b[1] - a[1])[0];
  let h = `<div class="tiles">
    <div class="tile"><div class="label">Avg spent / month</div><div class="v">${fmt(avgSpent)}</div></div>
    <div class="tile"><div class="label">Avg saved &amp; invested</div><div class="v pos">${fmt(avgSaved)}</div></div>
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
        h += `<td class="${!isSave(e) && sp > (+e.limit || 0) ? 'o' : ''}">${fmt(sp)}<small>${fmt(e.limit)}</small></td>`;
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
function closeSheets() { stopScan(); $('#backdrop').hidden = true; for (const id of ['addSheet', 'planSheet', 'acctSheet', 'paySheet', 'confirmSheet', 'fundsSheet']) $('#' + id).hidden = true; }

function openAdd(envId) {
  const s = stats(cur); if (!s.plan) return;
  addEnv = envId || (s.env.some(e => e.id === addEnv) ? addEnv : s.env[0] && s.env[0].id);
  const N = daysIn(cur), t = todayISO(), d = $('#add-date');
  d.min = cur + '-01'; d.max = cur + '-' + pad(N);
  d.value = t.startsWith(cur) ? t : (cur < THIS ? cur + '-' + pad(N) : cur + '-01');
  $('#add-amount').value = ''; $('#add-note').value = ''; $('#add-err').hidden = true;
  // Opened from an envelope tile: show just that envelope. From "+ Log spend": show the list.
  $('#f-add-envs').hidden = !!envId;
  $('#add-pay').hidden = cur !== THIS;
  renderPick(s); openSheet('addSheet'); setTimeout(() => $('#add-amount').focus(), 60);
}
// Each envelope gets one of the logo's colours, by its position in the month's plan.
const ENV_COLORS = ['var(--teal)', 'var(--yellow)', 'var(--green)', 'var(--purple)', 'var(--orange)', 'var(--blue)'];
function envColor(s, e) { const i = s.env.indexOf(e); return ENV_COLORS[(i < 0 ? 0 : i) % ENV_COLORS.length]; }
// One even-sized tile per envelope: name on top, balance below. Tap again to deselect.
function envTiles(s, selected) {
  return s.env.map(e => {
    const left = (+e.limit || 0) - (s.byEnv[e.id] || 0), on = e.id === selected;
    const save = isSave(e);
    const bal = save ? (left > 0 ? fmt(left) + ' to save' : 'Target reached') : (left < 0 ? '−' + fmt(-left) + ' over' : fmt(left) + ' left');
    return `<button type="button" class="envtile${on ? ' on' : ''}${!save && left < 0 ? ' neg' : ''}${save ? ' save' : ''}" style="--c:${envColor(s, e)}" data-pick="${esc(e.id)}" aria-pressed="${on}"><span class="n">${esc(e.name)}</span><span class="b">${bal}</span></button>`;
  }).join('');
}
function renderPick(s) {
  $('#add-envs').innerHTML = envTiles(s, addEnv);
  renderAddSummary();
}
function renderAddSummary() {
  const s = stats(cur), e = s.env.find(x => x.id === addEnv);
  if (!e) { $('#add-env-name').textContent = 'Pick an envelope'; $('#add-spent').textContent = '—'; $('#add-left').textContent = '—'; $('#add-after').hidden = true; return; }
  const lim = +e.limit || 0, sp = s.byEnv[e.id] || 0, left = lim - sp, amt = parseFloat($('#add-amount').value) || 0, save = isSave(e);
  $('#add-env-name').textContent = `${e.name} (${fmt(lim)})`;
  $('#add-spent-l').textContent = save ? 'Saved this month' : 'Already spent';
  $('#add-left-l').textContent = save ? 'Still to save' : 'Left';
  $('#add-amount-l').textContent = save ? 'Amount to save / invest now (₹)' : 'Amount to spend now (₹)';
  $('#add-spent').textContent = fmt(sp);
  const l = $('#add-left'); l.textContent = save ? fmt(Math.max(0, left)) : (left < 0 ? '−' + fmt(-left) : fmt(left)); l.classList.toggle('neg', !save && left < 0);
  const after = left - amt, a = $('#add-after');
  a.hidden = !(amt > 0);
  if (save) {
    a.className = 'after';
    a.textContent = after <= 0 ? `After this: target reached${after < 0 ? ', ' + fmt(-after) + ' extra saved' : ''}` : `After this: ${fmt(after)} still to save`;
  } else {
    a.className = 'after' + (after < 0 ? ' neg' : '');
    a.textContent = after < 0 ? `After this: ${fmt(-after)} over the limit` : `After this: ${fmt(after)} left`;
  }
}
$('#add-envs').addEventListener('click', ev => {
  const b = ev.target.closest('[data-pick]'); if (!b) return;
  const deselect = addEnv === b.dataset.pick;
  addEnv = deselect ? null : b.dataset.pick;
  renderPick(stats(cur));
  if (!deselect) { $('#f-add-envs').hidden = true; setTimeout(() => $('#add-amount').focus(), 60); }
});
$('#add-amount').addEventListener('input', renderAddSummary);
$('#add-change').addEventListener('click', () => { $('#f-add-envs').hidden = !$('#f-add-envs').hidden; });
$('#add-pay').addEventListener('click', () => {
  const amt = parseFloat($('#add-amount').value), err = $('#add-err');
  const e = stats(cur).env.find(x => x.id === addEnv);
  if (!(amt > 0)) { err.textContent = 'Enter the amount to pay.'; err.hidden = false; return; }
  if (!e) { err.textContent = 'Pick an envelope.'; err.hidden = false; return; }
  const preset = { envId: e.id, amount: amt, note: $('#add-note').value.trim() };
  closeSheets(); openPay(preset);
});
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
  if (isSave(e)) { toast(`${fmt(amt)} added to ${e.name}. ${left > 0 ? fmt(left) + ' still to save this month.' : 'Monthly target reached.'}`); return; }
  toast(left >= 0 ? `Saved. ${fmt(left)} left in ${e.name}`
    : partnerIds().length ? `Saved. ${e.name} is over by ${fmt(-left)}. To raise its limit, edit envelopes and ${partnerLabel()} will be asked.`
    : `Saved. ${e.name} is over by ${fmt(-left)}`);
});

function openPlan(mode, fromKey) {
  const base = mode === 'copy' ? months[fromKey] : mode === 'edit' ? months[cur] : null;
  planDraft = { salary: base ? base.salary : '', envelopes: base ? base.envelopes.map(e => ({ ...e })) : DEFAULTS.map(n => ({ id: uid(), name: n, limit: '' })) };
  $('#planTitle').textContent = (mode === 'edit' ? 'Edit ' : 'Set up ') + label(cur) + ' envelopes';
  $('#plan-salary').value = planDraft.salary; $('#plan-err').hidden = true;
  const needsOk = !!months[cur] && partnerIds().length > 0;
  $('#plan-note').hidden = !needsOk; $('#f-reason').hidden = !needsOk; $('#plan-reason').value = '';
  if (needsOk) $('#plan-note').textContent = `Raising a spending limit or adding a spending envelope needs ${partnerLabel()}’s approval. Savings targets, lower limits and the salary apply straight away.`;
  renderPlanRows(); openSheet('planSheet');
}
function renderPlanRows() {
  $('#plan-rows').innerHTML = planDraft.envelopes.map((e, i) => {
    const save = isSave(e);
    return `<div class="prow"><input id="pn-${e.id}" data-i="${i}" data-f="name" type="text" maxlength="40" value="${esc(e.name)}" placeholder="Envelope name" aria-label="Envelope name">
      <input id="pl-${e.id}" data-i="${i}" data-f="limit" type="number" inputmode="decimal" min="0" step="1" value="${esc(e.limit)}" placeholder="${save ? 'Monthly target' : 'Limit'}" aria-label="${save ? 'Monthly target' : 'Limit'}">
      <button type="button" class="typebtn${save ? ' save' : ''}" data-type="${i}" aria-pressed="${save}" title="Switch between spending and saving">${save ? 'Save' : 'Spend'}</button>
      <button type="button" class="rm" data-rm="${i}" aria-label="Remove envelope">×</button></div>`;
  }).join('');
  updateAlloc();
}
function updateAlloc() {
  const sal = +$('#plan-salary').value || 0, sum = list => list.reduce((a, e) => a + (+e.limit || 0), 0);
  const spend = sum(planDraft.envelopes.filter(e => !isSave(e))), save = sum(planDraft.envelopes.filter(isSave)), rem = sal - spend - save;
  $('#plan-alloc').innerHTML = `Spending <b>${fmt(spend)}</b> · Saving <b class="pos">${fmt(save)}</b> of <b>${fmt(sal)}</b> · ${rem >= 0 ? 'Unallocated' : 'Over-allocated by'} <b class="${rem < 0 ? 'neg' : ''}">${fmt(Math.abs(rem))}</b>`;
}
$('#plan-rows').addEventListener('input', ev => { const t = ev.target; if (t.dataset.i == null) return; planDraft.envelopes[+t.dataset.i][t.dataset.f] = t.value; updateAlloc(); });
$('#plan-rows').addEventListener('click', ev => {
  const rm = ev.target.closest('[data-rm]');
  if (rm) { planDraft.envelopes.splice(+rm.dataset.rm, 1); renderPlanRows(); return; }
  const tb = ev.target.closest('[data-type]');
  if (tb) { const e = planDraft.envelopes[+tb.dataset.type]; e.type = isSave(e) ? 'spend' : 'save'; renderPlanRows(); }
});
$('#plan-salary').addEventListener('input', updateAlloc);
$('#plan-addrow').addEventListener('click', () => { const e = { id: uid(), name: '', limit: '' }; planDraft.envelopes.push(e); renderPlanRows(); $('#pn-' + e.id).focus(); });
$('#plan-save').addEventListener('click', () => {
  const fail = m => { const err = $('#plan-err'); err.textContent = m; err.hidden = false; };
  const envs = planDraft.envelopes.map(e => ({ id: e.id, name: String(e.name).trim(), limit: Math.round(+e.limit || 0), type: isSave(e) ? 'save' : 'spend' })).filter(e => e.name || e.limit);
  if (!envs.length) return fail('Add at least one envelope.');
  if (envs.some(e => !e.name)) return fail('Give every envelope a name.');
  const seen = new Set(); for (const e of envs) { const n = e.name.toLowerCase(); if (seen.has(n)) return fail(`“${e.name}” appears twice. Use different names.`); seen.add(n); }
  const salary = Math.round(+$('#plan-salary').value || 0), prev = months[cur];
  const monthRef = doc(fs, 'households', hid, 'months', cur);
  const saveFail = x => { console.error(x); toast('Envelopes could not be saved. Try again.'); };

  // First plan of the month, or nobody to ask: applies at once.
  if (!prev || !partnerIds().length) {
    setDoc(monthRef, { salary, envelopes: envs, updatedAt: Date.now(), by: me.uid }).catch(saveFail);
    closeSheets(); toast('Envelopes saved for ' + label(cur, true)); return;
  }
  // Increases become a request; everything else applies now.
  const prevById = Object.fromEntries(prev.envelopes.map(e => [e.id, e]));
  const changes = [];
  const applied = envs.map(e => {
    const from = prevById[e.id] ? (+prevById[e.id].limit || 0) : 0;
    // Only spending increases need approval; raising a savings target applies at once.
    if (e.limit > from && e.type !== 'save') { changes.push({ envelopeId: e.id, name: e.name, from, to: e.limit }); return { ...e, limit: from }; }
    return e;
  });
  const batch = writeBatch(fs);
  batch.set(monthRef, { salary, envelopes: applied, updatedAt: Date.now(), by: me.uid });
  if (changes.length) batch.set(doc(collection(fs, 'households', hid, 'requests')), {
    month: cur, changes, reason: $('#plan-reason').value.trim(), status: 'pending', requestedBy: me.uid, requestedAt: Date.now()
  });
  batch.commit().catch(saveFail);
  closeSheets();
  toast(changes.length
    ? `Saved. ${changes.length === 1 ? 'The increase is' : changes.length + ' increases are'} waiting for ${partnerLabel()} to approve.`
    : 'Envelopes saved for ' + label(cur, true));
});

/* ---------- household rules ---------- */
const DEFAULT_RULES = { miscThreshold: 500, overridesPerMonth: 2, overrideCap: 5000 };
const rules = () => ({ ...DEFAULT_RULES, ...((household && household.rules) || {}) });
const RULE_NAMES = { overridesPerMonth: 'Emergency overrides per month', overrideCap: 'Largest single override' };
function fmtRule(c, v) { return c.kind === 'rule' && c.key === 'overridesPerMonth' ? String(v) : fmt(v); }
const overridesUsed = k => txns.filter(x => x.month === k && x.override).length;

function fillRules() {
  const r = rules();
  $('#r-misc').value = r.miscThreshold; $('#r-ovr').value = r.overridesPerMonth; $('#r-cap').value = r.overrideCap;
  $('#rulesNote').textContent = partnerIds().length
    ? `Raising the number or size of overrides needs ${partnerLabel()}’s approval. Lowering them applies at once.`
    : 'Overrides let a payment go over an envelope’s limit in an emergency, with a reason.';
  msg($('#rulesMsg'), '');
}
$('#saveRules').addEventListener('click', () => {
  const cur0 = rules(), m = $('#rulesMsg');
  const next = { miscThreshold: Math.round(+$('#r-misc').value), overridesPerMonth: Math.round(+$('#r-ovr').value), overrideCap: Math.round(+$('#r-cap').value) };
  if (!(next.miscThreshold >= 0) || !(next.overridesPerMonth >= 0 && next.overridesPerMonth <= 10) || !(next.overrideCap >= 0)) return msg(m, 'Use whole numbers. Overrides can be 0 to 10 a month.');
  const direct = { 'rules.miscThreshold': next.miscThreshold }, changes = [];
  for (const k of ['overridesPerMonth', 'overrideCap']) {
    if (next[k] > cur0[k] && partnerIds().length) changes.push({ kind: 'rule', key: k, name: RULE_NAMES[k], from: cur0[k], to: next[k] });
    else direct['rules.' + k] = next[k];
  }
  const batch = writeBatch(fs);
  batch.update(hhRef(), direct);
  if (changes.length) batch.set(doc(collection(fs, 'households', hid, 'requests')), { month: THIS, changes, reason: '', status: 'pending', requestedBy: me.uid, requestedAt: Date.now() });
  batch.commit().catch(x => { console.error(x); msg(m, 'Could not save the rules. Try again.'); });
  msg(m, changes.length ? `Saved. The override increase is waiting for ${partnerLabel()} to approve.` : 'Rules saved.', true);
});

/* ---------- Scan & Pay ---------- */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(navigator.userAgent);
const IOS_APPS = [
  { name: 'Google Pay', prefix: 'tez://upi/pay?' },
  { name: 'PhonePe', prefix: 'phonepe://pay?' },
  { name: 'Paytm', prefix: 'paytmmp://upi/pay?' },
];
const PENDING_KEY = 'envelopes.pendingPayment';
let pay = null, scanStream = null, scanTimer = null;

function parseUPI(text) {
  text = String(text || '').trim();
  if (!/^upi:\/\/pay\?/i.test(text)) return null;
  const q = new URLSearchParams(text.slice(text.indexOf('?') + 1));
  const pa = (q.get('pa') || '').trim();
  if (!/^[\w.\-]{2,256}@[\w.\-]{2,64}$/.test(pa)) return null;
  const am = parseFloat(q.get('am') || '');
  return { pa, pn: (q.get('pn') || '').trim(), am: am > 0 ? am : 0, params: q };
}
const payeeKey = pa => pa.toLowerCase().replace(/[^a-z0-9._@-]/g, '_');

let payPreset = null;
function openPay(preset) {
  if (!months[THIS]) { cur = THIS; render(); toast('Set up this month’s envelopes first.'); return; }
  cur = THIS; render();
  payPreset = preset && preset.envId ? preset : null;
  pay = null; $('#pay-vpa').value = ''; $('#pay-pn').value = ''; msg($('#scanMsg'), '');
  const e = payPreset && stats(cur).env.find(x => x.id === payPreset.envId);
  $('#scanTitle').textContent = e ? `Pay ${fmt(payPreset.amount)} from ${e.name}` : 'Scan & Pay';
  showPayStep('scan'); openSheet('paySheet'); startScan();
}
function showPayStep(step) { $('#pay-scan').hidden = step !== 'scan'; $('#pay-details').hidden = step !== 'details'; }

async function startScan() {
  const v = $('#scanVideo'), m = $('#scanMsg');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#scanBox').hidden = true; return msg(m, 'The camera isn’t available here. Upload a photo of the QR, or enter the UPI ID.'); }
  $('#scanBox').hidden = false;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if ($('#paySheet').hidden) { stopScan(); return; }
    v.srcObject = scanStream; await v.play();
    const det = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!scanStream) return;
      if (v.readyState >= 2 && v.videoWidth) {
        let text = null;
        try {
          if (det) { const r = await det.detect(v); if (r[0]) text = r[0].rawValue; }
          else if (window.jsQR) {
            const s = Math.min(1, 640 / v.videoWidth); c.width = v.videoWidth * s; c.height = v.videoHeight * s;
            ctx.drawImage(v, 0, 0, c.width, c.height);
            const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
            if (r) text = r.data;
          }
        } catch { /* keep scanning */ }
        if (text) { const p = parseUPI(text); if (p) { stopScan(); gotPayee(p); return; } msg(m, 'That QR isn’t a UPI payment code.'); }
      }
      scanTimer = setTimeout(tick, 250);
    };
    tick();
  } catch { $('#scanBox').hidden = true; msg(m, 'Camera access was refused. Upload a photo of the QR, or enter the UPI ID.'); }
}
function stopScan() { clearTimeout(scanTimer); if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } }

$('#qrFile').addEventListener('change', async ev => {
  const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (!f) return;
  const m = $('#scanMsg');
  try {
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = bmp.width * s; c.height = bmp.height * s;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    let text = null;
    if ('BarcodeDetector' in window) { const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(c); if (r[0]) text = r[0].rawValue; }
    if (!text && window.jsQR) { const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height); if (r) text = r.data; }
    const p = text && parseUPI(text);
    if (p) { stopScan(); gotPayee(p); } else msg(m, text ? 'That QR isn’t a UPI payment code.' : 'No QR code found in that photo. Try a closer, sharper photo.');
  } catch { msg(m, 'Couldn’t read that photo. Try another one.'); }
});
$('#pay-manual').addEventListener('click', () => {
  const pa = $('#pay-vpa').value.trim(), pn = $('#pay-pn').value.trim();
  const p = parseUPI('upi://pay?pa=' + encodeURIComponent(pa) + (pn ? '&pn=' + encodeURIComponent(pn) : ''));
  if (!p) return msg($('#scanMsg'), 'Enter a UPI ID like name@okhdfcbank.');
  stopScan(); gotPayee(p);
});

function gotPayee(p) {
  pay = { ...p, fixedAmount: p.am > 0, envId: null, picked: false, showList: false };
  $('#payTo').textContent = p.pn || p.pa;
  $('#payVpa').textContent = p.pn ? p.pa : '';
  const a = $('#pay-amount'); a.value = p.am || ''; a.readOnly = pay.fixedAmount;
  $('#pay-note').value = ''; $('#pay-reason').value = '';
  if (payPreset) {
    // Came from an envelope: keep that envelope, and the amount unless the QR fixes its own.
    pay.envId = payPreset.envId; pay.picked = true;
    if (!pay.fixedAmount) a.value = payPreset.amount;
    $('#pay-note').value = payPreset.note || '';
    if (pay.fixedAmount && Math.abs(p.am - payPreset.amount) > 0.009) toast(`This QR asks for ${fmt(p.am)}, not ${fmt(payPreset.amount)}.`);
  }
  showPayStep('details'); renderPay();
  if (!pay.fixedAmount) setTimeout(() => a.focus(), 60);
}

function autoEnvelope(amt) {
  const s = stats(cur), r = rules();
  const misc = s.env.find(e => /^misc/i.test(e.name.trim()));
  if (amt > 0 && amt < r.miscThreshold && misc) return { id: misc.id, why: `Under ${fmt(r.miscThreshold)}, so it goes to ${misc.name}.` };
  const mem = payees[payeeKey(pay.pa)];
  if (mem && s.env.some(e => e.id === mem.envelopeId)) return { id: mem.envelopeId, why: `Used for ${pay.pn || pay.pa} last time.` };
  return null;
}

function renderPay() {
  if (!pay) return;
  const s = stats(cur), r = rules(), amt = parseFloat($('#pay-amount').value) || 0;
  let why = '';
  if (!pay.picked) { const a = autoEnvelope(amt); pay.envId = a ? a.id : null; why = a ? a.why : ''; }
  // With an envelope chosen, collapse the list to one line; "Change" (or no choice) shows the tiles.
  const chosen = s.env.find(x => x.id === pay.envId), showList = !chosen || pay.showList;
  $('#pay-chosen').hidden = !chosen || pay.showList;
  $('#pay-pickhint').hidden = !!chosen;
  $('#pay-envs').hidden = !showList;
  if (chosen) {
    const left = (+chosen.limit || 0) - (s.byEnv[chosen.id] || 0);
    $('#pay-chosen-name').textContent = chosen.name;
    $('#pay-chosen').style.setProperty('--c', envColor(s, chosen));
    const l = $('#pay-chosen-left');
    if (isSave(chosen)) { l.textContent = left > 0 ? `${fmt(left)} still to save` : 'Monthly target reached'; l.classList.remove('neg'); }
    else { l.textContent = left < 0 ? `${fmt(-left)} over` : `${fmt(left)} left`; l.classList.toggle('neg', left < 0); }
    $('#pay-why').textContent = pay.picked ? '' : why;
  }
  if (showList) $('#pay-envs').innerHTML = envTiles(s, pay.envId);

  const e = s.env.find(x => x.id === pay.envId), warn = $('#pay-warn');
  pay.needOverride = false; pay.blocked = false; warn.hidden = true; $('#f-pay-reason').hidden = true; $('#pay-raise').hidden = true;
  if (e && amt > 0 && !isSave(e)) { // paying more into savings is never "overspending"
    const left = (+e.limit || 0) - (s.byEnv[e.id] || 0), over = amt - Math.max(left, 0);
    if (over > 0) {
      const remain = Math.max(0, r.overridesPerMonth - overridesUsed(cur));
      warn.hidden = false;
      if (remain > 0 && over <= r.overrideCap) {
        pay.needOverride = true;
        warn.innerHTML = `This takes <b>${esc(e.name)}</b> over its limit by <b>${fmt(over)}</b>. You can use an emergency override: ${remain} of ${r.overridesPerMonth} left this month${partnerIds().length ? ', and ' + esc(partnerLabel()) + ' will see the reason' : ''}.`;
        $('#f-pay-reason').hidden = false;
      } else {
        pay.blocked = true;
        warn.innerHTML = `This takes <b>${esc(e.name)}</b> over its limit by <b>${fmt(over)}</b>. ${remain ? `That’s more than the ${fmt(r.overrideCap)} override limit.` : 'No emergency overrides are left this month.'} Pick another envelope, or ${partnerIds().length ? 'ask ' + esc(partnerLabel()) + ' to raise the limit' : 'raise the limit'} first.`;
        $('#pay-raise').hidden = false;
      }
    }
  }
  const reasonOk = !pay.needOverride || $('#pay-reason').value.trim().length > 0;
  const ready = amt > 0 && !!e && !pay.blocked && reasonOk;
  renderPayApps(ready, amt);
}

function upiQuery(amt) {
  const q = new URLSearchParams(pay.params.toString());
  q.set('pa', pay.pa); if (pay.pn) q.set('pn', pay.pn);
  if (!pay.fixedAmount) q.set('am', amt.toFixed(2));
  q.set('cu', 'INR');
  // Privacy: the user's own note stays in SpendWise. Only what the payee's QR already carried
  // (payee, amount, the merchant's own reference) is passed to the UPI app.
  return [...q].map(([k, v]) => k + '=' + encodeURIComponent(v).replace(/%40/g, '@')).join('&');
}

function renderPayApps(ready, amt) {
  const box = $('#pay-apps'); let h = '';
  if (isAndroid) h = `<button class="btn primary" data-app="upi" ${ready ? '' : 'disabled'}>Pay ${amt > 0 ? fmt(amt) : ''} with a UPI app</button><p class="quiet">Your phone will list the UPI apps you have installed.</p>`;
  else if (isIOS) h = `<p class="quiet">Pay ${amt > 0 ? fmt(amt) : ''} with:</p><div class="row">${IOS_APPS.map((a, i) => `<button class="btn ${i ? '' : 'primary'}" data-app="ios-${i}" ${ready ? '' : 'disabled'}>${a.name}</button>`).join('')}</div><p class="quiet">If nothing opens, that app isn’t installed. Try another.</p>`;
  else h = `<p class="quiet">Open this app on your phone to pay through a UPI app. On a computer you can still log the payment after paying another way.</p>`;
  h += `<button class="link" data-app="other" ${ready ? '' : 'disabled'}>I paid another way, just log it</button>`;
  box.innerHTML = h;
}

$('#pay-envs').addEventListener('click', ev => {
  const b = ev.target.closest('[data-pick]'); if (!b) return;
  const deselect = pay.envId === b.dataset.pick; // tap the selected one again to deselect
  pay.envId = deselect ? null : b.dataset.pick;
  pay.picked = true; pay.showList = deselect; renderPay();
  if (!deselect) revealActions('#pay-actions');
});
$('#pay-change').addEventListener('click', () => { pay.showList = true; renderPay(); });
// Bring the pay buttons into view after choosing, without the user hunting for them.
function revealActions(sel) { setTimeout(() => { const el = $(sel); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, 50); }
$('#pay-amount').addEventListener('input', renderPay);
$('#pay-reason').addEventListener('input', renderPay);
$('#pay-back').addEventListener('click', () => { pay = null; showPayStep('scan'); startScan(); });
$('#pay-raise').addEventListener('click', () => { closeSheets(); openPlan('edit'); });
$('#pay-apps').addEventListener('click', ev => {
  const b = ev.target.closest('[data-app]'); if (!b || b.disabled) return;
  const s = stats(cur), e = s.env.find(x => x.id === pay.envId), amt = parseFloat($('#pay-amount').value) || 0;
  if (!e || !(amt > 0)) return;
  const pending = {
    hid, month: cur, date: todayISO(), amount: Math.round(amt * 100) / 100, envelopeId: e.id, envelopeName: e.name,
    note: $('#pay-note').value.trim(), payeeVpa: pay.pa, payeeName: pay.pn || pay.pa,
    override: !!pay.needOverride, overrideReason: pay.needOverride ? $('#pay-reason').value.trim() : '', at: Date.now(),
  };
  if (b.dataset.app === 'other') { logPayment(pending); closeSheets(); return; }
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch { /* confirm sheet still shows below */ }
  const qs = upiQuery(amt);
  const url = b.dataset.app === 'upi' ? 'upi://pay?' + qs : IOS_APPS[+b.dataset.app.split('-')[1]].prefix + qs;
  showConfirm(pending);
  window.location.href = url;
});

function readPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } }
function clearPending() { try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } }
function checkPending() {
  const p = readPending();
  if (!p || !hid || p.hid !== hid || !$('#confirmSheet').hidden) return;
  if (Date.now() - p.at > 6 * 3600e3) { clearPending(); return; }
  showConfirm(p);
}
function showConfirm(p) {
  stopScan(); for (const id of ['addSheet', 'planSheet', 'acctSheet', 'paySheet']) $('#' + id).hidden = true;
  $('#confirmText').textContent = `Did your ${fmt(p.amount)} payment to ${p.payeeName} go through?`;
  $('#confirmSub').textContent = `It will be logged under ${p.envelopeName}${p.override ? ' as an emergency override' : ''}.`;
  $('#confirmSheet').dataset.p = JSON.stringify(p);
  $('#backdrop').hidden = false; $('#confirmSheet').hidden = false;
}
$('#confirmYes').addEventListener('click', () => { const p = JSON.parse($('#confirmSheet').dataset.p || 'null'); clearPending(); closeSheets(); if (p) logPayment(p); });
$('#confirmNo').addEventListener('click', () => { clearPending(); closeSheets(); toast('Nothing logged.'); });

function logPayment(p) {
  setDoc(doc(collection(fs, 'households', hid, 'txns')), {
    month: p.month, envelopeId: p.envelopeId, envelopeName: p.envelopeName, amount: p.amount, note: p.note, date: p.date,
    payeeName: p.payeeName, payeeVpa: p.payeeVpa, via: 'upi', override: p.override, overrideReason: p.overrideReason, by: me.uid, at: Date.now(),
  }).catch(x => { console.error(x); toast('That payment could not be logged. Add it with “Log spend”.'); });
  if (p.payeeVpa) setDoc(doc(fs, 'households', hid, 'payees', payeeKey(p.payeeVpa)), { vpa: p.payeeVpa, name: p.payeeName, envelopeId: p.envelopeId, at: Date.now() }).catch(() => {});
  const s = stats(p.month), e = s.env.find(x => x.id === p.envelopeId);
  const left = e ? (+e.limit || 0) - ((s.byEnv[e.id] || 0) + p.amount) : 0;
  toast(p.override ? `Logged as an emergency override on ${p.envelopeName}.` : `Logged. ${fmt(left)} left in ${p.envelopeName}.`);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(checkPending, 300); });

/* ---------- savings opening balances ---------- */
// One-time amounts already saved before using the app (e.g. chit instalments paid so far).
function openFunds() {
  const s = stats(cur);
  $('#funds-rows').innerHTML = s.saveEnv.map(e => {
    const ft = fundTotal(e);
    return `<div class="field"><label for="fo-${esc(e.id)}">${esc(e.name)}: saved before using SpendWise (₹)</label>
      <input id="fo-${esc(e.id)}" data-fund="${esc(e.id)}" data-name="${esc(e.name)}" type="number" inputmode="decimal" min="0" step="1" value="${ft.opening || ''}" placeholder="0">
      <small class="quiet">Paid through the app so far: ${fmt(ft.contributed)}</small></div>`;
  }).join('') || '<p class="quiet">No savings envelopes this month. Mark one as Save in “Edit salary &amp; envelopes” first.</p>';
  msg($('#funds-msg'), ''); openSheet('fundsSheet');
}
$('#funds-save').addEventListener('click', () => {
  const upd = {};
  for (const i of document.querySelectorAll('#funds-rows [data-fund]')) {
    const v = Math.round(+i.value || 0);
    if (v < 0) return msg($('#funds-msg'), 'Amounts can’t be negative.');
    upd['funds.' + i.dataset.fund] = { opening: v, name: i.dataset.name, updatedAt: Date.now(), by: me.uid };
  }
  if (!Object.keys(upd).length) { closeSheets(); return; }
  updateDoc(hhRef(), upd).catch(x => { console.error(x); toast('Opening balances could not be saved. Try again.'); });
  closeSheets(); toast('Opening balances saved');
});

/* ---------- account ---------- */
$('#acctBtn').addEventListener('click', () => {
  $('#acctWho').textContent = myName() + ' · ' + (me.email || '');
  const names = household && household.memberNames ? Object.entries(household.memberNames).map(([u, n]) => n + (u === me.uid ? ' (you)' : '')) : [];
  $('#acctMembers').textContent = names.length > 1 ? names.join(', ') : (names[0] || '') + ' — waiting for your partner to join';
  $('#acctCode').textContent = (household && household.inviteCode) || '—';
  msg($('#acctMsg'), ''); fillRules(); openSheet('acctSheet');
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
  else if (a === 'funds') openFunds();
  else if (a === 'filter') { filterEnv = b.dataset.env; render(); }
  else if (a === 'rq-approve') decideRequest(b.dataset.id, true);
  else if (a === 'rq-decline') decideRequest(b.dataset.id, false);
  else if (a === 'rq-cancel') { deleteDoc(doc(fs, 'households', hid, 'requests', b.dataset.id)).catch(() => toast('Could not withdraw. Try again.')); toast('Request withdrawn'); }
  else if (a === 'del') {
    const id = b.dataset.id;
    if (armed !== id) { armed = id; clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; render(); }, 3500); render(); return; }
    armed = null; clearTimeout(armTimer);
    deleteDoc(doc(fs, 'households', hid, 'txns', id)).catch(() => toast('Could not delete. Try again.'));
    toast('Spend deleted');
  }
});
$('#fab').addEventListener('click', () => openAdd());
$('#fabPay').addEventListener('click', () => openPay());
$('#backdrop').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
$('#prev').addEventListener('click', () => { cur = shiftKey(cur, -1); filterEnv = 'all'; render(); });
$('#next').addEventListener('click', () => { cur = shiftKey(cur, 1); filterEnv = 'all'; render(); });
$('#mlabel').addEventListener('click', () => { cur = THIS; filterEnv = 'all'; render(); });
$('#tab-month').addEventListener('click', () => { view = 'month'; render(); });
$('#tab-trends').addEventListener('click', () => { view = 'trends'; render(); });
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (view === 'trends') render(); }, 150); });

/* ---------- install prompt ---------- */
(() => {
  const KEY = 'envelopes.installDismissed';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let dismissed = false; try { dismissed = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
  if (standalone || dismissed) return;
  const bar = $('#installBar'), btn = $('#installBtn'), text = $('#installText');
  let deferred = null;
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferred = e;
    text.textContent = 'Install SpendWise on your home screen to use it like an app.';
    btn.hidden = false; bar.hidden = false;
  });
  if (isIOS) {
    text.textContent = 'To use SpendWise like an app: in Safari, tap the Share button, then “Add to Home Screen”.';
    bar.hidden = false;
  }
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    deferred = null; bar.hidden = true;
  });
  addEventListener('appinstalled', () => { bar.hidden = true; });
  $('#installClose').addEventListener('click', () => { bar.hidden = true; try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } });
})();

updateOnline();
if ('serviceWorker' in navigator) {
  // Reload once when a new version takes over, so updates appear without reopening twice.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    const busy = ['addSheet', 'planSheet', 'paySheet', 'confirmSheet'].some(id => !$('#' + id).hidden);
    if (busy) return;
    reloaded = true; location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => { document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }); })
    .catch(() => {});
}
