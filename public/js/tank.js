/* ==========================================================================
   iCHANCE — معركة الدبابات (منطق المتصفح)
   --------------------------------------------------------------------------
   هذا الملف يرسم المعركة ويجمع ضغطات الأزرار — ولا يقرّر شيئاً.
   المحاكاة تعمل هنا لأن اللعب اللحظي يحتاج ذلك، لكن **النتيجة تأتي من
   الخادم** الذي يعيد تشغيل المعركة نفسها بالبذرة نفسها وبالضغطات نفسها.
   تعديل هذا الملف لا يربح جولة: يغيّر ما تراه لا ما يُحتسب.
   ========================================================================== */
'use strict';

const el = (id) => document.getElementById(id);
const S = window.TankSim;

const TICK_MS = 1000 / S.TICK_HZ;
const PX = 8;                       // وحدة محاكاة ← بكسل: 512 وحدة = 64 بكسل
const toPx = (u) => u / PX;

let CFG = null;
let stakes = [];
let betIndex = 0;
let diffKey = 'normal';

let sim = null;
let session = null;
let inputs = [];
let lastMask = 0;
let firedLastTick = false;
let running = false;
let rafId = 0;
let lastFrame = 0;
let particles = [];
let audioOn = true;

/* ================================= الصوت ================================= */
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
  tone(freq, duration = 0.1, type = 'square', gain = 0.04, slideTo) {
    if (!audioOn) return;
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().then(() => this.emit(ctx, freq, duration, type, gain, slideTo)).catch(() => {});
      return;
    }
    this.emit(ctx, freq, duration, type, gain, slideTo);
  },
  emit(ctx, freq, duration, type, gain, slideTo) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + duration);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  },
  shot()  { this.tone(320, 0.07, 'square', 0.03, 120); },
  brick() { this.tone(150, 0.05, 'square', 0.022); },
  clank() { this.tone(900, 0.04, 'square', 0.016); },
  kill()  { this.tone(200, 0.26, 'sawtooth', 0.05, 45); },
  hit()   { this.tone(110, 0.2, 'sawtooth', 0.06, 60); },
  dead()  { this.tone(150, 0.6, 'sawtooth', 0.07, 35); },
  win()   { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.2, 'square', 0.05), i * 100)); }
};

/* ============================== لوحة الرهان ============================== */
function buildStakes() {
  el('stakes').innerHTML = stakes
    .map((s, i) => `<button type="button" data-i="${i}" class="${i === betIndex ? 'is-on' : ''}">${fmt(s)}</button>`)
    .join('');
}

function buildDiffs() {
  el('diffs').innerHTML = CFG.difficulties.map((d) => `
    <button type="button" data-k="${d.key}" class="${d.key === diffKey ? 'is-on' : ''}">
      <span>
        <span class="d-name">${d.name}</span>
        <span class="d-meta">${d.enemies} دبابات · ${d.armor} درع · ${d.seconds}ث</span>
      </span>
      <span class="d-mult">×${d.payout.toFixed(2)}</span>
    </button>`).join('');
}

function currentDiff() {
  return CFG.difficulties.find((d) => d.key === diffKey) || CFG.difficulties[0];
}

function paintPayout() {
  const d = currentDiff();
  const bet = stakes[betIndex] || 0;
  el('payoutPreview').textContent = fmt(Math.floor(bet * d.payout));
}

function paintStats(stats) {
  if (!stats) return;
  el('mystats').innerHTML = `
    <div><span>معاركك</span><b>${fmt(stats.battles)}</b></div>
    <div><span>انتصاراتك</span><b>${fmt(stats.wins)}</b></div>
    <div><span>نسبة فوزك</span><b>${stats.battles ? (stats.winRate * 100).toFixed(0) + '%' : '—'}</b></div>
    <div><span>أفضل ربح</span><b>${fmt(stats.best)}</b></div>`;
}

function paintFair(fair, lastSeed) {
  // عرض العدالة أُزيل من واجهة اللاعب؛ الآلية نفسها ما زالت تعمل في
  // الخادم وهي التي تمنع التلاعب. نخرج بهدوء إن لم تعد العناصر موجودة.
  if (!el('seedHash')) return;
  if (fair) {
    el('seedHash').textContent = fair.seedHash;
    el('seedNonce').textContent = fmt(fair.nonce);
  }
  if (lastSeed) el('lastSeed').textContent = lastSeed;
}

/* ================================ الرسم ================================ */
const CANVAS = () => el('canvas');

function drawMap(ctx) {
  const t = S.TILE / PX;
  drawFloor(ctx);   // الأرض: شطرنج خفيف يعطي إحساس المسافة بلا ضجيج

  for (let r = 0; r < S.ROWS; r++) {
    for (let c = 0; c < S.COLS; c++) {
      const v = sim.map[r * S.COLS + c];
      if (v === S.EMPTY) continue;
      const x = c * t, y = r * t;
      if (v === S.BRICK) {
        ctx.fillStyle = '#8a3f1f';
        ctx.fillRect(x, y, t, t);
        ctx.fillStyle = '#b5552b';
        // صفّان من الطوب بإزاحة — نمط بسيط يقرأه العين كجدار
        for (let i = 0; i < 4; i++) {
          const yy = y + i * (t / 4) + 1;
          const off = (i & 1) ? t / 4 : 0;
          ctx.fillRect(x + off + 1, yy, t / 2 - 2, t / 4 - 2);
          ctx.fillRect(x + off - t / 2 + 1, yy, t / 2 - 2, t / 4 - 2);
          ctx.fillRect(x + off + t / 2 + 1, yy, t / 2 - 2, t / 4 - 2);
        }
        ctx.fillStyle = 'rgba(0,0,0,.18)';
        ctx.fillRect(x, y + t - 2, t, 2);
      } else {
        ctx.fillStyle = '#5c6675';
        ctx.fillRect(x, y, t, t);
        ctx.fillStyle = '#8b96a6';
        ctx.fillRect(x + 3, y + 3, t - 6, t - 6);
        ctx.fillStyle = '#39414d';
        ctx.fillRect(x + t / 2 - 2, y + 3, 4, t - 6);
        ctx.fillRect(x + 3, y + t / 2 - 2, t - 6, 4);
      }
    }
  }
}

/**
 * دبابة مرسومة من أشكال بسيطة — تصميم خاص بهذه اللعبة.
 * `dir`: 0 أعلى، 1 يمين، 2 أسفل، 3 يسار.
 */
function drawTank(ctx, x, y, dir, palette, tread, ghost) {
  const s = S.TANK / PX;
  const h = s / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(dir * Math.PI / 2);      // 0 = متجه للأعلى في إحداثيات الرسم
  if (ghost) ctx.globalAlpha = 0.45;

  // الجنزير
  ctx.fillStyle = palette.tread;
  ctx.fillRect(-h, -h, s * 0.26, s);
  ctx.fillRect(h - s * 0.26, -h, s * 0.26, s);
  ctx.fillStyle = palette.treadLine;
  for (let i = 0; i < 5; i++) {
    const oy = -h + ((i * s / 5) + (tread % 12) * (s / 60)) % s;
    ctx.fillRect(-h + 1, oy, s * 0.26 - 2, 2);
    ctx.fillRect(h - s * 0.26 + 1, oy, s * 0.26 - 2, 2);
  }

  // الهيكل
  ctx.fillStyle = palette.body;
  ctx.fillRect(-h + s * 0.2, -h + s * 0.08, s * 0.6, s * 0.84);
  ctx.fillStyle = palette.bodyLight;
  ctx.fillRect(-h + s * 0.26, -h + s * 0.14, s * 0.2, s * 0.7);

  // البرج والسبطانة
  ctx.fillStyle = palette.turret;
  ctx.beginPath();
  ctx.arc(0, s * 0.06, s * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.barrel;
  ctx.fillRect(-s * 0.07, -h - s * 0.1, s * 0.14, s * 0.52);

  ctx.restore();
}

const PLAYER_PAL = {
  tread: '#1c3a2c', treadLine: '#2f5f47', body: '#1f9d63', bodyLight: '#39c884',
  turret: '#2bbd7c', barrel: '#d6f5e6'
};
const ENEMY_PAL = {
  tread: '#3a1c22', treadLine: '#5f2f38', body: '#b03a4a', bodyLight: '#d4576a',
  turret: '#c9455a', barrel: '#f6d7dc'
};

function drawBullets(ctx) {
  for (const b of sim.bullets) {
    const x = toPx(b.x), y = toPx(b.y), r = S.BHALF / PX + 1;
    ctx.fillStyle = b.owner === -1 ? '#eafff4' : '#ffd9a0';
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = b.owner === -1 ? 'rgba(60,255,170,.35)' : 'rgba(255,150,60,.35)';
    ctx.fillRect(x - r * 2, y - r * 2, r * 4, r * 4);
  }
}

function spawnParticles(x, y, color, count, power) {
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count + Math.random();
    particles.push({
      x: toPx(x), y: toPx(y),
      vx: Math.cos(a) * power * (0.5 + Math.random()),
      vy: Math.sin(a) * power * (0.5 + Math.random()),
      life: 1, color
    });
  }
}

function drawParticles(ctx, dt) {
  const next = [];
  for (const p of particles) {
    p.x += p.vx * dt * 0.06;
    p.y += p.vy * dt * 0.06;
    p.life -= dt * 0.0022;
    if (p.life <= 0) continue;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 5, 5);
    next.push(p);
  }
  ctx.globalAlpha = 1;
  particles = next;
}

function drawFloor(ctx) {
  const t = S.TILE / PX;
  for (let r = 0; r < S.ROWS; r++) {
    for (let c = 0; c < S.COLS; c++) {
      ctx.fillStyle = ((r + c) & 1) ? '#141c27' : '#111823';
      ctx.fillRect(c * t, r * t, t, t);
    }
  }
}

function render(dt) {
  const cv = CANVAS();
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!sim) { drawFloor(ctx); return; }
  drawMap(ctx);

  for (const e of sim.enemies) {
    drawTank(ctx, toPx(e.x), toPx(e.y), e.dir, ENEMY_PAL, sim.tick);
  }
  const p = sim.player;
  if (p.alive) {
    // وميض أثناء المناعة: يخبر اللاعب أنه لا يتأذّى الآن بدل أن يحزر
    const blink = p.hurt > 0 && ((sim.tick >> 1) & 1);
    drawTank(ctx, toPx(p.x), toPx(p.y), p.dir, PLAYER_PAL, p.tread, blink);
  }

  drawBullets(ctx);
  drawParticles(ctx, dt);
}

/* ============================== شريط الحالة ============================== */
function paintHud() {
  if (!sim) return;
  const p = sim.player;
  const d = currentDiff();
  let pips = '';
  for (let i = 0; i < p.maxArmor; i++) pips += `<i class="${i < p.armor ? '' : 'is-gone'}"></i>`;
  el('armor').innerHTML = pips;
  el('enemiesLeft').textContent = String(d.enemies - sim.killed);

  const left = Math.max(0, Math.ceil((sim.diff.timeLimit - sim.tick) / S.TICK_HZ));
  el('timeLeft').textContent = String(left);
  el('timeLeft').parentElement.classList.toggle('is-low', left <= 10);
}

/* ============================== الأحداث ============================== */
function consumeEvents() {
  for (const ev of sim.events) {
    if (ev.t === 'fire') Sound.shot();
    else if (ev.t === 'brick') { Sound.brick(); spawnParticles(ev.x, ev.y, '#b5552b', 6, 1.6); }
    else if (ev.t === 'clank') Sound.clank();
    else if (ev.t === 'kill') { Sound.kill(); spawnParticles(ev.x, ev.y, '#ff9a5b', 16, 3); }
    else if (ev.t === 'hit') { Sound.hit(); spawnParticles(ev.x, ev.y, '#ffd166', 10, 2.2); }
    else if (ev.t === 'death') { Sound.dead(); spawnParticles(ev.x, ev.y, '#ff6b7f', 26, 3.6); }
    else if (ev.t === 'spawn') spawnParticles(ev.x, ev.y, '#8b96a6', 8, 1.4);
  }
  if (sim.shake > 0) {
    el('arena').classList.add('is-shaking');
    setTimeout(() => el('arena').classList.remove('is-shaking'), 280);
  }
}

/* ============================== الإدخال ============================== */
const held = { 0: false, 1: false, 2: false, 3: false };
let fireHeld = false;

function currentMask() {
  let m = 0;
  // اتجاه واحد في كل نبضة: المحاكاة لا تعرف الحركة القُطرية
  if (held[0]) m |= S.IN_UP;
  else if (held[1]) m |= S.IN_RIGHT;
  else if (held[2]) m |= S.IN_DOWN;
  else if (held[3]) m |= S.IN_LEFT;

  // الإطلاق يُحتسب على حافة الضغط. إبقاء الزر مضغوطاً لا يطلق إلا مرة،
  // فنولّد نبضة إفلات تلقائية ليصير الضغط المستمر إطلاقاً متتابعاً.
  if (fireHeld && !firedLastTick) m |= S.IN_FIRE;
  return m;
}

const KEYMAP = {
  ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1,
  ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3
};

function onKey(e, down) {
  if (e.repeat) return;
  const dir = KEYMAP[e.code];
  if (dir !== undefined) { held[dir] = down; e.preventDefault(); return; }
  if (e.code === 'Space' || e.code === 'Enter') { fireHeld = down; e.preventDefault(); }
}

function bindTouch() {
  for (const b of document.querySelectorAll('.dbtn')) {
    const dir = Number(b.dataset.dir);
    const set = (v) => (ev) => { ev.preventDefault(); held[dir] = v; b.classList.toggle('is-on', v); };
    b.addEventListener('pointerdown', set(true));
    b.addEventListener('pointerup', set(false));
    b.addEventListener('pointercancel', set(false));
    b.addEventListener('pointerleave', set(false));
  }
  const f = el('fireBtn');
  f.addEventListener('pointerdown', (ev) => { ev.preventDefault(); fireHeld = true; });
  f.addEventListener('pointerup', (ev) => { ev.preventDefault(); fireHeld = false; });
  f.addEventListener('pointercancel', () => { fireHeld = false; });
}

function clearInput() {
  held[0] = held[1] = held[2] = held[3] = false;
  fireHeld = false;
  for (const b of document.querySelectorAll('.dbtn')) b.classList.remove('is-on');
}

/* ============================== دورة اللعب ============================== */
/**
 * المحاكاة تسير على **ساعة الحائط** لا على إطارات الرسم.
 *
 * السبب: requestAnimationFrame يتوقّف تماماً عندما يُخفى التبويب. لو ربطنا
 * المعركة به لتجمّدت عند مغادرة الصفحة والرهان مخصوم، ولصار إخفاء التبويب
 * زرَّ إيقافٍ مجانياً يتيح التخطيط على مهل في لعبة سرعة.
 *
 * فالنبضة المستهدفة تُحسب من الزمن المنقضي، ومؤقّت خلفي يدفع المحاكاة حتى
 * لو توقّف الرسم. النتيجة: من يغادر المعركة يخسرها كما يخسر طاولة تركها.
 */
let startWall = 0;
let pumpTimer = 0;

function pump() {
  if (!running || !sim) return;
  const target = Math.min(
    Math.floor((performance.now() - startWall) / TICK_MS),
    sim.diff.timeLimit
  );

  // سقف لكل دفعة: العودة بعد غياب طويل تلزمها آلاف النبضات، ودفعها كلها
  // في إطار واحد يجمّد الصفحة. نوزّعها على دفعات ويلحق الباقي في التالية.
  let steps = 0;
  while (sim.tick < target && !sim.over && steps < 400) {
    const mask = currentMask();
    if (mask !== lastMask) { inputs.push(sim.tick, mask); lastMask = mask; }
    firedLastTick = !!(mask & S.IN_FIRE);
    S.step(sim, mask);
    consumeEvents();
    steps++;
  }

  if (sim.over) endBattle();
}

function loop(now) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(now - lastFrame, 250);
  lastFrame = now;
  pump();
  if (!running) return;        // انتهت المعركة داخل pump
  render(dt);
  paintHud();
}

function stopLoop() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = 0; }
}

/* ============================== بدء وإنهاء ============================== */
async function startBattle() {
  if (running) return;
  const bet = stakes[betIndex];
  el('startBtn').disabled = true;
  el('curtainBtn').disabled = true;

  try {
    session = await API.post('/api/tank/start', {
      bet, difficulty: diffKey,
      clientSeed: Math.random().toString(36).slice(2, 12)
    });
  } catch (err) {
    toast(err.message, 'error');
    el('startBtn').disabled = false;
    el('curtainBtn').disabled = false;
    return;
  }

  Session.setPlayer({ ...Session.player, balance: session.balance });
  paintFair(session.fair, session.seed);

  sim = S.createSim(session.seed, session.difficulty.key);
  inputs = [];
  lastMask = 0;
  firedLastTick = false;
  particles = [];
  clearInput();

  el('hud').hidden = false;
  el('touch').hidden = false;
  el('curtain').hidden = true;
  el('hudBet').textContent = fmt(session.bet);
  el('hudWin').textContent = fmt(Math.floor(session.bet * session.difficulty.payout));
  paintHud();

  Sound.ensure();
  running = true;
  lastFrame = performance.now();
  startWall = lastFrame;
  rafId = requestAnimationFrame(loop);
  // يدفع المحاكاة حتى حين يتوقّف الرسم (تبويب مخفي)
  pumpTimer = setInterval(pump, 120);
}

async function endBattle() {
  stopLoop();
  clearInput();
  render(0);
  paintHud();
  let result;
  try {
    result = await API.post('/api/tank/finish', { inputs });
  } catch (err) {
    toast(err.message, 'error');
    el('startBtn').disabled = false;
    return;
  }

  // النتيجة المعروضة هي نتيجة الخادم دائماً، لا ما حسبته الصفحة
  Session.setPlayer({ ...Session.player, balance: result.balance });
  paintStats(result.stats);
  paintFair(result.fair, result.seed);
  showResult(result);
  el('startBtn').disabled = false;
  el('curtainBtn').disabled = false;
  el('touch').hidden = true;
}

const REASON_TEXT = {
  cleared: 'طهّرت الساحة',
  killed: 'دُمّرت دبابتك',
  timeout: 'انتهى الوقت قبل أن تُنهيهم',
  abandoned: 'غادرت المعركة',
  rejected: 'رُفض سجلّ المعركة'
};

function showResult(r) {
  const box = el('curtainBox');
  box.classList.toggle('is-win', r.won);
  box.classList.toggle('is-lose', !r.won);
  el('curtainBadge').textContent = r.won ? 'نصر' : 'هزيمة';
  el('curtainTitle').textContent = r.won ? `ربحت ${fmt(r.win)}` : `خسرت ${fmt(r.bet)}`;

  el('curtainText').textContent = r.rejected
    ? `${REASON_TEXT.rejected}: ${r.rejected}`
    : REASON_TEXT[r.reason] || '';

  el('curtainStats').hidden = false;
  el('curtainStats').innerHTML = `
    <span>دمّرت <b>${r.killed}</b> من <b>${r.total}</b></span>
    <span>المضاعف <b>×${r.multiplier.toFixed(2)}</b></span>
    <span>رصيدك <b>${fmt(r.balance)}</b></span>`;

  el('curtainBtn').textContent = 'معركة جديدة';
  el('curtainHint').innerHTML = r.won
    ? 'ارفع الصعوبة لمضاعف أعلى — أو ثبّت على ما تتقنه.'
    : 'الحركة: الأسهم أو <b>WASD</b> · الإطلاق: <b>مسافة</b>';
  el('curtain').hidden = false;
  el('hud').hidden = true;

  if (r.won) { Sound.win(); toast(`نصر! ربحت ${fmt(r.win)}`, 'win'); }
}

/* =============================== الإقلاع =============================== */
async function boot() {
  await bootSession();
  mountShell('games');

  CFG = await API.get('/api/tank/config');
  const state = await API.get('/api/tank/state');
  stakes = state.stakes;
  betIndex = Math.min(1, stakes.length - 1);

  buildStakes();
  buildDiffs();
  paintPayout();
  paintStats(state.stats);
  paintFair(state.fair, null);

  // معركة معلّقة من زيارة سابقة: الرهان مخصوم، فننهيها بدل تركها تنتهي صامتة
  if (state.active) {
    toast('كانت لديك معركة لم تُنهَ — احتُسبت خسارة', 'error', 5000);
    try {
      const r = await API.post('/api/tank/finish', { inputs: [] });
      Session.setPlayer({ ...Session.player, balance: r.balance });
      paintStats(r.stats);
    } catch { /* انتهت صلاحيتها على الخادم أصلاً */ }
  }

  el('stakes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || running) return;
    betIndex = Number(b.dataset.i);
    buildStakes();
    paintPayout();
  });

  el('diffs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || running) return;
    diffKey = b.dataset.k;
    buildDiffs();
    paintPayout();
  });

  el('startBtn').addEventListener('click', startBattle);
  el('curtainBtn').addEventListener('click', startBattle);

  if (el('rotateBtn')) el('rotateBtn').addEventListener('click', async () => {
    try {
      const r = await API.post('/api/tank/rotate');
      paintFair(r.next, null);
      toast(`كُشفت بذرتك السابقة بعد ${r.battles} معركة`, 'info', 5000);
    } catch (err) { toast(err.message, 'error'); }
  });

  window.addEventListener('keydown', (e) => { if (running) onKey(e, true); });
  window.addEventListener('keyup', (e) => { if (running) onKey(e, false); });
  window.addEventListener('blur', clearInput);
  bindTouch();

  // الموسيقى تموت مع الصفحة (انظر music.js)
  initMusic('battle');

  render(0);
}

boot().catch((err) => {
  console.error(err);
  toast(err.message || 'تعذّر تحميل اللعبة', 'error', 6000);
});
