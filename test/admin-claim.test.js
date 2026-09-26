'use strict';

/**
 * ثغرة حرجة سابقة: POST /api/admin/claim (بلا مصادقة) كان يضيف مفتاح إدارة
 * لأي زائر. المطالبة الآن فقط حين يثبت من القاعدة أن لا مفاتيح إطلاقاً.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-claim-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.ICHANCE_ADMIN_KEY;

const secrets = new Map();
const db = { down: false };
const fake = {
  configured: () => true,
  enc: encodeURIComponent,
  async selectOne(t, q) {
    if (db.down) throw new Error('تعذّر الاتصال');
    const key = decodeURIComponent(q.match(/key=eq\.([^&]*)/)[1]);
    return secrets.has(key) ? { value: secrets.get(key) } : null;
  },
  async request(p, { body }) {
    if (db.down) throw new Error('تعذّر الاتصال');
    for (const r of body) secrets.set(r.key, r.value);
    return null;
  }
};
const supPath = require.resolve('../server/supabase');
require.cache[supPath] = { id: supPath, filename: supPath, loaded: true, exports: fake };

const authPath = require.resolve('../server/adminAuth');
const fresh = () => { delete require.cache[authPath]; return require('../server/adminAuth'); };

test('قاعدة فيها مفاتيح: المطالبة مرفوضة ولا يُضاف مفتاح', async () => {
  const A = fresh();
  const first = await A.claim('owner-key-000001');
  assert.equal(first.ok, true, 'أول تثبيت على قاعدة فارغة');
  const B = fresh();
  const attack = await B.claim('attacker-key-123');
  assert.equal(attack.ok, false);
  assert.equal(await B.verify('attacker-key-123'), false);
  assert.equal(await B.verify('owner-key-000001'), true);
});

test('تعذّر قراءة القاعدة: المطالبة مرفوضة (لا نعرف إن كانت هناك مفاتيح)', async () => {
  secrets.clear();
  const A = fresh();
  db.down = true;
  const out = await A.claim('attacker-key-456');
  db.down = false;
  assert.equal(out.ok, false);
  assert.equal(secrets.size, 0);
});

test('مفتاح البيئة مضبوط: المطالبة مرفوضة', async () => {
  secrets.clear();
  process.env.ICHANCE_ADMIN_KEY = 'env-admin-key-001';
  const A = fresh();
  const out = await A.claim('attacker-key-789');
  delete process.env.ICHANCE_ADMIN_KEY;
  assert.equal(out.ok, false);
});

test('الحالة العامة لا تكشف عدد المفاتيح', async () => {
  const A = fresh();
  const st = await A.publicStatus();
  assert.equal('keysCount' in st, false);
});
