'use strict';

const crypto = require('crypto');
const store = require('./store');
const rounds = require('./roundStore');

/**
 * LuckyArena — طريق الدجاجة (Chicken Road).
 *
 * الدجاجة تعبر 12 مساراً. قبل كل خطوة يقرّر الخادم وحده: تنجو باحتمال p
 * (حسب الصعوبة) أو تصدمها سيارة. بعد كل خطوة ناجحة يختار اللاعب: يكمل، أو
 * يجمع الرهان × مضاعف تلك الخطوة.
 *
 * الرياضيات: المضاعف بعد k خطوة = 0.96 ÷ p^k (مقرّباً لأسفل لخانتين). فأياً
 * كانت الخطوة التي يجمع عندها اللاعب — وأياً كانت استراتيجيته — العائد
 * المتوقّع p^k × 0.96/p^k = 96% بالضبط (أقلّ قليلاً بعد التقريب لأسفل).
 * لا توجد نقطة جمع ولا صعوبة يربح عندها اللاعب على المدى، والموقع يربح 4%.
 * (النسخة الأصلية كانت تقرّر في المتصفح، ونسبتها في «سهل» فوق 100%.)
 *
 * لا يُرسل للواجهة إلا المضاعفات — لا احتمالات ولا نسب عائد (طلب المالك).
 * الجولة محفوظة في roundStore (القاعدة) فلا تضيع بين نسخ الخادم.
 */

const STEPS = 12;
const RTP = 0.96;
const MIN_STAKE = 100;
const MAX_STAKE = 500000;
/** جولة متروكة: بعدها تُحسم تلقائياً (تُجمع إن كانت فيها خطوة ناجحة). */
const ROUND_TTL_MS = 30 * 60 * 1000;

const DIFFICULTIES = {
  easy:   { label: 'سهل',  p: 0.90 },
  normal: { label: 'قياسي', p: 0.80 },
  hard:   { label: 'تحدي', p: 0.70 }
};

/** مضاعفات الخطوات 1..12 لصعوبة: floor2(RTP / p^k). */
function ladderFor(p) {
  return Array.from({ length: STEPS }, (_, i) => Math.floor((RTP / p ** (i + 1)) * 100) / 100);
}
const LADDERS = Object.fromEntries(Object.entries(DIFFICULTIES).map(([k, d]) => [k, ladderFor(d.p)]));

/** u منتظم في [0,1) من مولّد التشفير (53 بت). */
function randomUnit() {
  const b = crypto.randomBytes(8);
  return (b.readUInt32BE(0) * 2 ** 21 + (b.readUInt32BE(4) >>> 11)) / 2 ** 53;
}

const keyOf = (player) => `round:chicken:${player.id}`;
const multAt = (diff, step) => (step > 0 ? LADDERS[diff][step - 1] : 1);
const payout = (bet, diff, step) => Math.floor(bet * multAt(diff, step));

function publicRound(r) {
  if (!r) return null;
  return {
    id: r.id,
    bet: r.bet,
    difficulty: r.diff,
    step: r.step,
    multiplier: multAt(r.diff, r.step),
    prize: r.step > 0 ? payout(r.bet, r.diff, r.step) : 0,
    next: r.step < STEPS ? LADDERS[r.diff][r.step] : null
  };
}

function record(player, r, win) {
  store.recordChicken(player, {
    bet: r.bet, win, multiplier: win > 0 ? win / r.bet : 0, difficulty: r.diff, steps: r.step
  });
}

/** يجمع جولة بعد «حجزها» (status=paid) — الحجز يمنع الدفع مرّتين. */
async function settlePaid(player, r) {
  const win = payout(r.bet, r.diff, r.step);
  if (win > 0) await store.gameCredit('chicken', player, win, `chicken-${r.id}-win`);
  record(player, r, win);
  return win;
}

/**
 * يُكمل جولة محجوزة (paid = جمع، refund = إرجاع الرهان) ثم يحذفها.
 * يُستعمل حين تسقط نسخة خادم بعد الحجز وقبل الإكمال.
 */
async function finishClaimed(player, found) {
  const r = found.value;
  if (r.status === 'paid') await settlePaid(player, r);
  else if (r.status === 'refund') await store.gameCredit('chicken', player, r.bet, `chicken-${r.id}-refund`);
  await rounds.remove(keyOf(player), found.tag);
}

/**
 * جولة متروكة أكثر من ROUND_TTL_MS: فيها خطوة ناجحة ← تُجمع للاعب؛ بلا
 * خطوات ← يُعاد رهانه (لم يخاطر بشيء). لا يخسر لاعب مالاً لأنه ابتعد.
 */
async function resolveStale(player, found) {
  const r = found.value;
  if (r.status !== 'alive') return finishClaimed(player, found);
  const claimed = { ...r, status: r.step > 0 ? 'paid' : 'refund', v: r.v + 1 };
  const tag = await rounds.swap(keyOf(player), found.tag, claimed);
  if (!tag) return;
  await finishClaimed(player, { value: claimed, tag });
}

async function current(player) {
  const found = await rounds.get(keyOf(player));
  if (!found) return null;
  if (Date.now() - found.value.at > ROUND_TTL_MS) {
    await resolveStale(player, found);
    return null;
  }
  return found;
}

// ─────────────────────────────────────────────────────────────── الخطوات
async function start(player, { bet, difficulty }) {
  if (!player) return { ok: false, error: 'سجّل الدخول للّعب', needsLogin: true };
  const diff = DIFFICULTIES[difficulty] ? difficulty : 'normal';
  const stake = Math.floor(Number(bet) || 0);
  if (stake < MIN_STAKE) return { ok: false, error: `الحد الأدنى للرهان ${MIN_STAKE.toLocaleString('en-US')}` };
  if (stake > MAX_STAKE) return { ok: false, error: `الحد الأقصى للرهان ${MAX_STAKE.toLocaleString('en-US')}` };
  if ((Number(player.balance) || 0) < stake) return { ok: false, error: 'رصيدك لا يكفي لهذا الرهان' };

  const existing = await current(player);
  if (existing) {
    if (existing.value.status === 'alive') {
      return { ok: false, error: 'لديك جولة جارية', round: publicRound(existing.value) };
    }
    // جولة عالقة في منتصف حسمها (نسخة سقطت بعد الحجز): تُكمَل الآن
    await finishClaimed(player, existing);
  }

  // المقعد أولاً ثم المال: لو فشل الخصم تُحذف الجولة ولم يُخصم شيء
  const r = { id: crypto.randomBytes(8).toString('hex'), bet: stake, diff, step: 0, status: 'alive', at: Date.now(), v: 0 };
  const tag = await rounds.create(keyOf(player), r);
  if (!tag) {
    return { ok: false, error: 'لديك جولة جارية — حدّث الصفحة' };
  }
  if (!(await store.gameDebit('chicken', player, stake, `chicken-${r.id}-bet`))) {
    await rounds.remove(keyOf(player), tag).catch(() => {});
    return { ok: false, error: 'تعذّر خصم الرهان — لم يُحتسب شيء' };
  }
  return { ok: true, round: publicRound(r), balance: player.balance };
}

async function cross(player) {
  if (!player) return { ok: false, error: 'سجّل الدخول للّعب', needsLogin: true };
  const found = await current(player);
  if (!found || found.value.status !== 'alive') return { ok: false, error: 'لا توجد جولة جارية', noRound: true };
  const r = found.value;
  if (r.step >= STEPS) return { ok: false, error: 'عبرت كل المسارات' };

  const safe = randomUnit() < DIFFICULTIES[r.diff].p;
  const lane = r.step + 1;

  if (!safe) {
    const dead = { ...r, status: 'dead', v: r.v + 1 };
    const tag = await rounds.swap(keyOf(player), found.tag, dead);
    if (!tag) return { ok: false, error: 'حاول مرّة أخرى', retry: true };
    record(player, r, 0);
    await rounds.remove(keyOf(player), tag).catch(() => {});
    return { ok: true, safe: false, lane, round: null, balance: player.balance };
  }

  const next = { ...r, step: lane, v: r.v + 1 };
  if (lane === STEPS) {
    // آخر مسار: تُجمع تلقائياً
    const claimed = { ...next, status: 'paid' };
    const tag = await rounds.swap(keyOf(player), found.tag, claimed);
    if (!tag) return { ok: false, error: 'حاول مرّة أخرى', retry: true };
    const win = await settlePaid(player, next);
    await rounds.remove(keyOf(player), tag).catch(() => {});
    return {
      ok: true, safe: true, lane, finished: true, win,
      multiplier: multAt(next.diff, lane), round: null, balance: player.balance
    };
  }
  if (!(await rounds.swap(keyOf(player), found.tag, next))) return { ok: false, error: 'حاول مرّة أخرى', retry: true };
  return { ok: true, safe: true, lane, round: publicRound(next), balance: player.balance };
}

async function cashOut(player) {
  if (!player) return { ok: false, error: 'سجّل الدخول للّعب', needsLogin: true };
  const found = await current(player);
  if (!found || found.value.status !== 'alive') return { ok: false, error: 'لا توجد جولة جارية', noRound: true };
  const r = found.value;
  if (r.step < 1) return { ok: false, error: 'اعبر خطوة واحدة على الأقل قبل الجمع' };

  const claimed = { ...r, status: 'paid', v: r.v + 1 };
  const tag = await rounds.swap(keyOf(player), found.tag, claimed);
  if (!tag) return { ok: false, error: 'حاول مرّة أخرى', retry: true };
  const win = await settlePaid(player, r);
  await rounds.remove(keyOf(player), tag).catch(() => {});
  return { ok: true, win, step: r.step, multiplier: multAt(r.diff, r.step), balance: player.balance };
}

/** الوضع التجريبي: نتيجة خطوة بلا مال ولا جولة — الاحتمال يبقى في الخادم. */
function demoStep(difficulty) {
  const diff = DIFFICULTIES[difficulty] ? difficulty : 'normal';
  return { ok: true, safe: randomUnit() < DIFFICULTIES[diff].p };
}

async function stateFor(player) {
  const base = {
    minStake: MIN_STAKE,
    maxStake: MAX_STAKE,
    steps: STEPS,
    ladders: LADDERS,
    difficulties: Object.fromEntries(Object.entries(DIFFICULTIES).map(([k, d]) => [k, d.label]))
  };
  if (!player) return { loggedIn: false, balance: 0, currency: 'IQD', round: null, ...base };
  const found = await current(player).catch(() => null);
  return {
    loggedIn: true,
    balance: player.balance,
    currency: player.currency || 'IQD',
    username: player.username || null,
    round: found && found.value.status === 'alive' ? publicRound(found.value) : null,
    ...base
  };
}

/** العائد النظري لكل نقطة جمع (للإدارة والاختبار): p^k × المضاعف. */
function rtpAt(diff, step) {
  return DIFFICULTIES[diff].p ** step * multAt(diff, step);
}

module.exports = {
  STEPS, RTP, MIN_STAKE, MAX_STAKE, ROUND_TTL_MS, DIFFICULTIES, LADDERS,
  ladderFor, rtpAt, randomUnit, start, cross, cashOut, demoStep, stateFor, publicRound, _keyOf: keyOf
};
