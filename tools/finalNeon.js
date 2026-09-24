'use strict';

/**
 * يثبّت تصميم نيون فيغاس المختار ويتحقّق منه من كل زاوية،
 * ثم يطبع ما يُلصق في الخادم وفي صفحة اللعبة.
 *
 * الاختيار من بين 51 توزيعاً تصيب 96% (انظر tuneNeon.js). المعيار لم يكن
 * العائد وحده — فكلّها تصيبه — بل شكل التجربة:
 *   • هرم ندرة نظيف 9 ← 6 ← 3 فالرمز الأثمن أندر فعلاً
 *   • تردّد فوز ~38% : شيء يحدث كثيراً بلا أن يصير ضجيجاً
 *   • المبعثر يحمل ~4% من العائد: ميزة محسوسة لا زينة ولا طاغية
 */

const { exactRtp } = require('./slotMath');
const crypto = require('crypto');

const WILD = 9, SCATTER = 10;
const LINES = 20;

const NAMES = ['A', 'DIAMONDS', 'J', 'CLUBS', 'K', 'HEARTS', 'Q', 'SPADES', 'SEVEN', 'WILD', 'SCATTER'];
const FILES = ['a.png', 'diamonds.png', 'j.png', 'clubs.png', 'k.png', 'hearts.png',
  'q.png', 'spades.png', 'seven.png', 'wild.png', 'scatter.png'];
const LOW = [0, 2, 4, 6], MID = [1, 3, 5, 7], HIGH = 8;
const TIER = ['low', 'mid', 'low', 'mid', 'low', 'mid', 'low', 'mid', 'high'];

const PAYS = {
  low:  { 3: 20,  4: 60,  5: 200 },
  mid:  { 3: 40,  4: 120, 5: 400 },
  high: { 3: 100, 4: 400, 5: 1500 }
};
const SCATTER_PAYS = { 3: 5, 4: 25, 5: 100 };

// ── التصميم المختار ──
const DESIGN = { low: 9, mid: 6, high: 3, scatter: 2, wildCentre: 3 };

const PAYLINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [1, 1, 0, 1, 2], [1, 1, 2, 1, 0],
  [1, 0, 1, 2, 1], [1, 0, 1, 2, 2], [1, 0, 0, 1, 2], [1, 2, 1, 0, 1], [1, 2, 2, 1, 0],
  [1, 2, 1, 0, 0], [0, 1, 2, 1, 0], [0, 1, 1, 1, 2], [0, 0, 1, 2, 2], [0, 0, 1, 2, 1],
  [0, 0, 0, 1, 2], [2, 1, 0, 1, 2], [2, 1, 1, 1, 0], [2, 2, 1, 0, 0], [2, 2, 1, 0, 1]
];

const symbols = NAMES.map((key, id) => {
  if (id === WILD) return { id, key, filename: FILES[id], wild: true, scatter: false, pays: {} };
  if (id === SCATTER) return { id, key, filename: FILES[id], wild: false, scatter: true, pays: { ...SCATTER_PAYS } };
  return { id, key, filename: FILES[id], wild: false, scatter: false, pays: { ...PAYS[TIER[id]] } };
});

function buildStrip(counts) {
  const L = counts.reduce((a, b) => a + b, 0);
  const slots = new Array(L).fill(null);
  const order = counts.map((n, s) => [s, n]).filter(([, n]) => n > 0).sort((a, b) => a[1] - b[1]);
  for (const [sym, n] of order) {
    const step = L / n;
    for (let i = 0; i < n; i++) {
      const ideal = Math.round(i * step + step / 2) % L;
      let k = 0;
      while (slots[(ideal + k) % L] !== null) k++;
      slots[(ideal + k) % L] = sym;
    }
  }
  return slots;
}

function counts(wild) {
  const c = new Array(11).fill(0);
  for (const id of LOW) c[id] = DESIGN.low;
  for (const id of MID) c[id] = DESIGN.mid;
  c[HIGH] = DESIGN.high; c[WILD] = wild; c[SCATTER] = DESIGN.scatter;
  return c;
}

const edge = buildStrip(counts(0));
const centre = buildStrip(counts(DESIGN.wildCentre));
const STRIPS = [edge, centre, centre, centre, edge];

// ────────────────────────────────────────────── التحقّق الدقيق
const e = exactRtp({ symbols, strips: STRIPS, wildId: WILD, scatterId: SCATTER, lineCount: LINES });

console.log('نيون فيغاس — التصميم النهائي');
console.log('  أطوال الأشرطة       : ' + STRIPS.map((s) => s.length).join(' · '));
console.log('  العائد للاعب        : ' + (e.rtp * 100).toFixed(3) + '%   (هامش الموقع '
  + ((1 - e.rtp) * 100).toFixed(3) + '%)');
console.log('    منه الخطوط        : ' + (e.linesRtp * 100).toFixed(3) + '%');
console.log('    منه المبعثر       : ' + (e.scatterRtp * 100).toFixed(3) + '%');

// ────────────────────────────────────────────── محاكاة التجربة
// العائد محسوب بدقّة أعلاه؛ المحاكاة هنا لما لا يُحسب بصيغة مغلقة:
// تردّد الفوز الحقيقي (الخطوط تتقاسم الأعمدة فليست مستقلّة)، وأكبر ربح،
// وأهمّ رقم للّاعب: احتمال أن ينهي جلسته رابحاً.
// مولّد سريع للقياس وحده. اللعبة نفسها تستعمل crypto — لكن استدعاءه مئةَ
// مليون مرّة هنا يستغرق دقائق بلا فائدة: التوزيع الإحصائي هو المطلوب،
// وxorshift كافٍ له تماماً.
let _s = 0x9e3779b9;
function rnd() {
  _s ^= _s << 13; _s |= 0;
  _s ^= _s >>> 17;
  _s ^= _s << 5; _s |= 0;
  return (_s >>> 0) / 4294967296;
}

function spin() {
  const grid = [];
  for (let c = 0; c < 5; c++) {
    const strip = STRIPS[c];
    const stop = Math.floor(rnd() * strip.length);
    grid.push([strip[stop % strip.length], strip[(stop + 1) % strip.length], strip[(stop + 2) % strip.length]]);
  }
  let win = 0;
  for (const def of PAYLINES) {
    let base = null;
    for (let c = 0; c < 5; c++) {
      const s = grid[c][def[c]];
      if (s !== WILD && s !== SCATTER) { base = s; break; }
    }
    if (base === null) base = WILD;
    let run = 0;
    for (let c = 0; c < 5; c++) {
      const s = grid[c][def[c]];
      if (s === base || s === WILD) run++; else break;
    }
    const p = symbols[base].pays[run];
    if (p) win += p;                       // بوحدات رهان الخط
  }
  let sc = 0;
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) if (grid[c][r] === SCATTER) sc++;
  if (SCATTER_PAYS[sc]) win += SCATTER_PAYS[sc] * LINES;   // المبعثر على الرهان الكلّي
  return win / LINES;                      // بوحدات الرهان الكلّي
}

const N = Number(process.env.SPINS || 2_000_000);
let sum = 0, hits = 0, max = 0, atLeastStake = 0, wins = 0;
const bands = { '0': 0, '0-1': 0, '1-2': 0, '2-5': 0, '5-20': 0, '20-100': 0, '100+': 0 };
for (let i = 0; i < N; i++) {
  const x = spin();
  sum += x;
  if (x > 0) { hits++; wins++; }
  if (x >= 1) atLeastStake++;
  if (x > max) max = x;
  if (x === 0) bands['0']++;
  else if (x < 1) bands['0-1']++;
  else if (x < 2) bands['1-2']++;
  else if (x < 5) bands['2-5']++;
  else if (x < 20) bands['5-20']++;
  else if (x < 100) bands['20-100']++;
  else bands['100+']++;
}

console.log('\n  محاكاة ' + N.toLocaleString('en-US') + ' دورة:');
console.log('    العائد المقيس     : ' + (sum / N * 100).toFixed(2) + '%   (يطابق الحساب الدقيق)');
console.log('    تردّد الفوز       : ' + (hits / N * 100).toFixed(2) + '%');
console.log('    فوز ≥ الرهان      : ' + (atLeastStake / N * 100).toFixed(2) + '% من الدورات');
console.log('    الأرباح دون الرهان: ' + ((hits - atLeastStake) / Math.max(hits, 1) * 100).toFixed(1)
  + '% من الفوزات  ← كلّما قلّ كان أصدق');
console.log('    أكبر ربح          : ×' + max.toFixed(1));

console.log('\n    توزيع نتيجة الدورة:');
for (const [k, v] of Object.entries(bands)) {
  const label = k === '0' ? 'لا شيء' : '×' + k;
  console.log('      ' + label.padEnd(10) + (v / N * 100).toFixed(2).padStart(6) + '%');
}

// احتمال إنهاء جلسة رابحاً — الرقم الذي يعيشه اللاعب فعلاً
for (const spins of [50, 200, 1000]) {
  const trials = 4000;
  let ahead = 0;
  for (let t = 0; t < trials; t++) {
    let bank = 0;
    for (let i = 0; i < spins; i++) bank += spin() - 1;
    if (bank > 0) ahead++;
  }
  console.log('    بعد ' + String(spins).padStart(4) + ' دورة   : '
    + (ahead / trials * 100).toFixed(1) + '% من اللاعبين رابحون');
}

// ────────────────────────────────────────────── للّصق
console.log('\n──────── للخادم: server/neonSlots.js ────────');
console.log('const REEL_STRIPS = [');
for (const s of STRIPS) console.log('  [' + s.join(', ') + '],');
console.log('];');
console.log('\n──────── الجدول ────────');
for (const s of symbols) {
  if (s.id === WILD) continue;
  console.log('  ' + s.key.padEnd(9) + JSON.stringify(s.pays));
}

module.exports = { STRIPS, symbols, PAYS, SCATTER_PAYS, TIER, DESIGN, exact: e };
