'use strict';

/**
 * يسمح لأدوات القياس باستيراد محرّكات اللعب بلا لمس قاعدة البيانات.
 *
 * معظم المحرّكات تستدعي server/store، وهو يتّصل بـSupabase عند التحميل
 * ويشغّل مؤقّت حفظ. أداة حساب لا تحتاج شيئاً من ذلك، ووصلها بقاعدة
 * الإنتاج أثناء التجريب خطر بلا مقابل. نزرع هنا بديلاً في ذاكرة الوحدات
 * **قبل** استيراد أي محرّك، فيأخذه المحرّك بدل الأصل.
 */

const path = require('path');

const storePath = require.resolve('../server/store');
if (!require.cache[storePath]) {
  const noop = () => {};
  const stub = {
    gameDebit: async () => true,
    gameCredit: async () => true,
    adjustBalance: async () => true,
    recordNeonSlots: noop,
    recordPlinko: noop,
    recordMines: noop,
    recordSlots: noop,
    recordRound: noop,
    publicProfile: (p) => p,
    flush: async () => {},
    all: () => [],
    __stub: true
  };
  require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: new Proxy(stub, {
      get(t, k) { return k in t ? t[k] : noop; }
    })
  };
}

module.exports = { stubbed: true };
