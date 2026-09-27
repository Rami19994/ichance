/* ==========================================================================
   بافالو وايز 3600 — الصوت
   موسيقى غربية ومؤثرات مُركّبة كلها في المتصفح (Web Audio) — لا ملفات صوت.
   الجيتار: خوارزمية Karplus-Strong (وتر مقروص). اللحن: صفير بتذبذب خفيف.
   الإيقاع: وقع حوافر خيل. في اللفات المجانية: أسرع وأعلى طبقة.
   ========================================================================== */
'use strict';

window.BWAudio = (() => {
  let ctx = null, master, musicBus, sfxBus, reverb, reverbSend;
  const opts = { music: true, sfx: true, muted: false };
  const pluckCache = new Map();
  let noiseBuf = null;

  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem('bw_audio') || '{}');
      if (typeof o.music === 'boolean') opts.music = o.music;
      if (typeof o.sfx === 'boolean') opts.sfx = o.sfx;
      if (typeof o.muted === 'boolean') opts.muted = o.muted;
    } catch { /* تصفح خاص */ }
  }
  function save() { try { localStorage.setItem('bw_audio', JSON.stringify(opts)); } catch { /* */ } }
  load();

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return true; }
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return false;
    try { ctx = new A(); } catch { return false; }
    master = ctx.createGain();
    master.gain.value = opts.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = opts.music ? 0.55 : 0; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = opts.sfx ? 0.9 : 0; sfxBus.connect(master);
    // صدى قاعة صغيرة من استجابة مُولّدة
    reverb = ctx.createConvolver();
    reverb.buffer = impulse(2.2, 2.6);
    reverbSend = ctx.createGain(); reverbSend.gain.value = 0.32;
    reverb.connect(reverbSend); reverbSend.connect(master);
    noiseBuf = makeNoise(2);
    return true;
  }

  function impulse(sec, decay) {
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }
  function makeNoise(sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** وتر مقروص (Karplus-Strong) — يُحسب مرّة لكل نغمة ويُخزَّن. */
  function pluckBuffer(midi, dur = 2.2, bright = 0.55, decay = 0.996) {
    const key = `${midi}|${dur}|${bright}|${decay}`;
    if (pluckCache.has(key)) return pluckCache.get(key);
    const sr = ctx.sampleRate;
    const f = midiHz(midi);
    const N = Math.max(2, Math.round(sr / f));
    const len = Math.floor(sr * dur);
    const b = ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    const ring = new Float32Array(N);
    let last = 0;
    for (let i = 0; i < N; i++) {           // ضجيج مُنعَّم = نقرة إصبع أنعم
      const x = Math.random() * 2 - 1;
      last = last + bright * (x - last);
      ring[i] = last;
    }
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const cur = ring[idx];
      const nxt = ring[(idx + 1) % N];
      ring[idx] = decay * 0.5 * (cur + nxt);
      d[i] = cur;
      idx = (idx + 1) % N;
    }
    // تلاشٍ في آخر المخزن كي لا يُقطع فجأة
    const fade = Math.min(len, Math.floor(sr * 0.05));
    for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
    pluckCache.set(key, b);
    return b;
  }

  function out(bus, { rev = 0, pan = 0 } = {}) {
    const g = ctx.createGain();
    let node = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p;
    }
    node.connect(bus);
    if (rev > 0) { const s = ctx.createGain(); s.gain.value = rev; node.connect(s); s.connect(reverb); }
    return g;
  }

  function pluck(t, midi, vol, bus, { dur, bright, decay, rev = 0.25, pan = 0 } = {}) {
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
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  /** صفير بتذبذب (اللحن الرئيسي). */
  function whistle(t, midi, dur, vol = 0.055, bus) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = midiHz(midi);
    o.frequency.setValueAtTime(f * 0.985, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.6;
    const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(dur, 0.5));
    lfo.connect(lg); lg.connect(o.frequency);
    const g = out(bus, { rev: 0.45 });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.05);
    g.gain.setValueAtTime(vol, t + Math.max(0.06, dur - 0.1));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    o.connect(g);
    o.start(t); lfo.start(t);
    o.stop(t + dur + 0.12); lfo.stop(t + dur + 0.12);
    noise(t, 0.08, { vol: vol * 0.25, freq: f * 2, q: 3, bus });   // نَفَس الصفير
  }

  function brass(t, midis, dur, vol = 0.06) {
    for (const m of midis) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = midiHz(m);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.08); f.frequency.exponentialRampToValueAtTime(900, t + dur);
      const g = out(sfxBus, { rev: 0.35 });
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f); f.connect(g); o.start(t); o.stop(t + dur + 0.05);
    }
  }

  // ─────────────────────────────────────────────────────── الموسيقى
  // تتابع أندلسي: Am G F E — مرتين (16 مازورة)
  const CHORDS = [
    [45, 52, 57, 60, 64],   // Am
    [43, 50, 55, 59, 62],   // G
    [41, 48, 53, 57, 60],   // F
    [40, 47, 52, 56, 59]    // E
  ];
  // اللحن: [مازورة, نبضة, نغمة, مدّة بالنبضات]
  const MELODY = [
    [0, 0, 76, 1.5], [0, 1.5, 74, .5], [0, 2, 72, 1], [0, 3, 69, 1], [1, 0, 76, 3],
    [2, 0, 74, 1.5], [2, 1.5, 72, .5], [2, 2, 71, 1], [2, 3, 67, 1], [3, 0, 74, 3],
    [4, 0, 72, 1.5], [4, 1.5, 69, .5], [4, 2, 65, 1], [4, 3, 69, 1], [5, 0, 72, 2], [5, 2, 74, 1], [5, 3, 72, 1],
    [6, 0, 71, 2], [6, 2, 68, 1], [6, 3, 71, 1], [7, 0, 76, 3.5],
    [8, 0, 81, 1.5], [8, 1.5, 79, .5], [8, 2, 76, 1], [8, 3, 72, 1], [9, 0, 74, 1], [9, 1, 76, 2.5],
    [10, 0, 79, 1.5], [10, 1.5, 76, .5], [10, 2, 74, 1], [10, 3, 71, 1], [11, 0, 74, 3],
    [12, 0, 77, 1.5], [12, 1.5, 76, .5], [12, 2, 72, 1], [12, 3, 69, 1], [13, 0, 72, 1], [13, 1, 74, 1], [13, 2, 76, 2],
    [14, 0, 68, 1], [14, 1, 71, 1], [14, 2, 74, 1], [14, 3, 71, 1], [15, 0, 69, 3.5]
  ];
  const BARS = 16;
  const music = { on: false, mode: 'base', nextTime: 0, step: 0, timer: null, gain: null, wind: null };
  const TEMPO = { base: 96, fs: 122 };

  function musicStart() {
    if (!ctx || music.on) return;
    music.on = true;
    music.gain = ctx.createGain(); music.gain.gain.value = 1; music.gain.connect(musicBus);
    music.nextTime = ctx.currentTime + 0.15;
    music.step = 0;
    startWind();
    music.timer = setInterval(schedule, 25);
  }
  function musicStop() {
    if (!music.on) return;
    music.on = false;
    clearInterval(music.timer);
    const g = music.gain;
    g.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    setTimeout(() => g.disconnect(), 1500);
    stopWind();
  }
  function setMode(mode) {
    if (music.mode === mode) return;
    music.mode = mode;
    // يبدأ المقطع الجديد من أوّل مازورة
    music.step = 0;
  }

  function startWind() {
    if (music.wind) return;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 260; lfo.connect(lg); lg.connect(f.frequency);
    const g = ctx.createGain(); g.gain.value = 0.018;
    src.connect(f); f.connect(g); g.connect(musicBus);
    src.start(); lfo.start();
    music.wind = { src, lfo, g };
  }
  function stopWind() {
    if (!music.wind) return;
    const w = music.wind; music.wind = null;
    w.g.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    setTimeout(() => { try { w.src.stop(); w.lfo.stop(); } catch { /* */ } }, 2000);
  }

  function schedule() {
    const bus = music.gain;
    while (music.nextTime < ctx.currentTime + 0.12) {
      const fs = music.mode === 'fs';
      const spb = 60 / TEMPO[music.mode];     // ثانية/نبضة
      const s16 = spb / 4;
      const t = music.nextTime;
      const step = music.step;                  // خطوة 1/16 داخل 16 مازورة
      const bar = Math.floor(step / 16) % BARS;
      const inBar = step % 16;
      const tr = fs ? 5 : 0;                    // اللفات المجانية: رابعة أعلى
      const chord = CHORDS[Math.floor(bar / 2) % 4].map((m) => m + tr);

      // الجيتار: أصابع على الثُمن — أو ضرب كامل في المجانية
      if (inBar % 2 === 0) {
        const e = inBar / 2;                    // 0..7
        if (fs && (e === 0 || e === 3 || e === 4 || e === 6)) {
          chord.slice(1).forEach((m, i) => pluck(t + i * 0.012, m, 0.16, bus, { bright: 0.7, rev: 0.2, pan: -0.15 + i * 0.08 }));
        } else if (!fs) {
          const seq = [2, 3, 4, 3, 2, 3, 4, 3];
          pluck(t, chord[seq[e]], 0.2, bus, { bright: 0.5, rev: 0.28, pan: 0.18 });
        }
        if (e === 0) pluck(t, chord[0] - 12 + 12, 0.34, bus, { bright: 0.35, dur: 2.6, rev: 0.15 });
        if (e === 4) pluck(t, chord[1] - 12 + 12, 0.28, bus, { bright: 0.35, dur: 2.2, rev: 0.15 });
      }

      // وقع الحوافر: دا-دا-دُم
      if (inBar % 4 === 0 || inBar % 4 === 3 || (fs && inBar % 4 === 2)) {
        const hi = inBar % 4 !== 0;
        noise(t, 0.05, { vol: fs ? 0.06 : 0.045, type: 'bandpass', freq: hi ? 1900 : 1100, q: 6, bus });
      }
      if (inBar === 0 || inBar === 8) tone(t, 110, 0.22, { vol: 0.18, slide: 45, bus, rev: 0 });
      if (fs && inBar % 2 === 1) noise(t, 0.03, { vol: 0.02, type: 'highpass', freq: 7000, bus });

      // الصفير — يبدأ من الدورة الثانية كي يبدأ المقطع بالجيتار وحده
      for (const [mb, beat, note, dur] of MELODY) {
        if (mb === bar && Math.round(beat * 4) === inBar) {
          whistle(t, note + tr, dur * spb * 0.95, fs ? 0.06 : 0.05, bus);
        }
      }

      music.nextTime += s16;
      music.step = (step + 1) % (BARS * 16);
    }
  }

  // ─────────────────────────────────────────────────────── المؤثرات
  const now = () => ctx.currentTime + 0.005;
  const ok = () => ctx && opts.sfx && !opts.muted;
  const PENTA = [0, 3, 5, 7, 10];

  const sfx = {
    click() { if (!ok()) return; const t = now(); tone(t, 900, 0.05, { vol: 0.08, slide: 500, rev: 0 }); noise(t, 0.02, { vol: 0.05, freq: 2500, q: 2 }); },
    spin() {
      if (!ok()) return; const t = now();
      noise(t, 0.45, { vol: 0.09, freq: 350, slide: 2400, q: 1.2, attack: 0.08 });
      tone(t, 180, 0.25, { vol: 0.06, slide: 360, type: 'triangle' });
    },
    reelStop(i) {
      if (!ok()) return; const t = now();
      tone(t, 150 - i * 6, 0.16, { vol: 0.22, slide: 55, rev: 0.05 });
      noise(t, 0.05, { vol: 0.08, type: 'lowpass', freq: 1400, q: 0.8 });
    },
    win(level = 1) {
      if (!ok()) return; const t = now();
      const n = Math.min(3 + level, 8);
      for (let i = 0; i < n; i++) {
        const m = 69 + PENTA[i % 5] + 12 * Math.floor(i / 5);
        pluck(t + i * 0.055, m, 0.28, sfxBus, { bright: 0.7, rev: 0.35, pan: (i / n) - 0.5 });
      }
      tone(t, midiHz(81), 0.9, { vol: 0.04, type: 'triangle', rev: 0.4, attack: 0.02 });
    },
    burst() {
      if (!ok()) return; const t = now();
      noise(t, 0.35, { vol: 0.07, type: 'highpass', freq: 3000, slide: 9000 });
      for (let i = 0; i < 6; i++) tone(t + Math.random() * 0.2, 1800 + Math.random() * 2600, 0.18, { vol: 0.03, type: 'sine', rev: 0.3 });
    },
    wild() {
      if (!ok()) return; const t = now();
      [72, 76, 79, 84, 88, 91].forEach((m, i) => tone(t + i * 0.05, midiHz(m), 0.7, { vol: 0.05, type: 'triangle', rev: 0.55 }));
      noise(t, 0.8, { vol: 0.05, type: 'highpass', freq: 5000, slide: 12000, rev: 0.3 });
      tone(t, 220, 0.5, { vol: 0.1, slide: 880, type: 'sine', rev: 0.3 });
    },
    ladder(i) {
      if (!ok()) return; const t = now();
      tone(t, 200, 0.2, { vol: 0.2, slide: 90, rev: 0.05 });
      tone(t + 0.02, 900 + i * 90, 0.5, { vol: 0.06, type: 'triangle', rev: 0.4 });
      noise(t, 0.06, { vol: 0.06, freq: 1800, q: 4 });
    },
    mult() {
      if (!ok()) return; const t = now();
      noise(t, 0.35, { vol: 0.1, freq: 600, slide: 3000, q: 1, attack: 0.1 });
      tone(t + 0.3, 95, 0.6, { vol: 0.32, slide: 38, rev: 0.1 });
      brass(t + 0.3, [57, 64, 69], 0.5, 0.045);
    },
    scatter(k = 0) {
      if (!ok()) return; const t = now();
      tone(t, 130 + k * 25, 0.35, { vol: 0.3, slide: 60, rev: 0.2 });
      for (let i = 0; i < 5; i++) noise(t + i * 0.035, 0.04, { vol: 0.06, freq: 2600 + k * 300, q: 5 });
      tone(t, midiHz(76 + k * 3), 0.6, { vol: 0.05, type: 'triangle', rev: 0.5 });
    },
    trigger() {
      if (!ok()) return; const t = now();
      brass(t, [57, 61, 64], 0.35, 0.05);
      brass(t + 0.32, [59, 62, 66], 0.35, 0.05);
      brass(t + 0.64, [61, 64, 69, 73], 1.4, 0.055);
      noise(t + 0.64, 1.6, { vol: 0.07, type: 'highpass', freq: 6000, rev: 0.4 });
      tone(t + 0.64, 70, 1, { vol: 0.3, slide: 35 });
    },
    coins(sec = 1.6) {
      if (!ok()) return; const t = now();
      const n = Math.floor(sec * 22);
      for (let i = 0; i < n; i++) {
        const tt = t + Math.random() * sec;
        tone(tt, 2400 + Math.random() * 2400, 0.09, { vol: 0.025, type: 'triangle', rev: 0.15 });
        tone(tt + 0.01, 5200 + Math.random() * 1500, 0.05, { vol: 0.012, type: 'sine' });
      }
    },
    bigWin() {
      if (!ok()) return; const t = now();
      brass(t, [57, 64, 69], 0.4, 0.05);
      brass(t + 0.4, [60, 67, 72], 0.4, 0.05);
      brass(t + 0.8, [64, 69, 76, 81], 1.8, 0.06);
      tone(t + 0.8, 55, 1.2, { vol: 0.3, slide: 30 });
      sfx.coins(2.8);
    },
    tick() { if (!ok()) return; tone(now(), 2200, 0.03, { vol: 0.03, type: 'square', rev: 0 }); },
    fsEnd() {
      if (!ok()) return; const t = now();
      [57, 64, 69, 72, 76].forEach((m, i) => pluck(t + i * 0.09, m, 0.3, sfxBus, { bright: 0.6, rev: 0.45 }));
      brass(t + 0.45, [57, 64, 69], 1.2, 0.04);
    },
    error() { if (!ok()) return; const t = now(); tone(t, 220, 0.18, { vol: 0.08, type: 'square', slide: 150, rev: 0 }); }
  };

  function applyGains() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(opts.muted ? 0 : 0.9, t, 0.05);
    musicBus.gain.setTargetAtTime(opts.music ? 0.55 : 0, t, 0.2);
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
