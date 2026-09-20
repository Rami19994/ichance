'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER } = require('./config');
const sb = require('./supabase');

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

// مجلد data الحقيقي (موجود في حزمة النشر على Vercel)
const REAL_DATA_DIR = path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
// مجلد الكتابة: على Vercel نكتب إلى /tmp (لنفس الـ invocation فقط)
const WRITE_DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ichance_data')
  : REAL_DATA_DIR;
const AUTH_FILE = path.join(REAL_DATA_DIR, 'admin.json');
const PLAIN_FILE = path.join(WRITE_DATA_DIR, 'admin-key.txt');

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

const DB_SECRET_KEY = 'admin_auth';

async function readDbAuth() {
  if (!sb.configured()) return null;
  try {
    const row = await sb.selectOne('site_secrets', `select=value&key=eq.${sb.enc(DB_SECRET_KEY)}`);
    if (row && row.value) {
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (parsed && parsed.salt && parsed.hash) return parsed;
    }
  } catch (err) {
    console.warn('[admin] تعذّرت قراءة المصادقة من قاعدة البيانات:', err.message);
  }
  return null;
}

async function writeDbAuth(val, { force = false } = {}) {
  if (!sb.configured()) return false;
  try {
    // حماية المفتاح المعتمد من الكتابة فوقه بمفتاح غير معتمد (claimed: false)
    if (!force && val && !val.claimed) {
      const existing = await readDbAuth();
      if (existing && existing.claimed && existing.hash) {
        state = existing;
        return true;
      }
    }

    await sb.request('/rest/v1/site_secrets?on_conflict=key', {
      method: 'POST',
      body: [{
        key: DB_SECRET_KEY,
        value: JSON.stringify(val),
        updated_at: new Date().toISOString()
      }],
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
    return true;
  } catch (err) {
    console.error('[admin] تعذّر حفظ المصادقة في قاعدة البيانات:', err.message);
    return false;
  }
}

async function save(stateToSave = state, options = {}) {
  let ok = false;
  if (sb.configured() && stateToSave) {
    const dbOk = await writeDbAuth(stateToSave, options);
    if (dbOk) ok = true;
  }
  try {
    fs.mkdirSync(WRITE_DATA_DIR, { recursive: true });
    // على Vercel نكتب في /tmp فقط (للـ invocation الحالي)
    // القراءة ستأتي من REAL_DATA_DIR أو قاعدة البيانات Supabase
    fs.writeFileSync(AUTH_FILE, JSON.stringify(stateToSave, null, 2), 'utf8');
    saveError = null;
    ok = true;
  } catch (err) {
    if (process.env.VERCEL) {
      saveError = null;
    } else if (!ok) {
      saveError = err.message;
      console.error('[admin] تعذّر حفظ ملف المصادقة:', err.message);
    }
  }
  return ok || !!process.env.VERCEL;
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
    console.error('[admin] ملف المصادقة تالف:', err.message);
  }

  // على Serverless (Vercel) أو مع اتصال قاعدة البيانات:
  // لا نولّد مفتاحاً عشوائياً عند الإقلاع ولا نكتب في قاعدة البيانات كي لا نطمس مفتاح المالك.
  if (process.env.VERCEL || sb.configured()) {
    return;
  }

  if (ENV_KEY) return;

  // أول إقلاع محلي بلا قاعدة بيانات: نولّد مفتاحاً ونكتبه نصاً
  const key = generateKey();
  const salt = crypto.randomBytes(16).toString('hex');
  state = {
    salt,
    hash: hashKey(key, salt),
    claimed: false,
    createdAt: Date.now(),
    rotatedAt: null
  };
  save(state);
  writePlainKey(key);
  state.firstRunKey = key;
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

async function publicStatus() {
  if ((!state || !state.claimed) && sb.configured()) {
    const dbState = await readDbAuth();
    if (dbState && dbState.salt && dbState.hash) {
      state = {
        salt: String(dbState.salt),
        hash: String(dbState.hash),
        claimed: true,
        createdAt: dbState.createdAt || Date.now(),
        rotatedAt: dbState.rotatedAt || null
      };
    }
  }
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

async function verify(key) {
  const clean = String(key || '').trim();
  if (!clean) return false;

  // 1. تحقق من الحالة الحالية في الذاكرة أولاً (سريع جداً)
  if (state && state.claimed && safeEqual(hashKey(clean, state.salt), state.hash)) {
    return true;
  }

  // 2. تحديث الكاش من Supabase (ضروري بين دوال Serverless على Vercel)
  if (sb.configured()) {
    const dbState = await readDbAuth();
    if (dbState && dbState.salt && dbState.hash) {
      state = {
        salt: String(dbState.salt),
        hash: String(dbState.hash),
        claimed: true,
        createdAt: dbState.createdAt || Date.now(),
        rotatedAt: dbState.rotatedAt || null
      };
      if (safeEqual(hashKey(clean, state.salt), state.hash)) {
        return true;
      }
    }
  }

  // 3. متغيّر البيئة (اختياري للطوارئ)
  if (ENV_KEY && safeEqual(clean, ENV_KEY)) return true;

  // 4. فحص الملف المحلي
  if (state && safeEqual(hashKey(clean, state.salt), state.hash)) return true;

  return false;
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

async function setKey(key, { claimed, force = true }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const previous = state;
  const nextState = {
    salt,
    hash: hashKey(key, salt),
    claimed,
    createdAt: state ? state.createdAt : Date.now(),
    rotatedAt: Date.now()
  };
  state = nextState;
  const saved = await save(nextState, { force });
  if (!saved && !sb.configured() && !process.env.VERCEL) {
    // لم يُكتب على القرص ولا في قاعدة البيانات: نتراجع كي لا يظنّ المالك أن مفتاحه محفوظ
    state = previous;
    return false;
  }
  // المفتاح صار من اختيار المالك، فلا داعي لبقاء النسخة النصية
  try { if (fs.existsSync(PLAIN_FILE)) fs.unlinkSync(PLAIN_FILE); } catch { /* تجاهل */ }
  return true;
}

const SAVE_FAILED = 'تعذّر حفظ المفتاح — تأكّد من اتصال قاعدة البيانات أو صلاحيات المجلد';

/** إنشاء المفتاح أول مرة من المتصفح. */
async function claim(key) {
  if (ENV_KEY) return { ok: false, error: 'المفتاح مضبوط من متغيّر البيئة ولا يُغيَّر من اللوحة' };
  if (!claimOpen()) {
    return {
      ok: false,
      error: 'انتهت نافذة الإنشاء. أعد تشغيل الخادم لفتحها من جديد، أو اقرأ المفتاح من data/admin-key.txt'
    };
  }
  const v = validateNewKey(key);
  if (!v.ok) return v;
  if (!(await setKey(v.clean, { claimed: true }))) return { ok: false, error: SAVE_FAILED };
  console.log('[admin] أنشأ المالك مفتاحاً جديداً من المتصفح');
  return { ok: true };
}

/** تغيير المفتاح من داخل اللوحة — يتطلب مفتاحاً صالحاً (يتحقق منه المسار). */
async function rotate(newKey) {
  // يعمل دائماً وبلا حاجة لمتغيّر بيئة: المفتاح الجديد يُحفظ في قاعدة البيانات ويصير هو المرجع.
  const key = newKey ? String(newKey).trim() : generateKey();
  const v = validateNewKey(key);
  if (!v.ok) return v;
  if (!(await setKey(v.clean, { claimed: true }))) return { ok: false, error: SAVE_FAILED };
  console.log('[admin] غُيِّر مفتاح الإدارة وحُفظ في قاعدة البيانات');
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
