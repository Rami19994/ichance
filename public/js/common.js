/* ==========================================================================
   LuckyArena — أدوات مشتركة: الجلسة، الاتصال بالخادم، الهيكل، التنبيهات
   ========================================================================== */
'use strict';

/* ------------------------------- تنسيق ------------------------------- */
const nf = new Intl.NumberFormat('en-US');

function fmt(n) {
  return nf.format(Math.round(Number(n) || 0));
}

function fmtSigned(n) {
  const v = Math.round(Number(n) || 0);
  return (v > 0 ? '+' : '') + nf.format(v);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------- التنبيهات ------------------------------- */
let toastLayer = null;
function toast(message, kind = 'info', ms = 3200) {
  if (!toastLayer) {
    toastLayer = document.createElement('div');
    toastLayer.className = 'toasts';
    document.body.appendChild(toastLayer);
  }
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--error' : kind === 'win' ? ' toast--win' : ''}`;
  el.textContent = message;
  toastLayer.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ------------------------------- الجلسة ------------------------------- */
const TOKEN_KEY = 'ichance.token';

const Session = {
  token: null,
  player: null,
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) { try { fn(this.player); } catch (e) { console.error(e); } } },

  setPlayer(player) {
    this.player = player;
    this.emit();
  },

  async init() {
    try { this.token = localStorage.getItem(TOKEN_KEY); } catch { this.token = null; }
    const data = await API.post('/api/session', {});
    this.token = data.token;
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch { /* وضع التصفح الخاص */ }
    this.setPlayer(data.player);
    return data;
  },

  async refresh() {
    const data = await API.get('/api/me');
    this.setPlayer(data.player);
    return data.player;
  }
};

/* ------------------------------- الاتصال بالخادم ------------------------------- */
const API = {
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (Session.token) h['X-Player-Token'] = Session.token;
    return h;
  },

  async request(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('تعذّر الاتصال بالخادم');
    }
    let data = null;
    try { data = await res.json(); } catch { /* رد بلا محتوى */ }
    if (!res.ok) throw new Error((data && data.error) || `خطأ ${res.status}`);
    return data;
  },

  get(url) { return this.request('GET', url); },
  post(url, body = {}) { return this.request('POST', url, body); }
};

/* ------------------------------- البث اللحظي ------------------------------- */
class GameStream {
  constructor() {
    this.source = null;
    this.handlers = new Map();
    this.closed = false;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return this;
  }

  fire(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) { try { fn(payload); } catch (e) { console.error(e); } }
  }

  connect() {
    if (this.closed) return;
    const url = `/api/stream${Session.token ? `?token=${encodeURIComponent(Session.token)}` : ''}`;
    this.source = new EventSource(url);

    this.source.addEventListener('state', (e) => {
      try { this.fire('state', JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    this.source.addEventListener('round-end', (e) => {
      try { this.fire('round-end', JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    this.source.addEventListener('open', () => this.fire('open'));
    this.source.addEventListener('error', () => {
      this.fire('offline');
      // EventSource يعيد المحاولة تلقائياً، لا حاجة لإعادة الإنشاء
    });
  }

  close() {
    this.closed = true;
    if (this.source) this.source.close();
  }
}

/* ------------------------------- الأيقونات ------------------------------- */
const ICONS = {
  casino: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="7" y="3" width="12" height="16" rx="2.5"/><path d="M4.5 6.5v11a3 3 0 0 0 3 3h8"/></svg>',
  slots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M9 5v14M15 5v14"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v4.8l3 1.8"/></svg>',
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.3" fill="currentColor" stroke="none"/></svg>',
  wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
  ball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 3c3 3 3 15 0 18M3.5 9h17M3.5 15h17"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 18h16M3.5 7l4 4L12 5l4.5 6 4-4-1.6 9H5.1z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="7" rx="8" ry="3.4"/><path d="M4 7v10c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4V7"/><path d="M4 12c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="9" width="18" height="11" rx="2"/><path d="M3 13h18M12 9v11M12 9S9.5 4.5 7 6.5 12 9 12 9zM12 9s2.5-4.5 5-2.5S12 9 12 9z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.8.7-.8 1.3v.4"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l7.5 3v6c0 4.6-3.2 8-7.5 9.3C7.7 20 4.5 16.6 4.5 12V6z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 6-6 6 6 6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.1-5.8 6.1H1.5l7.5-8.6L1 3h6.7l4.6 5.6zM16.4 19.1h1.8L7.8 4.8H5.9z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.6 4.3 2.9 11.5c-1 .4-1 1.8.1 2.1l4.6 1.4 1.8 5.4c.3.8 1.3 1 1.9.4l2.6-2.5 4.7 3.5c.7.5 1.7.1 1.9-.8l3.1-14.7c.2-1-.8-1.8-1.7-1.4z"/></svg>'
};

/* ------------------------------- الهيكل المشترك ------------------------------- */
const NAV_SECTIONS = [
  {
    items: [
      { id: 'home', label: 'الرئيسية', icon: 'casino', href: '/' },
      { id: 'lucky-cards', label: 'كروت الحظ', icon: 'cards', href: '/lucky-cards', live: true },
      { id: 'slots', label: 'صيّاد الجوائز', icon: 'slots', href: '/bounty-hunter', live: true },
      { id: 'tank', label: 'معركة الدبابات', icon: 'dice', href: '/battle-tanks', live: true }
    ]
  },
  {
    items: [
      { id: 'logout', label: 'تسجيل الخروج', icon: 'help', href: '#logout' }
    ]
  }
];

function renderSidebar(activeId) {
  const groups = NAV_SECTIONS.map((section) => {
    const items = section.items.map((item) => {
      const active = item.id === activeId ? ' is-active' : '';
      const badge = item.live ? '<span class="tag tag--live" style="margin-inline-start:auto"><span class="live-dot"></span>مباشر</span>' : '';
      const tag = item.href ? 'a' : 'button';
      const attrs = item.href ? `href="${item.href}"` : 'type="button"';
      return `<${tag} class="nav__item${active}" ${attrs}>${ICONS[item.icon] || ''}<span>${item.label}</span>${badge}</${tag}>`;
    }).join('');
    return `<div class="nav__group">${items}</div>`;
  }).join('');

  return `
    <div class="sidebar__socials">
      <a class="social-dot" href="#" title="X">${ICONS.x}</a>
      <a class="social-dot" href="#" title="تيليجرام">${ICONS.tg}</a>
    </div>
    <nav class="nav">${groups}</nav>`;
}

function renderTopbar() {
  return `
    <button class="burger" id="burger" aria-label="القائمة">${ICONS.menu}</button>
    <a class="logo" href="/">
      <span class="logo__mark">LA</span>
      <span class="logo__text"><b>LuckyArena</b><span>CASINO & SPORTS</span></span>
    </a>

    <nav class="topbar-nav" id="topbarNav">
      <a href="/#casino" class="topbar-nav__link is-active" data-cat="all">
        <span class="t-en">CASINO</span>
        <span class="t-ar">الكازينو</span>
      </a>
      <a href="/#live-dealers" class="topbar-nav__link" data-cat="table">
        <span class="t-en">LIVE DEALERS</span>
        <span class="t-ar">موزعون مباشرون</span>
      </a>
      <a href="/#crash-games" class="topbar-nav__link" data-cat="crash">
        <span class="t-en">CRASH GAMES</span>
        <span class="t-ar">ألعاب كراش</span>
      </a>
      <a href="/#sports" class="topbar-nav__link" data-cat="skill">
        <span class="t-en">SPORTS</span>
        <span class="t-ar">الرياضة</span>
      </a>
      <a href="/#vip-club" class="topbar-nav__link" data-cat="vip">
        <span class="t-en">VIP CLUB</span>
        <span class="t-ar">نادي VIP</span>
      </a>
    </nav>

    <div class="topbar__spacer"></div>

    <div class="topbar-auth" id="topbarGuestActions">
      <a href="/login" class="btn btn--outline-gold btn--sm" id="topbarLoginBtn">تسجيل الدخول</a>
      <a href="/login" class="btn btn--neon-green btn--sm" id="topbarRegisterBtn">إنشاء حساب</a>
    </div>

    <div class="wallet" id="wallet" hidden>
      <span class="wallet__coin">$</span>
      <span>
        <span class="wallet__label">الرصيد الحقيقي ($)</span>
        <span class="wallet__amount" id="walletAmount">0</span>
      </span>
      <button type="button" class="wallet__deposit-btn" id="topbarDepositBtn" title="شحن الرصيد">+ إيداع</button>
    </div>
    <span class="chip-id" id="playerChip" hidden></span>
    <div class="avatar" id="avatarBtn" title="تغيير الاسم أو نسخ المعرف" hidden></div>
    <button type="button" class="topbar-logout" id="topbarLogoutBtn" title="تسجيل الخروج" hidden>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
    </button>`;
}

/**
 * يبني الشريط الجانبي والعلوي ويربط سلوكهما.
 * @param {string} activeId المعرّف المميز للصفحة الحالية في القائمة
 */
function mountShell(activeId) {
  const sidebar = document.getElementById('sidebar');
  const topbar = document.getElementById('topbar');
  if (sidebar) sidebar.innerHTML = renderSidebar(activeId);
  if (topbar) topbar.innerHTML = renderTopbar();

  const burger = document.getElementById('burger');
  const out = document.querySelector('a[href="#logout"]');
  const topbarLogout = document.getElementById('topbarLogoutBtn');

  const doLogout = async (e) => {
    if (e) e.preventDefault();
    try { await API.post('/api/auth/logout'); } catch { /* نخرج محلياً */ }
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* تصفح خاص */ }
    Session.setPlayer(null);
    location.href = '/login';
  };

  if (out) out.addEventListener('click', doLogout);
  if (topbarLogout) topbarLogout.addEventListener('click', doLogout);

  const depositBtn = document.getElementById('topbarDepositBtn');
  if (depositBtn) {
    depositBtn.addEventListener('click', () => {
      const modal = document.getElementById('depositModal');
      if (modal) modal.hidden = false;
      else toast('يرجى التواصل مع خدمة العملاء لشحن الرصيد', 'info');
    });
  }

  if (burger && sidebar) {
    burger.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.classList.toggle('is-open');
    });
    document.addEventListener('click', (e) => {
      if (sidebar.classList.contains('is-open') && !sidebar.contains(e.target)) {
        sidebar.classList.remove('is-open');
      }
    });
  }

  document.querySelectorAll('[data-soon]').forEach((el) => {
    el.addEventListener('click', () => toast('هذا القسم قيد التطوير', 'info'));
  });

  const avatar = document.getElementById('avatarBtn');
  if (avatar) {
    avatar.title = 'اضغط لنسخ معرّفك';
    avatar.addEventListener('click', copyMyId);
  }

  Session.onChange(renderWallet);
  renderWallet(Session.player);
}

function renderWallet(player) {
  const wallet = document.getElementById('wallet');
  const amount = document.getElementById('walletAmount');
  const chip = document.getElementById('playerChip');
  const avatar = document.getElementById('avatarBtn');
  const guestActions = document.getElementById('topbarGuestActions');
  const logoutBtn = document.getElementById('topbarLogoutBtn');

  if (player) {
    if (wallet) wallet.hidden = false;
    if (chip) { chip.hidden = false; chip.textContent = `ID: ${player.id}`; }
    if (avatar) { avatar.hidden = false; avatar.textContent = player.id.slice(0, 2); }
    if (logoutBtn) logoutBtn.hidden = false;
    if (guestActions) guestActions.hidden = true;

    if (amount) {
      const prev = Number(amount.dataset.value || 0);
      const next = Number(player.balance || 0);
      amount.dataset.value = String(next);
      if (prev === next) { amount.textContent = fmt(next); return; }
      animateNumber(amount, prev, next, 650);
      if (next > prev) {
        amount.style.color = 'var(--neon-green, #29d98c)';
        setTimeout(() => { amount.style.color = ''; }, 900);
      }
    }
  } else {
    if (wallet) wallet.hidden = true;
    if (chip) chip.hidden = true;
    if (avatar) avatar.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;
    if (guestActions) guestActions.hidden = false;
  }
}

function animateNumber(el, from, to, duration) {
  // requestAnimationFrame لا يعمل إطلاقاً في تبويب مخفي. لو اكتفينا به لبقي
  // الرصيد المعروض قديماً لمن فتح الموقع في الخلفية — فنكتب القيمة النهائية
  // أولاً، ثم نتحرّك نحوها فقط حين تكون الصفحة ظاهرة.
  el.textContent = fmt(to);
  if (document.hidden) return;

  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(t < 1 ? from + (to - from) * eased : to);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ------------------------------- نسخ المعرّف ------------------------------- */
async function copyMyId() {
  const id = Session.player && Session.player.id;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    toast(`تم نسخ معرّفك: ${id}`);
  } catch {
    toast(`معرّفك: ${id}`);
  }
}

/* ------------------------------- بدء التشغيل ------------------------------- */
async function bootSession() {
  try {
    const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
    if (!token && location.pathname !== '/login' && location.pathname !== '/cashier') {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return false;
    }
    await Session.init();
    return true;
  } catch (err) {
    if (/سجّل الدخول|الدخول|needsLogin/.test(err.message || '')) {
      if (location.pathname !== '/login' && location.pathname !== '/cashier') {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        return false;
      }
    }
    toast(err.message || 'تعذّر بدء الجلسة', 'error', 6000);
    return false;
  }
}
