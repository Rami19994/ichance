/* ==========================================================================
   بافالو وايز 3600 — منطق الواجهة
   الخادم يحسم الجولة كاملة (/api/buffalo-ways/spin) ويرسل خطواتها؛ هنا العرض
   فقط: سقوط الرموز، الفوز، الانفجار، الذهبي ← WILD، المضاعف، الانهيار،
   اللفات المجانية، الربح الكبير. لا حساب لأي ربح في المتصفح.
   ========================================================================== */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const A = window.BWAudio;
  const REELS = [3, 4, 5, 5, 4, 3];
  const MULTS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  const ASSET = '/games/buffalo-ways/assets/';
  const IMGS = { bison: 'bison.webp', huntress: 'huntress.webp', wolf: 'wolf.webp', eagle: 'eagle.webp', wild: 'wild.webp', scatter: 'scatter.webp' };
  const LETTERS = ['A', 'K', 'Q', 'J'];
  const NAMES = { bison: 'البافالو', huntress: 'الصيّادة', wolf: 'الذئب', eagle: 'النسر', A: 'A', K: 'K', Q: 'Q', J: 'J' };
  const DEMO_KEY = 'ichance_demo_balance';
  const DEMO_START = 100000;

  const S = {
    token: '', demo: true, loggedIn: false, username: null,
    balance: 0, currency: 'IQD',
    bets: [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000], betIdx: 3,
    buyX: 75, maxWinX: 5000, paytable: null, fsInfo: null,
    busy: false, turbo: false, auto: 0,
    ladderIdx: 0, cells: [], started: false
  };

  const els = {
    game: $('game'), reels: $('reels'), board: $('board'), fx: $('fx'),
    track: $('ladderTrack'), ladder: $('ladder'), medal: document.querySelector('.bw-medal'),
    flyMult: $('flyMult'), fsBadge: $('fsBadge'), fsLeft: $('fsLeft'),
    msg: $('msg'), marquee: $('marquee'), marqueeText: $('marqueeText'), msgWin: $('msgWin'), msgLabel: $('msgLabel'), msgValue: $('msgValue'),
    spin: $('spinBtn'), autoCount: $('autoCount'), buy: $('buyBtn'), buyCost: $('buyCost'),
    betDown: $('betDown'), betUp: $('betUp'), betValue: $('betValue'),
    autoBtn: $('autoBtn'), turboBtn: $('turboBtn'), soundBtn: $('soundBtn'), menuBtn: $('menuBtn'),
    balance: $('balance'), currency: $('currency'), clock: $('clock'), badge: $('modeBadge'),
    toast: $('toast')
  };

  // ─────────────────────────────────────────────────────── أدوات
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
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

  /** حركة بـ Web Animations؛ القيمة النهائية تُكتب في النمط فتبقى بعد الانتهاء. */
  function play(el, frames, opts) {
    const a = el.animate(frames, { fill: 'backwards', ...opts, duration: opts.duration * speed(), delay: (opts.delay || 0) * speed() });
    return a.finished.catch(() => {});
  }

  // ─────────────────────────────────────────────────────── الشبكة
  let CW = 0, CH = 0;
  const cols = [];

  function buildColumns() {
    els.reels.innerHTML = '';
    cols.length = 0;
    for (let c = 0; c < REELS.length; c++) {
      const col = document.createElement('div');
      col.className = 'bw-col';
      els.reels.appendChild(col);
      cols.push(col);
    }
    measure();
  }

  function measure() {
    const r = els.reels.getBoundingClientRect();
    CW = r.width / 6;
    CH = r.height / 5;
    cols.forEach((col, c) => {
      col.style.left = `${c * CW}px`;
      col.style.top = `${((5 - REELS[c]) / 2) * CH}px`;
      col.style.height = `${REELS[c] * CH}px`;
    });
    S.cells.forEach((col) => col.forEach((cell, r) => { cell.el.style.transform = `translate3d(0,${r * CH}px,0)`; }));
  }

  function symbolHtml(s) {
    if (LETTERS.includes(s)) return `<span class="bw-letter" data-l="${s}">${s}</span>`;
    const tag = s === 'scatter' ? '<span class="bw-tag">SCATTER</span>' : '';
    return `<img src="${ASSET}${IMGS[s]}" alt="" draggable="false">${tag}`;
  }

  function makeCell(x) {
    const el = document.createElement('div');
    el.className = 'bw-cell' + (x.g ? ' is-gold' : '');
    el.innerHTML = `<div class="bw-sym">${symbolHtml(x.s)}</div>`;
    return { el, s: x.s, g: !!x.g };
  }

  function setCell(cell, s, g = false) {
    cell.s = s; cell.g = g;
    cell.el.classList.toggle('is-gold', g);
    cell.el.querySelector('.bw-sym').innerHTML = symbolHtml(s);
  }

  /** يضع الشبكة فوراً بلا حركة (البداية). */
  function setGrid(grid) {
    S.cells.forEach((col) => col.forEach((cell) => cell.el.remove()));
    S.cells = grid.map((col, c) => col.map((x, r) => {
      const cell = makeCell(x);
      cell.el.style.transform = `translate3d(0,${r * CH}px,0)`;
      cols[c].appendChild(cell.el);
      return cell;
    }));
  }

  function randomGrid() {
    const pool = ['bison', 'huntress', 'wolf', 'eagle', 'A', 'A', 'K', 'K', 'Q', 'Q', 'J', 'J'];
    return REELS.map((n, c) => Array.from({ length: n }, () => {
      const s = pool[Math.floor(Math.random() * pool.length)];
      return { s, g: (c === 2 || c === 3) && Math.random() < 0.15 };
    }));
  }

  /** الرموز الحالية تسقط للأسفل وتخرج، عمود بعد عمود. */
  async function dropOut() {
    const jobs = [];
    S.cells.forEach((col, c) => {
      const h = REELS[c] * CH;
      col.forEach((cell, r) => {
        const y = r * CH;
        jobs.push(play(cell.el, [
          { transform: `translate3d(0,${y}px,0)` },
          { transform: `translate3d(0,${y + h + CH}px,0)` }
        ], { duration: 260, delay: c * 45, easing: 'cubic-bezier(.5,0,.9,.4)' }).then(() => cell.el.remove()));
      });
    });
    await Promise.all(jobs);
    S.cells = REELS.map(() => []);
  }

  /** الشبكة الجديدة تسقط من الأعلى بارتداد، عموداً بعد عمود مع صوت الهبوط. */
  async function dropIn(grid) {
    let scat = 0;
    const jobs = grid.map((col, c) => {
      const cells = col.map((x) => makeCell(x));
      S.cells[c] = cells;
      const h = REELS[c] * CH;
      const delay = c * 95;
      const colJobs = cells.map((cell, r) => {
        const y = r * CH;
        cell.el.style.transform = `translate3d(0,${y}px,0)`;
        cols[c].appendChild(cell.el);
        return play(cell.el, [
          { transform: `translate3d(0,${y - h - CH * 0.3}px,0)`, easing: 'cubic-bezier(.45,0,.9,.55)' },
          { transform: `translate3d(0,${y + CH * 0.07}px,0)`, offset: 0.78, easing: 'ease-out' },
          { transform: `translate3d(0,${y - CH * 0.025}px,0)`, offset: 0.9 },
          { transform: `translate3d(0,${y}px,0)` }
        ], { duration: 420, delay: delay + (REELS[c] - 1 - r) * 18 });
      });
      setTimeout(() => {
        A.sfx.reelStop(c);
        if (col.some((x) => x.s === 'scatter')) A.sfx.scatter(scat++);
      }, (delay + 330) * speed());
      return Promise.all(colJobs);
    });
    await Promise.all(jobs);
  }

  // ─────────────────────────────────────────────────────── المضاعف
  let itemW = 0;
  function buildLadder() {
    const items = [];
    for (let k = 0; k < 3; k++) for (const m of MULTS) items.push(`<div class="bw-ladder__item">x${m}</div>`);
    els.track.innerHTML = items.join('');
    measureLadder();
  }
  function measureLadder() {
    const first = els.track.firstElementChild;
    itemW = first ? first.getBoundingClientRect().width : 0;
    placeLadder(S.ladderIdx, false);
  }
  function placeLadder(idx, animate) {
    const pos = MULTS.length + idx;
    const w = els.ladder.getBoundingClientRect().width;
    const x = w / 2 - (pos + 0.5) * itemW;
    els.track.style.transition = animate ? `transform ${0.45 * speed()}s cubic-bezier(.3,1.35,.5,1)` : 'none';
    els.track.style.transform = `translateX(${x}px)`;
    [...els.track.children].forEach((it, i) => it.classList.toggle('is-cur', i === pos));
  }
  function ladderTo(mult, animate = true) {
    const idx = Math.max(0, MULTS.indexOf(mult));
    if (idx === S.ladderIdx) return;
    const up = idx === S.ladderIdx + 1;
    S.ladderIdx = idx;
    placeLadder(idx, animate && up);
    if (animate && up) {
      els.medal.classList.remove('is-pop'); void els.medal.offsetWidth; els.medal.classList.add('is-pop');
      A.sfx.ladder(idx);
    }
  }

  // ─────────────────────────────────────────────────────── الجزيئات
  const fx = { ctx: els.fx.getContext('2d'), parts: [], raf: 0, dpr: 1 };
  function sizeFx() {
    const r = els.fx.getBoundingClientRect();
    fx.dpr = Math.min(2, window.devicePixelRatio || 1);
    els.fx.width = Math.round(r.width * fx.dpr);
    els.fx.height = Math.round(r.height * fx.dpr);
  }
  function cellCenter(el) {
    const a = el.getBoundingClientRect();
    const b = els.fx.getBoundingClientRect();
    return { x: (a.left + a.width / 2 - b.left) * fx.dpr, y: (a.top + a.height / 2 - b.top) * fx.dpr };
  }
  function burstAt(p, { n = 26, gold = false, power = 1 } = {}) {
    const u = CW * fx.dpr / 14;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const v = (1.5 + Math.random() * 5.5) * u * 0.35 * power;
      fx.parts.push({
        x: p.x, y: p.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - u * 0.6,
        life: 1, decay: 0.018 + Math.random() * 0.025,
        r: (0.5 + Math.random() * 1.3) * u * 0.55,
        hue: gold ? 42 + Math.random() * 12 : 28 + Math.random() * 30,
        light: gold ? 62 + Math.random() * 25 : 55 + Math.random() * 30,
        kind: 'spark'
      });
    }
    runFx();
  }
  function coinShower(ms = 2200) {
    const w = els.fx.width;
    const u = CW * fx.dpr / 14;
    const end = performance.now() + ms;
    const spawn = () => {
      if (performance.now() > end) return;
      if (fx.parts.length < 60) {
        for (let i = 0; i < 2; i++) {
          fx.parts.push({
            x: Math.random() * w, y: -u * 2, vx: (Math.random() - 0.5) * u * 0.5, vy: u * (0.9 + Math.random() * 1.1),
            life: 1, decay: 0.015, r: u * (1.2 + Math.random() * 0.7), rot: Math.random() * 6, vr: 0.12 + Math.random() * 0.2,
            kind: 'coin'
          });
        }
      }
      setTimeout(spawn, 75);
    };
    spawn();
    runFx();
  }
  function runFx() {
    if (fx.raf) return;
    const g = fx.ctx;
    const tick = () => {
      g.clearRect(0, 0, els.fx.width, els.fx.height);
      const u = CW * fx.dpr / 14;
      fx.parts = fx.parts.filter((p) => p.life > 0 && p.y < els.fx.height + u * 4);
      if (fx.parts.length > 70) fx.parts.splice(0, fx.parts.length - 70);
      for (const p of fx.parts) {
        p.x += p.vx; p.y += p.vy;
        p.life -= p.decay;
        if (p.kind === 'spark') {
          p.vy += u * 0.045; p.vx *= 0.985;
          g.globalAlpha = Math.max(0, p.life);
          g.fillStyle = `hsl(${p.hue},95%,${p.light}%)`;
          g.beginPath(); g.arc(p.x, p.y, p.r * (0.4 + p.life * 0.6), 0, Math.PI * 2); g.fill();
        } else {
          p.vy += u * 0.02; p.rot += p.vr;
          g.globalAlpha = Math.min(1, p.life * 1.4);
          const sx = Math.abs(Math.cos(p.rot));
          g.fillStyle = '#f5c038';
          g.beginPath(); g.ellipse(p.x, p.y, Math.max(1, p.r * sx), p.r, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#8a5a12'; g.lineWidth = Math.max(1, u * 0.12); g.stroke();
        }
      }
      g.globalAlpha = 1;
      if (fx.parts.length) fx.raf = requestAnimationFrame(tick);
      else { fx.raf = 0; g.clearRect(0, 0, els.fx.width, els.fx.height); }
    };
    fx.raf = requestAnimationFrame(tick);
  }

  // ─────────────────────────────────────────────────────── الرسائل
  const TIPS = [
    'مرحباً بك في بافالو وايز 3600 — 3600 طريقة للفوز!',
    'كل انهيار يضاعف المضاعف: ×1 ← ×2 ← ×4 … حتى ×1024',
    'الرموز ذات الإطار الذهبي تتحوّل إلى WILD عندما تفوز',
    '3 سكاتر أو أكثر = 12 لفة مجانية أو أكثر',
    'اللفة الرابحة تدفع رهانك كاملاً على الأقل',
    'في اللفات المجانية يبدأ المضاعف من ×4',
    'اشترِ العلاوة وادخل مباشرة إلى اللفات المجانية'
  ];
  let tipIdx = 0;
  function nextTip() { els.marqueeText.textContent = TIPS[tipIdx++ % TIPS.length]; }
  els.marqueeText.addEventListener('animationiteration', nextTip);

  function showWin(label, value, flash = true) {
    els.marquee.hidden = true;
    els.msgWin.hidden = false;
    els.msgLabel.textContent = label;
    els.msgValue.textContent = money(value);
    if (flash) { els.msg.classList.remove('is-flash'); void els.msg.offsetWidth; els.msg.classList.add('is-flash'); }
  }
  function showTips() { els.msgWin.hidden = true; els.marquee.hidden = false; }

  async function countUp(el, from, to, ms) {
    const t0 = performance.now();
    const dur = ms * speed();
    let lastTick = 0;
    return new Promise((resolve) => {
      const f = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
        el.textContent = money(v);
        if (t - lastTick > 70) { A.sfx.tick(); lastTick = t; }
        if (k < 1) requestAnimationFrame(f); else resolve();
      };
      requestAnimationFrame(f);
    });
  }

  // ─────────────────────────────────────────────────────── خطوة فوز
  async function showStep(step, runningBefore, label, floor = 0) {
    const shown = (v) => Math.max(v, floor);   // اللفة الرابحة لا تُعرض بأقل من الرهان
    const cellAt = ([c, r]) => S.cells[c][r];
    const winCells = step.positions.map(cellAt);
    const transformKeys = new Set(step.transform.map(([c, r]) => `${c},${r}`));

    // 1) الإبراز
    cols.forEach((col) => col.classList.add('is-open'));
    els.reels.classList.add('is-eval');
    winCells.forEach((cell) => cell.el.classList.add('is-win'));
    const level = step.win >= bet() * 5 ? 4 : step.win >= bet() * 2 ? 3 : step.win >= bet() ? 2 : 1;
    A.sfx.win(level);

    if (step.mult > 1) {
      showWin(label, shown(runningBefore + step.base));
      await sleep(650);
      // المضاعف يطير إلى الربح
      els.flyMult.textContent = `x${step.mult}`;
      els.flyMult.hidden = false;
      A.sfx.mult();
      const msgBox = els.msg.getBoundingClientRect();
      const brd = els.board.getBoundingClientRect();
      const dy = (msgBox.top + msgBox.height / 2) - (brd.top + brd.height * 0.46);
      await play(els.flyMult, [
        { transform: 'translate(-50%,-50%) scale(.2)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1.25)', opacity: 1, offset: 0.35 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.6 },
        { transform: `translate(-50%, calc(-50% + ${dy}px)) scale(.35)`, opacity: 0.2 }
      ], { duration: 900, easing: 'ease-in-out' });
      els.flyMult.hidden = true;
      showWin(label, shown(runningBefore + step.win));
    } else {
      showWin(label, shown(runningBefore + step.win));
    }
    await sleep(step.mult > 1 ? 350 : 750);

    // 2) الانفجار والتحوّل — المواضع تُقرأ كلها أولاً ثم تبدأ الحركات
    // (قراءة موضع بعد كل كتابة كانت تجبر المتصفح على إعادة التخطيط مراراً)
    const jobs = [];
    let transformed = false;
    const centers = step.positions.map(([c, r]) => cellCenter(S.cells[c][r].el));
    step.positions.forEach(([c, r], i) => {
      const cell = S.cells[c][r];
      const p = centers[i];
      if (transformKeys.has(`${c},${r}`)) {
        transformed = true;
        burstAt(p, { n: 26, gold: true, power: 1.3 });
        cell.el.classList.add('is-flash');
        jobs.push(play(cell.el.querySelector('.bw-sym'), [
          { transform: 'scale(1)' },
          { transform: 'scale(1.35)', offset: 0.45 },
          { transform: 'scale(1)' }
        ], { duration: 520, easing: 'ease-out' }).then(() => cell.el.classList.remove('is-flash')));
        setTimeout(() => setCell(cell, 'wild', false), 230 * speed());
      } else {
        burstAt(p, { n: 16 });
        jobs.push(play(cell.el, [
          { transform: `translate3d(0,${r * CH}px,0) scale(1)`, opacity: 1 },
          { transform: `translate3d(0,${r * CH}px,0) scale(1.25)`, opacity: 1, offset: 0.3 },
          { transform: `translate3d(0,${r * CH}px,0) scale(.1)`, opacity: 0 }
        ], { duration: 360, easing: 'ease-in', fill: 'forwards' }));
      }
    });
    A.sfx.burst();
    if (transformed) A.sfx.wild();
    await Promise.all(jobs);
    els.reels.classList.remove('is-eval');
    S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-win')));
    cols.forEach((col) => col.classList.remove('is-open'));

    if (!step.drops) return;          // الخطوة الأخيرة عند بلوغ السقف

    // 3) المضاعف يتقدّم
    ladderTo(Math.min(1024, step.mult * 2));

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
        const toY = r * CH;
        let fromY;
        if (r < n) {
          fromY = (r - n) * CH - CH * 0.15;
          cols[c].appendChild(cell.el);
        } else {
          fromY = col.indexOf(cell) * CH;
        }
        // الموضع النهائي في النمط لكل رمز — الجديد والباقي. كان الباقي يعود بعد
        // انتهاء حركة السقوط إلى مكانه القديم (الحركة لا تثبّت نهايتها)، فتبقى
        // خانات فارغة ورموز فوق بعضها.
        cell.el.style.transform = `translate3d(0,${toY}px,0)`;
        if (fromY === toY) return;
        const dist = (toY - fromY) / CH;
        falls.push(play(cell.el, [
          { transform: `translate3d(0,${fromY}px,0)`, easing: 'cubic-bezier(.45,0,.9,.55)' },
          { transform: `translate3d(0,${toY + CH * 0.06}px,0)`, offset: 0.8, easing: 'ease-out' },
          { transform: `translate3d(0,${toY}px,0)` }
        ], { duration: 240 + dist * 55, delay: c * 25 }));
      });
      return next;
    });
    setTimeout(() => A.sfx.reelStop(2), 280 * speed());
    await Promise.all(falls);
    reconcile();
    await sleep(120);
  }

  /**
   * صمّام أمان بعد كل خطوة: كل عمود فيه رموزه فقط (لا عنصر يتيم) وكل رمز في
   * خانته. أيّ حركة قُطعت أو أُلغيت لا تترك فراغاً ولا رمزاً فوق آخر.
   */
  function reconcile() {
    S.cells.forEach((col, c) => {
      const own = new Set(col.map((cell) => cell.el));
      [...cols[c].children].forEach((node) => { if (!own.has(node)) node.remove(); });
      col.forEach((cell, r) => {
        cell.el.getAnimations().forEach((a) => a.cancel());
        cell.el.style.opacity = '';
        cell.el.style.transform = `translate3d(0,${r * CH}px,0)`;
        if (cell.el.parentNode !== cols[c]) cols[c].appendChild(cell.el);
      });
    });
  }

  // ─────────────────────────────────────────────────────── لفة كاملة
  async function animateSpin(spin, { startMult, label, runningStart = 0, floor = 0 }) {
    ladderTo(startMult, false);
    A.sfx.spin();
    await dropOut();
    await dropIn(spin.grid);
    reconcile();
    let running = runningStart;
    for (const step of spin.steps) {
      await showStep(step, running, label, floor);
      running += step.win;
    }
    if (spin.scatters >= 3) {
      S.cells.forEach((col) => col.forEach((cell) => { if (cell.s === 'scatter') cell.el.classList.add('is-scat-on'); }));
      cols.forEach((col) => col.classList.add('is-open'));
      A.sfx.trigger();
      await sleep(1700);
      S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-scat-on')));
      cols.forEach((col) => col.classList.remove('is-open'));
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

  async function playFeature(feature, baseWin) {
    $('fsIntroCount').textContent = feature.awarded;
    await waitOverlay('fsIntro', 'fsStart', S.auto > 0 ? 3500 : 0);
    A.setMode('fs');
    els.game.classList.add('is-fs');
    els.fsBadge.hidden = false;
    let left = feature.awarded;
    let fsTotal = 0;
    for (const spin of feature.spins) {
      left--;
      els.fsLeft.textContent = left;
      fsTotal = await animateSpin(spin, { startMult: (S.fsInfo && S.fsInfo.startMult) || 4, label: 'ربح اللفات', runningStart: fsTotal });
      if (spin.retrigger) {
        left += spin.retrigger;
        els.fsLeft.textContent = left;
        toast(`+${spin.retrigger} لفات مجانية!`, 'info', 2500);
        await sleep(900);
      }
      if (fsTotal > 0) showWin('ربح اللفات', fsTotal, false);
      await sleep(250);
    }
    A.setMode('base');
    els.game.classList.remove('is-fs');
    els.fsBadge.hidden = true;
    $('fsOutroWin').textContent = money(feature.win);
    A.sfx.fsEnd();
    await waitOverlay('fsOutro', 'fsDone', S.auto > 0 ? 3500 : 0);
    return baseWin + feature.win;
  }

  async function bigWin(win) {
    const x = win / bet();
    if (x < 25) return;
    const title = x >= 150 ? 'ربح أسطوري!' : x >= 60 ? 'ربح ضخم!' : 'ربح كبير!';
    const ov = $('bigWin');
    $('bigWinTitle').textContent = title;
    $('bigWinValue').textContent = '0';
    ov.hidden = false;
    A.sfx.bigWin();
    coinShower(2400);
    let skip = false;
    let pollTimer = null;
    ov.onclick = () => { skip = true; };
    const counting = countUp($('bigWinValue'), 0, win, 2800);
    const skipPromise = new Promise((r) => {
      pollTimer = setInterval(() => { if (skip) { clearInterval(pollTimer); r(); } }, 40);
    });
    await Promise.race([counting, skipPromise]);
    clearInterval(pollTimer);
    $('bigWinValue').textContent = money(win);
    await new Promise((r) => {
      let t = setTimeout(() => { ov.onclick = null; r(); }, S.auto > 0 ? 1200 : 3000);
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
    showTips();
    let res;
    try {
      res = await api('POST', S.demo ? '/api/buffalo-ways/demo' : '/api/buffalo-ways/spin', { bet: b, buy });
    } catch (err) {
      setBusy(false);
      A.sfx.error();
      if (err.needsLogin) { S.demo = true; S.balance = demoBalance(); paintMode(); paintBalance(); }
      toast(err.message, 'error', 4200);
      return false;
    }

    try {
      // الرصيد يُظهر الخصم فوراً، والنتيجة في النهاية
      S.balance -= cost;
      paintBalance();

      // لفة عادية رابحة: لا تقلّ عن الرهان (الخادم يدفع كذلك). لفة الشراء بلا حدّ
      const baseWin = await animateSpin(res.base, { startMult: 1, label: 'ربح', floor: res.buy ? 0 : b });
      let total = baseWin;
      if (res.feature) total = await playFeature(res.feature, res.base.win);
      total = res.win;

      if (total > 0) {
        showWin(res.feature || res.base.steps.length > 1 ? 'إجمالي الربح' : 'ربح', total);
        await bigWin(total);
      } else {
        showTips();
      }

      if (S.demo) {
        S.balance = demoBalance() - cost + total;
        remember(DEMO_KEY, String(S.balance));
      } else {
        S.balance = Number(res.balance);
      }
      paintBalance();
      ladderTo(1, false);
      return { ok: true, feature: !!res.feature };
    } catch (animErr) {
      console.error('[BuffaloWays] Animation error:', animErr);
      if (res && res.balance != null) S.balance = Number(res.balance);
      paintBalance();
      ladderTo(1, false);
      return { ok: true, feature: !!(res && res.feature) };
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    S.busy = on;
    els.spin.classList.toggle('is-busy', on && S.auto === 0);
    els.spin.disabled = on && S.auto === 0;
    els.buy.disabled = on || S.auto > 0;
    els.betDown.disabled = on || S.betIdx === 0;
    els.betUp.disabled = on || S.betIdx === S.bets.length - 1;
    els.autoBtn.disabled = on && S.auto === 0;
  }

  // ─────────────────────────────────────────────────────── التلقائي
  async function autoLoop(n) {
    S.auto = n;
    els.spin.classList.add('is-auto');
    els.autoBtn.classList.add('is-on');
    els.autoCount.hidden = false;
    while (S.auto > 0) {
      els.autoCount.textContent = S.auto;
      const r = await spin();
      if (!r) break;
      S.auto--;
      if (r.feature) break;
      await sleep(250);
    }
    stopAuto();
  }
  function stopAuto() {
    S.auto = 0;
    els.spin.classList.remove('is-auto');
    els.autoBtn.classList.remove('is-on');
    els.autoCount.hidden = true;
    setBusy(S.busy);
  }

  // ─────────────────────────────────────────────────────── العرض
  function paintBalance() {
    els.balance.textContent = money(S.balance);
    els.currency.textContent = S.demo ? 'DEMO' : S.currency;
  }
  function paintBet() {
    els.betValue.textContent = money(bet());
    els.buyCost.textContent = `${money(bet() * S.buyX)} ${S.demo ? '' : S.currency}`.trim();
    $('buyConfirmCost').textContent = `${money(bet() * S.buyX)} ${S.demo ? '' : S.currency}`.trim();
    setBusy(S.busy);
    paintPaytable();
  }
  function paintMode() {
    els.badge.textContent = S.demo ? 'تجريبي' : 'رصيد حقيقي';
    els.badge.classList.toggle('is-real', !S.demo);
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
    const order = ['bison', 'huntress', 'wolf', 'eagle', 'A', 'K', 'Q', 'J'];
    $('payTable').innerHTML = order.map((s) => {
      const pays = S.paytable[s] || [];
      // [عدد البكرات, الدفع للطريقة] — من 4 بكرات فما فوق
      const rows = pays.map(([n, p]) => `<li><b>${n}×</b> ${nf2.format(p * b)}</li>`).join('');
      return `<div class="bw-pay"><div class="bw-pay__sym">${symbolHtml(s)}</div><ul class="bw-pay__list">${rows}</ul></div>`;
    }).join('');
    const fsI = S.fsInfo || { award3: 10, perExtra: 2, retrigger3: 5, startMult: 4 };
    $('rules').innerHTML = [
      `<b>3600 طريقة للفوز:</b> رموز متطابقة على بكرات متجاورة من اليسار ابتداءً من البكرة الأولى — ${S.minReels || 4} بكرات على الأقل.`,
      `<b>لا ربح أقل من رهانك:</b> اللفة الرابحة تدفع الرهان كاملاً على الأقل.`,
      `الربح = دفع الرمز × عدد الطرق × المضاعف الحالي.`,
      `<b>الانهيار:</b> الرموز الفائزة تنفجر وتسقط رموز جديدة مكانها، وقد يتكرّر الفوز.`,
      `<b>المضاعف:</b> يتضاعف مع كل انهيار: ×1 ← ×2 ← ×4 … حتى ×1024، ويعود إلى ×1 مع كل لفة.`,
      `<b>الرموز الذهبية:</b> تظهر في البكرتين 3 و4، وإن دخلت في ربح تتحوّل إلى <b>WILD</b>.`,
      `<b>WILD</b> يعوّض كل الرموز عدا SCATTER.`,
      `<b>SCATTER:</b> ${3} أو أكثر في أي مكان = ${fsI.award3} لفات مجانية (+${fsI.perExtra} لكل سكاتر إضافي). أثناءها 3 سكاتر تضيف ${fsI.retrigger3} لفات.`,
      `في اللفات المجانية يبدأ المضاعف من <b>×${fsI.startMult}</b> ويتضاعف مع كل انهيار، والرموز الذهبية أكثر ظهوراً.`,
      `<b>شراء العلاوة:</b> ${S.buyX} × الرهان للدخول مباشرة إلى اللفات المجانية.`,
      `أقصى ربح في الجولة الواحدة: ${nf.format(S.maxWinX)} × الرهان.`,
      `الأعطال تُلغي الجولة المعنيّة.`
    ].map((t) => `<li>${t}</li>`).join('');
  }

  // ─────────────────────────────────────────────────────── الأحداث
  function onSpinPress() {
    A.init();
    if (S.auto > 0) { stopAuto(); return; }
    if (S.busy) return;
    spin();
  }
  els.spin.addEventListener('click', onSpinPress);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && S.started && !e.repeat && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      if ([...document.querySelectorAll('.bw-overlay')].some((o) => !o.hidden)) return;
      onSpinPress();
    }
  });
  els.betDown.addEventListener('click', () => { if (S.busy || S.betIdx === 0) return; S.betIdx--; remember('bw_bet', String(bet())); A.sfx.click(); paintBet(); });
  els.betUp.addEventListener('click', () => { if (S.busy || S.betIdx >= S.bets.length - 1) return; S.betIdx++; remember('bw_bet', String(bet())); A.sfx.click(); paintBet(); });
  els.turboBtn.addEventListener('click', () => {
    S.turbo = !S.turbo; remember('bw_turbo', S.turbo ? '1' : '0');
    els.turboBtn.classList.toggle('is-on', S.turbo); A.sfx.click();
    toast(S.turbo ? 'اللعب السريع: مفعّل' : 'اللعب السريع: متوقّف', 'info', 1400);
  });
  els.autoBtn.addEventListener('click', () => {
    A.sfx.click();
    if (S.auto > 0) { stopAuto(); return; }
    if (!S.busy) $('autoMenu').hidden = false;
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
    A.sfx.click();
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
  els.menuBtn.addEventListener('click', () => { A.sfx.click(); $('infoModal').hidden = false; });
  $('optMusic').addEventListener('change', (e) => { A.setMusic(e.target.checked); if (e.target.checked) A.start(); });
  $('optSfx').addEventListener('change', (e) => A.setSfx(e.target.checked));
  document.querySelectorAll('.bw-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || (e.target === ov && ['buyConfirm', 'autoMenu', 'infoModal'].includes(ov.id))) ov.hidden = true;
    });
  });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { measure(); measureLadder(); sizeFx(); }, 80);
  });

  // ─────────────────────────────────────────────────────── الإقلاع
  function preload() {
    const urls = [...Object.values(IMGS).map((f) => ASSET + f), ASSET + 'bg.webp'];
    let done = 0;
    const bar = $('loadBar');
    const step = () => { done++; bar.style.width = `${Math.round((done / (urls.length + 1)) * 100)}%`; };
    const imgs = urls.map((u) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => { step(); r(); }; i.src = u; }));
    const font = (document.fonts && document.fonts.load) ? document.fonts.load('40px Rye').catch(() => {}).then(step) : Promise.resolve(step());
    return Promise.all([...imgs, font]);
  }

  async function loadState() {
    S.token = readToken();
    try {
      const d = await api('GET', '/api/buffalo-ways/state');
      S.loggedIn = !!d.loggedIn;
      S.demo = !(S.token && d.loggedIn);
      S.username = d.username || null;
      if (Array.isArray(d.bets) && d.bets.length) S.bets = d.bets;
      S.buyX = d.buyCostX || S.buyX;
      S.maxWinX = d.maxWinX || S.maxWinX;
      S.paytable = d.paytable || null;
      S.fsInfo = d.freeSpins || null;
      S.minReels = d.minReels || 4;
      if (!S.demo) { S.currency = d.currency || 'IQD'; S.balance = Number(d.balance) || 0; }
      else S.balance = demoBalance();
    } catch {
      S.demo = true;
      S.balance = demoBalance();
    }
    const saved = Number(recall('bw_bet'));
    const idx = S.bets.indexOf(saved);
    S.betIdx = idx >= 0 ? idx : Math.min(3, S.bets.length - 1);
  }

  async function boot() {
    buildColumns();
    buildLadder();
    sizeFx();
    setGrid(randomGrid());
    S.turbo = recall('bw_turbo') === '1';
    els.turboBtn.classList.toggle('is-on', S.turbo);
    nextTip();
    paintClock();
    setInterval(paintClock, 10000);
    paintSound();
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
      measure(); measureLadder(); sizeFx();
      try {
        await dropOut();
        await dropIn(randomGrid());
      } catch (e) {
        console.warn('[BuffaloWays] Initial drop error:', e);
      } finally {
        setBusy(false);
      }
    };
  }

  boot();
})();
