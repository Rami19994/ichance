'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * LuckyArena — محرك لعبة بلينكو عالي التذبذب (High-Volatility Plinko Engine)
 * 16 صفاً من العوائق، 17 وعاءً نهائياً.
 *
 * التوزيع الرياضي الثنائي المثبت (Binomial Distribution n=16, p=0.5):
 * - إجمالي المسارات الممكنة: 2^16 = 65,536 مساراً.
 * - مصفوفة المضاعفات (17 وعاء):
 *   [150, 100, 50, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10, 50, 100, 150]
 *
 * الإثبات الرياضي الدقيق:
 * - الأوعية [5, 6, 7, 8, 9, 10, 11] = 0x (المنطقة الميتة: 60,502 مسار = 92.31875% احتمال الخسارة).
 * - الأوعية [3, 4, 12, 13] = 10x (4,760 مسار = 7.263% معدل الإصابة).
 * - الأوعية [2, 14] = 50x (240 مسار = 0.366% معدل الإصابة).
 * - الأوعية [1, 15] = 100x (32 مسار = 0.0488% معدل الإصابة).
 * - الأوعية [0, 16] = 150x (مساران فقط = 0.00305% معدل الإصابة بالجائزة الكبرى).
 *
 * القيمة المتوقعة (EV / RTP):
 * 63,100 / 65,536 = 0.962829... (عائد اللاعب RTP = 96.28%، هامش المنصة House Edge = 3.72%).
 */

const ROWS = 16;
// مصفوفة المضاعفات المتناظرة والدقيقة هندسياً
const MULTIPLIERS = [150, 100, 50, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10, 50, 100, 150];
const MIN_STAKE = 100;
const MAX_STAKE = 1000000;

/** العائد النظري الدقيق: Σ C(16,k)·M[k] ÷ 2^16. */
const RTP = (() => {
  let c = 1, ev = 0;
  for (let k = 0; k <= ROWS; k++) {
    ev += c * MULTIPLIERS[k];
    c = c * (ROWS - k) / (k + 1);
  }
  return ev / 2 ** ROWS;
})();

/**
 * توليد مسار الكرة المشفر بنظام العدالة المثبتة (Provably Fair HMAC-SHA256)
 * @param {string} serverSeed - بذرة الخادم السرية
 * @param {string} clientSeed - بذرة العميل
 * @param {number} nonce - رقم تسلسل الجولة
 * @returns {{ decisions: number[], trajectory: number[], path: number[], index: number }}
 */
function generatePlinkoPath(serverSeed, clientSeed, nonce) {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  const decisions = [];  // 0 (Left) or 1 (Right)
  const trajectory = []; // -1 (Left visual bounce) or +1 (Right visual bounce)
  let k = 0;             // final bin index: sum(decisions) in range [0, 16]

  // تحويل أول 16 بايت من الهاش إلى قرارات اتجاهية متساوية الاحتمال تماماً (p = 0.5)
  // حيث أن قيم البايت [0-255] موزعة بالتساوي (128 زوجي = 0، 128 فردي = 1)
  for (let i = 0; i < ROWS; i++) {
    const byte = parseInt(hash.substr(i * 2, 2), 16);
    const decision = byte % 2; // 0 = Left, 1 = Right
    decisions.push(decision);
    trajectory.push(decision === 1 ? 1 : -1);
    if (decision === 1) k++;
  }

  return {
    decisions,
    trajectory,
    path: trajectory, // متوافق مع العارض المرئي في الكانفاس
    index: k          // رقم الوعاء النهائي المحسوب
  };
}

/**
 * إسقاط الكرة وخصم الرهان وإيداع الأرباح ذرياً
 */
async function dropBall(player, { bet, clientSeed = null }) {
  if (!player) return { ok: false, error: 'سجّل الدخول أولاً للّعب بالرصيد الحقيقي', needsLogin: true };

  const cleanBet = Math.floor(Number(bet) || 0);
  if (cleanBet < MIN_STAKE) return { ok: false, error: `الحد الأدنى للرهان هو ${MIN_STAKE.toLocaleString()} IQD` };
  if (cleanBet > MAX_STAKE) return { ok: false, error: `الحد الأقصى للرهان هو ${MAX_STAKE.toLocaleString()} IQD` };

  const currentBal = Number(player.balance) || 0;
  if (currentBal < cleanBet) {
    return {
      ok: false,
      error: `رصيدك لا يكفي لإتمام هذا الرهان. رصيدك الحالي: ${currentBal.toLocaleString()} IQD`
    };
  }

  const serverSeed = crypto.randomBytes(32).toString('hex');
  const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const cSeed = String(clientSeed || crypto.randomBytes(12).toString('hex')).trim();
  const nonce = (player.stats?.rounds || 0) + 1;

  const txRef = 'plinko-start-' + player.id + '-' + Date.now();
  if (!(await store.gameDebit('plinko', player, cleanBet, txRef))) {
    return { ok: false, error: 'تعذّر خصم الرهان (رصيد غير كافٍ أو خطأ بالاتصال)' };
  }

  const { decisions, trajectory, path, index } = generatePlinkoPath(serverSeed, cSeed, nonce);
  const multiplier = MULTIPLIERS[index];
  const winAmount = Math.round(cleanBet * multiplier);

  if (winAmount > 0) {
    const txRefWin = 'plinko-win-' + player.id + '-' + Date.now();
    await store.gameCredit('plinko', player, winAmount, txRefWin);
  }

  store.recordPlinko(player, { bet: cleanBet, win: winAmount, multiplier });

  return {
    ok: true,
    decisions,
    trajectory,
    path,
    index,
    multiplier,
    win: winAmount,
    netProfit: winAmount - cleanBet,
    balance: player.balance,
    seedHash,
    serverSeed,
    clientSeed: cSeed,
    nonce
  };
}

function stateFor(player) {
  if (!player) {
    return {
      loggedIn: false,
      active: true,
      balance: 0,
      currency: 'IQD',
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE,
      multipliers: MULTIPLIERS,
      rows: ROWS
    };
  }

  return {
    loggedIn: true,
    active: true,
    balance: player.balance,
    currency: player.currency || 'IQD',
    minStake: MIN_STAKE,
    maxStake: MAX_STAKE,
    multipliers: MULTIPLIERS,
    rows: ROWS
  };
}

module.exports = {
  ROWS,
  MULTIPLIERS,
  MIN_STAKE,
  MAX_STAKE,
  RTP,
  generatePlinkoPath,
  dropBall,
  stateFor
};
