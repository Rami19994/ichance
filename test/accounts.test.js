'use strict';

/**
 * حركة المال عند الكاشير، واتصال القاعدة — على قاعدة مُحاكاة.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-acc-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
process.env.ICHANCE_PING_RETRY_MS = '40';
delete process.env.VERCEL;

// الملف المحلّي: كاشير بعهدة ضخمة ولاعب — لو هرب الإيداع إلى الملف لنجح
// هنا حتماً، فنرى إن كان الرفض قد تُخطّي.
const LOCAL = path.join(TMP, 'accounts.json');
fs.writeFileSync(LOCAL, JSON.stringify({
  accounts: [
    { id: 'csh_1', role: 'cashier', active: true, balance: 1_000_000, unlimited_float: false },
    { id: 'ply_1', display_id: 'P1', role: 'player', active: true, balance: 1000, cashier_id: 'csh_1' }
  ],
  transactions: []
}));
const localPlayer = () => JSON.parse(fs.readFileSync(LOCAL, 'utf8')).accounts.find((a) => a.id === 'ply_1');

const db = { configured: true, ping: 'fail', deposit: 'ok' };

function fail(kind, { status = 400, code, raw, message } = {}) {
  const e = new Error(message || raw || kind);
  Object.assign(e, { kind, status, code, raw });
  return e;
}

const fake = {
  configured: () => db.configured,
  enc: encodeURIComponent,
  async ping() {
    return db.ping === 'ok' ? { ok: true } : { ok: false, error: 'انتهت مهلة الاتصال بقاعدة البيانات' };
  },
  async rpc(name, args) {
    if (name === 'cashier_deposit' || name === 'cashier_withdraw' || name === 'admin_adjust_cashier') {
      if (db.deposit === 'refused') throw fail('db', { code: 'P0001', raw: 'INSUFFICIENT_FLOAT', message: 'عهدتك لا تكفي — اطلب تعبئة من الإدارة' });
      if (db.deposit === 'down') throw fail('network', { status: 503, message: 'تعذّر الاتصال بقاعدة البيانات' });
      if (db.deposit === 'timeout') throw fail('timeout', { status: 503, message: 'انتهت مهلة الاتصال بقاعدة البيانات' });
      return { player_balance: 500, cashier_balance: 999_500 };
    }
    return { ok: true };
  },
  async selectOne(table, q) {
    if (table === 'accounts' && /play_token=eq\.tok_db/.test(q) && db.ping === 'ok') {
      return { id: 'ply_db', display_id: 'D1', role: 'player', active: true, play_token: 'tok_db', balance: 42 };
    }
    return null;
  },
  select: async () => [],
  insert: async () => [],
  update: async () => []
};
const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = {
  id: sbPath, filename: sbPath, loaded: true,
  exports: new Proxy(fake, { get: (t, k) => (k in t ? t[k] : async () => null) })
};
for (const k of ['log', 'warn', 'error']) console[k] = () => {};

const accounts = require('../server/accounts');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════ اتصال القاعدة

test('فحص اتصال فاشل لا يُثبَّت إلى الأبد — النسخة تعود للقاعدة حين تعود', async () => {
  // أوّل فحص يفشل (مهلة نسخة باردة): الجلسة غير موجودة مؤقّتاً
  assert.equal(await accounts.byToken('tok_db'), null);

  db.ping = 'ok';
  await wait(60);                                   // بعد مهلة إعادة الفحص
  const row = await accounts.byToken('tok_db');
  assert.ok(row, 'بقيت النسخة تقرأ من الملف المحلّي الفارغ — اللاعب مطرود');
  assert.equal(row.id, 'ply_db');
});

// ═══════════════════════════════════════════ الإيداع والسحب

test('رفض القاعدة للإيداع نهائي — لا يُعاد على الملف المحلّي', async () => {
  db.deposit = 'refused';
  const out = await accounts.deposit({ cashierId: 'csh_1', playerId: 'ply_1', amount: 500 });
  assert.equal(out.ok, false);
  assert.match(out.error, /عهدتك لا تكفي/);
  assert.equal(localPlayer().balance, 1000, 'الإيداع المرفوض نُفّذ على الملف');
});

test('القاعدة منقطعة: الإيداع لم يتمّ — لا يُسجَّل في ملف لا يراه أحد', async () => {
  db.deposit = 'down';
  const out = await accounts.deposit({ cashierId: 'csh_1', playerId: 'ply_1', amount: 500 });
  assert.equal(out.ok, false);
  assert.equal(localPlayer().balance, 1000);
});

test('السحب يتبع القاعدة نفسها', async () => {
  db.deposit = 'refused';
  const out = await accounts.withdraw({ cashierId: 'csh_1', playerId: 'ply_1', amount: 100 });
  assert.equal(out.ok, false);
  assert.equal(localPlayer().balance, 1000, 'السحب المرفوض نُفّذ على الملف');
});

test('انتهت المهلة: يُقال للكاشير إنها ربما تمّت — كي لا يكرّرها', async () => {
  db.deposit = 'timeout';
  const out = await accounts.deposit({ cashierId: 'csh_1', playerId: 'ply_1', amount: 500 });
  assert.equal(out.ok, false);
  assert.match(out.error, /قد تكون العملية تمّت/);
});

test('إيداع مقبول يعيد أرقام القاعدة', async () => {
  db.deposit = 'ok';
  const out = await accounts.deposit({ cashierId: 'csh_1', playerId: 'ply_1', amount: 500 });
  assert.equal(out.ok, true);
  assert.equal(out.player_balance, 500);
  assert.equal(localPlayer().balance, 1000, 'القاعدة هي الدفتر — الملف لا يُمسّ');
});

test('بلا قاعدة (تطوير محلّي): الملف هو الدفتر', async () => {
  db.configured = false;
  const out = await accounts.deposit({ cashierId: 'csh_1', playerId: 'ply_1', amount: 500 });
  assert.equal(out.ok, true);
  assert.equal(localPlayer().balance, 1500);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* تجاهل */ } });
