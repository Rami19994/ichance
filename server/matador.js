'use strict';

const crypto = require('crypto');
const siteConfig = require('./siteConfig');

/**
 * ماتادور فييستا — سلوت «طرق» 5×3 (243 طريقة) بانهيار الرموز.
 *
 * رموز متطابقة على بكرات متجاورة من اليسار ابتداءً من البكرة الأولى، 3 بكرات
 * على الأقل. الرموز الفائزة تنفجر وتسقط رموز جديدة مكانها (انهيار).
 *
 *   المؤطّر  رمز عادي بإطار ذهبي، في البكرات 2 و3 و4 فقط. إن دخل ربحاً لا
 *            ينفجر بل يتحوّل إلى WILD (الماتادور) مكانه.
 *   المضاعف  بعض المؤطّر يحمل شارة ×2 / ×3 / ×5 / ×8 (وفي المجانية ×10):
 *            إن دخل ربحاً تُضرب أرباح تلك الخطوة بمجموع الشارات الداخلة فيه.
 *   WILD     يعوّض كل رمز عدا السكاتر، وينفجر إن دخل ربحاً.
 *   سكاتر   الثور — 3 فأكثر في أي مكان بعد انتهاء الانهيارات ← لفات مجانية
 *            (10 / 15 / 20)، المؤطّر فيها أكثر وشاراته أكبر، و3 سكاتر تضيف 5.
 *            في المجانية تتراكم الشارات الفائزة في مضاعف واحد يبقى حتى نهايتها.
 *   الشراء   BUY_COST_X × الرهان: لفة بثلاثة سكاتر مضمونة ثم اللفات المجانية.
 *   الجاكبوت أربع جوائز ثابتة بمضاعفات الرهان (MINI … GRAND) قد تُمنح عشوائياً
 *            مع أي لفة عادية بمال — القيم الظاهرة في أعلى اللعبة هي ما يُدفع.
 *
 * السقف: ربح الجولة كلها لا يتجاوز MAX_WIN_X × الرهان.
 * الحدّ الأدنى (طلب المالك): اللفة العادية الرابحة تدفع الرهان كاملاً على الأقل.
 *
 * كل شيء يُحسم في الخادم دفعة واحدة؛ الواجهة تعرض الخطوات المرسلة فقط.
 * العائد 96% في اللعب العادي وفي الشراء — بالمحاكاة (4 ملايين لفة + 600 ألف
 * شراء): عادي 95.96% (بلا مجانية 63.0% + مجانية كل ~252 لفة × 77 + جاكبوت
 * 2.53%)، شراء 96.2% ±0.5، الفوز في 26.6% من اللفات، ولا لفة رابحة بأقل من
 * الرهان:
 *   node tools/tuneMatador.js 4000000 600000 --calibrate
 */

const GAME_ID = 'matador';
const NREELS = 5;
const ROWS = 3;
const GOLD_REELS = [1, 2, 3];

// الرموز: 0..8 دافعة، 9 WILD، 10 SCATTER
const SYM = ['hat', 'guitar', 'maracas', 'castanets', 'fan', 'hornRed', 'hornBlue', 'hornPurple', 'hornGreen', 'wild', 'scatter'];
const WILD = 9;
const SCAT = 10;
const PAYING = 9;

const MIN_REELS = 3;
const MIN_SPIN_WIN_X = 1;

/** دفع الطريقة الواحدة بمضاعفات الرهان الكلّي لـ 3 / 4 / 5 بكرات. */
const PAY_SCALE = 0.598;
const PAYS_REL = [
  [2.00, 5.00, 12.0],   // القبعة
  [1.60, 4.00, 9.00],   // الجيتار
  [1.20, 3.00, 7.00],   // الماراكاس
  [1.00, 2.50, 5.00],   // الكاستانيت
  [0.80, 2.00, 4.00],   // المروحة
  [0.50, 1.20, 2.50],   // قرن أحمر
  [0.50, 1.20, 2.50],   // قرن أزرق
  [0.40, 1.00, 2.00],   // قرن بنفسجي
  [0.40, 1.00, 2.00]    // قرن أخضر
];
const PAYS = PAYS_REL.map((row) => row.map((v) => v * PAY_SCALE));

/** أوزان الرموز الدافعة لكل خلية (مستقلّة)، ثم احتمال السكاتر والمؤطّر والشارة. */
const WEIGHTS = [4, 5, 6, 7, 8, 11, 11, 12, 12];
const MODES = {
  base: { scatter: 0.020, gold: 0.10, badge: 0.30, badges: [[2, 50], [3, 28], [5, 15], [8, 7]] },
  fs: { scatter: 0.016, gold: 0.29, badge: 0.50, badges: [[2, 35], [3, 28], [5, 20], [8, 11], [10, 6]] },
  buy: { scatter: 0.020, gold: 0.10, badge: 0.30, badges: [[2, 50], [3, 28], [5, 15], [8, 7]] }
};
const FS_AWARD = (n) => (n >= 5 ? 20 : n === 4 ? 15 : 10);
const FS_RETRIGGER = 5;
const FS_MAX_MULT = 100;
const MAX_FREE_SPINS = 100;
const BUY_COST_X = 80;
const MAX_WIN_X = 5000;

/**
 * الجاكبوت: جوائز ثابتة (مضاعف × الرهان) تُسحب مرّة مع كل لفة عادية بمال.
 * لا تتأثّر بمعامل العائد — ما يظهر في أعلى اللعبة هو ما يُدفع بالضبط؛
 * جدول المعايرة يحسب حصّتها (~2.5%) ضمن العائد.
 */
const JACKPOTS = [
  { key: 'grand', x: 1000, p: 1 / 400000 },
  { key: 'major', x: 100, p: 1 / 25000 },
  { key: 'minor', x: 25, p: 1 / 4000 },
  { key: 'mini', x: 10, p: 1 / 800 }
];

const BETS = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000];
const MIN_BET = BETS[0];
const MAX_BET = BETS[BETS.length - 1];

/** العائد المُقاس (انظر tools/tuneMatador.js) — للإدارة فقط، لا يُرسل للاعب. */
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

function drawBadge(rng, list) {
  const total = list.reduce((a, [, w]) => a + w, 0);
  let x = rng() * total;
  for (const [v, w] of list) {
    x -= w;
    if (x < 0) return v;
  }
  return list[list.length - 1][0];
}

/** خلية جديدة للبكرة c: { s, g, m } — g مؤطّر، m شارة المضاعف (0 = بلا). */
function drawCell(rng, c, mode) {
  const md = MODES[mode];
  if (rng() < md.scatter) return { s: SCAT, g: false, m: 0 };
  const s = drawPaying(rng);
  const g = GOLD_REELS.includes(c) && rng() < md.gold;
  const m = g && rng() < md.badge ? drawBadge(rng, md.badges) : 0;
  return { s, g, m };
}

function newGrid(rng, mode) {
  const grid = [];
  for (let c = 0; c < NREELS; c++) {
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(drawCell(rng, c, mode));
    grid.push(col);
  }
  return grid;
}

function countScatters(grid) {
  let n = 0;
  for (const col of grid) for (const x of col) if (x.s === SCAT) n++;
  return n;
}

/** شراء الميزة: سكاتر مضمونة على بكرات مختلفة، في خانات عشوائية. */
function forceScatters(rng, grid, count) {
  const reels = [0, 1, 2, 3, 4];
  for (let i = reels.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [reels[i], reels[j]] = [reels[j], reels[i]];
  }
  let placed = countScatters(grid);
  for (const c of reels) {
    if (placed >= count) break;
    if (grid[c].some((x) => x.s === SCAT)) continue;
    const r = Math.floor(rng() * ROWS);
    grid[c][r] = { s: SCAT, g: false, m: 0 };
    placed++;
  }
}

/**
 * أرباح الشبكة: لكل رمز دافع، البكرات المتتالية من اليسار التي فيها الرمز
 * أو WILD. يرجّع { wins, positions, pay, mult } — pay بمضاعفات الرهان قبل
 * مضاعف الشارات، وmult مجموع شارات المؤطّر الفائز (1 إن لم توجد).
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
  let badges = 0;
  hit.forEach((col, c) => col.forEach((h, r) => {
    if (!h) return;
    positions.push([c, r]);
    const x = grid[c][r];
    if (x.g && x.m) badges += x.m;
  }));
  return { wins, positions, pay, mult: badges > 0 ? badges : 1 };
}

/**
 * انهيار واحد: المؤطّر الفائز يصير WILD مكانه (وتُستهلك شارته)، والباقي
 * الفائز ينفجر، ثم تسقط الرموز المتبقية للأسفل وتُملأ من الأعلى.
 */
function collapse(rng, grid, positions, mode) {
  const remove = grid.map((col) => new Array(col.length).fill(false));
  const transform = [];
  for (const [c, r] of positions) {
    const x = grid[c][r];
    if (x.g) {
      grid[c][r] = { s: WILD, g: false, m: 0 };
      transform.push([c, r]);
    } else {
      remove[c][r] = true;
    }
  }
  const drops = [];
  for (let c = 0; c < NREELS; c++) {
    const kept = grid[c].filter((_, r) => !remove[c][r]);
    const fresh = [];
    while (kept.length + fresh.length < ROWS) fresh.push(drawCell(rng, c, mode));
    grid[c] = fresh.concat(kept);
    drops.push(fresh.map(pub));
  }
  return { transform, drops };
}

function pub(x) {
  const o = { s: SYM[x.s] };
  if (x.g) o.g = true;
  if (x.m) o.m = x.m;
  return o;
}
const pubGrid = (grid) => grid.map((col) => col.map(pub));

/**
 * لفة واحدة كاملة بكل انهياراتها. budget = ما بقي تحت السقف (بمضاعفات الرهان).
 * يرجّع { grid, steps, win, scatters, capped }.
 */
function playSpin(rng, mode, budget, { forced = 0, feature = null } = {}) {
  const grid = newGrid(rng, mode);
  if (forced) forceScatters(rng, grid, forced);
  const start = pubGrid(grid);
  const steps = [];
  let win = 0;
  let capped = false;

  const MAX_STEPS = 50;
  for (let stepCount = 0; stepCount < MAX_STEPS; stepCount++) {
    const ev = evaluate(grid);
    if (!ev.positions.length) break;
    // اللفات المجانية: شارات المؤطّر الفائز تُضاف إلى مضاعف تراكمي يبقى حتى
    // نهاية اللفات المجانية ويُضرب به كل ربح بعدها
    if (feature) {
      if (ev.mult > 1) feature.mult = Math.min(FS_MAX_MULT, feature.mult + ev.mult);
      ev.mult = feature.mult;
    }
    let stepWin = ev.pay * ev.mult;
    if (win + stepWin >= budget) {
      stepWin = Math.max(0, budget - win);
      capped = true;
    }
    win += stepWin;
    const step = {
      mult: ev.mult,
      base: ev.pay,
      win: stepWin,
      wins: ev.wins,
      positions: ev.positions
    };
    if (capped) { steps.push(step); break; }
    Object.assign(step, collapse(rng, grid, ev.positions, mode));
    steps.push(step);
  }
  return { grid: start, steps, win, scatters: countScatters(grid), capped };
}

function drawJackpot(rng) {
  let x = rng();
  for (const j of JACKPOTS) {
    x -= j.p;
    if (x < 0) return j;
  }
  return null;
}

/**
 * جولة كاملة: اللفة (أو لفة الشراء) ثم اللفات المجانية إن وُجدت، ثم الجاكبوت.
 * كل المبالغ هنا بمضاعفات الرهان. rng افتراضياً مولّد التشفير.
 * scale = معامل العائد من الإدارة: يُطبّق على أرباح الرموز فقط؛ الحدّ الأدنى
 * والجاكبوت ثابتان (يُمرَّران مقسومين على scale ليصيرا بالضبط عند الصرف).
 */
function playRound({ buy = false, rng = cryptoRng, scale = 1 } = {}) {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  let budget = MAX_WIN_X / k;
  const base = playSpin(rng, buy ? 'buy' : 'base', budget, { forced: buy ? 3 : 0 });
  const floorX = MIN_SPIN_WIN_X / k;
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
    const state = { mult: 1 };
    let fsWin = 0;
    while (left > 0 && spins.length < MAX_FREE_SPINS) {
      left--;
      const s = playSpin(rng, 'fs', budget, { feature: state });
      budget -= s.win;
      fsWin += s.win;
      let extra = 0;
      if (!s.capped && s.scatters >= 3) {
        extra = Math.max(0, Math.min(FS_RETRIGGER, MAX_FREE_SPINS - spins.length - 1 - left));
        left += extra;
      }
      spins.push({ ...s, retrigger: extra });
      if (s.capped) { capped = true; break; }
    }
    total += fsWin;
    feature = { awarded, spins, win: fsWin };
  }

  // الجاكبوت: مع اللفة العادية فقط (لا مع الشراء)، ضمن السقف
  let jackpot = null;
  if (!buy && !capped) {
    const j = drawJackpot(rng);
    if (j) {
      const x = Math.min(j.x / k, Math.max(0, budget));
      if (x > 0) {
        jackpot = { key: j.key, win: x };
        total += x;
        budget -= x;
      }
    }
  }
  return { base, feature, jackpot, total, capped };
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
  const base = spinOut(round.base);
  const feature = round.feature
    ? { awarded: round.feature.awarded, win: m(round.feature.win), spins: round.feature.spins.map(spinOut) }
    : null;
  const jackpot = round.jackpot ? { key: round.jackpot.key, win: m(round.jackpot.win) } : null;
  // المجموع = مجموع الأجزاء المعروضة بالضبط (لا فرق تقريب بين ما يُعرض وما يُدفع)
  const win = base.win + (feature ? feature.win : 0) + (jackpot ? jackpot.win : 0);
  return { base, feature, jackpot, win, capped: round.capped };
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
  store.recordMatador(player, {
    bet: cost, win: out.win, buy: !!buy,
    freeSpins: out.feature ? out.feature.spins.length : 0,
    jackpot: out.jackpot ? out.jackpot.key : null,
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
 * العائد المضبوط من الإدارة (افتراضياً 96%) ← معامل أرباح الرموز.
 * الشراء: كل ربحه من اللفات المجانية (بلا حدّ أدنى ولا جاكبوت) فالعائد خطّي.
 * اللعب العادي: الحدّ الأدنى والجاكبوت ثابتان مهما كان المعامل، فالعائد ليس
 * خطّياً فيه — نعكس جدول معايرة مقيساً بالمحاكاة.
 */
const BASE_CALIBRATION = [
  // [معامل, العائد % عند هذا المعامل] — tools/tuneMatador.js 4000000 600000 --calibrate
  // (مُزاح ليطابق العائد المقيس مُفكَّكاً عند المعامل 1)
  [0.60, 64.7], [0.65, 68.5], [0.70, 72.3], [0.75, 76.1], [0.80, 80.0], [0.85, 83.9], [0.90, 87.9],
  [0.95, 91.9], [1.00, 96.0], [1.05, 100.0], [1.10, 104.1], [1.15, 108.1], [1.20, 112.2], [1.25, 116.3], [1.30, 120.4]
];
function baseScaleFor(target) {
  const t = BASE_CALIBRATION;
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
function scaleFor(buy) {
  const target = siteConfig.getGameRtp(GAME_ID, 96.0);
  if (!Number.isFinite(target) || target <= 0) return 1;
  if (Math.abs(target - 96.0) < 1e-9) return 1;
  return buy ? target / 96.0 : baseScaleFor(target);
}

function stateFor(player) {
  const k = scaleFor(false);
  const base = {
    bets: BETS,
    buyCostX: BUY_COST_X,
    maxWinX: MAX_WIN_X,
    reels: NREELS,
    rows: ROWS,
    // جدول الدفع للطريقة الواحدة بمضاعفات الرهان — للعرض في «معلومات اللعبة»:
    // [عدد البكرات, الدفع] بعد معامل العائد المضبوط (ما يظهر هو ما يُدفع)
    paytable: Object.fromEntries(SYM.slice(0, PAYING).map((s, i) => [s, PAYS[i].map((v, j) => [j + 3, v * k])])),
    minReels: MIN_REELS,
    // الجاكبوت: المضاعفات فقط (القيم = الرهان × المضاعف) — لا احتمالات للاعب
    jackpots: JACKPOTS.map((j) => ({ key: j.key, x: j.x })),
    freeSpins: { award3: FS_AWARD(3), award4: FS_AWARD(4), award5: FS_AWARD(5), retrigger: FS_RETRIGGER }
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
  GAME_ID, NREELS, ROWS, SYM, PAYS, PAYS_REL, PAY_SCALE, WEIGHTS, MODES, BETS, MIN_BET, MAX_BET, MIN_REELS, MIN_SPIN_WIN_X,
  BASE_CALIBRATION, scaleFor, BUY_COST_X, MAX_WIN_X, RTP, FS_AWARD, FS_RETRIGGER, JACKPOTS,
  evaluate, collapse, playSpin, playRound, toMoney, spin, demo, stateFor, newGrid, countScatters, drawCell
};
