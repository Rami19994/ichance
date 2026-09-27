'use strict';

/**
 * بافالو وايز 3600 — المحرّك والمحفظة.
 *
 *   npm test
 * (قياس العائد الكامل: node tools/tuneBuffaloWays.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// متجر مُحاكى: المحرّك يطلب ./store عند اللعب بالمال فقط
const calls = [];
const fakeStore = {
  async gameDebit(game, player, amount, ref) {
    calls.push(['debit', game, amount, ref]);
    if (player.balance < amount) return false;
    player.balance -= amount;
    return true;
  },
  async gameCredit(game, player, amount, ref) { calls.push(['credit', game, amount, ref]); player.balance += amount; return true; },
  recordBuffaloWays(player, info) { calls.push(['record', info]); }
};
const storePath = require.resolve('../server/store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

const H = require('../server/buffaloWays');
const [BISON, , , , A, , , J] = [0, 1, 2, 3, 4, 5, 6, 7];

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

/** شبكة من أرقام الرموز؛ «g» لاحقة للذهبي. */
function grid(cols) {
  return cols.map((col) => col.map((v) => {
    const gold = typeof v === 'string' && v.endsWith('g');
    const s = gold ? Number(v.slice(0, -1)) : v;
    return { s, g: gold };
  }));
}

test('الطرق: عدد الطرق = حاصل ضرب التطابقات في البكرات المتتالية من اليسار', () => {
  // J في البكرات 1-3: 1 × 2 × 1 = طريقتان؛ البكرة 4 بلا J
  const g = grid([
    [J, A, A],
    [J, J, A, A],
    [A, A, J, A, A],
    [A, A, A, A, A],
    [A, A, A, A],
    [A, A, A]
  ]);
  const ev = H.evaluate(g);
  const wj = ev.wins.find((w) => w.symbol === 'J');
  assert.equal(wj.reels, 3);
  assert.equal(wj.ways, 2);
  assert.equal(wj.pay, H.PAYS[J][0] * 2);
  // A على كل البكرات الست
  const wa = ev.wins.find((w) => w.symbol === 'A');
  assert.equal(wa.reels, 6);
  assert.equal(wa.ways, 2 * 2 * 4 * 5 * 4 * 3);
});

test('WILD يعوّض، ولا فوز لأقل من 3 بكرات', () => {
  const g = grid([
    [BISON, A, J],
    [BISON, A, J, A],
    [H.SYM.indexOf('wild'), A, A, A, A],
    [J, J, J, J, J],
    [A, A, A, A],
    [A, A, A]
  ]);
  const ev = H.evaluate(g);
  const wb = ev.wins.find((w) => w.symbol === 'bison');
  assert.equal(wb.reels, 3, 'البافالو + البافالو + WILD');
  assert.equal(wb.ways, 1);
  assert.equal(ev.wins.find((w) => w.symbol === 'huntress'), undefined);
});

test('الانهيار: الذهبي الفائز يصير WILD مكانه، والباقي ينفجر وتُملأ الأعمدة من الأعلى', () => {
  const g = grid([
    [J, A, A],
    [J, A, A, A],
    [A, '7g', A, A, A],
    [A, A, A, A, A],
    [A, A, A, A],
    [A, A, A]
  ]);
  // J على البكرات 1-3 (الثالثة ذهبية)
  const positions = [[0, 0], [1, 0], [2, 1]];
  const out = H.collapse(mulberry32(1), g, positions, 'base');
  assert.deepEqual(out.transform, [[2, 1]]);
  assert.equal(g[2][1].s, H.SYM.indexOf('wild'), 'تحوّل في مكانه');
  assert.equal(out.drops[0].length, 1);
  assert.equal(out.drops[1].length, 1);
  assert.equal(out.drops[2].length, 0, 'لا شيء انفجر في البكرة الثالثة');
  g.forEach((col, c) => assert.equal(col.length, H.REELS[c]));
});

test('المضاعف يتضاعف مع كل انهيار، ويبدأ من ×1 في العادي ومن ×4 في المجانية', () => {
  const rng = mulberry32(7);
  let seenBase = 0, seenFs = 0;
  for (let i = 0; i < 4000 && (seenBase < 20 || seenFs < 20); i++) {
    const base = H.playSpin(rng, 'base', H.MAX_WIN_X);
    base.steps.forEach((st, k) => assert.equal(st.mult, Math.min(1024, 2 ** k)));
    if (base.steps.length > 1) seenBase++;
    const fs = H.playSpin(rng, 'fs', H.MAX_WIN_X);
    fs.steps.forEach((st, k) => assert.equal(st.mult, Math.min(1024, 4 * 2 ** k)));
    if (fs.steps.length > 1) seenFs++;
  }
  assert.ok(seenBase >= 20 && seenFs >= 20);
});

test('السقف: ربح الجولة لا يتجاوز الحدّ الأقصى', () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 300; i++) {
    const r = H.playSpin(rng, 'fs', 3);
    assert.ok(r.win <= 3 + 1e-9);
    if (r.capped) assert.equal(r.steps[r.steps.length - 1].drops, undefined);
  }
});

test('الشراء: 3 سكاتر مضمونة ولفات مجانية دائماً', () => {
  const rng = mulberry32(3);
  for (let i = 0; i < 200; i++) {
    const r = H.playRound({ buy: true, rng });
    assert.ok(r.base.scatters >= 3);
    assert.ok(r.feature && r.feature.spins.length >= 10);
  }
});

test('المبالغ بالعملة أعداد صحيحة، ومجموع خطوات اللفة لا يتجاوز ربحها', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 400; i++) {
    const out = H.toMoney(H.playRound({ rng, buy: i % 20 === 0 }), 300);
    assert.ok(Number.isInteger(out.win));
    const spins = [out.base, ...(out.feature ? out.feature.spins : [])];
    for (const s of spins) {
      const sum = s.steps.reduce((a, st) => a + st.win, 0);
      assert.ok(Number.isInteger(s.win));
      assert.ok(sum <= s.win + 0 && s.win - sum <= s.steps.length, `${sum} vs ${s.win}`);
    }
  }
});

test('بالمال: خصم الرهان ثم صرف الربح، والرصيد الناقص يُرفض دون خصم', async () => {
  calls.length = 0;
  const p = { id: 'P1', balance: 1000 };
  const r = await H.spin(p, { bet: 500 });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], 'debit');
  assert.equal(calls[0][2], 500);
  const credit = calls.find((c) => c[0] === 'credit');
  if (r.win > 0) assert.equal(credit[2], r.win); else assert.equal(credit, undefined);
  assert.equal(p.balance, 1000 - 500 + r.win);
  assert.ok(calls.some((c) => c[0] === 'record'));

  calls.length = 0;
  const poor = { id: 'P2', balance: 100 };
  const buy = await H.spin(poor, { bet: 100, buy: true });
  assert.equal(buy.ok, false);
  assert.equal(calls.length, 0, 'لا خصم');
});

test('رهان خارج القائمة مرفوض', async () => {
  for (const b of [-100, 0, 150, 1e9, 'x', null]) {
    assert.equal((await H.spin({ id: 'P', balance: 1e9 }, { bet: b })).ok, false);
    assert.equal(H.demo({ bet: b }).ok, false);
  }
});

test('التجربة لا تلمس المحفظة، والحالة للاعب لا تحمل أيّ عائد أو نسب', () => {
  calls.length = 0;
  const d = H.demo({ bet: 100 });
  assert.equal(d.ok, true);
  assert.equal(calls.length, 0);
  const st = H.stateFor({ balance: 5, currency: 'SYP' });
  assert.equal(st.currency, 'SYP');
  const text = JSON.stringify(st).toLowerCase();
  for (const k of ['rtp', 'odds', 'probab', 'weight', 'scatter":0']) assert.equal(text.includes(k), false, k);
});

test('العائد ضمن المتوقّع (فحص سريع — القياس الكامل في tools/tuneBuffaloWays.js)', () => {
  const rng = mulberry32(2026);
  const N = 120000;
  let base = 0, trig = 0;
  for (let i = 0; i < N; i++) {
    const r = H.playRound({ rng });
    base += r.base.win;
    if (r.feature) trig++;
  }
  const baseRtp = base / N;
  assert.ok(baseRtp > 0.60 && baseRtp < 0.69, `عائد اللعب العادي ${baseRtp}`);
  assert.ok(trig / N > 1 / 300 && trig / N < 1 / 170, `تكرار المجانية 1/${Math.round(N / trig)}`);
});
