'use strict';

/**
 * بيانات الإدارة لا تضيع أبداً — على قاعدة مُحاكاة تطبّق مرشّحات PostgREST.
 *
 * كان كل خادم يكتب ذاكرته فوق store_data كلّه كل ثانية ونصف، فنسخة فتيّة
 * (أصفار) تمحو التاريخ، ونسختان متزامنتان تمحو إحداهما عمل الأخرى، وسجلّ
 * الجولات آخر 100 فقط. كل اختبار هنا حالة كانت تمحو بيانات.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.VERCEL;

// ─────────────────────────────────────────── site_secrets مُحاكى
const rows = new Map();   // key -> { value, updated_at }
const sim = { selectDown: 0, casNeverMatches: false, patches: 0, inserts: 0, reads: 0 };
const tick = () => new Promise((r) => setImmediate(r));
let clock = Date.parse('2026-01-01T00:00:00Z');
const stamp = () => new Date(clock += 7).toISOString();

function likeToRe(p) {
  return new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

const fake = {
  configured: () => true,
  config: () => ({ url: 'https://sim.supabase.co', key: 'sim', source: 'env' }),
  enc: encodeURIComponent,
  ping: async () => ({ ok: true }),
  async select() { await tick(); return []; },
  async rpc() { throw Object.assign(new Error('fetch failed'), { kind: 'network', status: 503 }); },
  async selectOne(table, q) {
    await tick();
    if (sim.selectDown > 0) { sim.selectDown -= 1; throw Object.assign(new Error('timeout'), { kind: 'timeout', status: 503 }); }
    assert.equal(table, 'site_secrets');
    sim.reads += 1;
    const key = decodeURIComponent(q.match(/key=eq\.([^&]*)/)[1]);
    const r = rows.get(key);
    return r ? { value: r.value, updated_at: r.updated_at } : null;
  },
  async request(p, { method = 'GET', body, prefer = '' } = {}) {
    await tick();
    const [, query = ''] = p.split('?');
    const params = new URLSearchParams(query);
    const keyFilters = params.getAll('key');
    const match = (k, r) => keyFilters.every((f) => {
      const [op, ...rest] = f.split('.');
      const v = rest.join('.');
      if (op === 'eq') return k === v;
      if (op === 'lt') return k < v;
      if (op === 'like') return likeToRe(v).test(k);
      throw new Error('مرشّح غير متوقّع ' + f);
    }) && (!params.has('updated_at') || (!sim.casNeverMatches
      && Date.parse(r.updated_at) === Date.parse(params.get('updated_at').replace(/^eq\./, ''))));

    if (method === 'GET') {
      let out = [...rows.entries()].filter(([k, r]) => match(k, r)).map(([k, r]) => ({ key: k, value: r.value }));
      if (params.get('order') === 'key.desc') out.sort((a, b) => (a.key < b.key ? 1 : -1));
      if (params.has('limit')) out = out.slice(0, Number(params.get('limit')));
      return out;
    }
    if (method === 'POST') {
      const out = [];
      for (const r of body) {
        if (rows.has(r.key)) {
          if (prefer.includes('ignore-duplicates')) continue;
          throw Object.assign(new Error('duplicate key'), { code: '23505', status: 409 });
        }
        sim.inserts += 1;
        rows.set(r.key, { value: r.value, updated_at: stamp() });
        out.push({ key: r.key, updated_at: rows.get(r.key).updated_at });
      }
      return prefer.includes('return=representation') ? out : null;
    }
    if (method === 'PATCH') {
      const hit = [...rows.entries()].filter(([k, r]) => match(k, r));
      for (const [k, r] of hit) { r.value = body.value; r.updated_at = stamp(); sim.patches += 1; }
      return hit.map(([k, r]) => ({ key: k, updated_at: r.updated_at }));
    }
    throw new Error('غير متوقّع: ' + method);
  }
};

const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: fake };

/** نسخة خادم جديدة كلياً (كنسخة Vercel فتيّة): ذاكرة فارغة وملف مؤقّت خاص. */
// كل نسخة لها حفظ دوري كل 1.5 ث؛ نسخة من اختبار سابق فيها تغيير لم يُحفظ
// كانت تكتبه أثناء اختبار لاحق على القاعدة المُحاكاة نفسها
const live = [];
test.afterEach(() => { while (live.length) live.pop()._stopTimer(); });

function instance() {
  process.env.ICHANCE_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-persist-')), 'players.json');
  for (const m of ['../server/config', '../server/store', '../server/roundLog']) {
    delete require.cache[require.resolve(m)];
  }
  const st = require('../server/store');
  live.push(st);
  return st;
}

const storeValue = () => JSON.parse(rows.get('store_data').value);
const rlogKeys = () => [...rows.keys()].filter((k) => k.startsWith('rlog:'));

function seedHistory() {
  rows.clear();
  rows.set('store_data', {
    updated_at: stamp(),
    value: JSON.stringify({
      savedAt: 1,
      ledger: {
        real: { wagered: 5000, paid: 4800, bets: 50, rounds: 50 },
        bot: { wagered: 0, paid: 0, bets: 0, rounds: 0 },
        games: { mines: { wagered: 5000, paid: 4800, bets: 50, rounds: 50 } },
        slotBuys: { count: 0, wagered: 0 },
        faucet: 0,
        since: 1000
      },
      playerStats: {
        OLD1: { id: 'OLD1', balance: 70, stats: { rounds: 50, wagered: 5000, won: 4800, best: 900, bestMultiplier: 9 },
          minesStats: { games: 50, wagered: 5000, won: 4800, best: 900 } }
      },
      rounds: [
        { roundId: 'mines-A', ts: 1700000000001, game: 'mines', seats: [{ id: 'OLD1', stake: 100, isBot: false, net: -100 }] },
        { roundId: 'mines-B', ts: 1700000000002, game: 'mines', seats: [{ id: 'OLD1', stake: 100, isBot: false, net: 50 }] },
        { roundId: 'plinko-C', ts: 1700000000003, game: 'plinko', seats: [{ id: 'OLD1', stake: 10, isBot: false, net: 0 }] }
      ]
    })
  });
}

test('نسخة فتيّة تعذّرت قراءتها الأولى لا تمحو التاريخ — تضيف عليه', async () => {
  seedHistory();
  sim.selectDown = 1;                 // القراءة الأولى عند الإقلاع تنتهي مهلتها
  const A = instance();
  await tick(); await tick();
  const p = A.createPlayer();
  A.recordMines(p, { bet: 100, win: 0 });
  await A.flush();

  const v = storeValue();
  assert.equal(v.ledger.real.wagered, 5100, 'التاريخ + الجولة الجديدة');
  assert.equal(v.ledger.games.mines.rounds, 51);
  assert.equal(v.ledger.since, 1000, 'بداية الدفتر الأقدم تبقى');
  assert.equal(v.playerStats.OLD1.stats.rounds, 50, 'اللاعب القديم لم يُمسح');
  assert.equal(v.rounds.length, 3, 'السجلّ القديم باقٍ في مكانه');
});

test('نسختان متزامنتان: لا تمحو إحداهما عمل الأخرى', async () => {
  seedHistory();
  const A = instance();
  await A.ensureDbLoaded();
  const B = instance();
  await B.ensureDbLoaded();

  // اللاعب القديم نفسه يلعب على النسختين، ولاعب جديد على كلٍّ منهما
  A.recordMines(A.byId('OLD1'), { bet: 100, win: 0 });
  B.recordMines(B.byId('OLD1'), { bet: 200, win: 500 });
  A.recordPlinko(A.createPlayer(), { bet: 30, win: 0, multiplier: 0 });
  await Promise.all([A.flush(), B.flush()]);

  const v = storeValue();
  assert.equal(v.ledger.real.wagered, 5000 + 100 + 200 + 30);
  assert.equal(v.ledger.real.paid, 4800 + 500);
  assert.equal(v.ledger.games.mines.bets, 52);
  assert.equal(v.ledger.games.plinko.bets, 1);
  assert.equal(v.playerStats.OLD1.stats.rounds, 52);
  assert.equal(v.playerStats.OLD1.minesStats.wagered, 5300);
  assert.equal(v.playerStats.OLD1.minesStats.best, 900, 'الأعلى يبقى الأعلى، لا يُجمع');

  // والنسخة A ترى عمل B بعد المزامنة
  await A.syncWithDb({ force: true });
  assert.equal(A.ledgerSummary().real.wagered, 5330);
});

test('حفظ بلا أي تغيير لا يكتب شيئاً', async () => {
  seedHistory();
  const A = instance();
  await A.ensureDbLoaded();
  await A.flush();                      // أرشفة السجلّ القديم (مرّة واحدة)
  await A.flush();                      // وعلَم «أُرشف» (يُكتب مرّة واحدة في عمر القاعدة)
  const before = sim.patches;
  await A.flush();
  await A.flush();
  assert.equal(sim.patches, before);
});

test('صفّ تالف في القاعدة لا يُكتب فوقه', async () => {
  seedHistory();
  rows.get('store_data').value = '{"ledger": {"real": ';   // نصّ مقطوع
  const A = instance();
  await A.ensureDbLoaded();
  A.recordMines(A.createPlayer(), { bet: 100, win: 0 });
  await A.flush();
  assert.equal(rows.get('store_data').value, '{"ledger": {"real": ');
});

test('كل جولة تبقى إلى الأبد: صفحات السجلّ تصل لأوّل جولة، والقديم يُؤرشف مرّة واحدة', async () => {
  seedHistory();
  const A = instance();
  await A.ensureDbLoaded();
  const p = A.createPlayer();
  for (let i = 0; i < 250; i++) {
    if (i % 5 === 0) A.recordPlinko(p, { bet: 10, win: 0, multiplier: 0 });
    else A.recordMines(p, { bet: 10, win: 0 });
  }
  await A.flush();
  await A.flush();

  const B = instance();                 // نسخة أخرى تقرأ القديم مجدّداً
  await B.ensureDbLoaded();
  await B.flush();

  assert.equal(rlogKeys().length, 253, '250 جديدة + 3 قديمة، بلا تكرار');
  const v = storeValue();
  assert.equal(v.roundsArchived, true);
  assert.equal(v.rounds.length, 3, 'لا يُحذف شيء من الصفّ القديم');

  // تصفّح السجلّ كاملاً من نسخة ثالثة
  const C = instance();
  const seen = [];
  let before = null;
  do {
    const page = await C.roundHistory({ before, limit: 100 });
    seen.push(...page.rounds);
    before = page.next;
  } while (before);
  assert.equal(seen.length, 253);
  assert.equal(new Set(seen.map((r) => r.logKey)).size, 253);
  assert.equal(seen[seen.length - 1].roundId, 'mines-A', 'آخر صفحة تنتهي بأقدم جولة');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].logKey > seen[i].logKey, 'الأحدث أولاً');

  const plinko = await C.roundHistory({ game: 'plinko', limit: 200 });
  assert.equal(plinko.rounds.length, 51);
  assert.ok(plinko.rounds.every((r) => r.game === 'plinko'));
});

test('جولة كروت بوتات فقط لا تدخل السجلّ الدائم، وجولة فيها لاعب تدخل', async () => {
  seedHistory();
  const A = instance();
  A.recordRoundLog({ roundId: 'R-bots', endedAt: Date.now(), seats: [{ id: 'B1', isBot: true, stake: 10 }] });
  A.recordRoundLog({ roundId: 'R-real', endedAt: Date.now(), seats: [{ id: 'B1', isBot: true, stake: 10 }, { id: 'P9', isBot: false, stake: 10 }] });
  await A.flush();
  const cards = rlogKeys().filter((k) => k.includes(':cards:'));
  assert.equal(cards.length, 1);
  assert.equal(JSON.parse(rows.get(cards[0]).value).roundId, 'R-real');
});

test('قاعدة لا يطابق فيها مرشّح updated_at: الحفظ يكتشف ذلك ويستمرّ', async () => {
  seedHistory();
  const A = instance();
  await A.ensureDbLoaded();
  sim.casNeverMatches = true;
  A.recordMines(A.createPlayer(), { bet: 100, win: 0 });
  await A.flush();
  sim.casNeverMatches = false;
  assert.equal(storeValue().ledger.real.wagered, 5100);
});

test('عملة اللاعب ودولته من حسابه تصل لكل لعبة (لا «IQD» ثابتة)', () => {
  const A = instance();
  const p = A.attachAccount({ id: 'acc_sy', display_id: 'SY0001', play_token: 'tok-sy', balance: 700, currency: 'SYP', country: 'SY' });
  const prof = A.publicProfile(p);
  assert.equal(prof.currency, 'SYP');
  assert.equal(prof.country, 'SY');
  assert.equal(prof.currencySymbol, 'ل.س');
  assert.equal(require('../server/bullseyeGame').stateFor(p).currency, 'SYP');
});

test('الحفظ السريع: كتابة واحدة بلا قراءة، ونسخة أخرى كتبت في الأثناء تُدمج لا تُمحى', async () => {
  seedHistory();
  const A = instance();
  await A.ensureDbLoaded();
  await A.flush();                                 // أرشفة السجلّ القديم أولاً
  const B = instance();
  await B.ensureDbLoaded();

  // A وحدها تكتب: قراءة صفر، كتابة واحدة
  const r0 = sim.reads, p0 = sim.patches;
  A.recordMines(A.createPlayer(), { bet: 100, win: 0 });
  await A.flush();
  assert.equal(sim.reads - r0, 0, 'لا قراءة قبل الكتابة');
  assert.equal(sim.patches - p0, 1);

  // B ما زالت على الوسم القديم: الكتابة السريعة تفشل فتقرأ وتدمج
  B.recordMines(B.createPlayer(), { bet: 200, win: 0 });
  await B.flush();
  assert.equal(storeValue().ledger.real.wagered, 5000 + 100 + 200);

  // ثم A مجدّداً (وسمها قديم الآن) — لا يضيع رهان B
  A.recordMines(A.byId('OLD1'), { bet: 50, win: 0 });
  await A.flush();
  assert.equal(storeValue().ledger.real.wagered, 5350);
  assert.equal(storeValue().playerStats.OLD1.stats.rounds, 51);
});
