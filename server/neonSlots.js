'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * محرك لعبة ماكينة السلوتس الكلاسيكية — نيون فيغاس (Neon Vegas Slots)
 * 5 بكرات × 3 صفوف مع 20 خط دفع
 *
 * الأمان والنزاهة:
 * - الحساب يتم حصراً على الخادم باستخدام توليد عشوائي مشفّر آمن (crypto.randomBytes).
 * - لا يمكن لأي تعديل في المتصفح أو DevTools أو الذاكرة أن يزيد رصيد اللاعب في السيرفر أو قاعدة البيانات.
 * - يتم حجز الرهان وصرف الأرباح ذرياً عبر store.adjustBalance وقاعدة بيانات Supabase.
 */

// قائمة الرموز ومضاعفاتها
const SYMBOLS = [
  { id: 0, key: 'A', filename: 'a.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 1, key: 'K', filename: 'k.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 2, key: 'J', filename: 'j.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 3, key: 'Q', filename: 'q.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 4, key: 'DIAMONDS', filename: 'diamonds.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 5, key: 'HEARTS', filename: 'hearts.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 6, key: 'SPADES', filename: 'spades.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 7, key: 'CLUBS', filename: 'clubs.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 8, key: 'SEVEN', filename: 'seven.png', scatter: false, wild: false, pays: { 3: 25, 4: 50, 5: 100 } },
  { id: 9, key: 'SCATTER', filename: 'scatter.png', scatter: true, wild: false, pays: { 2: 2, 3: 5, 4: 10, 5: 20 } },
  { id: 10, key: 'WILD', filename: 'wild.png', scatter: false, wild: true, pays: {} }
];

// خطوط الدفع العشرون (كل خط يحدد الصف 0 أو 1 أو 2 لكل بكرة من 0 إلى 4)
const PAYLINES = [
  [1, 1, 1, 1, 1], // 1
  [0, 0, 0, 0, 0], // 2
  [2, 2, 2, 2, 2], // 3
  [1, 1, 0, 1, 2], // 4
  [1, 1, 2, 1, 0], // 5
  [1, 0, 1, 2, 1], // 6
  [1, 0, 1, 2, 2], // 7
  [1, 0, 0, 1, 2], // 8
  [1, 2, 1, 0, 1], // 9
  [1, 2, 2, 1, 0], // 10
  [1, 2, 1, 0, 0], // 11
  [0, 1, 2, 1, 0], // 12
  [0, 1, 1, 1, 2], // 13
  [0, 0, 1, 2, 2], // 14
  [0, 0, 1, 2, 1], // 15
  [0, 0, 0, 1, 2], // 16
  [2, 1, 0, 1, 2], // 17
  [2, 1, 1, 1, 0], // 18
  [2, 2, 1, 0, 0], // 19
  [2, 2, 1, 0, 1]  // 20
];

// توزيع أشرطة البكرات الافتراضية
const REEL_STRIPS = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 2, 4, 6, 8, 1, 3, 5, 7],
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 1, 3, 5, 7, 0, 2, 4, 6, 8],
  [2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 4, 6, 8, 0, 1, 3, 5, 7],
  [3, 4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 3, 5, 7, 8, 0, 2, 4, 6, 1],
  [4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 3, 4, 6, 8, 0, 2, 3, 5, 7, 1]
];

// توليد رقم عشوائي آمن مشفراً بين 0 و max-1
function secureRandom(max) {
  const bytes = crypto.randomBytes(4);
  const val = bytes.readUInt32BE(0);
  return val % max;
}

/**
 * تقييم الجولة وحساب أرباح البكرات والخطوط
 */
function evaluateSpin({ grid, lineCount, lineBet }) {
  let totalWin = 0;
  const winningLines = [];

  const linesToEval = Math.min(lineCount, PAYLINES.length);

  for (let lIdx = 0; lIdx < linesToEval; lIdx++) {
    const lineDef = PAYLINES[lIdx];
    // استخراج رموز الخط عبر البكرات الخمس
    const symbolsOnLine = [];
    for (let col = 0; col < 5; col++) {
      const row = lineDef[col];
      symbolsOnLine.push(grid[col][row]);
    }

    // تحديد الرمز الأساسي للخط (أول رمز غير Wild)
    let baseSymId = null;
    for (const symId of symbolsOnLine) {
      if (symId !== 10 && symId !== 9) { // ليس Wild وليس Scatter
        baseSymId = symId;
        break;
      }
    }

    if (baseSymId === null) baseSymId = 10; // كل الخط Wilds

    const baseSym = SYMBOLS[baseSymId];

    // عد التطابقات المتتالية من اليسار
    let matchCount = 0;
    for (let col = 0; col < 5; col++) {
      const curId = symbolsOnLine[col];
      if (curId === baseSymId || curId === 10) { // يطابق أو Wild
        matchCount++;
      } else {
        break;
      }
    }

    if (baseSym && baseSym.pays && baseSym.pays[matchCount]) {
      const lineWin = lineBet * baseSym.pays[matchCount];
      totalWin += lineWin;
      winningLines.push({
        lineIndex: lIdx,
        symbolId: baseSymId,
        count: matchCount,
        win: lineWin
      });
    }
  }

  // حساب أرباح الـ Scatter (تُحتسب في أي موضع عبر الشاشة)
  let scatterCount = 0;
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 3; r++) {
      if (grid[c][r] === 9) scatterCount++;
    }
  }

  const scatterSym = SYMBOLS[9];
  if (scatterSym && scatterSym.pays[scatterCount]) {
    const totalBet = lineBet * lineCount;
    const scatterWin = totalBet * scatterSym.pays[scatterCount];
    totalWin += scatterWin;
    winningLines.push({
      lineIndex: -1, // سكاتر عام
      symbolId: 9,
      count: scatterCount,
      win: scatterWin
    });
  }

  return { totalWin, winningLines, scatterCount };
}

/**
 * تنفيذ دورة عشوائية آمنة
 */
function generateGrid() {
  const grid = [];
  const stops = [];

  for (let col = 0; col < 5; col++) {
    const strip = REEL_STRIPS[col];
    const stopIdx = secureRandom(strip.length);
    stops.push(stopIdx);

    const colSymbols = [
      strip[stopIdx % strip.length],
      strip[(stopIdx + 1) % strip.length],
      strip[(stopIdx + 2) % strip.length]
    ];
    grid.push(colSymbols);
  }

  return { grid, stops };
}

/**
 * معالجة طلب الدوران من اللاعب
 */
function playSpin(player, { bet, lineCount = 20 }) {
  const cleanLineBet = Math.max(1, Math.min(10000, Math.floor(Number(bet) || 1)));
  const cleanLines = Math.max(1, Math.min(20, Math.floor(Number(lineCount) || 20)));
  const totalBet = cleanLineBet * cleanLines;

  if (player.balance < totalBet) {
    return { ok: false, error: 'رصيدك لا يكفي لإتمام هذه الدورة' };
  }

  // خصم الرهان فوراً من رصيد اللاعب
  if (!store.adjustBalance(player, -totalBet)) {
    return { ok: false, error: 'تعذّر خصم الرهان' };
  }

  // توليد نتيجة البكرات
  const { grid, stops } = generateGrid();
  const { totalWin, winningLines, scatterCount } = evaluateSpin({
    grid, lineCount: cleanLines, lineBet: cleanLineBet
  });

  // إضافة الربح إلى الرصيد
  if (totalWin > 0) {
    store.adjustBalance(player, totalWin);
  }

  // تسجيل الجولة في السجل المالي للنظام
  store.recordLedger({
    real: {
      wagered: totalBet,
      paid: totalWin,
      bets: 1
    },
    bot: null,
    game: 'neon-slots'
  });

  return {
    ok: true,
    balance: player.balance,
    bet: totalBet,
    lineBet: cleanLineBet,
    lineCount: cleanLines,
    win: totalWin,
    netProfit: totalWin - totalBet,
    grid,
    stops,
    winningLines,
    scatterCount
  };
}

module.exports = {
  SYMBOLS,
  PAYLINES,
  playSpin,
  generateGrid,
  evaluateSpin
};
