'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * محرك لعبة بلينكو (Plinko)
 * 16 صفاً من العوائق
 */

const ROWS = 16;
// Multipliers from left to right (17 buckets for 16 rows)
const MULTIPLIERS = [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000];
const MIN_STAKE = 100;
const MAX_STAKE = 1000000;

function generatePlinkoPath(serverSeed, clientSeed, nonce) {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  const path = [];
  let index = 0; // final bucket index
  
  let bitCount = 0;
  for (let i = 0; i < hash.length && bitCount < ROWS; i += 2) {
    const byte = parseInt(hash.substr(i, 2), 16);
    for (let b = 0; b < 8 && bitCount < ROWS; b++) {
      const bit = (byte >> b) & 1;
      path.push(bit === 1 ? 1 : -1);
      if (bit === 1) index++; // right
      bitCount++;
    }
  }
  
  return { path, index };
}

async function dropBall(player, { bet, clientSeed = null }) {
  if (!player) return { ok: false, error: 'غير مصرح' };

  const cleanBet = Math.floor(Number(bet) || 0);
  if (cleanBet < MIN_STAKE) return { ok: false, error: `الحد الأدنى هو ${MIN_STAKE}` };
  if (cleanBet > MAX_STAKE) return { ok: false, error: `الحد الأقصى هو ${MAX_STAKE}` };
  if (player.balance < cleanBet) return { ok: false, error: 'رصيدك لا يكفي لإتمام هذا الرهان' };

  const serverSeed = crypto.randomBytes(32).toString('hex');
  const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const cSeed = String(clientSeed || crypto.randomBytes(12).toString('hex')).trim();
  const nonce = (player.stats?.rounds || 0) + 1;

  const txRef = 'plinko-start-' + player.id + '-' + Date.now();
  if (!(await store.gameDebit('plinko', player, cleanBet, txRef))) {
    return { ok: false, error: 'تعذّر خصم الرهان (رصيد غير كافٍ أو خطأ بالاتصال)' };
  }

  const { path, index } = generatePlinkoPath(serverSeed, cSeed, nonce);
  const multiplier = MULTIPLIERS[index];
  const winAmount = Math.round(cleanBet * multiplier);

  if (winAmount > 0) {
    const txRefWin = 'plinko-win-' + player.id + '-' + Date.now();
    await store.gameCredit('plinko', player, winAmount, txRefWin);
  }

  store.recordPlinko(player, { bet: cleanBet, win: winAmount, multiplier });

  return {
    ok: true,
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
      active: true,
      balance: 1000,
      currency: 'IQD',
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE,
      multipliers: MULTIPLIERS,
      rows: ROWS
    };
  }

  return {
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
  ROWS, MULTIPLIERS, MIN_STAKE, MAX_STAKE,
  dropBall, stateFor, generatePlinkoPath
};
