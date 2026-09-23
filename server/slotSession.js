'use strict';

const crypto = require('crypto');
const store = require('./store');
const slots = require('./slots');
const { sha256Hex } = require('./rng');
const { STAKES } = require('./config');

/**
 * جلسات السلوتس: المحفظة، الدورات المجانية، والعدالة المثبتة.
 *
 * العدالة هنا بنظام الالتزام والكشف (commit–reveal):
 *   - لكل لاعب بذرة خادم سرّية، تُنشر بصمتها SHA-256 فقط.
 *   - كل دورة تستعمل البذرة + رقم متسلسل (nonce) لا يتكرر.
 *   - عند طلب اللاعب تُكشف البذرة القديمة وتُولَّد جديدة، فيستطيع إعادة
 *     حساب كل دورة سابقة والتأكد أنها لم تُغيَّر بعد الرهان.
 *
 * كل حساب يجري هنا. المتصفح لا يقرر شيئاً.
 */

/** @type {Map<string, object>} playerId -> جلسة الميزة الجارية */
const activeFeatures = new Map();

// ---------------------------------------------------------------------------
// العدالة المثبتة
// ---------------------------------------------------------------------------
function newSeed() { return crypto.randomBytes(32).toString('hex'); }

/** يضمن وجود بذرة للاعب ويرجّع حالتها العامة. */
function fairState(player) {
  if (!player.slotFair || !player.slotFair.seed) {
    player.slotFair = { seed: newSeed(), nonce: 0, previous: null };
  }
  const f = player.slotFair;
  return {
    seedHash: sha256Hex(f.seed),
    nonce: f.nonce,
    previous: f.previous
      ? { seed: f.previous.seed, seedHash: sha256Hex(f.previous.seed), spins: f.previous.spins }
      : null
  };
}

/** يكشف البذرة الحالية ويبدأ بذرة جديدة — بعدها يمكن التحقق من كل دورة سابقة. */
function rotateSeed(player) {
  const f = player.slotFair || {};
  const revealed = f.seed || newSeed();
  const spins = f.nonce || 0;
  player.slotFair = {
    seed: newSeed(),
    nonce: 0,
    previous: { seed: revealed, spins }
  };
  return { revealed, seedHash: sha256Hex(revealed), spins, next: fairState(player) };
}

// ---------------------------------------------------------------------------
// أدوات
// ---------------------------------------------------------------------------
/** المبالغ المسموحة في السلوتس: سلّم الموقع حتى الحدّ الأقصى للسلوتس. */
const SLOT_STAKES = STAKES.filter((s) => s <= slots.MAX_STAKE);

function validBet(bet) {
  return SLOT_STAKES.includes(Number(bet));
}

function publicFeature(f) {
  if (!f) return null;
  return {
    active: true,
    bet: f.bet,
    spinsLeft: f.spinsLeft,
    spinsUsed: f.spinsUsed,
    spinsGranted: f.spinsGranted,
    multiplier: f.multiplier,
    totalWin: f.totalWin,
    bought: f.bought
  };
}

// ---------------------------------------------------------------------------
// الدورة
// ---------------------------------------------------------------------------

/**
 * دورة واحدة. إن كانت هناك ميزة جارية فهي دورة مجانية (بلا خصم)،
 * وإلا فدورة أساسية تُخصم من الرصيد.
 */
async function spin(player, bet) {
  const feature = activeFeatures.get(player.id) || null;

  if (feature) return await freeSpin(player, feature);
  return await baseSpin(player, Number(bet));
}

async function baseSpin(player, bet) {
  if (!validBet(bet)) return { ok: false, error: 'مبلغ غير مسموح' };
  if (player.balance < bet) return { ok: false, error: 'رصيدك لا يكفي لهذا الرهان' };

  fairState(player);
  const f = player.slotFair;
  f.nonce += 1;
  const nonce = `s${f.nonce}`;

  const txRef = 'slot-spin-' + player.id + '-' + Date.now();
  if (!(await store.gameDebit('slots', player, bet, txRef))) return { ok: false, error: 'تعذّر خصم الرهان (رصيد غير كافٍ أو خطأ بالاتصال)' };

  const result = slots.playSpin({ seedHex: f.seed, nonce, bet, free: false, multiplier: 1 });
  const win = result.win;
  if (win > 0) {
    const txRefWin = 'slot-win-' + player.id + '-' + Date.now();
    await store.gameCredit('slots', player, win, txRefWin);
  }

  // هل فتحت هذه الدورة الميزة؟
  let opened = null;
  const granted = slots.freeSpinsFor(result.scatters);
  if (granted > 0) {
    opened = startFeature(player, bet, granted, false);
  }

  store.recordSlot(player, { bet, win, free: false });

  return {
    ok: true,
    nonce,
    grid: result.grid,
    lines: result.lines,
    scatters: result.scatters,
    scatterCells: result.scatterCells,
    win,
    bet,
    multiplier: 1,
    balance: player.balance,
    feature: publicFeature(opened),
    fair: fairState(player)
  };
}

async function freeSpin(player, feature) {
  const bet = feature.bet;
  fairState(player);
  const f = player.slotFair;
  f.nonce += 1;
  const nonce = `s${f.nonce}`;

  // لا سقف على المضاعف: نسبة العائد واحدة عند كل مبلغ.
  // حماية الموقع من سقف الرهان وسقفَي الدورة والجلسة، لا من تشويه المضاعف.
  const mult = feature.multiplier;
  const result = slots.playSpin({ seedHex: f.seed, nonce, bet, free: true, multiplier: mult });

  // سقف الجلسة: لا يُصرف أكثر مما تبقّى تحت السقف
  const room = Math.max(0, slots.MAX_SESSION_MULTIPLIER * bet - feature.totalWin);
  const win = Math.min(result.win, room);

  feature.spinsLeft -= 1;
  feature.spinsUsed += 1;
  feature.totalWin += win;
  if (win > 0) {
    const txRefWin = 'slot-win-free-' + player.id + '-' + Date.now();
    await store.gameCredit('slots', player, win, txRefWin);
  }

  // العدّاد: يتقدّم مع الربح، ويعود إلى ×1 عند الخسارة
  feature.multiplier = slots.stepMultiplier(feature.multiplier, win);

  // سكاتر داخل الميزة يمنح دورات إضافية (ضمن السقف)
  let retrigger = 0;
  if (result.scatters >= 3 && feature.spinsGranted < slots.FREE_SPINS.maxTotal) {
    retrigger = Math.min(slots.FREE_SPINS.retrigger, slots.FREE_SPINS.maxTotal - feature.spinsGranted);
    feature.spinsLeft += retrigger;
    feature.spinsGranted += retrigger;
  }

  store.recordSlot(player, { bet, win, free: true });

  const capReached = feature.totalWin >= slots.MAX_SESSION_MULTIPLIER * bet;
  let summary = null;
  if (feature.spinsLeft <= 0 || capReached) {
    summary = {
      totalWin: feature.totalWin,
      spins: feature.spinsUsed,
      bought: feature.bought,
      capped: capReached
    };
    activeFeatures.delete(player.id);
  }

  return {
    ok: true,
    nonce,
    grid: result.grid,
    lines: result.lines,
    scatters: result.scatters,
    scatterCells: result.scatterCells,
    win,
    bet,
    multiplier: mult,
    retrigger,
    balance: player.balance,
    feature: summary ? null : publicFeature(feature),
    featureEnded: summary,
    fair: fairState(player)
  };
}

function startFeature(player, bet, spins, bought) {
  const feature = {
    bet,
    spinsLeft: spins,
    spinsUsed: 0,
    spinsGranted: spins,
    multiplier: 1,
    totalWin: 0,
    bought,
    startedAt: Date.now()
  };
  activeFeatures.set(player.id, feature);
  return feature;
}

/** شراء الميزة بسعر ثابت من الرهان. */
async function buyFeature(player, bet) {
  if (activeFeatures.has(player.id)) return { ok: false, error: 'لديك ميزة جارية بالفعل' };
  if (!validBet(bet)) return { ok: false, error: 'مبلغ غير مسموح' };

  const cost = bet * slots.FEATURE_BUY_COST;
  if (player.balance < cost) {
    return { ok: false, error: `شراء الميزة يكلّف ${cost.toLocaleString('en-US')} — رصيدك لا يكفي` };
  }
  const txRef = 'slot-buy-' + player.id + '-' + Date.now();
  if (!(await store.gameDebit('slots', player, cost, txRef))) return { ok: false, error: 'تعذّر خصم السعر' };

  store.recordSlot(player, { bet: cost, win: 0, free: false, buy: true });
  const feature = startFeature(player, Number(bet), slots.FREE_SPINS.base, true);

  return {
    ok: true,
    cost,
    balance: player.balance,
    feature: publicFeature(feature),
    fair: fairState(player)
  };
}

/** الحالة الحالية للاعب — تُستدعى عند فتح الصفحة. */
function stateFor(player) {
  return {
    balance: player.balance,
    feature: publicFeature(activeFeatures.get(player.id) || null),
    fair: fairState(player),
    stats: player.slotStats || null
  };
}

module.exports = {
  spin, buyFeature, stateFor, rotateSeed, fairState,
  activeFeatures, validBet, SLOT_STAKES
};
