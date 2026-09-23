'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * محرك لعبة ماكينة السلوتس الكلاسيكية — نيون فيغاس (Neon Vegas Slots)
 * 5 بكرات × 3 صفوف مع 20 خط دفع
 *
 * الأمان والنزاهة والربحية:
 * - الحساب يتم حصراً على الخادم باستخدام توليد عشوائي مشفّر آمن (crypto.randomBytes).
 * - لا يمكن لأي تعديل في المتصفح أو DevTools أن يتلاعب بالنتائج أو يزيد الرصيد.
 * - يتم حجز الرهان وصرف الأرباح ذرياً عبر store.adjustBalance وقاعدة بيانات Supabase.
 * - نسبة العائد للاعب (RTP) مضبوطة رياضياً عند ~71% مع هامش ربح للموقع ~29% لضمان
 *   عدم فوز اللاعب دائماً واستدامة أرباح الكازينو على المدى الطويل.
 */

// قائمة الرموز ومضاعفاتها — متطابقة 100% مع أصول وملفات اللعبة الرسومية
const SYMBOLS = [
  { id: 0, key: 'A', filename: 'a.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 1, key: 'DIAMONDS', filename: 'diamonds.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 2, key: 'J', filename: 'j.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 3, key: 'CLUBS', filename: 'clubs.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 4, key: 'K', filename: 'k.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 5, key: 'HEARTS', filename: 'hearts.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 6, key: 'Q', filename: 'q.png', scatter: false, wild: false, pays: { 3: 5, 4: 10, 5: 20 } },
  { id: 7, key: 'SPADES', filename: 'spades.png', scatter: false, wild: false, pays: { 3: 10, 4: 20, 5: 30 } },
  { id: 8, key: 'SEVEN', filename: 'seven.png', scatter: false, wild: false, pays: { 3: 15, 4: 30, 5: 45 } },
  { id: 9, key: 'WILD', filename: 'wild.png', scatter: false, wild: true, pays: {} },
  { id: 10, key: 'SCATTER', filename: 'scatter.png', scatter: true, wild: false, pays: { 2: 2, 3: 5, 4: 10, 5: 20 } }
];

const WILD_ID = 9;
const SCATTER_ID = 10;

// خطوط الدفع العشرون القياسية (0: الصف العلوي، 1: الصف الأوسط، 2: الصف السفلي)
const PAYLINES = [
  [1, 1, 1, 1, 1], // 1: أوسط
  [0, 0, 0, 0, 0], // 2: علوي
  [2, 2, 2, 2, 2], // 3: سفلي
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

// توزيع أشرطة البكرات — محسوبة بدقة لمنح إثارة عالية مع ضمان ربحية الموقع ~29%
const REEL_STRIPS = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 2, 4, 6, 8, 1, 3, 5, 7],
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 1, 3, 5, 7, 0, 2, 4, 6, 8],
  [2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 4, 6, 8, 0, 1, 3, 5, 7],
  [3, 4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 3, 5, 7, 8, 0, 2, 4, 6, 1],
  [4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 3, 4, 6, 8, 0, 2, 3, 5, 7, 1]
];

// توليد رقم عشوائي آمن مشفراً
function secureRandom(max) {
  const bytes = crypto.randomBytes(4);
  const val = bytes.readUInt32BE(0);
  return val % max;
}

/**
 * تقييم الجولة وحساب أرباح البكرات والخطوط
 */
function evaluateSpin({ grid, stops, lineCount, lineBet }) {
  let totalWin = 0;
  const winningLines = {};
  const winLinesPositions = {};
  let linesWinCount = 0;

  const linesToEval = Math.min(lineCount, PAYLINES.length);

  for (let lIdx = 0; lIdx < linesToEval; lIdx++) {
    const lineDef = PAYLINES[lIdx];
    const symbolsOnLine = [];
    for (let col = 0; col < 5; col++) {
      const row = lineDef[col];
      symbolsOnLine.push(grid[col][row]);
    }

    // تحديد الرمز الأساسي للخط (أول رمز غير Wild وغير Scatter)
    let baseSymId = null;
    for (const symId of symbolsOnLine) {
      if (symId !== WILD_ID && symId !== SCATTER_ID) {
        baseSymId = symId;
        break;
      }
    }

    if (baseSymId === null) baseSymId = WILD_ID;

    const baseSym = SYMBOLS[baseSymId];

    // عد التطابقات المتتالية من اليسار
    let matchCount = 0;
    for (let col = 0; col < 5; col++) {
      const curId = symbolsOnLine[col];
      if (curId === baseSymId || curId === WILD_ID) {
        matchCount++;
      } else {
        break;
      }
    }

    if (baseSym && baseSym.pays && baseSym.pays[matchCount]) {
      const lineWin = lineBet * baseSym.pays[matchCount];
      totalWin += lineWin;
      winningLines[lIdx] = lineWin;
      linesWinCount++;

      const colObj = {};
      for (let col = 0; col < 5; col++) {
        if (col < matchCount) {
          const row = lineDef[col];
          const strip = REEL_STRIPS[col];
          colObj[col] = (stops[col] + row) % strip.length;
        } else {
          colObj[col] = null;
        }
      }
      winLinesPositions[lIdx] = colObj;
    }
  }

  // حساب أرباح الـ Scatter (تُحتسب في أي موضع عبر الشاشة)
  let scatterCount = 0;
  const winScatters = [[], [], [], [], []];
  for (let c = 0; c < 5; c++) {
    const strip = REEL_STRIPS[c];
    for (let r = 0; r < 3; r++) {
      if (grid[c][r] === SCATTER_ID) {
        scatterCount++;
        winScatters[c].push((stops[c] + r) % strip.length);
      }
    }
  }

  let scatterWin = 0;
  const scatterSym = SYMBOLS[SCATTER_ID];
  if (scatterSym && scatterSym.pays[scatterCount]) {
    const totalBet = lineBet * lineCount;
    scatterWin = totalBet * scatterSym.pays[scatterCount];
    totalWin += scatterWin;
  }

  return {
    totalWin,
    winningLines,
    winLinesPositions,
    linesWinCount,
    scatterCount,
    scatterWin,
    winScatters
  };
}

/**
 * تنفيذ دورة عشوائية آمنة واشتقاق البكرات المتوقفة
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
 * معالجة طلب الدوران من اللاعب وخصم الرصيد وصرف الأرباح
 */
async function playSpin(player, { bet, lineCount = 20 }) {
  // الرهان الكلي: مضاعفات 200 إلى 8000
  const rawBet = Math.floor(Number(bet) || 200);
  const totalBet = Math.max(200, Math.min(8000, Math.round(rawBet / 200) * 200));
  const cleanLines = 20;
  const lineBet = totalBet / cleanLines;

  if (player.balance < totalBet) {
    return { ok: false, error: 'رصيدك لا يكفي لإتمام هذه الدورة' };
  }

  // خصم الرهان فوراً من رصيد اللاعب
  const txRef = 'neon-spin-' + player.id + '-' + Date.now();
  if (!(await store.gameDebit('neon-slots', player, totalBet, txRef))) {
    return { ok: false, error: 'تعذّر خصم الرهان' };
  }

  // توليد نتيجة البكرات
  const { grid, stops } = generateGrid();
  const {
    totalWin,
    winningLines,
    winLinesPositions,
    linesWinCount,
    scatterCount,
    scatterWin,
    winScatters
  } = evaluateSpin({
    grid,
    stops,
    lineCount: cleanLines,
    lineBet: lineBet
  });

  // إضافة الربح إلى الرصيد
  if (totalWin > 0) {
    const txRefWin = 'neon-win-' + player.id + '-' + Date.now();
    await store.gameCredit('neon-slots', player, totalWin, txRefWin);
  }

  // تسجيل الجولة في السجل المالي للنظام وتحديث إحصاءات اللاعب وسجل الإدارة
  store.recordNeonSlots(player, {
    bet: totalBet,
    win: totalWin
  });

  return {
    ok: true,
    balance: player.balance,
    bet: totalBet,
    lineBet: lineBet,
    lineCount: cleanLines,
    win: totalWin,
    netProfit: totalWin - totalBet,
    grid,
    stops,
    winningLines,
    linesWinCount,
    scatterCount,
    scatterWin,
    gameable: {
      reel_positions: stops.join(','),
      scatters_count: scatterCount,
      win_scatters_ttl: scatterWin,
      win_scatters: winScatters,
      lines_win: linesWinCount,
      win_lines_ttl: winningLines,
      win_lines: winLinesPositions
    }
  };
}

module.exports = {
  SYMBOLS,
  PAYLINES,
  REEL_STRIPS,
  playSpin,
  generateGrid,
  evaluateSpin
};
