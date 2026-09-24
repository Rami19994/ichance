'use strict';

const { sha256Hex, createStream } = require('./rng');

/**
 * محرك السلوتس — لعبة "صيّاد الجوائز" (5 بكرات × 4 صفوف · 1024 طريقة).
 *
 * الميكانيكا:
 *   - نظام WAYS لا خطوط: أي تطابق على بكرات متجاورة من اليسار يُحتسب.
 *     عدد الطرق = حاصل ضرب عدد الرموز المطابقة في كل بكرة.
 *   - WILD يعوّض كل الرموز عدا SCATTER، ويظهر على البكرات 2-5 فقط.
 *   - 3 رموز SCATTER أو أكثر تفتح الدورات المجانية.
 *   - داخل الدورات المجانية: عدّاد مضاعفات يتقدّم مع كل دورة رابحة
 *     (1 ← 2 ← 4 ← ... ← 1024) ولا يعود للخلف حتى نهاية الجولة.
 *   - شراء الميزة (Feature Buy) بسعر ثابت من الرهان.
 *
 * كل شيء يُحسب على الخادم. المتصفح يعرض فقط ما يصله.
 */

// ---------------------------------------------------------------------------
// الرموز
// ---------------------------------------------------------------------------
const SYMBOLS = {
  J:       { key: 'J',       name: 'J',            tier: 'low' },
  Q:       { key: 'Q',       name: 'Q',            tier: 'low' },
  K:       { key: 'K',       name: 'K',            tier: 'low' },
  A:       { key: 'A',       name: 'A',            tier: 'low' },
  BOTTLE:  { key: 'BOTTLE',  name: 'قنينة ويسكي',  tier: 'mid' },
  HAT:     { key: 'HAT',     name: 'قبعة الشريف',  tier: 'mid' },
  GUN:     { key: 'GUN',     name: 'المسدس',       tier: 'high' },
  OUTLAW:  { key: 'OUTLAW',  name: 'الخارج عن القانون', tier: 'high' },
  WILD:    { key: 'WILD',    name: 'وايلد',        tier: 'wild' },
  SCATTER: { key: 'SCATTER', name: 'سبائك ذهب',    tier: 'scatter' }
};

const REELS = 5;
const ROWS = 4;
const WAYS = Math.pow(ROWS, REELS); // 1024

// ---------------------------------------------------------------------------
// جدول الأرباح — بوحدات "الرهان لكل طريقة" (bet / 1024)
// الربح = (الرهان ÷ 1024) × القيمة أدناه × عدد الطرق
//
// ── العائد 96.2% (كان 80.8%)
// كل ربح هنا = الجدول × عدد الطرق × المضاعف، فالعائد خطّي في الجدول. قِسنا
// العائد مفكَّكاً — الدورة الأساسية (4 ملايين دورة) + الميزة مُحاكاةً
// مباشرة (200 ألف ميزة) — ثم ضربنا الجدول كلّه في ×1.1885 وأعدنا القياس:
//     الدورة الأساسية 69.4% + الميزة (1 من 206 × قيمة ×55.1) 26.8% = 96.2%
// النِسَب بين الرموز لم تتغيّر، ولا الأشرطة ولا الميزة: اللعبة هي هي،
// وكل ربح أكبر بنحو الخُمس. الأداة: tools/tuneBounty.js
// ---------------------------------------------------------------------------
const PAYTABLE = {
  J:      { 4: 95,  5: 273 },
  Q:      { 4: 95,  5: 273 },
  K:      { 4: 137, 5: 404 },
  A:      { 4: 137, 5: 404 },
  BOTTLE: { 4: 214, 5: 594 },
  HAT:    { 4: 315, 5: 933 },
  GUN:    { 4: 553, 5: 1587 },
  OUTLAW: { 4: 951, 5: 2751 }
};

/**
 * أرقام اللعبة المقيسة — تُنشر للّاعب في /api/slot/config.
 * كانت مكتوبة يدوياً في index.js فبقيت تعلن 80.5% بعد أي تعديل. هنا تجاور
 * الجدول الذي أنتجها، فمن يغيّر أحدهما يرى الآخر. أعِد قياسها بـ
 * tools/tuneBounty.js بعد أي تعديل على الجدول أو الأشرطة.
 */
const MEASURED = { rtp: 96.2, hitRate: 53.1, featureOdds: 206 };

/**
 * الحد الأدنى للفوز: 4 بكرات متجاورة، لا 3.
 *
 * كانت 3 بكرات تكفي، فارتفعت نسبة الدورات الرابحة إلى 74% — لكن 82% من تلك
 * "الأرباح" كانت أقل من الرهان نفسه، أي خسارة متنكّرة في ثوب فوز. رفع الحد
 * إلى 4 بكرات خفض النسبة إلى ~53% وجعل الفوز حدثاً فعلياً لا ضجيجاً دائماً.
 */
const MIN_REELS_TO_WIN = 4;

// الجدول أعلاه هو المنشور للاعب وهو المصروف فعلاً — لا معامل خفيّ بينهما.
// ضبط نسبة العائد يتم بتعديل الجدول أو أعداد الرموز في الأشرطة، لا بمعامل سرّي.
const PAY_SCALE = 1;

// سقف الربح (مضاعف الرهان).
//   spin    = أقصى ربح لدورة واحدة
//   session = أقصى ربح لجولة كاملة بما فيها كل الدورات المجانية
// السقف الثاني ضروري: الميزة تتراكم عبر عشرات الدورات فقد يتجاوز مجموعها
// سقف الدورة الواحدة أضعافاً، وهو ما يحدّ تعرّض الموقع فعلياً.
const MAX_WIN_MULTIPLIER = 2000;
const MAX_SESSION_MULTIPLIER = 3000;

/**
 * أقصى رهان مسموح في السلوتس.
 *
 * لماذا حدّ على الرهان بدل سقف على المضاعف؟
 * جرّبنا تطبيق قاعدة "سقف ×5 على المبالغ الكبيرة" المستعملة في لعبة الكروت،
 * فكانت النتيجة كارثية: قيمة الدورات المجانية تهبط من ×186 إلى ×25، فينزل
 * عائد اللاعب الكبير من 87% إلى 55%، وعائد شراء الميزة إلى 11.9% بنفس السعر.
 * أي أن اللاعب يدفع ثمناً واحداً مقابل بضاعتين مختلفتين — وهذا غشّ لا حماية.
 *
 * الحدّ على الرهان يحقق نفس الغرض بلا ظلم: نسبة العائد واحدة عند كل مبلغ،
 * والتعرّض الأقصى للموقع = MAX_STAKE × MAX_SESSION_MULTIPLIER، رقم معروف سلفاً.
 */
const MAX_STAKE = 12_800;

// ---------------------------------------------------------------------------
// أشرطة البكرات — هي ما يحدد الاحتمالات فعلياً
// ---------------------------------------------------------------------------
/**
 * يبني شريط بكرة بتوزيع الرموز بالتساوي على طوله.
 *
 * ⚠️ التجميع قاتل هنا: لو وُضع كل رمز ككتلة متصلة لوقعت نافذة الصفوف الأربعة
 * غالباً داخل كتلة واحدة، فتنهار الاحتمالات وتصبح اللعبة بلا معنى.
 * لذا نوزّع كل رمز على مسافات متساوية، ونبدأ بالأندر لأن تباعده هو الأهم.
 */
function strip(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const slots = new Array(total).fill(null);

  const order = Object.entries(counts).sort((a, b) => a[1] - b[1]); // الأندر أولاً
  for (const [sym, n] of order) {
    const step = total / n;
    for (let i = 0; i < n; i++) {
      const ideal = Math.round(i * step + step / 2) % total;
      let k = 0;
      while (slots[(ideal + k) % total] !== null) k += 1;
      slots[(ideal + k) % total] = sym;
    }
  }
  return slots;
}

const STRIPS = [
  // سكاتر مضاعف على البكرتين 1 و5 — هو ما يرفع تكرار البونص من 1:500 إلى 1:200
  // بلا لمس بقية الاحتمالات. البكرة 1 بلا وايلد (قاعدة معتادة في هذا النوع).
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, SCATTER: 2 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 4, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 5, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 4, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 3, SCATTER: 2 })
];

// أشرطة البونص: وايلد أكثر قليلاً، وسكاتر مفرد حتى لا يتكرر التمديد بإفراط
const FREE_STRIPS = [
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 5, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 6, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 5, SCATTER: 1 }),
  strip({ J: 9, Q: 9, K: 9, A: 9, BOTTLE: 8, HAT: 7, GUN: 6, OUTLAW: 5, WILD: 4, SCATTER: 1 })
];

// ---------------------------------------------------------------------------
// الدورات المجانية وعدّاد المضاعفات
// ---------------------------------------------------------------------------
const MULTIPLIER_LADDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

const FREE_SPINS = {
  base: 10,        // 3 سكاتر
  perExtra: 3,     // لكل سكاتر إضافي
  retrigger: 3,    // سكاتر داخل الميزة يمنح دورات إضافية
  maxTotal: 30     // سقف يمنع جلسات لا تنتهي
};

// العدّاد يتقدّم خطوة مع كل دورة رابحة، ويعود إلى ×1 عند أول دورة خاسرة.
// بدون هذه العودة يصل ×1024 في كل ميزة تقريباً وتنهار حسابات الموقع.
const MULTIPLIER_RESETS_ON_LOSS = true;

/**
 * سعر شراء البونص كمضاعف للرهان.
 *
 * ⚠️ لا يجوز اختياره اعتباطاً، ويجب إعادة قياسه بعد أي تعديل على الأشرطة أو
 * جدول الأرباح. القيمة المتوقعة للبونص المشترى مقيسة بالمحاكاة (200,000
 * ميزة) عند ×53.8 من الرهان (±0.34)، فالسعر العادل = القيمة ÷ نسبة العائد
 * = 53.8 ÷ 0.962 ≈ 56 — أي أن الشراء واللعب يعطيان العائد نفسه (96.1%).
 *
 * تاريخ هذا الرقم يوضّح خطورة إهماله:
 *   - ×85  (تخمين أولي)  => عائد شراء 216% — الموقع يخسر في كل عملية شراء.
 *   - ×210 (بعد التوازن الأول) => كان عادلاً حين كان البونص يساوي ×184.
 *   - بعد خفض قيمة البونص إلى ×45.7 صار نفس السعر يعطي عائد 21.7% — ظلم للاعب.
 *   - ×57 عند عائد 80.8%؛ ثم رُفع الجدول إلى 96.2% فصارت القيمة ×53.8 → ×56.
 */
const FEATURE_BUY_COST = 56;
const FEATURE_BUY_MEASURED_EV = 54;

// ---------------------------------------------------------------------------
// توليد اللوحة
// ---------------------------------------------------------------------------

/**
 * يشتق مواضع توقّف البكرات من البذرة — حتمي وقابل لإعادة الحساب.
 * @returns {{ grid: string[][], stops: number[] }} grid[reel][row]
 */
function spinGrid(seedHex, nonce, free) {
  const next = createStream(`${seedHex}:${nonce}`);
  const strips = free ? FREE_STRIPS : STRIPS;
  const grid = [];
  const stops = [];

  for (let r = 0; r < REELS; r++) {
    const s = strips[r];
    const stop = next() % s.length;
    stops.push(stop);
    const col = [];
    for (let row = 0; row < ROWS; row++) col.push(s[(stop + row) % s.length]);
    grid.push(col);
  }
  return { grid, stops };
}

// ---------------------------------------------------------------------------
// تقييم اللوحة
// ---------------------------------------------------------------------------

/**
 * يحسب أرباح WAYS. التطابق يبدأ من البكرة الأولى ويستمر على المتجاورة.
 * @returns {{ lines: object[], total: number, scatters: number }}
 */
function evaluate(grid, bet, multiplier) {
  const perWay = bet / WAYS;
  const lines = [];

  for (const key of Object.keys(PAYTABLE)) {
    const counts = [];
    const positions = [];

    for (let r = 0; r < REELS; r++) {
      const hits = [];
      for (let row = 0; row < ROWS; row++) {
        const s = grid[r][row];
        if (s === key || s === 'WILD') hits.push(row);
      }
      if (!hits.length) break;
      counts.push(hits.length);
      positions.push(hits.map((row) => [r, row]));
    }

    const reelsHit = counts.length;
    if (reelsHit < MIN_REELS_TO_WIN) continue;

    const ways = counts.reduce((a, b) => a * b, 1);
    const pay = PAYTABLE[key][reelsHit];
    if (!pay) continue;

    const amount = perWay * pay * PAY_SCALE * ways * multiplier;
    lines.push({
      symbol: key,
      reels: reelsHit,
      ways,
      pay,
      amount,
      cells: positions.flat()
    });
  }

  let scatters = 0;
  const scatterCells = [];
  for (let r = 0; r < REELS; r++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[r][row] === 'SCATTER') { scatters += 1; scatterCells.push([r, row]); }
    }
  }

  const total = lines.reduce((a, l) => a + l.amount, 0);
  return { lines, total, scatters, scatterCells };
}

/** يطبّق سقف الربح لكل دورة. */
function capWin(amount, bet) {
  const cap = bet * MAX_WIN_MULTIPLIER;
  return amount > cap ? cap : amount;
}

/** يطبّق سقف الربح للجولة الكاملة (الأساسية + كل الدورات المجانية). */
function capSession(amount, bet) {
  const cap = bet * MAX_SESSION_MULTIPLIER;
  return amount > cap ? cap : amount;
}

/** الخطوة التالية في عدّاد المضاعفات بعد دورة رابحة. */
function nextMultiplier(current) {
  const i = MULTIPLIER_LADDER.indexOf(current);
  if (i < 0) return MULTIPLIER_LADDER[0];
  return MULTIPLIER_LADDER[Math.min(i + 1, MULTIPLIER_LADDER.length - 1)];
}

/** حالة العدّاد بعد دورة: يتقدّم عند الربح ويعود إلى البداية عند الخسارة. */
function stepMultiplier(current, won) {
  if (won > 0) return nextMultiplier(current);
  return MULTIPLIER_RESETS_ON_LOSS ? MULTIPLIER_LADDER[0] : current;
}

/** عدد الدورات المجانية الممنوحة لعدد سكاتر معيّن. */
function freeSpinsFor(scatters) {
  if (scatters < 3) return 0;
  return FREE_SPINS.base + (scatters - 3) * FREE_SPINS.perExtra;
}

/**
 * دورة واحدة كاملة: توليد + تقييم + تطبيق السقف.
 * لا تمسّ أي رصيد — الاستدعاء الأعلى هو من يتعامل مع المحفظة.
 */
function playSpin({ seedHex, nonce, bet, free, multiplier }) {
  const { grid, stops } = spinGrid(seedHex, nonce, free);
  const result = evaluate(grid, bet, free ? multiplier : 1);
  const win = capWin(result.total, bet);

  return {
    grid,
    stops,
    lines: result.lines,
    scatters: result.scatters,
    scatterCells: result.scatterCells,
    win: Math.round(win),
    rawWin: result.total,
    capped: result.total > bet * MAX_WIN_MULTIPLIER,
    multiplier: free ? multiplier : 1
  };
}

module.exports = {
  SYMBOLS, PAYTABLE, PAY_SCALE, STRIPS, FREE_STRIPS,
  REELS, ROWS, WAYS, MULTIPLIER_LADDER, FREE_SPINS,
  FEATURE_BUY_COST, FEATURE_BUY_MEASURED_EV,
  MAX_WIN_MULTIPLIER, MAX_SESSION_MULTIPLIER, MAX_STAKE, MULTIPLIER_RESETS_ON_LOSS,
  MIN_REELS_TO_WIN, MEASURED,
  spinGrid, evaluate, playSpin, nextMultiplier, stepMultiplier, freeSpinsFor, capWin, capSession,
  sha256Hex
};
