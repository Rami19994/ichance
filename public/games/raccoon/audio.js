/* ==========================================================================
   راكون الكونغ فو — الصوت
   موسيقى صينية خماسية ومؤثرات مُركّبة كلها في المتصفح (Web Audio) — لا ملفات.
   الغوجنغ (قانون صيني): وتر مقروص Karplus-Strong بانزلاق خفيف. الناي: جيبية
   بنفَس واهتزاز. الإيقاع: قطعة خشب وطبل وصنج (غونغ). المجانية: أسرع وأعلى.
   ========================================================================== */
'use strict';

window.RCAudio = (() => {
  let ctx = null, master, musicBus, sfxBus, reverb;
  const opts = { music: true, sfx: true, muted: false };
  const pluckCache = new Map();
  let noiseBuf = null;
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem('rc_audio') || '{}');
      if (typeof o.music === 'boolean') opts.music = o.music;
      if (typeof o.sfx === 'boolean') opts.sfx = o.sfx;
      if (typeof o.muted === 'boolean') opts.muted = o.muted;
    } catch { /* تصفح خاص */ }
  }
  function save() { try { localStorage.setItem('rc_audio', JSON.stringify(opts)); } catch { /* */ } }
  load();

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch { return false; }
    master = ctx.createGain(); master.gain.value = opts.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = opts.music ? 0.5 : 0; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = opts.sfx ? 0.9 : 0; sfxBus.connect(master);
    const delay = ctx.createDelay(); delay.delayTime.value = 0.11;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    delay.connect(lp); lp.connect(fb); fb.connect(delay);
    const send = ctx.createGain(); send.gain.value = 0.34; lp.connect(send); send.connect(master);
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
  function pluckBuffer(midi, dur = 1.4, bright = 0.7, decay = 0.995) {
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
  /** الغوجنغ: وتر مقروص ينزلق نصف نغمة للأعلى في بعض النغمات (زخرفة). */
  function zheng(t, midi, vol, bus, { bend = false, pan = 0, rev = 0.3, dur = 1.6 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = pluckBuffer(midi, dur, 0.72, 0.996);
    if (bend) { src.playbackRate.setValueAtTime(0.944, t); src.playbackRate.linearRampToValueAtTime(1, t + 0.12); }
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
    o.connect(g); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, { vol = 0.1, type = 'bandpass', freq = 1000, q = 1, slide = null, bus = sfxBus, rev = 0, attack = 0.003 } = {}) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (slide) f.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = out(bus, { rev });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    src.start(t, Math.random() * 1.2); src.stop(t + dur + 0.05);
  }
  /** الناي الصيني (ديزي): جيبية بنفَس واهتزاز يتأخّر. */
  function flute(t, midi, dur, vol = 0.05, bus = sfxBus) {
    const f = midiHz(midi);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.02, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.12;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
    const lg = ctx.createGain(); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(dur, 0.4));
    lfo.connect(lg); lg.connect(o.frequency);
    const g = out(bus, { rev: 0.45 });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
    g.gain.setValueAtTime(vol, t + Math.max(0.05, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    o.connect(g); o2.connect(g2); g2.connect(g);
    o.start(t); o2.start(t); lfo.start(t);
    o.stop(t + dur + 0.15); o2.stop(t + dur + 0.15); lfo.stop(t + dur + 0.15);
    noise(t, 0.07, { vol: vol * 0.3, freq: f * 2.5, q: 2, bus });
  }
  function woodblock(t, hi = true, vol = 0.06, bus = sfxBus) {
    tone(t, hi ? 1250 : 900, 0.06, { type: 'sine', vol, bus, rev: 0.05 });
    noise(t, 0.02, { vol: vol * 0.5, freq: hi ? 2400 : 1700, q: 6, bus });
  }
  function gong(t, vol = 0.14, bus = sfxBus) {
    for (const [f, v] of [[98, 1], [147, 0.6], [196, 0.45], [277, 0.3], [415, 0.2]]) {
      tone(t, f, 2.6, { type: 'sine', vol: vol * v, slide: f * 0.97, attack: 0.01, bus, rev: 0.5 });
    }
    noise(t, 1.8, { vol: vol * 0.25, type: 'bandpass', freq: 900, q: 0.8, bus, rev: 0.4 });
  }

  // ─────────────────────────────────────────────────────── الموسيقى
  // خماسي ري (D E G A B): لحن 8 مازورات 4/4 يتكرّر، مع إيقاع طبل وقطعة خشب
  const MEL = [
    [0, 74, 1], [1, 76, 1], [2, 79, 1.5], [3.5, 76, 0.5],
    [4, 74, 1], [5, 71, 1], [6, 74, 2],
    [8, 79, 1], [9, 81, 1], [10, 83, 1.5], [11.5, 81, 0.5],
    [12, 79, 1], [13, 76, 1], [14, 74, 2],
    [16, 76, 1], [17, 79, 0.5], [17.5, 76, 0.5], [18, 74, 1], [19, 71, 1],
    [20, 69, 1], [21, 71, 1], [22, 74, 2],
    [24, 81, 1], [25, 79, 1], [26, 76, 1], [27, 74, 1],
    [28, 71, 1], [29, 74, 1], [30, 74, 2]
  ];
  const BASS = [50, 50, 55, 55, 52, 52, 50, 57];   // أساس كل مازورة
  const BEATS = 32;
  const TEMPO = { base: 100, fs: 124 };
  const music = { on: false, mode: 'base', nextTime: 0, step: 0, timer: null, gain: null };

  function musicStart() {
    if (!ctx || music.on) return;
    music.on = true;
    music.gain = ctx.createGain(); music.gain.gain.value = 1; music.gain.connect(musicBus);
    music.nextTime = ctx.currentTime + 0.15;
    music.step = 0;
    music.timer = setInterval(schedule, 70);
  }
  function setMode(mode) { if (music.mode !== mode) { music.mode = mode; music.step = 0; } }

  function schedule() {
    if (!ctx || !music.on) return;
    const bus = music.gain;
    while (music.nextTime < ctx.currentTime + 0.22) {
      const fs = music.mode === 'fs';
      const spb = 60 / TEMPO[music.mode];
      const s8 = spb / 2;
      const t = music.nextTime;
      const step = music.step;                // ثُمن داخل 32 نبضة (64 ثُمناً)
      const beat = step / 2;
      const bar = Math.floor(beat / 4) % 8;
      const tr = fs ? 2 : 0;
      const inBar = step % 8;
      // الباص والغوجنغ المتكرّر (أربيجيو خماسي)
      if (inBar === 0) zheng(t, BASS[bar] + tr - 12, 0.34, bus, { rev: 0.2, dur: 2 });
      if (inBar === 4) zheng(t, BASS[bar] + tr - 5, 0.24, bus, { rev: 0.2 });
      const arp = [0, 7, 12, 14, 12, 7, 5, 7];
      zheng(t, BASS[bar] + tr + arp[inBar], fs ? 0.12 : 0.09, bus, { pan: 0.25, bend: inBar === 3 && bar % 2 === 1, dur: 1 });
      // الإيقاع
      if (inBar === 0 || inBar === 4) tone(t, 80, 0.2, { vol: 0.2, slide: 42, bus, rev: 0 });
      if (inBar === 2 || inBar === 6 || (fs && inBar % 2 === 1)) woodblock(t, inBar !== 6, fs ? 0.07 : 0.05, bus);
      if (bar === 7 && inBar === 6) noise(t, 0.4, { vol: 0.05, type: 'highpass', freq: 5000, bus, rev: 0.3 });
      if (step === 0) gong(t, 0.08, bus);
      // الناي: اللحن من الدورة الثانية كي يبدأ المقطع بالإيقاع
      for (const [b, note, len] of MEL) {
        if (Math.round(b * 2) === step) flute(t, note + tr, len * spb * 0.95, fs ? 0.055 : 0.045, bus);
      }
      music.nextTime += s8;
      music.step = (step + 1) % (BEATS * 2);
    }
  }

  // ─────────────────────────────────────────────────────── المؤثرات
  const now = () => ctx.currentTime + 0.005;
  const ok = () => ctx && opts.sfx && !opts.muted;
  const PENTA = [62, 64, 67, 69, 71, 74, 76, 79, 81, 83];
  const sfx = {
    click() { if (!ok()) return; const t = now(); woodblock(t, true, 0.06); },
    spin() { if (!ok()) return; const t = now(); noise(t, 0.4, { vol: 0.07, freq: 500, slide: 2600, q: 1.1, attack: 0.06 }); zheng(t, 74, 0.12, sfxBus); zheng(t + 0.05, 79, 0.1, sfxBus); },
    reelStop(i) { if (!ok()) return; const t = now(); tone(t, 150 - i * 10, 0.14, { vol: 0.22, slide: 60, rev: 0.05 }); woodblock(t, i % 2 === 0, 0.05); },
    wild(k = 0) { if (!ok()) return; const t = now(); zheng(t, 74 + k * 5, 0.25, sfxBus, { bend: true }); tone(t + 0.02, midiHz(86 + k * 3), 0.6, { vol: 0.05, type: 'triangle', rev: 0.5 }); },
    win(level = 1) {
      if (!ok()) return; const t = now();
      const n = Math.min(4 + level * 2, 10);
      for (let i = 0; i < n; i++) zheng(t + i * 0.055, PENTA[i], 0.26, sfxBus, { pan: (i / n) - 0.5, dur: 1 });
      if (level >= 2) gong(t + 0.1, 0.09);
    },
    collect() { if (!ok()) return; const t = now(); for (let i = 0; i < 6; i++) tone(t + i * 0.05, 1800 + i * 260, 0.25, { vol: 0.04, type: 'triangle', rev: 0.4 }); zheng(t, 86, 0.2, sfxBus); },
    mult() { if (!ok()) return; const t = now(); gong(t, 0.16); flute(t + 0.05, 86, 0.5, 0.06); },
    trigger() {
      if (!ok()) return; const t = now();
      gong(t, 0.2);
      [74, 76, 79, 81, 83, 86].forEach((m, i) => flute(t + 0.2 + i * 0.12, m, 0.18, 0.055));
      for (let i = 0; i < 8; i++) woodblock(t + 0.2 + i * 0.09, i % 2 === 0, 0.06);
    },
    tick() { if (!ok()) return; tone(now(), 2200, 0.03, { vol: 0.03, type: 'square', rev: 0 }); },
    coins(sec = 1.6) {
      if (!ok()) return; const t = now();
      for (let i = 0; i < Math.floor(sec * 20); i++) tone(t + Math.random() * sec, 2400 + Math.random() * 2400, 0.09, { vol: 0.024, type: 'triangle', rev: 0.15 });
    },
    bigWin() {
      if (!ok()) return; const t = now();
      gong(t, 0.22);
      [74, 79, 81, 86].forEach((m, i) => flute(t + 0.15 + i * 0.18, m, 0.3, 0.06));
      flute(t + 0.9, 88, 1.2, 0.06);
      sfx.coins(2.8);
    },
    jackpot() {
      if (!ok()) return; const t = now();
      gong(t, 0.24); gong(t + 0.8, 0.18);
      for (let i = 0; i < 12; i++) zheng(t + 0.2 + i * 0.07, PENTA[i % 10] + 12, 0.2, sfxBus);
      flute(t + 1.1, 91, 1.4, 0.06);
      sfx.coins(3.2);
    },
    fsEnd() { if (!ok()) return; const t = now(); gong(t, 0.18); [86, 83, 81, 79, 74].forEach((m, i) => zheng(t + i * 0.09, m, 0.24, sfxBus)); },
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
    if (document.hidden) ctx.suspend().catch(() => {}); else ctx.resume().catch(() => {});
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
