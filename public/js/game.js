/* ==========================================================================
   iCHANCE — طاولة "كروت الحظ" (منطق المتصفح)
   --------------------------------------------------------------------------
   الخادم هو المرجع الوحيد للحقيقة. هذا الملف لا يقرر نتيجة أبداً،
   بل يرسم ما يصل من /api/stream ويرسل نوايا اللاعب (دخول / قلب كرت).
   ========================================================================== */
'use strict';

const RING_CIRC = 2 * Math.PI * 27; // محيط حلقة العد التنازلي

let CONFIG = null;
let state = null;            // آخر حالة وصلت من الخادم
let clockOffset = 0;         // فرق ساعة الخادم عن ساعة المتصفح
let selectedStake = null;
let currentRoundId = null;
let pickInFlight = false;
let pickedSeats = new Set(); // لتمييز من قلب كرته للتوّ
let lastPhase = null;
let audioOn = true;
let lastTickSecond = -1;

const el = (id) => document.getElementById(id);

function tierOf(m) {
  if (m === 0) return 'lose';
  if (m === 1) return 'low';
  if (m <= 3) return 'mid';
  if (m <= 5) return 'high';
  if (m < 20) return 'top';
  return 'mega';   // ×20 فأعلى — نادرة جداً فتستحق مظهراً خاصاً
}

/* ==========================================================================
   أصوات بسيطة (WebAudio — بلا ملفات خارجية)
   ========================================================================== */
const Sound = {
  ctx: null,
  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this.ctx = new Ctx();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  tone(freq, duration = 0.12, type = 'sine', gain = 0.05) {
    if (!audioOn) return;
    const ctx = this.ensure();
    if (!ctx) return;
    // المتصفح يوقف سياق الصوت عند تحميل الصفحة أو إخفاء التبويب،
    // فإن لم يكن يعمل نستأنفه ثم نشغّل النغمة — بدل ابتلاعها بصمت.
    if (ctx.state !== 'running') {
      ctx.resume().then(() => this.emit(ctx, freq, duration, type, gain)).catch(() => {});
      return;
    }
    this.emit(ctx, freq, duration, type, gain);
  },
  emit(ctx, freq, duration, type, gain) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  },
  flip() { this.tone(520, 0.09, 'triangle', 0.045); },
  tick() { this.tone(880, 0.05, 'square', 0.025); },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.2, 'sine', 0.06), i * 95));
  },
  lose() { this.tone(180, 0.32, 'sawtooth', 0.04); }
};

/* ==========================================================================
   بناء اللوحة (مرة واحدة — لا نعيد بناء الـDOM حتى لا تنكسر حركة القلب)
   ========================================================================== */
function buildBoard() {
  const board = el('board');
  const count = CONFIG ? CONFIG.cardCount : 12;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <button class="pcard" data-i="${i}" type="button" aria-label="كرت رقم ${i + 1}">
        <div class="pcard__inner">
          <div class="pcard__face pcard__back">
            <span class="pcard__frame"></span>
            <span class="pcard__idx">${i + 1}</span>
            <span class="pcard__q">؟</span>
            <div class="pcard__owner" hidden>
              <span class="pcard__owner-dot"></span>
              <span class="pcard__owner-id"></span>
            </div>
          </div>
          <div class="pcard__face pcard__front" data-tier="low">
            <span class="pcard__mult">—</span>
            <span class="pcard__prize"></span>
            <span class="pcard__holder"></span>
          </div>
        </div>
      </button>`;
  }
  board.innerHTML = html;

  board.querySelectorAll('.pcard').forEach((card) => {
    card.addEventListener('click', () => onCardClick(Number(card.dataset.i)));
  });
}

async function onCardClick(index) {
  if (!state || state.phase !== 'playing') return;
  if (!state.you.seated) { toast('أنت مشاهد — انضم في مرحلة المشاركة القادمة', 'error'); return; }
  if (state.you.cardIndex !== null) { toast('اخترت كرتك في هذه الجولة', 'error'); return; }
  if (state.cards[index].owner) { toast('هذا الكرت محجوز للاعب آخر', 'error'); return; }
  if (pickInFlight) return;

  pickInFlight = true;
  Sound.ensure();
  try {
    const res = await API.post('/api/pick', { cardIndex: index });
    Sound.flip();
    toast(`حجزت الكرت رقم ${res.cardIndex + 1} — النتيجة عند نهاية الجولة`, 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pickInFlight = false;
  }
}

/* ==========================================================================
   رسم اللوحة من الحالة
   ========================================================================== */
function renderBoard() {
  const cards = el('board').children;
  const canPick = state.phase === 'playing' && state.you.seated && state.you.cardIndex === null;
  const revealing = state.phase === 'results';

  for (let i = 0; i < cards.length; i++) {
    const node = cards[i];
    const data = state.cards[i];
    const owner = data.owner;
    const m = data.multiplier;
    const isMine = owner && owner.id === (Session.player && Session.player.id);

    // ظهر الكرت: من حجزه؟
    const ownerBox = node.querySelector('.pcard__owner');
    if (owner) {
      ownerBox.hidden = false;
      node.querySelector('.pcard__owner-dot').textContent = owner.isBot ? 'B' : owner.id.slice(0, 2);
      node.querySelector('.pcard__owner-id').textContent = owner.id;
      ownerBox.classList.toggle('is-bot', !!owner.isBot);
    } else {
      ownerBox.hidden = true;
      ownerBox.classList.remove('is-bot');
    }

    // وجه الكرت
    const front = node.querySelector('.pcard__front');
    if (m === null || m === undefined) {
      // كرت مغلق: نمسح قيمة الجولة السابقة حتى لا تُرى أثناء حركة العودة
      front.dataset.tier = 'low';
      node.querySelector('.pcard__mult').textContent = '؟';
      node.querySelector('.pcard__prize').textContent = '';
      node.querySelector('.pcard__holder').textContent = '';
    } else {
      front.dataset.tier = tierOf(m);
      node.querySelector('.pcard__mult').textContent = m === 0 ? '×0' : `×${m}`;

      let prize = '';
      if (isMine && state.you.stake) {
        prize = m === 0 ? `خسرت ${fmt(state.you.stake)}` : `+${fmt(state.you.payout)}`;
      } else if (revealing && owner) {
        const seat = state.seats.find((s) => s.id === owner.id);
        if (seat) prize = m === 0 ? 'خسر' : `+${fmt(seat.payout)}`;
      } else if (!owner) {
        prize = 'لم يُختر';
      }
      node.querySelector('.pcard__prize').textContent = prize;
      node.querySelector('.pcard__holder').textContent = owner ? owner.id : '';
    }

    node.classList.toggle('is-flipped', m !== null && m !== undefined);
    node.classList.toggle('is-taken', !!owner && !isMine);
    node.classList.toggle('is-mine-taken', !!isMine);
    node.classList.toggle('is-yours', !!isMine);
    node.classList.toggle('is-selectable', canPick && !owner);
    node.classList.toggle('is-win', revealing && !!owner && m > 1);
  }
}

/** كشف متدرّج للوحة عند بداية مرحلة النتائج — أجمل من قلب الكل دفعة واحدة. */
function cascadeReveal() {
  const cards = [...el('board').children];
  cards.forEach((node, i) => {
    const inner = node.querySelector('.pcard__inner');
    inner.style.transitionDelay = `${i * 45}ms`;
  });
  setTimeout(() => {
    cards.forEach((node) => { node.querySelector('.pcard__inner').style.transitionDelay = ''; });
  }, cards.length * 45 + 700);
}

/* ==========================================================================
   شريط الجولة + العد التنازلي
   ========================================================================== */
const PHASE_TITLE = {
  betting: 'مرحلة المشاركة',
  playing: 'احجز كرتك الآن',
  results: 'النتائج'
};
const PHASE_ICON = { betting: '⏳', playing: '🎴', results: '🏆' };

function renderRoundBar() {
  el('phaseTitle').textContent = PHASE_TITLE[state.phase] || '—';
  el('roundLabel').textContent = `${state.roundId} · ${state.templateName ? `نمط ${state.templateName}` : 'التوزيع مخفي حتى نهاية الجولة'}`;

  const pill = el('phasePill');
  pill.dataset.phase = state.phase;
  pill.textContent = `${PHASE_ICON[state.phase] || ''} ${
    state.phase === 'betting' ? 'الباب مفتوح للانضمام'
      : state.phase === 'playing' ? 'الحجز جارٍ — لا كشف بعد'
        : 'كُشفت اللوحة'}`;

  el('ring').dataset.phase = state.phase;
  el('seatsText').textContent = `${state.playerCount} / ${state.maxPlayers}`;
  el('seatCountTag').textContent = state.playerCount;

  const fill = el('seatsFill');
  fill.style.width = `${(state.playerCount / state.maxPlayers) * 100}%`;
  fill.classList.toggle('is-full', state.playerCount >= state.maxPlayers);
}

function tickCountdown() {
  if (!state) return;
  const left = Math.max(0, state.phaseEndsAt - (Date.now() + clockOffset));
  const seconds = Math.ceil(left / 1000);
  const total = state.phaseDuration || 30000;

  el('ringNum').textContent = seconds;
  el('ringFill').style.strokeDashoffset = String(RING_CIRC * (1 - Math.min(1, left / total)));

  const urgent = seconds <= 5 && state.phase !== 'results';
  el('ring').classList.toggle('is-urgent', urgent);

  // نقرة خفيفة في آخر 3 ثوانٍ
  if (urgent && seconds <= 3 && seconds !== lastTickSecond && seconds > 0) {
    lastTickSecond = seconds;
    Sound.tick();
  }
  if (!urgent) lastTickSecond = -1;
}

/* ==========================================================================
   شريط المشاركة
   ========================================================================== */
function buildStakeGrid() {
  const grid = el('stakeGrid');
  const { threshold, maxMultiplier } = CONFIG.highStake;
  grid.innerHTML = CONFIG.stakes.map((s) => {
    const capped = s >= threshold;
    return `<button class="stake-chip${capped ? ' is-capped' : ''}" type="button" data-stake="${s}"
              ${capped ? `title="المبالغ من ${fmt(threshold)} فأعلى: أقصى مضاعف مصروف ×${maxMultiplier}"` : ''}>
              ${fmt(s)}${capped ? `<em>سقف ×${maxMultiplier}</em>` : ''}
            </button>`;
  }).join('');
  grid.querySelectorAll('.stake-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      selectedStake = Number(chip.dataset.stake);
      try { localStorage.setItem('ichance.stake', String(selectedStake)); } catch { /* تجاهل */ }
      renderStakeBar();
    });
  });

  let saved = null;
  try { saved = Number(localStorage.getItem('ichance.stake')); } catch { /* تجاهل */ }
  selectedStake = CONFIG.stakes.includes(saved) ? saved : CONFIG.stakes[0];
}

function renderStakeBar() {
  const balance = Session.player ? Session.player.balance : 0;
  const seated = state && state.you.seated;
  const betting = state && state.phase === 'betting';
  const tableFull = state && state.playerCount >= state.maxPlayers;

  el('stakeGrid').querySelectorAll('.stake-chip').forEach((chip) => {
    const value = Number(chip.dataset.stake);
    chip.classList.toggle('is-active', value === selectedStake);
    chip.disabled = seated || !betting || value > balance;
  });

  const joinBtn = el('joinBtn');
  const leaveBtn = el('leaveBtn');
  const topupBtn = el('topupBtn');
  const title = el('stakeTitle');
  const hint = el('stakeHint');

  leaveBtn.hidden = !(seated && betting);
  topupBtn.hidden = balance >= CONFIG.stakes[0];

  if (seated) {
    joinBtn.hidden = true;
    title.textContent = betting ? 'أنت في الجولة — بانتظار الانطلاق' : 'أنت في الجولة';
    hint.textContent = `مبلغ مشاركتك ${fmt(state.you.stake)} عملة`;
  } else {
    joinBtn.hidden = false;
    if (!betting) {
      joinBtn.disabled = true;
      joinBtn.textContent = 'انتظر الجولة القادمة';
      title.textContent = 'الجولة الحالية بدأت';
      hint.textContent = 'تابع اللعب الآن، وستُفتح المشاركة تلقائياً بعد انتهائها';
    } else if (tableFull) {
      joinBtn.disabled = true;
      joinBtn.textContent = 'اكتملت المقاعد';
      title.textContent = 'اكتمل عدد المشاركين (12)';
      hint.textContent = 'الجولة على وشك الانطلاق — انتظر التالية';
    } else if (balance < CONFIG.stakes[0]) {
      joinBtn.disabled = true;
      joinBtn.textContent = 'رصيدك لا يكفي';
      title.textContent = 'رصيدك أقل من أصغر مبلغ';
      hint.textContent = 'اشحن رصيداً تجريبياً للمتابعة';
    } else {
      joinBtn.disabled = false;
      joinBtn.textContent = `ادخل الجولة بـ ${fmt(selectedStake)}`;
      title.textContent = 'اختر مبلغ المشاركة';
      hint.textContent = selectedStake >= CONFIG.highStake.threshold
        ? `تنبيه: المبالغ من ${fmt(CONFIG.highStake.threshold)} فأعلى يُصرف لها ×${CONFIG.highStake.maxMultiplier} كحد أقصى`
        : 'المبلغ يُحجز من رصيدك عند الدخول';
    }
  }
}

/* ==========================================================================
   بطاقة "حالتك"
   ========================================================================== */
function renderYouCard() {
  const you = state.you;
  const box = el('youResult');
  const b = box.querySelector('b');
  const note = box.querySelector('span');

  if (!you.seated) {
    el('youState').textContent = 'مشاهد';
    el('youStake').textContent = '—';
    box.className = 'you-card__result pending';
    b.textContent = '—';
    note.textContent = state.phase === 'betting'
      ? 'اختر مبلغاً وادخل الجولة'
      : 'انتظر الجولة القادمة للمشاركة';
    return;
  }

  el('youStake').textContent = `${fmt(you.stake)} عملة`;

  if (state.phase === 'betting') {
    el('youState').textContent = 'مشارك — بانتظار الانطلاق';
    box.className = 'you-card__result pending';
    b.textContent = '⏳';
    note.textContent = 'الجولة لم تبدأ بعد';
    return;
  }

  if (you.cardIndex === null) {
    el('youState').textContent = 'دورك — اختر كرتاً';
    box.className = 'you-card__result pending';
    b.textContent = '؟';
    note.textContent = 'اضغط على أي كرت متاح — تُكشف النتائج في النهاية';
    return;
  }

  el('youState').textContent = `كرت رقم ${you.cardIndex + 1}${you.auto ? ' (تلقائي)' : ''}`;

  const m = you.multiplier;
  if (m === null || m === undefined) {
    // اللاعب حجز كرته لكن الكشف لم يحن بعد
    box.className = 'you-card__result pending';
    b.textContent = '🔒';
    note.textContent = 'كرتك محجوز — تُكشف كل الكروت عند نهاية الجولة';
    return;
  }

  if (m === 0) {
    box.className = 'you-card__result lose';
    b.textContent = '×0';
    note.textContent = `خسرت ${fmt(you.stake)} عملة`;
  } else if (m === 1) {
    box.className = 'you-card__result pending';
    b.textContent = '×1';
    note.textContent = `استرداد المبلغ — ${fmt(you.payout)} عملة`;
  } else {
    box.className = 'you-card__result win';
    b.textContent = `+${fmt(you.payout)}`;
    note.textContent = you.capped
      ? `الكرت ×${you.cardValue} — وسقف المبالغ الكبيرة ×${m}`
      : `مضاعف ×${m} على ${fmt(you.stake)}`;
  }
}

/* ==========================================================================
   قائمة اللاعبين
   ========================================================================== */
function renderSeats() {
  const list = el('seatList');
  if (!state.seats.length) {
    list.innerHTML = '<div class="seat-empty">لا يوجد مشاركون بعد — كن أول من يدخل الجولة.</div>';
    pickedSeats = new Set();
    return;
  }

  const nowPicked = new Set(state.seats.filter((s) => s.cardIndex !== null).map((s) => s.id));

  list.innerHTML = state.seats.map((s) => {
    let stateClass = '';
    let stateText = '';
    if (state.phase === 'betting') {
      stateText = 'جاهز';
    } else if (s.cardIndex === null) {
      stateText = 'يفكّر…';
    } else if (s.multiplier === null) {
      stateClass = 'picked';
      stateText = `حجز كرت ${s.cardIndex + 1}`;
    } else if (s.multiplier === 0) {
      stateClass = 'lost';
      stateText = `كرت ${s.cardIndex + 1} · <span class="ltr-num">×0</span>`;
    } else {
      stateClass = s.multiplier > 1 ? 'win' : 'picked';
      stateText = `كرت ${s.cardIndex + 1} · <span class="ltr-num">×${s.multiplier}</span>`;
    }

    const isNew = s.cardIndex !== null && !pickedSeats.has(s.id) && lastPhase === 'playing';

    return `
      <div class="seat-row${s.isYou ? ' is-you' : ''}${isNew ? ' just-picked' : ''}">
        <span class="seat-av${s.isBot ? ' bot' : ''}">${s.isBot ? 'B' : escapeHtml(s.id.slice(0, 2))}</span>
        <span class="seat-main">
          <span class="seat-name"><span class="seat-id-main">${escapeHtml(s.id)}</span>${s.isBot ? '<em>BOT</em>' : ''}${s.isYou ? '<em class="is-you-tag">أنت</em>' : ''}</span>
          <span class="seat-id">${s.stake >= (CONFIG ? CONFIG.highStake.threshold : Infinity) ? `سقف <span class="ltr-num">×${CONFIG.highStake.maxMultiplier}</span>` : 'مشارك'}</span>
        </span>
        <span class="seat-right">
          <span class="seat-stake">${fmt(s.stake)}</span>
          <span class="seat-state ${stateClass}">${stateText}</span>
        </span>
      </div>`;
  }).join('');

  // صوت خفيف عندما يقلب لاعب آخر كرته
  if (lastPhase === 'playing') {
    for (const id of nowPicked) {
      if (!pickedSeats.has(id) && id !== (Session.player && Session.player.id)) Sound.flip();
    }
  }
  pickedSeats = nowPicked;
}

/* ==========================================================================
   طبقة الرسائل
   ========================================================================== */
function renderOverlay() {
  const overlay = el('overlay');
  const card = el('overlayCard');

  if (state.phase === 'betting') {
    overlay.hidden = false;
    el('board').classList.add('is-locked');
    const spots = state.maxPlayers - state.playerCount;
    card.innerHTML = `
      <h3>الجولة تبدأ قريباً</h3>
      <p>${state.playerCount === 0
        ? 'لا يوجد مشاركون بعد — ادخل الجولة من الشريط بالأسفل.'
        : `${state.playerCount} مشارك حتى الآن · ${spots} مقعد متبقٍ`}</p>
      <p style="margin-top:8px;color:var(--gold-2);font-weight:700">
        ${spots === 0 ? 'اكتمل العدد — الانطلاق فوراً!' : 'عند اكتمال 12 مشتركاً تنطلق فوراً'}
      </p>`;
    return;
  }

  el('board').classList.remove('is-locked');

  if (state.phase === 'playing' && state.you.seated && state.you.cardIndex === null) {
    overlay.hidden = true;
    return;
  }
  if (state.phase === 'playing') { overlay.hidden = true; return; }

  if (state.phase === 'results') {
    overlay.hidden = true; // نترك اللوحة مكشوفة بلا حجب
    return;
  }
  overlay.hidden = true;
}

/* ==========================================================================
   العدالة المثبتة
   ========================================================================== */
function renderFair() {
  // عرض العدالة أُزيل من واجهة اللاعب؛ الآلية نفسها ما زالت تعمل في
  // الخادم وهي التي تمنع التلاعب. نخرج بهدوء إن لم تعد العناصر موجودة.
  if (!el('fairHash')) return;
  el('fairHash').textContent = state.seedHash ? `${state.seedHash.slice(0, 40)}…` : '—';
  el('fairHash').dataset.full = state.seedHash || '';

  const wrap = el('fairSeedWrap');
  const verdict = el('fairVerdict');

  if (state.phase === 'results' && state.serverSeed) {
    wrap.hidden = false;
    el('fairSeed').textContent = `${state.serverSeed.slice(0, 40)}…`;
    el('fairSeed').dataset.full = state.serverSeed;

    if (CONFIG) {
      const revealed = state.cards.map((c) => c.multiplier);
      const check = verifyRound({
        serverSeed: state.serverSeed,
        seedHash: state.seedHash,
        roundId: state.roundId,
        cards: revealed
      }, CONFIG.templates);

      if (check.hashOk && check.boardOk) {
        verdict.className = 'verdict ok';
        verdict.textContent = '✓ تم التحقق داخل متصفحك: التوزيع مطابق للبذرة المعلنة.';
      } else {
        verdict.className = 'verdict bad';
        verdict.textContent = `✗ عدم تطابق! البصمة: ${check.hashOk ? 'سليمة' : 'خاطئة'} · التوزيع: ${check.boardOk ? 'سليم' : 'مختلف'}`;
      }
    }
  } else {
    wrap.hidden = true;
    verdict.className = 'verdict';
    verdict.textContent = 'البذرة تُنشر بعد انتهاء الجولة مباشرة.';
  }
}

/* ==========================================================================
   سجل الجولات المصغّر
   ========================================================================== */
async function loadMiniHistory() {
  try {
    const { rounds } = await API.get('/api/history');
    const box = el('miniHistory');
    if (!rounds.length) return;
    box.innerHTML = rounds.slice(0, 6).map((r) => `
      <div class="mini-round">
        <span class="mini-round__id">${r.roundId}</span>
        <span class="mini-round__chips">
          ${r.cards.map((m) => `<span class="mini-chip" data-tier="${tierOf(m)}">${m === 0 ? '✕' : m}</span>`).join('')}
        </span>
      </div>`).join('');
  } catch { /* الشبكة غير متاحة */ }
}

/* ==========================================================================
   الاحتفال
   ========================================================================== */
function confettiBurst() {
  const canvas = el('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ['#f7c948', '#ffeaa7', '#29d98c', '#8b5cf6', '#3fa9ff', '#fff'];
  const parts = [];
  for (let i = 0; i < 110; i++) {
    parts.push({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 220,
      y: window.innerHeight * 0.36,
      vx: (Math.random() - 0.5) * 11,
      vy: Math.random() * -13 - 4,
      size: Math.random() * 7 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 1
    });
  }

  let raf = null;
  const started = performance.now();
  function frame() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    let alive = false;
    for (const p of parts) {
      p.vy += 0.34;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 0.0085;
      if (p.life <= 0 || p.y > window.innerHeight + 40) continue;
      alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
      ctx.restore();
    }
    if (alive && performance.now() - started < 4500) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
  if (raf) cancelAnimationFrame(raf);
  frame();
}

/* ==========================================================================
   استقبال الحالة
   ========================================================================== */
function applyState(next) {
  const prevPhase = state ? state.phase : null;
  state = next;
  clockOffset = next.now - Date.now();
  el('connLost').hidden = true;

  // جولة جديدة -> إعادة ضبط اللوحة
  if (next.roundId !== currentRoundId) {
    currentRoundId = next.roundId;
    pickedSeats = new Set();
  }

  if (prevPhase !== next.phase) {
    lastPhase = next.phase;
    if (next.phase === 'results') cascadeReveal();
    if (next.phase === 'playing' && next.you.seated) {
      toast('انطلقت الجولة — احجز كرتك!', 'info', 2600);
    }
  }
  lastPhase = next.phase;

  renderRoundBar();
  renderBoard();
  renderOverlay();
  renderSeats();
  renderYouCard();
  renderStakeBar();
  renderFair();
  tickCountdown();
}

function handleRoundEnd(payload) {
  loadMiniHistory();
  Session.refresh().catch(() => {});

  const mine = payload.you;
  if (!mine) return;
  if (mine.payout > mine.stake) {
    Sound.win();
    confettiBurst();
    toast(`ربحت ${fmt(mine.payout)} عملة بمضاعف ×${mine.multiplier}!`, 'win', 5000);
  } else if (mine.payout === mine.stake) {
    toast(`استرداد ${fmt(mine.payout)} عملة (×1)`, 'info', 4000);
  } else {
    toast(`خسرت ${fmt(mine.stake)} عملة في هذه الجولة`, 'error', 4000);
  }
}

/* ==========================================================================
   الأزرار
   ========================================================================== */
function initActions() {
  el('joinBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    Sound.ensure();
    try {
      const data = await API.post('/api/join', { stake: selectedStake });
      Session.setPlayer(data.player);
      toast(`دخلت الجولة بمبلغ ${fmt(selectedStake)}`, 'win');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      renderStakeBar();
    }
  });

  el('leaveBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const data = await API.post('/api/leave');
      Session.setPlayer(data.player);
      toast('انسحبت من الجولة وتم استرداد مبلغك');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  el('topupBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const data = await API.post('/api/faucet');
      Session.setPlayer(data.player);
      toast(`تم شحن ${fmt(data.amount)} عملة افتراضية`, 'win');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // نسخ البصمة/البذرة بضغطة
  document.querySelectorAll('.fair-mini code').forEach((code) => {
    code.addEventListener('click', async () => {
      const full = code.dataset.full;
      if (!full) return;
      try {
        await navigator.clipboard.writeText(full);
        toast('تم النسخ');
      } catch {
        toast('تعذّر النسخ — انسخه يدوياً', 'error');
      }
    });
  });

  // زر كتم الصوت داخل شريط الجولة
  try { audioOn = localStorage.getItem('ichance.mute') !== '1'; } catch { /* تجاهل */ }
  const muteBtn = document.createElement('button');
  muteBtn.className = 'btn btn--dark btn--sm';
  muteBtn.type = 'button';
  muteBtn.style.padding = '7px 11px';
  const paint = () => { muteBtn.textContent = audioOn ? '🔊' : '🔇'; muteBtn.title = audioOn ? 'كتم الصوت' : 'تشغيل الصوت'; };
  paint();
  muteBtn.addEventListener('click', () => {
    audioOn = !audioOn;
    try { localStorage.setItem('ichance.mute', audioOn ? '0' : '1'); } catch { /* تجاهل */ }
    paint();
    if (audioOn) Sound.flip();
  });
  el('phasePill').insertAdjacentElement('afterend', muteBtn);

  // موسيقى الخلفية — زر مستقل عن مؤثرات اللعب
  const music = initMusic('lounge');
  const musicBtn = document.createElement('button');
  musicBtn.className = 'btn btn--dark btn--sm';
  musicBtn.type = 'button';
  musicBtn.style.padding = '7px 11px';
  const paintMusic = () => {
    musicBtn.textContent = music.enabled ? '♪' : '♪̸';
    musicBtn.title = music.enabled ? 'إيقاف الموسيقى' : 'تشغيل الموسيقى';
    musicBtn.style.opacity = music.enabled ? '1' : '.5';
  };
  paintMusic();
  musicBtn.addEventListener('click', () => { music.toggle('lounge'); paintMusic(); });
  muteBtn.insertAdjacentElement('afterend', musicBtn);

  // سياسة المتصفحات تمنع الصوت قبل أول تفاعل، وتوقفه عند إخفاء التبويب.
  // نستأنفه عند أول لمسة/ضغطة وعند كل عودة للصفحة حتى لا يختفي الصوت.
  const wake = () => { if (audioOn) Sound.ensure(); };
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  window.addEventListener('focus', wake);

  // اختصار لوحة المفاتيح: أرقام 1..9 لاختيار كرت
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) onCardClick(n - 1);
  });
}

/* ==========================================================================
   الإقلاع
   ========================================================================== */
(async function boot() {
  await bootSession();
  mountShell('lucky-cards');

  try {
    CONFIG = await API.get('/api/config');
  } catch (err) {
    toast('تعذّر تحميل إعدادات اللعبة — حدّث الصفحة', 'error', 8000);
    return;
  }

  buildBoard();
  buildStakeGrid();
  initActions();
  loadMiniHistory();

  Session.onChange(() => { if (state) renderStakeBar(); });

  const stream = new GameStream();
  stream.on('state', applyState);
  stream.on('round-end', handleRoundEnd);
  stream.on('offline', () => { el('connLost').hidden = false; });
  stream.connect();

  setInterval(tickCountdown, 200);

  // حالة أولية سريعة في حال تأخر البث
  API.get('/api/state').then(applyState).catch(() => {});
})();
