'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER } = require('./config');
const sb = require('./supabase');

/**
 * مصادقة لوحة الإدارة — دعم تعدد الأدمن (Multi-Admin Keys)
 *
 * كل جهاز أو أدمن يمكن أن يمتلك مفتاحه المستقل، وتظل جميع المفاتيح
 * صالحة وتعمل في آنٍ واحد دون أن يلغي أحدهما الآخر.
 *
 * التخزين:
 *   في قاعدة البيانات Supabase (site_secrets -> admin_auth)
 *   ومحلياً في data/admin.json كنسخة احتياطية.
 */

// مجلد data الحقيقي
const REAL_DATA_DIR = path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const WRITE_DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ichance_data')
  : REAL_DATA_DIR;
const AUTH_FILE = path.join(REAL_DATA_DIR, 'admin.json');
const PLAIN_FILE = path.join(WRITE_DATA_DIR, 'admin-key.txt');

const CLAIM_WINDOW_MS = Number(process.env.ICHANCE_CLAIM_WINDOW_MIN || 120) * 60_000;
const MIN_KEY_LENGTH = 8;
const ENV_KEY = (process.env.ICHANCE_ADMIN_KEY || '').trim();

let state = null; // { claimed: boolean, createdAt: number, keys: Array<{id, name, salt, hash, createdAt, lastUsedAt}> }
let saveError = null;

// ---------------------------------------------------------------------------
// أدوات التشفير والتطبيع
// ---------------------------------------------------------------------------
function hashKey(key, salt) {
  return crypto.scryptSync(String(key), salt, 32).toString('hex');
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function generateKey() {
  return crypto.randomBytes(18).toString('base64url');
}

const DB_SECRET_KEY = 'admin_auth';

function normalizeState(raw) {
  if (!raw) return null;
  const createdAt = raw.createdAt || Date.now();
  let keys = Array.isArray(raw.keys) ? raw.keys : [];

  // تحويل المفتاح الفردي القديم إن وُجد
  if (!keys.length && raw.salt && raw.hash) {
    keys.push({
      id: 'adm_primary',
      name: 'الأدمن الرئيسي',
      salt: String(raw.salt),
      hash: String(raw.hash),
      createdAt,
      lastUsedAt: raw.rotatedAt || createdAt
    });
  }

  return {
    claimed: !!raw.claimed || keys.length > 0,
    createdAt,
    rotatedAt: raw.rotatedAt || null,
    keys
  };
}

async function readDbAuth() {
  if (!sb.configured()) return null;
  try {
    const row = await sb.selectOne('site_secrets', `select=value&key=eq.${sb.enc(DB_SECRET_KEY)}`);
    if (row && row.value) {
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      return normalizeState(parsed);
    }
  } catch (err) {
    console.warn('[admin] تعذّرت قراءة المصادقة من قاعدة البيانات:', err.message);
  }
  return null;
}

async function writeDbAuth(val, { force = false } = {}) {
  if (!sb.configured()) return false;
  try {
    const payload = {
      claimed: !!val.claimed,
      createdAt: val.createdAt || Date.now(),
      rotatedAt: val.rotatedAt || Date.now(),
      keys: val.keys || [],
      // توافق خلفي مع أي كود خارجي يقرأ salt و hash مباشرة
      salt: val.keys?.[0]?.salt || '',
      hash: val.keys?.[0]?.hash || ''
    };

    await sb.request('/rest/v1/site_secrets?on_conflict=key', {
      method: 'POST',
      body: [{
        key: DB_SECRET_KEY,
        value: JSON.stringify(payload),
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

async function refreshState() {
  if (sb.configured()) {
    const dbState = await readDbAuth();
    if (dbState) {
      state = dbState;
      return state;
    }
  }
  if (!state && fs.existsSync(AUTH_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      state = normalizeState(raw);
    } catch { /* تجاهل */ }
  }
  return state;
}

// ---------------------------------------------------------------------------
// التحميل والإقلاع
// ---------------------------------------------------------------------------
function load() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      state = normalizeState(raw);
      if (state) return;
    }
  } catch (err) {
    console.error('[admin] ملف المصادقة تالف:', err.message);
  }

  if (process.env.VERCEL || sb.configured()) {
    return;
  }

  if (ENV_KEY) return;

  const key = generateKey();
  const salt = crypto.randomBytes(16).toString('hex');
  state = {
    claimed: false,
    createdAt: Date.now(),
    rotatedAt: null,
    keys: [{
      id: 'adm_init',
      name: 'الأدمن الرئيسي',
      salt,
      hash: hashKey(key, salt),
      createdAt: Date.now(),
      lastUsedAt: null
    }]
  };
  save(state);
  state.firstRunKey = key;
}

// ---------------------------------------------------------------------------
// التحقق والمصادقة
// ---------------------------------------------------------------------------
function validateNewKey(key) {
  const clean = String(key || '').trim();
  if (clean.length < MIN_KEY_LENGTH) {
    return { ok: false, error: `المفتاح قصير — ${MIN_KEY_LENGTH} خانات على الأقل` };
  }
  if (clean.length > 200) return { ok: false, error: 'المفتاح طويل جداً' };
  if (/\s/.test(clean)) return { ok: false, error: 'المفتاح لا يحتمل مسافات' };
  return { ok: true, clean };
}

/**
 * التحقق من مفتاح الإدارة
 * يفحص المفتاح مقابل جميع المفاتيح النشطة في مصفوفة الأدمن
 */
async function verify(key) {
  const clean = String(key || '').trim();
  if (!clean) return false;

  // 1. فحص الذاكرة الحالية أولاً (سريع)
  if (state && Array.isArray(state.keys) && state.keys.length > 0) {
    for (const k of state.keys) {
      if (safeEqual(hashKey(clean, k.salt), k.hash)) {
        k.lastUsedAt = Date.now();
        return true;
      }
    }
  }

  // 2. تحديث من Supabase (لتزامن الخوادم والأجهزة المفتوحة)
  await refreshState();
  if (state && Array.isArray(state.keys)) {
    for (const k of state.keys) {
      if (safeEqual(hashKey(clean, k.salt), k.hash)) {
        k.lastUsedAt = Date.now();
        return true;
      }
    }
  }

  // 3. متغيّر البيئة للطوارئ
  if (ENV_KEY && safeEqual(clean, ENV_KEY)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// إدارة مفاتيح الأدمن المتعددة
// ---------------------------------------------------------------------------

/**
 * إضافة مفتاح أدمن جديد لجهاز أو مستخدم دون إلغاء المفاتيح السابقة
 */
async function addKey(key, { name = 'جهاز أدمن إضافي' } = {}) {
  const clean = String(key || '').trim();
  const v = validateNewKey(clean);
  if (!v.ok) return v;

  await refreshState();
  if (!state) {
    state = { claimed: true, createdAt: Date.now(), keys: [] };
  }
  if (!Array.isArray(state.keys)) state.keys = [];

  // التحقق إن كان المفتاح مسجلاً بالفعل
  for (const k of state.keys) {
    if (safeEqual(hashKey(v.clean, k.salt), k.hash)) {
      return { ok: true, key: v.clean, id: k.id, name: k.name, existed: true };
    }
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const keyObj = {
    id: 'adm_' + crypto.randomBytes(6).toString('hex'),
    name: String(name || '').trim() || `جهاز أدمن ${state.keys.length + 1}`,
    salt,
    hash: hashKey(v.clean, salt),
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  };

  state.keys.push(keyObj);
  state.claimed = true;
  state.rotatedAt = Date.now();

  const saved = await save(state, { force: true });
  if (!saved && !sb.configured() && !process.env.VERCEL) {
    return { ok: false, error: 'تعذّر حفظ المفتاح — تأكّد من صلاحيات المجلد أو قاعدة البيانات' };
  }

  console.log(`[admin] أُضيف مفتاح أدمن جديد (${keyObj.name} - ${keyObj.id})، إجمالي المفاتيح: ${state.keys.length}`);
  return { ok: true, key: v.clean, id: keyObj.id, name: keyObj.name };
}

/**
 * جلب قائمة آمنة بالمفاتيح النشطة (بدون الهاشات والـ salt)
 */
async function listKeys() {
  await refreshState();
  if (!state || !Array.isArray(state.keys)) return [];
  return state.keys.map((k) => ({
    id: k.id,
    name: k.name || 'أدمن',
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || null
  }));
}

/**
 * إلغاء/حذف مفتاح أدمن محدد (مثلاً جهاز مفقود أو موظف سابق)
 */
async function revokeKey(keyId) {
  await refreshState();
  if (!state || !Array.isArray(state.keys) || !state.keys.length) {
    return { ok: false, error: 'لا توجد مفاتيح مسجلة' };
  }
  if (state.keys.length <= 1) {
    return { ok: false, error: 'لا يمكن حذف المفتاح الأخير — يجب أن يبقى مفتاح أدمن واحد على الأقل' };
  }

  const prevLen = state.keys.length;
  state.keys = state.keys.filter((k) => k.id !== keyId);
  if (state.keys.length === prevLen) {
    return { ok: false, error: 'المفتاح المطلوب غير موجود' };
  }

  await save(state, { force: true });
  console.log(`[admin] تم حذف مفتاح الأدمن ${keyId}، المفاتيح المتبقية: ${state.keys.length}`);
  return { ok: true, remaining: state.keys.length };
}

/**
 * عند الدخول من البوابة أو إنشاء مفتاح جديد
 * الآن يُضاف كمفتاح نشط بدلاً من مسح المفاتيح الأخرى
 */
async function rotate(newKey, { name = 'جهاز أدمن' } = {}) {
  const key = newKey ? String(newKey).trim() : generateKey();
  const res = await addKey(key, { name });
  if (!res.ok) return res;
  return { ok: true, key: res.key, id: res.id, generated: !newKey };
}

async function claim(key, { name = 'الأدمن الرئيسي' } = {}) {
  return addKey(key, { name });
}

function claimOpen() {
  if (ENV_KEY) return false;
  if (!state || (Array.isArray(state.keys) && state.keys.length > 0)) return false;
  return Date.now() - (state ? state.createdAt : Date.now()) < CLAIM_WINDOW_MS;
}

async function publicStatus() {
  await refreshState();
  const hasKeys = !!(state && Array.isArray(state.keys) && state.keys.length > 0);
  return {
    source: hasKeys ? 'db' : (ENV_KEY ? 'env' : 'file'),
    ownKeyChosen: hasKeys || !!ENV_KEY,
    keysCount: hasKeys ? state.keys.length : 0,
    canSetFromBrowser: !hasKeys && !ENV_KEY,
    canRotate: true,
    storageWritable: !saveError
  };
}

function bootLines(port) {
  const lines = [`  لوحة الإدارة  : http://localhost:${port}/admin`];
  if (state && Array.isArray(state.keys) && state.keys.length > 0) {
    lines.push(`  مفاتيح الإدارة: ${state.keys.length} مفتاح أدمن نشط (يدعم تعدد الأجهزة)`);
  } else if (ENV_KEY) {
    lines.push('  مفتاح الإدارة : من متغيّر البيئة ICHANCE_ADMIN_KEY');
  } else {
    lines.push('  مفتاح الإدارة : ادخل من البوابة السرية لتوليد مفتاح لجهازك');
  }
  return lines;
}

load();

module.exports = {
  verify, claim, rotate, addKey, listKeys, revokeKey, publicStatus, generateKey, bootLines,
  AUTH_FILE, PLAIN_FILE, MIN_KEY_LENGTH
};
