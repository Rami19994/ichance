'use strict';

const crypto = require('crypto');
const siteConfig = require('./siteConfig');

/**
 * بافالو وايز 3600 — سلوت «طرق» بانهيار الرموز ومضاعف يتضاعف.
 *
 * الشبكة 6 بكرات بارتفاعات 3-4-5-5-4-3 = 3600 طريقة فوز، من اليسار لليمين،
 * 4 بكرات متتالية على الأقل. الرموز الفائزة تنفجر وتسقط رموز جديدة مكانها
 * (انهيار)، ومع كل انهيار يتضاعف المضاعف: ×1 ← ×2 ← ×4 … ← ×1024.
 *
 *   ذهبي   رمز عادي بإطار ذهبي، في البكرتين 3 و4 فقط. إن دخل ربحاً لا ينفجر
 *          بل يتحوّل إلى WILD مكانه.
 *   WILD   يعوّض كل رمز عدا السكاتر، وينفجر إن دخل ربحاً.
 *   سكاتر  3 فأكثر في أي مكان بعد انتهاء الانهيارات ← لفات مجانية
 *          (12 + 2 لكل سكاتر زائد). في اللفات المجانية يبدأ المضاعف من ×4،
 *          والذهبي أكثر، و3 سكاتر تضيف لفات.
 *   الشراء  75× الرهان: لفة بثلاثة سكاتر مضمونة ثم اللفات المجانية.
 *
 * السقف: ربح الجولة كلها (مع اللفات المجانية) لا يتجاوز MAX_WIN_X × الرهان.
 * الحدّ الأدنى: اللفة العادية الرابحة تدفع الرهان كاملاً على الأقل.
 *
 * كل شيء يُحسم في الخادم دفعة واحدة؛ الواجهة تعرض الخطوات المرسلة فقط.
 * العائد 96% في اللعب العادي وفي الشراء — مُقاس بالمحاكاة (3 ملايين لفة +
 * 500 ألف شراء): عادي 96.1% (بلا مجانية 62.7% + مجانية كل ~216 لفة × 72)،
 * شراء 96.5% ±0.8، الفوز في 31% من اللفات، ولا لفة رابحة بأقل من الرهان:
 *   node tools/tuneBuffaloWays.js 3000000 500000 --calibrate
 */

const GAME_ID = 'buffalo-ways';
const REELS = [3, 4, 5, 5, 4, 3];
const NREELS = REELS.length;
const GOLD_REELS = [2, 3];

// الرموز: 0..7 دافعة، 8 WILD، 9 SCATTER
const SYM = ['bison', 'huntress', 'wolf', 'eagle', 'A', 'K', 'Q', 'J', 'wild', 'scatter'];
const WILD = 8;
const SCAT = 9;
const PAYING = 8;

/**
 * لا ربح أقل من الرهان (طلب المالك: «راهنت بـ1000 فلا أربح أقل من 1000»):
 *   • الفوز من 4 بكرات متتالية على الأقل — كانت 3 تكفي فكان 84% من اللفات
 *     الرابحة يدفع أقل من الرهان (متوسّطها 0.21×): خسارة بثوب فوز.
 *   • اللفة الرابحة (اللعب العادي) تدفع الرهان كاملاً على الأقل؛ الواجهة لا
 *     تعرض مجموعاً أقل منه أبداً.
 * ثم أُعيد ضبط الجدول والسكاتر لتبقى النسبة 96% (tools/tuneBuffaloWays.js).
 */
const MIN_REELS = 4;
const MIN_SPIN_WIN_X = 1;

/** دفع الطريقة الواحدة بمضاعفات الرهان الكلّي — العمود 0 (3 بكرات) لم يعد يُدفع. */
const PAY_SCALE = 0.1263;
const PAYS_REL = [
  [1.00, 2.00, 4.00, 8.00],   // البافالو
  [0.80, 1.60, 3.00, 6.00],   // الصيّادة
  [0.60, 1.20, 2.40, 4.80],   // الذئب
  [0.50, 1.00, 2.00, 4.00],   // النسر
  [0.30, 0.50, 1.00, 2.00],   // A
  [0.30, 0.50, 1.00, 2.00],   // K
  [0.20, 0.40, 0.80, 1.50],   // Q
  [0.20, 0.40, 0.80, 1.50]    // J
];
const PAYS = PAYS_REL.map((row) => row.map((v) => v * PAY_SCALE));

/** أوزان الرموز الدافعة لكل خلية (مستقلّة)، ثم احتمال السكاتر والذهبي. */
const WEIGHTS = [5, 6, 7, 8, 11, 12, 13, 14];
const MODES = {
  base: { scatter: 0.0126, gold: 0.14, startMult: 1 },
  fs: { scatter: 0.0105, gold: 0.50, startMult: 4 },
  buy: { scatter: 0.0126, gold: 0.14, startMult: 1 }
};
const MULTS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const MAX_MULT = 1024;
const FS_AWARD = (n) => 12 + 2 * Math.max(0, n - 3);
const FS_RETRIGGER = (n) => 5 + 2 * Math.max(0, n - 3);
const MAX_FREE_SPINS = 100;
const BUY_COST_X = 75;
const MAX_WIN_X = 5000;

const BETS = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000];
const MIN_BET = BETS[0];
const MAX_BET = BETS[BETS.length - 1];

/** العائد المُقاس (انظر tools/tuneBuffaloWays.js) — للإدارة فقط، لا يُرسل للاعب. */
const RTP = 0.96;

const WEIGHT_TOTAL = WEIGHTS.reduce((a, b) => a + b, 0);

/** مولّد التشفير الافتراضي: عدد في [0,1). المحاكاة تمرّر مولّداً أسرع. */
function cryptoRng() {
  return crypto.randomInt(0, 0x1000000) / 0x1000000;
}

function drawPaying(rng) {
  let x = rng() * WEIGHT_TOTAL;
  for (let s = 0; s < PAYING; s++) {
    x -= WEIGHTS[s];
    if (x < 0) return s;
  }
  return PAYING - 1;
}

/** خلية جديدة للبكرة c: { s, g } — g ذهبي. */
function drawCell(rng, c, mode) {
  const m = MODES[mode];
  if (rng() < m.scatter) return { s: SCAT, g: false };
  const s = drawPaying(rng);
  const g = GOLD_REELS.includes(c) && rng() < m.gold;
  return { s, g };
}

function newGrid(rng, mode) {
  const grid = [];
  for (let c = 0; c < NREELS; c++) {
    const col = [];
    for (let r = 0; r < REELS[c]; r++) col.push(drawCell(rng, c, mode));
    grid.push(col);
  }
  return grid;
}

/** شراء الميزة: 3 سكاتر مضمونة على 3 بكرات مختلفة، في خانات عشوائية. */
function forceScatters(rng, grid, count) {
  const reels = [0, 1, 2, 3, 4, 5];
  for (let i = reels.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [reels[i], reels[j]] = [reels[j], reels[i]];
  }
  let placed = countScatters(grid);
  for (const c of reels) {
    if (placed >= count) break;
    if (grid[c].some((x) => x.s === SCAT)) continue;
    const r = Math.floor(rng() * REELS[c]);
    grid[c][r] = { s: SCAT, g: false };
    placed++;
  }
}

function countScatters(grid) {
  let n = 0;
  for (const col of grid) for (const x of col) if (x.s === SCAT) n++;
  return n;
}

/**
 * أرباح الشبكة: لكل رمز دافع، البكرات المتتالية من اليسار التي فيها الرمز
 * أو WILD. يرجّع { wins, positions, pay } — pay بمضاعفات الرهان قبل المضاعف.
 */
function evaluate(grid) {
  const wins = [];
  const hit = grid.map((col) => new Array(col.length).fill(false));
  let pay = 0;
  for (let s = 0; s < PAYING; s++) {
    let ways = 1;
    let n = 0;
    for (let c = 0; c < NREELS; c++) {
      let k = 0;
      for (const x of grid[c]) if (x.s === s || x.s === WILD) k++;
      if (!k) break;
      ways *= k;
      n++;
    }
    if (n < MIN_REELS) continue;
    const p = PAYS[s][n - 3] * ways;
    pay += p;
    const cells = [];
    for (let c = 0; c < n; c++) {
      grid[c].forEach((x, r) => {
        if (x.s === s || x.s === WILD) { hit[c][r] = true; cells.push([c, r]); }
      });
    }
    wins.push({ symbol: SYM[s], reels: n, ways, pay: p, cells });
  }
  const positions = [];
  hit.forEach((col, c) => col.forEach((h, r) => { if (h) positions.push([c, r]); }));
  return { wins, positions, pay };
}

/**
 * انهيار واحد: الذهبي الفائز يصير WILD مكانه، والباقي الفائز ينفجر، ثم تسقط
 * الرموز المتبقية للأسفل وتُملأ من الأعلى. يرجّع ما تحتاجه الواجهة للعرض.
 */
function collapse(rng, grid, positions, mode) {
  const remove = grid.map((col) => new Array(col.length).fill(false));
  const transform = [];
  for (const [c, r] of positions) {
    const x = grid[c][r];
    if (x.g) {
      grid[c][r] = { s: WILD, g: false };
      transform.push([c, r]);
    } else {
      remove[c][r] = true;
    }
  }
  const drops = [];
  for (let c = 0; c < NREELS; c++) {
    const kept = grid[c].filter((_, r) => !remove[c][r]);
    const fresh = [];
    while (kept.length + fresh.length < REELS[c]) fresh.push(drawCell(rng, c, mode));
    grid[c] = fresh.concat(kept);
    drops.push(fresh.map(pub));
  }
  return { transform, drops };
}

const pub = (x) => (x.g ? { s: SYM[x.s], g: true } : { s: SYM[x.s] });
const pubGrid = (grid) => grid.map((col) => col.map(pub));

/**
 * لفة واحدة كاملة بكل انهياراتها. budget = ما بقي تحت السقف (بمضاعفات الرهان).
 * يرجّع { grid, steps, win, scatters, capped }.
 */
function playSpin(rng, mode, budget, { forced = 0 } = {}) {
  const grid = newGrid(rng, mode);
  if (forced) forceScatters(rng, grid, forced);
  const start = pubGrid(grid);
  const steps = [];
  let mult = MODES[mode].startMult;
  let win = 0;
  let capped = false;

  const MAX_STEPS = 50;
  for (let stepCount = 0; stepCount < MAX_STEPS; stepCount++) {
    const ev = evaluate(grid);
    if (!ev.positions.length) break;
    let stepWin = ev.pay * mult;
    if (win + stepWin >= budget) {
      stepWin = Math.max(0, budget - win);
      capped = true;
    }
    win += stepWin;
    const step = {
      mult,
      base: ev.pay,
      win: stepWin,
      total: win,
      wins: ev.wins.map((w) => ({ symbol: w.symbol, reels: w.reels, ways: w.ways, pay: w.pay, cells: w.cells })),
      positions: ev.positions
    };
    if (capped) { steps.push(step); break; }
    Object.assign(step, collapse(rng, grid, ev.positions, mode));
    steps.push(step);
    mult = Math.min(MAX_MULT, mult * 2);
  }
  return { grid: start, steps, win, scatters: countScatters(grid), capped };
}

/**
 * جولة كاملة: اللفة (أو لفة الشراء) ثم اللفات المجانية إن وُجدت.
 * كل المبالغ هنا بمضاعفات الرهان. rng افتراضياً مولّد التشفير.
 */
function playRound({ buy = false, rng = cryptoRng, scale = 1 } = {}) {
  let budget = MAX_WIN_X;
  const base = playSpin(rng, buy ? 'buy' : 'base', budget, { forced: buy ? 3 : 0 });
  // الحدّ الأدنى للّفة الرابحة: الرهان كاملاً بعد معامل العائد (scale) — بمضاعفات
  // الرهان قبل المعامل هو 1/scale، فيصير بالضبط رهاناً واحداً عند الصرف
  const floorX = MIN_SPIN_WIN_X / scale;
  if (!buy && base.win > 0 && base.win < floorX) {
    base.floor = floorX - base.win;
    base.win = floorX;
  }
  budget -= base.win;
  let total = base.win;
  let capped = base.capped;

  let feature = null;
  if (!capped && base.scatters >= 3) {
    let left = FS_AWARD(base.scatters);
    const awarded = left;
    const spins = [];
    let fsWin = 0;
    while (left > 0 && spins.length < MAX_FREE_SPINS) {
      left--;
      const s = playSpin(rng, 'fs', budget);
      budget -= s.win;
      fsWin += s.win;
      let extra = 0;
      if (!s.capped && s.scatters >= 3) {
        extra = Math.min(FS_RETRIGGER(s.scatters), MAX_FREE_SPINS - spins.length - 1 - left);
        left += Math.max(0, extra);
      }
      spins.push({ ...s, retrigger: extra > 0 ? extra : 0 });
      if (s.capped) { capped = true; break; }
    }
    total += fsWin;
    feature = { awarded, spins, win: fsWin };
  }
  return { base, feature, total, capped };
}

// ─────────────────────────────────────────────────────────── بالمال

/** يحوّل مبالغ الجولة (مضاعفات) إلى عملة: أرقام صحيحة، والمجموع = ما يُدفع. */
function toMoney(round, bet, rtpScale = 1.0) {
  const scale = Number.isFinite(rtpScale) && rtpScale > 0 ? rtpScale : 1.0;
  const m = (x) => Math.floor(x * bet * scale + 1e-7);
  const spinOut = (s) => ({
    grid: s.grid,
    scatters: s.scatters,
    retrigger: s.retrigger || 0,
    win: m(s.win),
    steps: s.steps.map((st) => ({
      mult: st.mult,
      base: m(st.base),
      win: m(st.win),
      wins: st.wins.map((w) => ({ symbol: w.symbol, reels: w.reels, ways: w.ways, pay: m(w.pay), cells: w.cells })),
      positions: st.positions,
      transform: st.transform || [],
      drops: st.drops || null
    }))
  });
  return {
    base: spinOut(round.base),
    feature: round.feature
      ? { awarded: round.feature.awarded, win: m(round.feature.win), spins: round.feature.spins.map(spinOut) }
      : null,
    win: m(round.total),
    capped: round.capped
  };
}

function checkBet(raw) {
  const bet = Math.floor(Number(raw));
  if (!Number.isFinite(bet) || !BETS.includes(bet)) {
    return { ok: false, error: `اختر رهاناً من القائمة (${MIN_BET.toLocaleString('en-US')} – ${MAX_BET.toLocaleString('en-US')})` };
  }
  return { ok: true, bet };
}

/** جولة بمال حقيقي: خصم، حسم، صرف، تسجيل. */
async function spin(player, { bet: rawBet, buy = false } = {}) {
  const store = require('./store');
  const b = checkBet(rawBet);
  if (!b.ok) return b;
  const bet = b.bet;
  const cost = buy ? bet * BUY_COST_X : bet;
  if (player.balance < cost) return { ok: false, error: 'رصيدك لا يكفي' };

  const id = crypto.randomBytes(8).toString('hex');
  if (!(await store.gameDebit(GAME_ID, player, cost, `${GAME_ID}-${id}-bet`))) {
    return { ok: false, error: 'تعذّر خصم الرهان — حاول مجدداً' };
  }
  const rtpScale = scaleFor(!!buy);
  const out = toMoney(playRound({ buy: !!buy, scale: rtpScale }), bet, rtpScale);
  if (out.win > 0) {
    await store.gameCredit(GAME_ID, player, out.win, `${GAME_ID}-${id}-win`);
  }
  store.recordBuffaloWays(player, {
    bet: cost, win: out.win, buy: !!buy,
    freeSpins: out.feature ? out.feature.spins.length : 0,
    multiplier: cost > 0 ? out.win / cost : 0
  });
  return { ok: true, id, bet, cost, buy: !!buy, ...out, balance: player.balance };
}

/** تجربة بلا مال: المحرّك نفسه، لا خصم ولا تسجيل. */
function demo({ bet: rawBet, buy = false } = {}) {
  const b = checkBet(rawBet);
  if (!b.ok) return b;
  const cost = buy ? b.bet * BUY_COST_X : b.bet;
  const rtpScale = scaleFor(!!buy);
  return { ok: true, demo: true, bet: b.bet, cost, buy: !!buy, ...toMoney(playRound({ buy: !!buy, scale: rtpScale }), b.bet, rtpScale) };
}

/**
 * العائد المضبوط من الإدارة (افتراضياً 96%) ← معامل الأرباح.
 * الشراء: كل ربحه من اللفات المجانية (بلا حدّ أدنى) فالعائد خطّي: target/96.
 * اللعب العادي: الحدّ الأدنى للّفة الرابحة ثابت (رهان كامل) مهما كان المعامل،
 * فالعائد ليس خطّياً فيه — نعكس جدول معايرة مقيساً بالمحاكاة.
 */
const BASE_CALIBRATION = [
  // [معامل, العائد % عند هذا المعامل] — tools/tuneBuffaloWays.js --calibrate
  // (3 ملايين لفة؛ مُزاح ليطابق 96.0% عند المعامل 1 وهو المقيس مُفكَّكاً)
  [0.60, 66.9], [0.65, 70.4], [0.70, 74.0], [0.75, 77.6], [0.80, 81.2], [0.85, 84.9], [0.90, 88.6],
  [0.95, 92.3], [1.00, 96.0], [1.05, 99.7], [1.10, 103.5], [1.15, 107.3], [1.20, 111.0], [1.25, 114.8], [1.30, 118.6]
];
function baseScaleFor(target) {
  const t = BASE_CALIBRATION;
  if (target <= t[0][1]) return t[0][0];
  if (target >= t[t.length - 1][1]) return t[t.length - 1][0];
  for (let i = 1; i < t.length; i++) {
    if (target <= t[i][1]) {
      const [s0, r0] = t[i - 1];
      const [s1, r1] = t[i];
      return s0 + ((target - r0) / (r1 - r0)) * (s1 - s0);
    }
  }
  return 1;
}
function scaleFor(buy) {
  const target = siteConfig.getGameRtp(GAME_ID, 96.0);
  if (!Number.isFinite(target) || target <= 0) return 1;
  if (Math.abs(target - 96.0) < 1e-9) return 1;
  return buy ? target / 96.0 : baseScaleFor(target);
}

function stateFor(player) {
  const base = {
    bets: BETS,
    buyCostX: BUY_COST_X,
    maxWinX: MAX_WIN_X,
    reels: REELS,
    multipliers: MULTS,
    // جدول الدفع للطريقة الواحدة بمضاعفات الرهان — للعرض في «معلومات اللعبة»:
    // [عدد البكرات, الدفع] من MIN_REELS فما فوق (بعد معامل العائد المضبوط)
    paytable: Object.fromEntries(SYM.slice(0, PAYING).map((s, i) => {
      const k = scaleFor(false);
      return [s, PAYS[i].map((v, j) => [j + 3, v * k]).filter(([n]) => n >= MIN_REELS)];
    })),
    minReels: MIN_REELS,
    freeSpins: { award3: FS_AWARD(3), perExtra: 2, retrigger3: FS_RETRIGGER(3), startMult: MODES.fs.startMult }
  };
  if (!player) return { loggedIn: false, balance: 0, currency: 'IQD', ...base };
  return {
    loggedIn: true,
    balance: player.balance,
    currency: player.currency || 'IQD',
    username: player.username || null,
    ...base
  };
}

module.exports = {
  GAME_ID, REELS, SYM, PAYS, PAYS_REL, WEIGHTS, MODES, MULTS, BETS, MIN_BET, MAX_BET, MIN_REELS, MIN_SPIN_WIN_X, BASE_CALIBRATION, scaleFor,
  BUY_COST_X, MAX_WIN_X, RTP, FS_AWARD, FS_RETRIGGER,
  evaluate, collapse, playSpin, playRound, toMoney, spin, demo, stateFor, newGrid, countScatters
};
