/* ==========================================================================
   iCHANCE — لوحة الكاشير
   --------------------------------------------------------------------------
   كل صلاحية هنا يتحقّق منها الخادم من جديد: ملكية اللاعب، كفاية العهدة،
   كفاية رصيد اللاعب. ما في هذا الملف هو عرض وراحة استعمال لا أكثر.

   الأقسام: تعبئة وسحب (جدول كل لاعبيه) · حساب جديد · الكشف · الملخّص.
   القسم المفتوح في عنوان الصفحة (#new …) فيعمل زرّ الرجوع في الهاتف بينها.
   ========================================================================== */
'use strict';

const el = (id) => document.getElementById(id);
// اسم مختلف عمداً: common.js يعرّف CASHIER_TOKEN_KEY في النطاق العام نفسه،
// وتكرار const هناك يُفشل تحميل هذا الملف بأكمله فلا يُربط أي زر.
const CASHIER_TOKEN_KEY = 'ichance.cashierToken';

let token = null;
let me = null;
let players = [];
let txs = [];
let txPlayer = null;      // فلتر كشف الحركة
let action = null;        // الإجراء المفتوح في النافذة
let sheetPlayer = null;   // اللاعب المفتوحة قائمة إدارته
let lastCreated = null;   // آخر حساب أُنشئ — لعرض بياناته مرّة واحدة
let flashId = null;       // صفّ يُبرز بعد عملية عليه

// يُبرز صفّ اللاعب مرّة بعد عملية عليه، ثم لا يعود الإبراز مع كل تحديث
function flash(id) {
  flashId = id;
  setTimeout(() => { if (flashId === id) flashId = null; }, 2500);
}

/* ------------------------------- الاتصال ------------------------------- */
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Cashier-Token'] = token;
  let res;
  try {
    res = await fetch(path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw new Error('تعذّر الاتصال بالخادم'); }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `خطأ ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------- الأدوات ------------------------------- */
function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  // بلا السنة إن كانت الحالية — التاريخ الكامل لا يتّسع في بطاقة الهاتف
  const sameYear = d.getFullYear() === today.getFullYear();
  const date = d.toLocaleDateString('en-GB', sameYear
    ? { day: '2-digit', month: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${date} ${time}`;
}

const KIND = {
  deposit: { label: 'تعبئة', cls: 'tag-in', sign: '+' },
  withdraw: { label: 'سحب', cls: 'tag-out', sign: '−' },
  cashier_topup: { label: 'عهدة واردة', cls: 'tag-in', sign: '+' },
  cashier_debit: { label: 'عهدة مسحوبة', cls: 'tag-out', sign: '−' }
};

const byId = (id) => players.find((p) => p.id === id) || null;

/* -------------------------------- الأقسام -------------------------------- */
const TABS = ['transfer', 'new', 'tx', 'summary'];

function currentTab() {
  const h = location.hash.slice(1);
  return TABS.includes(h) ? h : 'transfer';
}

function paintTab() {
  const name = currentTab();
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function goTab(name) {
  if (currentTab() === name && location.hash) return paintTab();
  location.hash = name;   // hashchange يرسم القسم
}

el('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  goTab(b.dataset.tab);
  window.scrollTo(0, 0);
});
window.addEventListener('hashchange', paintTab);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) goTab(b.dataset.goto);
});

/* -------------------------------- البوابة -------------------------------- */
function showGate(message) {
  el('gate').hidden = false;
  el('panel').hidden = true;
  const box = el('gateError');
  if (message) { box.hidden = false; box.textContent = message; }
  else box.hidden = true;
}

function showPanel() {
  el('gate').hidden = true;
  el('panel').hidden = false;
  paintTab();
}

el('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('gateBtn').disabled = true;
  try {
    const out = await api('POST', '/api/cashier/login', {
      identifier: el('cuser').value.trim(),
      password: el('cpass').value.trim()
    });
    token = out.token;
    try { localStorage.setItem(CASHIER_TOKEN_KEY, token); } catch { /* تصفح خاص */ }
    el('cpass').value = '';
    showPanel();
    await refresh();
  } catch (err) {
    showGate(err.message);
  } finally {
    el('gateBtn').disabled = false;
  }
});

el('logoutBtn').addEventListener('click', () => {
  token = null;
  try { localStorage.removeItem(CASHIER_TOKEN_KEY); } catch { /* تجاهل */ }
  players = []; txs = []; me = null; lastCreated = null;
  el('newOut').hidden = true;
  el('newOut').innerHTML = '';
  showGate();
});

/* -------------------------------- التحميل -------------------------------- */
async function refresh() {
  const [overview, txData] = await Promise.all([
    api('GET', '/api/cashier/overview'),
    api('GET', `/api/cashier/transactions?limit=150${txPlayer ? `&player=${encodeURIComponent(txPlayer)}` : ''}`)
  ]);
  me = overview.cashier;
  players = overview.players || [];
  txs = txData.transactions || [];
  paintAll();
}

function paintAll() {
  paintHeader();
  paintKpis();
  paintPlayers();
  paintTx();
}

function paintHeader() {
  if (!me) return;
  el('whoName').textContent = me.username;
  el('floatAmount').textContent = me.unlimited_float ? 'مفتوحة' : fmt(me.float_balance);
  el('floatBox').classList.toggle('is-unlimited', !!me.unlimited_float);
}

function paintKpis() {
  if (!me) return;
  const cards = [
    { label: 'عهدتي', value: me.unlimited_float ? '∞' : fmt(me.float_balance),
      hint: me.unlimited_float ? 'عهدة مفتوحة من الإدارة' : 'ما تبقّى لك للتعبئة' },
    { label: 'لاعبيّ', value: fmt(me.player_count), hint: 'حسابات أنشأتها' },
    { label: 'مجموع أرصدتهم', value: fmt(me.players_balance), hint: 'ما في محافظ لاعبيك الآن' },
    { label: 'عبّأت', value: fmt(me.total_deposited), hint: 'إجمالي ما سلّمته' },
    { label: 'سحبت', value: fmt(me.total_withdrawn), hint: 'إجمالي ما استرجعته' },
    { label: 'صافي بذمّتي', value: fmtSigned(me.net_out), hint: 'عبّأت ناقص سحبت — رقم المحاسبة' }
  ];
  el('kpis').innerHTML = cards.map((c) => `
    <div class="kpi">
      <span class="kpi__label">${c.label}</span>
      <b class="kpi__value">${c.value}</b>
      <span class="kpi__hint">${c.hint}</span>
    </div>`).join('');
}

function visiblePlayers() {
  const q = el('search').value.trim().toLowerCase();
  if (!q) return players;
  return players.filter((p) =>
    (p.username || '').toLowerCase().includes(q)
    || (p.email || '').toLowerCase().includes(q)
    || (p.display_id || '').toLowerCase().includes(q));
}

// على الهاتف يصير كل صفّ بطاقة، وdata-label عنوان كل خانة فيها
function paintPlayers() {
  const list = visiblePlayers();
  el('playersCount').textContent = players.length ? `(${fmt(players.length)})` : '';
  el('playersEmpty').hidden = list.length > 0;
  el('playersEmptyText').textContent = players.length
    ? 'لا نتائج لهذا البحث.'
    : 'لا لاعبين بعد — كل حساب تنشئه يظهر هنا.';
  el('emptyNewBtn').hidden = players.length > 0;

  el('playersBody').innerHTML = list.map((p) => `
    <tr class="${p.active ? '' : 'is-off'}${p.id === flashId ? ' is-flash' : ''}" data-id="${escapeHtml(p.id)}">
      <td class="c-player">
        <span class="player-cell${p.active ? '' : ' is-off'}">
          <b>${escapeHtml(p.username)}${p.active ? '' : ' <em class="off-tag">موقوف</em>'}</b>
          ${p.email ? `<span>${escapeHtml(p.email)}</span>` : ''}
        </span>
      </td>
      <td class="c-id mono" data-label="المعرّف">${escapeHtml(p.display_id)}</td>
      <td class="c-bal" data-label="الرصيد"><b>${fmt(p.balance)}</b></td>
      <td class="c-in tag-in" data-label="عُبّئ له">${fmt(p.total_deposited)}</td>
      <td class="c-out tag-out" data-label="سُحب منه">${fmt(p.total_withdrawn)}</td>
      <td class="c-last dim" data-label="آخر دخول">${when(p.last_login_at)}</td>
      <td class="c-act">
        <span class="rowbtns">
          <button type="button" class="b-in"  data-do="deposit"  data-id="${escapeHtml(p.id)}">تعبئة</button>
          <button type="button" class="b-out" data-do="withdraw" data-id="${escapeHtml(p.id)}">سحب</button>
          <button type="button" class="b-more" data-do="more" data-id="${escapeHtml(p.id)}"
                  aria-label="إدارة حساب ${escapeHtml(p.username)}" title="إدارة الحساب">⋯</button>
        </span>
      </td>
    </tr>`).join('');
}

function paintTx() {
  el('txEmpty').hidden = txs.length > 0;
  el('txHint').textContent = txs.length ? `آخر ${txs.length} حركة` : '';
  el('txFilter').hidden = !txPlayer;

  el('txBody').innerHTML = txs.map((t) => {
    const k = KIND[t.kind] || { label: t.kind, cls: '', sign: '' };
    return `
      <tr>
        <td class="c-time dim">${when(t.created_at)}</td>
        <td class="c-who">${escapeHtml(t.player_username || '—')}</td>
        <td class="c-kind ${k.cls}">${k.label}</td>
        <td class="c-amt ${k.cls}"><b>${k.sign}${fmt(t.amount)}</b></td>
        <td class="c-after" data-label="رصيده بعدها">${fmt(t.player_balance_after)}</td>
        <td class="c-note dim">${escapeHtml(t.note || '—')}</td>
      </tr>`;
  }).join('');
}

/* ----------------------------- إنشاء لاعب ----------------------------- */
el('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('newBtn').disabled = true;
  const out = el('newOut');
  out.hidden = true;

  const username = el('nUser').value.trim();
  const email = el('nEmail').value.trim();
  const password = el('nPass').value;

  try {
    const r = await api('POST', '/api/cashier/player', { username, email, password });
    // نعرض البيانات مرة واحدة ليسلّمها الكاشير للاعب — كلمة المرور
    // لا تُخزَّن نصّاً في أي مكان ولن تُعرض ثانية
    lastCreated = { id: r.player.id, username: r.player.username, email: r.player.email,
                    display_id: r.player.display_id, password };
    el('newForm').reset();
    flash(r.player.id);
    await refresh();
    paintCreated();
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    out.hidden = false;
    out.classList.add('is-error');
    out.innerHTML = `<b>تعذّر الإنشاء:</b> ${escapeHtml(err.message)}`;
  } finally {
    el('newBtn').disabled = false;
  }
});

function paintCreated() {
  const c = lastCreated;
  const out = el('newOut');
  if (!c) { out.hidden = true; return; }
  out.classList.remove('is-error');
  out.hidden = false;
  out.innerHTML = `
    <b>✓ تمّ إنشاء الحساب.</b> سلّم اللاعب هذه البيانات — كلمة المرور لن تظهر مرة أخرى:
    <dl class="creds">
      <dt>المستخدم</dt><dd><code>${escapeHtml(c.username)}</code></dd>
      <dt>الإيميل</dt><dd><code>${escapeHtml(c.email)}</code></dd>
      <dt>كلمة المرور</dt><dd><code>${escapeHtml(c.password)}</code></dd>
      <dt>المعرّف</dt><dd><code>${escapeHtml(c.display_id)}</code></dd>
    </dl>
    <div class="newplayer__acts">
      <button type="button" class="btn btn--gold" data-act="fund">💸 تعبئة رصيد له الآن</button>
      <button type="button" class="btn btn--dark" data-act="copy">📋 نسخ البيانات</button>
    </div>`;
}

el('newOut').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !lastCreated) return;
  if (b.dataset.act === 'fund') {
    const p = byId(lastCreated.id);
    if (!p) { toast('حدّث الصفحة ثم حاول', 'error'); return; }
    openModal('deposit', p, { then: 'transfer' });
    return;
  }
  if (b.dataset.act === 'copy') {
    const c = lastCreated;
    const text = `المستخدم: ${c.username}\nالإيميل: ${c.email}\nكلمة المرور: ${c.password}\nالمعرّف: ${c.display_id}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('نُسخت البيانات');
    } catch {
      toast('تعذّر النسخ — انسخها يدوياً', 'error');
    }
  }
});

/* ------------------------------ نافذة الإجراء ------------------------------ */
const QUICK = [1000, 5000, 10000, 25000, 50000, 100000];

function openModal(kind, player, opts = {}) {
  closeSheet();
  action = { kind, player, then: opts.then || null };
  const titles = {
    deposit: 'تعبئة رصيد',
    withdraw: 'سحب رصيد',
    password: 'تغيير كلمة المرور',
    rename: 'تعديل بيانات اللاعب'
  };
  el('modalTitle').textContent = titles[kind];
  el('modalWho').textContent = `${player.username} · ${player.display_id} · رصيده ${fmt(player.balance)}`;
  el('modalForm').dataset.kind = kind;

  const isMoney = kind === 'deposit' || kind === 'withdraw';
  const isPass = kind === 'password';
  const isRename = kind === 'rename';
  el('amountField').hidden = !isMoney;
  el('noteField').hidden = !isMoney;
  el('passField').hidden = !isPass;
  el('nameField').hidden = !isRename;
  el('nameEmail').value = isRename ? (player.email || '') : '';
  el('modalName').value = isRename ? player.username : '';
  el('modalAmount').value = '';
  el('modalPass').value = '';
  el('modalNote').value = '';
  el('modalErr').hidden = true;

  // ما يحدّ المبلغ: عهدة الكاشير عند التعبئة، ورصيد اللاعب عند السحب
  const ctx = el('modalCtx');
  ctx.hidden = !isMoney;
  if (kind === 'deposit' && me) {
    ctx.textContent = me.unlimited_float ? 'عهدتك مفتوحة' : `عهدتك المتاحة: ${fmt(me.float_balance)}`;
  } else if (kind === 'withdraw') {
    ctx.textContent = `المتاح للسحب من رصيده: ${fmt(player.balance)}`;
  }

  el('modalOk').textContent = kind === 'deposit' ? 'تأكيد التعبئة'
    : kind === 'withdraw' ? 'تأكيد السحب' : 'حفظ';

  el('quickAmounts').innerHTML = !isMoney ? '' : [
    ...QUICK.map((q) => `<button type="button" data-q="${q}">+${fmt(q)}</button>`),
    kind === 'withdraw' && player.balance > 0
      ? `<button type="button" data-all="1">كل رصيده</button>` : '',
    `<button type="button" data-clear="1" aria-label="مسح المبلغ">مسح</button>`
  ].join('');

  el('modal').hidden = false;
  document.body.classList.add('has-modal');
  const focusEl = isPass ? el('modalPass') : isRename ? el('modalName') : el('modalAmount');
  setTimeout(() => focusEl.focus(), 30);
}

function closeModal() {
  el('modal').hidden = true;
  action = null;
  if (el('sheet').hidden) document.body.classList.remove('has-modal');
}

el('modalCancel').addEventListener('click', closeModal);
el('modal').addEventListener('click', (e) => { if (e.target === el('modal')) closeModal(); });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el('modal').hidden) closeModal();
  else if (!el('sheet').hidden) closeSheet();
});

el('quickAmounts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.clear) { el('modalAmount').value = ''; return; }
  if (b.dataset.all && action) { el('modalAmount').value = Math.floor(action.player.balance); return; }
  const cur = Number(el('modalAmount').value) || 0;
  el('modalAmount').value = cur + Number(b.dataset.q);
});

el('modalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!action) return;
  const errBox = el('modalErr');
  errBox.hidden = true;
  el('modalOk').disabled = true;
  const done = action;

  try {
    if (done.kind === 'rename') {
      await api('POST', '/api/cashier/player/update', {
        playerId: done.player.id,
        username: el('modalName').value.trim(),
        email: el('nameEmail').value.trim()
      });
      toast('حُفظ التعديل');
    } else if (done.kind === 'password') {
      const pw = el('modalPass').value;
      await api('POST', '/api/cashier/password', { playerId: done.player.id, password: pw });
      toast(`تغيّرت كلمة مرور ${done.player.username} — سلّمها له`, 'win', 6000);
    } else {
      const amount = Number(el('modalAmount').value);
      const out = await api('POST', `/api/cashier/${done.kind}`, {
        playerId: done.player.id,
        amount,
        note: el('modalNote').value.trim() || null
      });
      const verb = done.kind === 'deposit' ? `عُبّئ ${fmt(amount)} لـ` : `سُحب ${fmt(amount)} من`;
      toast(`${verb} ${done.player.username} — رصيده الآن ${fmt(out.player_balance)}`, 'win');
    }
    closeModal();
    flash(done.player.id);
    await refresh();
    if (done.then) goTab(done.then);
  } catch (err) {
    errBox.hidden = false;
    errBox.textContent = err.message;
  } finally {
    el('modalOk').disabled = false;
  }
});

/* ------------------------------ قائمة الإدارة (⋯) ------------------------------ */
function openSheet(player) {
  sheetPlayer = player;
  el('sheetTitle').textContent = player.username;
  el('sheetWho').textContent = `${player.display_id} · رصيده ${fmt(player.balance)}${player.active ? '' : ' · موقوف'}`;
  el('sheetToggle').innerHTML = player.active
    ? '<span aria-hidden="true">⏸</span> إيقاف الحساب'
    : '<span aria-hidden="true">▶</span> تفعيل الحساب';
  el('sheet').hidden = false;
  document.body.classList.add('has-modal');
}

function closeSheet() {
  el('sheet').hidden = true;
  sheetPlayer = null;
  if (el('modal').hidden) document.body.classList.remove('has-modal');
}

el('sheetClose').addEventListener('click', closeSheet);
el('sheet').addEventListener('click', (e) => { if (e.target === el('sheet')) closeSheet(); });

el('sheetList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-do]');
  if (!b || !sheetPlayer) return;
  const player = sheetPlayer;
  closeSheet();
  managePlayer(b.dataset.do, player);
});

/* ------------------------------ أزرار الصفوف ------------------------------ */
el('playersBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-do]');
  if (!b) return;
  const player = byId(b.dataset.id);
  if (!player) return;
  if (b.dataset.do === 'more') return openSheet(player);
  managePlayer(b.dataset.do, player);
});

async function managePlayer(what, player) {
  if (what === 'delete') {
    if (!confirm(`حذف ${player.username} نهائياً؟\nلا يُحذف إن كان له رصيد أو حركات مالية — أوقفه بدل ذلك.`)) return;
    try {
      await api('POST', '/api/cashier/player/delete', { playerId: player.id });
      toast('حُذف اللاعب');
      await refresh();
    } catch (err) { toast(err.message, 'error', 6000); }
    return;
  }

  if (what === 'deposit' || what === 'withdraw' || what === 'password' || what === 'rename') {
    if (!player.active && what !== 'password') {
      toast('الحساب موقوف — فعّله أولاً من ⋯', 'error');
      return;
    }
    openModal(what, player);
    return;
  }

  if (what === 'tx') {
    txPlayer = player.id;
    el('txPlayerName').textContent = player.username;
    try { await refresh(); } catch (err) { toast(err.message, 'error'); }
    goTab('tx');
    window.scrollTo(0, 0);
    return;
  }

  if (what === 'toggle') {
    const next = !player.active;
    if (!confirm(next ? `تفعيل حساب ${player.username}؟` : `إيقاف حساب ${player.username}؟ سيخرج فوراً.`)) return;
    try {
      await api('POST', '/api/cashier/toggle', { playerId: player.id, active: next });
      toast(next ? 'فُعّل الحساب' : 'أُوقف الحساب');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }
}

el('txClear').addEventListener('click', async () => {
  txPlayer = null;
  try { await refresh(); } catch (err) { toast(err.message, 'error'); }
});

el('search').addEventListener('input', paintPlayers);
el('refreshBtn').addEventListener('click', async () => {
  try { await refresh(); toast('تم التحديث'); }
  catch (err) { toast(err.message, 'error'); }
});

/* ------------------------------- الإقلاع ------------------------------- */
(async function boot() {
  try { token = localStorage.getItem(CASHIER_TOKEN_KEY); } catch { token = null; }
  if (!token) return showGate();

  try {
    showPanel();
    await refresh();
  } catch (err) {
    token = null;
    try { localStorage.removeItem(CASHIER_TOKEN_KEY); } catch { /* تجاهل */ }
    showGate(err.status === 401 ? '' : err.message);
  }
})();
