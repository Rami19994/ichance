'use strict';

/**
 * عائد الإدارة: ما يُعرض للاعب هو ما يُدفع، ولا ربح أقل من الرهان.
 *
 * كان ضرب الأرباح بمعامل العائد يترك اللوحات تعرض المضاعفات الأصلية
 * (بلينكو ×10، القرص ×2، الكرت ×3) والدفع أقل منها، ويجعل كرت الاسترداد
 * ×0.98. هنا نضبط عائداً غير الافتراضي ونفحص الاتساق.
 *
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// إعدادات في مجلد مؤقّت، وقاعدة مُحاكاة غير مربوطة — لا يُلمس أي ملف حقيقي
process.env.ICHANCE_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-rtp-')), 'players.json');
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
const sbPath = require.resolve('../server/supabase');
require.cache[sbPath] = {
  id: sbPath, filename: sbPath, loaded: true,
  exports: { configured: () => false, enc: encodeURIComponent, orVal: (v) => v, config: () => null }
};

const siteConfig = require('../server/siteConfig');
const plinko = require('../server/plinkoGame');
const bullseye = require('../server/bullseyeGame');
const tank = require('../server/tankGame');
const config = require('../server/config');

test('بلينكو: اللوحة تعرض المضاعفات كما تُصرف بعد العائد المضبوط', async () => {
  assert.equal((await siteConfig.setGame('plinko', { rtp: 94 })).ok, true);
  const shown = plinko.stateFor(null).multipliers;
  const scale = 94 / 96.28;
  plinko.MULTIPLIERS.forEach((m, i) => {
    assert.equal(shown[i], m > 0 ? Number((m * scale).toFixed(2)) : m);
  });
  assert.notDeepEqual(shown, plinko.MULTIPLIERS);
  await siteConfig.setGame('plinko', { rtp: 96.28 });
  assert.deepEqual(plinko.stateFor(null).multipliers, plinko.MULTIPLIERS);
});

test('بولزآي: القرص يعرض مضاعف القطاع كما يُصرف', async () => {
  await siteConfig.setGame('bullseye', { rtp: 90 });
  const wheels = bullseye.stateFor(null).wheels;
  const scale = 90 / 96;
  for (const [k, wheel] of Object.entries(bullseye.WHEELS)) {
    wheel.forEach((s, i) => assert.equal(wheels[k][i].m, s.m > 0 ? Number((s.m * scale).toFixed(2)) : 0));
  }
  await siteConfig.setGame('bullseye', { rtp: 96 });
});

test('الدبابات: مضاعف الفوز المعروض = المصروف، ولا نسبة فوز ولا عائد للاعب', async () => {
  await siteConfig.setGame('tank', { rtp: 70 });
  const pub = tank.publicConfig().difficulties;
  for (const d of pub) {
    assert.equal('measuredWinRate' in d, false);
    assert.equal('rtp' in d, false);
  }
  const admin = tank.difficultyReport({});
  assert.ok(admin.every((d) => 'measuredWinRate' in d && 'rtp' in d), 'الإدارة ترى الأرقام');
  assert.ok(pub.every((d, i) => d.payout === admin[i].payout));
  await siteConfig.setGame('tank', { rtp: 80 });
});

test('كروت الحظ: العائد الموزون للأنماط = المضبوط، والاسترداد يبقى ×1، ولا رابح أقل من ×1', async () => {
  await siteConfig.setGame('cards', { rtp: 90 });
  const cards = require('../server/luckyCards');
  const total = config.TEMPLATES.reduce((a, t) => a + t.weight, 0);
  let rtp = 0;
  for (const t of config.TEMPLATES) {
    const scaled = cards.scaleBoard({ cards: t.cards.slice() }).cards;
    rtp += (t.weight / total) * scaled.reduce((a, c) => a + c, 0) / scaled.length;
    assert.ok(scaled.every((c) => c === 0 || c >= 1), `${t.name}: ${scaled}`);
    assert.equal(scaled.filter((c) => c === 1).length, t.cards.filter((c) => c === 1).length, 'الاسترداد كما هو');
    // الترتيب النسبي باقٍ: الأكبر يبقى الأكبر
    assert.equal(scaled.indexOf(Math.max(...scaled)), t.cards.indexOf(Math.max(...t.cards)));
  }
  assert.ok(rtp <= 0.90 + 1e-9 && rtp > 0.897, `العائد الموزون ${rtp}`);
  await siteConfig.setGame('cards', { rtp: 96 });
  const same = cards.scaleBoard({ cards: config.TEMPLATES[0].cards.slice() }).cards;
  assert.deepEqual(same, config.TEMPLATES[0].cards, 'عند 96% اللوحة كما هي');
});
