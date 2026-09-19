/* ==========================================================================
   iCHANCE — موسيقى خلفية مولَّدة بـ WebAudio
   --------------------------------------------------------------------------
   لا ملفات صوتية ولا تحميل خارجي: النغمات تُولَّد في المتصفح لحظياً.
   الموسيقى جزء من الصفحة، فتتوقف من نفسها عند إغلاق اللعبة أو مغادرتها —
   لا تبقى تعمل في الخلفية ولا تحتاج إيقافاً يدوياً.
   ========================================================================== */
'use strict';

const MUSIC_KEY = 'ichance.music';

/** نوتة -> تردد. A4 = 440Hz. */
function note(n) {
  const names = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  const m = /^([A-G]#?)(-?\d)$/.exec(n);
  if (!m) return 440;
  const semis = names[m[1]] + (Number(m[2]) + 1) * 12 - 69;
  return 440 * Math.pow(2, semis / 12);
}

/**
 * مقاطع موسيقية لكل لعبة.
 * bass = خط الباص · lead = اللحن. كل عنصر [نوتة, عدد النبضات] و null = صمت.
 */
const TRACKS = {
  // غربي: مقام صغير بإيقاع متمهّل يشبه أجواء الصحراء
  western: {
    bpm: 96,
    bass: [
      ['D2', 2], ['D2', 1], ['A2', 1], ['D2', 2], ['F2', 1], ['A2', 1],
      ['C3', 2], ['C3', 1], ['G2', 1], ['A#2', 2], ['A2', 1], ['G2', 1]
    ],
    lead: [
      ['D4', 1], ['F4', 1], ['A4', 2], [null, 1], ['G4', 1], ['F4', 2],
      ['E4', 1], ['D4', 1], ['F4', 2], [null, 2], ['A4', 1], ['G4', 1],
      ['F4', 2], ['D4', 2], [null, 4]
    ]
  },
  // المعركة: إيقاع سريع بمقام صغير — توتّر بلا إزعاج، فاللعب طويل
  battle: {
    bpm: 132,
    bass: [
      ['E2', 1], ['E2', 1], ['E2', 1], ['G2', 1], ['A2', 1], ['A2', 1], ['G2', 1], ['E2', 1],
      ['D2', 1], ['D2', 1], ['D2', 1], ['F2', 1], ['G2', 2], ['E2', 2]
    ],
    lead: [
      ['E4', 1], ['B4', 1], ['G4', 2], ['A4', 1], ['E4', 1], ['D4', 2],
      [null, 1], ['G4', 1], ['A4', 1], ['B4', 1], ['A4', 2], ['G4', 2],
      ['E4', 2], [null, 2]
    ]
  },
  // طاولة الكروت: أهدأ وأكثر ترقّباً
  lounge: {
    bpm: 84,
    bass: [
      ['A2', 2], ['A2', 2], ['F2', 2], ['F2', 2],
      ['C3', 2], ['C3', 2], ['G2', 2], ['E2', 2]
    ],
    lead: [
      ['E4', 2], ['A4', 2], ['C5', 2], ['B4', 2],
      ['A4', 2], ['G4', 2], ['E4', 4]
    ]
  }
};

const Music = {
  ctx: null,
  master: null,
  timer: null,
  track: null,
  playing: false,
  enabled: true,
  volume: 0.16,

  /** يقرأ تفضيل اللاعب المحفوظ. */
  loadPref() {
    try { this.enabled = localStorage.getItem(MUSIC_KEY) !== '0'; } catch { this.enabled = true; }
    return this.enabled;
  },

  savePref() {
    try { localStorage.setItem(MUSIC_KEY, this.enabled ? '1' : '0'); } catch { /* تصفح خاص */ }
  },

  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  },

  /** نغمة واحدة: مذبذب + مغلّف بسيط. */
  voice(freq, start, dur, type, gain, detune) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (detune) osc.detune.setValueAtTime(detune, start);

    // مغلّف: صعود سريع ثم هبوط تدريجي — يمنع الطقطقة
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    osc.connect(g).connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  },

  /** يجدول مقطعاً كاملاً ابتداءً من زمن معيّن، ويرجّع طوله بالثواني. */
  schedule(at) {
    const t = TRACKS[this.track];
    const beat = 60 / t.bpm;
    let time = at;

    for (const [n, beats] of t.bass) {
      if (n) this.voice(note(n), time, beats * beat * 0.9, 'triangle', 0.5, 0);
      time += beats * beat;
    }
    const bassEnd = time;

    time = at;
    for (const [n, beats] of t.lead) {
      if (n) {
        this.voice(note(n), time, beats * beat * 0.8, 'sine', 0.32, 0);
        // طبقة ثانية مزاحة قليلاً تعطي دفئاً بدل نغمة جافة
        this.voice(note(n), time, beats * beat * 0.8, 'triangle', 0.14, 7);
      }
      time += beats * beat;
    }
    return Math.max(bassEnd, time) - at;
  },

  start(trackName) {
    this.track = TRACKS[trackName] ? trackName : 'western';
    if (!this.enabled || this.playing) return;
    const ctx = this.ensure();
    if (!ctx) return;

    // سياسة المتصفحات: لا صوت قبل أول تفاعل. نستأنف ثم نبدأ.
    if (ctx.state !== 'running') { ctx.resume().catch(() => {}); }

    this.playing = true;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.master.gain.exponentialRampToValueAtTime(this.volume, ctx.currentTime + 1.5);

    const loop = () => {
      if (!this.playing) return;
      const len = this.schedule(this.ctx.currentTime + 0.1);
      this.timer = setTimeout(loop, len * 1000 - 120);
    };
    loop();
  },

  stop(fadeSeconds = 0.6) {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), now);
    this.master.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
  },

  toggle(trackName) {
    this.enabled = !this.enabled;
    this.savePref();
    if (this.enabled) this.start(trackName);
    else this.stop();
    return this.enabled;
  },

  /**
   * إطفاء نهائي عند مغادرة اللعبة.
   * لا نكتفي بخفض الصوت: نغلق سياق الصوت كلّه، فتُلغى كل النغمات المجدولة
   * مسبقاً ولا يبقى أي شيء يعمل. `ensure()` يعيد بناءه إن عاد اللاعب.
   */
  shutdown() {
    this.playing = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx && ctx.state !== 'closed') {
      try { ctx.close(); } catch { /* أُغلق بالفعل */ }
    }
  }
};

/**
 * يربط الموسيقى بدورة حياة الصفحة.
 * تبدأ عند أول تفاعل (سياسة المتصفحات)، وتصمت عند إخفاء التبويب،
 * وتتوقف نهائياً عند مغادرة الصفحة.
 */
function initMusic(trackName) {
  Music.loadPref();

  const kick = () => {
    if (Music.enabled && !Music.playing) Music.start(trackName);
  };
  // نغطّي كل صور التفاعل: بعض المتصفحات لا تطلق pointerdown على اللمس،
  // والنقر البرمجي لا يطلقه إطلاقاً.
  for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown']) {
    window.addEventListener(ev, kick, { passive: true });
  }

  document.addEventListener('visibilitychange', () => {
    // لا نشغّل موسيقى لتبويب مخفي — إزعاج بلا فائدة
    if (document.hidden) Music.stop(0.35);
    else if (Music.enabled && !Music.playing) Music.start(trackName);
  });

  // مغادرة اللعبة بأي طريقة: إغلاق نهائي لسياق الصوت.
  // نغطّي الثلاثة لأن المتصفحات تختلف: pagehide هو الأوثق على الجوال،
  // beforeunload على سطح المكتب، وvisibilitychange يلتقط إخفاء التبويب.
  const kill = () => Music.shutdown();
  window.addEventListener('pagehide', kill);
  window.addEventListener('beforeunload', kill);

  // العودة من ذاكرة الرجوع (bfcache): الصفحة تُستعاد حيّة، فنعيد البناء
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && Music.enabled && !document.hidden) Music.start(trackName);
  });

  return Music;
}
