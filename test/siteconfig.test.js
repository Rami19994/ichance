'use strict';

/**
 * تشغيل/إيقاف الألعاب يُحفظ في القاعدة (site_secrets) لا في ملف: نسخة خادم
 * أخرى (أو تشغيل بارد على Vercel) ترى الإيقاف نفسه، وفشل الحفظ لا يترك
 * نسخة واحدة على إعداد مختلف عن الباقي.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-site-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.ICHANCE_ADMIN_DOMAIN;

// قاعدة مُحاكاة: جدول site_secrets فقط
const table = new Map();
const db = { failWrites: false, failReads: false, reads: 0 };
const fake = {
  configured: () => true,
  enc: encodeURIComponent,
  async selectOne(t, q) {
    assert.equal(t, 'site_secrets');
    db.reads++;
    if (db.failReads) throw new Error('تعذّر الاتصال');
    const key = decodeURIComponent(q.match(/key=eq\.([^&]*)/)[1]);
    return table.has(key) ? { value: table.get(key) } : null;
  },
  async request(p, { body }) {
    assert.match(p, /site_secrets/);
    if (db.failWrites) throw new Error('تعذّر الحفظ');
    for (const r of body) table.set(r.key, r.value);
    return null;
  }
};
const supPath = require.resolve('../server/supabase');
require.cache[supPath] = { id: supPath, filename: supPath, loaded: true, exports: fake };

const cfgPath = require.resolve('../server/siteConfig');
/** «نسخة خادم» جديدة: وحدة siteConfig بلا أي حالة في الذاكرة. */
function freshInstance() {
  delete require.cache[cfgPath];
  return require('../server/siteConfig');
}

test('إيقاف لعبة يُحفظ في القاعدة وتراه نسخة خادم أخرى', async () => {
  const a = freshInstance();
  await a.refresh();
  assert.equal(a.gameEnabled('mines'), true);
  const out = await a.setGame('mines', false);
  assert.equal(out.ok, true);
  assert.equal(JSON.parse(table.get('site_config')).games.mines, false);
  assert.equal(fs.existsSync(path.join(TMP, 'site.json')), false, 'لا ملف محلّي حين القاعدة مربوطة');

  const b = freshInstance();
  await b.refresh();
  assert.equal(b.gameEnabled('mines'), false);
  assert.equal(b.gameEnabled('plinko'), true);
});

test('فشل الحفظ: خطأ للإدارة والإعداد لا يتغيّر', async () => {
  const a = freshInstance();
  await a.refresh();
  db.failWrites = true;
  const out = await a.setGame('plinko', false);
  db.failWrites = false;
  assert.equal(out.ok, false);
  assert.equal(a.gameEnabled('plinko'), true);
});

test('فشل القراءة لا يُسقط الطلب: تبقى آخر قيمة معروفة', async () => {
  const a = freshInstance();
  await a.refresh();
  assert.equal(a.gameEnabled('mines'), false);
  db.failReads = true;
  await a.refresh({ force: true });
  db.failReads = false;
  assert.equal(a.gameEnabled('mines'), false);
});

test('القراءة مخزّنة مؤقتاً: طلبات متتالية لا تضرب القاعدة كل مرّة', async () => {
  const a = freshInstance();
  const before = db.reads;
  await Promise.all([a.refresh(), a.refresh(), a.refresh()]);
  await a.refresh();
  assert.equal(db.reads - before, 1);
});

test('تعديل من نسخة لا يمحو تعديلاً حفظته نسخة أخرى للتو', async () => {
  const a = freshInstance();
  await a.refresh();
  // نسخة ثانية تشغّل الألغام وتوقف بلينكو
  const other = freshInstance();
  await other.refresh({ force: true });
  await other.setGame('mines', true);
  await other.setGame('plinko', false);
  // النسخة الأولى (ذاكرتها قديمة) توقف كروت الحظ — يجب ألّا تُرجع الألغام موقوفة
  await a.setGame('cards', false);
  const saved = JSON.parse(table.get('site_config')).games;
  assert.equal(saved.cards, false);
  assert.equal(saved.mines, true);
  assert.equal(saved.plinko, false);
});
