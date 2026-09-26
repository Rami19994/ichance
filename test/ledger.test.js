'use strict';

/**
 * الدفتر الواحد: حين تكون القاعدة مضبوطة لا يحلّ محلّها ملف محلّي، والسجلّ
 * المالي لا يُمحى، ولا «تمّ» كاذبة، ولا يكشف الدخول أيّ الأسماء موجودة.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ledger-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.VERCEL;

// ملف محلّي فيه حساب «قديم» برمز جلسة — لو رجعت الدوال إليه لظهر هنا
const LOCAL = path.join(TMP, 'accounts.json');
fs.writeFileSync(LOCAL, JSON.stringify({
  accounts: [
    { id: 'ply_stale', display_id: 'S1', role: 'player', active: true, balance: 999999,
      play_token: 'tok_stale', username: 'stale', username_key: 'stale' }
  ],
  transactions: []
}));
const localAccounts = () => JSON.parse(fs.readFileSync(LOCAL, 'utf8')).accounts;

// ─────────────────────────────────────────── قاعدة مُحاكاة
const db = {
  configured: true,
  down: false,
  accounts: new Map(),
  txlog: [],            // { player_id, cashier_id, master_id }
  rounds: [],           // { player_id }
  secrets: new Map(),
  requests: []          // كل طلب تعديل/حذف — لنتأكّد أن السجلّ لم يُمسّ
};
const NET = () => Object.assign(new Error('تعذّر الاتصال بقاعدة البيانات'), { kind: 'network', status: 503 });
const guard = () => { if (db.down) throw NET(); };
const eqOf = (q, k) => { const m = q.match(new RegExp(`(?:^|[&(,])${k}=eq\\.([^&),]*)`)); return m && decodeURIComponent(m[1]); };
const orIds = (q) => [...q.matchAll(/([a-z_]+)\.eq\.([^,)]*)/g)].map((m) => [m[1], decodeURIComponent(m[2])]);

const fake = {
  configured: () => db.configured,
  enc: encodeURIComponent,
  ping: async () => ({ ok: !db.down }),
  async selectOne(table, q) {
    guard();
    if (table === 'accounts') {
      const token = eqOf(q, 'play_token');
      if (token) return [...db.accounts.values()].find((a) => a.play_token === token) || null;
      const id = eqOf(q, 'id');
      if (id && !q.includes('or=')) return db.accounts.get(id) || null;
      if (q.includes('or=(')) {
        const keys = orIds(q);
        return [...db.accounts.values()].find((a) => keys.some(([k, v]) => a[k] === v)) || null;
      }
    }
    if (table === 'site_secrets') {
      const k = eqOf(q, 'key');
      return db.secrets.has(k) ? { value: db.secrets.get(k) } : null;
    }
    return null;
  },
  async select(table, q) {
    guard();
    if (table === 'accounts' && q.includes('or=(')) {
      const keys = orIds(q);
      return [...db.accounts.values()].filter((a) => keys.some(([k, v]) => a[k] === v)).slice(0, 1);
    }
    if (table === 'transaction_log') {
      const keys = orIds(q);
      return db.txlog.filter((t) => keys.some(([k, v]) => t[k] === v)).slice(0, 1);
    }
    if (table === 'game_rounds') return db.rounds.filter((r) => r.player_id === eqOf(q, 'player_id')).slice(0, 1);
    return [];
  },
  async insert(table, row) {
    guard();
    db.requests.push({ method: 'POST', table });
    const r = { id: 'ply_' + Math.random().toString(16).slice(2, 10), active: true, ...row };
    db.accounts.set(r.id, r);
    return [r];
  },
  async update(table, q, patch) {
    guard();
    db.requests.push({ method: 'PATCH', table, q });
    const id = eqOf(q, 'id');
    if (table === 'accounts' && id && db.accounts.has(id)) Object.assign(db.accounts.get(id), patch);
    return [];
  },
  async request(pathname, { method = 'GET', body } = {}) {
    guard();
    const [, table, q = ''] = pathname.match(/\/rest\/v1\/([a-z_]+)\??(.*)$/) || [];
    db.requests.push({ method, table, q });
    if (table === 'site_secrets' && method === 'POST') {
      for (const r of body) db.secrets.set(r.key, r.value);
    }
    if (table === 'accounts' && method === 'DELETE') db.accounts.delete(eqOf(q, 'id'));
    return null;
  },
  async rpc() { guard(); return { ok: true }; }
};
const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = {
  id: sbPath, filename: sbPath, loaded: true,
  exports: new Proxy(fake, { get: (t, k) => (k in t ? t[k] : async () => null) })
};
for (const k of ['log', 'warn', 'error']) console[k] = () => {};

const accounts = require('../server/accounts');

function reset() {
  db.configured = true;
  db.down = false;
  db.accounts.clear();
  db.txlog = [];
  db.rounds = [];
  db.requests = [];
  delete process.env.VERCEL;
}
function account(row) {
  const r = { active: true, balance: 0, ...row };
  db.accounts.set(r.id, r);
  return r;
}

// ═══════════════════════════════════════════ لا ملف محلّي بديلاً عن القاعدة

test('القاعدة منقطعة: لا يُنشأ لاعب في الملف المحلّي', async () => {
  reset();
  db.down = true;
  const before = localAccounts().length;
  const out = await accounts.createPlayer({ cashierId: null, username: 'newguy', email: 'newguy@gmail.com', password: 'secret123' });
  assert.equal(out.ok, false);
  assert.equal(localAccounts().length, before, 'لاعب لا تعرفه القاعدة أُنشئ في الملف');
});

test('القاعدة منقطعة: رمز جلسة قديم في الملف المحلّي لا يُدخل صاحبه', async () => {
  reset();
  db.down = true;
  assert.equal(await accounts.byToken('tok_stale'), null);
});

test('القاعدة منقطعة: الدخول يرفض بدل أن يُدخل بحساب من الملف', async () => {
  reset();
  db.down = true;
  const out = await accounts.login('stale', 'whatever');
  assert.equal(out.ok, false);
});

test('على Vercel بلا قاعدة: لا دخول ولا إنشاء ولا إيداع على /tmp', async () => {
  reset();
  db.configured = false;
  process.env.VERCEL = '1';
  assert.equal((await accounts.createPlayer({ username: 'x1abc', email: 'x1abc@gmail.com', password: 'secret123' })).ok, false);
  assert.equal((await accounts.login('stale', 'x')).ok, false);
  assert.equal((await accounts.deposit({ cashierId: 'c', playerId: 'p', amount: 100 })).ok, false);
  assert.equal(await accounts.byToken('tok_stale'), null);
});

// ═══════════════════════════════════════════ لا «تمّ» كاذبة

test('إيقاف حساب يفشل في القاعدة ← خطأ، لا «تمّ»', async () => {
  reset();
  account({ id: 'ply_1', role: 'player', cashier_id: 'csh_1' });
  // القراءة تنجح ثم تنقطع القاعدة قبل التحديث
  const realUpdate = fake.update;
  fake.update = async () => { throw NET(); };
  try {
    const out = await accounts.setActive({ accountId: 'ply_1', active: false, ownerId: 'csh_1' });
    assert.equal(out.ok, false, 'قيل «أوقِف» والحساب ما زال نشطاً');
    assert.equal(db.accounts.get('ply_1').active, true);
  } finally { fake.update = realUpdate; }
});

test('تغيير كلمة مرور يفشل في القاعدة ← خطأ، لا «تمّ»', async () => {
  reset();
  account({ id: 'ply_1', role: 'player', cashier_id: 'csh_1' });
  const realUpdate = fake.update;
  fake.update = async () => { throw NET(); };
  try {
    const out = await accounts.setPlayerPassword({ playerId: 'ply_1', newPassword: 'another123', ownerId: 'csh_1' });
    assert.equal(out.ok, false);
  } finally { fake.update = realUpdate; }
});

// ═══════════════════════════════════════════ الملكية

test('الماستر يوقف كاشيراً من كاشيريته — كان مستحيلاً', async () => {
  reset();
  account({ id: 'csh_1', role: 'cashier', master_id: 'mst_1' });
  const out = await accounts.setActive({ accountId: 'csh_1', active: false, ownerId: 'mst_1', ownerField: 'master_id' });
  assert.equal(out.ok, true);
  assert.equal(db.accounts.get('csh_1').active, false);
});

test('ولا يوقف كاشير ماستر آخر', async () => {
  reset();
  account({ id: 'csh_2', role: 'cashier', master_id: 'mst_2' });
  const out = await accounts.setActive({ accountId: 'csh_2', active: false, ownerId: 'mst_1', ownerField: 'master_id' });
  assert.equal(out.ok, false);
  assert.equal(db.accounts.get('csh_2').active, true);
});

test('والكاشير لا يمسّ لاعب كاشير آخر', async () => {
  reset();
  account({ id: 'ply_9', role: 'player', cashier_id: 'csh_other' });
  assert.equal((await accounts.setActive({ accountId: 'ply_9', active: false, ownerId: 'csh_1' })).ok, false);
  assert.equal((await accounts.setPlayerPassword({ playerId: 'ply_9', newPassword: 'hijack123', ownerId: 'csh_1' })).ok, false);
  assert.equal((await accounts.deleteAccount({ accountId: 'ply_9', ownerId: 'csh_1', ownerField: 'cashier_id' })).ok, false);
});

// ═══════════════════════════════════════════ السجلّ المالي لا يُمحى

const touchedHistory = () => db.requests.filter((r) =>
  ['transaction_log', 'transactions', 'game_rounds', 'balance_anomalies'].includes(r.table)
  && (r.method === 'DELETE' || r.method === 'PATCH'));

test('حذف لاعب له حركات: يُرفض، والحركات باقية', async () => {
  reset();
  account({ id: 'ply_1', role: 'player', cashier_id: 'csh_1' });
  db.txlog.push({ player_id: 'ply_1', cashier_id: 'csh_1' });
  const out = await accounts.deleteAccount({ accountId: 'ply_1', ownerId: 'csh_1', ownerField: 'cashier_id' });
  assert.equal(out.ok, false);
  assert.match(out.error, /سجلّ مالي/);
  assert.ok(db.accounts.has('ply_1'));
  assert.deepEqual(touchedHistory(), [], 'مُسّ السجلّ المالي');
});

test('حذف كاشير عهدته صفر وله حركات: يُرفض — كان يمحو كل ما فعله مع لاعبيه', async () => {
  reset();
  account({ id: 'csh_1', role: 'cashier', master_id: 'mst_1', balance: 0 });
  db.txlog.push({ player_id: 'ply_x', cashier_id: 'csh_1' });
  const out = await accounts.deleteAccount({ accountId: 'csh_1', ownerId: 'mst_1', ownerField: 'master_id' });
  assert.equal(out.ok, false);
  assert.deepEqual(touchedHistory(), []);
});

test('حذف لاعب له جولات لعب: يُرفض', async () => {
  reset();
  account({ id: 'ply_1', role: 'player', cashier_id: 'csh_1' });
  db.rounds.push({ player_id: 'ply_1' });
  assert.equal((await accounts.deleteAccount({ accountId: 'ply_1', ownerId: 'csh_1', ownerField: 'cashier_id' })).ok, false);
});

test('حذف حساب له رصيد: يُرفض — حتى للإدارة', async () => {
  reset();
  account({ id: 'ply_1', role: 'player', cashier_id: 'csh_1', balance: 5000 });
  const out = await accounts.deleteAccount({ accountId: 'ply_1' });
  assert.equal(out.ok, false);
  assert.ok(db.accounts.has('ply_1'), 'مال لاعب مُحي');
});

test('حذف كاشير له لاعبون: يُرفض — لا يُترك لاعب بلا كاشير', async () => {
  reset();
  account({ id: 'csh_1', role: 'cashier', balance: 0 });
  account({ id: 'ply_1', role: 'player', cashier_id: 'csh_1' });
  assert.equal((await accounts.deleteAccount({ accountId: 'csh_1' })).ok, false);
});

test('حساب لم يُستعمل (أُنشئ بالخطأ) يُحذف', async () => {
  reset();
  account({ id: 'ply_new', role: 'player', cashier_id: 'csh_1' });
  const out = await accounts.deleteAccount({ accountId: 'ply_new', ownerId: 'csh_1', ownerField: 'cashier_id' });
  assert.equal(out.ok, true);
  assert.equal(db.accounts.has('ply_new'), false);
  assert.deepEqual(touchedHistory(), []);
});

// ═══════════════════════════════════════════ الدخول

test('الدخول لا يكشف أيّ الأسماء موجودة', async () => {
  reset();
  const { hash, salt } = accounts.hashPassword('right-pass-1');
  account({ id: 'ply_1', role: 'player', username_key: 'realuser', password_hash: hash, password_salt: salt });
  const unknown = await accounts.login('nobody-here', 'whatever1');
  const wrong = await accounts.login('realuser', 'wrong-pass-1');
  assert.equal(unknown.ok, false);
  assert.equal(wrong.ok, false);
  assert.equal(unknown.error, wrong.error, 'رسالتان مختلفتان تكشفان أن الاسم موجود');
  assert.equal((await accounts.login('realuser', 'right-pass-1')).ok, true);
});

// ═══════════════════════════════════════════ شرائح العمولة

test('شرائح العمولة تُحفظ في القاعدة — كانت تضيع مع كل تشغيل بارد', async () => {
  reset();
  const tiers = [{ min_burn: 0, rate: 5 }, { min_burn: 100000, rate: 8 }];
  assert.equal((await accounts.setCommissionTiers(tiers)).ok, true);
  assert.ok(db.secrets.has('commission_tiers'));
  const back = JSON.parse(db.secrets.get('commission_tiers'));
  assert.equal(back[1].rate, 8);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* تجاهل */ } });
