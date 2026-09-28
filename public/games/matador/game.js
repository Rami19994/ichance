/* ==========================================================================
   ماتادور فييستا — منطق الواجهة
   الخادم يحسم الجولة كاملة (/api/matador/spin) ويرسل خطواتها؛ هنا العرض فقط:
   سقوط الرموز، الفوز، الرقم الكبير، الانفجار، المؤطّر ← WILD، الانهيار،
   اللفات المجانية بمضاعفها، الجاكبوت، الربح الكبير. لا حساب لأي ربح هنا.
   ========================================================================== */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const A = window.MTAudio;
  const NREELS = 5, ROWS = 3;
  const CELL_W = 171, CELL_H = 162.3; // خانة البكرة بوحدات اللوح
  const REELS_X = 261, REELS_Y = 163;  // موضع البكرات داخل اللوح
  const ASSET = '/games/matador/assets/';
  // صورة الماراكاس المولَّدة كانت نسخة مطابقة من الكاستانيت (رمزان بدفع مختلف
  // لا يُميَّز أحدهما عن الآخر) — للماراكاس رسمه المتّجه حتى تُولَّد صورته
  const PORT_BOARD_K = 900 / 1036;   // العمودي: عرض الإطار (1036) يملأ عرض الهاتف
  const symSrc = (s) => `${ASSET}sym-${s}.${s === 'maracas' ? 'svg' : 'webp'}`;
  const SYMS = ['hat', 'guitar', 'maracas', 'castanets', 'fan', 'hornRed', 'hornBlue', 'hornPurple', 'hornGreen'];
  const NAMES = {
    hat: 'القبعة', guitar: 'الجيتار', maracas: 'الماراكاس', castanets: 'الكاستانيت', fan: 'المروحة',
    hornRed: 'القرن الأحمر', hornBlue: 'القرن الأزرق', hornPurple: 'القرن البنفسجي', hornGreen: 'القرن الأخضر'
  };
  const JP_ORDER = ['mini', 'minor', 'major', 'grand'];
  const DEMO_KEY = 'ichance_demo_balance';
  const DEMO_START = 100000;

  const S = {
    token: '', demo: true, loggedIn: false, username: null,
    balance: 0, currency: 'IQD',
    bets: [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000], betIdx: 4, page: 3,
    buyX: 80, maxWinX: 5000, paytable: null, fsInfo: null, jackpots: [{ key: 'mini', x: 10 }, { key: 'minor', x: 25 }, { key: 'major', x: 100 }, { key: 'grand', x: 1000 }],
    busy: false, turbo: false, auto: 0,
    cells: [], started: false, port: false, scale: 1, fsMult: 1
  };

  const els = {
    stage: $('stage'), reels: $('reels'), board: $('board'), fx: $('fx'), bull: $('bull'),
    burst: $('burst'), burstValue: $('burstValue'), scroll: $('scroll'), scrollText: $('scrollText'),
    msg: $('msg'), msgText: $('msgText'),
    spin: $('spinBtn'), autoCount: $('autoCount'), buy: $('buyBtn'),
    chips: $('chips'), betPrev: $('betPrev'), betNext: $('betNext'),
    autoBtn: $('autoBtn'), turboBtn: $('turboBtn'), repeatBtn: $('repeatBtn'), soundBtn: $('soundBtn'),
    menuBtn: $('menuBtn'), infoBtn: $('infoBtn'),
    balance: $('balance'), lastWin: $('lastWin'), winLabel: $('winLabel'),
    clock: $('clock'), badge: $('modeBadge'), roundId: $('roundId'), toast: $('toast')
  };

  // ─────────────────────────────────────────────────────── أدوات
  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfShort = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (n) => nf.format(Math.floor(Number(n) || 0));
  const speed = () => (S.turbo ? 0.45 : 1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed()));
  const bet = () => S.bets[S.betIdx];
  const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* تصفح خاص */ } };

  function readToken() {
    try { return localStorage.getItem('ichance.token') || localStorage.getItem('ichance_token') || ''; }
    catch { return ''; }
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers['x-player-token'] = S.token;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('تعذّر الاتصال بالخادم');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `خطأ ${res.status}`);
      e.status = res.status;
      e.needsLogin = !!data.needsLogin;
      throw e;
    }
    return data;
  }

  let toastTimer = null;
  function toast(text, kind = 'info', ms = 3200) {
    els.toast.textContent = text;
    els.toast.classList.toggle('is-error', kind === 'error');
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  /** حركة بـ Web Animations. fill 'backwards' لا يثبّت النهاية: القيمة النهائية
   *  تُكتب في النمط قبل الحركة دائماً (وإلا عاد العنصر لمكانه القديم). */
  function play(el, frames, opts) {
    const a = el.animate(frames, { fill: 'backwards', ...opts, duration: opts.duration * speed(), delay: (opts.delay || 0) * speed() });
    return a.finished.catch(() => {});
  }

  // ─────────────────────────────────────────────────────── المسرح والتحجيم
  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const port = vw / vh < 1;
    S.port = port;
    els.stage.classList.toggle('is-port', port);
    els.stage.classList.toggle('is-land', !port);
    const W = port ? 900 : 1376, H = port ? 1600 : 768;
    const k = Math.min(vw / W, vh / H);
    S.scale = k;
    const x = (vw - W * k) / 2, y = (vh - H * k) / 2;
    els.stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    sizeFx();
  }

  // ─────────────────────────────────────────────────────── الشبكة
  const posOf = (c, r) => `translate3d(${c * CELL_W}px,${r * CELL_H}px,0)`;

  function symbolHtml(x) {
    const s = x.s;
    let h = '';
    if (x.g) h += `<img class="mt-sym__frame" src="${ASSET}frame-gold.webp" alt="" draggable="false">`;
    h += `<img class="mt-sym__art" src="${symSrc(s)}" alt="" draggable="false">`;
    if (x.g && x.m) h += `<span class="mt-badge">${x.m}X</span>`;
    return h;
  }

  function makeCell(x) {
    const el = document.createElement('div');
    el.className = 'mt-cell' + (x.g ? ' is-gold' : '');
    el.innerHTML = `<i class="mt-cell__glow"></i><div class="mt-sym">${symbolHtml(x)}</div><i class="mt-dim"></i>`;
    return { el, s: x.s, g: !!x.g, m: x.m || 0 };
  }

  function setCell(cell, x) {
    cell.s = x.s; cell.g = !!x.g; cell.m = x.m || 0;
    cell.el.classList.toggle('is-gold', cell.g);
    cell.el.querySelector('.mt-sym').innerHTML = symbolHtml(x);
  }

  function setGrid(grid) {
    S.cells.forEach((col) => col.forEach((cell) => cell.el.remove()));
    S.cells = grid.map((col, c) => col.map((x, r) => {
      const cell = makeCell(x);
      cell.el.style.transform = posOf(c, r);
      els.reels.appendChild(cell.el);
      return cell;
    }));
  }

  function randomGrid() {
    const pool = ['hat', 'guitar', 'maracas', 'castanets', 'castanets', 'fan', 'fan', 'hornRed', 'hornRed', 'hornBlue', 'hornBlue', 'hornPurple', 'hornPurple', 'hornGreen', 'hornGreen'];
    return Array.from({ length: NREELS }, (_, c) => Array.from({ length: ROWS }, () => {
      const s = pool[Math.floor(Math.random() * pool.length)];
      const g = c >= 1 && c <= 3 && Math.random() < 0.1;
      return { s, g, m: g && Math.random() < 0.3 ? 2 : 0 };
    }));
  }

  /** الرموز الحالية تسقط للأسفل وتخرج، عموداً بعد عمود. */
  async function dropOut() {
    const jobs = [];
    S.cells.forEach((col, c) => {
      col.forEach((cell, r) => {
        const from = posOf(c, r);
        const to = `translate3d(${c * CELL_W}px,${(r + ROWS + 0.6) * CELL_H}px,0)`;
        cell.el.style.transform = to;
        jobs.push(play(cell.el, [
          { transform: from },
          { transform: to }
        ], { duration: 240, delay: c * 55, easing: 'cubic-bezier(.55,0,.95,.45)' }).then(() => cell.el.remove()));
      });
    });
    await Promise.all(jobs);
    S.cells = Array.from({ length: NREELS }, () => []);
  }

  /**
   * الدوران يبدأ لحظة الضغط، لا بعد ردّ الخادم: الرموز الحالية تسقط فوراً ثم
   * تتدفّق رموز عشوائية سريعة حتى تصل النتيجة (كان اللوح يقف ساكناً نصف ثانية
   * أو أكثر — زمن الخادم والقاعدة — قبل أن يتحرّك شيء).
   */
  function startPrespin() {
    const saved = S.cells.map((col) => col.map((c) => ({ s: c.s, g: c.g, m: c.m })));
    let stop = false;
    A.sfx.spin();
    const run = (async () => {
      await dropOut();
      while (!stop) await streamOnce();
    })();
    return { saved, async finish() { stop = true; await run; } };
  }

  /** دفعة واحدة من الرموز العشوائية تعبر كل عمود من الأعلى إلى الأسفل. */
  function streamOnce() {
    const jobs = [];
    const grid = randomGrid();
    grid.forEach((col, c) => col.forEach((x, r) => {
      const cell = makeCell({ s: x.s });
      cell.el.classList.add('is-stream');
      const from = `translate3d(${c * CELL_W}px,${(r - ROWS) * CELL_H}px,0)`;
      const to = `translate3d(${c * CELL_W}px,${(r + ROWS) * CELL_H}px,0)`;
      cell.el.style.transform = to;
      els.reels.appendChild(cell.el);
      jobs.push(play(cell.el, [{ transform: from }, { transform: to }], { duration: 230, delay: c * 22, easing: 'linear' }).then(() => cell.el.remove()));
    }));
    return Promise.all(jobs);
  }

  /** الشبكة الجديدة تسقط من الأعلى بارتداد، عموداً بعد عمود. */
  async function dropIn(grid) {
    let scat = 0;
    const jobs = grid.map((col, c) => {
      const cells = col.map((x) => makeCell(x));
      S.cells[c] = cells;
      const delay = c * 110;
      const colJobs = cells.map((cell, r) => {
        const to = posOf(c, r);
        cell.el.style.transform = to;
        els.reels.appendChild(cell.el);
        return play(cell.el, [
          { transform: `translate3d(${c * CELL_W}px,${(r - ROWS - 0.4) * CELL_H}px,0) scaleY(1.12)`, easing: 'cubic-bezier(.45,0,.9,.55)' },
          { transform: `translate3d(${c * CELL_W}px,${(r + 0.07) * CELL_H}px,0) scaleY(.94)`, offset: 0.78, easing: 'ease-out' },
          { transform: `translate3d(${c * CELL_W}px,${(r - 0.025) * CELL_H}px,0)`, offset: 0.9 },
          { transform: to }
        ], { duration: 430, delay: delay + (ROWS - 1 - r) * 22 });
      });
      setTimeout(() => {
        A.sfx.reelStop(c);
        if (col.some((x) => x.s === 'scatter')) A.sfx.scatter(scat++);
      }, (delay + 340) * speed());
      return Promise.all(colJobs);
    });
    await Promise.all(jobs);
  }

  /**
   * صمّام أمان بعد كل خطوة: كل خانة فيها رمزها فقط وفي مكانها. أيّ حركة قُطعت
   * لا تترك فراغاً ولا رمزاً فوق آخر.
   */
  function reconcile() {
    const own = new Set();
    S.cells.forEach((col, c) => col.forEach((cell, r) => {
      own.add(cell.el);
      cell.el.getAnimations().forEach((a) => a.cancel());
      cell.el.style.opacity = '';
      cell.el.style.transform = posOf(c, r);
      if (cell.el.parentNode !== els.reels) els.reels.appendChild(cell.el);
    }));
    [...els.reels.querySelectorAll('.mt-cell')].forEach((node) => { if (!own.has(node)) node.remove(); });
  }

  // ─────────────────────────────────────────────────────── الجزيئات
  const fx = { ctx: els.fx.getContext('2d'), parts: [], raf: 0, s: 1 };
  function sizeFx() {
    const boardK = S.port ? PORT_BOARD_K : 1;
    const s = Math.min(2, Math.max(0.5, S.scale * boardK * (window.devicePixelRatio || 1)));
    fx.s = s;
    els.fx.width = Math.round(1376 * s);
    els.fx.height = Math.round(768 * s);
  }
  const cellCenter = (c, r) => ({ x: REELS_X + c * CELL_W + CELL_W / 2, y: REELS_Y + r * CELL_H + CELL_H / 2 });

  function burstAt(p, { n = 22, gold = true, power = 1 } = {}) {
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const v = (2 + Math.random() * 7) * power;
      fx.parts.push({
        x: p.x, y: p.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - 3,
        life: 1, decay: 0.02 + Math.random() * 0.025,
        r: 3 + Math.random() * 6,
        hue: gold ? 40 + Math.random() * 14 : 20 + Math.random() * 30,
        light: 60 + Math.random() * 30, kind: 'spark'
      });
    }
    runFx();
  }
  function coinShower(ms = 2200) {
    const end = performance.now() + ms;
    const spawn = () => {
      if (performance.now() > end) return;
      if (fx.parts.length < 70) {
        for (let i = 0; i < 2; i++) {
          fx.parts.push({
            x: 40 + Math.random() * 1296, y: -30, vx: (Math.random() - 0.5) * 3, vy: 6 + Math.random() * 6,
            life: 1, decay: 0.012, r: 14 + Math.random() * 8, rot: Math.random() * 6, vr: 0.12 + Math.random() * 0.2, kind: 'coin'
          });
        }
      }
      setTimeout(spawn, 70);
    };
    spawn();
    runFx();
  }
  function runFx() {
    if (fx.raf) return;
    const g = fx.ctx;
    const tick = () => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, els.fx.width, els.fx.height);
      g.setTransform(fx.s, 0, 0, fx.s, 0, 0);
      fx.parts = fx.parts.filter((p) => p.life > 0 && p.y < 820);
      if (fx.parts.length > 90) fx.parts.splice(0, fx.parts.length - 90);
      for (const p of fx.parts) {
        p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        if (p.kind === 'spark') {
          p.vy += 0.35; p.vx *= 0.985;
          g.globalAlpha = Math.max(0, p.life);
          g.fillStyle = `hsl(${p.hue},95%,${p.light}%)`;
          g.beginPath(); g.arc(p.x, p.y, p.r * (0.35 + p.life * 0.65), 0, Math.PI * 2); g.fill();
        } else {
          p.vy += 0.15; p.rot += p.vr;
          g.globalAlpha = Math.min(1, p.life * 1.4);
          const sx = Math.abs(Math.cos(p.rot));
          g.fillStyle = '#f5c038';
          g.beginPath(); g.ellipse(p.x, p.y, Math.max(1, p.r * sx), p.r, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#8a5a12'; g.lineWidth = 2; g.stroke();
        }
      }
      g.globalAlpha = 1;
      if (fx.parts.length) fx.raf = requestAnimationFrame(tick);
      else { fx.raf = 0; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, els.fx.width, els.fx.height); }
    };
    fx.raf = requestAnimationFrame(tick);
  }

  // ─────────────────────────────────────────────────────── الرسائل ومؤثرات الربح
  let winDismissTimer = null;

  function scheduleWinDismiss(delayMs = 2800) {
    clearTimeout(winDismissTimer);
    winDismissTimer = setTimeout(() => {
      dismissWin();
    }, delayMs);
  }

  function dismissWin() {
    clearTimeout(winDismissTimer);
    winDismissTimer = null;
    if (els.msg.classList.contains('is-win-active')) {
      els.msg.classList.remove('is-win-active');
      els.msg.classList.add('is-fade-out');
      setTimeout(() => {
        msgIdle();
        els.msg.classList.remove('is-fade-out');
      }, 350);
    }
    if (els.burst) {
      els.burst.classList.remove('is-active');
      els.burst.hidden = true;
    }
    if (els.lastWin) {
      els.lastWin.classList.add('is-fade-dim');
      setTimeout(() => {
        els.lastWin.textContent = money(0);
        els.lastWin.classList.remove('is-fade-dim');
      }, 400);
    }
  }

  function msgIdle() {
    els.msg.classList.remove('is-win-active');
    els.msgText.innerHTML = S.stageFs ? 'لفات مجانية' : 'حظاً طيباً!';
  }

  function msgWin(value, label = 'مكسب') {
    els.msgText.innerHTML = `${label} <b>${money(value)}</b>`;
    els.msg.classList.remove('is-flash');
    els.msg.classList.remove('is-fade-out');
    void els.msg.offsetWidth;
    els.msg.classList.add('is-flash');
    els.msg.classList.add('is-win-active');
  }

  function setScroll(text, mult = false, pop = false) {
    els.scrollText.textContent = text;
    els.scroll.classList.toggle('is-mult', mult);
    if (pop) { els.scroll.classList.remove('is-pop'); void els.scroll.offsetWidth; els.scroll.classList.add('is-pop'); }
  }

  async function countTo(el, from, to, ms, attr = false) {
    const t0 = performance.now();
    const dur = Math.max(1, ms * speed());
    let lastTick = 0;
    return new Promise((resolve) => {
      const f = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
        const txt = money(v);
        el.textContent = txt;
        if (attr) el.dataset.t = txt;
        if (t - lastTick > 70) { A.sfx.tick(); lastTick = t; }
        if (k < 1) requestAnimationFrame(f); else resolve();
      };
      requestAnimationFrame(f);
    });
  }

  function setBurst(v) {
    const t = money(v);
    els.burstValue.textContent = t;
    els.burstValue.dataset.t = t;
  }

  // ─────────────────────────────────────────────────────── خطوة فوز
  async function showStep(step, runningBefore, { floor = 0, fs = false } = {}) {
    const shown = (v) => (v > 0 ? Math.max(v, floor) : v);   // اللفة الرابحة لا تُعرض بأقل من الرهان
    const winCells = step.positions.map(([c, r]) => S.cells[c][r]);
    const transformKeys = new Set(step.transform.map(([c, r]) => `${c},${r}`));
    const total = shown(runningBefore + step.win);

    // 1) الإبراز: الفائز يتوهّج والباقي يعتم
    els.reels.classList.add('is-eval');
    winCells.forEach((cell) => cell.el.classList.add('is-win'));
    const level = step.win >= bet() * 5 ? 4 : step.win >= bet() * 2 ? 3 : step.win >= bet() ? 2 : 1;
    A.sfx.win(level);

    // المضاعف: في اللعب العادي شارات هذه الخطوة، وفي المجانية المضاعف المتراكم
    if (fs) {
      if (step.mult > S.fsMult) {
        S.fsMult = step.mult;
        setScroll(`×${step.mult}`, true, true);
        A.sfx.mult();
        await sleep(550);
      }
    } else if (step.mult > 1) {
      setScroll(`×${step.mult}`, true, true);
      A.sfx.mult();
      await sleep(550);
    }

    // 2) الرقم الكبير في الوسط مع الأشعة
    const from = shown(runningBefore) || 0;
    setBurst(from);
    els.burst.hidden = false;
    els.burst.classList.add('is-active');
    play(els.burstValue, [
      { transform: 'scale(.3)', opacity: 0 },
      { transform: 'scale(1.15)', opacity: 1, offset: 0.55 },
      { transform: 'scale(1)', opacity: 1 }
    ], { duration: 380, easing: 'ease-out' });
    await countTo(els.burstValue, from, total, 650, true);
    msgWin(total);
    els.lastWin.textContent = money(total);
    await sleep(520);
    await play(els.burst, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 });
    els.burst.classList.remove('is-active');
    els.burst.hidden = true;
    if (!fs && step.mult > 1) setScroll('243 WAYS');

    // 3) الانفجار والتحوّل
    const jobs = [];
    let transformed = false;
    step.positions.forEach(([c, r]) => {
      const cell = S.cells[c][r];
      const p = cellCenter(c, r);
      if (transformKeys.has(`${c},${r}`)) {
        transformed = true;
        burstAt(p, { n: 26, power: 1.3 });
        cell.el.classList.add('is-flash');
        jobs.push(play(cell.el.querySelector('.mt-sym'), [
          { transform: 'scale(1)' }, { transform: 'scale(1.3)', offset: 0.45 }, { transform: 'scale(1)' }
        ], { duration: 520, easing: 'ease-out' }).then(() => cell.el.classList.remove('is-flash')));
        setTimeout(() => setCell(cell, { s: 'wild' }), 230 * speed());
      } else {
        burstAt(p, { n: 16 });
        const at = posOf(c, r);
        cell.el.style.opacity = '0';
        jobs.push(play(cell.el, [
          { transform: `${at} scale(1)`, opacity: 1 },
          { transform: `${at} scale(1.22)`, opacity: 1, offset: 0.3 },
          { transform: `${at} scale(.1)`, opacity: 0 }
        ], { duration: 360, easing: 'ease-in' }));
      }
    });
    A.sfx.burst();
    if (transformed) A.sfx.wild();
    await Promise.all(jobs);
    els.reels.classList.remove('is-eval');
    S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-win')));

    if (!step.drops) { reconcile(); return; }   // الخطوة الأخيرة عند بلوغ السقف

    // 4) الانهيار: الباقي يسقط والجديد ينزل من الأعلى
    const removed = new Set(step.positions.filter(([c, r]) => !transformKeys.has(`${c},${r}`)).map(([c, r]) => `${c},${r}`));
    const falls = [];
    S.cells = S.cells.map((col, c) => {
      const kept = col.filter((cell, r) => {
        if (removed.has(`${c},${r}`)) { cell.el.remove(); return false; }
        return true;
      });
      const fresh = step.drops[c].map((x) => makeCell(x));
      const next = fresh.concat(kept);
      const n = fresh.length;
      next.forEach((cell, r) => {
        const toY = r * CELL_H;
        let fromY;
        if (r < n) {
          fromY = (r - n) * CELL_H - CELL_H * 0.2;
          els.reels.appendChild(cell.el);
        } else {
          fromY = col.indexOf(cell) * CELL_H;
        }
        cell.el.style.opacity = '';
        cell.el.style.transform = posOf(c, r);
        if (fromY === toY) return;
        const dist = (toY - fromY) / CELL_H;
        falls.push(play(cell.el, [
          { transform: `translate3d(${c * CELL_W}px,${fromY}px,0)`, easing: 'cubic-bezier(.45,0,.9,.55)' },
          { transform: `translate3d(${c * CELL_W}px,${toY + CELL_H * 0.06}px,0)`, offset: 0.8, easing: 'ease-out' },
          { transform: posOf(c, r) }
        ], { duration: 250 + dist * 60, delay: c * 30 }));
      });
      return next;
    });
    setTimeout(() => A.sfx.reelStop(2), 300 * speed());
    await Promise.all(falls);
    reconcile();
    await sleep(140);
  }

  // ─────────────────────────────────────────────────────── لفة كاملة
  async function animateSpin(spin, { runningStart = 0, floor = 0, fs = false, pre = null } = {}) {
    if (pre) {
      await pre.finish();                 // اللوح يدور منذ الضغط
    } else {
      A.sfx.spin();
      await dropOut();
    }
    await dropIn(spin.grid);
    reconcile();
    let running = runningStart;
    for (const step of spin.steps) {
      await showStep(step, running, { floor, fs });
      running += step.win;
    }
    if (spin.scatters >= 3) {
      S.cells.forEach((col) => col.forEach((cell) => { if (cell.s === 'scatter') cell.el.classList.add('is-scat-on'); }));
      A.sfx.trigger();
      els.bull.classList.remove('is-cheer'); void els.bull.offsetWidth; els.bull.classList.add('is-cheer');
      await sleep(1700);
      S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-scat-on')));
    }
    return running;
  }

  function waitOverlay(id, btnId, autoMs) {
    return new Promise((resolve) => {
      const ov = $(id);
      ov.hidden = false;
      let done = false;
      const finish = () => { if (done) return; done = true; ov.hidden = true; A.sfx.click(); resolve(); };
      $(btnId).onclick = finish;
      if (autoMs) setTimeout(finish, autoMs);
    });
  }

  async function playFeature(feature) {
    $('fsIntroCount').textContent = feature.awarded;
    await waitOverlay('fsIntro', 'fsStart', S.auto !== 0 ? 3500 : 0);
    A.setMode('fs');
    S.stageFs = true;
    els.stage.classList.add('is-fs');
    S.fsMult = 1;
    setScroll('×1', true);
    let left = feature.awarded;
    let fsTotal = 0;
    for (const spin of feature.spins) {
      left--;
      els.msgText.innerHTML = `لفات مجانية <b>${left}</b>`;
      fsTotal = await animateSpin(spin, { runningStart: fsTotal, fs: true });
      if (spin.retrigger) {
        left += spin.retrigger;
        toast(`+${spin.retrigger} لفات مجانية!`, 'info', 2500);
        await sleep(900);
      }
      await sleep(250);
    }
    A.setMode('base');
    S.stageFs = false;
    els.stage.classList.remove('is-fs');
    setScroll('243 WAYS');
    $('fsOutroWin').textContent = money(feature.win);
    A.sfx.fsEnd();
    await waitOverlay('fsOutro', 'fsDone', S.auto !== 0 ? 3500 : 0);
  }

  async function bigWin(win) {
    const x = win / bet();
    if (x < 20) return;
    const title = x >= 150 ? 'ربح أسطوري!' : x >= 60 ? 'ربح ضخم!' : 'ربح كبير!';
    const ov = $('bigWin');
    $('bigWinTitle').textContent = title;
    $('bigWinValue').textContent = money(0);
    ov.hidden = false;
    A.sfx.bigWin();
    coinShower(2400);
    let skip = false;
    ov.onclick = () => { skip = true; };
    await Promise.race([
      countTo($('bigWinValue'), 0, win, 2800),
      new Promise((r) => { const p = setInterval(() => { if (skip) { clearInterval(p); r(); } }, 40); })
    ]);
    $('bigWinValue').textContent = money(win);
    await new Promise((r) => {
      const t = setTimeout(() => { ov.onclick = null; r(); }, S.auto !== 0 ? 1200 : 3000);
      ov.onclick = () => { clearTimeout(t); ov.onclick = null; r(); };
    });
    ov.hidden = true;
  }

  async function jackpotWin(jp) {
    const pill = document.querySelector(`.mt-jp[data-jp="${jp.key}"]`);
    if (pill) { pill.classList.remove('is-hit'); void pill.offsetWidth; pill.classList.add('is-hit'); }
    const ov = $('jpWin');
    $('jpGem').src = `${ASSET}gem-${jp.key}.svg`;
    $('jpName').textContent = jp.key.toUpperCase();
    $('jpValue').textContent = money(0);
    ov.hidden = false;
    A.sfx.jackpot();
    coinShower(3000);
    let skip = false;
    ov.onclick = () => { skip = true; };
    await Promise.race([
      countTo($('jpValue'), 0, jp.win, 3000),
      new Promise((r) => { const p = setInterval(() => { if (skip) { clearInterval(p); r(); } }, 40); })
    ]);
    $('jpValue').textContent = money(jp.win);
    await new Promise((r) => {
      const t = setTimeout(() => { ov.onclick = null; r(); }, S.auto !== 0 ? 1500 : 3500);
      ov.onclick = () => { clearTimeout(t); ov.onclick = null; r(); };
    });
    ov.hidden = true;
  }

  // ─────────────────────────────────────────────────────── الجولة
  function demoBalance() {
    const v = parseInt(recall(DEMO_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : DEMO_START;
  }

  async function spin({ buy = false } = {}) {
    dismissWin();
    if (S.busy) return false;
    const b = bet();
    const cost = buy ? b * S.buyX : b;
    if (S.balance < cost) {
      A.sfx.error();
      toast(S.demo ? 'نفد الرصيد التجريبي — سيُعاد ملؤه' : 'رصيدك لا يكفي — تواصل مع الكاشير للشحن', 'error');
      if (S.demo) { remember(DEMO_KEY, String(DEMO_START)); S.balance = DEMO_START; paintBalance(); }
      return false;
    }
    setBusy(true);
    msgIdle();
    els.winLabel.textContent = 'مكسب';
    els.lastWin.textContent = money(0);
    let res;
    const pre = startPrespin();
    try {
      res = await api('POST', S.demo ? '/api/matador/demo' : '/api/matador/spin', { bet: b, buy });
    } catch (err) {
      // لم تُلعب الجولة: الرموز السابقة تعود مكانها
      await pre.finish();
      await dropIn(pre.saved);
      reconcile();
      setBusy(false);
      A.sfx.error();
      if (err.needsLogin) { S.demo = true; S.balance = demoBalance(); paintMode(); paintBalance(); }
      toast(err.message, 'error', 4200);
      return false;
    }

    try {
      S.balance -= cost;
      paintBalance();
      els.roundId.textContent = `#${(res.id || Math.random().toString(16).slice(2, 14)).toUpperCase()}`;

      // لفة عادية رابحة: لا تقلّ عن الرهان (الخادم يدفع كذلك). لفة الشراء بلا حدّ
      await animateSpin(res.base, { floor: res.buy ? 0 : b, pre });
      if (res.feature) await playFeature(res.feature);
      if (res.jackpot) await jackpotWin(res.jackpot);

      const total = res.win;
      if (total > 0) {
        msgWin(total, res.feature || res.jackpot ? 'إجمالي المكسب' : 'مكسب');
        els.lastWin.textContent = money(total);
        await bigWin(total - (res.jackpot ? res.jackpot.win : 0));
        // إخفاء كمية الربح بعد انتهاء عرضها لترجع تختفي تلقائياً
        scheduleWinDismiss(2800);
      } else {
        msgIdle();
      }
      els.winLabel.textContent = 'آخر مكسب';

      if (S.demo) {
        S.balance = demoBalance() - cost + total;
        remember(DEMO_KEY, String(S.balance));
      } else {
        S.balance = Number(res.balance);
      }
      paintBalance();
      return { ok: true, feature: !!res.feature, jackpot: !!res.jackpot };
    } catch (animErr) {
      console.error('[Matador] Animation error:', animErr);
      reconcile();
      if (res && res.balance != null && !S.demo) S.balance = Number(res.balance);
      paintBalance();
      return { ok: true, feature: !!(res && res.feature) };
    } finally {
      if (els.burst) {
        els.burst.classList.remove('is-active');
        els.burst.hidden = true;
      }
      setBusy(false);
    }
  }

  function setBusy(on) {
    S.busy = on;
    const auto = S.auto !== 0;
    els.spin.classList.toggle('is-busy', on && !auto);
    els.spin.disabled = on && !auto;
    els.buy.disabled = on || auto;
    els.betPrev.disabled = on || S.page === 0;
    els.betNext.disabled = on || S.page >= S.bets.length - 4;
    els.chips.querySelectorAll('.mt-chip').forEach((ch) => { ch.disabled = on; });
    els.autoBtn.disabled = on && !auto;
    els.repeatBtn.disabled = on && !auto;
  }

  // ─────────────────────────────────────────────────────── التلقائي
  async function autoLoop(n) {
    S.auto = n;                            // -1 = بلا حدّ حتى الإيقاف
    els.spin.classList.add('is-auto');
    (n < 0 ? els.repeatBtn : els.autoBtn).classList.add('is-on');
    els.autoCount.hidden = false;
    setBusy(S.busy);
    while (S.auto !== 0) {
      els.autoCount.textContent = S.auto < 0 ? '∞' : S.auto;
      const r = await spin();
      if (!r) break;
      if (S.auto > 0) S.auto--;
      if (r.feature || r.jackpot) break;
      await sleep(250);
    }
    stopAuto();
  }
  function stopAuto() {
    S.auto = 0;
    els.spin.classList.remove('is-auto');
    els.autoBtn.classList.remove('is-on');
    els.repeatBtn.classList.remove('is-on');
    els.autoCount.hidden = true;
    setBusy(S.busy);
  }

  // ─────────────────────────────────────────────────────── العرض
  function paintBalance() {
    els.balance.textContent = `${money(S.balance)}`;
  }
  function paintChips() {
    S.page = Math.max(0, Math.min(S.page, S.bets.length - 4));
    const html = S.bets.slice(S.page, S.page + 4).map((v, i) => {
      const idx = S.page + i;
      return `<button class="mt-chip${idx === S.betIdx ? ' is-sel' : ''}" type="button" data-i="${idx}"><b>${money(v)}</b><em>العب</em></button>`;
    }).join('');
    els.chips.innerHTML = html;
    setBusy(S.busy);
  }
  function paintBet() {
    paintChips();
    const cost = `${money(bet() * S.buyX)} ${S.demo ? '' : S.currency}`.trim();
    $('buyConfirmCost').textContent = cost;
    paintJackpots();
    paintPaytable();
  }
  function paintJackpots() {
    for (const j of S.jackpots) {
      const pill = document.querySelector(`.mt-jp[data-jp="${j.key}"] [data-v]`);
      if (!pill) continue;
      const t = money(bet() * j.x);
      pill.textContent = t;
      // قيم الجاكبوت الطويلة (رهان كبير) تُصغَّر لتبقى كاملة داخل الشارة
      pill.classList.toggle('is-long', t.length > 11 && t.length <= 13);
      pill.classList.toggle('is-xlong', t.length > 13);
    }
  }
  function paintMode() {
    els.badge.textContent = S.demo ? 'وضع تجريبي' : `رصيد حقيقي · ${S.currency}`;
    paintBet();
  }
  function paintSound() {
    els.soundBtn.classList.toggle('is-off', A.muted);
    $('soundIcon').setAttribute('d', A.muted
      ? 'M4 9h4l5-4v14l-5-4H4Z M16 9l5 6 M21 9l-5 6'
      : 'M4 9h4l5-4v14l-5-4H4Z M16 8.5a5 5 0 0 1 0 7 M18.5 6a8.5 8.5 0 0 1 0 12');
    $('optMusic').checked = A.music;
    $('optSfx').checked = A.sfxOn;
  }
  function paintClock() {
    const d = new Date();
    els.clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function paintPaytable() {
    if (!S.paytable) return;
    const b = bet();
    $('payTable').innerHTML = SYMS.map((s) => {
      const rows = (S.paytable[s] || []).map(([n, p]) => `<li><b>${n}×</b> ${nf.format(p * b)}</li>`).join('');
      return `<div class="mt-pay"><img src="${symSrc(s)}" alt="${NAMES[s]}"><ul>${rows}</ul></div>`;
    }).join('');
    $('jpTable').innerHTML = JP_ORDER.map((k) => {
      const j = S.jackpots.find((x) => x.key === k) || { x: 0 };
      return `<div><img src="${ASSET}gem-${k}.svg" alt=""><span dir="ltr">${k.toUpperCase()}</span><b dir="ltr">${money(b * j.x)}</b></div>`;
    }).join('');
    const fsI = S.fsInfo || { award3: 10, award4: 15, award5: 20, retrigger: 5 };
    $('rules').innerHTML = [
      `<b>243 طريقة للفوز:</b> رموز متطابقة على بكرات متجاورة من اليسار ابتداءً من البكرة الأولى — ${S.minReels || 3} بكرات على الأقل.`,
      `<b>لا ربح أقل من رهانك:</b> اللفة الرابحة تدفع الرهان كاملاً على الأقل.`,
      `الربح = دفع الرمز × عدد الطرق × المضاعف.`,
      `<b>الانهيار:</b> الرموز الفائزة تنفجر وتسقط رموز جديدة مكانها، وقد يتكرّر الفوز.`,
      `<b>الرموز المؤطّرة بالذهبي:</b> تظهر في البكرات 2 و3 و4، وإن دخلت في ربح تتحوّل إلى الماتادور <b>WILD</b>.`,
      `<b>شارات المضاعف</b> (×2 ×3 ×5 ×8 …) على الرموز المؤطّرة: إن دخلت في ربح يُضرب ربح تلك الخطوة بمجموعها.`,
      `<b>WILD</b> يعوّض كل الرموز عدا SCATTER.`,
      `<b>SCATTER (الثور):</b> 3 = ${fsI.award3} لفات مجانية، 4 = ${fsI.award4}، 5 = ${fsI.award5}. أثناءها 3 سكاتر تضيف ${fsI.retrigger} لفات.`,
      `<b>في اللفات المجانية:</b> المؤطّر أكثر، وكل شارة تفوز تُضاف إلى مضاعف واحد يبقى حتى نهاية اللفات.`,
      `<b>الجاكبوت:</b> أربع جوائز (MINI، MINOR، MAJOR، GRAND) تساوي الرهان × 10 / 25 / 100 / 1000، وقد تُمنح مع أي لفة عادية. القيم في أعلى اللعبة هي ما يُدفع.`,
      `<b>الشراء:</b> ${S.buyX} × الرهان للدخول مباشرة إلى اللفات المجانية.`,
      `أقصى ربح في الجولة الواحدة: ${nfShort.format(S.maxWinX)} × الرهان.`,
      `الأعطال تُلغي الجولة المعنيّة.`
    ].map((t) => `<li>${t}</li>`).join('');
  }

  // ─────────────────────────────────────────────────────── الأحداث
  function onSpinPress() {
    A.init();
    if (S.auto !== 0) { stopAuto(); return; }
    if (S.busy) return;
    spin();
  }
  const anyOverlay = () => [...document.querySelectorAll('.mt-overlay')].some((o) => !o.hidden);
  els.spin.addEventListener('click', onSpinPress);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && S.started && !e.repeat && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      if (anyOverlay()) return;
      onSpinPress();
    }
  });
  els.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.mt-chip');
    if (!b || S.busy) return;
    S.betIdx = Number(b.dataset.i);
    remember('mt_bet', String(bet()));
    A.sfx.click();
    paintBet();
  });
  els.betPrev.addEventListener('click', () => { if (S.busy || S.page === 0) return; S.page--; A.sfx.click(); paintChips(); });
  els.betNext.addEventListener('click', () => { if (S.busy || S.page >= S.bets.length - 4) return; S.page++; A.sfx.click(); paintChips(); });
  els.turboBtn.addEventListener('click', () => {
    S.turbo = !S.turbo; remember('mt_turbo', S.turbo ? '1' : '0');
    els.turboBtn.classList.toggle('is-on', S.turbo); A.sfx.click();
    toast(S.turbo ? 'اللعب السريع: مفعّل' : 'اللعب السريع: متوقّف', 'info', 1400);
  });
  els.autoBtn.addEventListener('click', () => {
    A.init(); A.sfx.click();
    if (S.auto !== 0) { stopAuto(); return; }
    if (!S.busy) $('autoMenu').hidden = false;
  });
  els.repeatBtn.addEventListener('click', () => {
    A.init(); A.sfx.click();
    if (S.auto !== 0) { stopAuto(); return; }
    if (!S.busy) { toast('لفّات متتالية حتى تضغط إيقاف', 'info', 1800); autoLoop(-1); }
  });
  $('autoChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (!b) return;
    $('autoMenu').hidden = true;
    A.sfx.click();
    autoLoop(Number(b.dataset.n));
  });
  els.buy.addEventListener('click', () => {
    if (S.busy) return;
    A.init(); A.sfx.click();
    $('buyConfirm').hidden = false;
  });
  $('buyYes').addEventListener('click', () => {
    $('buyConfirm').hidden = true;
    A.sfx.click();
    spin({ buy: true });
  });
  els.soundBtn.addEventListener('click', () => {
    A.init();
    A.setMuted(!A.muted);
    if (!A.muted) A.start();
    paintSound();
  });
  const openInfo = () => { A.sfx.click(); $('infoModal').hidden = false; };
  els.menuBtn.addEventListener('click', openInfo);
  els.infoBtn.addEventListener('click', openInfo);
  $('optMusic').addEventListener('change', (e) => { A.setMusic(e.target.checked); if (e.target.checked) A.start(); });
  $('optSfx').addEventListener('change', (e) => A.setSfx(e.target.checked));
  document.querySelectorAll('.mt-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || (e.target === ov && ['buyConfirm', 'autoMenu', 'infoModal'].includes(ov.id))) ov.hidden = true;
    });
  });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(layout, 60);
  });

  // النقر في أي مكان يلغي أو يخفي عرض الربح فوراً لتفادي بقائه ثابتاً
  window.addEventListener('pointerdown', (e) => {
    if (winDismissTimer && !e.target.closest('#bigWin') && !e.target.closest('#jpWin')) {
      dismissWin();
    }
  }, { passive: true });

  // ─────────────────────────────────────────────────────── الإقلاع
  function preload() {
    const urls = [...SYMS, 'wild', 'scatter'].map(symSrc)
      .concat(['frame-gold.webp', 'bull.webp', 'logo-art.webp', 'buy.webp', 'bg.webp'].map((n) => ASSET + n));
    let done = 0;
    const bar = $('loadBar');
    const step = () => { done++; bar.style.width = `${Math.round((done / (urls.length + 1)) * 100)}%`; };
    const imgs = urls.map((u) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => { step(); r(); }; i.src = u; }));
    const font = (document.fonts && document.fonts.load) ? document.fonts.load('40px "Lilita One"').catch(() => {}).then(step) : Promise.resolve(step());
    return Promise.all([...imgs, font]);
  }

  async function loadState() {
    S.token = readToken();
    try {
      const d = await api('GET', '/api/matador/state');
      S.loggedIn = !!d.loggedIn;
      S.demo = !(S.token && d.loggedIn);
      S.username = d.username || null;
      if (Array.isArray(d.bets) && d.bets.length >= 4) S.bets = d.bets;
      S.buyX = d.buyCostX || S.buyX;
      S.maxWinX = d.maxWinX || S.maxWinX;
      S.paytable = d.paytable || null;
      S.fsInfo = d.freeSpins || null;
      S.minReels = d.minReels || 3;
      if (Array.isArray(d.jackpots) && d.jackpots.length) S.jackpots = d.jackpots;
      if (!S.demo) { S.currency = d.currency || 'IQD'; S.balance = Number(d.balance) || 0; }
      else S.balance = demoBalance();
    } catch {
      S.demo = true;
      S.balance = demoBalance();
    }
    const saved = Number(recall('mt_bet'));
    const idx = S.bets.indexOf(saved);
    S.betIdx = idx >= 0 ? idx : Math.min(4, S.bets.length - 1);
    S.page = Math.max(0, Math.min(S.betIdx - 1, S.bets.length - 4));
  }

  async function boot() {
    dismissWin();
    layout();
    setGrid(randomGrid());
    S.turbo = recall('mt_turbo') === '1';
    els.turboBtn.classList.toggle('is-on', S.turbo);
    msgIdle();
    paintClock();
    setInterval(paintClock, 10000);
    paintSound();
    paintChips();
    paintJackpots();
    await Promise.all([preload(), loadState()]);
    paintMode();
    paintBalance();
    $('loadNote').textContent = S.demo ? 'وضع تجريبي برصيد وهمي — سجّل دخولك للّعب برصيدك' : `أهلاً ${S.username || ''} — رصيدك جاهز`;
    $('startBtn').hidden = false;
    $('startBtn').onclick = async () => {
      $('loader').hidden = true;
      S.started = true;
      setBusy(true);
      A.start();
      layout();
      try {
        await dropOut();
        await dropIn(randomGrid());
        reconcile();
      } catch (e) {
        console.warn('[Matador] Initial drop error:', e);
      } finally {
        setBusy(false);
      }
    };
  }

  boot();
})();
