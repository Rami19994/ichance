'use strict';

const crypto = require('crypto');
const siteConfig = require('./siteConfig');

/**
 * راكون الكونغ فو — سلوت 3×3 بخمسة خطوط دفع وصناديق جوائز فوق البكرات.
 *
 *   الخطوط    الصفوف الثلاثة والقطران: 3 رموز متطابقة على الخط (من البكرة 1
 *             إلى 3)، والراكون WILD يعوّض أي رمز. 3 راكون على خط = أعلى دفع.
 *   الصناديق  فوق كل بكرة صندوق يُعاد سحبه مع كل لفة: مضاعف (2X…10X) أو
 *             جائزة نقدية (مضاعف رهان يُعرض بالمال). الراكون الداخل في خط
 *             رابح «يجمع» صندوق بكرته: الجوائز النقدية تُضاف إلى الربح،
 *             ومجموع المضاعفات المجموعة يُضرب به الربح كله.
 *   المجانية  3 راكون فأكثر في أي مكان ← 8 لفات مجانية يبقى فيها كل راكون
 *             في مكانه حتى النهاية (ويبدأ الراكون الذي فتحها ثابتاً).
 *   فرصة ×2   رهان أعلى (ANTE_COST_X × الرهان) يضاعف فرصة اللفات المجانية.
 *   الشراء    BUY_COST_X × الرهان: اللفات المجانية مباشرة بثلاثة راكون ثابتة.
 *   الجاكبوت  أربع جوائز ثابتة (MINI … GRAND) قد تُمنح مع أي لفة عادية بمال.
 *
 * السقف: ربح الجولة كلها لا يتجاوز MAX_WIN_X × الرهان.
 * الحدّ الأدنى (طلب المالك): اللفة العادية الرابحة تدفع ما دفعه اللاعب كاملاً.
 * كل شيء يُحسم في الخادم؛ الواجهة تعرض فقط. العائد 96% في كل الأوضاع —
 * بالمحاكاة (8 ملايين لفة لكل وضع + 400 ألف شراء):
 *   عادي 96.1% ±0.6 (لفات 47.9% + مجانية كل ~224 لفة × 102 + جاكبوت 2.5%)
 *   فرصة ×2 (1.75× الرهان) 96.6% ±0.5 — المجانية كل ~109 لفة (ضعف العادي)
 *   شراء (103×) 96.3% ±0.2 · الفوز في 23% من اللفات، ولا لفة رابحة بأقل مما دُفع
 *   node tools/tuneRaccoon.js 8000000 400000 --calibrate
 */

const GAME_ID = 'raccoon';
const NREELS = 3;
const ROWS = 3;

// 0..5 دافعة، 6 WILD (الراكون)
const SYM = ['pig', 'bag', 'lantern', 'gourd', 'scroll', 'darts', 'wild'];
const WILD = 6;
const PAYING = 6;

/** خطوط الدفع: صفّ كل بكرة على الخط. */
const LINES = [[1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0]];

/** دفع 3 على خط بمضاعفات الرهان الكلّي (الأخير: 3 راكون). */
const PAY_SCALE = 0.47;
const PAYS_REL = [5.0, 2.5, 1.5, 1.0, 0.8, 0.6, 10.0];
const PAYS = PAYS_REL.map((v) => v * PAY_SCALE);

const WEIGHTS = [8, 10, 12, 14, 16, 18];
const WEIGHT_TOTAL = WEIGHTS.reduce((a, b) => a + b, 0);

/** احتمال الراكون لكل خانة، واحتمال أن يكون الصندوق مضاعفاً، وقيمه. */
const MODES = {
  base: { wild: 0.040 },
  ante: { wild: 0.0516 },
  fs: { wild: 0.035 }
};
const BOX = { multP: 0.25 };
const BOX_MULTS = [[2, 60], [3, 25], [5, 12], [10, 3]];
const BOX_COINS = [[0.5, 35], [1, 28], [2, 18], [3, 10], [5, 6], [10, 2.5], [25, 0.5]];

const FS_TRIGGER = 3;
const FS_SPINS = 8;
const ANTE_COST_X = 1.75;
const BUY_COST_X = 103;
const MAX_WIN_X = 5000;
const MIN_SPIN_WIN_X = 1;

/** الجاكبوت: جوائز ثابتة (مضاعف × الرهان) تُسحب مرّة مع كل لفة عادية بمال. */
const JACKPOTS = [
  { key: 'grand', x: 1000, p: 1 / 400000 },
  { key: 'major', x: 100, p: 1 / 25000 },
  { key: 'minor', x: 25, p: 1 / 4000 },
  { key: 'mini', x: 10, p: 1 / 800 }
];

const BETS = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000];
const MIN_BET = BETS[0];
const MAX_BET = BETS[BETS.length - 1];

/** العائد المُقاس (tools/tuneRaccoon.js) — للإدارة فقط، لا يُرسل للاعب. */
const RTP = 0.96;

function cryptoRng() {
  return crypto.randomInt(0, 0x1000000) / 0x1000000;
}

function pick(rng, list) {
  const total = list.reduce((a, [, w]) => a + w, 0);
  let x = rng() * total;
  for (const [v, w] of list) {
    x -= w;
    if (x < 0) return v;
  }
  return list[list.length - 1][0];
}

function drawPaying(rng) {
  let x = rng() * WEIGHT_TOTAL;
  for (let s = 0; s < PAYING; s++) {
    x -= WEIGHTS[s];
    if (x < 0) return s;
  }
  return PAYING - 1;
}

function drawCell(rng, mode) {
  return rng() < MODES[mode].wild ? WILD : drawPaying(rng);
}

/** صندوق: { t: 'x', v: مضاعف } أو { t: 'c', v: جائزة بمضاعفات الرهان }. */
function drawBox(rng) {
  return rng() < BOX.multP ? { t: 'x', v: pick(rng, BOX_MULTS) } : { t: 'c', v: pick(rng, BOX_COINS) };
}

/** شبكة [بكرة][صف]؛ sticky = مجموعة «c,r» لخانات الراكون الثابتة. */
function newGrid(rng, mode, sticky = null) {
  const grid = [];
  for (let c = 0; c < NREELS; c++) {
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(sticky && sticky.has(`${c},${r}`) ? WILD : drawCell(rng, mode));
    grid.push(col);
  }
  return grid;
}

function countWilds(grid) {
  let n = 0;
  for (const col of grid) for (const s of col) if (s === WILD) n++;
  return n;
}

/**
 * أرباح الشبكة: الخطوط الرابحة، والبكرات التي جمع الراكون صناديقها.
 * يرجّع { lines, linePay, collect, coins, mult, win } — بمضاعفات الرهان قبل السقف.
 */
function evaluate(grid, boxes) {
  const lines = [];
  let linePay = 0;
  const collect = [false, false, false];
  LINES.forEach((rows, li) => {
    const syms = rows.map((r, c) => grid[c][r]);
    const base = syms.find((s) => s !== WILD);
    const s = base === undefined ? WILD : base;
    if (!syms.every((x) => x === s || x === WILD)) return;
    const pay = PAYS[s];
    linePay += pay;
    lines.push({ line: li, symbol: SYM[s], pay, cells: rows.map((r, c) => [c, r]) });
    syms.forEach((x, c) => { if (x === WILD) collect[c] = true; });
  });
  let coins = 0;
  let multSum = 0;
  collect.forEach((on, c) => {
    if (!on) return;
    if (boxes[c].t === 'c') coins += boxes[c].v;
    else multSum += boxes[c].v;
  });
  const mult = multSum > 0 ? multSum : 1;
  const win = lines.length ? (linePay + coins) * mult : 0;
  return { lines, linePay, collect, coins, mult, win };
}

/** لفة واحدة. budget = ما بقي تحت السقف (بمضاعفات الرهان). */
function playSpin(rng, mode, budget, sticky = null) {
  const grid = newGrid(rng, mode, sticky);
  const boxes = [drawBox(rng), drawBox(rng), drawBox(rng)];
  const ev = evaluate(grid, boxes);
  let win = ev.win;
  let capped = false;
  if (win >= budget) { win = Math.max(0, budget); capped = true; }
  return {
    grid, boxes, lines: ev.lines, collect: ev.collect, coins: ev.coins, mult: ev.mult,
    linePay: ev.linePay, win, capped, wilds: countWilds(grid)
  };
}

function drawJackpot(rng) {
  let x = rng();
  for (const j of JACKPOTS) {
    x -= j.p;
    if (x < 0) return j;
  }
  return null;
}

/** اللفات المجانية: كل راكون يهبط يبقى ثابتاً حتى النهاية. */
function playFeature(rng, budget, startSticky) {
  const sticky = new Set(startSticky);
  const spins = [];
  let win = 0;
  let capped = false;
  for (let i = 0; i < FS_SPINS; i++) {
    const held = [...sticky];
    const s = playSpin(rng, 'fs', budget - win, sticky);
    win += s.win;
    s.held = held;
    spins.push(s);
    s.grid.forEach((col, c) => col.forEach((x, r) => { if (x === WILD) sticky.add(`${c},${r}`); }));
    if (s.capped) { capped = true; break; }
  }
  return { spins, win, capped, start: [...startSticky] };
}

/**
 * جولة كاملة. mode: 'base' | 'ante' | 'buy'. المبالغ بمضاعفات الرهان.
 * scale = معامل العائد من الإدارة: على دفع الخطوط والجوائز النقدية فقط؛
 * الحدّ الأدنى والجاكبوت ثابتان (يُمرَّران مقسومين على scale).
 */
function playRound({ mode = 'base', rng = cryptoRng, scale = 1 } = {}) {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  let budget = MAX_WIN_X / k;
  const cost = mode === 'buy' ? BUY_COST_X : mode === 'ante' ? ANTE_COST_X : 1;
  let base = null;
  let feature = null;
  let total = 0;
  let capped = false;

  if (mode === 'buy') {
    // الشراء: ثلاثة راكون ثابتة في خانات عشوائية مختلفة، ثم اللفات المجانية
    const cells = [];
    for (let c = 0; c < NREELS; c++) for (let r = 0; r < ROWS; r++) cells.push(`${c},${r}`);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    feature = playFeature(rng, budget, cells.slice(0, FS_TRIGGER));
    total = feature.win;
    capped = feature.capped;
  } else {
    base = playSpin(rng, mode, budget);
    // الحدّ الأدنى: اللفة الرابحة تدفع ما دُفع فيها كاملاً (بعد معامل العائد)
    const floorX = (MIN_SPIN_WIN_X * cost) / k;
    if (base.win > 0 && base.win < floorX) {
      base.floor = floorX - base.win;
      base.win = floorX;
    }
    budget -= base.win;
    total = base.win;
    capped = base.capped;
    if (!capped && base.wilds >= FS_TRIGGER) {
      const start = [];
      base.grid.forEach((col, c) => col.forEach((x, r) => { if (x === WILD) start.push(`${c},${r}`); }));
      feature = playFeature(rng, budget, start);
      budget -= feature.win;
      total += feature.win;
      capped = feature.capped;
    }
  }

  let jackpot = null;
  if (mode !== 'buy' && !capped) {
    const j = drawJackpot(rng);
    if (j) {
      const x = Math.min(j.x / k, Math.max(0, budget));
      if (x > 0) { jackpot = { key: j.key, win: x }; total += x; }
    }
  }
  return { mode, cost, base, feature, jackpot, total, capped };
}

// ─────────────────────────────────────────────────────────── بالمال

function toMoney(round, bet, rtpScale = 1.0) {
  const scale = Number.isFinite(rtpScale) && rtpScale > 0 ? rtpScale : 1.0;
  const m = (x) => Math.floor(x * bet * scale + 1e-7);
  // الصندوق النقدي يُعرض بالمال بعد معامل العائد — المعروض هو المدفوع
  const box = (b) => (b.t === 'x' ? { t: 'x', v: b.v } : { t: 'c', v: m(b.v) });
  const spinOut = (s) => ({
    grid: s.grid.map((col) => col.map((x) => SYM[x])),
    boxes: s.boxes.map(box),
    lines: s.lines.map((l) => ({ line: l.line, symbol: l.symbol, pay: m(l.pay), cells: l.cells })),
    collect: s.collect,
    mult: s.mult,
    win: m(s.win),
    held: s.held || []
  });
  const base = round.base ? spinOut(round.base) : null;
  const feature = round.feature
    ? { start: round.feature.start, spins: round.feature.spins.map(spinOut), win: 0 }
    : null;
  if (feature) feature.win = feature.spins.reduce((a, s) => a + s.win, 0);
  const jackpot = round.jackpot ? { key: round.jackpot.key, win: m(round.jackpot.win) } : null;
  const win = (base ? base.win : 0) + (feature ? feature.win : 0) + (jackpot ? jackpot.win : 0);
  return { mode: round.mode, base, feature, jackpot, win, capped: round.capped };
}

function checkBet(raw) {
  const bet = Math.floor(Number(raw));
  if (!Number.isFinite(bet) || !BETS.includes(bet)) {
    return { ok: false, error: `اختر رهاناً من القائمة (${MIN_BET.toLocaleString('en-US')} – ${MAX_BET.toLocaleString('en-US')})` };
  }
  return { ok: true, bet };
}

function modeOf({ buy, ante }) {
  return buy ? 'buy' : ante ? 'ante' : 'base';
}
function costOf(bet, mode) {
  return mode === 'buy' ? bet * BUY_COST_X : mode === 'ante' ? Math.round(bet * ANTE_COST_X) : bet;
}

async function spin(player, { bet: rawBet, buy = false, ante = false } = {}) {
  const store = require('./store');
  const b = checkBet(rawBet);
  if (!b.ok) return b;
  const bet = b.bet;
  const mode = modeOf({ buy, ante });
  const cost = costOf(bet, mode);
  if (player.balance < cost) return { ok: false, error: 'رصيدك لا يكفي' };

  const id = crypto.randomBytes(8).toString('hex');
  if (!(await store.gameDebit(GAME_ID, player, cost, `${GAME_ID}-${id}-bet`))) {
    return { ok: false, error: 'تعذّر خصم الرهان — حاول مجدداً' };
  }
  const rtpScale = scaleFor(mode);
  const out = toMoney(playRound({ mode, scale: rtpScale }), bet, rtpScale);
  if (out.win > 0) {
    await store.gameCredit(GAME_ID, player, out.win, `${GAME_ID}-${id}-win`);
  }
  store.recordRaccoon(player, {
    bet: cost, win: out.win, mode,
    freeSpins: out.feature ? out.feature.spins.length : 0,
    jackpot: out.jackpot ? out.jackpot.key : null,
    multiplier: cost > 0 ? out.win / cost : 0
  });
  return { ok: true, id, bet, cost, ...out, balance: player.balance };
}

function demo({ bet: rawBet, buy = false, ante = false } = {}) {
  const b = checkBet(rawBet);
  if (!b.ok) return b;
  const mode = modeOf({ buy, ante });
  const rtpScale = scaleFor(mode);
  return { ok: true, demo: true, bet: b.bet, cost: costOf(b.bet, mode), ...toMoney(playRound({ mode, scale: rtpScale }), b.bet, rtpScale) };
}

/**
 * العائد المضبوط من الإدارة ← معامل الأرباح. الشراء خطّي (بلا حدّ أدنى ولا
 * جاكبوت). العادي و«فرصة ×2»: الحدّ الأدنى والجاكبوت ثابتان فالعلاقة ليست
 * خطّية — جدولا معايرة مقيسان بالمحاكاة.
 */
// [معامل, العائد %] — node tools/tuneRaccoon.js 8000000 400000 --calibrate
const BASE_CALIBRATION = [
  [0.60, 64.8], [0.65, 68.6], [0.70, 72.4], [0.75, 76.3], [0.80, 80.2], [0.85, 84.1], [0.90, 88.1],
  [0.95, 92.1], [1.00, 96.1], [1.05, 100.1], [1.10, 104.1], [1.15, 108.1], [1.20, 112.2], [1.25, 116.2], [1.30, 120.3]
];
const ANTE_CALIBRATION = [
  [0.60, 66.0], [0.65, 69.6], [0.70, 73.3], [0.75, 77.1], [0.80, 80.9], [0.85, 84.7], [0.90, 88.6],
  [0.95, 92.4], [1.00, 96.3], [1.05, 100.1], [1.10, 104.0], [1.15, 107.9], [1.20, 111.8], [1.25, 115.8], [1.30, 119.7]
];
function invert(table, target) {
  const t = table;
  if (target <= t[0][1]) {
    const [s0, r0] = t[0];
    const [s1, r1] = t[1];
    return Math.max(0.1, s0 - ((r0 - target) / (r1 - r0)) * (s1 - s0));
  }
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
function scaleFor(mode) {
  const target = siteConfig.getGameRtp(GAME_ID, 96.0);
  if (!Number.isFinite(target) || target <= 0) return 1;
  if (Math.abs(target - 96.0) < 1e-9) return 1;
  if (mode === 'buy') return target / 96.0;
  return invert(mode === 'ante' ? ANTE_CALIBRATION : BASE_CALIBRATION, target);
}

function stateFor(player) {
  const k = scaleFor('base');
  const base = {
    bets: BETS,
    buyCostX: BUY_COST_X,
    anteCostX: ANTE_COST_X,
    maxWinX: MAX_WIN_X,
    lines: LINES,
    // دفع 3 على خط بمضاعفات الرهان بعد معامل العائد (ما يظهر هو ما يُدفع)
    paytable: Object.fromEntries(SYM.map((s, i) => [s, PAYS[i] * k])),
    boxMults: BOX_MULTS.map(([v]) => v),
    jackpots: JACKPOTS.map((j) => ({ key: j.key, x: j.x })),
    freeSpins: { trigger: FS_TRIGGER, spins: FS_SPINS }
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
  GAME_ID, NREELS, ROWS, SYM, LINES, PAYS, PAYS_REL, PAY_SCALE, WEIGHTS, MODES, BOX, BOX_MULTS, BOX_COINS,
  BETS, MIN_BET, MAX_BET, MIN_SPIN_WIN_X, FS_TRIGGER, FS_SPINS, ANTE_COST_X, BUY_COST_X, MAX_WIN_X, RTP, JACKPOTS,
  BASE_CALIBRATION, ANTE_CALIBRATION, scaleFor,
  evaluate, playSpin, playFeature, playRound, toMoney, spin, demo, stateFor, newGrid, countWilds, drawBox
};
