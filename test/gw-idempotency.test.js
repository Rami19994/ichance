'use strict';

/**
 * المحفظة المتصلة لا تصرف الحركة نفسها مرّتين — فحص الخادم قبل القاعدة.
 *
 * دوال القاعدة لا ترفض رقم حركة مكرّراً (قبل ملف التحصين)، وgw_rollback كان
 * يعيد الرهان نفسه في كل نداء برقم تراجع جديد. game_rounds هنا مُحاكاة
 * تطبّق المرشّحات كما يقرؤها PostgREST (بما فيها القيم بين علامتي تنصيص).
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rounds = [];
const unquote = (v) => (/^".*"$/.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);

function matches(row, query) {
  const params = new URLSearchParams(query);
  for (const [k, raw] of params) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    if (k === 'or') {
      const inner = raw.replace(/^\(|\)$/g, '');
      // تقسيم على الفواصل خارج علامات التنصيص — كما يفعل PostgREST
      const parts = inner.match(/[a-z_]+\.eq\.(?:"(?:[^"\\]|\\.)*"|[^,]*)/g) || [];
      const ok = parts.some((p) => {
        const [, col, val] = p.match(/^([a-z_]+)\.eq\.(.*)$/);
        return String(row[col]) === unquote(val);
      });
      if (!ok) return false;
      continue;
    }
    if (raw === 'is.null') { if (row[k] != null) return false; continue; }
    const v = raw.replace(/^eq\./, '');
    if (String(row[k]) !== v) return false;
  }
  return true;
}

const fake = {
  configured: () => true,
  enc: encodeURIComponent,
  orVal: (v) => encodeURIComponent(`"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`),
  async select(table, query) {
    assert.equal(table, 'game_rounds');
    let list = rounds.filter((r) => matches(r, query));
    if (/order=created_at\.desc/.test(query)) list = list.slice().sort((a, b) => b.created_at - a.created_at);
    const lim = new URLSearchParams(query).get('limit');
    return lim ? list.slice(0, Number(lim)) : list;
  },
  async request() { return null; }
};
const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: fake };

const G = require('../server/gameRegistry');

let t = 1;
const add = (r) => rounds.push({ game_id: 'g1', player_id: 'p1', round_ref: 'R1', created_at: t++, ...r });

test('رقم حركة مسجّل يُعرف قبل أن يُصرف ثانيةً', async () => {
  add({ id: 'rnd_a', tx_ref: 'bet-1', action: 'debit', amount: 100, balance_after: 900 });
  const prior = await G.findTx('g1', 'bet-1');
  assert.equal(prior.action, 'debit');
  assert.equal(await G.findTx('g1', 'bet-2'), null);
  assert.equal(await G.findTx('other-game', 'bet-1'), null, 'رقم الحركة لكل لعبة على حدة');
});

test('التراجع عن رهان: مرّة واحدة فقط مهما تغيّر رقم التراجع', async () => {
  assert.equal((await G.rollbackAllowed('g1', 'bet-1')).ok, true);
  add({ id: 'rnd_b', tx_ref: 'rb-1', action: 'rollback', amount: 100, balance_after: 1000 });
  const again = await G.rollbackAllowed('g1', 'bet-1');
  assert.equal(again.ok, false, 'تراجع ثانٍ برقم جديد مرفوض');
});

test('رهانان بالمبلغ نفسه في الجولة نفسها: لكلٍّ تراجعه', async () => {
  add({ id: 'rnd_c', tx_ref: 'bet-3', action: 'debit', amount: 100, balance_after: 900 });
  assert.equal((await G.rollbackAllowed('g1', 'bet-3')).ok, true, 'الرهان الثاني لم يُتراجع عنه بعد');
  add({ id: 'rnd_d', tx_ref: 'rb-3', action: 'rollback', amount: 100, balance_after: 1000 });
  assert.equal((await G.rollbackAllowed('g1', 'bet-3')).ok, false);
});

test('هدف غير موجود، أو هدف هو نفسه تراجع: مرفوض', async () => {
  assert.equal((await G.rollbackAllowed('g1', 'nope')).ok, false);
  assert.equal((await G.rollbackAllowed('g1', '')).ok, false);
  assert.equal((await G.rollbackAllowed('g1', 'rb-1')).ok, false);
});

test('رقم هدف فيه فواصل وأقواس لا يضيف شروطاً إلى الاستعلام', async () => {
  const out = await G.rollbackAllowed('g1', 'x,id.eq.rnd_c');
  assert.equal(out.ok, false, 'لا يطابق rnd_c عبر شرط مُدسوس');
});
