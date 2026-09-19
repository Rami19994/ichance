/* ==========================================================================
   iCHANCE — الردهة الفاخرة (High-Fidelity Casino Lobby Engine)
   تحكم كامل بالكتالوج والتصفية والتفاعل بدون أرقام أو إحصاءات وهمية
   ========================================================================== */
'use strict';

const CATEGORIES = [
  { key: 'all',       name: '⭐ كل الألعاب',           en: 'All Games' },
  { key: 'slots',     name: '🎰 High RTP Slots',      en: 'Slots' },
  { key: 'table',     name: '🎡 Live Roulette',       en: 'Roulette' },
  { key: 'blackjack', name: '♠️ Blackjack & Tables',   en: 'Blackjack' },
  { key: 'crash',     name: '🚀 Crash Games',         en: 'Crash' },
  { key: 'skill',     name: '🛡️ Action & Skill',      en: 'Skill Battles' }
];

const GAMES = [
  {
    id: 'bounty',
    title: 'صيّاد الجوائز — Bounty Hunter',
    cat: 'slots',
    rtpBadge: 'HIGH RTP',
    provider: 'iChance Originals',
    providerKey: 'ichance',
    live: true,
    realGame: true,
    href: '/bounty-hunter',
    thumb: '/assets/thumb_bounty.jpg',
    tag: 'سلوتس أصلية',
    badge: 'HOT • SLOTS',
    badgeClass: 'badge-tag--hot',
    desc: 'سلوتس بعوائد مرتفعة، رموز Wild وScatter، وجوائز مضاعفة فورية.'
  },
  {
    id: 'lucky-cards',
    title: 'كروت الحظ — Lucky Cards',
    cat: 'table',
    cats: ['table', 'blackjack'],
    rtpBadge: 'LIVE DEALER',
    provider: 'iChance Live',
    providerKey: 'ichance',
    live: true,
    realGame: true,
    href: '/lucky-cards',
    thumb: '/assets/thumb_cards.jpg',
    tag: 'موزع مباشر • مضاعفات',
    badge: 'LIVE DEALER',
    badgeClass: 'badge-tag--live',
    desc: 'طاولة كازينو حية متعددة المقاعد مع موزع مباشر ومضاعفات عشوائية.'
  },
  {
    id: 'tank',
    title: 'معركة الدبابات — Battle Tanks',
    cat: 'skill',
    rtpBadge: 'PVP ARENA',
    provider: 'iChance PvP',
    providerKey: 'ichance',
    live: true,
    realGame: true,
    href: '/battle-tanks',
    thumb: '/assets/thumb_tank.jpg',
    tag: 'قتال بالمال الحقيقي',
    badge: 'PVP ARENA',
    badgeClass: 'badge-tag--gold',
    desc: 'ساحة قتال دبابات بالرهان الحقيقي: تحكم، صوب، واقضِ على الخصوم لتفوز بالرهان.'
  },
  {
    id: 'roulette',
    title: 'روليت أوروبي VIP — European Roulette',
    cat: 'table',
    rtpBadge: 'VIP TABLE',
    provider: 'Evolution Gaming',
    providerKey: 'evolution',
    live: true,
    realGame: false,
    previewMode: true,
    thumb: '/assets/thumb_roulette.jpg',
    tag: 'طاولة VIP بحدود مرنة',
    badge: 'VIP TABLE',
    badgeClass: 'badge-tag--live',
    desc: 'عجلة روليت أوروبية حية بفيزياء حقيقية، رهان مباشر على الأرقام والألوان وسحوبات سريعة.'
  },
  {
    id: 'blackjack',
    title: 'بلاك جاك النخبة — VIP Blackjack',
    cat: 'blackjack',
    rtpBadge: 'EXCLUSIVE',
    provider: 'Pragmatic Play',
    providerKey: 'pragmatic',
    live: true,
    realGame: false,
    previewMode: true,
    thumb: '/assets/thumb_blackjack.jpg',
    tag: 'طاولات حية مباشرة',
    badge: 'EXCLUSIVE',
    badgeClass: 'badge-tag--gold',
    desc: 'لعبة بلاك جاك الكلاسيكية للمحترفين مع خيارات تأمين ومضاعفة الرهان.'
  },
  {
    id: 'crash',
    title: 'سبيس كراش — Space Crash Rocket',
    cat: 'crash',
    rtpBadge: 'TRENDING',
    provider: 'Spribe Gaming',
    providerKey: 'spribe',
    live: true,
    realGame: false,
    previewMode: true,
    thumb: '/assets/thumb_crash.jpg',
    tag: 'مضاعفات صعود كبرى',
    badge: 'TRENDING',
    badgeClass: 'badge-tag--hot',
    desc: 'صاروخ الصعود الفضائي المثير: اسحب أرباحك قبل الانفجار واستمتع بمضاعفات قياسية فورية.'
  }
];

let activeCat = 'all';
let searchQuery = '';
let selectedProvider = 'all';
let serverGameConfig = {};

/* --------------------------- التحقق من إمكانية اللعب --------------------------- */
function isPlayable(g) {
  if (!g.live) return false;
  const map = { 'lucky-cards': 'cards', bounty: 'slots', tank: 'tank' };
  const key = map[g.id];
  return !key || serverGameConfig[key] !== false;
}

function matchCategory(g, catKey) {
  if (catKey === 'all') return true;
  if (g.cat === catKey) return true;
  if (Array.isArray(g.cats) && g.cats.includes(catKey)) return true;
  return false;
}

/* ------------------------------- رسم الفئات ------------------------------- */
function renderCats() {
  const container = document.getElementById('cats');
  if (!container) return;

  container.innerHTML = CATEGORIES.map((c) => {
    const active = c.key === activeCat ? ' is-on' : '';
    return `<button type="button" class="cat-tab${active}" data-cat="${c.key}">
      <span>${c.name}</span>
    </button>`;
  }).join('');
}

/* ------------------------------- رسم الألعاب ------------------------------- */
function renderGrid() {
  const container = document.getElementById('gamesGrid');
  if (!container) return;

  const filtered = GAMES.filter((g) => {
    if (!matchCategory(g, activeCat)) return false;
    if (selectedProvider !== 'all' && g.providerKey !== selectedProvider) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const text = `${g.title} ${g.provider} ${g.tag} ${g.cat}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; color: #64748b;">
        <div style="font-size: 38px; margin-bottom: 12px">🔍</div>
        <h4 style="font-size: 18px; color: #fff; margin-bottom: 6px">لم نجد أي ألعاب تطابق بحثك</h4>
        <p style="font-size: 14px">جرّب تغيير كلمات البحث أو اختيار فئة أخرى من القائمة أعلاه.</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((g) => {
    return `
      <article class="gcard" data-id="${g.id}">
        <div class="gcard__thumb">
          <img src="${g.thumb}" alt="${escapeHtml(g.title)}" loading="lazy">
          <div class="gcard__badges">
            <span class="badge-tag ${g.badgeClass || 'badge-tag--hot'}">${escapeHtml(g.badge)}</span>
          </div>
          <div class="gcard__overlay">
            <button type="button" class="btn-play-real" data-action="play" data-id="${g.id}">
              <span>العب بالمال الحقيقي</span>
              <span style="font-size:16px">▶</span>
            </button>
            <button type="button" class="btn-play-demo" data-action="preview" data-id="${g.id}">
              <span>تجربة واستعراض</span>
            </button>
          </div>
        </div>
        <div class="gcard__info">
          <div class="gcard__title-row">
            <h4 class="gcard__title" title="${escapeHtml(g.title)}">${escapeHtml(g.title)}</h4>
            <span class="gcard__rtp">${g.rtpBadge || 'PROVABLY FAIR'}</span>
          </div>
          <div class="gcard__meta">
            <span class="gcard__provider">${escapeHtml(g.provider)}</span>
            <span style="font-size:11.5px; color:#cbd5e1">${escapeHtml(g.tag)}</span>
          </div>
          <a href="#" class="gcard__play-btn-mobile" data-action="play" data-id="${g.id}">
            العب الآن بمال حقيقي
          </a>
        </div>
      </article>`;
  }).join('');
}

function paint() {
  renderCats();
  renderGrid();
}

/* ----------------------- فتح الألعاب والتحقق من الجلسة ----------------------- */
function handleGameLaunch(gameId, isDemo = false) {
  const game = GAMES.find((g) => g.id === gameId);
  if (!game) return;

  const player = Session.player;

  // إذا لم يكن مسجل الدخول، نفتح نافذة الدخول السريعة
  if (!player && !isDemo) {
    openAuthModal('login', `سجّل دخولك للعب ${game.title} بالمال الحقيقي`);
    return;
  }

  // إذا كانت لعبة حقيقية في النظام
  if (game.realGame) {
    window.location.href = game.href;
    return;
  }

  // إذا كانت لعبة عرض تفاعلية
  openGameLauncherModal(game, isDemo);
}

function openGameLauncherModal(game, isDemo) {
  const modal = document.getElementById('gameLauncherModal');
  const content = document.getElementById('launcherContent');
  if (!modal || !content) return;

  content.innerHTML = `
    <div style="text-align:center; padding: 10px 0;">
      <div style="aspect-ratio: 16/9; border-radius: 14px; overflow: hidden; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.1); position:relative">
        <img src="${game.thumb}" alt="${escapeHtml(game.title)}" style="width:100%; height:100%; object-fit:cover">
        <div style="position:absolute; inset:0; background:linear-gradient(to top, rgba(10,14,22,0.9), transparent 60%); display:flex; align-items:flex-end; padding:20px;">
          <div>
            <span class="badge-tag badge-tag--live" style="margin-bottom:6px; display:inline-block">${escapeHtml(game.badge)}</span>
            <h2 style="color:#fff; font-size:24px; font-weight:900; margin:0">${escapeHtml(game.title)}</h2>
          </div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:20px">
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:10px; border-radius:10px">
          <div style="font-size:11px; color:#94a3b8">نظام العوائد</div>
          <div style="font-size:15px; font-weight:800; color:#00ff87">High RTP</div>
        </div>
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:10px; border-radius:10px">
          <div style="font-size:11px; color:#94a3b8">المزوّد المعتمد</div>
          <div style="font-size:15px; font-weight:800; color:#fff">${escapeHtml(game.provider)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:10px; border-radius:10px">
          <div style="font-size:11px; color:#94a3b8">نظام النزاهة</div>
          <div style="font-size:15px; font-weight:800; color:var(--gold-2)">Provably Fair</div>
        </div>
      </div>

      <p style="font-size:14px; color:#cbd5e1; line-height:1.7; margin-bottom:24px; text-align:start">
        ${escapeHtml(game.desc)}
      </p>

      <div style="display:flex; gap:12px; justify-content:center">
        <button type="button" class="btn btn--neon-glow btn--lg" id="modalLaunchPlayReal">
          <span>دخول الطاولة الحية الآن ($)</span>
        </button>
        <button type="button" class="btn btn--glass-gold btn--lg" id="modalLaunchClose">
          <span>العودة للردهة</span>
        </button>
      </div>
    </div>
  `;

  modal.hidden = false;

  document.getElementById('modalLaunchClose').onclick = () => { modal.hidden = true; };
  document.getElementById('modalLaunchPlayReal').onclick = () => {
    modal.hidden = true;
    if (!Session.player) {
      openAuthModal('login', `سجّل دخولك للعب ${game.title} برصيد حقيقي`);
    } else {
      toast(`جارٍ فتح طاولة ${game.title}...`, 'win');
    }
  };
}

/* ----------------------- نوافذ تسجيل الدخول والشحن ----------------------- */
function openAuthModal(tab = 'login', customSubtitle = null) {
  const modal = document.getElementById('authModal');
  if (!modal) return;

  const tLogin = document.getElementById('tabLogin');
  const tReg = document.getElementById('tabRegister');
  const fLogin = document.getElementById('modalLoginForm');
  const bReg = document.getElementById('modalRegisterBox');
  const sub = document.getElementById('authModalSubtitle');

  if (customSubtitle && sub) sub.textContent = customSubtitle;

  if (tab === 'register') {
    tReg.classList.add('is-active');
    tLogin.classList.remove('is-active');
    fLogin.hidden = true;
    bReg.hidden = false;
  } else {
    tLogin.classList.add('is-active');
    tReg.classList.remove('is-active');
    fLogin.hidden = false;
    bReg.hidden = true;
  }

  modal.hidden = false;
}

function initModals() {
  const authModal = document.getElementById('authModal');
  const closeAuth = document.getElementById('closeAuthModal');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const formLogin = document.getElementById('modalLoginForm');
  const errBox = document.getElementById('modalLoginError');

  if (closeAuth) closeAuth.addEventListener('click', () => { authModal.hidden = true; });

  if (tabLogin && tabRegister) {
    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('is-active');
      tabRegister.classList.remove('is-active');
      formLogin.hidden = false;
      document.getElementById('modalRegisterBox').hidden = true;
    });
    tabRegister.addEventListener('click', () => {
      tabRegister.classList.add('is-active');
      tabLogin.classList.remove('is-active');
      formLogin.hidden = true;
      document.getElementById('modalRegisterBox').hidden = false;
    });
  }

  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const btn = document.getElementById('modalLoginSubmit');
      btn.disabled = true;
      btn.querySelector('span').textContent = 'جارٍ التحقق…';

      try {
        const idVal = document.getElementById('mIdentifier').value;
        const pwVal = document.getElementById('mPassword').value;
        const res = await API.post('/api/auth/login', { identifier: idVal, password: pwVal });
        try { localStorage.setItem('ichance.token', res.token); } catch {}
        Session.token = res.token;
        Session.setPlayer(res.player);
        authModal.hidden = true;
        toast(`أهلاً بك، تم تسجيل الدخول بنجاح!`, 'win');
      } catch (err) {
        errBox.hidden = false;
        errBox.textContent = err.message || 'بيانات الدخول غير صحيحة';
      } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'دخول إلى الألعاب';
      }
    });
  }

  // نافذة الإيداع
  const depModal = document.getElementById('depositModal');
  const closeDep = document.getElementById('closeDepositModal');
  if (closeDep && depModal) closeDep.addEventListener('click', () => { depModal.hidden = true; });

  // نافذة استعراض الألعاب
  const launchModal = document.getElementById('gameLauncherModal');
  const closeLauncher = document.getElementById('closeLauncherModal');
  if (closeLauncher && launchModal) closeLauncher.addEventListener('click', () => { launchModal.hidden = true; });

  // إغلاق بالنقر خارج البطاقة
  window.addEventListener('click', (e) => {
    if (e.target === authModal) authModal.hidden = true;
    if (e.target === depModal) depModal.hidden = true;
    if (e.target === launchModal) launchModal.hidden = true;
  });
}

/* ----------------------- ربط الأحداث العامة ----------------------- */
function bindEvents() {
  // زر بونص الهيرو
  const heroBtn = document.getElementById('heroClaimBtn');
  if (heroBtn) {
    heroBtn.addEventListener('click', () => {
      if (!Session.player) {
        openAuthModal('register', 'سجّل أو اشحن الآن لتفعيل بونص الإيداع الترحيبي');
      } else {
        const modal = document.getElementById('depositModal');
        if (modal) {
          const balEl = document.getElementById('depositCurrentBalance');
          if (balEl) balEl.textContent = `$ ${fmt(Session.player.balance)}`;
          modal.hidden = false;
        }
      }
    });
  }

  // زر نسخ كود البونص
  const copyBtn = document.getElementById('copyPromoBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('ICHANCE');
        toast('تم نسخ كود البونص: ICHANCE', 'win');
      } catch {
        toast('كود البونص: ICHANCE');
      }
    });
  }

  // روابط التذييل للإيداع
  const depFooter = document.getElementById('depositFooterLink');
  if (depFooter) {
    depFooter.addEventListener('click', (e) => {
      e.preventDefault();
      const modal = document.getElementById('depositModal');
      if (modal) modal.hidden = false;
    });
  }

  // شريط تبويبات الفئات
  const catsContainer = document.getElementById('cats');
  if (catsContainer) {
    catsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cat]');
      if (!btn) return;
      activeCat = btn.dataset.cat;
      paint();
    });
  }

  // التصفية عبر شريط التنقل العلوي
  document.querySelectorAll('.topbar-nav__link').forEach((link) => {
    link.addEventListener('click', (e) => {
      const cat = link.dataset.cat;
      if (cat && cat !== 'vip') {
        activeCat = cat;
        paint();
        document.querySelectorAll('.topbar-nav__link').forEach((l) => l.classList.remove('is-active'));
        link.classList.add('is-active');
      }
    });
  });

  // روابط الفئات في التذييل
  document.querySelectorAll('.cat-link-trigger').forEach((link) => {
    link.addEventListener('click', (e) => {
      const cat = link.dataset.cat;
      if (cat) {
        activeCat = cat;
        paint();
      }
    });
  });

  // البحث الفوري
  const searchInput = document.getElementById('gameSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderGrid();
    });
  }

  // تصفية المزودين
  const provSelect = document.getElementById('providerSelect');
  if (provSelect) {
    provSelect.addEventListener('change', (e) => {
      selectedProvider = e.target.value;
      renderGrid();
    });
  }

  // النقر على بطاقات الألعاب
  const grid = document.getElementById('gamesGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const playBtn = e.target.closest('[data-action="play"]');
      const previewBtn = e.target.closest('[data-action="preview"]');
      const card = e.target.closest('.gcard');

      if (playBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleGameLaunch(playBtn.dataset.id, false);
      } else if (previewBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleGameLaunch(previewBtn.dataset.id, true);
      } else if (card) {
        handleGameLaunch(card.dataset.id, false);
      }
    });
  }

  // زر تسجيل الدخول من الشريط العلوي إن وُجد
  const loginBtn = document.getElementById('topbarLoginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openAuthModal('login');
    });
  }

  const registerBtn = document.getElementById('topbarRegisterBtn');
  if (registerBtn) {
    registerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openAuthModal('register');
    });
  }

  const supportBtn = document.getElementById('btnLiveSupportChat');
  if (supportBtn) {
    supportBtn.addEventListener('click', () => {
      toast('فريق خدمة العملاء متاح لمساعدتك وتفعيل حسابك وشحنه فوراً', 'win', 4500);
    });
  }

  // معلومات الأمان في التذييل
  document.querySelectorAll('.info-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const type = link.dataset.type;
      const msgs = {
        'provably-fair': 'جميع ألعابنا مدعومة بنظام تشفير عشوائي Provably Fair يتيح لأي لاعب التحقق الرياضي من نزاهة الجولات.',
        'responsible': 'iCHANCE تدعم اللعب المسؤول. الألعاب مخصصة للترفيه فقط ويجب عدم الرهان بأموال لا تستطيع تحمل خسارتها.',
        'security': 'يتم تأمين جميع المعاملات بتشفير SSL ونظام حماية مالي متعدد الطبقات مطابق للمعايير البنكية الدولية.',
        'terms': 'شروط اللعب والسحب: السحوبات فورية وبدون أي رسوم خفية. تطبق قواعد المكافآت العامة.'
      };
      toast(msgs[type] || 'معلومات الأمان والنزاهة', 'info', 5000);
    });
  });
}

/* ------------------------------- الإقلاع (BOOT) ------------------------------- */
(async function boot() {
  mountShell('home');

  // استرجاع جلسة اللاعب دون طرد الزائر
  try {
    await Session.init();
  } catch (err) {
    // الزائر غير مسجل — يبقى في الردهة بكامل ميزاتها وزر التسجيل معروض
  }

  // جلب إعدادات الألعاب النشطة من الخادم
  try {
    const cfg = await API.get('/api/config');
    serverGameConfig = cfg.games || {};
  } catch {}

  paint();
  initModals();
  bindEvents();
})();
