'use strict';

/**
 * راكون الكونغ فو — المحرّك والمحفظة وقواعد الربح.
 *
 *   npm test
 * (قياس العائد الكامل: node tools/tuneRaccoon.js)
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
  recordRaccoon(player, info) { calls.push(['record', info]); }
};
const storePath = require.resolve('../server/store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

const R = require('../server/raccoon');
const [PIG, BAG, LANTERN, GOURD, SCROLL, DARTS] = [0, 1, 2, 3, 4, 5];
const W = R.SYM.indexOf('wild');
const coin = (v) => ({ t: 'c', v });
const mult = (v) => ({ t: 'x', v });

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

test('الخطوط: 3 متطابقة على خط تدفع، والقطران خطّان', () => {
  // كما في الفيديو: 3 قرع على القطر (أسفل-يسار ← أعلى-يمين)
  const g = [[BAG, DARTS, GOURD], [LANTERN, GOURD, DARTS], [GOURD, GOURD, PIG]];
  const ev = R.evaluate(g, [coin(2), coin(3), coin(5)]);
  assert.equal(ev.lines.length, 1);
  assert.equal(ev.lines[0].line, 4);
  assert.equal(ev.lines[0].symbol, 'gourd');
  assert.equal(ev.win, R.PAYS[GOURD]);
});

test('WILD يعوّض، و3 راكون على خط تدفع أعلى دفع', () => {
  const g = [[W, PIG, SCROLL], [W, PIG, DARTS], [W, BAG, GOURD]];
  const ev = R.evaluate(g, [mult(2), mult(2), mult(2)]);
  // الصف الأعلى: 3 راكون
  const top = ev.lines.find((l) => l.line === 1);
  assert.equal(top.symbol, 'wild');
  assert.equal(top.pay, R.PAYS[W]);
});

test('الراكون الداخل في خط رابح يجمع صندوق بكرته: النقد يُضاف والمضاعف يضرب', () => {
  // الصف الأوسط: خنزير، راكون، خنزير — الراكون في البكرة 2 يجمع صندوقها (نقد 3)
  const g = [[SCROLL, PIG, DARTS], [BAG, W, LANTERN], [GOURD, PIG, LANTERN]];
  let ev = R.evaluate(g, [mult(5), coin(3), mult(10)]);
  assert.deepEqual(ev.collect, [false, true, false]);
  assert.equal(ev.win, R.PAYS[PIG] + 3, 'المضاعفات فوق البكرتين 1 و3 لم تُجمع');
  // صندوق البكرة 2 مضاعف ×5
  ev = R.evaluate(g, [coin(50), mult(5), coin(50)]);
  assert.equal(ev.mult, 5);
  assert.equal(ev.win, R.PAYS[PIG] * 5);
});

test('راكون بلا خط رابح لا يجمع شيئاً (كما في الفيديو)', () => {
  const g = [[SCROLL, SCROLL, SCROLL].map(() => SCROLL), [GOURD, BAG, W], [LANTERN, LANTERN, LANTERN]];
  // الأعمدة: لفائف | قرع، كيس، راكون | فوانيس — لا خط متطابق
  const ev = R.evaluate(g, [coin(10), coin(20), coin(25)]);
  assert.equal(ev.lines.length, 0);
  assert.equal(ev.win, 0);
});

test('الحدّ الأدنى: اللفة الرابحة لا تدفع أقل مما دُفع — عادي و«فرصة ×2»', () => {
  for (const mode of ['base', 'ante']) {
    const rng = mulberry32(mode === 'base' ? 7 : 8);
    const cost = mode === 'ante' ? R.ANTE_COST_X : 1;
    let wins = 0;
    for (let i = 0; i < 40000; i++) {
      const r = R.playRound({ mode, rng });
      if (r.base.win > 0) {
        wins++;
        assert.ok(r.base.win >= cost - 1e-9, `${mode}: ${r.base.win} < ${cost}`);
      }
    }
    assert.ok(wins > 5000);
  }
  // وبالمال بعد التقريب
  const rng = mulberry32(3);
  for (let i = 0; i < 20000; i++) {
    const out = R.toMoney(R.playRound({ mode: 'ante', rng }), 1000);
    if (out.base.win > 0) assert.ok(out.base.win >= 1750, String(out.base.win));
  }
});

test('اللفات المجانية: 3 راكون تفتح 8 لفات، وكل راكون يبقى ثابتاً حتى النهاية', () => {
  const rng = mulberry32(99);
  let seen = 0;
  for (let i = 0; i < 200000 && seen < 30; i++) {
    const r = R.playRound({ mode: 'base', rng });
    if (!r.feature) continue;
    seen++;
    assert.ok(r.base.wilds >= R.FS_TRIGGER);
    assert.equal(r.feature.spins.length, R.FS_SPINS);
    const sticky = new Set(r.feature.start);
    for (const s of r.feature.spins) {
      for (const key of sticky) {
        const [c, row] = key.split(',').map(Number);
        assert.equal(s.grid[c][row], W, 'الراكون الثابت بقي في مكانه');
      }
      s.grid.forEach((col, c) => col.forEach((x, row) => { if (x === W) sticky.add(`${c},${row}`); }));
    }
  }
  assert.ok(seen >= 10, `مجانية ظهرت ${seen} مرّة`);
});

test('الشراء: 3 راكون ثابتة في خانات مختلفة من أوّل لفة مجانية', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 200; i++) {
    const r = R.playRound({ mode: 'buy', rng });
    assert.equal(r.base, null);
    assert.equal(new Set(r.feature.start).size, 3);
    const first = r.feature.spins[0];
    for (const key of r.feature.start) {
      const [c, row] = key.split(',').map(Number);
      assert.equal(first.grid[c][row], W);
    }
    assert.equal(r.jackpot, null, 'لا جاكبوت مع الشراء');
  }
});

test('السقف: لا جولة تتجاوز 5000 ضعف الرهان', () => {
  const rng = mulberry32(11);
  for (let i = 0; i < 3000; i++) {
    const r = R.playRound({ mode: 'buy', rng });
    assert.ok(r.total <= R.MAX_WIN_X + 1e-9);
  }
});

test('بالمال: المجموع = مجموع الأجزاء المعروضة، والصندوق النقدي يُعرض بالمال', () => {
  const rng = mulberry32(21);
  for (let i = 0; i < 5000; i++) {
    const out = R.toMoney(R.playRound({ mode: i % 3 === 0 ? 'ante' : 'base', rng }), 500);
    const parts = (out.base ? out.base.win : 0) + (out.feature ? out.feature.win : 0) + (out.jackpot ? out.jackpot.win : 0);
    assert.equal(out.win, parts);
    for (const b of out.base.boxes) {
      assert.ok(b.t === 'x' || b.t === 'c');
      if (b.t === 'c') assert.ok(Number.isInteger(b.v) && b.v >= 250);
    }
  }
});

test('المحفظة: خصم المدفوع (عادي / فرصة ×2 / شراء) ثم الصرف والتسجيل', async () => {
  for (const [opts, cost] of [[{}, 1000], [{ ante: true }, 1750], [{ buy: true }, 1000 * R.BUY_COST_X]]) {
    calls.length = 0;
    const player = { id: 'p1', balance: 10_000_000 };
    const res = await R.spin(player, { bet: 1000, ...opts });
    assert.equal(res.ok, true);
    assert.equal(res.cost, cost);
    assert.equal(calls[0][0], 'debit');
    assert.equal(calls[0][2], cost);
    const credit = calls.find((c) => c[0] === 'credit');
    if (res.win > 0) assert.equal(credit[2], res.win); else assert.equal(credit, undefined);
    const rec = calls.find((c) => c[0] === 'record')[1];
    assert.equal(rec.bet, cost);
    assert.equal(rec.win, res.win);
    assert.equal(player.balance, 10_000_000 - cost + res.win);
  }
  const poor = await R.spin({ id: 'p2', balance: 500 }, { bet: 1000 });
  assert.equal(poor.ok, false);
  const bad = await R.spin({ id: 'p3', balance: 1e9 }, { bet: 1234 });
  assert.equal(bad.ok, false);
});

test('حالة اللعبة للاعب: لا احتمالات ولا عائد ولا أوزان', () => {
  const st = R.stateFor(null);
  const json = JSON.stringify(st);
  for (const k of ['rtp', 'RTP', 'weight', 'wild":0', 'multP', 'p":']) assert.equal(json.includes(k), false, k);
  assert.equal(st.paytable.pig, R.PAYS[PIG]);
  assert.deepEqual(st.jackpots.map((j) => Object.keys(j).sort().join()), ['key,x', 'key,x', 'key,x', 'key,x']);
});
