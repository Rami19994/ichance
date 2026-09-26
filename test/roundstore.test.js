'use strict';

/**
 * مخزن الجولات بمسار القاعدة: إنشاء لا يكرّر جولة، و«قارن ثم بدّل» على
 * updated_at ينجح لطلب واحد فقط من طلبين قرآ الحالة نفسها، والحذف المشروط
 * لا يحذف حالة أحدث. القاعدة هنا مُحاكاة تطبّق مرشّحات PostgREST كما هي.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rows = new Map();   // key -> { value, updated_at }
const fake = {
  configured: () => true,
  enc: encodeURIComponent,
  async selectOne(t, q) {
    assert.equal(t, 'site_secrets');
    const key = decodeURIComponent(q.match(/key=eq\.([^&]*)/)[1]);
    const r = rows.get(key);
    return r ? { value: r.value, updated_at: r.updated_at } : null;
  },
  async request(p, { method, body }) {
    const [, query = ''] = p.split('?');
    const params = new URLSearchParams(query);
    const eq = (name) => (params.has(name) ? params.get(name).replace(/^eq\./, '') : null);
    const key = eq('key');
    const stamp = eq('updated_at');
    const match = (r) => r && (stamp === null || Date.parse(r.updated_at) === Date.parse(stamp));
    if (method === 'POST') {
      for (const r of body) {
        if (rows.has(r.key)) throw Object.assign(new Error('duplicate key'), { code: '23505', status: 409 });
        rows.set(r.key, { value: r.value, updated_at: r.updated_at });
      }
      return null;
    }
    const r = rows.get(key);
    if (method === 'PATCH') {
      if (!match(r)) return [];
      rows.set(key, { value: body.value, updated_at: body.updated_at });
      return [{ key, ...rows.get(key) }];
    }
    if (method === 'DELETE') {
      if (!match(r)) return [];
      rows.delete(key);
      return [{ key }];
    }
    throw new Error('غير متوقّع: ' + method);
  }
};
const supPath = require.resolve('../server/supabase');
require.cache[supPath] = { id: supPath, filename: supPath, loaded: true, exports: fake };

const R = require('../server/roundStore');

test('إنشاء: جولة واحدة لكل مفتاح', async () => {
  const t1 = await R.create('round:x:1', { step: 0 });
  assert.ok(t1);
  assert.equal(await R.create('round:x:1', { step: 0 }), null);
  const got = await R.get('round:x:1');
  assert.deepEqual(got.value, { step: 0 });
  assert.equal(got.tag, t1);
});

test('قارن ثم بدّل: من قرأ الحالة القديمة لا يكتب فوق الأحدث', async () => {
  const a = await R.get('round:x:1');
  const b = await R.get('round:x:1');
  const t2 = await R.swap('round:x:1', a.tag, { step: 1 });
  assert.ok(t2);
  assert.notEqual(t2, a.tag);
  assert.equal(await R.swap('round:x:1', b.tag, { step: 99 }), null, 'الثاني يفشل');
  assert.deepEqual((await R.get('round:x:1')).value, { step: 1 });
});

test('تبديلان متتاليان في الملّي ثانية نفسها يأخذان وسمين مختلفين', async () => {
  let cur = await R.get('round:x:1');
  const tags = new Set([cur.tag]);
  for (let i = 0; i < 5; i++) {
    const t = await R.swap('round:x:1', cur.tag, { step: 2 + i });
    assert.ok(t);
    assert.equal(tags.has(t), false);
    tags.add(t);
    cur = await R.get('round:x:1');
  }
});

test('الحذف المشروط لا يحذف حالة أحدث، والحذف بالوسم الصحيح ينجح', async () => {
  const old = await R.get('round:x:1');
  await R.swap('round:x:1', old.tag, { step: 20 });
  assert.equal(await R.remove('round:x:1', old.tag), false);
  const now = await R.get('round:x:1');
  assert.equal(await R.remove('round:x:1', now.tag), true);
  assert.equal(await R.get('round:x:1'), null);
});
