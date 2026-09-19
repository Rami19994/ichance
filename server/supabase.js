'use strict';

const fs = require('fs');
const path = require('path');
const { SERVER } = require('./config');

/**
 * عميل Supabase بلا أي مكتبة خارجية.
 *
 * المشروع كلّه بلا تبعيات، و`@supabase/supabase-js` كانت ستكسر ذلك وتفرض
 * `npm install` على الاستضافة. واجهة PostgREST هي HTTP عادي، و`fetch` مدمج
 * في Node 18+ — فما من سبب لإضافة مكتبة.
 *
 * ── أين تُقرأ المفاتيح
 *   1. متغيّرا البيئة SUPABASE_URL و SUPABASE_SECRET_KEY.
 *   2. ملف data/admin-supabase.json — للاستضافات التي لا تعطي تيرمنالاً.
 *
 * ⚠ مفتاح service_role يتخطّى كل صلاحيات قاعدة البيانات. لا يخرج من الخادم
 * إلى المتصفح أبداً، ومجلّد data لا يُخدَّم على الويب (الملفات العامة في
 * public وحدها) — فلا يصل إليه زائر.
 */

const DATA_DIR = path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const CONF_FILE = path.join(DATA_DIR, 'admin-supabase.json');

let conf = null;

function loadConfig() {
  const envUrl = (process.env.SUPABASE_URL || '').trim();
  const envKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (envUrl && envKey) return { url: envUrl.replace(/\/+$/, ''), key: envKey, source: 'env' };

  try {
    if (fs.existsSync(CONF_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
      if (raw && raw.url && raw.key) {
        return { url: String(raw.url).replace(/\/+$/, ''), key: String(raw.key), source: 'file' };
      }
    }
  } catch (err) {
    console.error('[supabase] ملف الإعدادات تالف:', err.message);
  }
  return null;
}

function config() {
  if (conf === null) conf = loadConfig();
  return conf;
}

function configured() { return !!config(); }

/** يعيد قراءة الإعدادات — بعد حفظها من لوحة الإدارة مثلاً. */
function reload() { conf = null; return config(); }

function saveConfig({ url, key }) {
  const clean = { url: String(url || '').trim().replace(/\/+$/, ''), key: String(key || '').trim() };
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(clean.url)) {
    return { ok: false, error: 'رابط المشروع غير صالح' };
  }
  if (clean.key.length < 20) return { ok: false, error: 'المفتاح قصير — تأكّد أنه مفتاح service_role' };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONF_FILE, JSON.stringify(clean, null, 2), 'utf8');
    conf = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `تعذّر الحفظ: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// الطلبات
// ---------------------------------------------------------------------------
class SupabaseError extends Error {
  constructor(message, { status, code, raw } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

/**
 * رسائل أخطاء الدوال المخزّنة بالعربية.
 * الدوال في قاعدة البيانات ترفع رموزاً إنجليزية ثابتة (لا رسائل جاهزة) كي
 * تبقى مستقلّة عن لغة الواجهة، والترجمة هنا في مكان واحد.
 */
const ERRORS = {
  AMOUNT_INVALID: 'المبلغ غير صالح',
  CASHIER_NOT_FOUND: 'حساب الكاشير غير موجود',
  CASHIER_INACTIVE: 'حساب الكاشير موقوف',
  PLAYER_NOT_FOUND: 'اللاعب غير موجود',
  PLAYER_INACTIVE: 'حساب اللاعب موقوف',
  NOT_YOUR_PLAYER: 'هذا اللاعب ليس من حساباتك',
  INSUFFICIENT_FLOAT: 'عهدتك لا تكفي — اطلب تعبئة من الإدارة',
  INSUFFICIENT_BALANCE: 'رصيد اللاعب لا يكفي'
};

function translate(message) {
  if (!message) return 'خطأ غير معروف من قاعدة البيانات';
  for (const [code, arabic] of Object.entries(ERRORS)) {
    if (message.includes(code)) return arabic;
  }
  if (message.includes('accounts_username_uniq')) return 'اسم المستخدم محجوز';
  if (message.includes('accounts_email_uniq')) return 'الإيميل مستخدم بالفعل';
  if (message.includes('accounts_display_uniq')) return 'تعارض في المعرّف — أعد المحاولة';
  if (message.includes('balance_not_negative')) return 'العملية تجعل الرصيد سالباً';
  return message;
}

const TIMEOUT_MS = 15_000;

async function request(pathname, { method = 'GET', body, prefer } = {}) {
  const c = config();
  if (!c) throw new SupabaseError('قاعدة البيانات غير مربوطة بعد', { status: 503 });

  const headers = {
    apikey: c.key,
    Authorization: `Bearer ${c.key}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;

  // مهلة صريحة: بدونها يعلّق طلب اللاعب إلى ما لا نهاية إن تعطّلت الشبكة
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${c.url}${pathname}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal
    });
  } catch (err) {
    throw new SupabaseError(
      err.name === 'AbortError' ? 'انتهت مهلة الاتصال بقاعدة البيانات' : 'تعذّر الاتصال بقاعدة البيانات',
      { status: 503, raw: err.message }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const msg = (data && (data.message || data.hint || data.details)) || String(data || res.statusText);
    throw new SupabaseError(translate(msg), { status: res.status, code: data && data.code, raw: msg });
  }
  return data;
}

const enc = encodeURIComponent;

/** استعلام قراءة. `query` سلسلة PostgREST جاهزة مثل `select=*&id=eq.x`. */
function select(table, query = 'select=*') {
  return request(`/rest/v1/${table}?${query}`);
}

/** صفّ واحد أو null. */
async function selectOne(table, query) {
  const rows = await request(`/rest/v1/${table}?${query}&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function insert(table, row, { returning = true } = {}) {
  return request(`/rest/v1/${table}`, {
    method: 'POST',
    body: Array.isArray(row) ? row : [row],
    prefer: returning ? 'return=representation' : 'return=minimal'
  });
}

function update(table, query, patch, { returning = true } = {}) {
  return request(`/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    body: patch,
    prefer: returning ? 'return=representation' : 'return=minimal'
  });
}

function rpc(fn, args = {}) {
  return request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
}

/** فحص اتصال سريع — يُستعمل عند الإقلاع وفي لوحة الإدارة. */
async function ping() {
  try {
    await request('/rest/v1/accounts?select=id&limit=1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  configured, config, reload, saveConfig, CONF_FILE,
  select, selectOne, insert, update, rpc, request, ping,
  SupabaseError, translate, enc
};
