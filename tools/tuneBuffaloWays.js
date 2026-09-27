'use strict';

/**
 * قياس عائد «بافالو وايز 3600» بالمحاكاة.
 *
 *   node tools/tuneBuffaloWays.js [لفات اللعب العادي] [جولات الشراء]
 *
 * يطبع: العائد الكلّي، حصّة اللعب العادي وحصّة اللفات المجانية، تكرار
 * اللفات المجانية، عائد الشراء، وتوزيع الأرباح الكبيرة وأثر السقف.
 */

const H = require('../server/buffaloWays');

// مولّد سريع قابل للتكرار (mulberry32) — للمحاكاة فقط
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(n, buy, seed, raw = null) {
  const rng = mulberry32(seed);
  let total = 0, baseOnly = 0, fsWin = 0, triggers = 0, capped = 0, hits = 0;
  let sumSq = 0, fsSpins = 0, maxX = 0, big = 0, cascades = 0, maxCascade = 0, subBet = 0;
  for (let i = 0; i < n; i++) {
    const r = H.playRound({ buy, rng });
    total += r.total;
    sumSq += r.total * r.total;
    baseOnly += r.base.win;
    if (raw) raw[i] = r.base.win - (r.base.floor || 0);
    if (!buy && r.base.win > 0 && r.base.win < H.MIN_SPIN_WIN_X - 1e-9) subBet++;
    if (r.total > 0) hits++;
    if (r.total > maxX) maxX = r.total;
    if (r.total >= 100) big++;
    if (r.capped) capped++;
    cascades += r.base.steps.length;
    if (r.base.steps.length > maxCascade) maxCascade = r.base.steps.length;
    if (r.feature) {
      triggers++;
      fsWin += r.feature.win;
      fsSpins += r.feature.spins.length;
    }
  }
  const cost = buy ? H.BUY_COST_X : 1;
  const mean = total / n;
  const sd = Math.sqrt(sumSq / n - mean * mean);
  return {
    n, rtp: mean / cost, se: sd / Math.sqrt(n) / cost,
    baseRtp: baseOnly / n / cost, fsRtp: fsWin / n / cost,
    trigger: triggers / n, fsAvg: triggers ? fsWin / triggers : 0, fsSpinsAvg: triggers ? fsSpins / triggers : 0,
    hit: hits / n, maxX, big: big / n, capped: capped / n,
    cascadesAvg: cascades / n, maxCascade, subBet
  };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

if (require.main === module) {
  const N = Number(process.argv[2] || 400000);
  const NB = Number(process.argv[3] || 40000);

  const t0 = Date.now();
  const b = run(N, false, 12345);
  console.log(`اللعب العادي (${N.toLocaleString()} لفة):`);
  console.log(`  العائد ${pct(b.rtp)} ± ${pct(1.96 * b.se)}   (عادي ${pct(b.baseRtp)} + مجانية ${pct(b.fsRtp)})`);
  console.log(`  نسبة الفوز ${pct(b.hit)} · مجانية كل ${Math.round(1 / b.trigger)} لفة · متوسّطها ${b.fsAvg.toFixed(1)}× في ${b.fsSpinsAvg.toFixed(1)} لفة`);
  console.log(`  انهيارات/لفة ${b.cascadesAvg.toFixed(2)} (أقصى ${b.maxCascade}) · ≥100× كل ${b.big ? Math.round(1 / b.big) : '—'} · أقصى ${b.maxX.toFixed(0)}× · السقف ${b.capped}`);
  const s = run(NB, true, 999);
  console.log(`الشراء (${NB.toLocaleString()} جولة بـ ${H.BUY_COST_X}×):`);
  console.log(`  العائد ${pct(s.rtp)} ± ${pct(1.96 * s.se)} · متوسّط ${(s.rtp * H.BUY_COST_X).toFixed(1)}× · أقصى ${s.maxX.toFixed(0)}× · السقف ${s.capped}`);
  // تقدير أدقّ للعائد الكلّي: اللعب العادي بلا مجانية (تباين صغير) + تكرار
  // المجانية × قيمتها من جولات الشراء (عدد جلسات أكبر بكثير)
  const fsValue = s.rtp * H.BUY_COST_X - s.baseRtp * H.BUY_COST_X;
  console.log(`تقدير مُفكّك: ${pct(b.baseRtp + b.trigger * fsValue)} = ${pct(b.baseRtp)} + (1/${Math.round(1 / b.trigger)}) × ${fsValue.toFixed(1)}×`);
  console.log(`لفات رابحة بأقل من الرهان: ${b.subBet} (يجب 0)`);
  if (process.argv.includes('--calibrate')) {
    // العائد عند كل معامل: الحدّ الأدنى ثابت (رهان) والباقي يتناسب مع المعامل
    const raw = new Float64Array(N);
    const c = run(N, false, 54321, raw);
    const rows = [];
    for (let k = 0.6; k <= 1.301; k += 0.05) {
      let sum = 0;
      for (let i = 0; i < N; i++) if (raw[i] > 0) sum += Math.max(k * raw[i], H.MIN_SPIN_WIN_X);
      rows.push([Number(k.toFixed(2)), Number(((sum / N + c.trigger * k * fsValue) * 100).toFixed(1))]);
    }
    console.log('BASE_CALIBRATION = ' + JSON.stringify(rows));
  }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} ث)`);
}

module.exports = { run, mulberry32 };
