'use strict';

/**
 * بولزآي X: الرياضيات (96% بالضبط لكل وضع، والسحب يتبع الأوزان)، وقواعد
 * المال (الرهان يُخصم مرّة، الربح يُضاف مرّة، و«ضاعف أو اخسر» فقط بمبلغ آخر
 * ربح وفرصة واحدة لكل ربح)، والواجهة لا تستلم نسباً ولا بذوراً.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// لاعب محلّي بلا قاعدة بيانات: المحفظة في الذاكرة
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-bullseye-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.VERCEL;

const supabase = require('../server/supabase');
supabase.configured = () => false;

const store = require('../server/store');
const B = require('../server/bullseyeGame');

function freshPlayer(balance = 1000000) {
  const p = store.createPlayer();
  p.balance = balance;
  B._gambles.delete(p.id);
  return p;
}

test('كل قرص: العائد 96% بالضبط والأوزان أعداد صحيحة موجبة', () => {
  for (const [key, wheel] of Object.entries(B.WHEELS)) {
    const total = wheel.reduce((a, s) => a + s.w, 0);
    const ev = wheel.reduce((a, s) => a + s.w * s.m, 0);
    assert.ok(wheel.every((s) => Number.isInteger(s.w) && s.w > 0), `${key}: وزن غير صالح`);
    assert.equal(ev * 100, total * 96, `${key}: العائد ليس 96%`);
  }
  for (const v of Object.values(B.RTP)) assert.equal(Number(v.toFixed(12)), 0.96);
});

test('الزاوية تقع في القطاع المُعلَن — حدود القطاعات بالضبط', () => {
  for (const key of Object.keys(B.WHEELS)) {
    const wheel = B.WHEELS[key];
    const total = wheel.reduce((a, s) => a + s.w, 0);
    let acc = 0;
    wheel.forEach((s, i) => {
      // على بُعد جزء من مليون من وحدة الوزن داخل كل حدّ (الحدّ نفسه تقريب عشري)
      assert.equal(B.sliceAt(wheel, (acc + 1e-6) / total), i, `${key}: بداية القطاع ${i}`);
      acc += s.w;
      assert.equal(B.sliceAt(wheel, (acc - 1e-6) / total), i, `${key}: نهاية القطاع ${i}`);
    });
  }
});

test('الزاوية = u × 360 والقطاع ما تقع فيه، والسحب منتظم في [0,1)', () => {
  const r = B.landArrow('classic', 0.5);
  assert.equal(r.angle, 180);
  assert.equal(r.slice, B.sliceAt(B.WHEELS.classic, 0.5));
  assert.equal(r.multiplier, B.WHEELS.classic[r.slice].m);
  for (let i = 0; i < 20000; i++) {
    const u = B.randomUnit();
    assert.ok(u >= 0 && u < 1);
  }
});

test('التوزيع الفعلي يطابق الأوزان (200,000 رمية)', () => {
  const wheel = B.WHEELS.classic;
  const total = wheel.reduce((a, s) => a + s.w, 0);
  const hits = new Array(wheel.length).fill(0);
  const N = 200000;
  let paid = 0;
  for (let n = 1; n <= N; n++) {
    const r = B.landArrow('classic');
    hits[r.slice]++;
    paid += r.multiplier;
  }
  // كل قطاع ضمن 5 انحرافات معيارية من حصّته
  wheel.forEach((s, i) => {
    const p = s.w / total;
    const sd = Math.sqrt(N * p * (1 - p));
    assert.ok(Math.abs(hits[i] - N * p) < 5 * sd + 1, `القطاع ${i}: ${hits[i]} مقابل ${N * p}`);
  });
  assert.ok(Math.abs(paid / N - 0.96) < 0.03, `عائد المحاكاة ${paid / N}`);
});

test('الرمية: يُخصم الرهان ويُضاف الربح مرّة واحدة، والرصيد = قبل − رهان + ربح', async () => {
  const p = freshPlayer(100000);
  for (const mode of ['classic', 'risk', 'double']) {
    for (let i = 0; i < 30; i++) {
      const before = p.balance;
      const r = await B.throwArrow(p, { mode, bet: 1000 });
      assert.equal(r.ok, true, r.error);
      assert.equal(p.balance, before - 1000 + r.win);
      const sum = r.arrows.reduce((a, x) => a + x.multiplier, 0);
      assert.equal(r.win, Math.floor(1000 * sum / r.arrows.length));
      assert.equal(r.arrows.length, mode === 'double' ? 2 : 1);
    }
  }
});

test('الرمية ترفض المبالغ خارج الحدود والرصيد غير الكافي والوضع المجهول', async () => {
  const p = freshPlayer(5000);
  assert.equal((await B.throwArrow(p, { mode: 'classic', bet: 50 })).ok, false);
  assert.equal((await B.throwArrow(p, { mode: 'classic', bet: B.MAX_STAKE + 1 })).ok, false);
  assert.equal((await B.throwArrow(p, { mode: 'classic', bet: 6000 })).ok, false);
  assert.equal((await B.throwArrow(p, { mode: 'nope', bet: 1000 })).ok, false);
  assert.equal(p.balance, 5000, 'رمية مرفوضة لا تمسّ الرصيد');
});

/** يرمي في وضع المخاطرة حتى يربح — يرجّع نتيجة الرمية الرابحة. */
async function winRisk(p) {
  for (let i = 0; i < 400; i++) {
    const r = await B.throwArrow(p, { mode: 'risk', bet: 1000 });
    if (r.win > 0) return r;
  }
  throw new Error('لم يربح في 400 رمية');
}

test('ضاعف أو اخسر: فقط بعد ربح في المخاطرة، وبمبلغه بالضبط', async () => {
  const p = freshPlayer();
  // بلا ربح سابق: مرفوض
  assert.equal((await B.gamble(p, { amount: 1000 })).ok, false);

  // الكلاسيك لا يمنح فرصة
  await B.throwArrow(p, { mode: 'classic', bet: 1000 });
  assert.equal((await B.gamble(p, { amount: 1000 })).ok, false);

  const r = await winRisk(p);
  assert.equal(r.gamble.available, true);
  assert.equal(r.gamble.amount, r.win);

  // مبلغ غير مطابق: مرفوض والفرصة باقية
  const bad = await B.gamble(p, { amount: r.win + 1 });
  assert.equal(bad.ok, false);
  const before = p.balance;
  const g = await B.gamble(p, { amount: r.win });
  assert.equal(g.ok, true, g.error);
  assert.equal(p.balance, before - r.win + g.win);
  assert.ok(g.win === 0 || g.win === r.win * 2);
});

test('ضاعف أو اخسر: طلبان متزامنان لا يخاطران بالربح نفسه مرّتين', async () => {
  const p = freshPlayer();
  const r = await winRisk(p);
  const [a, b] = await Promise.all([
    B.gamble(p, { amount: r.win }),
    B.gamble(p, { amount: r.win })
  ]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
});

test('ضاعف أو اخسر: رمية جديدة أو «سحب الأرباح» تُسقط الفرصة، والسلسلة تتوقّف عند الحدّ', async () => {
  const p = freshPlayer();
  let r = await winRisk(p);
  await B.throwArrow(p, { mode: 'classic', bet: 1000 });
  assert.equal((await B.gamble(p, { amount: r.win })).ok, false, 'رمية جديدة تُسقطها');

  r = await winRisk(p);
  B.collect(p);
  assert.equal((await B.gamble(p, { amount: r.win })).ok, false, 'سحب الأرباح يُسقطها');

  // سلسلة: لا تتجاوز MAX_GAMBLES خطوة
  for (let attempt = 0; attempt < 200; attempt++) {
    r = await winRisk(p);
    let amount = r.win, steps = 0;
    while (true) {
      const g = await B.gamble(p, { amount });
      if (!g.ok) break;
      steps++;
      if (!g.gamble.available) break;
      amount = g.gamble.amount;
    }
    assert.ok(steps <= B.MAX_GAMBLES, `سلسلة من ${steps} خطوات`);
    if (steps === B.MAX_GAMBLES) break;
  }
});

test('الحالة العامة للواجهة لا تحمل نسب عائد ولا نسب فوز ولا بذوراً', async () => {
  const p = freshPlayer();
  const st = B.stateFor(p);
  for (const k of ['rtp', 'hitRate', 'fair']) assert.equal(k in st, false, k);
  const r = await B.throwArrow(p, { mode: 'classic', bet: 1000 });
  assert.equal('fair' in r, false);
});

test('دفتر الموقع: كل رمية تُسجَّل في ربحية اللعبة', async () => {
  const p = freshPlayer();
  const g0 = { ...store.ledgerSummary().games.bullseye };
  const r = await B.throwArrow(p, { mode: 'classic', bet: 2000 });
  const g1 = store.ledgerSummary().games.bullseye;
  assert.equal(g1.wagered - g0.wagered, 2000);
  assert.equal(g1.paid - g0.paid, r.win);
  assert.equal(g1.bets - g0.bets, 1);
});
