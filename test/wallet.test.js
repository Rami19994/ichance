'use strict';

/**
 * اختبارات المحفظة وطابور الفروق — على قاعدة بيانات مُحاكاة.
 *
 * لا نلمس قاعدة الإنتاج: نزرع بديلاً لـ server/supabase في ذاكرة الوحدات قبل
 * تحميل أي شيء، يتصرّف كما تتصرّف القاعدة الحقيقية (يرفض رصيداً لا يكفي،
 * يتراجع عن النداء كلّه عند الخطأ، يسجّل الجولة برقم الحركة) — ونستطيع أن
 * نأمره بأن ينقطع أو يتأخّر أو ينفّذ ثم يضيع ردّه.
 *
 * كل اختبار هنا حالة كانت تُفقد مالاً أو تخلقه من العدم.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─────────────────────────────────────────── بيئة معزولة
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-wallet-'));
process.env.ICHANCE_DATA = path.join(TMP, 'players.json');
delete process.env.VERCEL;

// دفتر محلّي فيه حسابان: لاعب القاعدة (للتأكّد أن الفشل لا يلمس الملف)
// ولاعب محلّي (لاختبار وضع «بلا قاعدة»)
fs.writeFileSync(path.join(TMP, 'accounts.json'), JSON.stringify({
  accounts: [
    { id: 'ply_1', display_id: 'P1', role: 'player', active: true, balance: 1000 },
    { id: 'ply_local', display_id: 'L1', role: 'player', active: true, balance: 500 }
  ],
  transactions: []
}));

// ─────────────────────────────────────────── قاعدة مُحاكاة
const db = {
  configured: true,
  balances: new Map(),
  rounds: [],
  mode: {},              // gw_debit / gw_credit / apply_game_deltas / select
  deltaCalls: 0,
  release: null
};

function fail(kind, { status = 400, code, raw } = {}) {
  const e = new Error(raw || kind);
  Object.assign(e, { kind, status, code, raw });
  return e;
}
const NETWORK = () => fail('network', { status: 503, raw: 'fetch failed' });
const TIMEOUT = () => fail('timeout', { status: 503, raw: 'This operation was aborted' });
const RAISE = (msg) => fail('db', { status: 400, code: 'P0001', raw: msg });
const FK = () => fail('db', {
  status: 409, code: '23503',
  raw: 'insert or update on table "game_rounds" violates foreign key constraint "game_rounds_game_id_fkey"'
});

/** gw_debit / gw_credit كما في القاعدة: فحوص، ثم تحديث، ثم تسجيل الجولة — كلّه أو لا شيء. */
function walletCall(action, { p_player, p_amount, p_tx_ref }) {
  const mode = db.mode[action === 'debit' ? 'gw_debit' : 'gw_credit'] || 'ok';
  if (mode === 'down') throw NETWORK();
  if (mode === 'timeout-before') throw TIMEOUT();
  // نسخ أخرى من الدالّة تُرجع ok:false بدل أن ترفع استثناءً
  if (mode === 'soft-refuse') return { ok: false, error: 'INSUFFICIENT_BALANCE' };
  if (mode === 'soft-unknown-game') return { ok: false, error: 'GAME_NOT_FOUND' };

  if (!db.balances.has(p_player)) throw RAISE('PLAYER_NOT_FOUND');
  const bal = db.balances.get(p_player);
  if (action === 'debit' && bal < p_amount) throw RAISE('INSUFFICIENT_BALANCE');
  // المفتاح الأجنبي يُفحص عند إدراج الجولة — بعد فحص الرصيد، فتتراجع المعاملة كلّها
  if (mode === 'fk') throw FK();

  const next = action === 'debit' ? bal - p_amount : bal + p_amount;
  db.balances.set(p_player, next);
  db.rounds.push({ player_id: p_player, tx_ref: p_tx_ref, action });
  if (mode === 'timeout-after') throw TIMEOUT();          // نُفِّذ وضاع الردّ
  return { ok: true, balance: next };
}

async function applyDeltas({ p_items }) {
  const mode = db.mode.apply_game_deltas || 'ok';
  if (mode === 'down') throw NETWORK();
  if (mode === 'hold') await new Promise((r) => { db.release = r; });
  db.deltaCalls++;
  for (const { id, delta } of p_items) {
    if (db.balances.has(id)) db.balances.set(id, Math.max(0, db.balances.get(id) + delta));
  }
  return { ok: true };
}

const fake = {
  configured: () => db.configured,
  config: () => (db.configured ? { url: 'https://sim.supabase.co', key: 'sim', source: 'env' } : null),
  ping: async () => ({ ok: db.configured }),
  enc: encodeURIComponent,
  async rpc(name, args) {
    if (name === 'gw_debit') return walletCall('debit', args);
    if (name === 'gw_credit') return walletCall('credit', args);
    if (name === 'apply_game_deltas') return applyDeltas(args);
    return { ok: true };
  },
  async select(table, q = '') {
    if (table !== 'game_rounds') return [];
    if (db.mode.select === 'down') throw NETWORK();
    const get = (k) => { const m = q.match(new RegExp(`${k}=eq\\.([^&]*)`)); return m && decodeURIComponent(m[1]); };
    return db.rounds.filter((r) => r.player_id === get('player_id')
      && r.tx_ref === get('tx_ref') && r.action === get('action'));
  },
  selectOne: async () => null,
  insert: async () => [],
  update: async () => [],
  request: async () => ({})
};
const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = {
  id: sbPath, filename: sbPath, loaded: true,
  exports: new Proxy(fake, { get: (t, k) => (k in t ? t[k] : async () => []) })
};

// الرسائل المتوقّعة (انقطاع، فشل كتابة) تُسجَّل ولا تُطبع وسط نتائج الاختبار
const logs = [];
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => logs.push(a.join(' '));

const accounts = require('../server/accounts');
const store = require('../server/store');

// ─────────────────────────────────────────── أدوات
const ROW = { id: 'ply_1', display_id: 'P1', play_token: 'tok_1', username: 'p1', cashier_id: 'c1' };

/** يبدأ كل اختبار من حالة نظيفة: لا فروق معلّقة، والذاكرة = القاعدة = balance. */
async function fresh(balance) {
  db.mode = {};
  db.configured = true;
  for (let i = 0; i < 5 && accounts.hasPending('ply_1'); i++) await accounts.flushDeltas();
  assert.equal(accounts.hasPending('ply_1'), false, 'فروق عالقة من اختبار سابق');
  db.balances.set('ply_1', balance);
  db.rounds = [];
  db.deltaCalls = 0;
  return store.attachAccount({ ...ROW, balance });
}
let ref = 0;
const tx = () => `t-${++ref}`;

// ═══════════════════════════════════════════ الخصم (الرهان)

test('خصم مؤكَّد: الذاكرة تساوي القاعدة', async () => {
  const p = await fresh(1000);
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), true);
  assert.equal(p.balance, 900);
  assert.equal(db.balances.get('ply_1'), 900);
});

test('رفض الرصيد لا يُتجاوَز: لا رهان من الذاكرة بعد سحب الكاشير', async () => {
  const p = await fresh(1000);
  db.balances.set('ply_1', 50);            // الكاشير سحب — الذاكرة ما زالت 1000
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), false);
  assert.equal(accounts.hasPending('ply_1'), false, 'لا فرق يُدفع إلى القاعدة');
  assert.equal(db.balances.get('ply_1'), 50);
});

test('لا اتصال: لا رهان بلا دفتر', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'down';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), false);
  assert.equal(p.balance, 1000);
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('انتهت المهلة بعد التنفيذ: الرهان قائم ولا يُخصم مرّتين', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'timeout-after';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), true);
  assert.equal(p.balance, 900);
  assert.equal(db.balances.get('ply_1'), 900);
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('انتهت المهلة قبل التنفيذ: لا رهان ولا خصم', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'timeout-before';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), false);
  assert.equal(p.balance, 1000);
  assert.equal(db.balances.get('ply_1'), 1000);
});

test('مهلة ولا يمكن السؤال عن مصيرها: لا رهان', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'timeout-before';
  db.mode.select = 'down';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), false);
  assert.equal(p.balance, 1000);
});

test('لعبة غير مسجّلة (مفتاح أجنبي): الرهان يمرّ عبر الطابور ويُكتب مرّة واحدة', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'fk';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), true);
  assert.equal(p.balance, 900);
  assert.equal(db.balances.get('ply_1'), 900, 'مكتوب قبل أن يُقبل الرهان');
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('عبر الطابور ولم يثبت في الدفتر: يُلغى الرهان كاملاً', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'fk';
  db.mode.apply_game_deltas = 'down';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), false);
  assert.equal(p.balance, 1000);
  assert.equal(accounts.hasPending('ply_1'), false, 'لا يبقى خصمٌ معلّق لرهان رُفض');
  assert.equal(db.balances.get('ply_1'), 1000);
});

test('ردّ ok:false بسبب الرصيد: لا رهان', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'soft-refuse';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), false);
  assert.equal(p.balance, 1000);
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('ردّ ok:false لسبب بنيوي: الرهان يمرّ عبر الطابور ولا تتوقّف اللعبة', async () => {
  const p = await fresh(1000);
  db.mode.gw_debit = 'soft-unknown-game';
  assert.equal(await store.gameDebit('neon-slots', p, 100, tx()), true);
  assert.equal(db.balances.get('ply_1'), 900);
});

// ═══════════════════════════════════════════ الصرف (الربح)

test('لا اتصال: الربح لا يضيع، يُكتب مرّة واحدة حين تعود القاعدة', async () => {
  const p = await fresh(1000);
  db.mode.gw_credit = 'down';
  db.mode.apply_game_deltas = 'down';
  assert.equal(await store.gameCredit('neon-slots', p, 300, tx()), true);
  assert.equal(p.balance, 1300);
  assert.equal(db.balances.get('ply_1'), 1000);
  assert.equal(accounts.hasPending('ply_1'), true);

  // محاولات كتابة والقاعدة ما زالت منقطعة — لا يجوز أن يضيع الربح فيها
  await accounts.flushDeltas();
  await accounts.flushDeltas();
  assert.equal(accounts.hasPending('ply_1'), true, 'الربح اختفى من الطابور أثناء الانقطاع');

  db.mode.apply_game_deltas = 'ok';
  await accounts.flushDeltas();
  await accounts.flushDeltas();
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 1300, 'مرّة واحدة، لا مرّتين ولا صفر');
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('انتهت المهلة بعد الصرف: لا يُصرف مرّتين', async () => {
  const p = await fresh(1000);
  db.mode.gw_credit = 'timeout-after';
  assert.equal(await store.gameCredit('neon-slots', p, 300, tx()), true);
  assert.equal(p.balance, 1300);
  // الصرف الثاني لا يظهر إلا حين يُكتب الطابور — فنكتبه ثم نحكم
  db.mode = {};
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 1300, 'صُرف مرّتين');
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('انتهت المهلة قبل الصرف: يُصرف مرّة عبر الطابور', async () => {
  const p = await fresh(1000);
  db.mode.gw_credit = 'timeout-before';
  assert.equal(await store.gameCredit('neon-slots', p, 300, tx()), true);
  assert.equal(p.balance, 1300);
  assert.equal(db.balances.get('ply_1'), 1300);
});

// ═══════════════════════════════════════════ طابور الفروق

test('الطابور لا يموت بعد أول كتابة ناجحة', async () => {
  // كانت الكتابة الناجحة تعود قبل أن تُنزل راية «جارٍ»، فكل كتابة بعدها
  // تعود فوراً بلا شيء، وتتراكم الفروق في الذاكرة حتى يُعاد تشغيل الخادم
  // — فتضيع. هذا ما كان يُرجع الرصيد بعد التحديث.
  await fresh(1000);
  accounts.queueDelta('ply_1', 100);
  await accounts.flushDeltas();
  accounts.queueDelta('ply_1', 50);
  await accounts.flushDeltas();
  accounts.queueDelta('ply_1', 25);
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 1175);
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('فشل الكتابة يُبقي الفروق — كانت تُحذف قبل النداء فتضيع', async () => {
  await fresh(1000);
  db.mode.apply_game_deltas = 'down';
  accounts.queueDelta('ply_1', 250);
  await accounts.flushDeltas();
  assert.equal(accounts.hasPending('ply_1'), true);
  assert.equal(db.balances.get('ply_1'), 1000);

  db.mode.apply_game_deltas = 'ok';
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 1250);
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('فشل الكتابة لا يمسّ الملف المحلّي — كان يُضاف إليه الفرق كل 5 ثوانٍ', async () => {
  await fresh(1000);
  const localBalance = () => JSON.parse(fs.readFileSync(path.join(TMP, 'accounts.json'), 'utf8'))
    .accounts.find((a) => a.id === 'ply_1').balance;
  const before = localBalance();
  db.mode.apply_game_deltas = 'down';
  accounts.queueDelta('ply_1', 100);
  for (let i = 0; i < 4; i++) await accounts.flushDeltas();
  assert.equal(localBalance(), before);

  db.mode.apply_game_deltas = 'ok';
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 1100);
});

test('فروق تصل أثناء الكتابة تبقى — لا تضيع ولا تتكرّر', async () => {
  await fresh(1000);
  db.mode.apply_game_deltas = 'hold';
  accounts.queueDelta('ply_1', 100);
  const writing = accounts.flushDeltas();
  await new Promise((r) => setImmediate(r));
  accounts.queueDelta('ply_1', 50);               // وصل أثناء الكتابة
  db.release();
  await writing;
  assert.equal(db.balances.get('ply_1'), 1100);
  assert.equal(accounts.hasPending('ply_1'), true);

  db.mode.apply_game_deltas = 'ok';
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 1150);
  assert.equal(accounts.hasPending('ply_1'), false);
});

test('flushPlayer ينتظر الكتابة الجارية ولا يتخطّاها', async () => {
  await fresh(1000);
  db.mode.apply_game_deltas = 'hold';
  accounts.queueDelta('ply_1', 100);
  const writing = accounts.flushDeltas();
  await new Promise((r) => setImmediate(r));

  let done = false;
  const waiting = accounts.flushPlayer('ply_1').then((ok) => { done = true; return ok; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'عاد قبل اكتمال الكتابة — كان الإيداع سيُحسب على رصيد قديم');

  db.release();
  await writing;
  assert.equal(await waiting, true);
  assert.equal(db.balances.get('ply_1'), 1100);
});

test('flushPlayer يقول الحقيقة: false حين تبقى الفروق معلّقة', async () => {
  await fresh(1000);
  db.mode.apply_game_deltas = 'down';
  accounts.queueDelta('ply_1', 100);
  assert.equal(await accounts.flushPlayer('ply_1'), false);
  db.mode.apply_game_deltas = 'ok';
  assert.equal(await accounts.flushPlayer('ply_1'), true);
});

// ═══════════════════════════════════════════ مزامنة الذاكرة مع القاعدة

test('الذاكرة تتبع القاعدة نزولاً — سحب الكاشير يظهر', async () => {
  const p = await fresh(1000);
  store.attachAccount({ ...ROW, balance: 400 });
  assert.equal(p.balance, 400, 'كانت تبقى 1000: «الأعلى بين الذاكرة والقاعدة»');
});

test('وحين توجد فروق لم تُكتب، الذاكرة أحدث فتبقى', async () => {
  const p = await fresh(1000);
  db.mode.apply_game_deltas = 'down';
  store.adjustBalance(p, -100);                    // 900 في الذاكرة، -100 معلّق
  store.attachAccount({ ...ROW, balance: 1000 });  // صفّ قديم من القاعدة
  assert.equal(p.balance, 900);
  db.mode.apply_game_deltas = 'ok';
  await accounts.flushDeltas();
  assert.equal(db.balances.get('ply_1'), 900);
});

// ═══════════════════════════════════════════ بلا قاعدة (يأتي أخيراً: يغيّر حالة الاتصال)

test('بلا قاعدة: الملف المحلّي هو الدفتر، والفرق يُطبَّق مرّة واحدة', async () => {
  await fresh(1000);
  db.configured = false;
  accounts.queueDelta('ply_local', 100);
  for (let i = 0; i < 4; i++) await accounts.flushDeltas();
  const local = JSON.parse(fs.readFileSync(path.join(TMP, 'accounts.json'), 'utf8'))
    .accounts.find((a) => a.id === 'ply_local');
  assert.equal(local.balance, 600);
  assert.equal(accounts.hasPending('ply_local'), false);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* تجاهل */ } });
