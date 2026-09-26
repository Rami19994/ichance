'use strict';

const sb = require('./supabase');

/**
 * مخزن الجولات متعددة الخطوات (طريق الدجاجة).
 *
 * الجولة في ذاكرة نسخة خادم واحدة تضيع على Vercel إن وصل الطلب التالي إلى
 * نسخة أخرى أو أُعيد تشغيل النسخة — فيخسر اللاعب رهانه دون ذنب. هنا الجولة
 * في site_secrets (مفتاح لكل لاعب) حين تكون القاعدة مربوطة.
 *
 * كل تعديل «قارن ثم بدّل» على وسم الحالة (tag): في القاعدة هو updated_at،
 * والتحديث يشترط updated_at=eq.<الوسم الذي قرأناه> ويضع وسماً أحدث. فطلبان
 * متزامنان على الجولة نفسها — من نسختين أو من ضغطتين — ينجح أحدهما فقط،
 * ولا تُدفع جائزة مرّتين ولا تُعبر خطوة بعد اصطدام. (مرشّح الوقت بسيط في
 * الرابط — كما في تنظيف game_sessions — بخلاف مقارنة نصّ JSON كامل.)
 *
 * بلا قاعدة (التطوير المحلّي) الدلالة نفسها في الذاكرة بعدّاد.
 */

const memory = new Map();   // key -> { raw, tag }
let memoryTag = 0;

const useDb = () => sb.configured();
const table = '/rest/v1/site_secrets';

/** وسم أحدث من السابق دائماً (نفس الملّي ثانية لا يكرّر وسماً). */
function nextStamp(prevTag) {
  const prev = prevTag ? Date.parse(prevTag) : 0;
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString();
}

/** الجولة المخزّنة: { value, tag } أو null. */
async function get(key) {
  if (!useDb()) {
    const e = memory.get(key);
    return e ? { value: JSON.parse(e.raw), tag: e.tag } : null;
  }
  const row = await sb.selectOne('site_secrets', `select=value,updated_at&key=eq.${sb.enc(key)}`);
  return row && row.value ? { value: JSON.parse(row.value), tag: row.updated_at } : null;
}

/** ينشئ جولة إن لم توجد: يرجّع وسمها، أو null إن كانت موجودة (جولة جارية أو سباق). */
async function create(key, value) {
  const raw = JSON.stringify(value);
  if (!useDb()) {
    if (memory.has(key)) return null;
    const tag = ++memoryTag;
    memory.set(key, { raw, tag });
    return tag;
  }
  const stamp = nextStamp(null);
  try {
    await sb.request(table, {
      method: 'POST',
      body: [{ key, value: raw, updated_at: stamp }],
      prefer: 'return=minimal'
    });
  } catch (err) {
    if (err && (err.code === '23505' || err.status === 409)) return null;
    throw err;
  }
  const back = await get(key);   // الوسم كما خزّنته القاعدة بالضبط
  return back ? back.tag : null;
}

/** يبدّل القيمة فقط إن كان الوسم ما يزال prevTag: يرجّع الوسم الجديد أو null. */
async function swap(key, prevTag, next) {
  const raw = JSON.stringify(next);
  if (!useDb()) {
    const e = memory.get(key);
    if (!e || e.tag !== prevTag) return null;
    const tag = ++memoryTag;
    memory.set(key, { raw, tag });
    return tag;
  }
  const rows = await sb.request(`${table}?key=eq.${sb.enc(key)}&updated_at=eq.${sb.enc(prevTag)}`, {
    method: 'PATCH',
    body: { value: raw, updated_at: nextStamp(prevTag) },
    prefer: 'return=representation'
  });
  return Array.isArray(rows) && rows.length === 1 ? rows[0].updated_at : null;
}

/** يحذف الجولة (إن كان وسمها ما يزال tag حين يُعطى). */
async function remove(key, tag) {
  if (!useDb()) {
    const e = memory.get(key);
    if (!e || (tag !== undefined && e.tag !== tag)) return false;
    return memory.delete(key);
  }
  const cond = tag !== undefined ? `&updated_at=eq.${sb.enc(tag)}` : '';
  const rows = await sb.request(`${table}?key=eq.${sb.enc(key)}${cond}`, {
    method: 'DELETE',
    prefer: 'return=representation'
  });
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = { get, create, swap, remove, _memory: memory };
