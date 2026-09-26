/* ==========================================================================
   LuckyArena — بولزآي X (الواجهة)
   --------------------------------------------------------------------------
   الخادم يقرّر الزاوية التي يصيبها السهم (server/bullseyeGame.js). هذا الملف
   يرسم القرص بقطاعات بحجم احتمالها، ويحرّك القرص بحيث يكون القطاع المقرَّر
   أسفل القرص لحظة وصول السهم بالضبط — فما تراه هو النتيجة نفسها.

   اتجاه الزوايا: درجات مع عقارب الساعة من أعلى القرص. θ = دوران القرص.
   النقطة a من القرص تظهر عند a + θ؛ السهم يصيب الأسفل (180°)، فالشرط
   لحظة الإصابة: θ ≡ 180 − a.
   ========================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------ الحالة */
  const S = {
    mode: 'classic',
    wheels: null, modes: null,
    minStake: 100, maxStake: 500000, maxGambles: 5,
    balance: 0, shownBalance: 0, currency: 'IQD',
    demo: true, token: '', username: null, enabled: true,
    busy: false,
    gamble: null,            // { amount, step, max } فرصة «ضاعف أو اخسر»
    wheelKey: 'classic'      // القرص المرسوم الآن
  };

  const MODE_TEXT = {
    classic: 'كلاسيك',
    risk: 'المخاطرة',
    double: 'السهم المزدوج',
    gamble: 'ضاعف أو اخسر'
  };

  const nf = new Intl.NumberFormat('en-US');
  const money = (n) => nf.format(Math.floor(Number(n) || 0));
  const multText = (m) => '×' + (Math.round(m * 100) / 100).toString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function readToken() {
    try { return localStorage.getItem('ichance.token') || localStorage.getItem('ichance_token') || ''; }
    catch { return ''; }
  }
  function store(key, val) { try { localStorage.setItem(key, val); } catch { /* تصفح خاص */ } }
  function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

  /* ------------------------------------------------------------ الصوت */
  const Snd = {
    ctx: null,
    muted: recall('ichance_muted') === 'true',
    init() {
      if (!this.ctx) {
        const A = window.AudioContext || window.webkitAudioContext;
        if (A) { try { this.ctx = new A(); } catch { this.ctx = null; } }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    },
    tone(freq, dur, type = 'sine', vol = 0.08, delay = 0, slideTo = null) {
      if (this.muted || !this.ctx) return;
      try {
        const t = this.ctx.currentTime + delay;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        o.connect(g); g.connect(this.ctx.destination);
        o.start(t); o.stop(t + dur + 0.02);
      } catch { /* تجاهل */ }
    },
    noise(dur, vol, fFrom, fTo) {
      if (this.muted || !this.ctx) return;
      try {
        const t = this.ctx.currentTime;
        const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const f = this.ctx.createBiquadFilter();
        f.type = 'bandpass'; f.Q.value = 1.4;
        f.frequency.setValueAtTime(fFrom, t);
        f.frequency.exponentialRampToValueAtTime(fTo, t + dur);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        src.connect(f); f.connect(g); g.connect(this.ctx.destination);
        src.start(t); src.stop(t + dur);
      } catch { /* تجاهل */ }
    },
    charge() { this.tone(220, 0.35, 'triangle', 0.05, 0, 440); },
    whoosh() { this.noise(0.32, 0.16, 500, 2600); },
    thunk() { this.tone(150, 0.2, 'triangle', 0.24, 0, 55); this.noise(0.06, 0.14, 2400, 700); },
    tick() { this.tone(1900, 0.022, 'square', 0.025); },
    win(big) {
      const notes = big ? [523, 659, 784, 1047, 1319] : [523, 659, 784];
      notes.forEach((n, i) => this.tone(n, 0.22, 'triangle', 0.09, i * 0.09));
    },
    lose() { this.tone(330, 0.3, 'sawtooth', 0.04, 0, 150); }
  };

  /* ------------------------------------------------------------ الرسم */
  const canvas = $('bxCanvas');
  const ctx = canvas.getContext('2d');
  let W = 0;            // حجم اللوحة بوحدات CSS
  let DPR = 1;
  let G = null;         // { cx, cy, R }
  let wheelCache = null;
  let cacheKey = '';

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(180, Math.round(rect.width));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (size === W && dpr === DPR) return;
    W = size; DPR = dpr;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(W * DPR);
    G = { cx: W / 2, cy: W * 0.45, R: W * 0.33 };
    wheelCache = null;
  }
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe($('canvasWrap'));
  window.addEventListener('resize', resize);

  function slicesOf(key) {
    const wheel = (S.wheels && S.wheels[key]) || [];
    const total = wheel.reduce((a, s) => a + s.w, 0) || 1;
    let acc = 0;
    return wheel.map((s, i) => {
      const a0 = (acc / total) * 360;
      acc += s.w;
      const a1 = (acc / total) * 360;
      return { i, m: s.m, w: s.w, a0, a1, span: a1 - a0, p: s.w / total };
    });
  }

  function sliceColor(m, key, zeroIdx) {
    if (key === 'gamble') return m > 0 ? ['#ffe08a', '#d99a0b'] : ['#8a1f33', '#4d0f1c'];
    if (m === 0) return zeroIdx % 2 ? ['#1d2638', '#111724'] : ['#232d42', '#151c2b'];
    if (m < 2) return ['#2dd4bf', '#0f766e'];
    if (m < 3) return ['#60a5fa', '#1d4ed8'];
    if (m < 5) return ['#a78bfa', '#6d28d9'];
    if (m < 10) return ['#f472b6', '#be185d'];
    if (m < 25) return ['#fdba74', '#ea580c'];
    return ['#fff3c4', '#f7c948'];
  }

  const rad = (deg) => (deg * Math.PI) / 180;
  /** زاوية القرص (من الأعلى مع عقارب الساعة) → زاوية canvas (من اليمين). */
  const cAng = (deg) => rad(deg - 90);

  /** القرص كاملاً بلا دوران، مرّة لكل حجم/قرص — ثم يُدار بـ drawImage كل إطار. */
  function buildWheelCache() {
    const key = `${S.wheelKey}|${W}|${DPR}`;
    if (wheelCache && cacheKey === key) return;
    cacheKey = key;
    const R = G.R;
    const half = R * 1.3;
    const c = document.createElement('canvas');
    c.width = c.height = Math.ceil(half * 2 * DPR);
    const x = c.getContext('2d');
    x.scale(DPR, DPR);
    x.translate(half, half);

    const slices = slicesOf(S.wheelKey);
    const inner = R * 0.26;
    let zeroIdx = 0;

    // القطاعات
    for (const s of slices) {
      const [c1, c2] = sliceColor(s.m, S.wheelKey, s.m === 0 ? zeroIdx++ : 0);
      const grad = x.createRadialGradient(0, 0, inner, 0, 0, R);
      grad.addColorStop(0, c2);
      grad.addColorStop(1, c1);
      x.beginPath();
      x.moveTo(0, 0);
      x.arc(0, 0, R, cAng(s.a0), cAng(s.a1));
      x.closePath();
      x.fillStyle = grad;
      x.fill();
    }
    // الفواصل
    x.strokeStyle = 'rgba(0,0,0,.45)';
    x.lineWidth = Math.max(1, R * 0.008);
    for (const s of slices) {
      x.beginPath();
      x.moveTo(Math.sin(rad(s.a0)) * inner, -Math.cos(rad(s.a0)) * inner);
      x.lineTo(Math.sin(rad(s.a0)) * R, -Math.cos(rad(s.a0)) * R);
      x.stroke();
    }

    // القطاعات الرفيعة (الجوائز الكبرى): خط متوهّج + بطاقة خارج الإطار
    for (const s of slices) {
      if (s.span >= 7 || s.m === 0) continue;
      const mid = (s.a0 + s.a1) / 2;
      x.save();
      x.shadowColor = '#f7c948';
      x.shadowBlur = R * 0.06;
      x.strokeStyle = '#ffe08a';
      x.lineWidth = Math.max(2, R * 0.016);
      x.beginPath();
      x.moveTo(Math.sin(rad(mid)) * inner, -Math.cos(rad(mid)) * inner);
      x.lineTo(Math.sin(rad(mid)) * R, -Math.cos(rad(mid)) * R);
      x.stroke();
      x.restore();

      const rr = R * 1.16;
      x.save();
      x.translate(Math.sin(rad(mid)) * rr, -Math.cos(rad(mid)) * rr);
      const fs = Math.max(9, R * 0.075);
      x.font = `900 ${fs}px Tajawal, system-ui, sans-serif`;
      const label = multText(s.m);
      const tw = x.measureText(label).width + fs * 0.9;
      x.fillStyle = 'rgba(10,12,18,.92)';
      x.strokeStyle = '#f7c948';
      x.lineWidth = 1.5;
      roundRect(x, -tw / 2, -fs * 0.75, tw, fs * 1.5, fs * 0.75);
      x.fill(); x.stroke();
      x.fillStyle = '#ffe08a';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(label, 0, fs * 0.05);
      x.restore();
    }

    // أسماء المضاعفات على القطاعات الواسعة (على امتداد نصف القطر)
    for (const s of slices) {
      if (s.span < 7) continue;
      const mid = (s.a0 + s.a1) / 2;
      x.save();
      x.rotate(rad(mid));
      const fs = clamp(R * 0.1 * Math.min(1, s.span / 14), 9, R * 0.12);
      x.font = `900 ${fs}px Tajawal, system-ui, sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.translate(0, -R * 0.7);
      x.rotate(-Math.PI / 2);
      x.fillStyle = s.m === 0 ? 'rgba(182,193,212,.55)' : (s.m >= 25 || S.wheelKey === 'gamble' ? '#1a1204' : '#fff');
      if (s.m > 0 && S.wheelKey !== 'gamble' && s.m < 25) {
        x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = 4;
      }
      x.fillText(s.m === 0 ? '×0' : multText(s.m), 0, 0);
      x.restore();
    }

    // المحور: حلقات هدف بهوية الموقع
    const hub = [[inner, '#0b0f17'], [inner * 0.86, '#d99a0b'], [inner * 0.72, '#121826'], [inner * 0.5, '#f7c948'], [inner * 0.32, '#0b0f17']];
    for (const [r, col] of hub) {
      x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.fillStyle = col; x.fill();
    }
    x.fillStyle = '#f7c948';
    x.font = `900 ${inner * 0.42}px Tajawal, system-ui, sans-serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('X', 0, inner * 0.03);

    wheelCache = c;
  }

  function roundRect(x, px, py, w, h, r) {
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + w, py, px + w, py + h, r);
    x.arcTo(px + w, py + h, px, py + h, r);
    x.arcTo(px, py + h, px, py, r);
    x.arcTo(px, py, px + w, py, r);
    x.closePath();
  }

  /** سهم: الرأس عند (0,0) يشير لأعلى، والذيل نحو +y. */
  function drawArrow(x, len, alpha = 1) {
    const R = G.R;
    x.save();
    x.globalAlpha = alpha;
    // العمود
    const shaft = x.createLinearGradient(-R * 0.02, 0, R * 0.02, 0);
    shaft.addColorStop(0, '#6b4a1a');
    shaft.addColorStop(0.5, '#e8c77a');
    shaft.addColorStop(1, '#6b4a1a');
    x.fillStyle = shaft;
    x.fillRect(-R * 0.013, R * 0.07, R * 0.026, len - R * 0.12);
    // الرأس
    x.beginPath();
    x.moveTo(0, -R * 0.005);
    x.lineTo(-R * 0.04, R * 0.1);
    x.lineTo(R * 0.04, R * 0.1);
    x.closePath();
    const head = x.createLinearGradient(0, 0, 0, R * 0.1);
    head.addColorStop(0, '#ffffff');
    head.addColorStop(1, '#9aa7bd');
    x.fillStyle = head;
    x.fill();
    // الريش
    x.fillStyle = '#ff5b73';
    x.beginPath();
    x.moveTo(-R * 0.012, len - R * 0.2);
    x.lineTo(-R * 0.07, len - R * 0.06);
    x.lineTo(-R * 0.07, len + R * 0.01);
    x.lineTo(-R * 0.012, len - R * 0.06);
    x.closePath(); x.fill();
    x.beginPath();
    x.moveTo(R * 0.012, len - R * 0.2);
    x.lineTo(R * 0.07, len - R * 0.06);
    x.lineTo(R * 0.07, len + R * 0.01);
    x.lineTo(R * 0.012, len - R * 0.06);
    x.closePath(); x.fill();
    x.fillStyle = '#f7c948';
    x.fillRect(-R * 0.013, len - R * 0.2, R * 0.026, R * 0.2);
    x.restore();
  }

  /* ------------------------------------------------------------ الحركة */
  const IDLE = 0.035;      // درجة/ms — دوران هادئ بانتظار الرمي
  const CRUISE = 0.5;      // سرعة لحظة الإصابة
  const FLIGHT = 380;      // زمن طيران السهم
  const STOP_MS = 1900;    // التباطؤ بعد آخر إصابة
  const TIP = 0.84;        // عمق رأس السهم في القرص (× R)

  const MOT = { theta: 0, omega: IDLE, mode: 'idle', segs: [], onEnd: null };

  function stepMotion(now, dt) {
    if (MOT.mode === 'plan') {
      let seg = null;
      for (const s of MOT.segs) { if (now < s.t0 + s.T) { seg = s; break; } }
      if (!seg) {
        const last = MOT.segs[MOT.segs.length - 1];
        MOT.theta = segTheta(last, last.t0 + last.T);
        MOT.omega = 0;
        MOT.mode = 'rest';
        const fn = MOT.onEnd; MOT.onEnd = null;
        if (fn) fn();
        return;
      }
      MOT.theta = segTheta(seg, now);
      MOT.omega = segOmega(seg, now);
      return;
    }
    const target = MOT.mode === 'spinup' ? CRUISE : IDLE;
    const k = 1 - Math.exp(-dt / (MOT.mode === 'spinup' ? 260 : 1400));
    MOT.omega += (target - MOT.omega) * k;
    MOT.theta += MOT.omega * dt;
    if (MOT.theta > 3600) MOT.theta -= 3600;
  }

  // مقطع Hermite: يبدأ بسرعة m0 وينتهي بـ m1 ويصل th1 بالضبط عند نهاية T
  function segTheta(s, t) {
    const u = clamp((t - s.t0) / s.T, 0, 1);
    if (s.type === 'd') return s.th0 + s.w0 * s.T * (u - (u * u) / 2);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * s.th0 + (u3 - 2 * u2 + u) * s.T * s.m0
      + (-2 * u3 + 3 * u2) * s.th1 + (u3 - u2) * s.T * s.m1;
  }
  function segOmega(s, t) {
    const u = clamp((t - s.t0) / s.T, 0, 1);
    if (s.type === 'd') return s.w0 * (1 - u);
    const d = (6 * u * u - 6 * u) * s.th0 + (3 * u * u - 4 * u + 1) * s.T * s.m0
      + (-6 * u * u + 6 * u) * s.th1 + (3 * u * u - 2 * u) * s.T * s.m1;
    return d / s.T;
  }

  const mod360 = (v) => ((v % 360) + 360) % 360;

  /** يخطّط دوران القرص ليكون كل هدف أسفل القرص لحظة وصول سهمه. */
  function planArrows(arrows, onImpact, onEnd) {
    const now = performance.now();
    let t = now, th = MOT.theta, w = Math.max(MOT.omega, 0.02);
    const segs = [];
    const flights = [];
    arrows.forEach((ar, idx) => {
      const target = mod360(180 - ar.angle);
      const avg = idx === 0 ? (w + CRUISE) / 2 : CRUISE;
      const minTh = th + Math.max(avg * (idx === 0 ? 700 : 760), 200);
      const th1 = minTh + mod360(target - minTh);
      const T = clamp((th1 - th) / avg, idx === 0 ? 600 : 700, 1700);
      segs.push({ type: 'h', t0: t, T, th0: th, th1, m0: w, m1: CRUISE });
      t += T; th = th1; w = CRUISE;
      flights.push({ launch: t - FLIGHT, impact: t, angle: ar.angle, multiplier: ar.multiplier, state: 'wait', idx });
    });
    segs.push({ type: 'd', t0: t, T: STOP_MS, th0: th, w0: w });
    MOT.segs = segs;
    MOT.mode = 'plan';
    MOT.onEnd = onEnd;
    FLY.list = flights;
    FLY.onImpact = onImpact;
  }

  /* ------------------------------------------------------------ الأسهم والمؤثرات */
  const FLY = { list: [], onImpact: null };
  let stuck = [];            // { a, born, fade }
  let particles = [];
  let highlight = [];        // مؤشرات القطاعات الرابحة
  let highlightAt = 0;
  let winFlash = 0;
  let readyVisible = true;
  let chargeFrom = 0;
  let lastTickSlice = -1;
  let lastTickAt = 0;

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.08 + Math.random() * 0.28;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.12, life: 1, color, r: 1.5 + Math.random() * 2.5 });
    }
  }

  function sliceUnderBottom(theta) {
    const a = mod360(180 - theta);
    const slices = slicesOf(S.wheelKey);
    for (const s of slices) if (a >= s.a0 && a < s.a1) return s;
    return slices[slices.length - 1];
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - lastFrame);
    lastFrame = now;
    if (G && S.wheels) {
      stepMotion(now, dt);
      stepFlights(now);
      draw(now, dt);
      maybeTick(now);
    }
    requestAnimationFrame(frame);
  }

  function stepFlights(now) {
    for (const f of FLY.list) {
      if (f.state === 'wait' && now >= f.launch) { f.state = 'fly'; Snd.whoosh(); }
      if (f.state === 'fly' && now >= f.impact) {
        f.state = 'done';
        stuck.push({ a: f.angle, born: now, fade: 0 });
        Snd.thunk();
        const hx = G.cx, hy = G.cy + G.R * TIP;
        if (f.multiplier > 0) {
          burst(hx, hy, f.multiplier >= 10 ? '#ffe08a' : '#29d98c', f.multiplier >= 10 ? 46 : 22);
        } else {
          burst(hx, hy, '#7f8da5', 10);
        }
        if (FLY.onImpact) FLY.onImpact(f);
      }
    }
  }

  function maybeTick(now) {
    if (MOT.mode !== 'plan' || MOT.omega > 0.33) return;
    const s = sliceUnderBottom(MOT.theta);
    if (s && s.i !== lastTickSlice && now - lastTickAt > 40) {
      lastTickSlice = s.i; lastTickAt = now;
      Snd.tick();
    }
  }

  function draw(now, dt) {
    const { cx, cy, R } = G;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, W);

    // هالة خلف القرص
    const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.5);
    halo.addColorStop(0, winFlash > 0 ? `rgba(247,201,72,${0.18 + 0.14 * winFlash})` : 'rgba(247,201,72,.1)');
    halo.addColorStop(1, 'rgba(247,201,72,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, Math.PI * 2); ctx.fill();

    // القرص
    buildWheelCache();
    const half = wheelCache.width / DPR / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad(MOT.theta));
    ctx.drawImage(wheelCache, -half, -half, half * 2, half * 2);

    // إبراز القطاعات الرابحة بعد التوقّف
    if (highlight.length) {
      const pulse = 0.35 + 0.25 * Math.sin((now - highlightAt) / 160);
      const slices = slicesOf(S.wheelKey);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const idx of highlight) {
        const s = slices[idx];
        if (!s) continue;
        const pad = s.span < 4 ? (4 - s.span) / 2 : 0;   // الرفيعة تُبرز بعرض مرئي
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R, cAng(s.a0 - pad), cAng(s.a1 + pad));
        ctx.closePath();
        ctx.fillStyle = `rgba(255,236,160,${pulse * 0.55})`;
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();

    // الإطار الذهبي والمصابيح (ثابتة لا تدور)
    ctx.save();
    ctx.lineWidth = R * 0.07;
    const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    rim.addColorStop(0, '#ffeaa7'); rim.addColorStop(0.5, '#d99a0b'); rim.addColorStop(1, '#8a5a07');
    ctx.strokeStyle = rim;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.035, 0, Math.PI * 2); ctx.stroke();
    const BULBS = 28;
    const speed = Math.abs(MOT.omega);
    const chase = Math.floor(now / (speed > 0.2 ? 60 : 220));
    for (let i = 0; i < BULBS; i++) {
      const a = (i / BULBS) * Math.PI * 2;
      const on = winFlash > 0 ? (Math.floor(now / 120) % 2 === 0) : ((i + chase) % 4 === 0);
      const bx = cx + Math.cos(a) * R * 1.035, by = cy + Math.sin(a) * R * 1.035;
      ctx.beginPath();
      ctx.arc(bx, by, R * 0.018, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#fff6d0' : '#5c3d05';
      if (on) { ctx.shadowColor = '#ffe08a'; ctx.shadowBlur = R * 0.05; } else ctx.shadowBlur = 0;
      ctx.fill();
    }
    ctx.restore();
    if (winFlash > 0) winFlash = Math.max(0, winFlash - dt / 2600);

    // مؤشّر نقطة الإصابة أسفل الإطار
    ctx.save();
    ctx.fillStyle = 'rgba(247,201,72,.9)';
    ctx.beginPath();
    ctx.moveTo(cx, cy + R * 1.1);
    ctx.lineTo(cx - R * 0.045, cy + R * 1.17);
    ctx.lineTo(cx + R * 0.045, cy + R * 1.17);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // الأسهم المغروسة (تدور مع القرص)
    const L = R * 0.5;
    stuck = stuck.filter((s) => s.fade < 1);
    for (const s of stuck) {
      if (s.fading) s.fade = Math.min(1, s.fade + dt / 220);
      const phi = s.a + MOT.theta;
      const tx = cx + Math.sin(rad(phi)) * R * TIP;
      const ty = cy - Math.cos(rad(phi)) * R * TIP;
      const age = now - s.born;
      const wobble = age < 420 ? Math.sin(age / 22) * 5 * (1 - age / 420) : 0;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(rad(phi + 180 + wobble));
      drawArrow(ctx, L, 1 - s.fade);
      ctx.restore();
    }

    // السهم الطائر
    for (const f of FLY.list) {
      if (f.state !== 'fly') continue;
      const u = clamp((now - f.launch) / FLIGHT, 0, 1);
      const e = u * u * (1.6 - 0.6 * u);                 // تسارع ثم وصول حادّ
      const y0 = W + R * 0.1;
      const y1 = cy + R * TIP;
      const y = y0 + (y1 - y0) * e;
      // أثر الحركة
      ctx.save();
      const trail = ctx.createLinearGradient(cx, y, cx, y + R * 0.9);
      trail.addColorStop(0, 'rgba(255,234,167,.45)');
      trail.addColorStop(1, 'rgba(255,234,167,0)');
      ctx.fillStyle = trail;
      ctx.fillRect(cx - R * 0.012, y + L * 0.5, R * 0.024, R * 0.9);
      ctx.translate(cx, y);
      drawArrow(ctx, L);
      ctx.restore();
    }

    // السهم الجاهز أسفل القرص (يتراجع قليلاً وهو «يُشحن»)
    const flying = FLY.list.some((f) => f.state === 'fly');
    const waiting = FLY.list.filter((f) => f.state === 'wait');
    if ((readyVisible || waiting.length) && !flying) {
      const pull = chargeFrom ? clamp((now - chargeFrom) / 300, 0, 1) * R * 0.08 : 0;
      ctx.save();
      ctx.translate(cx, cy + R * 1.22 + pull);
      drawArrow(ctx, L * 0.9, 0.95);
      ctx.restore();
    }

    // الشرر
    particles = particles.filter((p) => p.life > 0);
    for (const p of particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.0006 * dt; p.life -= dt / 900;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------ الواجهة */
  const els = {
    bal: $('walletBal'), cur: $('walletCur'), badge: $('modeBadge'), demoBanner: $('demoBanner'),
    bet: $('betInput'), throwBtn: $('throwBtn'), throwText: $('throwText'),
    risk: $('riskBox'), riskAmount: $('riskAmount'), riskDouble: $('riskDouble'), riskStep: $('riskStep'), riskMax: $('riskMax'),
    take: $('takeBtn'), gambleBtn: $('gambleBtn'),
    result: $('result'), ticker: $('ticker'),
    lastWin: $('lastWin'), lastMult: $('lastMult'), limits: $('betLimits')
  };

  function paintBalance(v) {
    S.shownBalance = v;
    els.bal.textContent = money(v);
    els.cur.textContent = S.demo ? 'DEMO' : S.currency;
  }

  function paintMode() {
    document.querySelectorAll('#modes [data-mode]').forEach((b) => b.classList.toggle('is-on', b.dataset.mode === S.mode));
    els.throwText.textContent = S.mode === 'double' ? 'ارمِ السهمين' : 'ارمِ السهم';
  }

  function setBusy(v) {
    S.busy = v;
    els.throwBtn.disabled = v || !S.enabled;
    document.querySelectorAll('#modes button').forEach((b) => { b.disabled = v; });
    els.take.disabled = v;
    els.gambleBtn.disabled = v;
  }

  function setWheel(key) {
    if (S.wheelKey === key) return;
    S.wheelKey = key;
    wheelCache = null;
    highlight = [];
  }

  function clearStuck() {
    for (const s of stuck) s.fading = true;
    highlight = [];
  }

  function readBet() {
    const v = Math.floor(Number(els.bet.value) || 0);
    return v;
  }

  function normalizeBet() {
    let v = readBet();
    if (!v) v = S.minStake;
    v = clamp(v, S.minStake, S.maxStake);
    els.bet.value = v;
    return v;
  }

  function showRisk() {
    const g = S.gamble;
    if (!g) { els.risk.hidden = true; return; }
    els.riskAmount.textContent = money(g.amount);
    els.riskDouble.textContent = money(g.amount * 2);
    els.riskStep.textContent = String(g.step + 1);
    els.riskMax.textContent = String(g.max || S.maxGambles);
    els.risk.hidden = false;
  }

  let resultTimer = null;
  function showResult(data) {
    const r = els.result;
    const m = data.bet ? data.win / data.bet : 0;
    r.classList.remove('is-win', 'is-big', 'is-part', 'is-lose');
    let tier, cls;
    if (data.win <= 0) { tier = 'حظ أوفر المرّة القادمة'; cls = 'is-lose'; }
    else if (m >= 10) { tier = '🔥 فوز ضخم!'; cls = 'is-big'; }
    else if (m >= 3) { tier = '🎯 فوز كبير!'; cls = 'is-big'; }
    else if (m >= 1) { tier = '✓ فوز!'; cls = 'is-win'; }
    else { tier = 'استرداد جزئي'; cls = 'is-part'; }
    r.classList.add(cls);
    $('resTier').textContent = tier;
    $('resMult').textContent = multText(m);
    $('resBet').textContent = money(data.bet);
    $('resPay').textContent = money(data.win);
    const profit = data.win - data.bet;
    const pEl = $('resProfit');
    pEl.textContent = (profit > 0 ? '+' : profit < 0 ? '−' : '') + money(Math.abs(profit));
    pEl.className = profit > 0 ? 'pos' : profit < 0 ? 'neg' : '';
    $('resNote').textContent = data.arrows.length > 1
      ? `(${data.arrows.map((a) => multText(a.multiplier)).join(' + ')}) ÷ 2`
      : (data.mode === 'gamble' ? 'ضاعف أو اخسر' : '');
    r.hidden = false;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { r.hidden = true; }, data.win > 0 ? 3400 : 2200);
  }
  els.result.addEventListener('click', () => { els.result.hidden = true; });

  function addTicker(m) {
    const chip = document.createElement('span');
    chip.className = 'bx-chip-res';
    chip.textContent = multText(m);
    const [c1] = m > 0 ? sliceColor(m >= 25 ? 25 : m, 'classic', 0) : ['#222b3d'];
    if (m > 0) { chip.style.background = c1; chip.style.color = m >= 25 ? '#1a1204' : '#08101e'; }
    els.ticker.prepend(chip);
    while (els.ticker.children.length > 18) els.ticker.lastChild.remove();
  }

  /* ------------------------------------------------------------ السجل */
  const histKey = () => 'bx_hist:' + (S.demo ? 'demo' : (S.username || 'me'));
  function loadHist() {
    try { return JSON.parse(recall(histKey()) || '[]'); } catch { return []; }
  }
  function pushHist(data) {
    const list = loadHist();
    list.unshift({
      t: Date.now(), mode: data.mode, bet: data.bet, win: data.win,
      m: data.bet ? data.win / data.bet : 0,
      arrows: data.arrows.map((a) => a.multiplier)
    });
    store(histKey(), JSON.stringify(list.slice(0, 60)));
  }

  /* ------------------------------------------------------------ التجريبي */
  function randU() {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return ((a[0] >>> 5) * 67108864 + (a[1] >>> 6)) / 9007199254740992;
  }
  function landLocal(key, u) {
    const slices = slicesOf(key);
    const a = u * 360;
    let s = slices[slices.length - 1];
    const pos = u * S.wheels[key].reduce((x, y) => x + y.w, 0);
    let acc = 0;
    for (const sl of slices) { acc += sl.w; if (pos < acc) { s = sl; break; } }
    return { angle: a, slice: s.i, multiplier: s.m };
  }
  function demoBalance() {
    const v = parseInt(recall('ichance_demo_balance'), 10);
    return Number.isFinite(v) ? v : 100000;
  }
  function demoThrow(mode, bet) {
    let bal = demoBalance();
    if (bal < bet) { bal = 50000; toast('أُعيد شحن رصيد التجربة 50,000 تلقائياً', 'info'); }
    const cfg = S.modes[mode];
    const arrows = [];
    for (let i = 0; i < cfg.arrows; i++) arrows.push(landLocal(cfg.wheel, randU()));
    const sum = arrows.reduce((a, x) => a + x.multiplier, 0);
    const win = Math.floor(bet * sum / cfg.arrows);
    bal = bal - bet + win;
    store('ichance_demo_balance', String(bal));
    const gamble = mode === 'risk' && win > 0 ? { available: true, amount: win, step: 0, max: S.maxGambles } : { available: false };
    return { ok: true, mode, bet, arrows, win, balance: bal, gamble };
  }
  function demoGamble(amount, step) {
    let bal = demoBalance();
    const arrow = landLocal('gamble', randU());
    const win = Math.floor(amount * arrow.multiplier);
    bal = bal - amount + win;
    store('ichance_demo_balance', String(bal));
    const next = step + 1;
    const gamble = win > 0 && next < S.maxGambles ? { available: true, amount: win, step: next, max: S.maxGambles } : { available: false };
    return { ok: true, mode: 'gamble', bet: amount, arrows: [arrow], win, balance: bal, gamble };
  }

  /* ------------------------------------------------------------ الخادم */
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
      throw e;
    }
    return data;
  }

  function applyState(d) {
    S.lastState = d;
    S.wheels = d.wheels;
    S.modes = d.modes;
    S.minStake = d.minStake;
    S.maxStake = d.maxStake;
    S.maxGambles = d.maxGambles;
    S.demo = !(S.token && d.loggedIn);
    S.username = d.username || null;
    if (!S.demo) {
      S.currency = d.currency || 'IQD';
      S.balance = Number(d.balance) || 0;
    } else {
      S.balance = demoBalance();
    }
    els.badge.textContent = S.demo ? 'تجريبي' : 'رصيد حقيقي';
    els.badge.classList.toggle('is-real', !S.demo);
    els.demoBanner.hidden = !S.demo;
    document.body.classList.toggle('is-demo', S.demo);
    els.bet.min = S.minStake;
    els.bet.max = S.maxStake;
    els.limits.textContent = `${money(S.minStake)} – ${money(S.maxStake)}`;
    if (!S.busy) paintBalance(S.balance);
    paintMode();
  }

  async function loadState() {
    S.token = readToken();
    try {
      const [d, cfg] = await Promise.all([
        api('GET', '/api/bullseye/state'),
        api('GET', '/api/config').catch(() => null)
      ]);
      applyState(d);
      S.enabled = !(cfg && cfg.games && cfg.games.bullseye === false);
      if (!S.enabled) {
        els.throwText.textContent = 'اللعبة متوقفة مؤقتاً';
      }
      setBusy(S.busy);
      return true;
    } catch (err) {
      if (err.status === 401) { S.token = ''; return loadState(); }
      toast(err.message || 'تعذّر تحميل اللعبة', 'error');
      return false;
    }
  }

  /* ------------------------------------------------------------ الرمي */
  function startCharge() {
    Snd.init();
    Snd.charge();
    readyVisible = true;
    chargeFrom = performance.now();
    MOT.mode = 'spinup';
    FLY.list = [];
  }

  function abortThrow() {
    chargeFrom = 0;
    MOT.mode = 'idle';
    FLY.list = [];
  }

  function animateRound(data, done) {
    const winners = [];
    planArrows(data.arrows, (f) => {
      if (f.multiplier > 0) winners.push(data.arrows[f.idx].slice);
      if (f.idx === 0) { readyVisible = data.arrows.length > 1; chargeFrom = 0; }
    }, () => {
      highlight = winners;
      highlightAt = performance.now();
      done();
    });
  }

  function finishRound(data) {
    S.balance = Number(data.balance) || 0;
    paintBalance(S.balance);
    showResult(data);
    const m = data.bet ? data.win / data.bet : 0;
    addTicker(m);
    pushHist(data);
    els.lastWin.textContent = money(data.win);
    els.lastMult.textContent = multText(m);
    if (data.win > 0) { Snd.win(m >= 3); if (m >= 3) winFlash = 1; }
    else Snd.lose();
    S.gamble = data.gamble && data.gamble.available ? data.gamble : null;
    showRisk();
    if (data.mode === 'gamble' && !S.gamble) setTimeout(() => { if (!S.busy) setWheel(S.modes[S.mode].wheel); }, 2200);
    readyVisible = true;
    setBusy(false);
  }

  function handleError(err) {
    if (err.status === 401) {
      toast('سجّل الدخول للّعب برصيدك', 'error');
      setTimeout(() => { location.href = '/login?next=/bullseye'; }, 900);
      return;
    }
    toast(err.message || 'تعذّرت الرمية', 'error', 4500);
  }

  async function doThrow() {
    if (S.busy || !S.wheels || !S.enabled) return;
    const bet = normalizeBet();
    if (!S.demo && bet > S.balance) {
      toast(`رصيدك لا يكفي (${money(S.balance)}). اضغط «شحن».`, 'error', 4000);
      return;
    }
    setBusy(true);
    els.result.hidden = true;
    S.gamble = null; showRisk();
    clearStuck();
    setWheel(S.modes[S.mode].wheel);
    startCharge();

    let data;
    try {
      if (S.demo) { await sleep(260); data = demoThrow(S.mode, bet); }
      else data = await api('POST', '/api/bullseye/throw', { mode: S.mode, bet });
    } catch (err) {
      abortThrow();
      setBusy(false);
      handleError(err);
      if (!S.demo) loadState();
      return;
    }
    paintBalance(data.balance - data.win);   // الرهان خُصم؛ الربح يظهر عند النتيجة
    animateRound(data, () => finishRound(data));
  }

  async function doGamble() {
    if (S.busy || !S.gamble) return;
    const offer = S.gamble;
    setBusy(true);
    els.result.hidden = true;
    els.risk.hidden = true;
    clearStuck();
    setWheel('gamble');
    startCharge();

    let data;
    try {
      if (S.demo) { await sleep(260); data = demoGamble(offer.amount, offer.step); }
      else data = await api('POST', '/api/bullseye/gamble', { amount: offer.amount });
    } catch (err) {
      abortThrow();
      S.gamble = null;
      setWheel(S.modes[S.mode].wheel);
      setBusy(false);
      toast(err.message || 'تعذّرت المخاطرة', 'error', 4500);
      if (!S.demo) loadState();
      return;
    }
    paintBalance(data.balance - data.win);
    animateRound(data, () => finishRound(data));
  }

  /* ------------------------------------------------------------ الأحداث */
  els.throwBtn.addEventListener('click', doThrow);
  els.gambleBtn.addEventListener('click', doGamble);
  els.take.addEventListener('click', () => {
    if (S.busy) return;
    const amount = S.gamble ? S.gamble.amount : 0;
    S.gamble = null;
    showRisk();
    setWheel(S.modes[S.mode].wheel);
    if (amount) toast(`✓ ${money(amount)} في رصيدك`, 'win');
    if (!S.demo) api('POST', '/api/bullseye/collect', {}).catch(() => {});
  });

  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || S.busy) return;
    S.mode = b.dataset.mode;
    S.gamble = null; showRisk();
    clearStuck();
    setWheel(S.modes ? S.modes[S.mode].wheel : 'classic');
    paintMode();
  });

  document.querySelector('.bx-bet__row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bet]');
    if (!b) return;
    let v = readBet() || S.minStake;
    if (b.dataset.bet === 'half') v = Math.floor(v / 2);
    if (b.dataset.bet === 'double') v = v * 2;
    if (b.dataset.bet === 'max') v = S.demo ? S.maxStake : Math.min(S.maxStake, Math.floor(S.balance));
    els.bet.value = clamp(v, S.minStake, S.maxStake);
  });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    els.bet.value = clamp(Number(b.dataset.chip), S.minStake, S.maxStake);
  });
  els.bet.addEventListener('change', normalizeBet);

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== 'Enter') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(tag)) return;
    if (document.querySelector('.bx-modal:not([hidden])')) return;
    e.preventDefault();
    doThrow();
  });

  const soundBtn = $('soundBtn');
  soundBtn.textContent = Snd.muted ? '🔇' : '🔊';
  soundBtn.addEventListener('click', () => {
    Snd.muted = !Snd.muted;
    store('ichance_muted', String(Snd.muted));
    soundBtn.textContent = Snd.muted ? '🔇' : '🔊';
    if (!Snd.muted) { Snd.init(); Snd.tick(); }
  });

  $('depositBtn').addEventListener('click', () => {
    if (S.demo) { location.href = '/login?next=/bullseye'; return; }
    toast(S.username
      ? `للشحن تواصل مع الكاشير الخاص بك وأعطه اسم المستخدم: ${S.username}`
      : 'للشحن تواصل مع الكاشير الخاص بك', 'info', 6000);
  });

  /* ------------------------------------------------------------ النوافذ */
  function openModal(id) { $(id).hidden = false; }
  document.querySelectorAll('.bx-modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.bx-modal').forEach((m) => { m.hidden = true; });
  });

  // — رمياتي
  $('historyBtn').addEventListener('click', () => {
    const list = loadHist();
    $('historyEmpty').hidden = list.length > 0;
    $('historyBody').innerHTML = list.map((h) => {
      const profit = h.win - h.bet;
      const d = new Date(h.t);
      const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `<tr>
        <td class="num">${time}</td>
        <td>${escapeHtml(MODE_TEXT[h.mode] || h.mode)}</td>
        <td class="num">${money(h.bet)}</td>
        <td class="num">${multText(h.m)}</td>
        <td class="num">${money(h.win)}</td>
        <td class="num ${profit > 0 ? 'pos' : profit < 0 ? 'neg' : ''}">${profit > 0 ? '+' : profit < 0 ? '−' : ''}${money(Math.abs(profit))}</td>
      </tr>`;
    }).join('');
    openModal('historyModal');
  });

  /* ------------------------------------------------------------ الإقلاع */
  (async function boot() {
    resize();
    requestAnimationFrame(frame);
    let ok = await loadState();
    while (!ok) { await sleep(3000); ok = await loadState(); }
    setWheel(S.modes[S.mode].wheel);
    wheelCache = null;
    // فرصة «ضاعف أو اخسر» لم تُحسم قبل إعادة تحميل الصفحة
    const g = S.lastState && S.lastState.gamble;
    if (!S.demo && g && g.available) {
      S.mode = 'risk';
      paintMode();
      S.gamble = g;
      showRisk();
    }
    // مزامنة الرصيد كل 10 ثوانٍ (الكاشير قد يعبّئ أثناء اللعب)
    setInterval(() => { if (!S.busy && !document.hidden) loadState(); }, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.busy) loadState(); });
  })();
})();
