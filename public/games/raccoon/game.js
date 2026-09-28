/* ==========================================================================
   راكون الكونغ فو — منطق الواجهة
   الخادم يحسم الجولة كاملة (/api/raccoon/spin) ويرسل نتيجتها؛ هنا العرض فقط:
   دوران البكرات والصناديق، الخطوط الرابحة، جمع الصناديق، اللفات المجانية
   بالراكون الثابت، الجاكبوت، الربح الكبير. لا حساب لأي ربح في المتصفح.
   ========================================================================== */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const A = window.RCAudio;
  const NREELS = 3, ROWS = 3;
  const CW = 187, CH = 166;           // خانة البكرة بوحدات اللوح
  const REELS_X = 247, REELS_Y = 208;  // موضع البكرات داخل اللوح
  const ASSET = '/games/raccoon/assets/';
  const SYMS = ['pig', 'bag', 'lantern', 'gourd', 'scroll', 'darts', 'wild'];
  const NAMES = { pig: 'الخنزير الذهبي', bag: 'كيس الذهب', lantern: 'الفانوس', gourd: 'القرعة', scroll: 'اللفافة', darts: 'الخناجر', wild: 'الراكون WILD' };
  const LINES_DEFAULT = [[1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0]];
  const JP_ORDER = ['mini', 'minor', 'major', 'grand'];
  const DEMO_KEY = 'ichance_demo_balance';
  const DEMO_START = 100000;

  const S = {
    token: '', demo: true, loggedIn: false, username: null, balance: 0, currency: 'IQD',
    bets: [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000], betIdx: 3, page: 2,
    buyX: 103, anteX: 1.75, ante: false, maxWinX: 5000, paytable: null, lines: LINES_DEFAULT,
    boxMults: [2, 3, 5, 10], jackpots: [{ key: 'mini', x: 10 }, { key: 'minor', x: 25 }, { key: 'major', x: 100 }, { key: 'grand', x: 1000 }],
    fsInfo: { trigger: 3, spins: 8 },
    busy: false, turbo: false, auto: 0, started: false, port: false, scale: 1,
    cells: [], held: new Set(), fs: false
  };

  const els = {
    stage: $('stage'), reels: $('reels'), board: $('board'), fx: $('fx'), hero: $('hero'),
    boxes: [...document.querySelectorAll('.rc-box')], msg: $('msg'), msgText: $('msgText'),
    spin: $('spinBtn'), autoCount: $('autoCount'), buy: $('buyBtn'), chance: $('chanceBtn'), chanceSw: $('chanceSw'),
    chips: $('chips'), betPrev: $('betPrev'), betNext: $('betNext'),
    autoBtn: $('autoBtn'), turboBtn: $('turboBtn'), repeatBtn: $('repeatBtn'), soundBtn: $('soundBtn'),
    menuBtn: $('menuBtn'), infoBtn: $('infoBtn'),
    balance: $('balance'), lastWin: $('lastWin'), winLabel: $('winLabel'), footPays: $('footPays'),
    clock: $('clock'), badge: $('modeBadge'), roundId: $('roundId'), toast: $('toast')
  };

  // ─────────────────────────────────────────────────────── أدوات
  const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfShort = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (n) => nf.format(Math.floor(Number(n) || 0));
  const speed = () => (S.turbo ? 0.45 : 1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed()));
  const bet = () => S.bets[S.betIdx];
  const spinCost = (buy = false) => (buy ? bet() * S.buyX : S.ante ? Math.round(bet() * S.anteX) : bet());
  const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* تصفح خاص */ } };
  const readToken = () => { try { return localStorage.getItem('ichance.token') || localStorage.getItem('ichance_token') || ''; } catch { return ''; } };

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

  /** حركة Web Animations. النهاية تُكتب في النمط قبل الحركة (fill لا يثبّتها). */
  function play(el, frames, opts) {
    const a = el.animate(frames, { fill: 'backwards', ...opts, duration: opts.duration * speed(), delay: (opts.delay || 0) * speed() });
    return a.finished.catch(() => {});
  }

  // ─────────────────────────────────────────────────────── المسرح
  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    S.port = vw / vh < 1;
    els.stage.classList.toggle('is-port', S.port);
    els.stage.classList.toggle('is-land', !S.port);
    const W = S.port ? 900 : 1600, H = S.port ? 1600 : 900;
    const k = Math.min(vw / W, vh / H);
    S.scale = k;
    els.stage.style.transform = `translate(${(vw - W * k) / 2}px, ${(vh - H * k) / 2}px) scale(${k})`;
    sizeFx();
  }

  // ─────────────────────────────────────────────────────── الخانات
  const posOf = (c, r) => `translate3d(${c * CW}px,${r * CH}px,0)`;
  function makeCell(s) {
    const el = document.createElement('div');
    el.className = 'rc-cell' + (s === 'wild' ? ' is-wild' : '');
    el.innerHTML = `<i class="rc-cell__glow"></i><img src="${ASSET}sym-${s}.svg" alt="" draggable="false"><img class="rc-cell__frame" src="${ASSET}win-frame.svg" alt="">`;
    return { el, s };
  }
  function setGrid(grid) {
    els.reels.innerHTML = '';
    S.cells = grid.map((col, c) => col.map((s, r) => {
      const cell = makeCell(s);
      cell.el.style.transform = posOf(c, r);
      els.reels.appendChild(cell.el);
      return cell;
    }));
  }
  function randomSym(noWild = false) {
    const pool = ['pig', 'bag', 'bag', 'lantern', 'lantern', 'gourd', 'gourd', 'gourd', 'scroll', 'scroll', 'scroll', 'darts', 'darts', 'darts'];
    if (!noWild && Math.random() < 0.06) return 'wild';
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const randomGrid = () => Array.from({ length: NREELS }, () => Array.from({ length: ROWS }, () => randomSym()));

  // ─────────────────────────────────────────────────────── الصناديق
  const boxText = (b) => (b.t === 'x' ? `${b.v}X` : money(b.v));
  function setBox(i, b) {
    const el = els.boxes[i];
    el.classList.toggle('is-mult', b.t === 'x');
    const t = boxText(b);
    const lab = el.querySelector('b');
    lab.textContent = t;
    lab.classList.toggle('is-long', t.length > 9 && t.length <= 11);
    lab.classList.toggle('is-xlong', t.length > 11);
  }
  /** قيم عرض عشوائية أثناء الدوران فقط — القيمة الحقيقية من الخادم عند التوقّف. */
  function randomBox() {
    if (Math.random() < 0.3) return { t: 'x', v: S.boxMults[Math.floor(Math.random() * S.boxMults.length)] };
    const xs = [0.5, 1, 2, 3, 5, 10, 25];
    return { t: 'c', v: Math.floor(bet() * xs[Math.floor(Math.random() * xs.length)]) };
  }

  // ─────────────────────────────────────────────────────── الدوران
  /**
   * كل بكرة شريط: [النتيجة 3] + [رموز عشوائية] + [الحالية 3] يُزاح للأسفل حتى
   * تظهر النتيجة، والبكرات تقف من اليسار لليمين ومعها صناديقها. الخانات الثابتة
   * (راكون المجانية) لا تدور: تبقى فوق الشريط.
   */
  /**
   * البكرات تبدأ الدوران لحظة الضغط وتبقى تدور حتى يصل ردّ الخادم (كانت
   * تقف ساكنة نصف ثانية أو أكثر — زمن الخادم والقاعدة — قبل أن تتحرّك).
   */
  function startPrespin() {
    A.sfx.spin();
    const saved = S.cells.map((col) => col.map((x) => x.s));
    const loops = [];
    const rolls = [];
    for (let c = 0; c < NREELS; c++) {
      const N = 12;
      const cur = saved[c];
      // الشريط يبدأ بالرموز الحالية ويعود إليها في نهاية الدورة: الحلقة بلا قفزة
      const seq = cur.concat(Array.from({ length: N - 3 }, () => randomSym()), cur);
      const strip = document.createElement('div');
      strip.className = 'rc-strip';
      strip.style.left = `${c * CW}px`;
      strip.style.height = `${seq.length * CH}px`;
      seq.forEach((sym, i) => {
        const cell = makeCell(sym);
        cell.el.style.transform = `translate3d(0,${i * CH}px,0)`;
        strip.appendChild(cell.el);
      });
      S.cells[c].forEach((cell) => cell.el.remove());
      S.cells[c] = [];
      els.reels.insertBefore(strip, els.reels.firstChild);
      strip.style.transform = 'translate3d(0,0,0)';
      const anim = strip.animate([
        { transform: `translate3d(0,${-N * CH}px,0)` },
        { transform: 'translate3d(0,0,0)' }
      ], { duration: N * 48, delay: c * 60, iterations: Infinity, easing: 'linear', fill: 'backwards' });
      loops.push({ strip, anim });
      els.boxes[c].classList.add('is-rolling');
      rolls[c] = setInterval(() => setBox(c, randomBox()), 70);
    }
    return {
      saved,
      /** يوقف الحلقة؛ الهبوط على النتيجة يكمل من هنا. */
      stop() {
        loops.forEach(({ strip, anim }) => { anim.cancel(); strip.remove(); });
        rolls.forEach((r) => clearInterval(r));
      }
    };
  }

  async function spinReels(grid, boxes, held, pre = null) {
    const jobs = [];
    const rolls = [];
    let wildLand = 0;
    if (pre) pre.stop();
    for (let c = 0; c < NREELS; c++) {
      // بعد الدوران المسبق يكفي هبوط أقصر: البكرة تدور أصلاً منذ الضغط
      const K = pre ? 4 + c * 3 : 9 + c * 4;
      const had = S.cells[c] && S.cells[c].length ? S.cells[c].map((x) => x.s) : null;
      const cur = had || Array.from({ length: ROWS }, () => randomSym());
      const seq = grid[c].concat(Array.from({ length: K }, () => randomSym()), cur);
      const strip = document.createElement('div');
      strip.className = 'rc-strip';
      strip.style.left = `${c * CW}px`;
      strip.style.height = `${seq.length * CH}px`;
      seq.forEach((s, i) => {
        const cell = makeCell(s);
        cell.el.style.transform = `translate3d(0,${i * CH}px,0)`;
        strip.appendChild(cell.el);
      });
      // خانات العمود الحالية تُزال، والثابتة (held) تُعاد فوق الشريط
      (S.cells[c] || []).forEach((cell, r) => {
        if (held.has(`${c},${r}`)) { cell.el.classList.add('is-held'); cell.el.classList.remove('is-win'); }
        else cell.el.remove();
      });
      els.reels.insertBefore(strip, els.reels.firstChild);
      const from = -(seq.length - 3) * CH;
      strip.style.transform = 'translate3d(0,0,0)';
      const dur = pre ? 360 + c * 230 : 620 + c * 260;
      jobs.push(play(strip, [
        { transform: `translate3d(0,${from}px,0)`, easing: 'cubic-bezier(.35,.05,.45,1)' },
        { transform: `translate3d(0,${CH * 0.1}px,0)`, offset: 0.9, easing: 'ease-out' },
        { transform: 'translate3d(0,0,0)' }
      ], { duration: dur }).then(() => {
        A.sfx.reelStop(c);
        rolls[c] && clearInterval(rolls[c]);
        els.boxes[c].classList.remove('is-rolling');
        setBox(c, boxes[c]);
        if (grid[c].some((s, r) => s === 'wild' && !held.has(`${c},${r}`))) A.sfx.wild(wildLand++);
      }));
      // الصندوق يدور مع بكرته
      els.boxes[c].classList.add('is-rolling');
      rolls[c] = setInterval(() => setBox(c, randomBox()), 70);
    }
    await Promise.all(jobs);
    // الشرائط تُستبدل بخانات ثابتة
    S.cells.forEach((col) => col.forEach((cell) => cell.el.remove()));
    els.reels.innerHTML = '';
    S.cells = grid.map((col, c) => col.map((s, r) => {
      const cell = makeCell(s);
      cell.el.style.transform = posOf(c, r);
      if (held.has(`${c},${r}`)) cell.el.classList.add('is-held');
      else if (s === 'wild') cell.el.classList.add('is-land');
      els.reels.appendChild(cell.el);
      return cell;
    }));
  }

  // ─────────────────────────────────────────────────────── الجزيئات
  const fx = { ctx: els.fx.getContext('2d'), parts: [], raf: 0, s: 1 };
  function sizeFx() {
    const s = Math.min(2, Math.max(0.5, S.scale * (window.devicePixelRatio || 1)));
    fx.s = s;
    els.fx.width = Math.round(1074 * s);
    els.fx.height = Math.round(780 * s);
  }
  const cellCenter = (c, r) => ({ x: REELS_X + c * CW + CW / 2, y: REELS_Y + r * CH + CH / 2 });
  function burstAt(p, n = 18) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 6;
      fx.parts.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3, life: 1, decay: 0.022 + Math.random() * 0.02, r: 3 + Math.random() * 5, hue: 40 + Math.random() * 14, kind: 'spark' });
    }
    runFx();
  }
  function coinShower(ms = 2200) {
    const end = performance.now() + ms;
    const spawn = () => {
      if (performance.now() > end) return;
      if (fx.parts.length < 70) {
        for (let i = 0; i < 2; i++) fx.parts.push({ x: 60 + Math.random() * 950, y: -30, vx: (Math.random() - 0.5) * 3, vy: 6 + Math.random() * 6, life: 1, decay: 0.012, r: 14 + Math.random() * 8, rot: Math.random() * 6, vr: 0.12 + Math.random() * 0.2, kind: 'coin' });
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
      for (const p of fx.parts) {
        p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        if (p.kind === 'spark') {
          p.vy += 0.35; p.vx *= 0.985;
          g.globalAlpha = Math.max(0, p.life);
          g.fillStyle = `hsl(${p.hue},95%,65%)`;
          g.beginPath(); g.arc(p.x, p.y, p.r * (0.35 + p.life * 0.65), 0, Math.PI * 2); g.fill();
        } else {
          p.vy += 0.15; p.rot += p.vr;
          g.globalAlpha = Math.min(1, p.life * 1.4);
          g.fillStyle = '#f5c038';
          g.beginPath(); g.ellipse(p.x, p.y, Math.max(1, p.r * Math.abs(Math.cos(p.rot))), p.r, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#8a5a12'; g.lineWidth = 2; g.stroke();
        }
      }
      g.globalAlpha = 1;
      if (fx.parts.length) fx.raf = requestAnimationFrame(tick);
      else { fx.raf = 0; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, els.fx.width, els.fx.height); }
    };
    fx.raf = requestAnimationFrame(tick);
  }

  // ─────────────────────────────────────────────────────── الرسائل
  function msgIdle() {
    els.msg.classList.remove('is-win');
    els.msgText.innerHTML = S.fs ? els.msgText.innerHTML : 'حظاً طيباً!';
  }
  function msgSet(html, win = false) {
    els.msgText.innerHTML = html;
    els.msg.classList.toggle('is-win', win);
    els.msg.classList.remove('is-flash'); void els.msg.offsetWidth; els.msg.classList.add('is-flash');
  }
  async function countTo(el, from, to, ms) {
    const t0 = performance.now();
    const dur = Math.max(1, ms * speed());
    let last = 0;
    return new Promise((resolve) => {
      const f = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        el.textContent = money(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (t - last > 70) { A.sfx.tick(); last = t; }
        if (k < 1) requestAnimationFrame(f); else resolve();
      };
      requestAnimationFrame(f);
    });
  }

  // ─────────────────────────────────────────────────────── عرض الفوز
  async function showWin(spin, runningBefore, label) {
    if (!spin.win) return runningBefore;
    const keys = new Set();
    spin.lines.forEach((l) => l.cells.forEach(([c, r]) => keys.add(`${c},${r}`)));
    keys.forEach((k) => { const [c, r] = k.split(',').map(Number); S.cells[c][r].el.classList.add('is-win'); });
    A.sfx.win(spin.win >= bet() * 5 ? 3 : spin.win >= bet() * 2 ? 2 : 1);
    els.footPays.textContent = spin.lines.length ? `${spin.lines.length > 1 ? `${spin.lines.length} خطوط تدفع` : `الخط ${spin.lines[0].line + 1} يدفع`} ${money(spin.lines.reduce((a, l) => a + l.pay, 0))}` : '';

    // الراكون يجمع صناديق بكراته
    const collected = spin.collect.map((on, c) => (on ? c : -1)).filter((c) => c >= 0);
    if (collected.length) {
      collected.forEach((c) => {
        els.boxes[c].classList.remove('is-collect'); void els.boxes[c].offsetWidth; els.boxes[c].classList.add('is-collect');
        burstAt({ x: REELS_X + c * CW + CW / 2, y: 165 }, 16);
      });
      A.sfx.collect();
      await sleep(700);
    }
    const total = runningBefore + spin.win;
    const b = document.createElement('b');
    msgSet(`${label} `, true);
    els.msgText.appendChild(b);
    if (spin.mult > 1) {
      b.textContent = `×${spin.mult}`;
      A.sfx.mult();
      await sleep(600);
    }
    await countTo(b, runningBefore, total, 700);
    els.lastWin.textContent = money(total);
    await sleep(650);
    S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-win')));
    els.boxes.forEach((bx) => bx.classList.remove('is-collect'));
    return total;
  }

  async function playSpin(spin, { held = new Set(), running = 0, label = 'مكسب', pre = null } = {}) {
    if (!pre) A.sfx.spin();
    els.footPays.textContent = '';
    await spinReels(spin.grid, spin.boxes, held, pre);
    return showWin(spin, running, label);
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
    // الراكون الذي فتح المجانية يلمع ثم يثبت
    S.cells.forEach((col, c) => col.forEach((cell, r) => { if (feature.start.includes(`${c},${r}`)) cell.el.classList.add('is-win'); }));
    els.hero.classList.remove('is-cheer'); void els.hero.offsetWidth; els.hero.classList.add('is-cheer');
    A.sfx.trigger();
    await sleep(1500);
    S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-win')));
    $('fsIntroCount').textContent = feature.spins.length;
    await waitOverlay('fsIntro', 'fsStart', S.auto !== 0 ? 3500 : 0);
    A.setMode('fs');
    S.fs = true;
    els.stage.classList.add('is-fs');
    let total = 0;
    for (let i = 0; i < feature.spins.length; i++) {
      const s = feature.spins[i];
      const held = new Set(s.held);
      // الخانات الثابتة تظهر راكوناً قبل الدوران (وتبقى فوق الشريط)
      held.forEach((k) => {
        const [c, r] = k.split(',').map(Number);
        const cell = S.cells[c][r];
        if (cell.s !== 'wild') {
          const w = makeCell('wild');
          w.el.style.transform = posOf(c, r);
          els.reels.appendChild(w.el);
          cell.el.remove();
          S.cells[c][r] = w;
        }
        S.cells[c][r].el.classList.add('is-held');
      });
      msgSet(`لفات مجانية <b>${i + 1}/${feature.spins.length}</b>`);
      await sleep(250);
      total = await playSpin(s, { held, running: total, label: 'ربح المجانية' });
      await sleep(200);
    }
    A.setMode('base');
    S.fs = false;
    els.stage.classList.remove('is-fs');
    S.cells.forEach((col) => col.forEach((cell) => cell.el.classList.remove('is-held')));
    $('fsOutroWin').textContent = money(feature.win);
    A.sfx.fsEnd();
    await waitOverlay('fsOutro', 'fsDone', S.auto !== 0 ? 3500 : 0);
  }

  async function bigWin(win) {
    const x = win / bet();
    if (x < 20) return;
    const ov = $('bigWin');
    $('bigWinTitle').textContent = x >= 150 ? 'ربح أسطوري!' : x >= 60 ? 'ربح ضخم!' : 'ربح كبير!';
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
    const pill = document.querySelector(`.rc-jp[data-jp="${jp.key}"]`);
    if (pill) { pill.classList.remove('is-hit'); void pill.offsetWidth; pill.classList.add('is-hit'); }
    const ov = $('jpWin');
    $('jpGem').src = `/games/matador/assets/gem-${jp.key}.svg`;
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
    if (S.busy) return false;
    const cost = spinCost(buy);
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
      res = await api('POST', S.demo ? '/api/raccoon/demo' : '/api/raccoon/spin', { bet: bet(), buy, ante: !buy && S.ante });
    } catch (err) {
      // لم تُلعب الجولة: الرموز السابقة تعود مكانها
      pre.stop();
      setGrid(pre.saved);
      setBusy(false);
      A.sfx.error();
      if (err.needsLogin) { S.demo = true; S.balance = demoBalance(); paintMode(); paintBalance(); }
      toast(err.message, 'error', 4200);
      return false;
    }

    try {
      S.balance -= res.cost;
      paintBalance();
      els.roundId.textContent = `#${(res.id || Math.random().toString(16).slice(2, 14)).toUpperCase()}`;
      if (res.base) {
        // اللفة الرابحة لا تُعرض بأقل مما دُفع — الخادم يرفعها ويدفعها كذلك
        await playSpin(res.base, { pre });
      }
      if (res.feature) {
        if (!res.base) {
          // الشراء: الراكون الثلاثة الثابتة تهبط أوّلاً
          const grid = randomGrid().map((col, c) => col.map((s, r) => (res.feature.start.includes(`${c},${r}`) ? 'wild' : (s === 'wild' ? 'darts' : s))));
          await spinReels(grid, res.feature.spins[0].boxes, new Set(), pre);
        }
        await playFeature(res.feature);
      }
      if (res.jackpot) await jackpotWin(res.jackpot);

      const total = res.win;
      if (total > 0) {
        msgSet(`${res.feature || res.jackpot ? 'إجمالي المكسب' : 'مكسب'} <b>${money(total)}</b>`, true);
        els.lastWin.textContent = money(total);
        await bigWin(total - (res.jackpot ? res.jackpot.win : 0));
      } else {
        msgIdle();
      }
      els.winLabel.textContent = 'آخر مكسب';
      if (S.demo) {
        S.balance = demoBalance() - res.cost + total;
        remember(DEMO_KEY, String(S.balance));
      } else {
        S.balance = Number(res.balance);
      }
      paintBalance();
      return { ok: true, feature: !!res.feature, jackpot: !!res.jackpot };
    } catch (animErr) {
      console.error('[Raccoon] Animation error:', animErr);
      if (res && res.base) setGrid(res.base.grid);
      if (res && res.balance != null && !S.demo) S.balance = Number(res.balance);
      paintBalance();
      return { ok: true, feature: !!(res && res.feature) };
    } finally {
      S.fs = false;
      els.stage.classList.remove('is-fs');
      setBusy(false);
    }
  }

  function setBusy(on) {
    S.busy = on;
    const auto = S.auto !== 0;
    els.spin.classList.toggle('is-busy', on && !auto);
    els.spin.disabled = on && !auto;
    els.buy.disabled = on || auto;
    els.chance.disabled = on || auto;
    els.betPrev.disabled = on || S.page === 0;
    els.betNext.disabled = on || S.page >= S.bets.length - 4;
    els.chips.querySelectorAll('.rc-chip').forEach((ch) => { ch.disabled = on; });
    els.autoBtn.disabled = on && !auto;
    els.repeatBtn.disabled = on && !auto;
  }

  async function autoLoop(n) {
    S.auto = n;
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
  function paintBalance() { els.balance.textContent = money(S.balance); }
  function paintChips() {
    S.page = Math.max(0, Math.min(S.page, S.bets.length - 4));
    els.chips.innerHTML = S.bets.slice(S.page, S.page + 4).map((v, i) => {
      const idx = S.page + i;
      return `<button class="rc-chip${idx === S.betIdx ? ' is-sel' : ''}" type="button" data-i="${idx}"><b>${money(v)}</b><em>العب</em></button>`;
    }).join('');
    setBusy(S.busy);
  }
  function paintJackpots() {
    for (const j of S.jackpots) {
      const b = document.querySelector(`.rc-jp[data-jp="${j.key}"] [data-v]`);
      if (!b) continue;
      const t = money(bet() * j.x);
      b.textContent = t;
      b.classList.toggle('is-long', t.length > 11 && t.length <= 13);
      b.classList.toggle('is-xlong', t.length > 13);
    }
  }
  function paintChance() {
    els.chance.classList.toggle('is-on', S.ante);
    els.chance.setAttribute('aria-pressed', S.ante ? 'true' : 'false');
    els.chanceSw.textContent = S.ante ? 'ON' : 'OFF';
  }
  function paintBet() {
    paintChips();
    $('buyConfirmCost').textContent = `${money(bet() * S.buyX)} ${S.demo ? '' : S.currency}`.trim();
    paintJackpots();
    paintPaytable();
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
    $('payTable').innerHTML = SYMS.map((s) => `<div class="rc-pay"><img src="${ASSET}sym-${s}.svg" alt="${NAMES[s]}"><b>${nf.format((S.paytable[s] || 0) * b)}</b></div>`).join('');
    $('linesTable').innerHTML = S.lines.map((rows) => {
      let cells = '';
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells += `<i class="${rows[c] === r ? 'on' : ''}"></i>`;
      return `<div class="rc-line">${cells}</div>`;
    }).join('');
    $('jpTable').innerHTML = JP_ORDER.map((k) => {
      const j = S.jackpots.find((x) => x.key === k) || { x: 0 };
      return `<div><img src="/games/matador/assets/gem-${k}.svg" alt=""><span dir="ltr">${k.toUpperCase()}</span><b dir="ltr">${money(b * j.x)}</b></div>`;
    }).join('');
    const ante = money(Math.round(b * S.anteX));
    $('rules').innerHTML = [
      `<b>5 خطوط دفع:</b> الصفوف الثلاثة والقطران. 3 رموز متطابقة على خط تربح.`,
      `<b>لا ربح أقل مما دفعت:</b> اللفة الرابحة تدفع رهانها كاملاً على الأقل.`,
      `<b>الراكون WILD</b> يعوّض كل الرموز، و3 راكون على خط تدفع أعلى جائزة.`,
      `<b>الصناديق:</b> فوق كل بكرة صندوق يتغيّر مع كل لفة — مضاعف (مثل 2X) أو جائزة نقدية.`,
      `إذا دخل <b>الراكون في خط رابح</b> جمع صندوق بكرته: الجائزة النقدية تُضاف إلى الربح، والمضاعف يُضرب به ربح اللفة كله.`,
      `<b>3 راكون أو أكثر</b> في أي مكان = ${S.fsInfo.spins} لفات مجانية، يبقى فيها كل راكون ثابتاً في مكانه حتى النهاية.`,
      `<b>فرصة ×2:</b> رهان اللفة ${ante} بدل ${money(b)} ويضاعف فرصة اللفات المجانية.`,
      `<b>ميزة الشراء:</b> ${S.buyX} × الرهان للدخول مباشرة إلى اللفات المجانية بثلاثة راكون ثابتة.`,
      `<b>الجاكبوت:</b> أربع جوائز (MINI، MINOR، MAJOR، GRAND) تساوي الرهان × 10 / 25 / 100 / 1000، وقد تُمنح مع أي لفة عادية. القيم في أعلى اللعبة هي ما يُدفع.`,
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
  const anyOverlay = () => [...document.querySelectorAll('.rc-overlay')].some((o) => !o.hidden);
  els.spin.addEventListener('click', onSpinPress);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && S.started && !e.repeat && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      if (!anyOverlay()) onSpinPress();
    }
  });
  els.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.rc-chip');
    if (!b || S.busy) return;
    S.betIdx = Number(b.dataset.i);
    remember('rc_bet', String(bet()));
    A.sfx.click();
    paintBet();
  });
  els.betPrev.addEventListener('click', () => { if (S.busy || S.page === 0) return; S.page--; A.sfx.click(); paintChips(); });
  els.betNext.addEventListener('click', () => { if (S.busy || S.page >= S.bets.length - 4) return; S.page++; A.sfx.click(); paintChips(); });
  els.chance.addEventListener('click', () => {
    if (S.busy || S.auto !== 0) return;
    A.init(); A.sfx.click();
    S.ante = !S.ante;
    remember('rc_ante', S.ante ? '1' : '0');
    paintChance();
    paintPaytable();
    toast(S.ante ? `فرصة ×2 مفعّلة — اللفة ${money(spinCost())}` : 'فرصة ×2 متوقّفة', 'info', 1800);
  });
  els.turboBtn.addEventListener('click', () => {
    S.turbo = !S.turbo; remember('rc_turbo', S.turbo ? '1' : '0');
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
  els.buy.addEventListener('click', () => { if (S.busy) return; A.init(); A.sfx.click(); $('buyConfirm').hidden = false; });
  $('buyYes').addEventListener('click', () => { $('buyConfirm').hidden = true; A.sfx.click(); spin({ buy: true }); });
  els.soundBtn.addEventListener('click', () => { A.init(); A.setMuted(!A.muted); if (!A.muted) A.start(); paintSound(); });
  const openInfo = () => { A.sfx.click(); $('infoModal').hidden = false; };
  els.menuBtn.addEventListener('click', openInfo);
  els.infoBtn.addEventListener('click', openInfo);
  $('optMusic').addEventListener('change', (e) => { A.setMusic(e.target.checked); if (e.target.checked) A.start(); });
  $('optSfx').addEventListener('change', (e) => A.setSfx(e.target.checked));
  document.querySelectorAll('.rc-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || (e.target === ov && ['buyConfirm', 'autoMenu', 'infoModal'].includes(ov.id))) ov.hidden = true;
    });
  });
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(layout, 60); });

  // ─────────────────────────────────────────────────────── الإقلاع
  function preload() {
    const urls = SYMS.map((s) => `${ASSET}sym-${s}.svg`).concat(['gate.svg', 'raccoon.svg', 'bg.svg', 'coin.svg', 'win-frame.svg'].map((n) => ASSET + n));
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
      const d = await api('GET', '/api/raccoon/state');
      S.loggedIn = !!d.loggedIn;
      S.demo = !(S.token && d.loggedIn);
      S.username = d.username || null;
      if (Array.isArray(d.bets) && d.bets.length >= 4) S.bets = d.bets;
      S.buyX = d.buyCostX || S.buyX;
      S.anteX = d.anteCostX || S.anteX;
      S.maxWinX = d.maxWinX || S.maxWinX;
      S.paytable = d.paytable || null;
      if (Array.isArray(d.lines)) S.lines = d.lines;
      if (Array.isArray(d.boxMults)) S.boxMults = d.boxMults;
      if (Array.isArray(d.jackpots) && d.jackpots.length) S.jackpots = d.jackpots;
      if (d.freeSpins) S.fsInfo = d.freeSpins;
      if (!S.demo) { S.currency = d.currency || 'IQD'; S.balance = Number(d.balance) || 0; } else S.balance = demoBalance();
    } catch {
      S.demo = true;
      S.balance = demoBalance();
    }
    const idx = S.bets.indexOf(Number(recall('rc_bet')));
    S.betIdx = idx >= 0 ? idx : Math.min(3, S.bets.length - 1);
    S.page = Math.max(0, Math.min(S.betIdx - 1, S.bets.length - 4));
    S.ante = recall('rc_ante') === '1';
  }

  async function boot() {
    layout();
    setGrid(randomGrid());
    [{ t: 'x', v: 2 }, { t: 'c', v: 1000 }, { t: 'c', v: 1500 }].forEach((b, i) => setBox(i, b));
    S.turbo = recall('rc_turbo') === '1';
    els.turboBtn.classList.toggle('is-on', S.turbo);
    msgIdle();
    paintClock();
    setInterval(paintClock, 10000);
    paintSound();
    paintChips();
    paintJackpots();
    await Promise.all([preload(), loadState()]);
    paintMode();
    paintChance();
    paintBalance();
    [{ t: 'x', v: 2 }, { t: 'c', v: bet() * 2 }, { t: 'c', v: bet() * 3 }].forEach((b, i) => setBox(i, b));
    $('loadNote').textContent = S.demo ? 'وضع تجريبي برصيد وهمي — سجّل دخولك للّعب برصيدك' : `أهلاً ${S.username || ''} — رصيدك جاهز`;
    $('startBtn').hidden = false;
    $('startBtn').onclick = () => {
      $('loader').hidden = true;
      S.started = true;
      A.start();
      layout();
    };
  }

  boot();
})();
