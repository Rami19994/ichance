'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * محرك لعبة مناجم الحظ الأصلية (Stake Mines Clone)
 * شبكة 5×5 (25 مربعاً) مع إمكانية اختيار من 1 إلى 24 لغماً
 *
 * الأمان والعدالة والرياضيات:
 * - حساب النتيجة بالكامل على الخادم (Server-Side).
 * - مبدأ العدالة المثبتة (Provably Fair) مع تجزئة SHA-256 قبل بدء اللعب وبذور قابلة للتحقق.
 * - نسبة العائد (RTP) مضبوطة عند 97% مع هامش ربح للموقع 3.0% ثابت ومستدام.
 * - حجز الرهان فوري وصرف الفوز ذري عبر store.adjustBalance وتسجيل الأرباح في الدفتر المالي.
 */

const TOTAL_TILES = 25;
const MIN_MINES = 1;
const MAX_MINES = 24;
const DEFAULT_RTP = 0.97;
const MIN_STAKE = 100;
const MAX_STAKE = 1000000;

// الجلسات النشطة للاعبين: playerId -> session
const activeSessions = new Map();

/**
 * حساب المضاعف العادل بدقة متطابقة مع Stake
 */
function calculateMultiplier(minesCount, revealedCount, rtp = DEFAULT_RTP) {
  if (revealedCount <= 0) return 1.0;
  let multiplier = 1.0;
  for (let i = 0; i < revealedCount; i++) {
    multiplier *= (TOTAL_TILES - i) / (TOTAL_TILES - minesCount - i);
  }
  const result = multiplier * rtp;
  // تقريب المضاعف لرقمين عشريين أو أربعة للأرقام الحساسة
  return Number(result.toFixed(2));
}

/**
 * توليد مواقع الألغام بشكل عادل ومثبت رياضياً (Fisher-Yates Shuffle)
 */
function generateMinePositions(serverSeed, clientSeed, nonce, minesCount) {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  const tiles = Array.from({ length: TOTAL_TILES }, (_, i) => i);
  let hashIndex = 0;

  for (let i = TOTAL_TILES - 1; i > 0; i--) {
    if (hashIndex + 4 > hash.length) {
      hashIndex = 0;
    }
    const sub = hash.substr(hashIndex, 4);
    const randVal = parseInt(sub, 16);
    hashIndex += 4;
    const j = randVal % (i + 1);
    const tmp = tiles[i];
    tiles[i] = tiles[j];
    tiles[j] = tmp;
  }

  // أول minesCount من المصفوفة هي الألغام
  return new Set(tiles.slice(0, minesCount));
}

/**
 * بدء لعبة ألغام جديدة
 */
function startGame(player, { bet, minesCount = 3, clientSeed = null }) {
  if (!player) return { ok: false, error: 'غير مصرح' };

  // إذا كان هناك جلسة نشطة بالفعل
  if (activeSessions.has(player.id)) {
    return { ok: false, error: 'لديك جولة ألغام جارية بالفعل، أنهها أولاً أو اسحب أرباحك' };
  }

  const cleanBet = Math.floor(Number(bet) || 0);
  if (cleanBet < MIN_STAKE) {
    return { ok: false, error: `الحد الأدنى للرهان هو ${MIN_STAKE}` };
  }
  if (cleanBet > MAX_STAKE) {
    return { ok: false, error: `الحد الأقصى للرهان هو ${MAX_STAKE.toLocaleString()}` };
  }
  if (player.balance < cleanBet) {
    return { ok: false, error: 'رصيدك لا يكفي لإتمام هذا الرهان' };
  }

  const cleanMines = Math.max(MIN_MINES, Math.min(MAX_MINES, Math.floor(Number(minesCount) || 3)));
  const gemsCount = TOTAL_TILES - cleanMines;

  // توليد البذور والمفاتيح
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const cSeed = String(clientSeed || crypto.randomBytes(12).toString('hex')).trim();
  const nonce = (player.stats?.rounds || 0) + 1;

  const minePositions = generateMinePositions(serverSeed, cSeed, nonce, cleanMines);

  // خصم الرهان فوراً من رصيد اللاعب
  if (!store.adjustBalance(player, -cleanBet)) {
    return { ok: false, error: 'تعذّر خصم الرهان' };
  }

  const session = {
    playerId: player.id,
    bet: cleanBet,
    minesCount: cleanMines,
    gemsCount,
    serverSeed,
    seedHash,
    clientSeed: cSeed,
    nonce,
    minePositions,
    revealedTiles: [],
    currentMultiplier: 1.0,
    nextMultiplier: calculateMultiplier(cleanMines, 1),
    startedAt: Date.now(),
    status: 'active'
  };

  activeSessions.set(player.id, session);

  return {
    ok: true,
    active: true,
    bet: cleanBet,
    minesCount: cleanMines,
    gemsCount,
    seedHash,
    clientSeed: cSeed,
    nonce,
    revealedTiles: [],
    currentMultiplier: 1.0,
    nextMultiplier: session.nextMultiplier,
    balance: player.balance
  };
}

/**
 * كشف مربع في الشبكة
 */
function revealTile(player, tileIndex) {
  if (!player) return { ok: false, error: 'غير مصرح' };

  const session = activeSessions.get(player.id);
  if (!session || session.status !== 'active') {
    return { ok: false, error: 'لا توجد جولة نشطة حالياً' };
  }

  const idx = Math.floor(Number(tileIndex));
  if (idx < 0 || idx >= TOTAL_TILES) {
    return { ok: false, error: 'موضع المربع غير صالح' };
  }

  if (session.revealedTiles.includes(idx)) {
    return { ok: false, error: 'تم كشف هذا المربع مسبقاً' };
  }

  // هل أصاب لغماً؟ (انفجار وخسارة)
  if (session.minePositions.has(idx)) {
    session.status = 'exploded';
    activeSessions.delete(player.id);

    // تسجيل الخسارة في دفتر أرباح الموقع
    store.recordLedger({
      real: { wagered: session.bet, paid: 0, bets: 1 },
      bot: null,
      game: 'mines'
    });

    const allMines = Array.from(session.minePositions);

    return {
      ok: true,
      hitMine: true,
      explodedTile: idx,
      mines: allMines,
      revealedTiles: session.revealedTiles,
      serverSeed: session.serverSeed,
      seedHash: session.seedHash,
      balance: player.balance,
      loss: session.bet,
      netProfit: -session.bet
    };
  }

  // أصاب جوهرة (نجاح وتقدم)
  session.revealedTiles.push(idx);
  const revealedCount = session.revealedTiles.length;
  const multiplier = calculateMultiplier(session.minesCount, revealedCount);
  session.currentMultiplier = multiplier;

  const currentProfit = Math.round(session.bet * multiplier) - session.bet;
  const cashoutAmount = Math.round(session.bet * multiplier);

  // هل كشف جميع الجواهر المتبقية بالكامل؟ (Jackpot Max Win)
  if (revealedCount === session.gemsCount) {
    session.status = 'won';
    activeSessions.delete(player.id);

    store.adjustBalance(player, cashoutAmount);

    store.recordLedger({
      real: { wagered: session.bet, paid: cashoutAmount, bets: 1 },
      bot: null,
      game: 'mines'
    });

    return {
      ok: true,
      hitMine: false,
      allGemsFound: true,
      revealedTile: idx,
      revealedTiles: session.revealedTiles,
      multiplier,
      win: cashoutAmount,
      netProfit: currentProfit,
      balance: player.balance,
      mines: Array.from(session.minePositions),
      serverSeed: session.serverSeed
    };
  }

  // حساب المضاعف للمربع التالي
  const nextMultiplier = calculateMultiplier(session.minesCount, revealedCount + 1);
  session.nextMultiplier = nextMultiplier;
  const nextProfit = Math.round(session.bet * nextMultiplier) - session.bet;

  return {
    ok: true,
    hitMine: false,
    revealedTile: idx,
    revealedTiles: session.revealedTiles,
    revealedCount,
    multiplier,
    currentProfit,
    cashoutAmount,
    nextMultiplier,
    nextProfit,
    balance: player.balance
  };
}

/**
 * سحب الأرباح فوراً (Cash Out)
 */
function cashOut(player) {
  if (!player) return { ok: false, error: 'غير مصرح' };

  const session = activeSessions.get(player.id);
  if (!session || session.status !== 'active') {
    return { ok: false, error: 'لا توجد جولة نشطة للسحب' };
  }

  if (session.revealedTiles.length === 0) {
    return { ok: false, error: 'يجب كشف جوهرة واحدة على الأقل قبل سحب الأرباح' };
  }

  const multiplier = session.currentMultiplier;
  const winAmount = Math.round(session.bet * multiplier);
  const netProfit = winAmount - session.bet;

  session.status = 'cashed_out';
  activeSessions.delete(player.id);

  // إضافة الأرباح لرصيد اللاعب
  store.adjustBalance(player, winAmount);

  // تسجيل النتيجة في دفتر أرباح الموقع
  store.recordLedger({
    real: { wagered: session.bet, paid: winAmount, bets: 1 },
    bot: null,
    game: 'mines'
  });

  return {
    ok: true,
    cashedOut: true,
    win: winAmount,
    netProfit,
    multiplier,
    balance: player.balance,
    revealedTiles: session.revealedTiles,
    mines: Array.from(session.minePositions),
    serverSeed: session.serverSeed,
    seedHash: session.seedHash
  };
}

/**
 * اختيار عشوائي لمربع غير مكشوف (Random Pick)
 */
function randomPick(player) {
  if (!player) return { ok: false, error: 'غير مصرح' };
  const session = activeSessions.get(player.id);
  if (!session || session.status !== 'active') {
    return { ok: false, error: 'لا توجد جولة نشطة' };
  }

  const unrevealed = [];
  for (let i = 0; i < TOTAL_TILES; i++) {
    if (!session.revealedTiles.includes(i)) {
      unrevealed.push(i);
    }
  }

  if (unrevealed.length === 0) {
    return { ok: false, error: 'تم كشف جميع المربعات' };
  }

  const randomIndex = unrevealed[crypto.randomInt(0, unrevealed.length)];
  return revealTile(player, randomIndex);
}

/**
 * جلب حالة اللعبة الحالية للاعب
 */
function stateFor(player) {
  if (!player) {
    return {
      active: false,
      balance: 1000,
      currency: 'IQD',
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE
    };
  }

  const session = activeSessions.get(player.id);
  if (!session || session.status !== 'active') {
    return {
      active: false,
      balance: player.balance,
      currency: player.currency || 'IQD',
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE
    };
  }

  return {
    active: true,
    bet: session.bet,
    minesCount: session.minesCount,
    gemsCount: session.gemsCount,
    seedHash: session.seedHash,
    revealedTiles: session.revealedTiles,
    currentMultiplier: session.currentMultiplier,
    nextMultiplier: session.nextMultiplier,
    currentProfit: Math.round(session.bet * session.currentMultiplier) - session.bet,
    cashoutAmount: Math.round(session.bet * session.currentMultiplier),
    balance: player.balance,
    currency: player.currency || 'IQD',
    minStake: MIN_STAKE,
    maxStake: MAX_STAKE
  };
}

module.exports = {
  TOTAL_TILES,
  MIN_MINES,
  MAX_MINES,
  DEFAULT_RTP,
  MIN_STAKE,
  MAX_STAKE,
  calculateMultiplier,
  startGame,
  revealTile,
  cashOut,
  randomPick,
  stateFor
};
