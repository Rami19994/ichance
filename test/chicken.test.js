'use strict';

/**
 * طريق الدجاجة: الرياضيات (≤ 96% عند كل نقطة جمع ولكل صعوبة)، وقواعد المال
 * (الرهان مرّة، الجائزة مرّة، لا جمع بعد اصطدام، لا دفع مرّتين من طلبين
 * متزامنين)، والجولات المتروكة لا تأكل مال اللاعب.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-chicken-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.VERCEL;

const supabase = require('../server/supabase');
supabase.configured = () => false;

const store = require('../server/store');
const C = require('../server/chickenGame');
const rounds = require('../server/roundStore');

function freshPlayer(balance = 1000000) {
  const p = store.createPlayer();
  p.balance = balance;
  return p;
}

test('كل صعوبة: العائد عند كل نقطة جمع ≤ 96% والمضاعفات تصاعدية', () => {
  for (const diff of Object.keys(C.DIFFICULTIES)) {
    const L = C.LADDERS[diff];
    assert.equal(L.length, C.STEPS);
    for (let k = 1; k <= C.STEPS; k++) {
      const rtp = C.rtpAt(diff, k);
      assert.ok(rtp <= 0.96 + 1e-12, `${diff} خطوة ${k}: ${rtp}`);
      assert.ok(rtp > 0.95, `${diff} خطوة ${k}: التقريب أكل أكثر من نقطة (${rtp})`);
      if (k > 1) assert.ok(L[k - 1] > L[k - 2]);
    }
    assert.ok(L[0] > 1, 'أول خطوة تربح شيئاً');
  }
});

test('الواجهة لا تستلم احتمالات: الحالة فيها المضاعفات فقط', async () => {
  const st = await C.stateFor(freshPlayer());
  assert.ok(st.ladders && st.ladders.normal.length === 12);
  const json = JSON.stringify(st);
  assert.equal(/"p"\s*:/.test(json), false);
  assert.equal(/rtp|chance|prob/i.test(json), false);
});

test('جولة كاملة: الرهان يُخصم مرّة والجائزة = الرهان × مضاعف الخطوة', async () => {
  const p = freshPlayer(100000);
  let paid = 0;
  for (let i = 0; i < 60 && paid < 3; i++) {
    const before = p.balance;
    const s = await C.start(p, { bet: 1000, difficulty: 'easy' });
    assert.equal(s.ok, true, s.error);
    assert.equal(p.balance, before - 1000);
    const c = await C.cross(p);
    assert.equal(c.ok, true, c.error);
    if (!c.safe) {
      assert.equal(p.balance, before - 1000, 'الاصطدام لا يُعيد شيئاً');
      assert.equal((await C.cashOut(p)).ok, false, 'لا جمع بعد اصطدام');
      continue;
    }
    const out = await C.cashOut(p);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.win, Math.floor(1000 * C.LADDERS.easy[0]));
    assert.equal(p.balance, before - 1000 + out.win);
    paid++;
  }
  assert.ok(paid >= 1);
});

test('لا جمع قبل أول خطوة، ولا جولتان معاً', async () => {
  const p = freshPlayer();
  const s = await C.start(p, { bet: 500, difficulty: 'normal' });
  assert.equal(s.ok, true);
  assert.equal((await C.cashOut(p)).ok, false);
  const again = await C.start(p, { bet: 500, difficulty: 'normal' });
  assert.equal(again.ok, false);
  assert.equal(again.round.bet, 500, 'تُعاد الجولة الجارية ليكملها');
  await rounds.remove(C._keyOf(p));
});

test('الحدود والرصيد: رهان مرفوض لا يمسّ الرصيد ولا يفتح جولة', async () => {
  const p = freshPlayer(300);
  assert.equal((await C.start(p, { bet: 50 })).ok, false);
  assert.equal((await C.start(p, { bet: C.MAX_STAKE + 1 })).ok, false);
  assert.equal((await C.start(p, { bet: 1000 })).ok, false);
  assert.equal(p.balance, 300);
  assert.equal(await rounds.get(C._keyOf(p)), null);
});

/** يبدأ جولة ويعبر خطوة ناجحة — يعيد المحاولة حتى ينجح. */
async function aliveAtStepOne(p, difficulty = 'easy') {
  for (let i = 0; i < 100; i++) {
    const s = await C.start(p, { bet: 1000, difficulty });
    assert.equal(s.ok, true, s.error);
    const c = await C.cross(p);
    if (c.safe) return;
  }
  throw new Error('لم تنجُ خطوة في 100 محاولة');
}

test('جمعان متزامنان: يُدفع واحد فقط', async () => {
  const p = freshPlayer();
  await aliveAtStepOne(p);
  const before = p.balance;
  const [a, b] = await Promise.all([C.cashOut(p), C.cashOut(p)]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  const win = (a.ok ? a : b).win;
  assert.equal(p.balance, before + win);
});

test('خطوة وجمع متزامنان: لا يُحتسبان معاً على الحالة نفسها', async () => {
  for (let n = 0; n < 20; n++) {
    const p = freshPlayer();
    await aliveAtStepOne(p);
    const before = p.balance;
    const [x, y] = await Promise.all([C.cross(p), C.cashOut(p)]);
    const oks = [x, y].filter((r) => r.ok);
    assert.equal(oks.length, 1, 'واحد فقط يفوز بالحالة');
    if (y.ok) assert.equal(p.balance, before + y.win);
    await rounds.remove(C._keyOf(p));
  }
});

test('جولة متروكة: فيها خطوة ← تُجمع للاعب؛ بلا خطوات ← يُعاد الرهان', async () => {
  const p = freshPlayer();
  await aliveAtStepOne(p);
  const key = C._keyOf(p);
  let found = await rounds.get(key);
  const old = { ...found.value, at: Date.now() - C.ROUND_TTL_MS - 1000 };
  await rounds.swap(key, found.tag, old);
  const before = p.balance;
  const st = await C.stateFor(p);
  assert.equal(st.round, null);
  assert.equal(p.balance, before + Math.floor(1000 * C.LADDERS.easy[0]));

  const q = freshPlayer();
  await C.start(q, { bet: 700, difficulty: 'hard' });
  found = await rounds.get(C._keyOf(q));
  await rounds.swap(C._keyOf(q), found.tag, { ...found.value, at: Date.now() - C.ROUND_TTL_MS - 1000 });
  const qBefore = q.balance;
  const s2 = await C.start(q, { bet: 700, difficulty: 'hard' });
  assert.equal(s2.ok, true, 'جولة جديدة بعد حسم المتروكة');
  assert.equal(q.balance, qBefore + 700 - 700, 'أُعيد الرهان القديم ثم خُصم الجديد');
});

test('العائد الفعلي لاستراتيجية «اجمع عند الخطوة k» ≈ 96% (24,000 جولة)', async () => {
  const p = freshPlayer(1e12);
  const N = 8000;
  for (const [diff, k] of [['easy', 6], ['normal', 3], ['hard', 2]]) {
    let wagered = 0, won = 0;
    for (let i = 0; i < N; i++) {
      await C.start(p, { bet: 1000, difficulty: diff });
      wagered += 1000;
      let alive = true;
      for (let s = 0; s < k && alive; s++) alive = (await C.cross(p)).safe;
      if (alive) won += (await C.cashOut(p)).win;
    }
    const rtp = won / wagered;
    assert.ok(Math.abs(rtp - C.rtpAt(diff, k)) < 0.05, `${diff}@${k}: ${rtp}`);
  }
});
