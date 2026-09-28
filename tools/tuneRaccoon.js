'use strict';

/**
 * قياس عائد «راكون الكونغ فو» بالمحاكاة — اللعب العادي و«فرصة ×2» والشراء.
 *
 *   node tools/tuneRaccoon.js [لفات] [جولات الشراء] [--calibrate]
 *
 * --calibrate يطبع جدولي المعايرة لعائد الإدارة (BASE_CALIBRATION و
 * ANTE_CALIBRATION في server/raccoon.js): الحدّ الأدنى والجاكبوت ثابتان
 * والباقي يتناسب مع المعامل.
 */

const H = require('../server/raccoon');

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

const JACKPOT_EV = H.JACKPOTS.reduce((a, j) => a + j.x * j.p, 0);

/** raw: لكل جولة [ربح اللفة قبل الحدّ الأدنى, ربح المجانية] — للمعايرة. */
function run(n, mode, seed, raw = null) {
  const rng = mulberry32(seed);
  let total = 0, sumSq = 0, baseWin = 0, fsWin = 0, jpWin = 0, triggers = 0, hits = 0, floored = 0, subBet = 0, maxX = 0, capped = 0, big = 0;
  for (let i = 0; i < n; i++) {
    const r = H.playRound({ mode, rng });
    total += r.total;
    sumSq += r.total * r.total;
    if (r.base) {
      baseWin += r.base.win;
      if (r.base.win > 0) hits++;
      if (r.base.floor) floored++;
      if (r.base.win > 0 && r.base.win < r.cost - 1e-9) subBet++;
    }
    if (r.feature) { triggers++; fsWin += r.feature.win; }
    if (r.jackpot) jpWin += r.jackpot.win;
    if (raw) { raw[2 * i] = r.base ? r.base.win - (r.base.floor || 0) : 0; raw[2 * i + 1] = r.feature ? r.feature.win : 0; }
    if (r.total > maxX) maxX = r.total;
    if (r.total >= 100) big++;
    if (r.capped) capped++;
  }
  const cost = mode === 'buy' ? H.BUY_COST_X : mode === 'ante' ? H.ANTE_COST_X : 1;
  const mean = total / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return {
    n, cost, rtp: mean / cost, se: sd / Math.sqrt(n) / cost,
    baseRtp: baseWin / n / cost, fsRtp: fsWin / n / cost, jpRtp: jpWin / n / cost,
    trigger: triggers / n, fsAvg: triggers ? fsWin / triggers : 0,
    hit: hits / n, floored: floored / n, subBet, maxX, capped: capped / n, big: big / n
  };
}

function calibrate(n, mode, seed) {
  const raw = new Float64Array(2 * n);
  const c = run(n, mode, seed, raw);
  const floor = H.MIN_SPIN_WIN_X * c.cost;
  const rows = [];
  for (let k = 0.6; k <= 1.301; k += 0.05) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const b = raw[2 * i];
      if (b > 0) sum += Math.max(k * b, floor);
      sum += k * raw[2 * i + 1];
    }
    rows.push([Number(k.toFixed(2)), (sum / n + JACKPOT_EV) / c.cost * 100]);
  }
  return rows;
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

if (require.main === module) {
  const N = Number(process.argv[2] || 400000);
  const NB = Number(process.argv[3] || 40000);
  const t0 = Date.now();
  for (const [mode, seed] of [['base', 11], ['ante', 22]]) {
    const b = run(N, mode, seed);
    console.log(`${mode === 'base' ? 'اللعب العادي' : `فرصة ×2 (${H.ANTE_COST_X}× الرهان)`} — ${N.toLocaleString()} لفة:`);
    console.log(`  العائد ${pct(b.rtp)} ± ${pct(1.96 * b.se)}   (لفات ${pct(b.baseRtp)} + مجانية ${pct(b.fsRtp)} + جاكبوت ${pct(b.jpRtp)} [نظري ${pct(JACKPOT_EV / b.cost)}])`);
    console.log(`  الفوز ${pct(b.hit)} (رُفع للحدّ الأدنى ${pct(b.floored)}) · مجانية كل ${Math.round(1 / b.trigger)} لفة × ${b.fsAvg.toFixed(1)}× · ≥100× كل ${b.big ? Math.round(1 / b.big) : '—'} · أقصى ${b.maxX.toFixed(0)}× · أقل من المدفوع: ${b.subBet} (يجب 0)`);
  }
  const s = run(NB, 'buy', 33);
  console.log(`الشراء (${NB.toLocaleString()} جولة بـ ${H.BUY_COST_X}×): العائد ${pct(s.rtp)} ± ${pct(1.96 * s.se)} · متوسّط ${(s.rtp * H.BUY_COST_X).toFixed(1)}× · أقصى ${s.maxX.toFixed(0)}×`);
  if (process.argv.includes('--calibrate')) {
    const fmt = (rows) => JSON.stringify(rows.map(([k, r]) => [k, Number(r.toFixed(1))]));
    console.log('BASE_CALIBRATION = ' + fmt(calibrate(N, 'base', 44)));
    console.log('ANTE_CALIBRATION = ' + fmt(calibrate(N, 'ante', 55)));
  }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} ث)`);
}

module.exports = { run, mulberry32, JACKPOT_EV, calibrate };
