'use strict';

const EventEmitter = require('events');
const store = require('./store');
const { newServerSeed, sha256Hex, deriveBoard, randInt } = require('./rng');
const {
  STAKES, TIMING, FULL_TABLE_LAUNCH_MS, ALL_PICKED_TAIL_MS,
  CARD_COUNT, MAX_PLAYERS, GRID, SERVER,
  HIGH_STAKE_THRESHOLD, HIGH_STAKE_MAX_MULTIPLIER, cappedMultiplier
} = require('./config');

/**
 * محرك لعبة "كروت الحظ".
 *
 * دورة الجولة:
 *   betting (15 ث)  -> اللاعبون يختارون مبلغ المشاركة. الحد الأقصى 12 مشترك.
 *                      عند اكتمال الـ12 تنطلق اللعبة فوراً (عد تنازلي 3 ثوانٍ).
 *   playing (30 ث)  -> كل لاعب يحجز كرتاً واحداً. لا تُكشف أي قيمة أثناء اللعب،
 *                      حتى صاحب الكرت لا يرى نتيجته — الجميع يرى فقط
 *                      أي كرت حجزه كل لاعب.
 *   results (5 ث)   -> تنكشف الكروت الاثنا عشر دفعة واحدة، تُضاف الأرباح،
 *                      وتُنشر بذرة الجولة للتحقق.
 *
 * الخادم هو المرجع الوحيد للحالة: المتصفح لا يقرر شيئاً، فقط يعرض ويطلب.
 */

class LuckyCards extends EventEmitter {
  constructor() {
    super();
    this.roundCounter = 0;
    this.history = [];
    /** @type {Map<string, object>} playerId -> seat */
    this.seats = new Map();
    this.cardOwners = new Array(CARD_COUNT).fill(null);
    this.phase = 'betting';
    this.phaseStartedAt = Date.now();
    this.phaseEndsAt = Date.now();
    this.board = null;
    this.serverSeed = null;
    this.seedHash = null;
    this.lastSummary = null;
    this.timer = null;
    this.startBetting();
  }

  // ------------------------------------------------------------------ دورة الحياة

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 250);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (Date.now() < this.phaseEndsAt) return;
    if (this.phase === 'betting') {
      if (this.seats.size === 0) this.startBetting(); // لا مشتركين: جولة جديدة فوراً
      else this.startPlaying();
    } else if (this.phase === 'playing') {
      this.phase = 'processing';
      await this.finishRound();
    } else if (this.phase === 'results') {
      this.startBetting();
    }
  }

  startBetting() {
    this.roundCounter += 1;
    this.roundId = `R${String(this.roundCounter).padStart(6, '0')}`;

    // الالتزام المسبق: نولّد البذرة ونشتق اللوحة الآن، وننشر البصمة فقط.
    this.serverSeed = newServerSeed();
    this.seedHash = sha256Hex(this.serverSeed);
    this.board = deriveBoard(this.serverSeed, this.roundId);

    this.seats.clear();
    this.cardOwners = new Array(CARD_COUNT).fill(null);
    this.roundStartedAt = Date.now();
    this.setPhase('betting', TIMING.betting);
  }

  startPlaying() {
    this.setPhase('playing', TIMING.playing);
  }

  setPhase(phase, durationMs) {
    this.phase = phase;
    this.phaseStartedAt = Date.now();
    this.phaseDuration = durationMs;
    this.phaseEndsAt = this.phaseStartedAt + durationMs;
    this.emit('update', { reason: 'phase', phase });
  }

  // ------------------------------------------------------------------ أفعال اللاعبين

  /** مشاركة لاعب حقيقي بمبلغ من الجدول. */
  async join(playerId, stake) {
    const player = store.byId(playerId);
    if (!player) return { ok: false, error: 'لم يتم العثور على حسابك' };

    const guard = this.canJoin(stake);
    if (!guard.ok) return guard;
    if (this.seats.has(playerId)) return { ok: false, error: 'أنت مشارك في هذه الجولة بالفعل' };
    if (player.balance < stake) return { ok: false, error: 'رصيدك لا يكفي لهذا المبلغ' };

    const txRef = 'cards-join-' + player.id + '-' + this.roundId;
    if (!(await store.gameDebit('lucky-cards', player, stake, txRef))) {
      return { ok: false, error: 'تعذّر خصم المبلغ (رصيد غير كافٍ أو خطأ بالاتصال)' };
    }
    this.seatPlayer({ id: player.id, isBot: false, stake });
    return { ok: true, balance: player.balance, roundId: this.roundId };
  }

  /** مشاركة لاعب آلي (لا يملك محفظة، ولا يؤثر على أي رصيد حقيقي). */
  joinBot(bot, stake) {
    const guard = this.canJoin(stake);
    if (!guard.ok) return guard;
    if (this.seats.has(bot.id)) return { ok: false, error: 'مشارك بالفعل' };
    this.seatPlayer({ id: bot.id, isBot: true, stake });
    return { ok: true };
  }

  canJoin(stake) {
    if (this.phase !== 'betting') return { ok: false, error: 'انتهى وقت المشاركة، انتظر الجولة القادمة' };
    if (!STAKES.includes(stake)) return { ok: false, error: 'مبلغ غير مسموح' };
    if (this.seats.size >= MAX_PLAYERS) return { ok: false, error: 'اكتمل عدد المشاركين في هذه الجولة' };
    return { ok: true };
  }

  seatPlayer({ id, isBot, stake }) {
    // المقعد لا يحمل اسماً: الهوية المعروضة للجميع هي المعرّف فقط
    this.seats.set(id, {
      id, isBot, stake,
      cardIndex: null,
      cardValue: null,
      multiplier: null,
      capped: false,
      payout: null,
      auto: false,
      // القاعدة معروفة للاعب قبل أن يلعب، لا تُكتشف بعد النتيجة
      maxMultiplier: stake >= HIGH_STAKE_THRESHOLD ? HIGH_STAKE_MAX_MULTIPLIER : null,
      joinedAt: Date.now(),
      pickedAt: null
    });

    // اكتمال الطاولة يطلق الجولة فوراً بدل انتظار المهلة كاملة
    if (this.seats.size >= MAX_PLAYERS) {
      const fastEnd = Date.now() + FULL_TABLE_LAUNCH_MS;
      if (fastEnd < this.phaseEndsAt) {
        this.phaseEndsAt = fastEnd;
        this.emit('update', { reason: 'table-full' });
      }
    }
    this.emit('update', { reason: 'join', playerId: id });
  }

  /** الانسحاب قبل انطلاق الجولة مع استرداد المبلغ. */
  async leave(playerId) {
    if (this.phase !== 'betting') return { ok: false, error: 'لا يمكن الانسحاب بعد بدء الجولة' };
    const seat = this.seats.get(playerId);
    if (!seat) return { ok: false, error: 'أنت غير مشارك' };
    const player = store.byId(playerId);
    if (player) {
      const txRef = 'cards-leave-' + player.id + '-' + this.roundId;
      await store.gameCredit('lucky-cards', player, seat.stake, txRef);
    }
    this.seats.delete(playerId);
    this.emit('update', { reason: 'leave', playerId });
    return { ok: true, balance: player ? player.balance : null };
  }

  /** حجز كرت. كل لاعب له كرت واحد، والكرت المحجوز لا يُختار مرتين.
   *  النتيجة لا تُكشف هنا — تُكشف كل الكروت معاً في نهاية الجولة. */
  pick(playerId, cardIndex) {
    if (this.phase !== 'playing') return { ok: false, error: 'اللعب غير متاح الآن' };
    const seat = this.seats.get(playerId);
    if (!seat) return { ok: false, error: 'أنت لست مشاركاً في هذه الجولة' };
    if (seat.cardIndex !== null) return { ok: false, error: 'اخترت كرتك في هذه الجولة' };

    const i = Number(cardIndex);
    if (!Number.isInteger(i) || i < 0 || i >= CARD_COUNT) return { ok: false, error: 'كرت غير صالح' };
    if (this.cardOwners[i] !== null) return { ok: false, error: 'هذا الكرت محجوز للاعب آخر' };

    this.assignCard(seat, i, false);
    this.emit('update', { reason: 'pick', playerId, cardIndex: i });

    // إذا اختار الجميع، نختصر الانتظار إلى آخر ثوانٍ بدل الوقوف بلا فائدة
    if (this.allPicked()) {
      const fastEnd = Date.now() + ALL_PICKED_TAIL_MS;
      if (fastEnd < this.phaseEndsAt) {
        this.phaseEndsAt = fastEnd;
        this.emit('update', { reason: 'all-picked' });
      }
    }

    // لا نُرجع المضاعف ولا الربح: النتيجة لا تُكشف قبل نهاية الجولة
    return { ok: true, cardIndex: i };
  }

  assignCard(seat, i, auto) {
    const raw = this.board.cards[i];
    // سقف المضاعف على المبالغ الكبيرة — قاعدة معلنة مسبقاً في /api/config والواجهة
    const paid = cappedMultiplier(seat.stake, raw);

    this.cardOwners[i] = seat.id;
    seat.cardIndex = i;
    seat.cardValue = raw;        // قيمة الكرت كما ظهرت على اللوحة
    seat.multiplier = paid;      // المضاعف المصروف فعلاً
    seat.capped = paid < raw;
    seat.payout = Math.round(seat.stake * paid);
    seat.auto = auto;
    seat.pickedAt = Date.now();
  }

  allPicked() {
    for (const seat of this.seats.values()) if (seat.cardIndex === null) return false;
    return true;
  }

  freeCards() {
    const free = [];
    for (let i = 0; i < CARD_COUNT; i++) if (this.cardOwners[i] === null) free.push(i);
    return free;
  }

  // ------------------------------------------------------------------ إنهاء الجولة

  async finishRound() {
    // من لم يختر (انقطع اتصاله أو تأخر) يحصل على كرت عشوائي من المتبقي
    for (const seat of this.seats.values()) {
      if (seat.cardIndex !== null) continue;
      const free = this.freeCards();
      if (!free.length) { seat.multiplier = 0; seat.payout = 0; seat.auto = true; continue; }
      this.assignCard(seat, free[randInt(free.length)], true);
    }

    // صرف الأرباح وتحديث الإحصاءات.
    // نحسب بدلوين: البشر (مال فعلي) والبوتات (محاكاة لحجم اللعب).
    const real = { wagered: 0, paid: 0, bets: 0 };
    const bot = { wagered: 0, paid: 0, bets: 0 };

    for (const seat of this.seats.values()) {
      if (seat.isBot) {
        bot.wagered += seat.stake;
        bot.paid += seat.payout;
        bot.bets += 1;
        continue;
      }
      const player = store.byId(seat.id);
      if (!player) continue;
      if (seat.payout > 0) {
        const txRef = 'cards-win-' + player.id + '-' + this.roundId;
        await store.gameCredit('lucky-cards', player, seat.payout, txRef);
      }
      store.recordRound(player, {
        stake: seat.stake,
        payout: seat.payout,
        multiplier: seat.multiplier
      });
      seat.balanceAfter = player.balance;
      real.wagered += seat.stake;
      real.paid += seat.payout;
      real.bets += 1;
    }
    store.recordLedger({ real, bot, game: 'cards' });

    const summary = {
      roundId: this.roundId,
      endedAt: Date.now(),
      templateName: this.board.templateName,
      templateKey: this.board.templateKey,
      seedHash: this.seedHash,
      serverSeed: this.serverSeed,
      cards: this.board.cards.slice(),
      startedAt: this.roundStartedAt,
      // الدورة الكاملة = (مشاركة + لعب) المقيسان فعلياً + مرحلة النتائج الثابتة.
      // نضيف النتائج لأن finishRound يُستدعى قبل بدئها، وبدونها تُحسب
      // "جولات في الساعة" أكبر من الواقع فتتضخّم توقعات الجدوى.
      durationMs: Date.now() - this.roundStartedAt + TIMING.results,
      house: {
        real: { ...real, profit: real.wagered - real.paid },
        bot: { ...bot, profit: bot.wagered - bot.paid },
        total: {
          wagered: real.wagered + bot.wagered,
          paid: real.paid + bot.paid,
          bets: real.bets + bot.bets,
          profit: (real.wagered + bot.wagered) - (real.paid + bot.paid)
        }
      },
      seats: [...this.seats.values()].map((s) => ({
        id: s.id, isBot: s.isBot, stake: s.stake,
        cardIndex: s.cardIndex, cardValue: s.cardValue,
        multiplier: s.multiplier, capped: s.capped,
        payout: s.payout, net: s.payout - s.stake, auto: s.auto
      }))
    };
    this.lastSummary = summary;
    store.recordRoundLog(summary);
    this.history.unshift(summary);
    if (this.history.length > SERVER.historySize) this.history.length = SERVER.historySize;

    this.setPhase('results', TIMING.results);
    this.emit('round-end', summary);
  }

  // ------------------------------------------------------------------ عرض الحالة

  /**
   * الحالة العامة مخصّصة لكل لاعب:
   * أثناء اللعب يرى الجميع *أي كرت* اختاره كل لاعب، لكن قيمة الكرت
   * تظهر لصاحبها فقط — وتنكشف للجميع في مرحلة النتائج.
   */
  stateFor(playerId) {
    const revealAll = this.phase === 'results';
    const now = Date.now();

    const cards = [];
    for (let i = 0; i < CARD_COUNT; i++) {
      const ownerId = this.cardOwners[i];
      const owner = ownerId ? this.seats.get(ownerId) : null;
      // الكشف في مرحلة النتائج فقط — لا أحد يرى قيمة أي كرت قبلها، ولا حتى كرته
      const visible = revealAll;
      cards.push({
        i,
        // هوية اللاعب على الطاولة هي المعرّف فقط — لا تُنشر الأسماء إطلاقاً
        owner: owner ? { id: owner.id, isBot: owner.isBot } : null,
        multiplier: visible && this.board ? this.board.cards[i] : null
      });
    }

    const seats = [...this.seats.values()].map((s) => {
      const mine = s.id === playerId;
      const show = revealAll;
      return {
        id: s.id,
        isBot: s.isBot,
        stake: s.stake,
        cardIndex: s.cardIndex,
        cardValue: show ? s.cardValue : null,
        multiplier: show ? s.multiplier : null,
        capped: show ? s.capped : false,
        payout: show ? s.payout : null,
        auto: s.auto,
        isYou: mine
      };
    }).sort((a, b) => b.stake - a.stake);

    const you = this.seats.get(playerId) || null;

    return {
      game: 'lucky-cards',
      now,
      roundId: this.roundId,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      phaseDuration: this.phaseDuration,
      msLeft: Math.max(0, this.phaseEndsAt - now),
      grid: GRID,
      maxPlayers: MAX_PLAYERS,
      stakes: STAKES,
      playerCount: this.seats.size,
      seatsTaken: this.cardOwners.filter((o) => o !== null).length,
      seedHash: this.seedHash,
      serverSeed: revealAll ? this.serverSeed : null,
      templateName: revealAll && this.board ? this.board.templateName : null,
      cards,
      seats,
      highStake: { threshold: HIGH_STAKE_THRESHOLD, maxMultiplier: HIGH_STAKE_MAX_MULTIPLIER },
      you: you ? {
        seated: true,
        stake: you.stake,
        cardIndex: you.cardIndex,
        // نتيجتك أنت أيضاً محجوبة حتى مرحلة النتائج
        cardValue: revealAll ? you.cardValue : null,
        multiplier: revealAll ? you.multiplier : null,
        capped: revealAll ? you.capped : false,
        maxMultiplier: you.maxMultiplier,
        payout: revealAll ? you.payout : null,
        auto: you.auto
      } : { seated: false }
    };
  }

  recentHistory(limit = 12) {
    return this.history.slice(0, limit).map((h) => ({
      roundId: h.roundId,
      endedAt: h.endedAt,
      templateName: h.templateName,
      seedHash: h.seedHash,
      serverSeed: h.serverSeed,
      cards: h.cards,
      players: h.seats.length,
      topWin: h.seats.reduce((best, s) => (s.payout > (best?.payout ?? -1) ? s : best), null)
    }));
  }

  /** بيانات كاملة للوحة الإدارة — من السجل المحفوظ حتى تبقى بعد إعادة التشغيل. */
  adminHistory(limit = 40) {
    return store.rounds(limit);
  }

  /** لقطة حيّة للجولة الجارية تستخدمها لوحة الإدارة. */
  adminSnapshot() {
    const seats = [...this.seats.values()];
    return {
      roundId: this.roundId,
      phase: this.phase,
      msLeft: Math.max(0, this.phaseEndsAt - Date.now()),
      players: seats.length,
      humans: seats.filter((s) => !s.isBot).length,
      exposure: seats.filter((s) => !s.isBot).reduce((a, s) => a + s.stake, 0),
      botExposure: seats.filter((s) => s.isBot).reduce((a, s) => a + s.stake, 0),
      templateKey: this.board ? this.board.templateKey : null,
      templateName: this.board ? this.board.templateName : null,
      cards: this.phase === 'results' && this.board ? this.board.cards.slice() : null
    };
  }
}

module.exports = new LuckyCards();
