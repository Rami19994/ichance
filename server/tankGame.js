'use strict';

const config = require('./config');
const store = require('./store');
const { sha256Hex, newServerSeed } = require('./rng');
const T = require('../public/js/tankSim.js');

/**
 * معركة الدبابات — لعبة مهارة برهان.
 *
 * القاعدة: يراهن اللاعب، يخوض معركة واحدة، ينجو ويُنهي كل الأعداء فيربح
 * الرهان × مضاعف الصعوبة، ويموت أو ينتهي وقته فيخسر الرهان.
 *
 * ── لماذا لا يوجد سُلّم مضاعفات؟
 * لأن الحساسية تصير أُسّية: في سُلّم من 12 درجة، لو كان اللاعبون أفضل من
 * تقديرنا بـ10% فقط لقفز العائد من 80% إلى 128% وصار الموقع خاسراً في كل
 * جولة. بجولة واحدة بمضاعف ثابت تصير العلاقة خطّية: مهارة أعلى بـ10% ترفع
 * العائد 10% لا أكثر — انحراف يُرى في اللوحة ويُعالَج بتعديل المضاعف.
 *
 * ── كيف يُمنع الغش؟
 * المتصفح لا يُصدَّق أبداً. هو يشغّل المحاكاة للعرض فقط، ثم يرسل **ضغطات
 * الأزرار** لا النتيجة. الخادم يعيد تشغيل المعركة نفسها بالبذرة نفسها وبتلك
 * الضغطات (tankSim.runReplay) ويحسب النتيجة بنفسه. تزوير الفوز يستلزم إيجاد
 * سلسلة ضغطات تفوز فعلاً — أي أن يلعب ويفوز حقاً.
 *
 * ── الحدّ المتبقّي (مكشوف عمداً)
 * المتصفح يملك البذرة أثناء اللعب (يلزمه ذلك ليرسم المعركة)، فيستطيع
 * برنامج آلي أن يلعب لعباً مثالياً. لهذا: (١) المضاعفات مضبوطة على أداء
 * **بوت قوي** لا لاعب متوسط، (٢) يوجد فحص زمن حقيقي يمنع إرسال معركة
 * أُنجزت أسرع ممّا يسمح الزمن، (٣) لوحة الإدارة تعرض نسبة الفوز الفعلية لكل
 * صعوبة لتُرى أي مبالغة فوراً. الحلّ الجذري (محاكاة على الخادم لحظياً) يحتاج
 * WebSocket، وهو التطوير المقترح إن صار اللعب بمال حقيقي.
 */

// أقصى رهان: نفس منطق السلوتس — سقف التعرّض بدل سقف المضاعف.
// أعلى مضاعف ×6.40، فأقصى ربح ممكن من جولة واحدة = 12,800 × 6.40 = 81,920.
const MAX_STAKE = 12_800;
const STAKES = config.STAKES.filter((s) => s <= MAX_STAKE);

// سجلّ الضغطات: [نبضة, قناع, ...]. أطول معركة 80 ثانية × 30 نبضة = 2400 نبضة،
// والتغيّر النادر جداً يكون كل نبضة، فـ6000 رقم سقف سخيّ وآمن.
const MAX_INPUT_NUMBERS = 6000;

// مهلة إضافية بعد انتهاء زمن المعركة قبل اعتبار الجلسة مهجورة.
const GRACE_MS = 45_000;

/**
 * أدنى نسبة من الزمن الحقيقي مقابل زمن المعركة.
 * معركة 40 ثانية لا يمكن أن تصل نتيجتها بعد 3 ثوانٍ: ذلك يعني سجلّ ضغطات
 * حُسب خارج اللعب. نسمح بـ60% لا 100% لأن تبويب الخلفية والتأخّر الشبكي
 * يجعلان القياس غير دقيق، ونحن نمنع «الأسرع من الممكن» لا «الأسرع قليلاً».
 */
const MIN_REAL_TIME_RATIO = 0.6;

/** الجلسات الجارية: معرّف اللاعب → جلسة. واحدة فقط لكل لاعب. */
const sessions = new Map();

// ---------------------------------------------------------------- العدالة
function fairState(player) {
  if (!player.tankFair || !player.tankFair.seed) {
    player.tankFair = { seed: newServerSeed(), nonce: 0, previous: null };
  }
  const f = player.tankFair;
  return {
    seedHash: sha256Hex(f.seed),
    nonce: f.nonce,
    previous: f.previous
      ? { seed: f.previous.seed, seedHash: sha256Hex(f.previous.seed), battles: f.previous.battles }
      : null
  };
}

function rotateSeed(player) {
  const f = player.tankFair || {};
  const revealed = f.seed || newServerSeed();
  const battles = f.nonce || 0;
  player.tankFair = { seed: newServerSeed(), nonce: 0, previous: { seed: revealed, battles } };
  return { revealed, seedHash: sha256Hex(revealed), battles, next: fairState(player) };
}

/** بذرة المعركة: تُكشف عند البدء لأن المتصفح يحتاجها ليرسم، وكشفها
 *  لنبضة واحدة لا يكشف البذرة الأمّ فتبقى المعارك القادمة مُلتزَماً بها. */
function battleSeed(player, nonce) {
  const f = player.tankFair;
  const client = f.clientSeed || '';
  return sha256Hex(`${f.seed}:${client}:t${nonce}`);
}

// ---------------------------------------------------------------- الوصف
function describeDifficulty(d) {
  return {
    key: d.key,
    name: d.name,
    order: d.order,
    enemies: d.enemies,
    maxAlive: d.maxAlive,
    armor: d.armor,
    payout: d.payout / 100,
    seconds: Math.round(d.timeLimit / T.TICK_HZ),
    measuredWinRate: d.measured,
    rtp: Number((d.measured * d.payout).toFixed(2))   // بالمئة
  };
}

function difficulties() {
  return Object.values(T.DIFFICULTY)
    .sort((a, b) => a.order - b.order)
    .map(describeDifficulty);
}

function publicConfig() {
  return {
    stakes: STAKES,
    maxStake: MAX_STAKE,
    difficulties: difficulties(),
    arena: { cols: T.COLS, rows: T.ROWS, tile: T.TILE, tickHz: T.TICK_HZ },
    tank: { size: T.TANK, speed: T.PLAYER_SPEED, maxShots: T.PLAYER_MAX_SHOTS }
  };
}

// ---------------------------------------------------------------- الحالة
function statsOf(player) {
  const st = player.tankStats || { battles: 0, wins: 0, wagered: 0, won: 0, best: 0, streak: 0, bestStreak: 0 };
  return {
    battles: st.battles, wins: st.wins, wagered: st.wagered, won: st.won,
    best: st.best, streak: st.streak, bestStreak: st.bestStreak,
    winRate: st.battles ? st.wins / st.battles : 0
  };
}

function stateFor(player) {
  const s = sessions.get(player.id);
  return {
    balance: player.balance,
    stakes: STAKES,
    active: s ? { bet: s.bet, difficulty: s.difficulty, seed: s.seed, nonce: s.nonce } : null,
    stats: statsOf(player),
    fair: fairState(player)
  };
}

// ---------------------------------------------------------------- البدء
function start(player, { bet, difficulty, clientSeed }) {
  if (sessions.has(player.id)) {
    return { error: 'لديك معركة جارية — أنهِها أولاً' };
  }
  const stake = Number(bet);
  if (!STAKES.includes(stake)) return { error: 'مبلغ غير متاح' };
  if (player.balance < stake) return { error: 'رصيدك لا يكفي' };

  const diff = T.DIFFICULTY[difficulty];
  if (!diff) return { error: 'مستوى صعوبة غير معروف' };

  fairState(player);
  const f = player.tankFair;
  if (typeof clientSeed === 'string' && clientSeed.trim()) {
    f.clientSeed = clientSeed.trim().slice(0, 64);
  }
  f.nonce += 1;

  const seed = battleSeed(player, f.nonce);
  // الخصم عند البدء لا عند النهاية: من يهجر معركة خاسرة لا يستعيد رهانه
  store.adjustBalance(player, -stake);

  const session = {
    playerId: player.id,
    bet: stake,
    difficulty: diff.key,
    seed,
    nonce: f.nonce,
    startedAt: Date.now(),
    expiresAt: Date.now() + (diff.timeLimit / T.TICK_HZ) * 1000 + GRACE_MS
  };
  sessions.set(player.id, session);

  return {
    ok: true,
    seed,
    nonce: f.nonce,
    bet: stake,
    balance: player.balance,
    difficulty: describeDifficulty(diff),
    fair: fairState(player)
  };
}

// --------------------------------------------------------------- الإنهاء
function validateInputs(inputs) {
  if (!Array.isArray(inputs)) return 'سجلّ الضغطات مفقود';
  if (inputs.length % 2 !== 0) return 'سجلّ الضغطات غير مكتمل';
  if (inputs.length > MAX_INPUT_NUMBERS) return 'سجلّ الضغطات أطول من المسموح';
  for (const n of inputs) {
    if (!Number.isInteger(n) || n < 0 || n > 100000) return 'سجلّ الضغطات يحوي قيمة غير صالحة';
  }
  return null;
}

function settle(player, session, { won, replay, rejected }) {
  const diff = T.DIFFICULTY[session.difficulty];
  const win = won ? Math.floor(session.bet * diff.payout / 100) : 0;
  if (win > 0) store.adjustBalance(player, win);

  store.recordTank(player, {
    bet: session.bet, win, difficulty: session.difficulty, won
  });
  sessions.delete(player.id);

  return {
    ok: true,
    won,
    win,
    bet: session.bet,
    multiplier: diff.payout / 100,
    balance: player.balance,
    reason: rejected ? 'rejected' : (replay ? replay.reason : 'abandoned'),
    rejected: rejected || null,
    killed: replay ? replay.killed : 0,
    total: diff.enemies,
    seed: session.seed,
    nonce: session.nonce,
    stats: statsOf(player),
    fair: fairState(player)
  };
}

function finish(player, { inputs }) {
  const session = sessions.get(player.id);
  if (!session) return { error: 'لا توجد معركة جارية' };

  const bad = validateInputs(inputs);
  // سجلّ فاسد = خسارة، لا خطأ يُعاد معه الرهان: وإلا صار إرسال سجلّ فاسد
  // طريقةً لإلغاء كل معركة خاسرة.
  if (bad) return settle(player, session, { won: false, rejected: bad });

  const replay = T.runReplay(session.seed, session.difficulty, inputs);
  if (!replay.valid) {
    return settle(player, session, { won: false, rejected: replay.error });
  }

  // فحص الزمن الحقيقي: معركة طولها 40 ثانية لا تصل نتيجتها بعد ثانيتين
  const elapsed = Date.now() - session.startedAt;
  const needed = (replay.ticks / T.TICK_HZ) * 1000 * MIN_REAL_TIME_RATIO;
  if (replay.won && elapsed < needed) {
    return settle(player, session, {
      won: false, replay,
      rejected: 'المعركة وصلت أسرع من الممكن لعبها'
    });
  }

  return settle(player, session, { won: replay.won, replay });
}

/** ينهي الجلسات المهجورة: من أغلق الصفحة وهو خاسر لا يترك رهانه معلّقاً. */
function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt > now) continue;
    const player = store.byId(id);
    if (player) settle(player, s, { won: false, replay: null });
    else sessions.delete(id);
  }
}

const sweeper = setInterval(sweep, 15_000);
if (sweeper.unref) sweeper.unref();

/** تفصيل الصعوبات كما وقع فعلاً — للوحة الإدارة. */
function difficultyReport(ledgerTank) {
  return difficulties().map((d) => {
    const seen = (ledgerTank && ledgerTank[d.key]) || { battles: 0, wins: 0, wagered: 0, paid: 0 };
    return {
      ...d,
      battles: seen.battles,
      wins: seen.wins,
      actualWinRate: seen.battles ? seen.wins / seen.battles : null,
      wagered: seen.wagered,
      paid: seen.paid,
      actualRtp: seen.wagered ? seen.paid / seen.wagered : null
    };
  });
}

module.exports = {
  MAX_STAKE, STAKES, MIN_REAL_TIME_RATIO,
  publicConfig, stateFor, start, finish, rotateSeed, fairState,
  difficulties, difficultyReport, sweep,
  activeCount: () => sessions.size
};
