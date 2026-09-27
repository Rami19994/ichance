'use strict';

/**
 * صيّاد الجوائز: لا ربح أقل من الرهان (طلب المالك) — عبر مسار الدورة
 * الحقيقي (slotSession.spin) بمحفظة مُحاكاة.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const credits = [];
const fakeStore = {
  async gameDebit(game, player, amount) { if (player.balance < amount) return false; player.balance -= amount; return true; },
  async gameCredit(game, player, amount) { credits.push(amount); player.balance += amount; return true; },
  recordSlot() {}
};
const storePath = require.resolve('../server/store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

const slotSession = require('../server/slotSession');
const slots = require('../server/slots');

test('كل دورة أساسية رابحة تدفع الرهان كاملاً على الأقل', async () => {
  const bet = slotSession.SLOT_STAKES[Math.min(3, slotSession.SLOT_STAKES.length - 1)];
  const player = { id: 'SLOTFLOOR', balance: bet * 5000, stats: { rounds: 0, wagered: 0, won: 0, best: 0, bestMultiplier: 0 } };
  let wins = 0;
  for (let i = 0; i < 1500; i++) {
    if (slotSession.activeFeatures.has(player.id)) slotSession.activeFeatures.delete(player.id);
    const r = await slotSession.spin(player, bet);
    assert.equal(r.ok, true, r.error);
    if (r.win > 0 && r.multiplier === 1) {
      wins++;
      assert.ok(r.win >= bet, `دورة رابحة بـ ${r.win} على رهان ${bet}`);
    }
  }
  assert.ok(wins > 300, `دورات رابحة كافية للفحص (${wins})`);
});

test('اللاعب لا يستلم أرقام العائد ولا نسب الفوز', () => {
  assert.equal(slots.MIN_BASE_WIN_X, 1);
  const cfg = JSON.stringify(slotSession.stateFor({ id: 'X', balance: 0 }) || {});
  for (const k of ['hitRate', 'featureOdds', '"rtp"']) assert.equal(cfg.includes(k), false, k);
});
