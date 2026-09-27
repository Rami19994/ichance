/* ==========================================================================
   ماتادور فييستا — الصوت
   موسيقى «باسو دوبلي» إسبانية ومؤثرات مُركّبة كلها في المتصفح (Web Audio) —
   لا ملفات صوت. البوق: موجتا منشار بفلتر متحرّك. الجيتار: Karplus-Strong
   (وتر مقروص) بضربات «راسغيادو». الإيقاع: طبل وكاستانيت. في اللفات المجانية
   أسرع وأعلى طبقة. الجمهور: ضجيج مُرشَّح يهتف «أوليه» عند الأرباح الكبيرة.
   ========================================================================== */
'use strict';

window.MTAudio = (() => {
  let ctx = null, master, musicBus, sfxBus, reverb;
  const opts = { music: true, sfx: true, muted: false };
  const pluckCache = new Map();
  let noiseBuf = null;

  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem('mt_audio') || '{}');
      if (typeof o.music === 'boolean') opts.music = o.music;
      if (typeof o.sfx === 'boolean') opts.sfx = o.sfx;
      if (typeof o.muted === 'boolean') opts.muted = o.muted;
    } catch { /* تصفح خاص */ }
  }
  function save() { try { localStorage.setItem('mt_audio', JSON.stringify(opts)); } catch { /* */ } }
  load();

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch { return false; }
    master = ctx.createGain();
    master.gain.value = opts.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = opts.music ? 0.5 : 0; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = opts.sfx ? 0.9 : 0; sfxBus.connect(master);
    // صدى خفيف (تأخير مُرشَّح بتغذية راجعة) — رخيص على المعالج
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.09;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    delay.connect(lp); lp.connect(fb); fb.connect(delay);
    const send = ctx.createGain(); send.gain.value = 0.3;
    lp.connect(send); send.connect(master);
    reverb = delay;
    noiseBuf = makeNoise(1.5);
    return true;
  }

  function makeNoise(sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** وتر مقروص (Karplus-Strong) — يُحسب مرّة لكل نغمة ويُخزَّن. */
  function pluckBuffer(midi, dur = 1.1, bright = 0.6, decay = 0.993) {
    const key = `${midi}|${dur}|${bright}|${decay}`;
    if (pluckCache.has(key)) return pluckCache.get(key);
    const sr = ctx.sampleRate;
    const N = Math.max(2, Math.round(sr / midiHz(midi)));
    const len = Math.floor(sr * dur);
    const b = ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    const ring = new Float32Array(N);
    let last = 0;
    for (let i = 0; i < N; i++) { const x = Math.random() * 2 - 1; last += bright * (x - last); ring[i] = last; }
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const cur = ring[idx];
      ring[idx] = decay * 0.5 * (cur + ring[(idx + 1) % N]);
      d[i] = cur;
      idx = (idx + 1) % N;
    }
    const fade = Math.min(len, Math.floor(sr * 0.05));
    for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
    pluckCache.set(key, b);
    return b;
  }

  function out(bus, { rev = 0, pan = 0 } = {}) {
    const g = ctx.createGain();
    let node = g;
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
    node.connect(bus);
    if (rev > 0) { const s = ctx.createGain(); s.gain.value = rev; node.connect(s); s.connect(reverb); }
    return g;
  }

  function pluck(t, midi, vol, bus, { dur, bright, decay, rev = 0.2, pan = 0 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = pluckBuffer(midi, dur, bright, decay);
    const g = out(bus, { rev, pan });
    g.gain.value = vol;
    src.connect(g);
    src.start(t);
  }

  function tone(t, freq, dur, { type = 'sine', vol = 0.1, slide = null, attack = 0.005, bus = sfxBus, rev = 0.1, pan = 0 } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = out(bus, { rev, pan });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(t, dur, { vol = 0.1, type = 'bandpass', freq = 1000, q = 1, slide = null, bus = sfxBus, rev = 0, attack = 0.003 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (slide) f.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = out(bus, { rev });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    src.start(t, Math.random() * 1.2); src.stop(t + dur + 0.05);
  }

  /** بوق: منشاران متباعدان قليلاً بفلتر ينفتح مع النفخة واهتزاز خفيف. */
  function trumpet(t, midi, dur, vol = 0.05, bus = sfxBus, rev = 0.3) {
    const f0 = midiHz(midi);
    const g = out(bus, { rev });
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.exponentialRampToValueAtTime(3200, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(1700, t + Math.max(0.1, dur));
    lp.connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.setValueAtTime(vol * 0.85, t + Math.max(0.05, dur - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
    const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f0 * 0.008, t + Math.min(0.35, dur));
    lfo.connect(lg);
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 0.98, t);
      o.frequency.exponentialRampToValueAtTime(f0, t + 0.03);
      o.detune.value = det;
      lg.connect(o.frequency);
      o.connect(lp);
      o.start(t); o.stop(t + dur + 0.12);
    }
    lfo.start(t); lfo.stop(t + dur + 0.12);
  }

  /** ضربة جيتار «راسغيادو»: الأوتار بتتابع سريع. */
  function strum(t, notes, vol, bus, { up = false, gap = 0.014 } = {}) {
    const ns = up ? notes.slice().reverse() : notes;
    ns.forEach((m, i) => pluck(t + i * gap, m, vol, bus, { bright: 0.72, dur: 0.9, rev: 0.18, pan: -0.2 + i * 0.1 }));
  }

  function castanet(t, vol = 0.05, bus = sfxBus) {
    noise(t, 0.035, { vol, type: 'bandpass', freq: 3400, q: 7, bus });
    noise(t + 0.004, 0.02, { vol: vol * 0.6, type: 'highpass', freq: 6000, bus });
  }

  function crowd(t, dur = 1.6, vol = 0.08, bus = sfxBus) {
    // هتاف الجمهور: ضجيج بنطاقَي الأصوات البشرية مع صعود وهبوط
    for (const [f, q] of [[750, 2.2], [1250, 2.6], [2200, 3]]) {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(f * 0.85, t); bp.Q.value = q;
      bp.frequency.linearRampToValueAtTime(f * 1.12, t + dur * 0.4);
      bp.frequency.linearRampToValueAtTime(f, t + dur);
      const g = out(bus, { rev: 0.25 });
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g);
      src.start(t, Math.random()); src.stop(t + dur + 0.05);
    }
  }

  // ─────────────────────────────────────────────────────── الموسيقى
  // باسو دوبلي في لا الصغير: 16 مازورة 2/4. [أساس, خامسة, نغمات الضربة]
  const CH = {
    Am: [45, 52, [57, 60, 64, 69]], Dm: [50, 45, [57, 62, 65, 69]], E7: [40, 47, [56, 59, 62, 64]],
    C: [48, 43, [55, 60, 64, 67]], G7: [43, 50, [55, 59, 62, 65]], F: [41, 48, [57, 60, 65, 69]]
  };
  const PROG = ['Am', 'Am', 'Dm', 'Am', 'E7', 'E7', 'Am', 'Am', 'C', 'G7', 'C', 'C', 'F', 'E7', 'Am', 'E7'];
  // اللحن: لكل مازورة [ثُمن, نغمة, طول بالأثمان]
  const MEL = [
    [[0, 76, 1], [1, 77, 1], [2, 76, 1], [3, 74, 1]],
    [[0, 72, 2], [2, 69, 2]],
    [[0, 74, 1], [1, 76, 1], [2, 77, 1], [3, 76, 1]],
    [[0, 74, 1], [1, 72, 1], [2, 71, 1], [3, 72, 1]],
    [[0, 71, 1], [1, 72, 1], [2, 71, 1], [3, 68, 1]],
    [[0, 64, 2], [2, 68, 1], [3, 71, 1]],
    [[0, 76, 1], [1, 74, 1], [2, 72, 1], [3, 71, 1]],
    [[0, 69, 3]],
    [[0, 72, 1], [1, 76, 1], [2, 79, 2]],
    [[0, 79, 1], [1, 77, 1], [2, 74, 1], [3, 71, 1]],
    [[0, 72, 1], [1, 74, 1], [2, 76, 1], [3, 79, 1]],
    [[0, 84, 3]],
    [[0, 81, 1], [1, 79, 1], [2, 77, 1], [3, 76, 1]],
    [[0, 77, 1], [1, 76, 1], [2, 74, 1], [3, 71, 1]],
    [[0, 72, 1], [1, 71, 1], [2, 69, 1], [3, 68, 1]],
    [[0, 69, 2], [2, 64, 2]]
  ];
  const BARS = PROG.length;
  const TEMPO = { base: 116, fs: 136 };      // نبضة = ربع
  const music = { on: false, mode: 'base', nextTime: 0, step: 0, timer: null, gain: null, amb: null };

  function musicStart() {
    if (!ctx || music.on) return;
    music.on = true;
    music.gain = ctx.createGain(); music.gain.gain.value = 1; music.gain.connect(musicBus);
    music.nextTime = ctx.currentTime + 0.15;
    music.step = 0;
    startAmbience();
    music.timer = setInterval(schedule, 70);
  }
  function setMode(mode) {
    if (music.mode === mode) return;
    music.mode = mode;
    music.step = 0;
  }

  function startAmbience() {
    // همهمة المدرّجات الخفيفة
    if (music.amb) return;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.9;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
    const lg = ctx.createGain(); lg.gain.value = 250; lfo.connect(lg); lg.connect(f.frequency);
    const g = ctx.createGain(); g.gain.value = 0.012;
    src.connect(f); f.connect(g); g.connect(musicBus);
    src.start(); lfo.start();
    music.amb = { src, lfo, g };
  }

  function schedule() {
    if (!ctx || !music.on) return;
    const bus = music.gain;
    while (music.nextTime < ctx.currentTime + 0.22) {
      const fs = music.mode === 'fs';
      const spb = 60 / TEMPO[music.mode];
      const s16 = spb / 4;
      const t = music.nextTime;
      const step = music.step;                 // خطوة 1/16 — المازورة 2/4 = 8 خطوات
      const bar = Math.floor(step / 8) % BARS;
      const inBar = step % 8;
      const tr = fs ? 2 : 0;
      const [root, fifth, notes] = CH[PROG[bar]];
      const chord = notes.map((m) => m + tr);

      // الباص: «أوم-با» — الأساس على النبضة الأولى والخامسة على الثانية
      if (inBar === 0) pluck(t, root + tr, 0.42, bus, { bright: 0.3, dur: 1.2, rev: 0.05, decay: 0.996 });
      if (inBar === 4) pluck(t, fifth + tr, 0.36, bus, { bright: 0.3, dur: 1, rev: 0.05, decay: 0.996 });
      // الجيتار: ضربات على الثمن الثاني والرابع (وفي المجانية على كل ثمن)
      if (inBar === 2 || inBar === 6 || (fs && (inBar === 0 || inBar === 4))) strum(t, chord, fs ? 0.1 : 0.085, bus, { up: inBar === 6 });
      // الطبل: ضربة على 2 ودحرجة قبل كل عبارة
      if (inBar === 4) noise(t, 0.12, { vol: 0.07, type: 'bandpass', freq: 1800, q: 0.8, bus });
      if (bar % 4 === 3 && inBar >= 4) noise(t, 0.05, { vol: 0.035 + inBar * 0.004, type: 'bandpass', freq: 2000, q: 0.9, bus });
      if (inBar === 0) tone(t, 90, 0.18, { vol: 0.16, slide: 45, bus, rev: 0 });
      // الكاستانيت: «تري-كي-تا»
      if (inBar === 0 || inBar === 1 || inBar === 2 || inBar === 5 || (fs && inBar % 2 === 1)) castanet(t, fs ? 0.05 : 0.038, bus);
      // البوق: اللحن — يبدأ بعد مازورتين من الدخول كي يبدأ المقطع بالإيقاع
      if (inBar % 2 === 0) {
        const e = inBar / 2;
        for (const [pos, note, len] of MEL[bar]) {
          if (pos === e) trumpet(t, note + tr, len * (spb / 2) * 0.92, fs ? 0.05 : 0.042, bus, 0.35);
        }
      }
      music.nextTime += s16;
      music.step = (step + 1) % (BARS * 8);
    }
  }

  // ─────────────────────────────────────────────────────── المؤثرات
  const now = () => ctx.currentTime + 0.005;
  const ok = () => ctx && opts.sfx && !opts.muted;
  const AM = [69, 71, 72, 74, 76, 77, 80, 81, 83, 84];

  const sfx = {
    click() { if (!ok()) return; const t = now(); tone(t, 900, 0.05, { vol: 0.08, slide: 500, rev: 0 }); noise(t, 0.02, { vol: 0.05, freq: 2500, q: 2 }); },
    spin() {
      if (!ok()) return; const t = now();
      noise(t, 0.4, { vol: 0.08, freq: 400, slide: 2600, q: 1.1, attack: 0.07 });
      castanet(t + 0.02, 0.06); castanet(t + 0.09, 0.05);
    },
    reelStop(i) {
      if (!ok()) return; const t = now();
      tone(t, 140 - i * 6, 0.15, { vol: 0.22, slide: 55, rev: 0.05 });
      noise(t, 0.04, { vol: 0.07, type: 'lowpass', freq: 1500, q: 0.8 });
      castanet(t + 0.01, 0.03);
    },
    win(level = 1) {
      if (!ok()) return; const t = now();
      const n = Math.min(3 + level, 8);
      for (let i = 0; i < n; i++) pluck(t + i * 0.06, AM[i], 0.28, sfxBus, { bright: 0.75, rev: 0.3, pan: (i / n) - 0.5 });
      for (let i = 0; i < 4; i++) castanet(t + i * 0.07, 0.05);
      if (level >= 3) trumpet(t + 0.15, 81, 0.5, 0.05);
    },
    burst() {
      if (!ok()) return; const t = now();
      noise(t, 0.35, { vol: 0.07, type: 'highpass', freq: 3000, slide: 9000 });
      for (let i = 0; i < 7; i++) tone(t + Math.random() * 0.22, 1800 + Math.random() * 2800, 0.16, { vol: 0.028, rev: 0.3 });
    },
    wild() {
      if (!ok()) return; const t = now();
      trumpet(t, 76, 0.14, 0.05); trumpet(t + 0.14, 81, 0.5, 0.055);
      noise(t, 0.8, { vol: 0.05, type: 'highpass', freq: 5000, slide: 12000, rev: 0.3 });
      crowd(t + 0.1, 1, 0.05);
    },
    mult() {
      if (!ok()) return; const t = now();
      tone(t, 100, 0.5, { vol: 0.3, slide: 40, rev: 0.1 });
      trumpet(t, 69, 0.12, 0.05); trumpet(t + 0.12, 76, 0.12, 0.05); trumpet(t + 0.24, 81, 0.4, 0.055);
    },
    scatter(k = 0) {
      if (!ok()) return; const t = now();
      tone(t, 110 + k * 20, 0.35, { vol: 0.3, slide: 55, rev: 0.2 });
      noise(t, 0.25, { vol: 0.05, type: 'lowpass', freq: 600, slide: 200 });           // نخرة الثور
      tone(t + 0.02, midiHz(76 + k * 4), 0.7, { vol: 0.06, type: 'triangle', rev: 0.5 });
    },
    trigger() {
      if (!ok()) return; const t = now();
      [69, 73, 76].forEach((m, i) => trumpet(t + i * 0.16, m, 0.15, 0.055));
      trumpet(t + 0.5, 81, 1.2, 0.06);
      tone(t + 0.5, 70, 1, { vol: 0.3, slide: 35 });
      crowd(t + 0.3, 2, 0.09);
    },
    coins(sec = 1.6) {
      if (!ok()) return; const t = now();
      const n = Math.floor(sec * 20);
      for (let i = 0; i < n; i++) {
        const tt = t + Math.random() * sec;
        tone(tt, 2400 + Math.random() * 2400, 0.09, { vol: 0.024, type: 'triangle', rev: 0.15 });
      }
    },
    bigWin() {
      if (!ok()) return; const t = now();
      [69, 72, 76].forEach((m, i) => trumpet(t + i * 0.2, m, 0.18, 0.055));
      trumpet(t + 0.6, 81, 1.4, 0.06); trumpet(t + 0.6, 76, 1.4, 0.04);
      tone(t + 0.6, 55, 1.2, { vol: 0.3, slide: 30 });
      crowd(t + 0.4, 2.6, 0.1);
      sfx.coins(2.8);
    },
    jackpot() {
      if (!ok()) return; const t = now();
      [69, 72, 76, 81].forEach((m, i) => trumpet(t + i * 0.17, m, 0.16, 0.055));
      trumpet(t + 0.7, 84, 1.6, 0.06); trumpet(t + 0.7, 76, 1.6, 0.045);
      for (let i = 0; i < 10; i++) tone(t + 0.7 + i * 0.12, midiHz(88 + (i % 3) * 3), 0.6, { vol: 0.04, type: 'triangle', rev: 0.5 });
      crowd(t + 0.5, 3, 0.11);
      sfx.coins(3.2);
    },
    tick() { if (!ok()) return; tone(now(), 2200, 0.03, { vol: 0.03, type: 'square', rev: 0 }); },
    fsEnd() {
      if (!ok()) return; const t = now();
      strum(t, [57, 60, 64, 69, 72], 0.2, sfxBus);
      trumpet(t + 0.3, 76, 0.2, 0.05); trumpet(t + 0.5, 81, 1, 0.055);
      crowd(t + 0.3, 1.8, 0.08);
    },
    error() { if (!ok()) return; const t = now(); tone(t, 220, 0.18, { vol: 0.08, type: 'square', slide: 150, rev: 0 }); }
  };

  function applyGains() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(opts.muted ? 0 : 0.9, t, 0.05);
    musicBus.gain.setTargetAtTime(opts.music ? 0.5 : 0, t, 0.2);
    sfxBus.gain.setTargetAtTime(opts.sfx ? 0.9 : 0, t, 0.05);
  }

  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });

  return {
    init,
    start() { if (init()) musicStart(); },
    setMode,
    sfx,
    get muted() { return opts.muted; },
    get music() { return opts.music; },
    get sfxOn() { return opts.sfx; },
    setMuted(v) { opts.muted = !!v; save(); applyGains(); },
    setMusic(v) { opts.music = !!v; save(); applyGains(); },
    setSfx(v) { opts.sfx = !!v; save(); applyGains(); }
  };
})();
