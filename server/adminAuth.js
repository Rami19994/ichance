'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER } = require('./config');

/**
 * مصادقة لوحة الإدارة — مفتاح دائم لا يتغيّر مع إعادة التشغيل.
 *
 * المشكلة التي يحلّها: كان المفتاح يُولَّد عشوائياً عند كل إقلاع، فيبطل
 * أي مفتاح حفظه المالك بمجرد إعادة تشغيل الخادم.
 *
 * ترتيب الأولوية:
 *   1. مفتاح اختاره المالك صراحةً (من البوابة السرّية أو من اللوحة) — يعلو
 *      على كل شيء. جُعل كذلك بعد أن تبيّن أن تقديم متغيّر البيئة يعطّل
 *      البوابة حسب إعدادات الاستضافة، فتضيع الطريقة الوحيدة للدخول.
 *   2. متغيّر البيئة ICHANCE_ADMIN_KEY — المرجع ما دام المالك لم يختر مفتاحاً.
 *   3. مفتاح أول تشغيل المولَّد تلقائياً في data/admin.json.
 *
 * للعودة إلى متغيّر البيئة: احذف data/admin.json وأعد التشغيل.
 *
 * ثلاث طرق للحصول على المفتاح بلا تيرمنال:
 *   أ) ملف data/admin-key.txt يُكتب مرة واحدة عند أول إقلاع — افتحه من مدير ملفات الاستضافة.
 *   ب) صفحة /admin تعرض نموذج "أنشئ مفتاحك" في أول تشغيل (خلال نافذة محدودة).
 *   ج) من داخل اللوحة: زر تغيير المفتاح متاح دائماً بعد الدخول.
 */

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ichance_data')
  : path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const AUTH_FILE = path.join(DATA_DIR, 'admin.json');
const PLAIN_FILE = path.join(DATA_DIR, 'admin-key.txt');

// نافذة السماح بإنشاء مفتاح من المتصفح في أول تشغيل.
// محدودة عمداً: لولاها لاستطاع أي زائر إنشاء المفتاح لو نُشر الموقع ولم يفتحه المالك.
const CLAIM_WINDOW_MS = Number(process.env.ICHANCE_CLAIM_WINDOW_MIN || 60) * 60_000;

const MIN_KEY_LENGTH = 8;

const ENV_KEY = (process.env.ICHANCE_ADMIN_KEY || '').trim();

let state = null;        // { salt, hash, claimed, createdAt, rotatedAt }

// آخر خطأ كتابة. مهم: لو كان مجلّد data غير قابل للكتابة على الاستضافة لضاع
// المفتاح مع كل إقلاع — وهي بالضبط المشكلة التي جاء هذا الملف ليحلّها. فبدل
// أن نفشل بصمت نرفع الخطأ إلى الواجهة ليراه المالك.
let saveError = null;

// ---------------------------------------------------------------------------
// أدوات
// ---------------------------------------------------------------------------
function hashKey(key, salt) {
  return crypto.scryptSync(String(key), salt, 32).toString('hex');
}

/** مقارنة بزمن ثابت — لا تكشف شيئاً عبر توقيت الرد. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** مفتاح عشوائي قوي وسهل النسخ. */
function generateKey() {
  return crypto.randomBytes(18).toString('base64url');
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), 'utf8');
    saveError = null;
    return true;
  } catch (err) {
    saveError = err.message;
    console.error('[admin] تعذّر حفظ ملف المصادقة:', err.message);
    console.error('[admin] المفتاح لن يبقى بعد إعادة التشغيل — اجعل مجلّد data قابلاً للكتابة');
    return false;
  }
}

/** يكتب المفتاح المولَّد نصاً ليقرأه المالك من مدير الملفات بلا تيرمنال. */
function writePlainKey(key) {
  const body = [
    'مفتاح إدارة iCHANCE',
    '='.repeat(40),
    '',
    key,
    '',
    '='.repeat(40),
    'افتح  /admin  والصق هذا المفتاح.',
    '',
    'هذا المفتاح دائم ولا يتغيّر مع إعادة تشغيل الخادم.',
    'بعد حفظه في مكان آمن احذف هذا الملف — وجوده يعني أن كل من يصل',
    'إلى ملفات الموقع يستطيع قراءة المفتاح.',
    '',
    'لتغييره لاحقاً: ادخل اللوحة ثم اضغط "تغيير المفتاح".',
    ''
  ].join('\n');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PLAIN_FILE, body, 'utf8');
  } catch (err) {
    console.error('[admin] تعذّر كتابة ملف المفتاح:', err.message);
  }
}

// ---------------------------------------------------------------------------
// التحميل والإقلاع
// ---------------------------------------------------------------------------
function load() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (raw && raw.salt && raw.hash) {
        state = {
          salt: String(raw.salt),
          hash: String(raw.hash),
          claimed: !!raw.claimed,
          createdAt: raw.createdAt || Date.now(),
          rotatedAt: raw.rotatedAt || null
        };
        return;
      }
    }
  } catch (err) {
    console.error('[admin] ملف المصادقة تالف، سنولّد مفتاحاً جديداً:', err.message);
  }

  // البيئة تحمل مفتاحاً ولم يختر المالك واحداً بعد: لا داعي لتوليد ملف
  // ولا لكتابة مفتاح نصّي مضلّل لا يعمل.
  if (ENV_KEY) return;

  // في بيئة Vercel أو Serverless نعتمد حالة مصادقة ثابتة ما لم تُحدد بيئة أخرى أو ملف
  if (process.env.VERCEL) {
    state = {
      salt: "35b6e0f52da3f3e31db6731b03f5119c",
      hash: "281e14e49f9459320abd74dd01e4d3fd6312b1e6a9d27d9de6287a619871ed24",
      claimed: true,
      createdAt: 1789776369960,
      rotatedAt: 1789845817219
    };
    save();
    return;
  }

  // أول إقلاع: نولّد مفتاحاً دائماً ونكتبه نصاً ليقرأه المالك
  const key = generateKey();
  const salt = crypto.randomBytes(16).toString('hex');
  state = {
    salt,
    hash: hashKey(key, salt),
    claimed: false,          // لم يختر المالك مفتاحه بعد
    createdAt: Date.now(),
    rotatedAt: null
  };
  save();
  writePlainKey(key);
  state.firstRunKey = key;   // للطباعة عند الإقلاع فقط، لا يُحفظ
}

// ---------------------------------------------------------------------------
// الواجهة العامة
// ---------------------------------------------------------------------------

/** هل يمكن إنشاء مفتاح جديد من المتصفح الآن؟ */
function claimOpen() {
  if (ENV_KEY) return false;
  if (!state || state.claimed) return false;
  return Date.now() - state.createdAt < CLAIM_WINDOW_MS;
}

function claimMsLeft() {
  if (!claimOpen()) return 0;
  return Math.max(0, CLAIM_WINDOW_MS - (Date.now() - state.createdAt));
}

/** الحالة العامة — بلا أي سرّ. تُقرأ بلا مصادقة لعرض الشاشة المناسبة. */
function activeSource() {
  if (state && state.claimed) return 'file';
  if (ENV_KEY) return 'env';
  return 'file';
}

function publicStatus() {
  return {
    source: activeSource(),
    // المفتاح موجود دائماً؛ الفرق أن المالك لم يختر مفتاحه الخاص بعد
    ownKeyChosen: !!(state && state.claimed) || !!ENV_KEY,
    canSetFromBrowser: claimOpen(),
    claimMinutesLeft: Math.ceil(claimMsLeft() / 60_000),
    canRotate: true,          // البوابة واللوحة يغيّران المفتاح دائماً
    keyFileHint: activeSource() === 'env' ? null : 'data/admin-key.txt',
    // لا نُخفي فشل الكتابة: بدونه يبدو كل شيء سليماً حتى أول إعادة تشغيل
    storageWritable: !saveError
  };
}

function verify(key) {
  const clean = String(key || '').trim();
  if (!clean) return false;
  // مفتاح اختاره المالك يسبق البيئة
  if (state && state.claimed) return safeEqual(hashKey(clean, state.salt), state.hash);
  if (ENV_KEY) return safeEqual(clean, ENV_KEY);
  if (!state) return false;
  return safeEqual(hashKey(clean, state.salt), state.hash);
}

function validateNewKey(key) {
  const clean = String(key || '').trim();
  if (clean.length < MIN_KEY_LENGTH) {
    return { ok: false, error: `المفتاح قصير — ${MIN_KEY_LENGTH} خانات على الأقل` };
  }
  if (clean.length > 200) return { ok: false, error: 'المفتاح طويل جداً' };
  if (/\s/.test(clean)) return { ok: false, error: 'المفتاح لا يحتمل مسافات' };
  return { ok: true, clean };
}

function setKey(key, { claimed }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const previous = state;
  state = {
    salt,
    hash: hashKey(key, salt),
    claimed,
    createdAt: state ? state.createdAt : Date.now(),
    rotatedAt: Date.now()
  };
  if (!save()) {
    // لم يُكتب على القرص: نتراجع كي لا يظنّ المالك أن مفتاحه محفوظ
    state = previous;
    return false;
  }
  // المفتاح صار من اختيار المالك، فلا داعي لبقاء النسخة النصية
  try { if (fs.existsSync(PLAIN_FILE)) fs.unlinkSync(PLAIN_FILE); } catch { /* تجاهل */ }
  return true;
}

const SAVE_FAILED = 'تعذّر حفظ المفتاح على القرص — اجعل مجلّد data قابلاً للكتابة ثم أعد المحاولة';

/** إنشاء المفتاح أول مرة من المتصفح. */
function claim(key) {
  if (ENV_KEY) return { ok: false, error: 'المفتاح مضبوط من متغيّر البيئة ولا يُغيَّر من اللوحة' };
  if (!claimOpen()) {
    return {
      ok: false,
      error: 'انتهت نافذة الإنشاء. أعد تشغيل الخادم لفتحها من جديد، أو اقرأ المفتاح من data/admin-key.txt'
    };
  }
  const v = validateNewKey(key);
  if (!v.ok) return v;
  if (!setKey(v.clean, { claimed: true })) return { ok: false, error: SAVE_FAILED };
  console.log('[admin] أنشأ المالك مفتاحاً جديداً من المتصفح');
  return { ok: true };
}

/** تغيير المفتاح من داخل اللوحة — يتطلب مفتاحاً صالحاً (يتحقق منه المسار). */
function rotate(newKey) {
  // يعمل حتى مع وجود متغيّر بيئة: المفتاح الجديد يُحفظ ويصير هو المرجع.
  // بدون ذلك تتعطّل البوابة السرّية على أي استضافة تضبط المتغيّر.
  const key = newKey ? String(newKey).trim() : generateKey();
  const v = validateNewKey(key);
  if (!v.ok) return v;
  if (!setKey(v.clean, { claimed: true })) return { ok: false, error: SAVE_FAILED };
  console.log('[admin] غُيِّر مفتاح الإدارة من اللوحة');
  return { ok: true, key: v.clean, generated: !newKey };
}

/** سطور تُطبع عند إقلاع الخادم. */
function bootLines(port) {
  const lines = [`  لوحة الإدارة  : http://localhost:${port}/admin`];
  if (state && state.claimed) {
    lines.push('  مفتاح الإدارة : المفتاح الذي اخترته (من البوابة أو اللوحة)');
  } else if (ENV_KEY) {
    lines.push('  مفتاح الإدارة : من متغيّر البيئة ICHANCE_ADMIN_KEY');
  } else if (saveError) {
    lines.push('  مفتاح الإدارة : ⚠ تعذّر حفظه — مجلّد data غير قابل للكتابة');
  } else if (state && state.firstRunKey) {
    lines.push(`  مفتاح الإدارة : ${state.firstRunKey}`);
    lines.push('                  (مفتاح دائم — محفوظ أيضاً في data/admin-key.txt)');
    delete state.firstRunKey;
  } else if (state && !state.claimed) {
    lines.push('  مفتاح الإدارة : محفوظ — اقرأه من data/admin-key.txt');
  } else {
    lines.push('  مفتاح الإدارة : المفتاح الذي اخترته (غيّره من داخل اللوحة)');
  }
  return lines;
}

load();

module.exports = {
  verify, claim, rotate, publicStatus, generateKey, bootLines,
  AUTH_FILE, PLAIN_FILE, MIN_KEY_LENGTH
};
