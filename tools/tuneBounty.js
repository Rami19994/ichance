'use strict';

/**
 * ضبط رياضيات «صيّاد الجوائز».
 *
 * ── لماذا لا نكتفي بمحاكاة الجولات كما هي
 * تذبذب الجولة الواحدة هنا ×9.6 من الرهان (الميزة تتراكم عبر عشرات الدورات
 * بمضاعف يصل ×1024). فمحاكاة 150 ألف جولة تعطي عائداً يرتجف ±2.5 نقطة —
 * لا يصلح لضبط هامش الموقع بدقّة نصف نقطة.
 *
 * الحلّ تفكيك العائد إلى جزأين يُقاس كلٌّ بما يناسبه:
 *
 *     العائد = عائد الدورة الأساسية + احتمال فتح الميزة × قيمة الميزة
 *
 *   • الدورة الأساسية قليلة التذبذب: ملايين الدورات تكفي لدقّة عالية.
 *   • الميزة نادرة (1 من 200) لكننا نحاكيها **مباشرة** مئات الآلاف من
 *     المرّات بدل انتظار أن تُفتح صدفةً.
 *
 * ── الرافعة
 * كل الأرباح = الجدول × عدد الطرق × المضاعف، فالعائد خطّي في الجدول
 * (عدا ما يقصّه السقف، وهو نادر جداً). فنقيس عند الجدول الحالي ونحلّ
 * لمعامل واحد، ثم نقرّب الجدول لأعداد صحيحة ونعيد القياس للتأكّد.
 *
 * ── مطابقة الإنتاج
 * حلقة الميزة هنا نسخة من server/slotSession.js: سقف الجلسة يُحسب على
 * أرباح الميزة وحدها، وإعادة الفتح محدودة بسقف الدورات الممنوحة.
 */

const slots = require('../server/slots');

const TARGET_RTP = 0.96;
const BET = 1024;             // مضاعف لـ1024 طريقة فتبقى الحسابات صحيحة

// مولّد سريع للقياس — الإنتاج يستعمل تيّار sha256 لإثبات العدالة، وهو هنا
// عبء بلا فائدة: المطلوب توزيع إحصائي لا قابلية تحقّق.
let seed = (Date.now() ^ 0x5bd1e995) | 0 || 1;
function next() {
  seed ^= seed << 13; seed |= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed |= 0;
  return seed >>> 0;
}

function grid(free) {
  const strips = free ? slots.FREE_STRIPS : slots.STRIPS;
  const g = [];
  for (let r = 0; r < slots.REELS; r++) {
    const s = strips[r];
    const stop = next() % s.length;
    const col = [];
    for (let row = 0; row < slots.ROWS; row++) col.push(s[(stop + row) % s.length]);
    g.push(col);
  }
  return g;
}

/** دورة كما في slots.playSpin: تقييم ثم سقف الدورة ثم تقريب. */
function spinWin(free, mult) {
  const g = grid(free);
  const r = slots.evaluate(g, BET, free ? mult : 1);
  return { win: Math.round(slots.capWin(r.total, BET)), scatters: r.scatters };
}

/** ميزة كاملة كما في slotSession.freeSpin — تعيد مجموعها بوحدات الرهان. */
function runFeature(granted) {
  let spinsLeft = granted, spinsGranted = granted;
  let mult = 1, total = 0;
  const cap = slots.MAX_SESSION_MULTIPLIER * BET;
  while (spinsLeft > 0) {
    const r = spinWin(true, mult);
    const win = Math.min(r.win, Math.max(0, cap - total));
    total += win;
    spinsLeft--;
    mult = slots.stepMultiplier(mult, win);
    if (r.scatters >= 3 && spinsGranted < slots.FREE_SPINS.maxTotal) {
      const add = Math.min(slots.FREE_SPINS.retrigger, slots.FREE_SPINS.maxTotal - spinsGranted);
      spinsLeft += add; spinsGranted += add;
    }
    if (total >= cap) break;
  }
  return total / BET;
}

/** يقيس العائد بأجزائه. */
function measure({ baseSpins, features }) {
  // 1) الدورة الأساسية + تكرار فتح الميزة وتوزيع عدد دوراتها
  let baseSum = 0, hits = 0;
  const trig = new Map();                  // عدد الدورات الممنوحة → مرّات
  for (let i = 0; i < baseSpins; i++) {
    const r = spinWin(false, 1);
    baseSum += r.win;
    if (r.win > 0) hits++;
    const g = slots.freeSpinsFor(r.scatters);
    if (g > 0) trig.set(g, (trig.get(g) || 0) + 1);
  }
  const baseRtp = baseSum / baseSpins / BET;
  let pTrig = 0;
  for (const n of trig.values()) pTrig += n;
  pTrig /= baseSpins;

  // 2) قيمة الميزة لكل عدد دورات ممنوح — موزونة بتكرار كل حالة
  let featureEv = 0, featureSq = 0, totalTrig = 0;
  for (const [g, n] of trig) totalTrig += n;
  for (const [g, n] of trig) {
    const share = n / totalTrig;
    const runs = Math.max(2000, Math.round(features * share));
    let s = 0, sq = 0;
    for (let i = 0; i < runs; i++) { const x = runFeature(g); s += x; sq += x * x; }
    featureEv += share * (s / runs);
    featureSq += share * (sq / runs);
  }
  // قيمة الميزة المشتراة: تمنح دائماً FREE_SPINS.base دورات
  let buySum = 0;
  const buyRuns = features;
  for (let i = 0; i < buyRuns; i++) buySum += runFeature(slots.FREE_SPINS.base);
  const buyEv = buySum / buyRuns;

  return {
    baseRtp, pTrig, featureEv, buyEv,
    featureSd: Math.sqrt(featureSq - featureEv * featureEv),
    rtp: baseRtp + pTrig * featureEv,
    hitRate: hits / baseSpins,
    featureOdds: 1 / pTrig
  };
}

function setScale(orig, k) {
  for (const key of Object.keys(orig)) {
    for (const n of Object.keys(orig[key])) {
      slots.PAYTABLE[key][n] = Math.round(orig[key][n] * k);
    }
  }
}

// ─────────────────────────────────────────────────────────── القياس
const ORIGINAL = JSON.parse(JSON.stringify(slots.PAYTABLE));

console.log('صيّاد الجوائز — القياس عند الجدول الحالي…');
const m0 = measure({ baseSpins: 3_000_000, features: 150_000 });
console.log('  عائد الدورة الأساسية : ' + (m0.baseRtp * 100).toFixed(2) + '%');
console.log('  فتح الميزة           : 1 من ' + m0.featureOdds.toFixed(0));
console.log('  قيمة الميزة          : ×' + m0.featureEv.toFixed(2) + ' (تذبذب ×' + m0.featureSd.toFixed(1) + ')');
console.log('  مساهمة الميزة        : ' + (m0.pTrig * m0.featureEv * 100).toFixed(2) + '%');
console.log('  العائد الكلّي         : ' + (m0.rtp * 100).toFixed(2) + '%');
console.log('  قيمة الميزة المشتراة : ×' + m0.buyEv.toFixed(2)
  + ' → عائد الشراء بالسعر الحالي ×' + slots.FEATURE_BUY_COST + ' = '
  + (m0.buyEv / slots.FEATURE_BUY_COST * 100).toFixed(1) + '%');

const k = TARGET_RTP / m0.rtp;
console.log('\n  المعامل المطلوب       : ×' + k.toFixed(4));

setScale(ORIGINAL, k);
console.log('\nإعادة القياس بالجدول الجديد (مقرّباً)…');
const m1 = measure({ baseSpins: 4_000_000, features: 200_000 });
console.log('  عائد الدورة الأساسية : ' + (m1.baseRtp * 100).toFixed(2) + '%');
console.log('  قيمة الميزة          : ×' + m1.featureEv.toFixed(2));
console.log('  العائد الكلّي         : ' + (m1.rtp * 100).toFixed(2) + '%');
console.log('  تردّد الفوز           : ' + (m1.hitRate * 100).toFixed(1) + '%');
console.log('  فتح الميزة           : 1 من ' + m1.featureOdds.toFixed(0));

// سعر شراء عادل: يعطي نفس عائد اللعبة. نقرّبه للأعلى كي لا يتجاوز العائدُ الهدف
const fairBuy = Math.ceil(m1.buyEv / TARGET_RTP);
console.log('  قيمة الميزة المشتراة : ×' + m1.buyEv.toFixed(2)
  + ' → سعر عادل ×' + fairBuy + ' (عائد الشراء ' + (m1.buyEv / fairBuy * 100).toFixed(1) + '%)');

console.log('\n  الجدول الجديد:');
for (const [key, pays] of Object.entries(slots.PAYTABLE)) {
  console.log('    ' + key.padEnd(8) + JSON.stringify(ORIGINAL[key]) + '  →  ' + JSON.stringify(pays));
}

module.exports = { m0, m1, k, fairBuy, PAYTABLE: slots.PAYTABLE };
