'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * LuckyArena — بولزآي X (Bullseye X): قرص دوّار وسهم.
 *
 * النتيجة زاوية منتظمة على القرص تُسحب في الخادم (crypto، 53 بت):
 *   u منتظم في [0, 1) ← الزاوية = u × 360° مع عقارب الساعة من بداية القطاع
 *   الأول (أعلى القرص)، والقطاع = ما تقع فيه الزاوية.
 *
 * حجم كل قطاع على الشاشة = احتماله بالضبط، فلا قطاع يبدو أكبر من حظّه.
 * المتصفح لا يقرّر شيئاً — يرسم الزاوية التي يرسلها الخادم فقط، ولا يستلم
 * أي نسب أو بذور (طلب المالك: لا معلومات عن الاحتمالات في الواجهة).
 *
 * العائد لكل وضع 96% بالضبط: Σ(الوزن × المضاعف) ÷ Σ(الأوزان) — يفحصه
 * test/bullseye.test.js. المبالغ تُقرَّب لأسفل، فالفعلي ≤ 96% دائماً.
 *
 *   كلاسيك    : حتى ×25، يربح 43.5% من الرميات.
 *   المخاطرة  : حتى ×50، يربح 22.8% — وبعد الربح «ضاعف أو اخسر» (48% ×2).
 *   مزدوج     : سهمان على قرص الكلاسيك، كلٌّ بنصف الرهان — تذبذب أقل.
 *
 * الربح يُضاف للمحفظة فور الرمية. «المخاطرة مجدداً» رهان جديد بمبلغ ذلك
 * الربح بالضبط، فلا مال معلّق في الذاكرة: لو ضاعت الجلسة بقي الربح في الرصيد.
 */

const MIN_STAKE = 100;
const MAX_STAKE = 500000;
/** أقصى مبلغ يُخاطَر به في «ضاعف أو اخسر» (سقف الدفعة ×2 = 4,000,000). */
const GAMBLE_MAX_STAKE = 2000000;
/** عدد المضاعفات المتتالية المسموح بها بعد ربح واحد. */
const MAX_GAMBLES = 5;
/** فرصة المخاطرة تنتهي إن لم تُستعمل خلال هذه المدّة (الربح باقٍ في الرصيد). */
const GAMBLE_TTL_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────── الأقراص
// القطاعات بترتيبها مع عقارب الساعة بدءاً من أعلى القرص. w = الوزن (الاحتمال).
const z = (w) => ({ m: 0, w });
const WHEELS = {
  // المجموع 1000 · Σ w×m = 960
  classic: [
    z(81), { m: 1.5, w: 50 }, { m: 2, w: 50 }, z(81), { m: 3, w: 30 }, z(81),
    { m: 1.5, w: 50 }, { m: 5, w: 20 }, z(81), { m: 10, w: 3 }, { m: 25, w: 2 },
    z(81), { m: 2, w: 50 }, { m: 1.5, w: 50 }, z(80), { m: 3, w: 30 },
    { m: 2, w: 50 }, z(80), { m: 1.5, w: 50 }
  ],
  // المجموع 10000 · Σ w×m = 9600
  risk: [
    z(1288), { m: 2, w: 500 }, { m: 5, w: 300 }, z(1287), { m: 15, w: 75 },
    { m: 2, w: 500 }, z(1287), { m: 50, w: 27 }, z(1287), { m: 5, w: 300 },
    z(1287), { m: 2, w: 500 }, z(1287), { m: 15, w: 75 }
  ],
  // ضاعف أو اخسر: 48% ×2 · المجموع 10000 · Σ w×m = 9600
  gamble: [
    { m: 2, w: 1200 }, z(1300), { m: 2, w: 1200 }, z(1300),
    { m: 2, w: 1200 }, z(1300), { m: 2, w: 1200 }, z(1300)
  ]
};

const MODES = {
  classic: { wheel: 'classic', arrows: 1, label: 'كلاسيك' },
  risk:    { wheel: 'risk',    arrows: 1, label: 'المخاطرة' },
  double:  { wheel: 'classic', arrows: 2, label: 'السهم المزدوج' }
};

const totalWeight = (wheel) => wheel.reduce((a, s) => a + s.w, 0);

/** العائد النظري للقرص (0..1): Σ w×m ÷ Σ w. */
function wheelRtp(wheel) {
  return wheel.reduce((a, s) => a + s.w * s.m, 0) / totalWeight(wheel);
}

/** نسبة الرميات الرابحة (مضاعف > 0). */
function wheelHitRate(wheel) {
  return wheel.reduce((a, s) => a + (s.m > 0 ? s.w : 0), 0) / totalWeight(wheel);
}

// ─────────────────────────────────────────────────────── السحب
/** u منتظم في [0, 1) بدقّة 53 بت من مولّد التشفير. */
function randomUnit() {
  const b = crypto.randomBytes(8);
  return (b.readUInt32BE(0) * 2 ** 21 + (b.readUInt32BE(4) >>> 11)) / 2 ** 53;
}

/** الزاوية → القطاع. حدود القطاع i: [Σ ما قبله, Σ ما قبله + w_i) بوحدات الوزن. */
function sliceAt(wheel, u) {
  const pos = u * totalWeight(wheel);
  let acc = 0;
  for (let i = 0; i < wheel.length; i++) {
    acc += wheel[i].w;
    if (pos < acc) return i;
  }
  return wheel.length - 1;
}

/** سهم واحد: u (منتظم في [0,1)) ← الزاوية والقطاع. */
function landArrow(wheelKey, u = randomUnit()) {
  const wheel = WHEELS[wheelKey];
  const slice = sliceAt(wheel, u);
  return { angle: Number((u * 360).toFixed(6)), slice, multiplier: wheel[slice].m };
}

// ─────────────────────────────────────────────────────── فرص المخاطرة
/** playerId → { amount, step, at } — آخر ربح يحقّ للاعب أن يخاطر به. */
const gambles = new Map();

function gambleOffer(player) {
  const g = gambles.get(player.id);
  if (!g) return { available: false };
  if (Date.now() - g.at > GAMBLE_TTL_MS || g.step >= MAX_GAMBLES || g.amount > GAMBLE_MAX_STAKE) {
    gambles.delete(player.id);
    return { available: false };
  }
  return { available: true, amount: g.amount, step: g.step, max: MAX_GAMBLES };
}

// ─────────────────────────────────────────────────────────── اللعب
async function throwArrow(player, { mode, bet }) {
  if (!player) return { ok: false, error: 'سجّل الدخول للّعب', needsLogin: true };
  const cfg = MODES[mode];
  if (!cfg) return { ok: false, error: 'وضع لعب غير معروف' };

  const stake = Math.floor(Number(bet) || 0);
  if (stake < MIN_STAKE) return { ok: false, error: `الحد الأدنى للرهان ${MIN_STAKE.toLocaleString('en-US')}` };
  if (stake > MAX_STAKE) return { ok: false, error: `الحد الأقصى للرهان ${MAX_STAKE.toLocaleString('en-US')}` };
  if ((Number(player.balance) || 0) < stake) return { ok: false, error: 'رصيدك لا يكفي لهذا الرهان' };

  // أي رمية جديدة تُسقط فرصة المخاطرة السابقة — ربحها في الرصيد أصلاً
  gambles.delete(player.id);

  const txRef = `bullseye-${mode}-${player.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  if (!(await store.gameDebit('bullseye', player, stake, txRef))) {
    return { ok: false, error: 'تعذّر خصم الرهان — لم يُحتسب شيء' };
  }

  const arrows = [];
  for (let a = 0; a < cfg.arrows; a++) arrows.push(landArrow(cfg.wheel));

  // كل سهم يحمل رهان/عدد الأسهم؛ المجموع يُقرَّب لأسفل مرّة واحدة
  const sumMult = arrows.reduce((a, x) => a + x.multiplier, 0);
  const win = Math.floor(stake * sumMult / cfg.arrows);
  if (win > 0) await store.gameCredit('bullseye', player, win, `${txRef}-win`);

  store.recordBullseye(player, { bet: stake, win, multiplier: win / stake, mode });

  if (mode === 'risk' && win > 0 && win <= GAMBLE_MAX_STAKE) {
    gambles.set(player.id, { amount: win, step: 0, at: Date.now() });
  }

  return {
    ok: true,
    mode,
    bet: stake,
    arrows,
    multiplier: Number((win / stake).toFixed(4)),
    win,
    profit: win - stake,
    balance: player.balance,
    gamble: gambleOffer(player)
  };
}

/** «المخاطرة مجدداً»: رهان بمبلغ آخر ربح بالضبط على قرص ضاعف أو اخسر. */
async function gamble(player, { amount }) {
  if (!player) return { ok: false, error: 'سجّل الدخول للّعب', needsLogin: true };
  const offer = gambleOffer(player);
  if (!offer.available) return { ok: false, error: 'انتهت فرصة المخاطرة — ربحك محفوظ في رصيدك' };
  const stake = Math.floor(Number(amount) || 0);
  if (stake !== offer.amount) return { ok: false, error: 'مبلغ المخاطرة لا يطابق ربحك الأخير' };
  if ((Number(player.balance) || 0) < stake) return { ok: false, error: 'رصيدك لا يغطي مبلغ المخاطرة' };

  // يُحذف قبل أي انتظار: طلبان متزامنان لا يخاطران بالربح نفسه مرّتين
  const entry = gambles.get(player.id);
  gambles.delete(player.id);

  const txRef = `bullseye-gamble-${player.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  if (!(await store.gameDebit('bullseye', player, stake, txRef))) {
    gambles.set(player.id, entry);   // لم يُخصم شيء — تبقى الفرصة
    return { ok: false, error: 'تعذّر خصم مبلغ المخاطرة — لم يُحتسب شيء' };
  }

  const arrow = landArrow('gamble');
  const win = Math.floor(stake * arrow.multiplier);
  if (win > 0) await store.gameCredit('bullseye', player, win, `${txRef}-win`);

  store.recordBullseye(player, { bet: stake, win, multiplier: arrow.multiplier, mode: 'gamble' });

  const step = entry.step + 1;
  if (win > 0 && step < MAX_GAMBLES && win <= GAMBLE_MAX_STAKE) {
    gambles.set(player.id, { amount: win, step, at: Date.now() });
  }

  return {
    ok: true,
    mode: 'gamble',
    bet: stake,
    arrows: [arrow],
    multiplier: arrow.multiplier,
    win,
    profit: win - stake,
    step,
    balance: player.balance,
    gamble: gambleOffer(player)
  };
}

/** «سحب الأرباح»: يغلق فرصة المخاطرة (الربح في الرصيد منذ الرمية). */
function collect(player) {
  if (player) gambles.delete(player.id);
  return { ok: true };
}

const RTP = {
  classic: wheelRtp(WHEELS.classic),
  risk: wheelRtp(WHEELS.risk),
  double: wheelRtp(WHEELS.classic),
  gamble: wheelRtp(WHEELS.gamble)
};

function publicWheels() {
  const out = {};
  for (const [k, wheel] of Object.entries(WHEELS)) out[k] = wheel.map((s) => ({ m: s.m, w: s.w }));
  return out;
}

function stateFor(player) {
  const base = {
    minStake: MIN_STAKE,
    maxStake: MAX_STAKE,
    gambleMaxStake: GAMBLE_MAX_STAKE,
    maxGambles: MAX_GAMBLES,
    wheels: publicWheels(),
    modes: Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, { wheel: m.wheel, arrows: m.arrows, label: m.label }]))
  };
  if (!player) return { loggedIn: false, active: true, balance: 0, currency: 'IQD', ...base };
  return {
    loggedIn: true,
    active: true,
    balance: player.balance,
    currency: player.currency || 'IQD',
    username: player.username || null,
    gamble: gambleOffer(player),
    ...base
  };
}

module.exports = {
  MIN_STAKE, MAX_STAKE, GAMBLE_MAX_STAKE, MAX_GAMBLES, WHEELS, MODES, RTP,
  wheelRtp, wheelHitRate, randomUnit, sliceAt, landArrow,
  throwArrow, gamble, collect, stateFor,
  _gambles: gambles
};
