'use strict';

/**
 * قياس عائد «ماتادور فييستا» بالمحاكاة.
 *
 *   node tools/tuneMatador.js [لفات اللعب العادي] [جولات الشراء] [--calibrate]
 *
 * يطبع: العائد الكلّي، حصّة اللعب العادي واللفات المجانية والجاكبوت، تكرار
 * اللفات المجانية، عائد الشراء، ونسبة الفوز. --calibrate يطبع جدول المعايرة
 * لعائد الإدارة (BASE_CALIBRATION في server/matador.js).
 */

const H = require('../server/matador');

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

/** قيمة الجاكبوت المتوقّعة لكل لفة عادية (ثابتة، لا تتأثّر بالمعامل). */
const JACKPOT_EV = H.JACKPOTS.reduce((a, j) => a + j.x * j.p, 0);

function run(n, buy, seed, raw = null) {
  const rng = mulberry32(seed);
  let total = 0, baseOnly = 0, fsWin = 0, jpWin = 0, triggers = 0, capped = 0, hits = 0, lineHits = 0;
  let sumSq = 0, fsSpins = 0, maxX = 0, big = 0, cascades = 0, maxCascade = 0, subBet = 0, floored = 0, jps = 0;
  for (let i = 0; i < n; i++) {
    const r = H.playRound({ buy, rng });
    total += r.total;
    sumSq += r.total * r.total;
    baseOnly += r.base.win;
    if (r.jackpot) { jpWin += r.jackpot.win; jps++; }
    if (raw) raw[i] = r.base.win - (r.base.floor || 0);
    if (!buy && r.base.win > 0 && r.base.win < H.MIN_SPIN_WIN_X - 1e-9) subBet++;
    if (r.base.floor) floored++;
    if (r.base.win > 0) lineHits++;
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
    baseRtp: baseOnly / n / cost, fsRtp: fsWin / n / cost, jpRtp: jpWin / n / cost, jps,
    trigger: triggers / n, fsAvg: triggers ? fsWin / triggers : 0, fsSpinsAvg: triggers ? fsSpins / triggers : 0,
    hit: hits / n, lineHit: lineHits / n, floored: floored / n, maxX, big: big / n, capped: capped / n,
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
  console.log(`  العائد ${pct(b.rtp)} ± ${pct(1.96 * b.se)}   (عادي ${pct(b.baseRtp)} + مجانية ${pct(b.fsRtp)} + جاكبوت ${pct(b.jpRtp)} [نظري ${pct(JACKPOT_EV)}])`);
  console.log(`  نسبة الفوز ${pct(b.lineHit)} (منها رُفعت للرهان ${pct(b.floored)}) · مجانية كل ${Math.round(1 / b.trigger)} لفة · متوسّطها ${b.fsAvg.toFixed(1)}× في ${b.fsSpinsAvg.toFixed(1)} لفة`);
  console.log(`  انهيارات/لفة ${b.cascadesAvg.toFixed(2)} (أقصى ${b.maxCascade}) · ≥100× كل ${b.big ? Math.round(1 / b.big) : '—'} · أقصى ${b.maxX.toFixed(0)}× · السقف ${b.capped}`);
  const s = run(NB, true, 999);
  console.log(`الشراء (${NB.toLocaleString()} جولة بـ ${H.BUY_COST_X}×):`);
  console.log(`  العائد ${pct(s.rtp)} ± ${pct(1.96 * s.se)} · متوسّط ${(s.rtp * H.BUY_COST_X).toFixed(1)}× · أقصى ${s.maxX.toFixed(0)}× · السقف ${s.capped}`);
  // تقدير أدقّ للعائد الكلّي: اللعب العادي بلا مجانية (تباين صغير) + تكرار
  // المجانية × قيمتها من جولات الشراء + الجاكبوت النظري
  const fsValue = s.rtp * H.BUY_COST_X - s.baseRtp * H.BUY_COST_X;
  const est = b.baseRtp + b.trigger * fsValue + JACKPOT_EV;
  console.log(`تقدير مُفكّك: ${pct(est)} = ${pct(b.baseRtp)} + (1/${Math.round(1 / b.trigger)}) × ${fsValue.toFixed(1)}× + ${pct(JACKPOT_EV)}`);
  console.log(`لفات رابحة بأقل من الرهان: ${b.subBet} (يجب 0)`);
  if (process.argv.includes('--calibrate')) {
    // العائد عند كل معامل: الحدّ الأدنى والجاكبوت ثابتان، والباقي يتناسب مع المعامل
    const raw = new Float64Array(N);
    const c = run(N, false, 54321, raw);
    const rows = [];
    for (let k = 0.6; k <= 1.301; k += 0.05) {
      let sum = 0;
      for (let i = 0; i < N; i++) if (raw[i] > 0) sum += Math.max(k * raw[i], H.MIN_SPIN_WIN_X);
      rows.push([Number(k.toFixed(2)), (sum / N + c.trigger * k * fsValue + JACKPOT_EV) * 100]);
    }
    // مُزاح ليطابق 96.0% عند المعامل 1 (المقيس مُفكّكاً أعلاه)
    const at1 = rows.find(([k]) => k === 1)[1];
    const shift = est * 100 - at1;
    console.log('BASE_CALIBRATION = ' + JSON.stringify(rows.map(([k, r]) => [k, Number((r + shift).toFixed(1))])));
  }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} ث)`);
}

module.exports = { run, mulberry32, JACKPOT_EV };
