/* ==========================================================================
   iCHANCE — لوحة الإدارة
   --------------------------------------------------------------------------
   المفتاح يُحفظ في متصفح الأدمن فقط ويُرسل في ترويسة X-Admin-Key.
   كل الأرقام تأتي محسوبة من الخادم (/api/admin/overview) — لا حساب هنا.
   ========================================================================== */
'use strict';

const KEY_STORE = 'ichance.adminKey';
const el = (id) => document.getElementById(id);

let adminKey = null;
let timer = null;
let openRound = null;   // الجولة المفتوحة تفاصيلها
let lastData = null;
let mode = 'total';     // total | real | bot
let calcTouched = false;

const MODE_NOTE = {
  total: 'الإجمالي: أموال اللاعبين الحقيقيين + محاكاة البوتات معاً. هذا هو الرقم المناسب لدراسة الجدوى — يمثّل ما سيجنيه الموقع عند هذا الحجم من اللعب.',
  real: 'حقيقي فقط: أرصدة اللاعبين البشر. هذه هي الأموال التي تحرّكت فعلاً في محافظ حقيقية.',
  bot: 'محاكاة فقط: رهانات البوتات. أموال وهمية لا تمرّ بأي محفظة — تُستعمل لتقدير السلوك عند حجم لعب أكبر.'
};

/* ------------------------------- أدوات ------------------------------- */
function tierOf(m) {
  if (m === 0) return 'lose';
  if (m === 1) return 'low';
  if (m <= 3) return 'mid';
  if (m <= 5) return 'high';
  if (m < 20) return 'top';
  return 'mega';   // ×20 فأعلى — نادرة جداً فتستحق مظهراً خاصاً
}

function pct(x) { return `${(x * 100).toFixed(2)}%`; }

/** بدلو الدفتر حسب الوضع المختار. */
function bucket(ledger) { return ledger[mode]; }

/** حساب الجولة حسب الوضع المختار. */
const EMPTY_HOUSE = { wagered: 0, paid: 0, profit: 0, bets: 0 };
function roundHouse(r) {
  if (!r.house) return EMPTY_HOUSE;
  return r.house[mode] || r.house.total || EMPTY_HOUSE;
}

function timeOf(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function boardMini(cards) {
  return `<span class="board-mini">${cards
    .map((m) => `<i data-tier="${tierOf(m)}">${m === 0 ? '✕' : m}</i>`)
    .join('')}</span>`;
}

function currentGateProof() {
  const fromQuery = new URLSearchParams(location.search).get('gate');
  if (fromQuery) {
    try { localStorage.setItem('ichance_admin_gate', fromQuery); } catch { /* تصفح خاص */ }
    return fromQuery;
  }
  const fromCookie = document.cookie.match(/ichance_admin_gate=([A-Za-z0-9_-]+)/)?.[1];
  if (fromCookie) return fromCookie;
  try { return localStorage.getItem('ichance_admin_gate') || ''; } catch { return ''; }
}

async function adminGet(path) {
  const gate = currentGateProof();
  const sep = path.includes('?') ? '&' : '?';
  const url = gate ? `${path}${sep}gate=${encodeURIComponent(gate)}` : path;
  const headers = { 'X-Admin-Key': adminKey || '' };
  if (gate) headers['X-Gate'] = gate;
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      showGate((data && data.error) || 'انتهت صلاحية المفتاح — أدخل مفتاحك للمتابعة');
    }
    const err = new Error((data && data.error) || `خطأ ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function adminPost(path, body) {
  const gate = currentGateProof();
  const sep = path.includes('?') ? '&' : '?';
  const url = gate ? `${path}${sep}gate=${encodeURIComponent(gate)}` : path;
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' };
  if (gate) headers['X-Gate'] = gate;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      showGate((data && data.error) || 'انتهت صلاحية المفتاح — أدخل مفتاحك للمتابعة');
    }
    const err = new Error((data && data.error) || `خطأ ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** مفتاح عشوائي يولّده المتصفح — للراحة فقط، والخادم هو من يتحقق ويحفظ. */
function randomKey() {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** حالة المفتاح على الخادم — بلا مصادقة، تحدّد أي شاشة نعرض. */
async function keyStatus() {
  try {
    const res = await fetch('/api/admin/status');
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/* ------------------------------- البوابة ------------------------------- */
function showGate(message) {
  el('gate').hidden = false;
  el('admin').hidden = true;
  el('claimForm').hidden = true;
  el('gateForm').hidden = false;
  if (timer) { clearInterval(timer); timer = null; }
  const box = el('gateError');
  if (message) { box.hidden = false; box.textContent = message; }
  else box.hidden = true;
  el('keyInput').focus();
  // الحالة تتغيّر بعد الإنشاء أو التغيير، فنسأل الخادم في كل مرة
  keyStatus().then(paintGateHelp);
}

/** شاشة إنشاء المفتاح — أول تشغيل فقط، وضمن نافذة زمنية. */
function showClaim(status) {
  el('gate').hidden = false;
  el('admin').hidden = true;
  el('gateForm').hidden = true;
  el('claimForm').hidden = false;
  el('claimLeft').textContent = `${status.claimMinutesLeft} دقيقة`;
  el('claimInput').focus();
}

/**
 * سطر المساعدة أسفل نموذج الدخول: يقول للمالك من أين يأتي بالمفتاح
 * في وضعه الحالي بالضبط، بدل نصّ ثابت قد لا ينطبق.
 */
function paintGateHelp(status) {
  const box = el('gateHelp');
  if (!status) { box.innerHTML = ''; return; }
  if (status.storageWritable === false) {
    box.innerHTML = '⚠ الخادم لا يستطيع الكتابة في مجلّد <code>data</code>، فالمفتاح لن يبقى بعد '
      + 'إعادة التشغيل. أعطِ المجلّد صلاحية الكتابة من لوحة الاستضافة.';
  } else if (status.source === 'env') {
    box.innerHTML = 'المفتاح مضبوط من متغيّر البيئة <code>ICHANCE_ADMIN_KEY</code> على الخادم.';
  } else if (!status.ownKeyChosen) {
    box.innerHTML = 'مفتاحك الأول محفوظ في ملف <code>data/admin-key.txt</code> — افتحه من مدير ملفات الاستضافة.';
  } else {
    box.innerHTML = 'نسيت المفتاح؟ احذف ملف <code>data/admin.json</code> من الاستضافة ثم أعد تشغيل الخادم ليُنشأ مفتاح جديد.';
  }
}

function showPanel() {
  el('gate').hidden = true;
  el('admin').hidden = false;
}

/** يدخل باللوحة بمفتاح معيّن، ويحفظه إن نجح. */
async function enterWith(value) {
  adminKey = value;
  const data = await adminGet('/api/admin/overview');
  try { localStorage.setItem(KEY_STORE, value); } catch { /* تصفح خاص */ }
  showPanel();
  render(data);
  startPolling();
  keyStatus().then(paintKeySection);
  loadOwner();
  loadMasters();
  loadGames();
  loadDomainConfig();
  loadAdminKeys();
}

el('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = el('keyInput').value.trim();
  if (!value) return;
  try {
    await enterWith(value);
  } catch (err) {
    adminKey = null;
    showGate(err.message);
  }
});

/* --------------------- إنشاء المفتاح في أول تشغيل --------------------- */
el('claimGenBtn').addEventListener('click', () => {
  el('claimInput').value = randomKey();
  el('claimInput').focus();
  el('claimInput').select();
});

el('haveKeyBtn').addEventListener('click', () => showGate());

el('claimForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = el('claimInput').value.trim();
  const err = el('claimError');
  err.hidden = true;
  if (!value) { err.hidden = false; err.textContent = 'اكتب مفتاحاً أو اضغط 🎲 ليولَّد'; return; }
  try {
    await adminPost('/api/admin/claim', { key: value });
    await enterWith(value);
    toast('حُفظ المفتاح — احتفظ به');
  } catch (ex) {
    adminKey = null;
    err.hidden = false;
    err.textContent = ex.message;
  }
});

/* ------------------------- إدارة مفاتيح وأجهزة الأدمن ------------------------- */
let ADMIN_KEYS = [];

function paintKeySection(status) {
  if (!status) return;
  el('keySource').textContent = `المفاتيح النشطة: ${status.keysCount || 1} مفتاح (يدعم تعدد الأجهزة)`;
}

async function loadAdminKeys() {
  try {
    const res = await adminGet('/api/admin/keys');
    ADMIN_KEYS = res.keys || [];
    renderAdminKeysTable();
  } catch (err) {
    if (err.status !== 401) console.warn('admin keys:', err.message);
  }
}

function renderAdminKeysTable() {
  const body = el('adminKeysBody');
  if (!body) return;
  if (!ADMIN_KEYS.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">لا توجد مفاتيح مسجلة.</td></tr>';
    return;
  }
  body.innerHTML = ADMIN_KEYS.map((k) => {
    const created = new Date(k.createdAt);
    const createdStr = `${created.toLocaleDateString('ar-EG')} ${timeOf(k.createdAt)}`;
    const usedStr = k.lastUsedAt ? `${new Date(k.lastUsedAt).toLocaleDateString('ar-EG')} ${timeOf(k.lastUsedAt)}` : 'لم يُستخدم بعد';
    const canDelete = ADMIN_KEYS.length > 1;
    return `
      <tr>
        <td><b>${escapeHtml(k.name)}</b></td>
        <td class="dim">${createdStr}</td>
        <td class="dim">${usedStr}</td>
        <td>
          ${canDelete
            ? `<button class="btn btn--dark btn--sm" data-key-del="${k.id}">🗑️ حذف المفتاح</button>`
            : '<span class="dim">المفتاح الوحيد</span>'}
        </td>
      </tr>`;
  }).join('');
}

el('adminKeysBody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-key-del]');
  if (!btn) return;
  const id = btn.dataset.keyDel;
  if (!confirm('هل أنت متأكد من حذف مفتاح هذا الجهاز نهائياً؟')) return;
  try {
    await adminPost('/api/admin/keys/delete', { keyId: id });
    toast('تم حذف المفتاح بنجاح');
    await loadAdminKeys();
    keyStatus().then(paintKeySection);
  } catch (err) {
    toast(err.message, 'error');
  }
});

el('genKeyBtn')?.addEventListener('click', () => {
  el('newKeyInput').value = randomKey();
  el('newKeyInput').focus();
  el('newKeyInput').select();
});

el('addKeyBtn')?.addEventListener('click', async () => {
  const name = el('newKeyNameInput').value.trim() || 'جهاز أدمن إضافي';
  const wanted = el('newKeyInput').value.trim();
  const errBox = el('keyError');
  errBox.hidden = true;
  try {
    const out = await adminPost('/api/admin/keys/add', {
      name,
      key: wanted || undefined
    });
    el('newKeyInput').value = '';
    el('newKeyNameInput').value = '';
    el('keyValue').textContent = out.key;
    el('keyResultLabel').textContent = `تم إنشاء المفتاح بنجاح لـ (${escapeHtml(out.name)}) — انسخه الآن وسلمه للأدمن:`;
    el('keyResult').hidden = false;
    toast('تم إنشاء وحفظ المفتاح الجديد بنجاح', 'win');
    await loadAdminKeys();
    keyStatus().then(paintKeySection);
  } catch (ex) {
    errBox.hidden = false;
    errBox.textContent = ex.message;
  }
});

el('copyKeyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('keyValue').textContent);
    toast('نُسخ المفتاح');
  } catch {
    // clipboard محجوب (http أو إذن مرفوض) — نترك النص محدَّداً لينسخه يدوياً
    const r = document.createRange();
    r.selectNodeContents(el('keyValue'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    toast('انسخ المفتاح المحدَّد');
  }
});

el('logoutBtn').addEventListener('click', () => {
  adminKey = null;
  try { localStorage.removeItem(KEY_STORE); } catch { /* تجاهل */ }
  el('keyInput').value = '';
  showGate();
});

el('refreshBtn').addEventListener('click', () => refresh(true));

el('modeSeg').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-mode]');
  if (!btn) return;
  mode = btn.dataset.mode;
  [...el('modeSeg').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  if (lastData) render(lastData);
});

['calcPlayers', 'calcBet', 'calcRound', 'calcHours', 'calcEdge'].forEach((id) => {
  el(id).addEventListener('input', () => { calcTouched = true; renderCalc(); });
});

/* ------------------------------- الرسم ------------------------------- */
function renderKpis(d) {
  const L = bucket(d.ledger);
  const T = d.ledger.total;
  const profitClass = L.profit >= 0 ? 'kpi--profit' : 'kpi--loss';
  const share = T.wagered ? (L.wagered / T.wagered) * 100 : 0;

  el('modeNote').dataset.mode = mode;
  el('modeNote').textContent = MODE_NOTE[mode];

  el('kpis').innerHTML = `
    <div class="kpi ${profitClass}">
      <span class="kpi__label">صافي ربح الموقع</span>
      <span class="kpi__value">${fmtSigned(L.profit)}</span>
      <span class="kpi__sub">هامش ${pct(L.margin)} · نظري ${d.settings.houseEdge}%</span>
    </div>
    <div class="kpi kpi--gold">
      <span class="kpi__label">إجمالي الرهانات</span>
      <span class="kpi__value">${fmt(L.wagered)}</span>
      <span class="kpi__sub">${fmt(L.bets)} مشاركة · متوسط ${fmt(L.avgBet)}</span>
    </div>
    <div class="kpi">
      <span class="kpi__label">إجمالي المدفوع للاعبين</span>
      <span class="kpi__value">${fmt(L.paid)}</span>
      <span class="kpi__sub">عائد فعلي ${pct(L.actualRtp)} · نظري ${d.settings.theoreticalRtp}%</span>
    </div>
    <div class="kpi">
      <span class="kpi__label">الجولات المحسوبة</span>
      <span class="kpi__value">${fmt(L.rounds)}</span>
      <span class="kpi__sub">${mode === 'total' ? 'كل الجولات' : `${share.toFixed(0)}% من حجم الرهان`}</span>
    </div>
    <div class="kpi">
      <span class="kpi__label">اللاعبون المسجّلون</span>
      <span class="kpi__value">${fmt(d.playerCount)}</span>
      <span class="kpi__sub">${d.online} متصل الآن</span>
    </div>
    <div class="kpi">
      <span class="kpi__label">الشحن التجريبي الممنوح</span>
      <span class="kpi__value">${fmt(d.ledger.faucet)}</span>
      <span class="kpi__sub">عملة افتراضية وُزّعت مجاناً</span>
    </div>`;
}

/* ------------------------------- ربحية الألعاب ------------------------------- */
// العائد النظري يأتي من الخادم (d.gameRtp) — rtp هنا احتياط فقط لخادم أقدم.
// الدبابات لعبة مهارة: عائدها مقيس لا مضمون (~80%، انظر جدولها).
const GAME_META = {
  cards: { name: 'كروت الحظ', emoji: '🎴', rtp: 96.0 },
  slots: { name: 'صيّاد الجوائز', emoji: '🤠', rtp: 96.2 },
  tank:  { name: 'معركة الدبابات', emoji: '🛡️', rtp: 80.0 },
  'neon-slots': { name: 'نيون فيغاس', emoji: '🎰', rtp: 96.01 },
  mines: { name: 'مناجم الحظ', emoji: '💣', rtp: 97.0 },
  plinko: { name: 'بلينكو', emoji: '🔻', rtp: 96.28 },
  bullseye: { name: 'بولزآي X', emoji: '🎯', rtp: 96.0 },
  chicken: { name: 'طريق الدجاجة', emoji: '🐔', rtp: 96.0 }
};

function renderGames(d) {
  const games = d.ledger.games || {};
  const totalWagered = Object.values(games).reduce((a, g) => a + g.wagered, 0);

  el('gamesProfit').innerHTML = Object.entries(games).map(([key, g]) => {
    const base = GAME_META[key] || { name: key, emoji: '🎲', rtp: null };
    const meta = { ...base, rtp: (d.gameRtp && d.gameRtp[key] != null) ? d.gameRtp[key] : base.rtp };
    const share = totalWagered ? (g.wagered / totalWagered) * 100 : 0;
    return `
      <div class="game-card${g.bets ? '' : ' game-card--idle'}">
        <div class="game-card__head">
          <span class="game-card__emoji">${meta.emoji}</span>
          <span class="game-card__name">${escapeHtml(meta.name)}</span>
        </div>
        <div class="game-card__profit ${g.profit >= 0 ? 'pos' : 'neg'}">${fmtSigned(g.profit)}</div>
        <div class="game-card__sub">${g.bets ? `هامش ${pct(g.margin)} من ${fmt(g.bets)} رهان` : 'لم تُلعب بعد'}</div>
        <div class="game-card__rows">
          <div><span>إجمالي الرهانات</span><b>${fmt(g.wagered)}</b></div>
          <div><span>المدفوع للاعبين</span><b>${fmt(g.paid)}</b></div>
          <div><span>العائد الفعلي</span><b>${g.bets ? pct(g.actualRtp) : '—'}</b></div>
          <div><span>العائد النظري</span><b>${meta.rtp ? meta.rtp + '%' : '—'}</b></div>
          <div><span>متوسط الرهان</span><b>${g.spinCount ? fmt(g.avgSpinBet) : (g.bets ? fmt(g.avgBet) : '—')}</b></div>
          ${g.buys ? `<div><span>شراء الميزة</span><b>${fmt(g.buys.count)} × ${fmt(g.buys.avg)}</b></div>` : ''}
        </div>
        <div class="game-card__bar"><i style="width:${share.toFixed(1)}%"></i></div>
        <div class="game-card__sub" style="margin:6px 0 0">${share.toFixed(1)}% من حجم اللعب</div>
      </div>`;
  }).join('');
}

/**
 * جدول الدبابات: اللعبة الوحيدة التي يتحكّم اللاعب في نتيجتها بمهارته،
 * فعائدها ليس مضموناً رياضياً كالكروت والسلوتس بل مبنيّ على نسبة نجاة
 * **مقيسة**. لذلك نعرض المقيس بجانب الواقع: أي ابتعاد يعني أن مستوى
 * اللاعبين غير ما افترضناه، وعلاجه تعديل المضاعف لا انتظار «تصحيح الحظ».
 */
function renderTank(d) {
  const rows = d.tank || [];
  const played = rows.reduce((a, r) => a + r.battles, 0);

  el('tankSample').textContent = played
    ? `${fmt(played)} معركة حتى الآن`
    : 'لم تُلعب بعد';

  el('tankBody').innerHTML = rows.map((r) => {
    const gap = r.actualWinRate === null ? null : r.actualWinRate - r.measuredWinRate;
    // تحت 40 معركة الضجيج أكبر من أي إشارة، فلا نلوّن ولا ننذر
    const thin = r.battles < 40;
    const cls = gap === null || thin ? '' : (Math.abs(gap) > 0.08 ? 'neg' : 'pos');
    return `
      <tr>
        <td><b>${escapeHtml(r.name)}</b><br><span class="dim">${r.enemies} دبابات · ${r.armor} درع</span></td>
        <td class="ltr-num">×${r.payout.toFixed(2)}</td>
        <td>${pct(r.measuredWinRate)}</td>
        <td class="${cls}">${r.actualWinRate === null ? '—' : pct(r.actualWinRate)}</td>
        <td>${fmt(r.battles)}</td>
        <td>${r.actualRtp === null ? '—' : pct(r.actualRtp)}</td>
        <td class="dim">${r.rtp}%</td>
      </tr>`;
  }).join('');

  // إنذار مبكّر: عائد فعلي فوق 100% يعني أن اللعبة تخسر مالاً الآن
  const hot = rows.filter((r) => r.battles >= 40 && r.actualRtp !== null && r.actualRtp > 1);
  const warn = el('tankWarn');
  if (hot.length) {
    warn.hidden = false;
    warn.textContent = `⚠ عائد فعلي فوق 100% في: ${hot.map((r) => r.name).join('، ')}`
      + ' — اللاعبون أمهر من المفترض. اخفض المضاعف في public/js/tankSim.js أو ارفع الصعوبة.';
  } else {
    warn.hidden = true;
  }
}

/* ------------------------------- دراسة الجدوى ------------------------------- */
function renderEconomics(d) {
  const e = d.economics;
  const L = bucket(d.ledger);

  // عيّنة صغيرة => التوقعات المقيسة بلا معنى إحصائي. نقولها صراحة بدل تركها تُقرأ كحقيقة.
  const MIN_SAMPLE = 50;
  const thin = e.sampleRounds < MIN_SAMPLE;
  el('econSample').textContent = thin
    ? `عيّنة صغيرة: ${fmt(e.sampleRounds)} جولة فقط — التوقعات أدناه غير موثوقة بعد`
    : `مقيس من ${fmt(e.sampleRounds)} جولة فعلية`;
  el('econSample').style.color = thin ? 'var(--red)' : '';

  el('econMeasured').innerHTML = `
    <div class="econ-cell"><span>مدة الجولة (وسيط)</span><b>${e.avgRoundSeconds} ث</b></div>
    <div class="econ-cell"><span>جولات في الساعة</span><b>${e.roundsPerHour}</b></div>
    <div class="econ-cell"><span>متوسط اللاعبين بالجولة</span><b>${e.avgSeatsPerRound}</b></div>
    <div class="econ-cell"><span>منهم بشر</span><b>${e.avgHumansPerRound}</b></div>
    <div class="econ-cell gold"><span>متوسط مبلغ المشاركة</span><b>${fmt(L.avgBet)}</b></div>
    <div class="econ-cell ${e.profitPerRound >= 0 ? 'pos' : 'neg'}"><span>ربح الموقع لكل جولة</span><b>${fmtSigned(e.profitPerRound)}</b></div>
    <div class="econ-cell ${e.projected.day >= 0 ? 'pos' : 'neg'}"><span>ربح يومي بهذه الوتيرة</span><b>${fmtSigned(e.projected.day)}</b></div>
    <div class="econ-cell ${e.projected.month >= 0 ? 'pos' : 'neg'}"><span>ربح شهري بهذه الوتيرة</span><b>${fmtSigned(e.projected.month)}</b></div>`;

  if (e.stalledRounds > 0) {
    el('econMeasured').insertAdjacentHTML('beforeend', `
      <div class="econ-warn">
        استُبعدت <b>${fmt(e.stalledRounds)}</b> جولة تجاوزت ضِعف الدورة الطبيعية
        (<b>${e.nominalCycleSeconds}</b> ث) — تلك توقّفات في تشغيل الخادم لا جولات حقيقية،
        وإدخالها في الحساب يخرّب كل التوقعات.
      </div>`);
  }

  if (thin) {
    el('econMeasured').insertAdjacentHTML('beforeend', `
      <div class="econ-warn">
        ⚠️ هذه الأرقام مقيسة من <b>${fmt(e.sampleRounds)}</b> جولة فقط. جولة واحدة فيها كرت ×10
        تكفي لقلب الإشارة من ربح إلى خسارة. لقراءة موثوقة شغّل الموقع حتى تتجاوز
        <b>${fmt(e.betsForConfidence)}</b> مشاركة، أو اعتمد على حاسبة السيناريو أدناه التي
        تستعمل الهامش النظري بدل العيّنة.
      </div>`);
  }

  // نملأ الحاسبة بالقيم المقيسة أول مرة فقط، ثم نحترم أرقام المستخدم
  if (!calcTouched) {
    el('calcPlayers').value = Math.max(1, Math.round(e.avgSeatsPerRound)) || 6;
    el('calcBet').value = Math.round(L.avgBet) || 800;
    el('calcRound').value = Math.round(e.avgRoundSeconds) || 50;
    el('calcHours').value = 24;
    el('calcEdge').value = d.settings.houseEdge;
  }
  renderCalc();

  const n = e.betsForConfidence;
  const hoursToConfidence = (e.roundsPerHour && e.avgSeatsPerRound)
    ? (n / (e.roundsPerHour * e.avgSeatsPerRound)).toFixed(1)
    : '—';

  el('econRisk').innerHTML = `
    هامش الموقع <b>${d.settings.houseEdge}%</b> متوسط على المدى الطويل، وليس ربحاً مضموناً في كل جولة.
    الانحراف المعياري لكل مشاركة <b>${e.stdDev}</b> ضعف المبلغ — أي أن جولة واحدة قد تقلب النتيجة.
    ${n ? `يلزم نحو <b>${fmt(n)}</b> مشاركة حتى يصبح الربح شبه مؤكد إحصائياً (ثلاثة انحرافات فوق الصفر)،` : ''}
    وبوتيرة <b>${e.roundsPerHour}</b> جولة/ساعة و<b>${e.avgSeatsPerRound}</b> لاعب بالجولة يتحقق ذلك خلال
    <b>${hoursToConfidence}</b> ساعة تشغيل.`;
}

function renderCalc() {
  const players = Math.max(0, Number(el('calcPlayers').value) || 0);
  const bet = Math.max(0, Number(el('calcBet').value) || 0);
  const roundSec = Math.max(1, Number(el('calcRound').value) || 1);
  const hours = Math.max(0, Number(el('calcHours').value) || 0);
  const edge = Math.max(0, Number(el('calcEdge').value) || 0) / 100;

  const volume = players * bet;
  const roundsPerHour = 3600 / roundSec;
  const profitPerRound = volume * edge;
  const perHour = profitPerRound * roundsPerHour;
  const perDay = perHour * hours;

  el('econOut').innerHTML = `
    <div class="econ-row"><span>حجم الرهان في الجولة</span><b>${fmt(volume)}</b></div>
    <div class="econ-row"><span>ربح الموقع في الجولة</span><b>${fmt(profitPerRound)}</b></div>
    <div class="econ-row"><span>جولات في الساعة</span><b>${roundsPerHour.toFixed(1)}</b></div>
    <div class="econ-row"><span>ربح في الساعة</span><b>${fmt(perHour)}</b></div>
    <div class="econ-row hero"><span>الربح اليومي المتوقع</span><b>${fmt(perDay)}</b></div>
    <div class="econ-row"><span>الربح الشهري المتوقع</span><b>${fmt(perDay * 30)}</b></div>
    <div class="econ-row"><span>الربح السنوي المتوقع</span><b>${fmt(perDay * 365)}</b></div>`;
}

function renderChart(rounds) {
  const box = el('profitChart');
  const played = rounds.filter((r) => roundHouse(r).bets > 0).slice(0, 30).reverse();
  if (!played.length) {
    box.innerHTML = '<div class="chart-empty">لا توجد جولات بلاعبين حقيقيين بعد.</div>';
    return;
  }
  const peak = Math.max(...played.map((r) => Math.abs(roundHouse(r).profit)), 1);

  box.innerHTML = played.map((r) => {
    const p = roundHouse(r).profit;
    const h = Math.max(3, Math.round((Math.abs(p) / peak) * 68));
    const bar = p >= 0
      ? `<div class="pbar__up" style="height:${h}%"></div>`
      : `<div class="pbar__down" style="height:${h}%"></div>`;
    return `
      <div class="pbar">
        ${p >= 0 ? '' : bar}
        ${p >= 0 ? bar : ''}
        <span class="pbar__tip">${r.roundId} · ${fmtSigned(p)}</span>
      </div>`;
  }).join('');
}

function renderLive(d) {
  const L = d.live;
  const phaseAr = { betting: 'مرحلة المشاركة', playing: 'اللعب جارٍ', results: 'كشف النتائج' };
  el('liveGrid').innerHTML = `
    <div class="live-cell"><span>رقم الجولة</span><b class="mono">${L.roundId}</b></div>
    <div class="live-cell"><span>المرحلة</span><b>${phaseAr[L.phase] || L.phase}</b></div>
    <div class="live-cell"><span>متبقٍ</span><b class="num">${Math.ceil(L.msLeft / 1000)} ث</b></div>
    <div class="live-cell"><span>على الطاولة</span><b class="num">${L.players} / ${d.settings.maxPlayers}</b></div>
    <div class="live-cell"><span>لاعبون حقيقيون</span><b class="num">${L.humans}</b></div>
    <div class="live-cell"><span>مبالغ معرّضة</span><b class="num">${fmt(L.exposure)}</b></div>`;
}

function renderRounds(rounds) {
  const body = el('roundsBody');
  if (!rounds.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">لم تُلعب أي جولة بعد.</td></tr>';
    return;
  }

  body.innerHTML = rounds.map((r) => {
    const h = roundHouse(r);
    const humans = r.seats.filter((s) => !s.isBot).length;
    const detail = openRound === r.roundId ? detailRow(r) : '';
    return `
      <tr class="clickable" data-round="${r.roundId}">
        <td class="mono">${r.roundId}</td>
        <td class="dim num">${timeOf(r.endedAt || r.ts)}</td>
        <td>${escapeHtml(r.templateName || r.patternName || r.game || '—')}</td>
        <td>${boardMini(r.cards)}</td>
        <td class="num">${humans}<span class="dim"> / ${r.seats.length}</span></td>
        <td class="num">${fmt(h.wagered)}</td>
        <td class="num">${fmt(h.paid)}</td>
        <td class="num ${h.profit > 0 ? 'pos' : h.profit < 0 ? 'neg' : 'dim'}">${h.bets ? fmtSigned(h.profit) : '—'}</td>
      </tr>${detail}`;
  }).join('');

  body.querySelectorAll('tr.clickable').forEach((row) => {
    row.addEventListener('click', () => {
      openRound = openRound === row.dataset.round ? null : row.dataset.round;
      if (lastData) renderRounds(lastData.rounds);
    });
  });
}

function detailRow(r) {
  if (!r.seats.length) {
    return '<tr class="detail-row"><td colspan="8"><div class="detail-box dim">لم يشارك أحد في هذه الجولة.</div></td></tr>';
  }
  const chips = r.seats
    .slice()
    .sort((a, b) => b.stake - a.stake)
    .map((s) => `
      <div class="seat-chip${s.isBot ? ' is-bot' : ''}">
        <b>${escapeHtml(s.id)}</b>${s.isBot ? '<span class="badge-bot">BOT</span>' : ''}${s.capped ? `<span class="badge-cap">سقف ×${s.multiplier}</span>` : ''}
        <div class="row2"><span class="dim">كرت ${s.cardIndex + 1}${s.auto ? ' (تلقائي)' : ''}</span><span>×${s.cardValue}</span></div>
        <div class="row2"><span class="dim">راهن ${fmt(s.stake)}</span><span class="${s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : 'dim'}">${fmtSigned(s.net)}</span></div>
      </div>`).join('');

  return `
    <tr class="detail-row">
      <td colspan="8">
        <div class="detail-box">
          <h4>تفاصيل لاعبي ${escapeHtml(r.roundId)} · البذرة: <span class="mono">${escapeHtml(r.serverSeed.slice(0, 32))}…</span></h4>
          <div class="seat-chips">${chips}</div>
        </div>
      </td>
    </tr>`;
}

function renderPlayers(players) {
  const body = el('playersBody');
  if (!body) return;
  el('playersHint').textContent = `${players.length} لاعب مسجّل`;
  if (!players.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">لا يوجد لاعبون بعد.</td></tr>';
    return;
  }
  body.innerHTML = players.map((p) => {
    const pName = p.username || p.display_id || p.id;
    let cashierBadge = '<span class="badge-direct">مباشر (إدارة)</span>';
    if (p.cashierName) {
      cashierBadge = `<span class="badge-cashier" title="كاشير: ${escapeHtml(p.cashierName)}">💼 ${escapeHtml(p.cashierName)}</span>`;
      if (p.masterName) {
        cashierBadge += ` <span class="badge-master" title="ماستر: ${escapeHtml(p.masterName)}">👑 ${escapeHtml(p.masterName)}</span>`;
      }
    }
    return `
    <tr>
      <td class="mono"><b>${escapeHtml(pName)}</b></td>
      <td>${cashierBadge}</td>
      <td class="num">${fmt(p.balance)}</td>
      <td class="num">${fmt(p.rounds)}</td>
      <td class="num">${fmt(p.wagered)}</td>
      <td class="num">${fmt(p.won)}</td>
      <td class="num ${p.houseNet > 0 ? 'pos' : p.houseNet < 0 ? 'neg' : 'dim'}">${fmtSigned(p.houseNet)}</td>
      <td>
        <span class="rowbtns">
          <button class="btn-del" data-pa="delete" data-id="${p.realId || p.id}" data-name="${escapeHtml(pName)}" title="حذف حساب اللاعب نهائياً من قاعدة البيانات">🗑️ حذف</button>
        </span>
      </td>
    </tr>`;
  }).join('');
}

if (el('playersBody')) {
  el('playersBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pa="delete"]');
    if (!b) return;
    const id = b.dataset.id;
    const name = b.dataset.name || 'هذا اللاعب';
    if (!confirm(`هل أنت متأكد من حذف حساب اللاعب "${name}" نهائياً؟\nسيتم حذفه بالكامل من قاعدة البيانات.`)) return;
    b.disabled = true;
    try {
      await adminPost('/api/admin/account/delete', { accountId: id });
      toast(`تم حذف حساب اللاعب "${name}" بنجاح`, 'win');
      await loadOwner();
    } catch (err) {
      toast(`تعذّر الحذف: ${err.message}`, 'error', 6000);
      b.disabled = false;
    }
  });
}

el('newPlayerAdminForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('npaBtn');
  const out = el('npaOut');
  btn.disabled = true;
  out.hidden = true;
  const username = el('npaUser').value.trim();
  const password = el('npaPass').value;
  const cashierId = el('npaCashier').value || null;
  const balance = Number(el('npaBalance').value) || 0;
  try {
    const res = await adminPost('/api/admin/player', { username, password, cashierId, balance });
    out.hidden = false;
    out.className = 'newplayer__out ok';
    out.innerHTML = `✅ تم إنشاء اللاعب <b>${escapeHtml(res.player.username)}</b> بنجاح! المعرّف: <code>${escapeHtml(res.player.display_id || res.player.id)}</code> · كلمة المرور: <code>${escapeHtml(password)}</code> · الرصيد: <b>${fmt(res.player.balance || 0)}</b>`;
    el('newPlayerAdminForm').reset();
    toast('تم إنشاء حساب اللاعب بنجاح', 'win');
    await loadOwner();
  } catch (err) {
    out.hidden = false;
    out.className = 'newplayer__out err';
    out.innerHTML = `<b>خطأ:</b> ${escapeHtml(err.message)}`;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function renderRules(s) {
  el('rulesBox').innerHTML = `
    <div class="rule-line"><span>نسبة العائد النظرية للاعبين</span><b>${s.theoreticalRtp}%</b></div>
    <div class="rule-line"><span>هامش الموقع النظري</span><b>${s.houseEdge}%</b></div>
    <div class="rule-line"><span>كروت رابحة في كل جولة</span><b>${s.winnersPerRound} من 12 بالضبط</b></div>
    <div class="rule-line"><span>مدد الجولة (مشاركة/لعب/نتائج)</span><b>${s.timing.betting / 1000} / ${s.timing.playing / 1000} / ${s.timing.results / 1000} ث</b></div>
    <div class="rule-line"><span>سقف المضاعف للمبالغ من ${fmt(s.highStakeThreshold)} فأعلى</span><b>×${s.highStakeMaxMultiplier}</b></div>
    <div class="rule-line"><span>الحد الأقصى للمشاركين بالجولة</span><b>${s.maxPlayers}</b></div>
    <div class="rule-line"><span>اللاعبون الآليون</span><b>${s.botsEnabled ? 'مفعّل' : 'متوقف'}</b></div>`;

  const total = s.templates.reduce((a, t) => a + t.weight, 0);
  el('templatesBody').innerHTML = s.templates
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((t) => `
      <tr>
        <td>${escapeHtml(t.name)}</td>
        <td class="num">${((t.weight / total) * 100).toFixed(0)}%</td>
        <td class="num ${t.winners ? '' : 'dim'}">${t.winners}</td>
        <td class="num dim">${t.refunds}</td>
        <td class="num dim">${t.losers}</td>
        <td class="num">×${t.top}</td>
      </tr>`).join('');
}

function render(d) {
  lastData = d;
  renderKpis(d);
  renderGames(d);
  renderTank(d);
  renderEconomics(d);
  renderChart(d.rounds);
  renderLive(d);
  renderRounds(d.rounds);
  renderPlayers(d.players);
  renderRules(d.settings);
}

/* ------------------------------- التحديث ------------------------------- */
async function refresh(manual) {
  if (!adminKey) return;
  try {
    const data = await adminGet('/api/admin/overview');
    render(data);
    el('refreshNote').textContent = `آخر تحديث ${timeOf(Date.now())}`;
    if (manual) toast('تم التحديث');
  } catch (err) {
    if (err.status === 401) {
      // إعادة فحص سريعة لتجنب ومضات الاتصال المؤقتة
      try {
        await new Promise((r) => setTimeout(r, 600));
        const retryData = await adminGet('/api/admin/overview');
        render(retryData);
        el('refreshNote').textContent = `آخر تحديث ${timeOf(Date.now())}`;
        return;
      } catch (retryErr) {
        if (retryErr.status === 401) {
          showGate('انتهت صلاحية المفتاح أو تغيّر — أدخله من جديد');
          return;
        }
      }
    }
    el('refreshNote').textContent = 'تعذّر التحديث — إعادة المحاولة…';
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, 5000);
}

/* ------------------------------- الإقلاع ------------------------------- */
(async function boot() {
  const status = await keyStatus();

  let saved = null;
  const urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey && urlKey.trim()) {
    saved = urlKey.trim();
  } else {
    try { saved = localStorage.getItem(KEY_STORE); } catch { /* تصفح خاص */ }
  }

  if (saved) {
    try {
      await enterWith(saved);
      el('refreshNote').textContent = `آخر تحديث ${timeOf(Date.now())}`;
      return;
    } catch (err) {
      adminKey = null;
      try { localStorage.removeItem(KEY_STORE); } catch { /* تجاهل */ }
      if (err.status !== 401) return showGate(err.message);
    }
  }

  // لا مفتاح صالح: إن كان الخادم في أول تشغيله نعرض شاشة الإنشاء
  if (status && status.canSetFromBrowser) return showClaim(status);
  showGate(saved ? 'المفتاح المحفوظ لم يعد صالحاً' : '');
})();

/* ═══════════════════════════ صلاحيات المالك ═══════════════════════════ */
let COUNTRIES = [
  { code: 'SY', name: 'سوريا', currency: 'SYP', symbol: 'ل.س' },
  { code: 'LB', name: 'لبنان', currency: 'LBP', symbol: 'ل.ل' },
  { code: 'TR', name: 'تركيا', currency: 'TRY', symbol: '₺' },
  { code: 'IQ', name: 'العراق', currency: 'IQD', symbol: 'د.ع' },
  { code: 'JO', name: 'الأردن', currency: 'JOD', symbol: 'د.أ' },
  { code: 'EG', name: 'مصر', currency: 'EGP', symbol: 'ج.م' },
  { code: 'SA', name: 'السعودية', currency: 'SAR', symbol: 'ر.س' },
  { code: 'AE', name: 'الإمارات', currency: 'AED', symbol: 'د.إ' },
  { code: 'KW', name: 'الكويت', currency: 'KWD', symbol: 'د.ك' },
  { code: 'QA', name: 'قطر', currency: 'QAR', symbol: 'ر.ق' },
  { code: 'BH', name: 'البحرين', currency: 'BHD', symbol: 'د.ب' },
  { code: 'OM', name: 'عُمان', currency: 'OMR', symbol: 'ر.ع' },
  { code: 'YE', name: 'اليمن', currency: 'YER', symbol: 'ر.ي' },
  { code: 'LY', name: 'ليبيا', currency: 'LYD', symbol: 'د.ل' },
  { code: 'SD', name: 'السودان', currency: 'SDG', symbol: 'ج.س' },
  { code: 'DZ', name: 'الجزائر', currency: 'DZD', symbol: 'د.ج' },
  { code: 'MA', name: 'المغرب', currency: 'MAD', symbol: 'د.م' },
  { code: 'TN', name: 'تونس', currency: 'TND', symbol: 'د.ت' },
  { code: 'PS', name: 'فلسطين', currency: 'ILS', symbol: '₪' },
  { code: 'DE', name: 'ألمانيا', currency: 'EUR', symbol: '€' },
  { code: 'SE', name: 'السويد', currency: 'SEK', symbol: 'kr' },
  { code: 'GB', name: 'بريطانيا', currency: 'GBP', symbol: '£' },
  { code: 'US', name: 'الولايات المتحدة', currency: 'USD', symbol: '$' }
];
let TIERS = [];

async function loadOwner() {
  renderCountryOptions();
  try {
    const [games, cash, tiers, db, cs] = await Promise.all([
      adminGet('/api/admin/games').catch(() => ({ games: [] })),
      adminGet('/api/admin/cashiers').catch(() => ({ cashiers: [] })),
      adminGet('/api/admin/tiers').catch(() => ({ tiers: [] })),
      adminGet('/api/admin/database').catch(() => ({ configured: true, reachable: true })),
      COUNTRIES.length ? Promise.resolve({ countries: COUNTRIES }) : adminGet('/api/admin/countries').catch(() => ({ countries: COUNTRIES }))
    ]);
    if (cs && Array.isArray(cs.countries) && cs.countries.length) {
      COUNTRIES = cs.countries;
    }
    TIERS = (tiers && tiers.tiers) || [];
    if (games && games.games) renderGamesToggle(games.games);
    if (db) renderDbStatus(db);
    if (cash) renderCashiers(cash);
    renderCountryOptions();
    renderTiers();
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  }
}

function renderDbStatus(db) {
  const box = el('dbStatus');
  if (!db.configured) {
    box.textContent = '⚠ قاعدة البيانات غير مربوطة — لا حسابات ولا كاشير';
    return;
  }
  box.textContent = db.reachable
    ? `متّصلة${db.pendingDeltas ? ` · ${db.pendingDeltas} فرق بانتظار الكتابة` : ''}`
    : `⚠ غير متاحة: ${db.error}`;
}

function renderGamesToggle(games) {
  el('gamesToggle').innerHTML = (games || []).map((g) => `
    <div class="game-switch ${g.enabled ? 'is-on' : 'is-off'}">
      <span>
        <span class="game-switch__name">${escapeHtml(g.name)}</span>
        <span class="game-switch__state">${g.enabled ? 'تعمل الآن' : 'موقوفة'}</span>
      </span>
      <button type="button" data-game="${g.key}" data-next="${g.enabled ? '0' : '1'}">
        ${g.enabled ? 'أوقفها' : 'شغّلها'}
      </button>
    </div>`).join('');
}

function renderCountryOptions() {
  const sel = el('ncCountry');
  if (!sel) return;
  if (sel.options && sel.options.length >= COUNTRIES.length) return;
  sel.innerHTML = COUNTRIES
    .map((c) => `<option value="${c.code}" ${c.code === 'IQ' ? 'selected' : ''}>${escapeHtml(c.name)} — ${c.currency}</option>`).join('');
}

let CURRENT_CASHIERS = [];

function renderCashiers(data) {
  const list = data.cashiers || [];
  CURRENT_CASHIERS = list;
  el('cashiersEmpty').hidden = list.length > 0;

  // تحديث قائمة الكاشيرية في نموذج إنشاء اللاعب من الإدارة
  const npaSel = el('npaCashier');
  if (npaSel) {
    const curVal = npaSel.value;
    npaSel.innerHTML = '<option value="">بدون كاشير (مباشر للإدارة)</option>' +
      list.map(c => `<option value="${c.id}">${escapeHtml(c.username)} (${escapeHtml(c.country || '')})</option>`).join('');
    if (curVal) npaSel.value = curVal;
  }

  el('cashiersBody').innerHTML = list.map((c) => {
    const cur = c.currency || '';
    const floatVal = c.float_balance != null ? c.float_balance : (c.balance || 0);
    const commRate = Number(c.commission_rate || 0);
    const commAmt = Number(c.commission_amount || 0);
    return `
    <tr>
      <td>
        <span class="player-cell${c.active ? '' : ' is-off'}">
          <b>${escapeHtml(c.username)}</b>
          <span>${c.active ? 'يعمل' : 'موقوف'}${c.email ? ` · ${escapeHtml(c.email)}` : ''}</span>
        </span>
      </td>
      <td class="dim">${escapeHtml(c.country || '—')} ${escapeHtml(cur)}</td>
      <td><b>${c.unlimited_float ? '∞' : fmt(floatVal)}</b></td>
      <td>${fmt(c.player_count || 0)}</td>
      <td>${fmt(c.players_balance || 0)}</td>
      <td class="pos">${fmt(c.burn || 0)}</td>
      <td><b>${commRate.toFixed(0)}%</b><br><span class="dim">${fmt(commAmt)}</span></td>
      <td>
        <span class="rowbtns">
          <button class="btn-eye"   data-ca="view"     data-id="${c.id}" data-name="${escapeHtml(c.username)}" title="عرض تفاصيل الكاشير واللاعبين المسجلين من خلاله">👁️ شبكته</button>
          <button class="b-in"      data-ca="topup"    data-id="${c.id}" title="إرسال وتعبئة عهدة للكاشير">💸 أرسل</button>
          <button class="b-out"     data-ca="debit"    data-id="${c.id}" title="سحب عهدة من الكاشير">📥 اسحب</button>
          <button data-ca="password" data-id="${c.id}" title="تغيير كلمة مرور الكاشير">🔑 كلمة المرور</button>
          <button data-ca="country"  data-id="${c.id}" title="تغيير دولة وعملة الكاشير">🌍 الدولة</button>
          <button data-ca="toggle"   class="${c.active ? 'btn-off' : 'btn-on'}" data-id="${c.id}" data-next="${c.active ? '0' : '1'}" title="${c.active ? 'إيقاف حساب الكاشير' : 'تفعيل حساب الكاشير'}">
            ${c.active ? '🛑 أوقف' : '🟢 شغّل'}
          </button>
          <button class="btn-del"    data-ca="delete" data-id="${c.id}" data-name="${escapeHtml(c.username)}" title="حذف حساب الكاشير نهائياً من قاعدة البيانات">🗑️ حذف</button>
        </span>
      </td>
    </tr>`;
  }).join('');
}

/* ────────────────── نظام النوافذ المنبثقة التفاعلية لإجراءات الكاشير ────────────────── */
const CashierModal = {
  overlay: el('cashierModal'),
  icon: el('cmIcon'),
  title: el('cmTitle'),
  subtitle: el('cmSubtitle'),
  body: el('cmBody'),
  err: el('cmErr'),

  show({ icon, title, subtitle, content, wide = false, onMount }) {
    const box = this.overlay.querySelector('.c-modal-box');
    if (box) box.classList.toggle('c-modal-box--wide', !!wide);
    this.icon.textContent = icon || '💼';
    this.title.textContent = title;
    this.subtitle.textContent = subtitle || '';
    this.err.hidden = true;
    this.err.textContent = '';
    this.body.innerHTML = content;
    this.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    if (typeof onMount === 'function') onMount(this.body);
  },

  hide() {
    const box = this.overlay.querySelector('.c-modal-box');
    if (box) box.classList.remove('c-modal-box--wide');
    this.overlay.hidden = true;
    this.body.innerHTML = '';
    document.body.style.overflow = '';
  },

  showError(msg) {
    this.err.hidden = false;
    this.err.textContent = msg;
  }
};

el('cmCloseBtn').addEventListener('click', () => CashierModal.hide());
CashierModal.overlay.addEventListener('click', (e) => {
  if (e.target === CashierModal.overlay) CashierModal.hide();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !CashierModal.overlay.hidden) CashierModal.hide();
});

function openTopupModal(c) {
  const cur = c.currency || '';
  const currentFloat = c.unlimited_float ? 'عهدة مفتوحة' : `${fmt(c.balance || 0)} ${cur}`;
  CashierModal.show({
    icon: '💸',
    title: `إرسال وتعبئة عهدة للكاشير (${c.username})`,
    subtitle: `العهدة الحالية: ${currentFloat} ${c.email ? '· ' + c.email : ''}`,
    content: `
      <form id="cmTopupForm">
        <div class="cm-field">
          <label for="cmTopupAmount">المبلغ المراد إرساله (${cur}):</label>
          <input type="number" id="cmTopupAmount" min="1" step="1" placeholder="مثال: 500000" required autofocus>
          <div class="cm-chips">
            <button type="button" class="cm-chip" data-add="50000">+50,000</button>
            <button type="button" class="cm-chip" data-add="100000">+100,000</button>
            <button type="button" class="cm-chip" data-add="250000">+250,000</button>
            <button type="button" class="cm-chip" data-add="500000">+500,000</button>
            <button type="button" class="cm-chip" data-add="1000000">+1,000,000</button>
            <button type="button" class="cm-chip" data-add="5000000">+5,000,000</button>
          </div>
        </div>
        <div class="cm-field">
          <label for="cmTopupNote">ملاحظة العملية (اختياري):</label>
          <input type="text" id="cmTopupNote" placeholder="تعبئة عهدة من الإدارة">
        </div>
        <div class="cm-actions">
          <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
          <button type="submit" class="btn btn--gold" id="cmTopupSubmit">💸 تأكيد الإرسال</button>
        </div>
      </form>
    `,
    onMount(container) {
      const inp = container.querySelector('#cmTopupAmount');
      container.querySelectorAll('.cm-chip[data-add]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const add = Number(btn.dataset.add) || 0;
          inp.value = (Number(inp.value) || 0) + add;
          inp.focus();
        });
      });

      container.querySelector('#cmTopupForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = Number(inp.value);
        if (!Number.isInteger(amount) || amount <= 0) {
          return CashierModal.showError('يرجى كتابة مبلغ صحيح أكبر من الصفر');
        }
        const note = container.querySelector('#cmTopupNote').value.trim();
        const submitBtn = container.querySelector('#cmTopupSubmit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جارٍ الإرسال…';
        try {
          const out = await adminPost('/api/admin/cashier/float', {
            cashierId: c.id,
            amount,
            topup: true,
            note: note || undefined
          });
          CashierModal.hide();
          toast(`تم إرسال ${fmt(amount)} ${cur} للكاشير ${c.username} بنجاح! العهدة الآن: ${fmt(out.cashier_balance)}`, 'win');
          await loadOwner();
        } catch (err) {
          CashierModal.showError(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = '💸 تأكيد الإرسال';
        }
      });
    }
  });
}

function openDebitModal(c) {
  const cur = c.currency || '';
  const currentBal = Number(c.balance || 0);
  const currentFloat = c.unlimited_float ? 'عهدة مفتوحة' : `${fmt(currentBal)} ${cur}`;
  CashierModal.show({
    icon: '📥',
    title: `سحب عهدة من الكاشير (${c.username})`,
    subtitle: `العهدة المتوفرة حالياً: ${currentFloat} ${c.email ? '· ' + c.email : ''}`,
    content: `
      <form id="cmDebitForm">
        <div class="cm-field">
          <label for="cmDebitAmount">المبلغ المراد سحبه (${cur}):</label>
          <input type="number" id="cmDebitAmount" min="1" ${c.unlimited_float ? '' : `max="${currentBal}"`} step="1" placeholder="مثال: 200000" required autofocus>
          <div class="cm-chips">
            <button type="button" class="cm-chip" data-set="50000">50,000</button>
            <button type="button" class="cm-chip" data-set="100000">100,000</button>
            <button type="button" class="cm-chip" data-set="500000">500,000</button>
            <button type="button" class="cm-chip" data-set="1000000">1,000,000</button>
            ${!c.unlimited_float && currentBal > 0 ? `<button type="button" class="cm-chip" data-set="${currentBal}">سحب كامل العهدة (${fmt(currentBal)})</button>` : ''}
          </div>
        </div>
        <div class="cm-field">
          <label for="cmDebitNote">ملاحظة العملية (اختياري):</label>
          <input type="text" id="cmDebitNote" placeholder="سحب عهدة من الإدارة">
        </div>
        <div class="cm-actions">
          <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
          <button type="submit" class="btn btn--red" id="cmDebitSubmit" style="background:#e0507f;color:#fff">📥 تأكيد السحب</button>
        </div>
      </form>
    `,
    onMount(container) {
      const inp = container.querySelector('#cmDebitAmount');
      container.querySelectorAll('.cm-chip[data-set]').forEach((btn) => {
        btn.addEventListener('click', () => {
          inp.value = Number(btn.dataset.set) || 0;
          inp.focus();
        });
      });

      container.querySelector('#cmDebitForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = Number(inp.value);
        if (!Number.isInteger(amount) || amount <= 0) {
          return CashierModal.showError('يرجى كتابة مبلغ صحيح أكبر من الصفر');
        }
        if (!c.unlimited_float && amount > currentBal) {
          return CashierModal.showError(`المبلغ المطلوب سحبه أكبر من عهدة الكاشير الحالية (${fmt(currentBal)} ${cur})`);
        }
        const note = container.querySelector('#cmDebitNote').value.trim();
        const submitBtn = container.querySelector('#cmDebitSubmit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جارٍ السحب…';
        try {
          const out = await adminPost('/api/admin/cashier/float', {
            cashierId: c.id,
            amount,
            topup: false,
            note: note || undefined
          });
          CashierModal.hide();
          toast(`تم سحب ${fmt(amount)} ${cur} من عهدة ${c.username}. العهدة المتبقية: ${fmt(out.cashier_balance)}`, 'win');
          await loadOwner();
        } catch (err) {
          CashierModal.showError(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = '📥 تأكيد السحب';
        }
      });
    }
  });
}

function openCountryModal(c) {
  const currentCode = (c.country || '').toUpperCase();
  const currentCur = c.currency || '';
  const optionsHtml = COUNTRIES.map((item) => {
    const isSel = item.code.toUpperCase() === currentCode;
    return `<option value="${item.code}" ${isSel ? 'selected' : ''}>${escapeHtml(item.name)} — ${item.currency} (${item.symbol || ''})</option>`;
  }).join('');

  CashierModal.show({
    icon: '🌍',
    title: `تغيير دولة وعملة الكاشير (${c.username})`,
    subtitle: `الدولة الحالية: ${c.country || 'غير محددة'} · العملة: ${currentCur}`,
    content: `
      <form id="cmCountryForm">
        <div class="cm-field">
          <label for="cmCountrySelect">اختر الدولة والعملة الجديدة:</label>
          <select id="cmCountrySelect" required>
            ${optionsHtml}
          </select>
        </div>
        <div class="cm-warn-box">
          ℹ️ <b>تنبيه اقتصادي:</b> تغيير الدولة يُعيّن العملة الجديدة رسمياً لحساب الكاشير وجميع اللاعبين المسجلين عبره.
        </div>
        <div class="cm-actions">
          <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
          <button type="submit" class="btn btn--gold" id="cmCountrySubmit">💾 حفظ الدولة والعملة</button>
        </div>
      </form>
    `,
    onMount(container) {
      container.querySelector('#cmCountryForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = container.querySelector('#cmCountrySelect').value;
        const submitBtn = container.querySelector('#cmCountrySubmit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جارٍ الحفظ…';
        try {
          const out = await adminPost('/api/admin/cashier/country', {
            cashierId: c.id,
            country: code
          });
          CashierModal.hide();
          toast(`تم تغيير دولة الكاشير ${c.username} إلى ${out.name} — العملة (${out.currency})`, 'win');
          await loadOwner();
        } catch (err) {
          CashierModal.showError(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = '💾 حفظ الدولة والعملة';
        }
      });
    }
  });
}

function openToggleModal(c, next) {
  CashierModal.show({
    icon: next ? '🟢' : '🛑',
    title: next ? `تفعيل حساب الكاشير (${c.username})` : `إيقاف حساب الكاشير (${c.username})`,
    subtitle: `${c.username} ${c.email ? '· ' + c.email : ''}`,
    content: `
      <form id="cmToggleForm">
        <div class="${next ? 'cm-success-box' : 'cm-warn-box'}">
          ${next
            ? `هل تريد بالتأكيد <b>إعادة تفعيل</b> حساب الكاشير <b>${escapeHtml(c.username)}</b>؟<br>سيتمكن من تسجيل الدخول إلى بوابة الكاشير واستئناف شحن وسحب أرصدة اللاعبين.`
            : `هل أنت متأكد من <b>إيقاف</b> حساب الكاشير <b>${escapeHtml(c.username)}</b>؟<br>سيتم إنهاء جلسته فوراً ومنعه من تسجيل الدخول أو إجراء أي عمليات مالية حتى تعيد تفعيله.`}
        </div>
        <div class="cm-actions">
          <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
          <button type="submit" class="btn ${next ? 'btn--gold' : 'btn--red'}" style="${next ? '' : 'background:#e0507f;color:#fff'}" id="cmToggleSubmit">
            ${next ? '🟢 نعم، تفعيل الكاشير' : '🛑 نعم، إيقاف الكاشير فوراً'}
          </button>
        </div>
      </form>
    `,
    onMount(container) {
      container.querySelector('#cmToggleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = container.querySelector('#cmToggleSubmit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جارٍ التنفيذ…';
        try {
          await adminPost('/api/admin/cashier/toggle', {
            cashierId: c.id,
            active: next
          });
          CashierModal.hide();
          toast(next ? `تم تفعيل حساب الكاشير ${c.username} بنجاح` : `تم إيقاف حساب الكاشير ${c.username}`, 'win');
          await loadOwner();
        } catch (err) {
          CashierModal.showError(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = next ? '🟢 نعم، تفعيل الكاشير' : '🛑 نعم، إيقاف الكاشير فوراً';
        }
      });
    }
  });
}

function openPasswordModal(c) {
  CashierModal.show({
    icon: '🔑',
    title: `تغيير كلمة المرور للكاشير (${c.username})`,
    subtitle: `${c.username} ${c.email ? '· ' + c.email : ''}`,
    content: `
      <form id="cmPassForm">
        <div class="cm-field">
          <label for="cmNewPassInput">كلمة المرور الجديدة (6 خانات فأكثر):</label>
          <div class="field-row">
            <input type="text" id="cmNewPassInput" minlength="6" placeholder="اكتب كلمة مرور أو اضغط 🎲" required autofocus>
            <button type="button" class="btn btn--dark btn--sm" id="cmGenBtn">🎲 توليد</button>
          </div>
        </div>
        <div class="cm-actions">
          <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
          <button type="submit" class="btn btn--gold" id="cmPassSubmit">💾 حفظ كلمة المرور</button>
        </div>
      </form>
      <div id="cmPassResult" hidden style="margin-top:14px"></div>
    `,
    onMount(container) {
      const inp = container.querySelector('#cmNewPassInput');
      container.querySelector('#cmGenBtn').addEventListener('click', () => {
        inp.value = randomKey().slice(0, 10);
        inp.focus();
        inp.select();
      });

      container.querySelector('#cmPassForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pass = inp.value.trim();
        if (pass.length < 6) {
          return CashierModal.showError('يجب ألا تقل كلمة المرور عن 6 خانات');
        }
        const submitBtn = container.querySelector('#cmPassSubmit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'جارٍ الحفظ…';
        try {
          await adminPost('/api/admin/cashier/password', {
            cashierId: c.id,
            password: pass
          });
          toast(`تم تغيير كلمة مرور الكاشير ${c.username} بنجاح`, 'win');
          const resBox = container.querySelector('#cmPassResult');
          resBox.hidden = false;
          resBox.innerHTML = `
            <div class="cm-success-box">
              ✅ <b>تم تغيير كلمة المرور بنجاح!</b><br>
              سلّم الكاشير كلمة المرور الجديدة الآن (لن تظهر لاحقاً):
              <code>${escapeHtml(pass)}</code>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button type="button" class="btn btn--dark btn--sm" id="cmCopyPassBtn">📋 نسخ كلمة المرور</button>
                <button type="button" class="btn btn--gold btn--sm" onclick="CashierModal.hide()">إغلاق النافذة</button>
              </div>
            </div>
          `;
          container.querySelector('#cmCopyPassBtn').addEventListener('click', () => {
            navigator.clipboard.writeText(pass)
              .then(() => toast('تم نسخ كلمة المرور', 'win'))
              .catch(() => toast(pass));
          });
          container.querySelector('#cmPassForm').hidden = true;
          await loadOwner();
        } catch (err) {
          CashierModal.showError(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = '💾 حفظ كلمة المرور';
        }
      });
    }
  });
}

function openCashierDeleteModal(c) {
  CashierModal.show({
    icon: '🗑️',
    title: `حذف حساب الكاشير: ${c.username}`,
    subtitle: 'تحذير: سيتم مسح حساب الكاشير نهائياً من قاعدة البيانات',
    content: `
      <div style="background:rgba(235,47,47,0.08);border:1px solid rgba(235,47,47,0.3);border-radius:10px;padding:14px;margin-bottom:16px;color:#ff7675;font-size:13px;line-height:1.6">
        ⚠️ <b>تنبيه هام:</b> سيتم حذف حساب الكاشير <b>${escapeHtml(c.username)}</b> (${escapeHtml(c.display_id || c.id)}) نهائياً من قاعدة البيانات (Supabase)، وفك ارتباط اللاعبين التابعين له ومسح أي سجلات مرتبطة. هذا الإجراء نهائي ولا يمكن التراجع عنه.
      </div>
      <div class="cm-actions">
        <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
        <button type="button" class="btn" style="background:#d63031;color:#fff;border:none;padding:8px 16px;font-weight:bold" id="cmConfirmCashierDelete">🗑️ نعم، احذف الكاشير نهائياً</button>
      </div>
    `,
    onMount(container) {
      const btn = container.querySelector('#cmConfirmCashierDelete');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'جارٍ الحذف من قاعدة البيانات…';
        try {
          await adminPost('/api/admin/account/delete', { accountId: c.id });
          CashierModal.hide();
          toast(`تم حذف حساب الكاشير "${c.username}" نهائياً من قاعدة البيانات`, 'win');
          await loadOwner();
        } catch (err) {
          CashierModal.showError(err.message);
          btn.disabled = false;
          btn.textContent = '🗑️ نعم، احذف الكاشير نهائياً';
        }
      });
    }
  });
}

/* ─────────────── إنشاء كاشير جديد ─────────────── */
el('newCashierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('ncBtn');
  const out = el('ncOut');
  btn.disabled = true;
  out.hidden = true;

  const username = el('ncUser').value.trim();
  const email    = el('ncEmail').value.trim();
  const password = el('ncPass').value;
  const country  = el('ncCountry').value;
  const startingFloat = Number(el('ncFloat').value) || 0;
  const unlimited = el('ncUnlimited').checked;

  try {
    const result = await adminPost('/api/admin/cashier', { username, email, password, country, startingFloat, unlimited });
    out.hidden = false;
    out.className = 'newplayer__out ok';
    out.innerHTML = `✅ تم إنشاء الكاشير <b>${escapeHtml(username)}</b> بنجاح.`;
    el('newCashierForm').reset();
    toast('تم إنشاء الكاشير', 'win');

    // أضف الكاشير فوراً للجدول بدون انتظار loadOwner
    if (result && result.cashier) {
      const c = result.cashier;
      // ضمان وجود الحقول الأساسية
      c.player_count = c.player_count || 0;
      c.players_balance = c.players_balance || 0;
      c.burn = c.burn || 0;
      c.commission_rate = c.commission_rate || 5;
      c.commission_amount = c.commission_amount || 0;
      c.active = c.active !== false;
      c.country = c.country || country;
      c.currency = c.currency || '';
      c.email = c.email || email;
      CURRENT_CASHIERS.push(c);
      renderCashiers({ cashiers: CURRENT_CASHIERS });
    }

    // تحديث كامل في الخلفية
    loadOwner().catch(() => {});
  } catch (err) {
    out.hidden = false;
    out.className = 'newplayer__out err';
    out.innerHTML = `<b>خطأ:</b> ${escapeHtml(err.message)}`;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});


el('cashiersBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ca]');
  if (!b) return;
  const id = b.dataset.id;
  const what = b.dataset.ca;
  const cashier = CURRENT_CASHIERS.find((x) => x.id === id);
  if (!cashier) return toast('بيانات الكاشير غير متوفرة، جاري التحديث…', 'error');

  if (what === 'view') {
    openCashierNetworkModal(cashier);
  } else if (what === 'topup') {
    openTopupModal(cashier);
  } else if (what === 'debit') {
    openDebitModal(cashier);
  } else if (what === 'country') {
    openCountryModal(cashier);
  } else if (what === 'toggle') {
    const next = b.dataset.next === '1';
    openToggleModal(cashier, next);
  } else if (what === 'password') {
    openPasswordModal(cashier);
  } else if (what === 'delete') {
    openCashierDeleteModal(cashier);
  }
});

async function openCashierNetworkModal(c) {
  CashierModal.show({
    icon: '💼',
    title: `شبكة الكاشير: ${c.username}`,
    subtitle: 'جارٍ تحميل قائمة اللاعبين وحركاتهم المالية…',
    wide: true,
    content: `<div style="text-align:center;padding:40px;color:var(--txt-2)">⏳ جارٍ جلب شبكة الكاشير واللاعبين…</div>`
  });

  try {
    const res = await adminGet('/api/admin/cashier/network?cashier=' + encodeURIComponent(c.id));
    const cashier = res.cashier || c;
    const players = res.players || [];
    const cur = cashier.currency || c.currency || 'IQD';
    const totalPlayersBal = players.reduce((s, p) => s + Number(p.balance || 0), 0);
    const totalDeposited = players.reduce((s, p) => s + Number(p.total_deposited || 0), 0);
    const totalWithdrawn = players.reduce((s, p) => s + Number(p.total_withdrawn || 0), 0);
    const floatVal = cashier.unlimited_float ? '∞' : fmt(cashier.float_balance != null ? cashier.float_balance : (cashier.balance || 0));
    const masterLabel = cashier.master_username ? `👑 ${escapeHtml(cashier.master_username)}` : 'مباشر تحت الإدارة';

    const playersRows = players.length ? players.map((p) => {
      const pName = p.username || p.display_id || p.id;
      const createdStr = p.created_at ? new Date(p.created_at).toLocaleDateString('ar-EG') : '—';
      return `
        <tr>
          <td><b class="mono">${escapeHtml(pName)}</b><br><span class="dim" style="font-size:11px">${escapeHtml(p.display_id || '')}</span></td>
          <td class="num"><b>${fmt(p.balance)}</b> ${cur}</td>
          <td class="num tag-in">${fmt(p.total_deposited || 0)}</td>
          <td class="num tag-out">${fmt(p.total_withdrawn || 0)}</td>
          <td class="num ${p.game_pl > 0 ? 'pos' : p.game_pl < 0 ? 'neg' : 'dim'}">${p.game_pl ? fmtSigned(p.game_pl) : '0'}</td>
          <td><span class="${p.active ? 'pos' : 'neg'}">${p.active ? 'نشط' : 'موقوف'}</span></td>
          <td class="dim" style="font-size:11px">${createdStr}</td>
        </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty-cell">لا يوجد لاعبون مسجلون عبر هذا الكاشير حتى الآن.</td></tr>`;

    const html = `
      <div class="net-kpis">
        <div class="net-kpi net-kpi--gold">
          <span class="net-kpi__lbl">العهدة الحالية</span>
          <span class="net-kpi__val">${floatVal} ${cur}</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">الماستر المشرف</span>
          <span class="net-kpi__val" style="font-size:14px">${masterLabel}</span>
        </div>
        <div class="net-kpi net-kpi--blue">
          <span class="net-kpi__lbl">عدد اللاعبين</span>
          <span class="net-kpi__val">${players.length} لاعب</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">إجمالي أرصدة لاعبيه</span>
          <span class="net-kpi__val">${fmt(totalPlayersBal)} ${cur}</span>
        </div>
        <div class="net-kpi net-kpi--pos">
          <span class="net-kpi__lbl">إجمالي الإيداعات</span>
          <span class="net-kpi__val">${fmt(totalDeposited)}</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">إجمالي السحوبات</span>
          <span class="net-kpi__val">${fmt(totalWithdrawn)}</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">حرق الكاشير (Burn)</span>
          <span class="net-kpi__val">${fmt(cashier.burn || 0)}</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">العمولة المستحقة</span>
          <span class="net-kpi__val">${Number(cashier.commission_rate || 5)}% (${fmt(cashier.commission_amount || 0)})</span>
        </div>
      </div>

      <div style="margin-top:14px">
        <div style="font-weight:800;font-size:14px;margin-bottom:8px;color:#fff;display:flex;align-items:center;justify-content:space-between">
          <span>🎮 اللاعبون المسجلون عن طريق الكاشير (${players.length})</span>
          <span class="dim" style="font-size:12px">الدولة: ${escapeHtml(cashier.country || '—')}</span>
        </div>
        <div class="table-wrap" style="max-height:360px;overflow-y:auto">
          <table class="dt dt--compact">
            <thead>
              <tr>
                <th>اللاعب / المعرف</th>
                <th>الرصيد</th>
                <th>إيداعاته</th>
                <th>سحوباته</th>
                <th>صافي لعبه</th>
                <th>الحالة</th>
                <th>تاريخ التسجيل</th>
              </tr>
            </thead>
            <tbody>
              ${playersRows}
            </tbody>
          </table>
        </div>
      </div>
      <div class="cm-actions" style="margin-top:16px">
        <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إغلاق النافذة</button>
      </div>
    `;

    CashierModal.show({
      icon: '💼',
      title: `شبكة الكاشير: ${cashier.username}`,
      subtitle: `المعرف: ${cashier.display_id || cashier.id} · الدولة: ${cashier.country || ''} (${cur})`,
      wide: true,
      content: html
    });
  } catch (err) {
    CashierModal.showError('تعذّر جلب شبكة الكاشير: ' + err.message);
  }
}

function renderTiers() {
  const tbody = el('tiersBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!Array.isArray(TIERS) || !TIERS.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:12px">لا توجد شرائح عمولة محددة</td></tr>';
    return;
  }
  TIERS.forEach((t, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <input type="number" class="tier-input" data-t="${idx}" data-f="min_burn" value="${Number(t.min_burn) || 0}" min="0" step="1000" style="width:120px;padding:4px 8px;background:#111827;border:1px solid #374151;color:#fff;border-radius:4px">
      </td>
      <td>
        <input type="number" class="tier-input" data-t="${idx}" data-f="rate" value="${Number(t.rate) || 0}" min="0" max="100" step="0.5" style="width:75px;padding:4px 8px;background:#111827;border:1px solid #374151;color:#fff;border-radius:4px"> %
      </td>
      <td>
        <input type="text" class="tier-input" data-t="${idx}" data-f="label" value="${escapeHtml(t.label || '')}" placeholder="وصف الشريحة" style="width:100%;max-width:200px;padding:4px 8px;background:#111827;border:1px solid #374151;color:#fff;border-radius:4px">
      </td>
      <td style="text-align:center">
        ${idx === 0 ? '<span style="color:#6b7280;font-size:0.75rem">أساسي</span>' : `<button type="button" class="btn btn--del btn--sm" data-del="${idx}" title="حذف الشريحة" style="padding:2px 8px;color:#ef4444;background:transparent;border:none;cursor:pointer;font-size:1.1rem">✕</button>`}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

el('tiersBody').addEventListener('input', (e) => {
  const inp = e.target.closest('.tier-input');
  if (!inp) return;
  const t = TIERS[Number(inp.dataset.t)];
  if (!t) return;
  const f = inp.dataset.f;
  t[f] = f === 'label' ? inp.value : Number(inp.value);
});

el('tiersBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-del]');
  if (!b) return;
  TIERS.splice(Number(b.dataset.del), 1);
  renderTiers();
});

el('tierAdd').addEventListener('click', () => {
  const last = TIERS[TIERS.length - 1] || { min_burn: 0, rate: 20 };
  TIERS.push({ min_burn: Number(last.min_burn) + 100000, rate: Math.min(100, Number(last.rate) + 5), label: '' });
  renderTiers();
});

el('tierSave').addEventListener('click', async () => {
  const box = el('tiersErr');
  box.hidden = true;
  try {
    const out = await adminPost('/api/admin/tiers', { tiers: TIERS });
    TIERS = out.tiers;
    renderTiers();
    toast('حُفظت الشرائح — تُطبَّق فوراً على كل الكاشيرية', 'win');
    await loadOwner();
  } catch (err) {
    box.hidden = false;
    box.textContent = err.message;
  }
});

/* ------------------- إدارة دومين الإدارة والرابط السري ------------------- */
async function loadDomainConfig() {
  try {
    const data = await adminGet('/api/admin/domain');
    if (data.adminDomain) {
      el('adminDomainInput').value = data.adminDomain;
      el('domainHint').textContent = `مفعّل: ${data.adminDomain}`;
    } else {
      el('adminDomainInput').value = '';
      el('domainHint').textContent = 'غير محدد (يعمل بالرابط السري)';
    }
  } catch (err) {
    console.error('فشل جلب دومين الإدارة:', err);
  }
}

el('saveDomainBtn').addEventListener('click', async () => {
  const box = el('domainErr');
  const res = el('domainResult');
  box.hidden = true;
  res.hidden = true;
  const domain = el('adminDomainInput').value.trim();
  try {
    const out = await adminPost('/api/admin/domain', { domain });
    res.hidden = false;
    if (out.adminDomain) {
      el('domainResultLabel').innerHTML = `✅ تم حفظ دومين الإدارة بنجاح: <b>${escapeHtml(out.adminDomain)}</b>.<br>لوحة الإدارة الآن محجوبة وتُرجع 404 على أي دومين آخر!`;
      el('domainHint').textContent = `مفعّل: ${out.adminDomain}`;
    } else {
      el('domainResultLabel').textContent = 'تم إلغاء دومين الإدارة (تعمل اللوحة عبر الرابط السري الآن).';
      el('domainHint').textContent = 'يعمل بالرابط السري';
    }
    toast('تم حفظ إعدادات دومين الإدارة', 'win');
  } catch (err) {
    box.hidden = false;
    box.textContent = err.message;
  }
});

el('rotateGateBtn').addEventListener('click', async () => {
  if (!confirm('سيتوقف الرابط السري الحالي ويتم توليد رابط سري جديد. هل تريد المتابعة؟')) return;
  try {
    const out = await adminPost('/api/admin/gate/path', {});
    el('gateResult').hidden = false;
    const fullUrl = location.origin + '/' + out.path;
    el('gateValue').textContent = fullUrl;
    toast('تم توليد رابط سري جديد', 'win');
  } catch (err) {
    toast(err.message, 'error');
  }
});

el('copyGateBtn').addEventListener('click', () => {
  const txt = el('gateValue').textContent;
  if (!txt) return;
  navigator.clipboard.writeText(txt).then(() => toast('تم نسخ الرابط السري', 'win')).catch(() => toast(txt));
});

/* ═══════════════════════════ الماسترية ═══════════════════════════ */
let MASTERS = [];

async function loadMasters() {
  try {
    const out = await adminGet('/api/admin/masters');
    MASTERS = out.masters || [];
    renderMasters();
    renderMasterCountries();
  } catch (err) {
    if (err.status !== 401) console.warn('masters:', err.message);
  }
}

function renderMasterCountries() {
  const sel = el('nmCountry');
  if (!sel || sel.options.length || !COUNTRIES.length) return;
  sel.innerHTML = COUNTRIES
    .map((c) => `<option value="${c.code}">${escapeHtml(c.name)} — ${c.currency}</option>`).join('');
}

function renderMasters() {
  el('mastersEmpty').hidden = MASTERS.length > 0;
  el('mastersBody').innerHTML = MASTERS.map((m) => `
    <tr>
      <td>
        <span class="player-cell${m.active ? '' : ' is-off'}">
          <b>${escapeHtml(m.username)}</b>
          <span>${m.active ? 'يعمل' : 'موقوف'}</span>
        </span>
      </td>
      <td class="dim">${escapeHtml(m.country || '—')} ${escapeHtml(m.currency || '')}</td>
      <td><b>${m.unlimited_float ? '∞' : fmt(m.float_balance)}</b></td>
      <td>${fmt(m.cashier_count)}</td>
      <td>${fmt(m.player_count)}</td>
      <td class="tag-in">${fmt(m.received_from_admin)}</td>
      <td class="tag-out">${fmt(m.gave_cashiers)}</td>
      <td class="pos">${fmt(m.burn)}</td>
      <td><b>${Number(m.commission_rate).toFixed(0)}%</b><br><span class="dim">${fmt(m.commission_amount)}</span></td>
      <td>
        <span class="rowbtns">
          <button class="btn-eye"  data-ma="view"   data-id="${m.id}" data-name="${escapeHtml(m.username)}" title="عرض كاشيرية ولاعبي الماستر وإحصائيات شبكته">👁️ شبكته</button>
          <button class="b-in"     data-ma="topup"  data-id="${m.id}" title="إرسال عهدة للماستر">أرسل</button>
          <button class="b-out"    data-ma="debit"  data-id="${m.id}" title="سحب عهدة من الماستر">اسحب</button>
          <button data-ma="chain"  data-id="${m.id}" title="كشف حساب شبكة الماستر">كشفه</button>
          <button data-ma="toggle" data-id="${m.id}" data-next="${m.active ? '0' : '1'}" title="${m.active ? 'إيقاف حساب الماستر' : 'تفعيل حساب الماستر'}">
            ${m.active ? 'أوقف' : 'شغّل'}
          </button>
          <button class="btn-del"  data-ma="delete" data-id="${m.id}" data-name="${escapeHtml(m.username)}" title="حذف حساب الماستر نهائياً من قاعدة البيانات">🗑️ حذف</button>
        </span>
      </td>
    </tr>`).join('');
}

function openMasterDeleteModal(m) {
  CashierModal.show({
    icon: '🗑️',
    title: `حذف حساب الماستر: ${m.username}`,
    subtitle: 'تحذير: سيتم مسح حساب الماستر نهائياً من قاعدة البيانات',
    content: `
      <div style="background:rgba(235,47,47,0.08);border:1px solid rgba(235,47,47,0.3);border-radius:10px;padding:14px;margin-bottom:16px;color:#ff7675;font-size:13px;line-height:1.6">
        ⚠️ <b>تنبيه هام:</b> سيتم حذف حساب الماستر <b>${escapeHtml(m.username)}</b> (${escapeHtml(m.display_id || m.id)}) نهائياً من قاعدة البيانات (Supabase)، وفك ارتباط شبكة الكاشيرية واللاعبين التابعين له. هذا الإجراء نهائي ولا يمكن التراجع عنه.
      </div>
      <div class="cm-actions">
        <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إلغاء</button>
        <button type="button" class="btn" style="background:#d63031;color:#fff;border:none;padding:8px 16px;font-weight:bold" id="cmConfirmMasterDelete">🗑️ نعم، احذف الماستر نهائياً</button>
      </div>
    `,
    onMount(container) {
      const btn = container.querySelector('#cmConfirmMasterDelete');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'جارٍ الحذف من قاعدة البيانات…';
        try {
          await adminPost('/api/admin/account/delete', { accountId: m.id });
          CashierModal.hide();
          toast(`تم حذف حساب الماستر "${m.username}" نهائياً من قاعدة البيانات`, 'win');
          await loadMasters();
        } catch (err) {
          CashierModal.showError(err.message);
          btn.disabled = false;
          btn.textContent = '🗑️ نعم، احذف الماستر نهائياً';
        }
      });
    }
  });
}

el('newMasterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = el('nmOut');
  out.hidden = true;
  el('nmBtn').disabled = true;
  const password = el('nmPass').value;
  const userVal = el('nmUser').value.trim();
  try {
    const payload = {
      username: userVal,
      password,
      country: el('nmCountry').value,
      startingFloat: Number(el('nmFloat').value) || 0
    };
    if (userVal.includes('@')) {
      payload.email = userVal;
    }
    const r = await adminPost('/api/admin/master', payload);
    out.hidden = false;
    out.innerHTML = `<b>أُنشئ الماستر.</b> سلّمه بياناته — كلمة المرور لن تظهر ثانية:
      المستخدم <code>${escapeHtml(r.master.username)}</code>
      · كلمة المرور <code>${escapeHtml(password)}</code>
      · العملة <code>${escapeHtml(r.master.currency)}</code>
      · الدخول من <code>/master</code>`;
    el('newMasterForm').reset();
    await loadMasters();
  } catch (err) {
    out.hidden = false;
    out.innerHTML = `<b style="color:var(--red)">تعذّر الإنشاء:</b> ${escapeHtml(err.message)}`;
  } finally {
    el('nmBtn').disabled = false;
  }
});

el('mastersBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-ma]');
  if (!b) return;
  const id = b.dataset.id;
  const what = b.dataset.ma;
  try {
    if (what === 'view') {
      const m = MASTERS.find((x) => x.id === id) || { username: b.dataset.name || 'الماستر', id };
      openMasterNetworkModal(m);
      return;
    } else if (what === 'topup' || what === 'debit') {
      const raw = prompt(what === 'topup' ? 'المبلغ المُرسل للماستر' : 'المبلغ المسحوب من الماستر');
      if (raw === null) return;
      const amount = Number(raw);
      if (!Number.isInteger(amount) || amount <= 0) return toast('مبلغ غير صالح', 'error');
      const out = await adminPost('/api/admin/master/float', {
        masterId: id, amount, topup: what === 'topup'
      });
      toast(`عهدته الآن ${fmt(out.master_balance)}`, 'win');
    } else if (what === 'toggle') {
      const next = b.dataset.next === '1';
      if (!next && !confirm('إيقاف الماستر يمنعه من الدخول فوراً. متابعة؟')) return;
      await adminPost('/api/admin/master/toggle', { masterId: id, active: next });
      toast(next ? 'شُغّل الماستر' : 'أُوقف الماستر');
    } else if (what === 'chain') {
      const out = await adminGet(`/api/admin/chain?master=${encodeURIComponent(id)}&limit=40`);
      const rows = out.transactions || [];
      toast(rows.length ? `${rows.length} حركة في شبكته — آخرها ${rows[0].direction}` : 'لا حركات بعد', 'info', 6000);
      return;
    } else if (what === 'delete') {
      const m = MASTERS.find((x) => x.id === id) || { username: b.dataset.name || 'الماستر', id };
      openMasterDeleteModal(m);
      return;
    }
    await loadMasters();
  } catch (err) { toast(err.message, 'error', 6000); }
});

async function openMasterNetworkModal(m) {
  CashierModal.show({
    icon: '👑',
    title: `شبكة الماستر: ${m.username}`,
    subtitle: 'جارٍ تحميل كاشيرية ولاعبي الماستر…',
    wide: true,
    content: `<div style="text-align:center;padding:40px;color:var(--txt-2)">⏳ جارٍ جلب شبكة الماستر…</div>`
  });

  try {
    const res = await adminGet('/api/admin/master/cashiers?master=' + encodeURIComponent(m.id));
    const master = res.master || m;
    const cashiers = res.cashiers || [];
    const players = res.players || [];
    const cur = master.currency || m.currency || 'IQD';

    const totalCashiersFloat = cashiers.reduce((s, c) => s + Number(c.float_balance != null ? c.float_balance : (c.balance || 0)), 0);
    const totalPlayersBal = players.reduce((s, p) => s + Number(p.balance || 0), 0);
    const totalDeposited = players.reduce((s, p) => s + Number(p.total_deposited || 0), 0);
    const totalWithdrawn = players.reduce((s, p) => s + Number(p.total_withdrawn || 0), 0);
    const floatVal = master.unlimited_float ? '∞' : fmt(master.float_balance != null ? master.float_balance : (master.balance || 0));

    const cashiersRows = cashiers.length ? cashiers.map((c) => {
      const cFloat = c.unlimited_float ? '∞' : fmt(c.float_balance != null ? c.float_balance : (c.balance || 0));
      return `
        <tr>
          <td><b class="mono">${escapeHtml(c.username)}</b><br><span class="dim" style="font-size:11px">${escapeHtml(c.display_id || '')}</span></td>
          <td class="dim">${escapeHtml(c.country || '—')}</td>
          <td class="num"><b>${cFloat}</b> ${cur}</td>
          <td class="num">${fmt(c.player_count || 0)}</td>
          <td class="num">${fmt(c.players_balance || 0)}</td>
          <td class="num pos">${fmt(c.burn || 0)}</td>
          <td>
            <button class="btn-eye btn--sm" data-ca-sub-view="${c.id}" style="padding:4px 8px;font-size:11px">👁️ عرض لاعبيه</button>
          </td>
        </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty-cell">لا يوجد كاشيرية مسجلون تحت هذا الماستر بعد.</td></tr>`;

    const playersRows = players.length ? players.map((p) => {
      const pName = p.username || p.display_id || p.id;
      return `
        <tr>
          <td><b class="mono">${escapeHtml(pName)}</b></td>
          <td><span class="badge-cashier">💼 ${escapeHtml(p.cashier_username || 'كاشير')}</span></td>
          <td class="num"><b>${fmt(p.balance)}</b> ${cur}</td>
          <td class="num tag-in">${fmt(p.total_deposited || 0)}</td>
          <td class="num tag-out">${fmt(p.total_withdrawn || 0)}</td>
          <td class="num ${p.game_pl > 0 ? 'pos' : p.game_pl < 0 ? 'neg' : 'dim'}">${p.game_pl ? fmtSigned(p.game_pl) : '0'}</td>
          <td><span class="${p.active ? 'pos' : 'neg'}">${p.active ? 'نشط' : 'موقوف'}</span></td>
        </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty-cell">لا يوجد لاعبون في شبكة هذا الماستر بعد.</td></tr>`;

    const html = `
      <div class="net-kpis">
        <div class="net-kpi net-kpi--gold">
          <span class="net-kpi__lbl">عهدة الماستر</span>
          <span class="net-kpi__val">${floatVal} ${cur}</span>
        </div>
        <div class="net-kpi net-kpi--blue">
          <span class="net-kpi__lbl">كاشيرية الماستر</span>
          <span class="net-kpi__val">${cashiers.length} كاشير</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">إجمالي عهدات كاشيريته</span>
          <span class="net-kpi__val">${fmt(totalCashiersFloat)} ${cur}</span>
        </div>
        <div class="net-kpi net-kpi--blue">
          <span class="net-kpi__lbl">إجمالي لاعبي شبكته</span>
          <span class="net-kpi__val">${players.length} لاعب</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">أرصدة لاعبي الشبكة</span>
          <span class="net-kpi__val">${fmt(totalPlayersBal)} ${cur}</span>
        </div>
        <div class="net-kpi net-kpi--pos">
          <span class="net-kpi__lbl">إيداعات شبكته</span>
          <span class="net-kpi__val">${fmt(totalDeposited)}</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">سحوبات شبكته</span>
          <span class="net-kpi__val">${fmt(totalWithdrawn)}</span>
        </div>
        <div class="net-kpi">
          <span class="net-kpi__lbl">حرق الشبكة (Burn)</span>
          <span class="net-kpi__val">${fmt(master.burn || 0)}</span>
        </div>
      </div>

      <div class="net-tabs">
        <button type="button" class="net-tab is-active" id="mTabCashiers">💼 كاشيرية الماستر (${cashiers.length})</button>
        <button type="button" class="net-tab" id="mTabPlayers">🎮 لاعبو شبكة الماستر (${players.length})</button>
      </div>

      <div id="mPanelCashiers">
        <div class="table-wrap" style="max-height:340px;overflow-y:auto">
          <table class="dt dt--compact">
            <thead>
              <tr>
                <th>الكاشير</th>
                <th>الدولة</th>
                <th>عهدته</th>
                <th>لاعبوه</th>
                <th>أرصدتهم</th>
                <th>حرقه</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              ${cashiersRows}
            </tbody>
          </table>
        </div>
      </div>

      <div id="mPanelPlayers" hidden>
        <div class="table-wrap" style="max-height:340px;overflow-y:auto">
          <table class="dt dt--compact">
            <thead>
              <tr>
                <th>اللاعب / المعرف</th>
                <th>الكاشير المباشر</th>
                <th>الرصيد</th>
                <th>إيداعاته</th>
                <th>سحوباته</th>
                <th>صافي لعبه</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              ${playersRows}
            </tbody>
          </table>
        </div>
      </div>

      <div class="cm-actions" style="margin-top:16px">
        <button type="button" class="btn btn--dark" onclick="CashierModal.hide()">إغلاق النافذة</button>
      </div>
    `;

    CashierModal.show({
      icon: '👑',
      title: `داشبورد شبكة الماستر: ${master.username}`,
      subtitle: `المعرف: ${master.display_id || master.id} · الدولة: ${master.country || ''} (${cur})`,
      wide: true,
      content: html,
      onMount(container) {
        const tabC = container.querySelector('#mTabCashiers');
        const tabP = container.querySelector('#mTabPlayers');
        const panC = container.querySelector('#mPanelCashiers');
        const panP = container.querySelector('#mPanelPlayers');

        tabC?.addEventListener('click', () => {
          tabC.classList.add('is-active');
          tabP.classList.remove('is-active');
          panC.hidden = false;
          panP.hidden = true;
        });

        tabP?.addEventListener('click', () => {
          tabP.classList.add('is-active');
          tabC.classList.remove('is-active');
          panP.hidden = false;
          panC.hidden = true;
        });

        container.querySelectorAll('button[data-ca-sub-view]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const cid = btn.dataset.caSubView;
            const cObj = cashiers.find(x => x.id === cid) || { id: cid };
            openCashierNetworkModal(cObj);
          });
        });
      }
    });
  } catch (err) {
    CashierModal.showError('تعذّر جلب شبكة الماستر: ' + err.message);
  }
}

/* ═══════════════════════ سجلّ الألعاب الخارجية ═══════════════════════ */
let GAMES = [];

async function loadGames() {
  try {
    const out = await adminGet('/api/admin/games/external');
    GAMES = out.games || [];
    renderGamesTable();
  } catch (err) {
    if (err.status !== 401) console.warn('games:', err.message);
  }
}

function renderGamesTable() {
  el('gamesEmpty').hidden = GAMES.length > 0;
  el('gamesBody').innerHTML = GAMES.map((g) => `
    <tr>
      <td><b>${escapeHtml(g.name)}</b></td>
      <td class="mono">${escapeHtml(g.slug)}</td>
      <td class="dim">${escapeHtml(g.category)}</td>
      <td class="dim" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(g.launch_url)}</td>
      <td class="${g.enabled ? 'pos' : 'neg'}">${g.enabled ? 'تعمل' : 'موقوفة'}</td>
      <td>
        <span class="rowbtns">
          <button data-ga="toggle" data-id="${g.id}" data-next="${g.enabled ? '0' : '1'}">
            ${g.enabled ? 'أوقف' : 'شغّل'}
          </button>
          <button data-ga="url"    data-id="${g.id}">الرابط</button>
          <button data-ga="secret" data-id="${g.id}">بدّل المفتاح</button>
          <button data-ga="delete" data-id="${g.id}">حذف</button>
        </span>
      </td>
    </tr>`).join('');
}

el('newGameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = el('ngOut');
  out.hidden = true;
  el('ngBtn').disabled = true;
  try {
    const r = await adminPost('/api/admin/games/external', {
      name: el('ngName').value.trim(),
      slug: el('ngSlug').value.trim().toLowerCase(),
      category: el('ngCat').value,
      launchUrl: el('ngUrl').value.trim(),
      coverUrl: el('ngCover').value.trim() || null,
      config: el('ngConfig').value.trim() || '{}'
    });
    out.hidden = false;
    // المفتاح يُعرض هنا مرة واحدة فقط ولا يُخرجه الخادم بعدها إطلاقاً
    out.innerHTML = `<b>سُجّلت اللعبة.</b> انسخ مفتاح التوقيع الآن — لن يظهر مرة أخرى:
      <code>${escapeHtml(r.secret)}</code>
      رابط اللعب: <code>${location.origin}/play/${escapeHtml(r.game.slug)}</code>`;
    el('newGameForm').reset();
    await loadGames();
  } catch (err) {
    out.hidden = false;
    out.innerHTML = `<b style="color:var(--red)">تعذّر التسجيل:</b> ${escapeHtml(err.message)}`;
  } finally {
    el('ngBtn').disabled = false;
  }
});

el('gamesBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-ga]');
  if (!b) return;
  const id = b.dataset.id;
  const g = GAMES.find((x) => x.id === id);
  const what = b.dataset.ga;
  try {
    if (what === 'toggle') {
      await adminPost('/api/admin/games/external/update', { id, enabled: b.dataset.next === '1' });
      toast(b.dataset.next === '1' ? 'شُغّلت اللعبة' : 'أُوقفت اللعبة');
    } else if (what === 'url') {
      const next = prompt('رابط اللعبة', g ? g.launch_url : '');
      if (next === null) return;
      await adminPost('/api/admin/games/external/update', { id, launchUrl: next.trim() });
      toast('حُفظ الرابط');
    } else if (what === 'secret') {
      if (!confirm('سيتوقف المفتاح الحالي فوراً وتحتاج تحديثه في لعبتك. متابعة؟')) return;
      const r = await adminPost('/api/admin/games/external/secret', { id });
      el('ngOut').hidden = false;
      el('ngOut').innerHTML = `<b>المفتاح الجديد</b> — انسخه الآن، لن يظهر ثانية:<code>${escapeHtml(r.secret)}</code>`;
      toast('بُدِّل المفتاح', 'win');
    } else if (what === 'delete') {
      if (!confirm('حذف اللعبة نهائياً؟ لا تُحذف إن كانت لها حركات لعب.')) return;
      await adminPost('/api/admin/games/external/delete', { id });
      toast('حُذفت اللعبة');
    }
    await loadGames();
  } catch (err) { toast(err.message, 'error', 6000); }
});
