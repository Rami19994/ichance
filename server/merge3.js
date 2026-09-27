'use strict';

/**
 * دمج ثلاثي لإحصاءات تراكمية بين نسخ الخادم.
 *
 * على Vercel عدّة نسخ تعمل في آن، ولكلّ واحدة ذاكرتها. كانت كل نسخة تكتب
 * ما في ذاكرتها فوق ما في القاعدة كلّه، فتمحو نسخةٌ فتيّة (ذاكرتها أصفار)
 * كلَّ التاريخ، وتمحو نسختان متزامنتان إحداهما عمل الأخرى.
 *
 * الصحيح: ما تكتبه النسخة هو ما «أضافته» هي فقط منذ آخر ما رأته من القاعدة:
 *
 *     النتيجة = القاعدة الآن + (ذاكرتي − ما رأيته آخر مرّة)
 *
 *   db     القيمة في القاعدة الآن
 *   local  القيمة في ذاكرة هذه النسخة
 *   base   ما كانت عليه القاعدة حين تزامنت هذه النسخة آخر مرّة
 *
 * العدّادات لا تنقص أبداً (رهانات، مدفوع، جولات…)، فالفرق السالب يُهمل: لو
 * ضاع كائن لاعب من الذاكرة لا يجوز أن يُطرح تاريخه من القاعدة.
 */

/** «الأعلى» لا «المجموع»: أكبر ربح، أعلى مضاعف، آخر ظهور. */
const MAX_KEYS = new Set(['best', 'bestMultiplier', 'bestStreak', 'maxMultiplier', 'lastSeen']);
/** «الأقدم»: بداية الدفتر وتاريخ الإنشاء. */
const MIN_KEYS = new Set(['since', 'createdAt']);
/** قيمة لحظية لا تراكمية: من غيّرها آخراً هو الصحيح. */
const LAST_KEYS = new Set(['balance', 'streak']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function merge3(db, local, base, key) {
  if (isObj(db) || isObj(local)) {
    const d = isObj(db) ? db : {};
    const l = isObj(local) ? local : {};
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(d), ...Object.keys(l)])) {
      const v = merge3(d[k], l[k], b[k], k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // مفتاح لا تعرفه هذه النسخة: يبقى كما في القاعدة
  if (local === undefined) return db;

  if (isNum(local) && (db === undefined || isNum(db))) {
    if (db === undefined) return local;
    if (MAX_KEYS.has(key)) return Math.max(db, local);
    if (MIN_KEYS.has(key)) return Math.min(db, local);
    if (LAST_KEYS.has(key)) return isNum(base) && local === base ? db : local;
    const added = local - (isNum(base) ? base : 0);
    return db + Math.max(0, added);
  }

  // نص، منطقي، مصفوفة، null: قيمة هذه النسخة إن غيّرتها، وإلّا ما في القاعدة
  if (db === undefined) return local;
  return same(local, base) ? db : local;
}

/** نسخة عميقة لقيم JSON. */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

module.exports = { merge3, clone };
