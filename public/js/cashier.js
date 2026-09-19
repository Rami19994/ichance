/* ==========================================================================
   iCHANCE — لوحة الكاشير
   --------------------------------------------------------------------------
   كل صلاحية هنا يتحقّق منها الخادم من جديد: ملكية اللاعب، كفاية العهدة،
   كفاية رصيد اللاعب. ما في هذا الملف هو عرض وراحة استعمال لا أكثر.
   ========================================================================== */
'use strict';

const el = (id) => document.getElementById(id);
const TOKEN_KEY = 'ichance.cashierToken';

let token = null;
let me = null;
let players = [];
let txs = [];
let txPlayer = null;      // فلتر كشف الحركة
let action = null;        // الإجراء المفتوح في النافذة

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
  return sameDay ? time : `${d.toLocaleDateString('en-GB')} ${time}`;
}

const KIND = {
  deposit: { label: 'تعبئة', cls: 'tag-in', sign: '+' },
  withdraw: { label: 'سحب', cls: 'tag-out', sign: '−' },
  cashier_topup: { label: 'عهدة واردة', cls: 'tag-in', sign: '+' },
  cashier_debit: { label: 'عهدة مسحوبة', cls: 'tag-out', sign: '−' }
};

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
}

el('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('gateBtn').disabled = true;
  try {
    const out = await api('POST', '/api/cashier/login', {
      identifier: el('cuser').value,
      password: el('cpass').value
    });
    token = out.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* تصفح خاص */ }
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
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* تجاهل */ }
  players = []; txs = []; me = null;
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

function paintPlayers() {
  const list = visiblePlayers();
  el('playersEmpty').hidden = list.length > 0;
  el('playersEmpty').textContent = players.length
    ? 'لا نتائج لهذا البحث.'
    : 'لا لاعبين بعد — أنشئ أول حساب من الأعلى.';

  el('playersBody').innerHTML = list.map((p) => `
    <tr>
      <td>
        <span class="player-cell${p.active ? '' : ' is-off'}">
          <b>${escapeHtml(p.username)}</b>
          <span>${escapeHtml(p.email || '—')}</span>
        </span>
      </td>
      <td class="mono">${escapeHtml(p.display_id)}</td>
      <td><b>${fmt(p.balance)}</b></td>
      <td class="tag-in">${fmt(p.total_deposited)}</td>
      <td class="tag-out">${fmt(p.total_withdrawn)}</td>
      <td class="dim">${when(p.last_login_at)}</td>
      <td>
        <span class="rowbtns">
          <button class="b-in"  data-do="deposit"  data-id="${p.id}">تعبئة</button>
          <button class="b-out" data-do="withdraw" data-id="${p.id}">سحب</button>
          <button data-do="password" data-id="${p.id}">كلمة المرور</button>
          <button data-do="tx"       data-id="${p.id}">كشفه</button>
          <button data-do="toggle"   data-id="${p.id}">${p.active ? 'إيقاف' : 'تفعيل'}</button>
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
        <td class="dim">${when(t.created_at)}</td>
        <td>${escapeHtml(t.player_username || '—')}</td>
        <td class="${k.cls}">${k.label}</td>
        <td class="${k.cls}"><b>${k.sign}${fmt(t.amount)}</b></td>
        <td>${fmt(t.player_balance_after)}</td>
        <td class="dim">${escapeHtml(t.note || '—')}</td>
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
    out.hidden = false;
    // نعرض البيانات مرة واحدة ليسلّمها الكاشير للاعب — كلمة المرور
    // لا تُخزَّن نصّاً في أي مكان ولن تُعرض ثانية
    out.innerHTML = `
      <b>تمّ إنشاء الحساب.</b> سلّم اللاعب هذه البيانات — كلمة المرور لن تظهر مرة أخرى:
      <br>المستخدم <code>${escapeHtml(r.player.username)}</code>
      · الإيميل <code>${escapeHtml(r.player.email)}</code>
      · كلمة المرور <code>${escapeHtml(password)}</code>
      · المعرّف <code>${escapeHtml(r.player.display_id)}</code>`;
    el('newForm').reset();
    await refresh();
  } catch (err) {
    out.hidden = false;
    out.innerHTML = `<b style="color:var(--red)">تعذّر الإنشاء:</b> ${escapeHtml(err.message)}`;
  } finally {
    el('newBtn').disabled = false;
  }
});

/* ------------------------------ نافذة الإجراء ------------------------------ */
const QUICK = [1000, 5000, 10000, 25000, 50000, 100000];

function openModal(kind, player) {
  action = { kind, player };
  const titles = {
    deposit: 'تعبئة رصيد',
    withdraw: 'سحب رصيد',
    password: 'تغيير كلمة المرور'
  };
  el('modalTitle').textContent = titles[kind];
  el('modalWho').textContent = `${player.username} · ${player.display_id} · رصيده ${fmt(player.balance)}`;

  const isPass = kind === 'password';
  el('amountField').hidden = isPass;
  el('passField').hidden = !isPass;
  el('modalAmount').value = '';
  el('modalPass').value = '';
  el('modalNote').value = '';
  el('modalErr').hidden = true;

  el('quickAmounts').innerHTML = isPass ? ''
    : QUICK.map((q) => `<button type="button" data-q="${q}">${fmt(q)}</button>`).join('');

  el('modal').hidden = false;
  setTimeout(() => (isPass ? el('modalPass') : el('modalAmount')).focus(), 30);
}

function closeModal() { el('modal').hidden = true; action = null; }

el('modalCancel').addEventListener('click', closeModal);
el('modal').addEventListener('click', (e) => { if (e.target === el('modal')) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('modal').hidden) closeModal(); });

el('quickAmounts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]');
  if (!b) return;
  const cur = Number(el('modalAmount').value) || 0;
  el('modalAmount').value = cur + Number(b.dataset.q);
});

el('modalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!action) return;
  const errBox = el('modalErr');
  errBox.hidden = true;
  el('modalOk').disabled = true;

  try {
    if (action.kind === 'password') {
      const pw = el('modalPass').value;
      await api('POST', '/api/cashier/password', { playerId: action.player.id, password: pw });
      toast(`تغيّرت كلمة مرور ${action.player.username} — سلّمها له`, 'win', 6000);
    } else {
      const amount = Number(el('modalAmount').value);
      const out = await api('POST', `/api/cashier/${action.kind}`, {
        playerId: action.player.id,
        amount,
        note: el('modalNote').value.trim() || null
      });
      const verb = action.kind === 'deposit' ? 'عُبّئ' : 'سُحب';
      toast(`${verb} ${fmt(amount)} — رصيده الآن ${fmt(out.player_balance)}`, 'win');
    }
    closeModal();
    await refresh();
  } catch (err) {
    errBox.hidden = false;
    errBox.textContent = err.message;
  } finally {
    el('modalOk').disabled = false;
  }
});

/* ------------------------------ أزرار الصفوف ------------------------------ */
el('playersBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-do]');
  if (!b) return;
  const player = players.find((p) => p.id === b.dataset.id);
  if (!player) return;

  const what = b.dataset.do;
  if (what === 'deposit' || what === 'withdraw' || what === 'password') {
    if (!player.active && what !== 'password') {
      toast('الحساب موقوف — فعّله أولاً', 'error');
      return;
    }
    return openModal(what, player);
  }

  if (what === 'tx') {
    txPlayer = player.id;
    el('txPlayerName').textContent = player.username;
    await refresh();
    el('txFilter').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
});

el('txClear').addEventListener('click', async () => {
  txPlayer = null;
  await refresh();
});

el('search').addEventListener('input', paintPlayers);
el('refreshBtn').addEventListener('click', async () => {
  try { await refresh(); toast('تم التحديث'); }
  catch (err) { toast(err.message, 'error'); }
});

/* ------------------------------- الإقلاع ------------------------------- */
(async function boot() {
  try { token = localStorage.getItem(TOKEN_KEY); } catch { token = null; }
  if (!token) return showGate();

  try {
    showPanel();
    await refresh();
  } catch (err) {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* تجاهل */ }
    showGate(err.status === 401 ? '' : err.message);
  }
})();
