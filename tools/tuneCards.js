'use strict';

/**
 * ضبط رياضيات كروت الحظ.
 *
 * العائد هنا بسيط وصريح: اللاعب يختار كرتاً من اثني عشر، فالعائد = متوسط
 * مضاعفات الكروت. أي:  RTP = (عدد كروت الاسترداد + مجموع مضاعفات الكروت
 * الرابحة) ÷ 12.
 *
 * في التوزيع القديم كان 65% من الكروت صفراً و10% استرداداً و25% ربحاً،
 * ومجموع الرابحة 8.45 وسطياً — فالعائد (1.2 + 8.45) ÷ 12 = 80.4%.
 *
 * الرافعة الأنظف ليست تكبير الجوائز (يرفع التذبذب وتعرّض الموقع) بل
 * **تثبيت ثلاثة كروت استرداد في كل نمط**: يتحوّل ثلث الخسائر إلى «استرجعت
 * مالك»، وهو أفضل ما يمكن أن يحدث للاعب بعد الربح، ويكلّف الموقع رقماً
 * معلوماً بالضبط لا مفاجأة فيه.
 */

const TARGET = 0.96;
const CARDS = 12;
const REFUNDS = 3;      // كروت ×1 في كل نمط
const WINNERS = 3;      // كروت >×1 — قاعدة اللعبة، لا تتغيّر

// مجموع مضاعفات الكروت الرابحة لكل نمط (كما هي اليوم)
const SHAPES = [
  { key: 'trio',     win: [2, 2, 2] },
  { key: 'balanced', win: [2, 2, 3] },
  { key: 'rising',   win: [2, 3, 3] },
  { key: 'five',     win: [2, 2, 5] },
  { key: 'five2',    win: [2, 3, 5] },
  { key: 'ten',      win: [2, 2, 10] },
  { key: 'twenty',   win: [2, 2, 20] },
  { key: 'fifty',    win: [2, 2, 50] },
  { key: 'hundred',  win: [2, 2, 100] }
];

// الأوزان النادرة مثبّتة: هي التي تحدّد ندرة الجوائز الكبيرة وتعرّض الموقع
const FIXED = { ten: 50, twenty: 14, fifty: 5, hundred: 1 };
const TOTAL_WEIGHT = 1000;

const sums = Object.fromEntries(SHAPES.map((s) => [s.key, s.win.reduce((a, b) => a + b, 0)]));

/** المجموع الموزون للكروت الرابحة الذي يصيب الهدف بالضبط. */
const needWinSum = TARGET * CARDS - REFUNDS;
console.log('كروت الحظ');
console.log('  كروت الاسترداد لكل نمط : ' + REFUNDS);
console.log('  المطلوب من الكروت الرابحة (موزوناً): ' + needWinSum.toFixed(3));

// نوزّع الوزن المتبقّي على الأنماط الصغيرة الأربعة بحيث يصيب المتوسط هدفه
const fixedWeight = Object.values(FIXED).reduce((a, b) => a + b, 0);
const fixedContribution = Object.entries(FIXED)
  .reduce((a, [k, w]) => a + w * sums[k], 0);
const freeWeight = TOTAL_WEIGHT - fixedWeight;
const needFree = needWinSum * TOTAL_WEIGHT - fixedContribution;

console.log('  وزن الأنماط النادرة    : ' + fixedWeight + '  (مساهمتها ' + fixedContribution + ')');
console.log('  الوزن الحرّ             : ' + freeWeight + '  (المطلوب منه ' + needFree.toFixed(0) + ')');

// البحث عن أوزان صحيحة للأنماط الأربعة الصغيرة تصيب المجموع بالضبط
const small = ['trio', 'balanced', 'rising', 'five', 'five2'];
let found = null;
for (let a = 100; a <= 400 && !found; a += 5) {          // trio  (6)
  for (let b = 100; b <= 400 && !found; b += 5) {        // balanced (7)
    for (let c = 50; c <= 350 && !found; c += 5) {       // rising (8)
      for (let d = 50; d <= 300 && !found; d += 5) {     // five (9)
        const e = freeWeight - a - b - c - d;            // five2 (10)
        if (e < 50 || e > 300) continue;
        const total = a * sums.trio + b * sums.balanced + c * sums.rising
                    + d * sums.five + e * sums.five2;
        if (Math.abs(total - needFree) < 0.5) {
          found = { trio: a, balanced: b, rising: c, five: d, five2: e };
        }
      }
    }
  }
}

if (!found) { console.error('لم يُعثر على أوزان صحيحة'); process.exit(1); }

const weights = { ...found, ...FIXED };
let wsum = 0, contrib = 0;
for (const [k, w] of Object.entries(weights)) { wsum += w; contrib += w * sums[k]; }
const winSum = contrib / wsum;
const rtp = (REFUNDS + winSum) / CARDS;

console.log('\n  الأوزان المقترحة (من ' + wsum + '):');
for (const s of SHAPES) {
  console.log('    ' + s.key.padEnd(10) + String(weights[s.key]).padStart(4)
    + '   كروت رابحة [' + s.win.join(', ') + ']  مجموع ' + sums[s.key]);
}
console.log('\n  العائد الناتج          : ' + (rtp * 100).toFixed(4) + '%');
console.log('  هامش الموقع            : ' + ((1 - rtp) * 100).toFixed(4) + '%');

// تجربة اللاعب
console.log('\n  ما يراه اللاعب عند اختيار كرت واحد:');
console.log('    ربح فعلي            : ' + (WINNERS / CARDS * 100).toFixed(1) + '%');
console.log('    استرداد الرهان      : ' + (REFUNDS / CARDS * 100).toFixed(1) + '%');
console.log('    خسارة               : ' + ((CARDS - WINNERS - REFUNDS) / CARDS * 100).toFixed(1) + '%');
console.log('    (كان: ربح 25% · استرداد 10% · خسارة 65%)');

// سقف المضاعف على الرهانات الكبيرة يغيّر العائد — نقيسه صراحةً
for (const cap of [5, 10]) {
  let c2 = 0;
  for (const [k, w] of Object.entries(weights)) {
    c2 += w * SHAPES.find((s) => s.key === k).win.reduce((a, m) => a + Math.min(m, cap), 0);
  }
  const rtpCapped = (REFUNDS + c2 / wsum) / CARDS;
  console.log('  العائد عند سقف ×' + cap + '      : ' + (rtpCapped * 100).toFixed(2) + '%'
    + '   (للرهانات الكبيرة)');
}

console.log('\n  الأنماط جاهزة للّصق:');
for (const s of SHAPES) {
  const cards = [...Array(CARDS - WINNERS - REFUNDS).fill(0), ...Array(REFUNDS).fill(1), ...s.win];
  console.log("    { key: '" + s.key + "', weight: " + String(weights[s.key]).padStart(3)
    + ', cards: [' + cards.join(', ') + '] }');
}
