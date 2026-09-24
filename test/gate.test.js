'use strict';

/**
 * بوابة المالك: لا مسار يفتحها إلا المسار الحالي المحفوظ.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-gate-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.ICHANCE_GATE_PATH;
delete process.env.VERCEL;

// بلا قاعدة: البوابة تحفظ مسارها في ملف داخل مجلّد الاختبار
const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = {
  id: sbPath, filename: sbPath, loaded: true,
  exports: new Proxy({ configured: () => false, enc: encodeURIComponent },
    { get: (t, k) => (k in t ? t[k] : async () => null) })
};
for (const k of ['log', 'warn', 'error']) console[k] = () => {};

const gate = require('../server/adminGate');

// كانت مكتوبة في الكود على مستودع عامّ وتفتح البوابة قبل المسار الحقيقي
const PUBLISHED = [
  '6a546f34f797ed19196b0d9392ae8979',
  'a18b77f4a88d5b55a55f13d409700361',
  '26b0213e43fdfe51d5c564182d6eebe3'
];

test('المسارات المنشورة في المستودع لا تفتح البوابة', async () => {
  for (const p of PUBLISHED) assert.equal(await gate.matches('/' + p), false, p);
});

test('أوّل تشغيل يولّد مساراً عشوائياً — لا مساراً ثابتاً من الكود', async () => {
  const g = await gate.current({ fresh: true });
  assert.match(g.path, /^[a-f0-9]{32}$/);
  assert.equal(PUBLISHED.includes(g.path), false);
  assert.equal(await gate.matches('/' + g.path), true);
});

test('التبديل يقتل المسار القديم', async () => {
  const before = (await gate.current({ fresh: true })).path;
  const r = await gate.rotatePath();
  assert.equal(r.ok, true);
  assert.notEqual(r.path, before);
  assert.equal(await gate.matches('/' + before), false, 'القديم ما زال يفتح');
  assert.equal(await gate.matches('/' + r.path), true);
});

test('مسار بشكل صحيح لكنه ليس الحالي لا يفتح', async () => {
  assert.equal(await gate.matches('/' + '0'.repeat(32)), false);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* تجاهل */ } });
