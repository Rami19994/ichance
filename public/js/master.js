/* ==========================================================================
   iCHANCE — لوحة الماستر
   --------------------------------------------------------------------------
   الماستر ينشئ كاشيريته ويعبّئ عهدتهم من عهدته هو، ويرى لاعبيهم بلا أن
   يتصرّف بأرصدتهم. كل صلاحية هنا تُفحص في قاعدة البيانات من جديد؛ ما في
   هذا الملف عرض وراحة استعمال لا أكثر.
   ========================================================================== */
'use strict';

// اسم خاص لا TOKEN_KEY: common.js يعرّف ذلك الاسم في النطاق العام نفسه،
// وتكراره يُفشل تحميل هذا الملف بأكمله فلا يُربط أي زر.
const MASTER_TOKEN_KEY = 'ichance.masterToken';
const el = (id) => document.getElementById(id);

let token = null;
let me = null;
let cashiers = [];
let players = [];
let txs = [];
let txCashier = null;
let action = null;

/* ------------------------------- الاتصال ------------------------------- */
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Master-Token'] = token;
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

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('en-GB')} ${time}`;
}

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
    const out = await api('POST', '/api/master/login', {
      identifier: el('muser').value,
      password: el('mpass').value
    });
    token = out.token;
    try { localStorage.setItem(MASTER_TOKEN_KEY, token); } catch { /* تصفح خاص */ }
    el('mpass').value = '';
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
  try { localStorage.removeItem(MASTER_TOKEN_KEY); } catch { /* تجاهل */ }
  cashiers = []; players = []; txs = []; me = null;
  showGate();
});

/* -------------------------------- التحميل -------------------------------- */
async function refresh() {
  const [overview, pl, tx] = await Promise.all([
    api('GET', '/api/master/overview'),
    api('GET', '/api/master/players'),
    api('GET', `/api/master/transactions?limit=150${txCashier ? `&cashier=${encodeURIComponent(txCashier)}` : ''}`)
  ]);
  me = overview.master;
  cashiers = overview.cashiers || [];
  players = pl.players || [];
  txs = tx.transactions || [];
  paintAll();
}

function paintAll() {
  paintHeader();
  paintKpis();
  paintCashiers();
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
      hint: 'ما تبقّى لك لتعبئة كاشيريتك' },
    { label: 'كاشيريّتي', value: fmt(me.cashier_count),
      hint: `${fmt(me.active_cashiers)} نشط` },
    { label: 'عهدهم مجتمعة', value: fmt(me.cashiers_float), hint: 'ما في أيدي كاشيريتك' },
    { label: 'لاعبو شبكتي', value: fmt(me.player_count),
      hint: `أرصدتهم ${fmt(me.players_balance)}` },
    { label: 'استلمت من الإدارة', value: fmt(me.received_from_admin), hint: 'إجمالي ما وصلك' },
    { label: 'وزّعت على كاشيريتي', value: fmt(me.gave_cashiers), hint: 'إجمالي ما سلّمته' },
    { label: 'حرق شبكتي', value: fmt(me.burn), hint: 'ما خسره لاعبو شبكتك صافياً' },
    { label: 'عمولتي', value: fmt(me.commission_amount),
      hint: `${Number(me.commission_rate).toFixed(0)}% على الحرق` }
  ];
  el('kpis').innerHTML = cards.map((c) => `
    <div class="kpi">
      <span class="kpi__label">${c.label}</span>
      <b class="kpi__value">${c.value}</b>
      <span class="kpi__hint">${c.hint}</span>
    </div>`).join('');
}

function visibleCashiers() {
  const q = el('search').value.trim().toLowerCase();
  if (!q) return cashiers;
  return cashiers.filter((c) =>
    (c.username || '').toLowerCase().includes(q)
    || (c.display_id || '').toLowerCase().includes(q));
}

function paintCashiers() {
  const list = visibleCashiers();
  el('cashiersEmpty').hidden = list.length > 0;
  el('cashiersEmpty').textContent = cashiers.length
    ? 'لا نتائج لهذا البحث.'
    : 'لا كاشيرية بعد — أنشئ أول حساب من الأعلى.';

  el('cashiersBody').innerHTML = list.map((c) => `
    <tr>
      <td>
        <span class="player-cell${c.active ? '' : ' is-off'}">
          <b>${escapeHtml(c.username)}</b>
          <span>${c.active ? 'يعمل' : 'موقوف'}</span>
        </span>
      </td>
      <td class="mono">${escapeHtml(c.display_id)}</td>
      <td><b>${fmt(c.float_balance)}</b></td>
      <td>${fmt(c.player_count)}</td>
      <td>${fmt(c.players_balance)}</td>
      <td class="pos">${fmt(c.burn)}</td>
      <td>
        <span class="rowbtns">
          <button class="b-in"  data-do="topup" data-id="${c.id}">عبّئ</button>
          <button class="b-out" data-do="debit" data-id="${c.id}">اسحب</button>
          <button data-do="password" data-id="${c.id}">كلمة المرور</button>
          <button data-do="rename"   data-id="${c.id}">تعديل</button>
          <button data-do="tx"       data-id="${c.id}">كشفه</button>
          <button data-do="toggle"   data-id="${c.id}">${c.active ? 'إيقاف' : 'تفعيل'}</button>
          <button data-do="delete"   data-id="${c.id}">حذف</button>
        </span>
      </td>
    </tr>`).join('');
}

function paintPlayers() {
  el('playersEmpty').hidden = players.length > 0;
  el('playersBody').innerHTML = players.map((p) => {
    const pl = Number(p.game_pl || 0);
    return `
      <tr>
        <td>
          <span class="player-cell${p.active ? '' : ' is-off'}">
            <b>${escapeHtml(p.username)}</b>
            <span>${escapeHtml(p.display_id)}</span>
          </span>
        </td>
        <td class="dim">${escapeHtml(p.cashier_username || '—')}</td>
        <td><b>${fmt(p.balance)}</b></td>
        <td class="tag-in">${fmt(p.total_deposited)}</td>
        <td class="tag-out">${fmt(p.total_withdrawn)}</td>
        <td class="${pl >= 0 ? 'pos' : 'neg'}">${fmtSigned(pl)}</td>
      </tr>`;
  }).join('');
}

function paintTx() {
  el('txEmpty').hidden = txs.length > 0;
  el('txHint').textContent = txs.length ? `آخر ${txs.length} حركة` : '';
  el('txFilter').hidden = !txCashier;

  el('txBody').innerHTML = txs.map((t) => {
    const incoming = t.kind === 'cashier_topup' || t.kind === 'withdraw';
    return `
      <tr>
        <td class="dim">${when(t.created_at)}</td>
        <td class="${incoming ? 'tag-out' : 'tag-in'}">${escapeHtml(t.direction || t.kind)}</td>
        <td>${escapeHtml(t.subject_username || '—')}</td>
        <td><b>${fmt(t.amount)}</b></td>
        <td class="dim">${escapeHtml(t.note || '—')}</td>
      </tr>`;
  }).join('');
}

/* ----------------------------- إنشاء كاشير ----------------------------- */
el('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('newBtn').disabled = true;
  const out = el('newOut');
  out.hidden = true;
  const password = el('nPass').value;

  try {
    const r = await api('POST', '/api/master/cashier', {
      username: el('nUser').value.trim(), password
    });
    out.hidden = false;
    // تُعرض مرة واحدة ليسلّمها الماستر لكاشيره — لا تُخزَّن نصّاً في أي مكان
    out.innerHTML = `<b>أُنشئ الكاشير.</b> سلّمه هذه البيانات — كلمة المرور لن تظهر ثانية:
      المستخدم <code>${escapeHtml(r.cashier.username)}</code>
      · كلمة المرور <code>${escapeHtml(password)}</code>
      · الدخول من <code>/cashier</code>
      <br>عهدته صفر الآن — اضغط «عبّئ» لتسليمه من عهدتك.`;
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
const QUICK = [10000, 50000, 100000, 250000, 500000];

function openModal(kind, c) {
  action = { kind, c };
  const titles = {
    topup: 'تعبئة عهدة الكاشير',
    debit: 'سحب من عهدة الكاشير',
    password: 'تغيير كلمة مرور الكاشير',
    rename: 'تعديل اسم الكاشير'
  };
  el('modalTitle').textContent = titles[kind];
  el('modalWho').textContent = `${c.username} · ${c.display_id} · عهدته ${fmt(c.float_balance)}`;

  const isMoney = kind === 'topup' || kind === 'debit';
  el('amountField').hidden = !isMoney;
  el('passField').hidden = kind !== 'password';
  el('nameField').hidden = kind !== 'rename';
  el('noteField').hidden = !isMoney;

  el('modalAmount').value = '';
  el('modalPass').value = '';
  el('modalName').value = kind === 'rename' ? c.username : '';
  el('modalNote').value = '';
  el('modalErr').hidden = true;

  el('quickAmounts').innerHTML = isMoney
    ? QUICK.map((q) => `<button type="button" data-q="${q}">${fmt(q)}</button>`).join('')
    : '';

  el('modal').hidden = false;
  setTimeout(() => {
    const f = isMoney ? el('modalAmount') : (kind === 'password' ? el('modalPass') : el('modalName'));
    f.focus();
  }, 30);
}

function closeModal() { el('modal').hidden = true; action = null; }

el('modalCancel').addEventListener('click', closeModal);
el('modal').addEventListener('click', (e) => { if (e.target === el('modal')) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('modal').hidden) closeModal(); });

el('quickAmounts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]');
  if (!b) return;
  el('modalAmount').value = (Number(el('modalAmount').value) || 0) + Number(b.dataset.q);
});

el('modalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!action) return;
  const errBox = el('modalErr');
  errBox.hidden = true;
  el('modalOk').disabled = true;

  try {
    const { kind, c } = action;
    if (kind === 'topup' || kind === 'debit') {
      const amount = Number(el('modalAmount').value);
      const out = await api('POST', '/api/master/cashier/float', {
        cashierId: c.id, amount, topup: kind === 'topup',
        note: el('modalNote').value.trim() || null
      });
      toast(`عهدته ${fmt(out.cashier_balance)} · عهدتك ${fmt(out.master_balance)}`, 'win', 5000);
    } else if (kind === 'password') {
      await api('POST', '/api/master/cashier/password', {
        cashierId: c.id, password: el('modalPass').value
      });
      toast('تغيّرت كلمة المرور — سلّمها له', 'win', 6000);
    } else if (kind === 'rename') {
      await api('POST', '/api/master/cashier/update', {
        cashierId: c.id, username: el('modalName').value.trim()
      });
      toast('حُفظ التعديل');
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
el('cashiersBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-do]');
  if (!b) return;
  const c = cashiers.find((x) => x.id === b.dataset.id);
  if (!c) return;
  const what = b.dataset.do;

  if (['topup', 'debit', 'password', 'rename'].includes(what)) return openModal(what, c);

  if (what === 'tx') {
    txCashier = c.id;
    el('txWho').textContent = c.username;
    await refresh();
    el('txFilter').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  try {
    if (what === 'toggle') {
      const next = !c.active;
      if (!confirm(next ? `تفعيل ${c.username}؟` : `إيقاف ${c.username}؟ سيخرج فوراً.`)) return;
      await api('POST', '/api/master/cashier/toggle', { cashierId: c.id, active: next });
      toast(next ? 'فُعّل الكاشير' : 'أُوقف الكاشير');
    } else if (what === 'delete') {
      if (!confirm(`حذف ${c.username} نهائياً؟\nلا يُحذف إن كان له عهدة أو لاعبون أو حركات مالية.`)) return;
      await api('POST', '/api/master/cashier/delete', { cashierId: c.id });
      toast('حُذف الكاشير');
    }
    await refresh();
  } catch (err) { toast(err.message, 'error', 6000); }
});

el('txClear').addEventListener('click', async () => { txCashier = null; await refresh(); });
el('search').addEventListener('input', paintCashiers);
el('refreshBtn').addEventListener('click', async () => {
  try { await refresh(); toast('تم التحديث'); }
  catch (err) { toast(err.message, 'error'); }
});

/* ------------------------------- الإقلاع ------------------------------- */
(async function boot() {
  try { token = localStorage.getItem(MASTER_TOKEN_KEY); } catch { token = null; }
  if (!token) return showGate();
  try {
    showPanel();
    await refresh();
  } catch (err) {
    token = null;
    try { localStorage.removeItem(MASTER_TOKEN_KEY); } catch { /* تجاهل */ }
    showGate(err.status === 401 ? '' : err.message);
  }
})();
