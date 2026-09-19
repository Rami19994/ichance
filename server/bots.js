'use strict';

const { randInt } = require('./rng');
const store = require('./store');
const { BOTS, STAKES, MAX_PLAYERS, TIMING } = require('./config');

/**
 * لاعبون آليون يملؤون الطاولة حتى تبقى اللعبة حيّة عند قلة اللاعبين.
 *
 * ملاحظات مهمة:
 *  - يظهرون دائماً بشارة "BOT" في الواجهة، فلا يوهمون أحداً.
 *  - لا يملكون محفظة ولا يؤثرون على رصيد أي لاعب حقيقي.
 *  - يعملون فقط عندما يكون هناك متصفّح بشري متصل.
 *  - يمكن إيقافهم نهائياً بتشغيل الخادم بـ  ICHANCE_BOTS=0
 */
class BotDirector {
  constructor(game) {
    this.game = game;
    this.viewers = 0;
    this.roundId = null;
    this.target = 0;
    this.active = new Map(); // botId -> { id, pickAt }
    this.nextJoinAt = 0;
    this.timer = null;
  }

  start() {
    if (!BOTS.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), 500);
    if (this.timer.unref) this.timer.unref();
    console.log('[bots] اللاعبون الآليون مفعّلون (أوقفهم بـ ICHANCE_BOTS=0)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setViewers(count) { this.viewers = count; }

  onNewRound() {
    this.roundId = this.game.roundId;
    this.active.clear();

    // نترك دائماً مقاعد للبشر المتصلين
    const humanSeats = Math.max(1, Math.min(this.viewers, 4));
    const cap = Math.min(BOTS.maxTarget, MAX_PLAYERS - humanSeats);
    const wanted = BOTS.minTarget + randInt(Math.max(1, BOTS.maxTarget - BOTS.minTarget + 1));
    this.target = Math.max(0, Math.min(wanted, cap));

    // نافذة المشاركة 5 ثوانٍ فقط: نبدأ فوراً تقريباً وإلا لم يلحق أحد
    this.nextJoinAt = Date.now() + 150 + randInt(400);
  }

  botStake() {
    // ميل نحو المبالغ الصغيرة، مع ظهور نادر للمبالغ الكبيرة
    const weights = [22, 20, 16, 13, 10, 8, 5, 3, 2, 1];
    const total = weights.reduce((a, b) => a + b, 0);
    let ticket = randInt(total);
    for (let i = 0; i < weights.length; i++) {
      ticket -= weights[i];
      if (ticket < 0) return STAKES[i];
    }
    return STAKES[0];
  }

  /** معرّف بنفس شكل معرّفات اللاعبين، مع ضمان عدم التصادم. */
  makeBotId() {
    const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let attempt = 0; attempt < 50; attempt++) {
      let id = '';
      for (let i = 0; i < 6; i++) id += alphabet[randInt(alphabet.length)];
      if (!store.byId(id) && !this.game.seats.has(id) && !this.active.has(id)) return id;
    }
    return `B${Date.now().toString(36).toUpperCase().slice(-5)}`;
  }

  makeBot() {
    // لا أسماء: الطاولة تعرض المعرّف فقط، مع شارة BOT صريحة
    return { id: this.makeBotId(), pickAt: 0 };
  }

  tick() {
    const game = this.game;
    if (game.roundId !== this.roundId) this.onNewRound();
    if (this.viewers <= 0) return; // لا أحد يشاهد -> لا داعي لتشغيلهم

    if (game.phase === 'betting') this.tickBetting();
    else if (game.phase === 'playing') this.tickPlaying();
  }

  tickBetting() {
    const now = Date.now();
    if (this.active.size >= this.target) return;
    if (now < this.nextJoinAt) return;
    // لا نزاحم البشر على آخر مقعد
    if (this.game.seats.size >= MAX_PLAYERS - 1) return;

    const bot = this.makeBot();
    const res = this.game.joinBot(bot, this.botStake());
    if (res.ok) this.active.set(bot.id, bot);

    const remaining = Math.max(0, this.target - this.active.size);
    // نحتفظ بآخر ثانية للبشر، ونوزّع الباقي على البوتات
    const windowLeft = Math.max(600, this.game.phaseEndsAt - now - 1000);
    this.nextJoinAt = now + Math.max(120, Math.round(windowLeft / (remaining + 1)) + randInt(200));
  }

  tickPlaying() {
    const now = Date.now();
    for (const bot of this.active.values()) {
      const seat = this.game.seats.get(bot.id);
      if (!seat || seat.cardIndex !== null) continue;
      if (!bot.pickAt) {
        // "تفكير" موزّع على معظم مدة اللعب حتى يبدو الجدول حيّاً
        bot.pickAt = now + 600 + randInt(Math.max(2000, TIMING.playing - 4000));
      }
      if (now >= bot.pickAt) {
        const free = this.game.freeCards();
        if (free.length) this.game.pick(bot.id, free[randInt(free.length)]);
      }
    }
  }
}

module.exports = BotDirector;
