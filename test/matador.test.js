'use strict';

/**
 * ماتادور فييستا — المحرّك والمحفظة وقواعد الربح.
 *
 *   npm test
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
  async gameCredit(game, player, amount, ref) {
    calls.push(['credit', game, amount, ref]);
    player.balance += amount;
    return true;
  },
  recordMatador(player, info) {
    calls.push(['record', info]);
  }
};
const storePath = require.resolve('../server/store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

const M = require('../server/matador');
const [HAT, GUITAR, MARACAS, CASTANETS, FAN] = [0, 1, 2, 3, 4];
const WILD = M.SYM.indexOf('wild');
const SCAT = M.SYM.indexOf('scatter');

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

/** شبكة 5×3 بسيطة للاختبار */
function grid(cols) {
  return cols.map((col) => col.map((item) => {
    if (typeof item === 'object' && item !== null) return { s: item.s, g: !!item.g, m: item.m || 0 };
    return { s: item, g: false, m: 0 };
  }));
}

test('ماتادور: حساب الطرق (243 طريقة) من اليسار لليمين', () => {
  // HAT في البكرات 1-3: 1 × 2 × 1 = طريقتان؛ البكرة 4 بلا HAT
  const g = grid([
    [HAT, FAN, FAN],
    [HAT, HAT, FAN],
    [FAN, HAT, FAN],
    [FAN, FAN, FAN],
    [FAN, FAN, FAN]
  ]);
  const ev = M.evaluate(g);
  const wHat = ev.wins.find((w) => w.symbol === 'hat');
  assert.ok(wHat, 'يوجد فوز للقبعة');
  assert.equal(wHat.reels, 3);
  assert.equal(wHat.ways, 2);
  assert.equal(wHat.pay, M.PAYS[HAT][0] * 2);

  // FAN على كل البكرات الخمس
  const wFan = ev.wins.find((w) => w.symbol === 'fan');
  assert.ok(wFan, 'يوجد فوز للمروحة');
  assert.equal(wFan.reels, 5);
  assert.equal(wFan.ways, 2 * 1 * 2 * 3 * 3);
});

test('ماتادور: WILD يعوّض الرموز الدافعة ولا يعوّض السكاتر', () => {
  const g = grid([
    [GUITAR, FAN, FAN],
    [WILD, FAN, FAN],
    [GUITAR, FAN, FAN],
    [FAN, FAN, FAN],
    [FAN, FAN, FAN]
  ]);
  const ev = M.evaluate(g);
  const wG = ev.wins.find((w) => w.symbol === 'guitar');
  assert.ok(wG);
  assert.equal(wG.reels, 3);
  assert.equal(wG.ways, 1);
});

test('ماتادور: الانهيار — المؤطّر يتحوّل إلى WILD مكانه وغير المؤطّر ينفجر', () => {
  const g = grid([
    [HAT, FAN, FAN],
    [{ s: HAT, g: true, m: 3 }, FAN, FAN],
    [HAT, FAN, FAN],
    [FAN, FAN, FAN],
    [FAN, FAN, FAN]
  ]);
  const positions = [[0, 0], [1, 0], [2, 0]];
  const out = M.collapse(mulberry32(1), g, positions, 'base');
  assert.deepEqual(out.transform, [[1, 0]]);
  assert.equal(g[1][0].s, WILD, 'تحول إلى وايلد مكانه');
  assert.equal(out.drops[0].length, 1);
  assert.equal(out.drops[1].length, 0, 'لم يسقط بدله لأنه تحوّل في مكانه');
  assert.equal(out.drops[2].length, 1);
  g.forEach((col) => assert.equal(col.length, 3));
});

test('ماتادور: الحد الأدنى للفة العادية الرابحة لا يقل عن الرهان', () => {
  const rng = mulberry32(101);
  let wins = 0;
  for (let i = 0; i < 3000; i++) {
    const out = M.toMoney(M.playRound({ rng }), 1000);
    if (out.base.win > 0) {
      wins++;
      assert.ok(out.base.win >= 1000, `لفة رابحة بـ ${out.base.win} على رهان 1000`);
    }
  }
  assert.ok(wins > 500, 'فحص عدد كافٍ من اللفات الرابحة');
});

test('ماتادور: شراء الميزة يضمن 3 سكاتر على الأقل ولفات مجانية', () => {
  const rng = mulberry32(77);
  for (let i = 0; i < 100; i++) {
    const r = M.playRound({ buy: true, rng });
    assert.ok(r.base.scatters >= 3);
    assert.ok(r.feature && r.feature.spins.length >= 10);
  }
});

test('ماتادور: بالمال — خصم التكلفة (والشراء 80 ضعفاً) وصرف الربح وتسجيل الإحصائيات', async () => {
  calls.length = 0;
  const p = { id: 'PM1', balance: 100000 };
  const r = await M.spin(p, { bet: 1000 });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], 'debit');
  assert.equal(calls[0][2], 1000);
  if (r.win > 0) {
    const credit = calls.find((c) => c[0] === 'credit');
    assert.equal(credit[2], r.win);
  }
  assert.ok(calls.some((c) => c[0] === 'record'));

  // فحص الشراء: التكلفة 80x
  calls.length = 0;
  const pBuy = { id: 'PM2', balance: 100000 };
  const buyRes = await M.spin(pBuy, { bet: 1000, buy: true });
  assert.equal(buyRes.ok, true);
  assert.equal(calls[0][0], 'debit');
  assert.equal(calls[0][2], 80000);

  // رصيد ناقص للشراء
  calls.length = 0;
  const poor = { id: 'PM3', balance: 500 };
  const failRes = await M.spin(poor, { bet: 1000, buy: true });
  assert.equal(failRes.ok, false);
  assert.equal(calls.length, 0);
});

test('ماتادور: رهان غير صالح يُرفض، والتجربة لا تخصم شيئاً', async () => {
  calls.length = 0;
  for (const b of [-10, 0, 99, 1e7, 'bad', null]) {
    const res = await M.spin({ id: 'P', balance: 1e9 }, { bet: b });
    assert.equal(res.ok, false);
  }
  const d = M.demo({ bet: 1000 });
  assert.equal(d.ok, true);
  assert.equal(calls.length, 0);
});

test('ماتادور: الحالة العامة للاعب لا تُظهر نسباً أو جداول أوزان داخلية', () => {
  const st = M.stateFor({ balance: 5000, currency: 'IQD', username: 'MatadorHero' });
  assert.equal(st.loggedIn, true);
  assert.equal(st.balance, 5000);
  assert.equal(st.currency, 'IQD');
  assert.equal(st.username, 'MatadorHero');

  const serialized = JSON.stringify(st).toLowerCase();
  for (const forbidden of ['rtp', 'odds', 'probab', 'weight', 'base_calibration']) {
    assert.equal(serialized.includes(forbidden), false, `يجب عدم إرسال ${forbidden}`);
  }
});
