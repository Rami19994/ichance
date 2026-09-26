'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sb = require('./supabase');
const countries = require('./countries');
const { SERVER } = require('./config');

/**
 * الحسابات: إدارة ← كاشير ← لاعب.
 *
 * يدعم وضعين:
 * 1. Supabase (عبر PostgREST) عند توفر مفتاح صالح ورابط صحيح.
 * 2. التخزين المحلي المشفر في data/accounts.json كنسخة احتياطية ذاتية العمل 100%
 *    (تشفير scrypt، عهدة الكاشير، سجل العمليات، التحقق من الصلاحيات).
 */

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ichance_data')
  : path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

const EMAIL_DOMAIN = '@gmail.com';
const MIN_PASSWORD = 6;
const FLUSH_MS = 2_000;

// ---------------------------------------------------------------- كلمات المرور
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const got = crypto.scryptSync(String(password), salt, 32);
  const want = Buffer.from(hash, 'hex');
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

function shortId() {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ------------------------------------------------------------------- التحقّق
function checkUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3) return { ok: false, error: 'اسم المستخدم قصير — 3 أحرف على الأقل' };
  if (u.length > 64) return { ok: false, error: 'اسم المستخدم طويل' };
  if (!/^[A-Za-z0-9._@+-]+$/.test(u)) {
    return { ok: false, error: 'اسم المستخدم: حروف إنجليزية وأرقام و . _ - @ فقط' };
  }
  return { ok: true, value: u };
}

function checkEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { ok: false, error: 'الإيميل مطلوب' };
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) {
    return { ok: false, error: 'صيغة الإيميل غير صحيحة' };
  }
  return { ok: true, value: e };
}

function checkPassword(password) {
  const p = String(password || '').trim();
  if (p.length < MIN_PASSWORD) return { ok: false, error: `كلمة المرور: ${MIN_PASSWORD} خانات على الأقل` };
  if (p.length > 200) return { ok: false, error: 'كلمة المرور طويلة جداً' };
  return { ok: true, value: p };
}

function checkAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'المبلغ يجب أن يكون رقماً صحيحاً أكبر من صفر' };
  }
  if (n > 1_000_000_000) return { ok: false, error: 'المبلغ كبير جداً' };
  return { ok: true, value: n };
}

// ------------------------------------------------------------------ التخزين المحلي
let localDb = null;

function loadLocal() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      if (raw && Array.isArray(raw.accounts)) {
        localDb = {
          accounts: raw.accounts,
          transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
          tiers: Array.isArray(raw.tiers) ? raw.tiers : [{ min_burn: 0, rate: 5, label: 'افتراضي' }]
        };
        return localDb;
      }
    }
  } catch (err) {
    console.error('[accounts] تعذرت قراءة ملف الحسابات المحلي:', err.message);
  }
  localDb = {
    accounts: [],
    transactions: [],
    tiers: [{ min_burn: 0, rate: 5, label: 'افتراضي' }]
  };
  saveLocal();
  return localDb;
}

function getLocal() {
  if (!localDb) localDb = loadLocal();
  return localDb;
}

function saveLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(localDb, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[accounts] تعذّر حفظ الحسابات محلياً:', err.message);
    return false;
  }
}

// فحص وجاهزية Supabase
//
// ⚠ فحصٌ فاشل واحد لا يحكم على عمر النسخة كلّه. كانت نتيجة أوّل فحص تُثبَّت
// إلى الأبد: نسخةٌ باردة على Vercel يتأخّر أوّل اتصال لها 15 ثانية — وهذا
// يحدث، ظهر في سجلّات الإنتاج — تبقى تخدم الدخول والحسابات من ملف محلّي فارغ
// حتى تُعاد. اللاعب يُطرد من جلسته بلا سبب ظاهر. الآن يُعاد الفحص بعد مهلة.
let supabaseReady = sb.configured();   // متفائل إلى أن يكتمل أوّل فحص
let pingPromise = null;
let pingOk = false;
let pingFailedAt = 0;
const PING_RETRY_MS = Number(process.env.ICHANCE_PING_RETRY_MS) || 10_000;

async function checkSupabase() {
  if (!sb.configured()) {
    supabaseReady = false;
    return false;
  }
  const ping = await sb.ping();
  supabaseReady = ping.ok;
  return supabaseReady;
}

async function ensureSupabase() {
  if (!sb.configured()) {
    supabaseReady = false;
    return false;
  }
  if (pingPromise) return pingPromise;
  // ثبت الاتصال مرّة: أخطاء ما بعده تُعالَج في كل نداء على حدة
  if (pingOk) return supabaseReady;
  // فشل قريباً: لا نطرق القاعدة مع كل طلب — ننتظر المهلة ثم نعيد
  if (pingFailedAt && Date.now() - pingFailedAt < PING_RETRY_MS) return false;

  pingPromise = sb.ping().then((res) => {
    supabaseReady = !!res.ok;
    if (res.ok) {
      pingOk = true;
      pingFailedAt = 0;
      console.log('[accounts] متصل بـ Supabase بنجاح');
    } else {
      pingFailedAt = Date.now();
      console.warn(`[accounts] تعذّر الاتصال بـ Supabase — يُعاد الفحص بعد ${PING_RETRY_MS / 1000} ثوانٍ:`, res.error);
    }
    return supabaseReady;
  }).catch(() => {
    supabaseReady = false;
    pingFailedAt = Date.now();
    return false;
  }).finally(() => { pingPromise = null; });
  return pingPromise;
}

// ── مرجع الدفتر
//
// القاعدة — إن كانت مضبوطة — هي المرجع الوحيد للحسابات والأرصدة. لا ملف محلّي
// بديلاً عنها حين تخطئ: كانت كل دالّة تقريباً تعيد المحاولة على الملف عند أي
// خطأ، فيُنشأ لاعب لا تعرفه القاعدة، ويُقال «أوقفتُ الحساب» والحساب ما زال
// نشطاً، ويدخل مستخدمٌ بحساب قديم من الملف. وعلى Vercel ذلك الملف /tmp يُمحى
// مع الدالّة. الملف المحلّي للتطوير على جهاز بلا قاعدة فقط.
const NO_DB = 'قاعدة البيانات غير مربوطة — اضبط SUPABASE_URL و SUPABASE_SECRET_KEY';
const DB_DOWN = 'تعذّر الاتصال بقاعدة البيانات — حاول بعد قليل';

function useDb() { return sb.configured(); }
function localAllowed() { return !sb.configured() && !process.env.VERCEL; }

/** خطأ قراءة من القاعدة: يُرفع فيردّ الخادم بخطأ صريح بدل قائمة فارغة تكذب. */
function readFailed(where, err) {
  const e = new Error(`${where}: ${(err && err.message) || DB_DOWN}`);
  e.status = 503;
  return e;
}

const stripAll = (rows) => (Array.isArray(rows) ? rows.map(strip) : []);

// فحص أولي سريع في الخلفية
ensureSupabase();

function strip(row) {
  if (!row) return null;
  const { password_hash, password_salt, play_token, ...safe } = row;
  return safe;
}

// ------------------------------------------------------------------ إنشاء الحسابات
async function createCashier({ username, email, password, startingFloat = 0, unlimited = false, country, masterId = null }) {
  const u = checkUsername(username); if (!u.ok) return u;
  const p = checkPassword(password); if (!p.ok) return p;
  const em = email ? checkEmail(email) : { ok: true, value: null };
  if (!em.ok) return em;
  const f = startingFloat ? checkAmount(startingFloat) : { ok: true, value: 0 };
  if (!f.ok) return f;
  const c = countries.resolve(country); if (!c.ok) return c;

  const { hash, salt } = hashPassword(p.value);

  if (useDb()) {
    try {
      const rows = await sb.insert('accounts', {
        role: 'cashier',
        username: u.value,
        email: em.value || null,
        password_hash: hash,
        password_salt: salt,
        display_id: shortId(),
        balance: 0,
        unlimited_float: !!unlimited,
        country: c.country,
        currency: c.currency,
        master_id: masterId || null
      });
      let row = rows[0];
      if (f.value > 0) {
        const out = await sb.rpc('admin_adjust_cashier', {
          p_cashier: row.id, p_amount: f.value, p_topup: true, p_note: 'عهدة أولى'
        });
        row = { ...row, balance: out.cashier_balance, float_balance: out.cashier_balance };
      } else {
        row = { ...row, balance: 0, float_balance: 0 };
      }
      return { ok: true, cashier: strip(row) };
    } catch (err) {
      console.warn('[accounts] تعذّر الإنشاء على Supabase:', err.message);
      if (err.raw && (err.raw.includes('accounts_username_uniq') || err.raw.includes('duplicate key') || err.code === '23505')) {
        if (err.raw.includes('accounts_email_uniq')) return { ok: false, error: 'هذا الإيميل مستخدم بالفعل' };
        return { ok: false, error: 'اسم المستخدم محجوز مسبقاً' };
      }
      return { ok: false, error: err.message || 'تعذّر إنشاء الكاشير' };
    }
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };

  // المحرك المحلي
  const db = getLocal();
  const unameKey = u.value.toLowerCase();
  const emailKey = em.value ? em.value.toLowerCase() : null;
  if (db.accounts.some((a) => a.username_key === unameKey)) {
    return { ok: false, error: 'اسم المستخدم محجوز مسبقاً' };
  }
  if (emailKey && db.accounts.some((a) => a.email_key === emailKey)) {
    return { ok: false, error: 'هذا الإيميل مستخدم بالفعل' };
  }

  const id = 'csh_' + crypto.randomBytes(8).toString('hex');
  const cashier = {
    id,
    role: 'cashier',
    username: u.value,
    username_key: unameKey,
    email: em.value || null,
    email_key: emailKey,
    password_hash: hash,
    password_salt: salt,
    display_id: shortId(),
    balance: f.value || 0,
    float_balance: f.value || 0,
    unlimited_float: !!unlimited,
    country: c.country,
    currency: c.currency,
    master_id: masterId || null,
    active: true,
    created_at: new Date().toISOString(),
    last_login_at: null
  };

  db.accounts.push(cashier);
  if (f.value > 0) {
    db.transactions.push({
      id: 'tx_' + crypto.randomBytes(8).toString('hex'),
      cashier_id: id,
      player_id: null,
      kind: 'topup',
      amount: f.value,
      cashier_balance_after: cashier.balance,
      player_balance_after: null,
      note: 'عهدة أولى',
      created_at: new Date().toISOString()
    });
  }
  saveLocal();
  return { ok: true, cashier: strip(cashier) };
}

/**
 * ينشئ لاعباً برصيد صفر دائماً. لا معامل رصيد: أي مال يدخل حساباً يمرّ
 * بإيداع مسجَّل في الدفتر، وإلا ظهر مالٌ لا يراه أي تقرير.
 */
async function createPlayer({ cashierId, username, email, password, createdBy }) {
  let uRaw = String(username || '').trim();
  let emRaw = email ? String(email).trim() : '';
  if (uRaw.includes('@') && !emRaw) {
    emRaw = uRaw;
  }
  if (!emRaw) {
    emRaw = `${uRaw.toLowerCase()}@player.luckyarena.com`;
  }
  const u = checkUsername(uRaw); if (!u.ok) return u;
  const e = checkEmail(emRaw); if (!e.ok) return e;
  const p = checkPassword(password); if (!p.ok) return p;

  const { hash, salt } = hashPassword(p.value);

  let creatorId = null;
  if (createdBy && typeof createdBy === 'string' && createdBy !== 'admin' && (createdBy.startsWith('csh_') || createdBy.startsWith('mst_'))) {
    creatorId = createdBy;
  } else if (cashierId) {
    creatorId = cashierId;
  }

  let playerCountry = 'IQ';
  let playerCurrency = 'IQD';
  if (cashierId) {
    try {
      const c = await cashierSelf(cashierId);
      if (c) {
        if (c.country) playerCountry = c.country;
        if (c.currency) playerCurrency = c.currency;
      }
    } catch {}
  }

  if (useDb()) {
    try {
      const rows = await sb.insert('accounts', {
        role: 'player',
        username: u.value,
        email: e.value,
        password_hash: hash,
        password_salt: salt,
        display_id: shortId(),
        cashier_id: cashierId || null,
        balance: 0,
        country: playerCountry,
        currency: playerCurrency,
        created_by: creatorId
      });
      return { ok: true, player: strip(rows[0]) };
    } catch (err) {
      console.warn('[accounts] تعذّر إنشاء اللاعب على Supabase:', err.message);
      if (err.raw && (err.raw.includes('accounts_username_uniq') || err.raw.includes('duplicate key') || err.code === '23505')) {
        if (err.raw.includes('accounts_email_uniq')) return { ok: false, error: 'هذا الإيميل مستخدم بالفعل' };
        return { ok: false, error: 'اسم المستخدم محجوز مسبقاً' };
      }
      return { ok: false, error: err.message || 'تعذّر إنشاء اللاعب' };
    }
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };

  // المحرك المحلي
  const db = getLocal();
  const unameKey = u.value.toLowerCase();
  const emailKey = e.value.toLowerCase();
  if (db.accounts.some((a) => a.username_key === unameKey)) {
    return { ok: false, error: 'اسم المستخدم محجوز مسبقاً' };
  }
  if (db.accounts.some((a) => a.email_key === emailKey)) {
    return { ok: false, error: 'هذا الإيميل مستخدم بالفعل' };
  }

  const id = 'ply_' + crypto.randomBytes(8).toString('hex');
  const player = {
    id,
    role: 'player',
    username: u.value,
    username_key: unameKey,
    email: e.value,
    email_key: emailKey,
    password_hash: hash,
    password_salt: salt,
    display_id: shortId(),
    cashier_id: cashierId || null,
    created_by: creatorId,
    balance: 0,
    country: playerCountry,
    currency: playerCurrency,
    active: true,
    created_at: new Date().toISOString(),
    last_login_at: null
  };

  db.accounts.push(player);
  saveLocal();
  return { ok: true, player: strip(player) };
}

// ------------------------------------------------------------------- تسجيل الدخول
/**
 * الدخول.
 *
 * رسالة واحدة لاسم خاطئ أو كلمة مرور خاطئة، وزمن واحد في الحالتين: كانت
 * الرسالتان مختلفتين («غير مسجّل» / «كلمة المرور غير صحيحة»)، فيعرف من
 * يجرّب أيّ الأسماء موجودة ثم يركّز عليها. ولأن فحص كلمة المرور بطيء عمداً
 * (scrypt)، كان الردّ على اسم غير موجود أسرع بوضوح — فنفحص كلمة وهمية
 * ليتساوى الزمن.
 */
const BAD_LOGIN = 'اسم المستخدم أو كلمة المرور غير صحيحة';
let dummyCredential = null;
function burnPasswordCheck(pwd) {
  if (!dummyCredential) dummyCredential = hashPassword(crypto.randomBytes(16).toString('hex'));
  verifyPassword(pwd, dummyCredential.hash, dummyCredential.salt);
}

function checkLoginRow(row, pwd, expectRole) {
  if (!row) { burnPasswordCheck(pwd); return { ok: false, error: BAD_LOGIN }; }
  const isMatch = verifyPassword(pwd, row.password_hash, row.password_salt) ||
                  verifyPassword(pwd.trim(), row.password_hash, row.password_salt);
  if (!isMatch) return { ok: false, error: BAD_LOGIN };
  // ما بعد كلمة المرور الصحيحة لا يكشف شيئاً لمن لا يملكها
  if (!row.active) return { ok: false, error: 'هذا الحساب موقوف — راجع الإدارة' };
  if (expectRole && row.role !== expectRole) {
    return { ok: false, error: `هذا الحساب ليس حساب ${expectRole === 'cashier' ? 'كاشير' : expectRole === 'master' ? 'ماستر' : 'لاعب'}` };
  }
  return { ok: true };
}

async function login(identifier, password, { expectRole } = {}) {
  const rawId = String(identifier || '').trim();
  const id = rawId.toLowerCase();
  const pwd = String(password || '');
  if (!rawId || !pwd) return { ok: false, error: 'أدخل اسم المستخدم وكلمة المرور' };

  if (useDb()) {
    let row;
    try {
      const q = `or=(username_key.eq.${sb.enc(id)},email_key.eq.${sb.enc(id)},display_id.eq.${sb.enc(rawId)},display_id.eq.${sb.enc(rawId.toUpperCase())},id.eq.${sb.enc(rawId)})`;
      row = await sb.selectOne('accounts', `select=*&${q}`);
    } catch (err) {
      return { ok: false, error: DB_DOWN };
    }
    const verdict = checkLoginRow(row, pwd, expectRole);
    if (!verdict.ok) return verdict;
    const token = newToken();
    try {
      await sb.update('accounts', `id=eq.${sb.enc(row.id)}`,
        { play_token: token, last_login_at: new Date().toISOString() }, { returning: false });
    } catch (err) {
      return { ok: false, error: DB_DOWN };
    }
    return { ok: true, token, account: strip({ ...row, play_token: undefined }) };
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };

  const db = getLocal();
  const row = db.accounts.find((a) =>
    a.username_key === id ||
    a.email_key === id ||
    a.display_id === rawId ||
    a.display_id === rawId.toUpperCase() ||
    a.id === rawId
  );
  const verdict = checkLoginRow(row, pwd, expectRole);
  if (!verdict.ok) return verdict;

  const token = newToken();
  row.play_token = token;
  row.last_login_at = new Date().toISOString();
  saveLocal();
  return { ok: true, token, account: strip(row) };
}

async function byToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;

  if (useDb()) {
    // خطأ القاعدة هنا = «لا جلسة» — أسلم من قبول رمز لا يمكن التحقّق منه
    try {
      const row = await sb.selectOne('accounts', `select=*&play_token=eq.${sb.enc(t)}`);
      return row && row.active ? row : null;
    } catch {
      return null;
    }
  }
  if (!localAllowed()) return null;

  const db = getLocal();
  const row = db.accounts.find((a) => a.play_token === t);
  return row && row.active ? row : null;
}

async function byId(id) {
  if (!id) return null;
  if (useDb()) {
    try {
      return await sb.selectOne('accounts', `select=*&id=eq.${sb.enc(String(id))}`);
    } catch (err) {
      throw readFailed('byId', err);
    }
  }
  if (!localAllowed()) return null;
  const db = getLocal();
  return db.accounts.find((a) => a.id === String(id) || a.display_id === String(id)) || null;
}

async function logout(token) {
  const t = String(token || '').trim();
  if (!t) return;
  if (useDb()) {
    try { await sb.update('accounts', `play_token=eq.${sb.enc(t)}`, { play_token: null }, { returning: false }); }
    catch { /* الرمز يبقى صالحاً حتى الدخول التالي — لا شيء أسوأ من ذلك */ }
    return;
  }
  if (!localAllowed()) return;
  const db = getLocal();
  const row = db.accounts.find((a) => a.play_token === t);
  if (row) {
    row.play_token = null;
    saveLocal();
  }
}

// -------------------------------------------------------------- كلمات المرور والحالة
async function setPlayerPassword({ playerId, newPassword, ownerId }) {
  const p = checkPassword(newPassword); if (!p.ok) return p;
  const row = await byId(playerId);
  if (!row || row.role !== 'player') return { ok: false, error: 'اللاعب غير موجود' };
  if (ownerId && row.cashier_id !== ownerId) return { ok: false, error: 'هذا اللاعب ليس من حساباتك' };

  const { hash, salt } = hashPassword(p.value);

  if (useDb()) {
    try {
      await sb.update('accounts', `id=eq.${sb.enc(row.id)}`,
        { password_hash: hash, password_salt: salt, play_token: null }, { returning: false });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || DB_DOWN };
    }
  }
  if (!localAllowed()) return { ok: false, error: NO_DB };

  row.password_hash = hash;
  row.password_salt = salt;
  row.play_token = null;
  saveLocal();
  return { ok: true };
}

async function setCashierPassword({ cashierId, newPassword }) {
  const p = checkPassword(newPassword); if (!p.ok) return p;
  const target = await byId(cashierId);
  if (!target || target.role !== 'cashier') return { ok: false, error: 'الكاشير غير موجود' };
  const { hash, salt } = hashPassword(p.value);

  if (useDb()) {
    try {
      await sb.update('accounts', `id=eq.${sb.enc(target.id)}`,
        { password_hash: hash, password_salt: salt, play_token: null }, { returning: false });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || DB_DOWN };
    }
  }
  if (!localAllowed()) return { ok: false, error: NO_DB };

  target.password_hash = hash;
  target.password_salt = salt;
  target.play_token = null;
  saveLocal();
  return { ok: true };
}

/**
 * إيقاف حساب أو تفعيله.
 * ownerField يحدّد علاقة الملكية: cashier_id (كاشير ← لاعبوه) أو master_id
 * (ماستر ← كاشيريته). كانت الدالّة تتجاهله وتقارن cashier_id دائماً، فلم يكن
 * الماستر قادراً على إيقاف كاشير واحد من كاشيريته.
 */
async function setActive({ accountId, active, ownerId, ownerField = 'cashier_id' }) {
  const row = await byId(accountId);
  if (!row) return { ok: false, error: 'الحساب غير موجود' };
  if (ownerId && row[ownerField] !== ownerId) return { ok: false, error: 'هذا الحساب ليس من حساباتك' };

  const patch = { active: !!active };
  if (!active) patch.play_token = null;          // الإيقاف يُخرجه فوراً

  if (useDb()) {
    try {
      await sb.update('accounts', `id=eq.${sb.enc(row.id)}`, patch, { returning: false });
      return { ok: true };
    } catch (err) {
      // لا «تمّ» كاذبة: حساب يُظنّ موقوفاً وهو نشط أخطر من رسالة خطأ
      return { ok: false, error: err.message || DB_DOWN };
    }
  }
  if (!localAllowed()) return { ok: false, error: NO_DB };

  Object.assign(row, patch);
  saveLocal();
  return { ok: true };
}

// ---------------------------------------------------------------- حركة المال
/**
 * خطأ عملية مالية حين تكون القاعدة هي الدفتر.
 * رفضها نهائي، وانقطاعها يعني أن العملية لم تتمّ — لا تُنقل إلى ملف محلّي
 * لا يراه أحد (ويُمحى على Vercel مع الدالّة). كان الإيداع والسحب يُعاد
 * تجريبهما على الملف عند أي خطأ، حتى «عهدتك لا تكفي»، فيتخطّيان الرفض.
 * وإن انتهت المهلة فربما تمّت وضاع الردّ وحده: نقول ذلك صراحةً كي لا يعيد
 * الكاشير العملية فتتكرّر.
 */
function moneyError(err) {
  if (err && err.kind === 'timeout') {
    return {
      ok: false,
      error: 'انتهت مهلة قاعدة البيانات — قد تكون العملية تمّت. راجع رصيد اللاعب وسجلّه قبل أن تعيد المحاولة.'
    };
  }
  return { ok: false, error: (err && err.message) || 'تعذّرت العملية' };
}

async function deposit({ cashierId, playerId, amount, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;

  // القاعدة هي الدفتر إن كانت مضبوطة — لا ملف محلّي بديلاً عنها (انظر moneyError)
  if (sb.configured()) {
    try {
      const out = await sb.rpc('cashier_deposit', {
        p_cashier: cashierId, p_player: playerId, p_amount: a.value, p_note: note || null
      });
      return { ok: true, ...out };
    } catch (err) {
      return moneyError(err);
    }
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  const cashier = db.accounts.find((x) => x.id === cashierId && x.role === 'cashier');
  const player = db.accounts.find((x) => (x.id === playerId || x.display_id === playerId) && x.role === 'player');

  if (!cashier) return { ok: false, error: 'حساب الكاشير غير موجود' };
  if (!cashier.active) return { ok: false, error: 'حساب الكاشير موقوف' };
  if (!player) return { ok: false, error: 'حساب اللاعب غير موجود' };
  if (!player.active) return { ok: false, error: 'حساب اللاعب موقوف' };
  if (player.cashier_id && player.cashier_id !== cashier.id) {
    return { ok: false, error: 'هذا اللاعب ليس من حساباتك' };
  }

  if (!cashier.unlimited_float && cashier.balance < a.value) {
    return { ok: false, error: 'عهدتك لا تكفي — اطلب تعبئة من الإدارة' };
  }

  if (!cashier.unlimited_float) cashier.balance -= a.value;
  player.balance = (player.balance || 0) + a.value;

  db.transactions.push({
    id: 'tx_' + crypto.randomBytes(8).toString('hex'),
    cashier_id: cashier.id,
    player_id: player.id,
    kind: 'deposit',
    amount: a.value,
    cashier_balance_after: cashier.balance,
    player_balance_after: player.balance,
    note: note || 'إيداع للاعب',
    created_at: new Date().toISOString()
  });

  saveLocal();
  return {
    ok: true,
    cashier_balance: cashier.balance,
    player_balance: player.balance
  };
}

async function withdraw({ cashierId, playerId, amount, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;

  // القاعدة هي الدفتر إن كانت مضبوطة — لا ملف محلّي بديلاً عنها (انظر moneyError)
  if (sb.configured()) {
    try {
      const out = await sb.rpc('cashier_withdraw', {
        p_cashier: cashierId, p_player: playerId, p_amount: a.value, p_note: note || null
      });
      return { ok: true, ...out };
    } catch (err) {
      return moneyError(err);
    }
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  const cashier = db.accounts.find((x) => x.id === cashierId && x.role === 'cashier');
  const player = db.accounts.find((x) => (x.id === playerId || x.display_id === playerId) && x.role === 'player');

  if (!cashier) return { ok: false, error: 'حساب الكاشير غير موجود' };
  if (!cashier.active) return { ok: false, error: 'حساب الكاشير موقوف' };
  if (!player) return { ok: false, error: 'حساب اللاعب غير موجود' };
  if (!player.active) return { ok: false, error: 'حساب اللاعب موقوف' };
  if (player.cashier_id && player.cashier_id !== cashier.id) {
    return { ok: false, error: 'هذا اللاعب ليس من حساباتك' };
  }

  if (player.balance < a.value) {
    return { ok: false, error: 'رصيد اللاعب لا يكفي' };
  }

  player.balance -= a.value;
  if (!cashier.unlimited_float) cashier.balance += a.value;

  db.transactions.push({
    id: 'tx_' + crypto.randomBytes(8).toString('hex'),
    cashier_id: cashier.id,
    player_id: player.id,
    kind: 'withdraw',
    amount: a.value,
    cashier_balance_after: cashier.balance,
    player_balance_after: player.balance,
    note: note || 'سحب من اللاعب',
    created_at: new Date().toISOString()
  });

  saveLocal();
  return {
    ok: true,
    cashier_balance: cashier.balance,
    player_balance: player.balance
  };
}

async function adjustCashierFloat({ cashierId, amount, topup, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;

  // القاعدة هي الدفتر إن كانت مضبوطة — لا ملف محلّي بديلاً عنها (انظر moneyError)
  if (sb.configured()) {
    try {
      const out = await sb.rpc('admin_adjust_cashier', {
        p_cashier: cashierId, p_amount: a.value, p_topup: !!topup, p_note: note || null
      });
      return { ok: true, ...out };
    } catch (err) {
      return moneyError(err);
    }
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  const cashier = db.accounts.find((x) => x.id === cashierId && x.role === 'cashier');
  if (!cashier) return { ok: false, error: 'حساب الكاشير غير موجود' };

  if (topup) {
    cashier.balance = (cashier.balance || 0) + a.value;
  } else {
    cashier.balance = Math.max(0, (cashier.balance || 0) - a.value);
  }

  db.transactions.push({
    id: 'tx_' + crypto.randomBytes(8).toString('hex'),
    cashier_id: cashier.id,
    player_id: null,
    kind: topup ? 'topup' : 'deduct',
    amount: a.value,
    cashier_balance_after: cashier.balance,
    player_balance_after: null,
    note: note || (topup ? 'تعبئة عهدة من الإدارة' : 'سحب عهدة من الإدارة'),
    created_at: new Date().toISOString()
  });

  saveLocal();
  return { ok: true, cashier_balance: cashier.balance };
}

// ----------------------------------------------------------------- التقارير
async function allCashiers() {
  let list = null;
  if (useDb()) {
    try {
      list = stripAll(await sb.select('cashier_summary', 'select=*&order=created_at.desc'));
    } catch (err) {
      throw readFailed('allCashiers', err);
    }
  } else if (!localAllowed()) {
    list = [];
  }
  if (!list) {
    const db = getLocal();
    list = db.accounts
      .filter((a) => a.role === 'cashier')
      .map((c) => {
        const pl = db.accounts.filter((p) => p.role === 'player' && p.cashier_id === c.id);
        const burn = (db.transactions || [])
          .filter((t) => t.cashier_id === c.id)
          .reduce((acc, t) => {
            if (t.kind === 'deposit') return acc + Number(t.amount || 0);
            if (t.kind === 'withdraw') return acc - Number(t.amount || 0);
            return acc;
          }, 0);
        return {
          ...strip(c),
          player_count: pl.length,
          active_players: pl.filter((p) => p.active).length,
          players_balance: pl.reduce((sum, p) => sum + Number(p.balance || 0), 0),
          burn: Math.max(0, burn)
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const tiers = await commissionTiers();
  return list.map((c) => {
    const float_balance = Number(c.float_balance != null ? c.float_balance : (c.balance || 0));
    const players_balance = Number(c.players_balance || 0);
    const burn = Number(c.burn || 0);

    let rate = 5;
    if (Array.isArray(tiers) && tiers.length) {
      for (const t of tiers) {
        if (burn >= Number(t.min_burn || 0)) rate = Number(t.rate);
      }
    }
    const commission_amount = Math.round(burn * (rate / 100));

    return {
      ...c,
      balance: float_balance,
      float_balance,
      players_balance,
      burn,
      commission_rate: rate,
      commission_amount
    };
  });
}

async function cashierSelf(cashierId) {
  if (useDb()) {
    try {
      return strip(await sb.selectOne('cashier_summary', `select=*&id=eq.${sb.enc(String(cashierId))}`));
    } catch (err) {
      throw readFailed('cashierSelf', err);
    }
  }
  if (!localAllowed()) return null;
  return strip(getLocal().accounts.find((a) => a.id === cashierId) || null);
}

async function cashierPlayers(cashierId) {
  if (useDb()) {
    try {
      return stripAll(await sb.select('player_summary',
        `select=*&cashier_id=eq.${sb.enc(String(cashierId))}&order=created_at.desc`));
    } catch (err) {
      throw readFailed('cashierPlayers', err);
    }
  }
  if (!localAllowed()) return [];
  const db = getLocal();
  return db.accounts.filter((a) => a.role === 'player' && a.cashier_id === cashierId).map(strip);
}

async function allPlayers({ limit = 200 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (useDb()) {
    try {
      return stripAll(await sb.select('player_summary', `select=*&order=created_at.desc&limit=${n}`));
    } catch (err) {
      // العرض قد يغيب في قاعدة قديمة — نقرأ الجدول مباشرة قبل أن نستسلم
      try {
        return stripAll(await sb.select('accounts', `role=eq.player&order=created_at.desc&limit=${n}`));
      } catch (err2) {
        throw readFailed('allPlayers', err2);
      }
    }
  }
  if (!localAllowed()) return [];
  const db = getLocal();
  return db.accounts.filter((a) => a.role === 'player').slice(0, n).map(strip);
}

async function transactions({ cashierId, playerId, limit = 100 } = {}) {
  const n = Math.min(Number(limit) || 100, 500);
  if (useDb()) {
    const parts = ['select=*', 'order=created_at.desc', `limit=${n}`];
    if (cashierId) parts.push(`cashier_id=eq.${sb.enc(cashierId)}`);
    if (playerId) parts.push(`player_id=eq.${sb.enc(playerId)}`);
    try {
      return await sb.select('transaction_log', parts.join('&'));
    } catch (err) {
      throw readFailed('transactions', err);
    }
  }
  if (!localAllowed()) return [];
  const db = getLocal();
  let list = db.transactions;
  if (cashierId) list = list.filter((t) => t.cashier_id === cashierId);
  if (playerId) list = list.filter((t) => t.player_id === playerId);
  return list.slice(-n).reverse();
}

async function anomalies(limit = 50) {
  return [];
}

// ----------------------------------------------- مزامنة رصيد اللعب
//
// فروق اللعب (رهان/ربح) التي لم تمرّ بنداء المحفظة الذرّي تُجمَّع هنا وتُكتب
// إلى الدفتر دفعةً واحدة.
//
// ── ثلاث قواعد لا تُكسر
// 1. الفرق لا يغادر الطابور إلا بعد أن يؤكّد الدفتر كتابته. كان يُحذف قبل
//    النداء، فأي انقطاع عابر يمحو أرباح اللاعبين وخسائرهم من القاعدة للأبد.
// 2. للدفتر مرجع واحد: القاعدة إن كانت مضبوطة، وإلّا الملف المحلّي. لا تُكتب
//    الفروق في الاثنين. محاولةٌ سابقة كانت تطبّقها على الملف عند الفشل ثم
//    تبقيها في الطابور وتعيد كل 5 ثوانٍ — فيُضاف الفرق نفسه مرّة بعد مرّة.
// 3. من يطلب الكتابة وهناك كتابة جارية ينتظرها ولا يتخطّاها. flushPlayer
//    يسبق الإيداع والسحب؛ لو عاد فوراً لحُسبت العملية على رصيد قديم.
//
// ── حدّ معروف
// apply_game_deltas لا ترفض التكرار: لو نفّذتها القاعدة ثم ضاع الردّ، تُعيد
// المحاولةُ تطبيق الدفعة. علاجه في القاعدة نفسها (رقم دفعة يُسجَّل ويُرفض
// تكراره). ضياع الردّ بعد التنفيذ نادر جداً: المهلة 15 ثانية لتحديث يستغرق
// أجزاءً من الثانية.
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

const pending = new Map();        // accountId → صافي فرق لم يؤكّده الدفتر
let flushTimer = null;
let inflight = null;              // الكتابة الجارية
let retryTimer = null;
let retryDelay = RETRY_MIN_MS;

function queueDelta(accountId, delta) {
  const d = Math.round(delta);
  if (!accountId || !d) return;
  const next = (pending.get(accountId) || 0) + d;
  if (next) pending.set(accountId, next); else pending.delete(accountId);
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushDeltas().catch(() => {}); }, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
}

function hasPending(accountId) { return pending.has(accountId); }

/** يكتب الطابور. من يأتي أثناء كتابة جارية ينتظرها بدل أن يتخطّاها. */
function flushDeltas() {
  if (inflight) return inflight;
  if (!pending.size) return Promise.resolve({ applied: 0, pending: 0 });
  inflight = writeBatch().finally(() => { inflight = null; });
  return inflight;
}

async function writeBatch() {
  const batch = [...pending.entries()].map(([id, delta]) => ({ id, delta }));

  if (!sb.configured()) {
    // لا قاعدة: الملف المحلّي هو الدفتر — نطبّق مرّة واحدة ونُفرغ
    const db = getLocal();
    for (const { id, delta } of batch) {
      const acc = db.accounts.find((a) => a.id === id || a.display_id === id);
      if (acc) acc.balance = Math.max(0, Math.round((acc.balance || 0) + delta));
    }
    saveLocal();
    settle(batch);
    return { applied: batch.length, pending: pending.size };
  }

  try {
    await sb.rpc('apply_game_deltas', { p_items: batch });
  } catch (err) {
    console.warn(`[accounts] تعذّرت كتابة ${batch.length} فرق رصيد — تبقى معلّقة وتُعاد المحاولة:`, err.message);
    scheduleRetry();
    return { applied: 0, pending: pending.size, error: err.message };
  }

  settle(batch);
  retryDelay = RETRY_MIN_MS;
  if (pending.size) scheduleRetry();          // فروق وصلت أثناء الكتابة
  return { applied: batch.length, pending: pending.size };
}

/**
 * يطرح ما كُتب ويُبقي ما وصل أثناء الكتابة.
 * الباقي = الصافي الحالي − المكتوب — ويصحّ حتى لو صار الصافي صفراً أثناء
 * الكتابة (رهان ثم ربح بالقيمة نفسها): حينها يبقى عكس المكتوب، وهو فعلاً
 * ما لم يصل الدفتر بعد.
 */
function settle(batch) {
  for (const { id, delta } of batch) {
    const rest = (pending.get(id) || 0) - delta;
    if (rest) pending.set(id, rest); else pending.delete(id);
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  const wait = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => { retryTimer = null; flushDeltas().catch(() => {}); }, wait);
  if (retryTimer.unref) retryTimer.unref();
}

/**
 * يكتب فروق لاعب قبل عملية تعتمد على رصيده في الدفتر.
 * true = الدفتر محدَّث لهذا اللاعب. false = بقيت فروقه معلّقة — لا يجوز
 * إجراء إيداع أو سحب أو رهان خارجي على رصيده الآن.
 */
async function flushPlayer(accountId) {
  if (inflight) await inflight.catch(() => {});
  if (!pending.has(accountId)) return true;
  await flushDeltas().catch(() => {});
  return !pending.has(accountId);
}

async function setCashierCountry(cashierId, country) {
  const c = countries.resolve(country); if (!c.ok) return c;
  if (useDb()) {
    try {
      await sb.update('accounts', `id=eq.${sb.enc(String(cashierId))}`,
        { country: c.country, currency: c.currency }, { returning: false });
      return { ok: true, ...c };
    } catch (err) {
      return { ok: false, error: err.message || DB_DOWN };
    }
  }
  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  const cashier = db.accounts.find((x) => x.id === cashierId);
  if (cashier) {
    cashier.country = c.country;
    cashier.currency = c.currency;
    saveLocal();
  }
  return { ok: true, ...c };
}

/**
 * شرائح العمولة.
 * كانت تُحفظ في الملف المحلّي وحده — وعلى Vercel ذلك /tmp، فتعود الشرائح
 * التي تضبطها الإدارة إلى 5% الافتراضية مع كل تشغيل بارد، وتُحسب عمولات
 * الكاشيرية خطأً بصمت. الآن في site_secrets تحت مفتاح commission_tiers.
 */
const DEFAULT_TIERS = [{ min_burn: 0, rate: 5, label: 'افتراضي' }];
const TIERS_KEY = 'commission_tiers';
let tiersCache = null;           // { tiers, at }
const TIERS_CACHE_MS = 30_000;

async function commissionTiers() {
  if (useDb()) {
    if (tiersCache && Date.now() - tiersCache.at < TIERS_CACHE_MS) return tiersCache.tiers;
    try {
      const row = await sb.selectOne('site_secrets', `select=value&key=eq.${sb.enc(TIERS_KEY)}`);
      let tiers = DEFAULT_TIERS;
      if (row && row.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed) && parsed.length) tiers = parsed;
      }
      tiersCache = { tiers, at: Date.now() };
      return tiers;
    } catch (err) {
      throw readFailed('commissionTiers', err);
    }
  }
  if (!localAllowed()) return DEFAULT_TIERS;
  const db = getLocal();
  return db.tiers || DEFAULT_TIERS;
}

async function setCommissionTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return { ok: false, error: 'لا شرائح' };
  const clean = [];
  for (const t of tiers) {
    const min = Number(t.min_burn);
    const rate = Number(t.rate);
    if (!Number.isInteger(min) || min < 0) return { ok: false, error: 'حدّ الشريحة غير صالح' };
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { ok: false, error: 'النسبة بين 0 و100' };
    clean.push({ min_burn: min, rate, label: t.label || null });
  }
  clean.sort((a, b) => a.min_burn - b.min_burn);
  if (clean[0].min_burn !== 0) return { ok: false, error: 'أول شريحة يجب أن تبدأ من صفر' };

  if (useDb()) {
    try {
      await sb.request('/rest/v1/site_secrets?on_conflict=key', {
        method: 'POST',
        body: [{ key: TIERS_KEY, value: JSON.stringify(clean), updated_at: new Date().toISOString() }],
        prefer: 'resolution=merge-duplicates,return=minimal'
      });
      tiersCache = { tiers: clean, at: Date.now() };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || DB_DOWN };
    }
  }
  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  db.tiers = clean;
  saveLocal();
  return { ok: true };
}


/* ═══════════════════════════════════════════════════════════════════════
   طبقة الماستر

   الصلاحيات مفروضة في قاعدة البيانات (داخل master_adjust_cashier) لا هنا
   فقط: الواجهة والمسار قابلان للتجاوز، ودالة قاعدة البيانات ليست كذلك.
   ما في هذا القسم هو تحقّق مبكّر يعطي رسالة مفهومة قبل الوصول إليها.
   ═══════════════════════════════════════════════════════════════════════ */

async function createMaster({ username, email, password, startingFloat = 0, unlimited = false, country }) {
  let uRaw = String(username || '').trim();
  let emRaw = email ? String(email).trim() : '';
  if (uRaw.includes('@') && !emRaw) {
    emRaw = uRaw;
  }
  const u = checkUsername(uRaw); if (!u.ok) return u;
  const p = checkPassword(password); if (!p.ok) return p;
  const em = emRaw ? checkEmail(emRaw) : { ok: true, value: null };
  if (!em.ok) return em;
  const f = startingFloat ? checkAmount(startingFloat) : { ok: true, value: 0 };
  if (!f.ok) return f;
  const c = countries.resolve(country); if (!c.ok) return c;

  const { hash, salt } = hashPassword(p.value);

  if (useDb()) {
    try {
      const rows = await sb.insert('accounts', {
        role: 'master',
        username: u.value,
        email: em.value || null,
        password_hash: hash,
        password_salt: salt,
        display_id: shortId(),
        balance: 0,
        unlimited_float: !!unlimited,
        country: c.country,
        currency: c.currency
      });
      let row = rows[0];
      // العهدة الأولى تمرّ بمسار الإدارة لا بكتابة مباشرة: كل ليرة لها أثر
      if (f.value > 0) {
        const out = await sb.rpc('admin_adjust_master', {
          p_master: row.id, p_amount: f.value, p_topup: true, p_note: 'عهدة أولى'
        });
        row = { ...row, balance: out.master_balance, float_balance: out.master_balance };
      } else {
        row = { ...row, balance: 0, float_balance: 0 };
      }
      return { ok: true, master: strip(row) };
    } catch (err) {
      if (err.raw && (err.raw.includes('duplicate key') || err.code === '23505')) {
        return { ok: false, error: 'اسم المستخدم محجوز مسبقاً' };
      }
      return { ok: false, error: err.message || 'تعذّر إنشاء الماستر' };
    }
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  const unameKey = u.value.toLowerCase();
  if (db.accounts.some((a) => a.username_key === unameKey)) {
    return { ok: false, error: 'اسم المستخدم محجوز مسبقاً' };
  }
  const master = {
    id: 'mst_' + crypto.randomBytes(8).toString('hex'),
    role: 'master',
    username: u.value,
    username_key: unameKey,
    email: em.value || null,
    email_key: em.value ? em.value.toLowerCase() : null,
    password_hash: hash,
    password_salt: salt,
    display_id: shortId(),
    balance: f.value || 0,
    float_balance: f.value || 0,
    unlimited_float: !!unlimited,
    country: c.country,
    currency: c.currency,
    active: true,
    created_at: new Date().toISOString(),
    last_login_at: null
  };
  db.accounts.push(master);
  saveLocal();
  return { ok: true, master: strip(master) };
}

async function allMasters() {
  if (useDb()) {
    try { return stripAll(await sb.select('master_summary', 'select=*&order=created_at.desc')); }
    catch (err) { throw readFailed('allMasters', err); }
  }
  if (!localAllowed()) return [];
  return getLocal().accounts.filter((a) => a.role === 'master').map(strip);
}

async function masterSelf(masterId) {
  if (useDb()) {
    try { return strip(await sb.selectOne('master_summary', `select=*&id=eq.${sb.enc(masterId)}`)); }
    catch (err) { throw readFailed('masterSelf', err); }
  }
  if (!localAllowed()) return null;
  return strip(getLocal().accounts.find((a) => a.id === masterId) || null);
}

async function masterCashiers(masterId) {
  if (useDb()) {
    try {
      return stripAll(await sb.select('cashier_summary',
        `select=*&master_id=eq.${sb.enc(masterId)}&order=created_at.desc`));
    } catch (err) { throw readFailed('masterCashiers', err); }
  }
  if (!localAllowed()) return [];
  return getLocal().accounts.filter((a) => a.role === 'cashier' && a.master_id === masterId).map(strip);
}

async function masterPlayers(masterId) {
  if (useDb()) {
    try {
      return stripAll(await sb.select('player_summary',
        `select=*&master_id=eq.${sb.enc(masterId)}&order=created_at.desc`));
    } catch (err) { throw readFailed('masterPlayers', err); }
  }
  if (!localAllowed()) return [];
  const db = getLocal();
  const mine = new Set(db.accounts.filter((a) => a.role === 'cashier' && a.master_id === masterId).map((a) => a.id));
  return db.accounts.filter((a) => a.role === 'player' && mine.has(a.cashier_id)).map(strip);
}

/** الإدارة تعبّئ عهدة ماستر أو تسحب منها. */
async function adjustMasterFloat({ masterId, amount, topup, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;
  if (!useDb()) return { ok: false, error: NO_DB };
  try {
    const out = await sb.rpc('admin_adjust_master', {
      p_master: masterId, p_amount: a.value, p_topup: !!topup, p_note: note || null
    });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** الماستر يعبّئ كاشيره من عهدته هو — الملكية تُفحص في قاعدة البيانات. */
async function masterAdjustCashier({ masterId, cashierId, amount, topup, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;
  if (!useDb()) return { ok: false, error: NO_DB };
  try {
    const out = await sb.rpc('master_adjust_cashier', {
      p_master: masterId, p_cashier: cashierId,
      p_amount: a.value, p_topup: !!topup, p_note: note || null
    });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** نقل كاشير إلى ماستر (أو فكّ ارتباطه) — للإدارة وحدها. */
async function setCashierMaster({ cashierId, masterId }) {
  if (!useDb()) return { ok: false, error: NO_DB };
  try {
    if (masterId) {
      const m = await byId(masterId);
      if (!m || m.role !== 'master') return { ok: false, error: 'الماستر غير موجود' };
    }
    await sb.update('accounts', `id=eq.${sb.enc(cashierId)}`,
      { master_id: masterId || null }, { returning: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function chainLedger({ masterId, cashierId, playerId, kinds, limit = 120 } = {}) {
  if (!useDb()) return [];
  const parts = ['select=*', 'order=created_at.desc',
                 `limit=${Math.min(Number(limit) || 120, 500)}`];
  if (masterId) parts.push(`master_id=eq.${sb.enc(masterId)}`);
  if (cashierId) parts.push(`cashier_id=eq.${sb.enc(cashierId)}`);
  if (playerId) parts.push(`player_id=eq.${sb.enc(playerId)}`);
  if (Array.isArray(kinds) && kinds.length) {
    parts.push(`kind=in.(${kinds.map((k) => sb.enc(k)).join(',')})`);
  }
  // سجلّ فارغ عند الخطأ كان يوحي للإدارة بأن لا حركة — والحقيقة أننا لم نقرأ
  try { return await sb.select('chain_ledger', parts.join('&')); }
  catch (err) { throw readFailed('chainLedger', err); }
}

/**
 * تعديل بيانات حساب (الاسم/الإيميل).
 * `ownerId` إن مُرّر وجب أن يكون المالك المباشر — الكاشير للاعبه،
 * والماستر لكاشيره.
 */
async function updateAccount({ accountId, username, email, ownerId, ownerField }) {
  const row = await byId(accountId);
  if (!row) return { ok: false, error: 'الحساب غير موجود' };
  if (ownerId && row[ownerField] !== ownerId) {
    return { ok: false, error: 'هذا الحساب ليس من حساباتك' };
  }

  const patch = {};
  if (username !== undefined && username !== null && String(username).trim() !== row.username) {
    const u = checkUsername(username); if (!u.ok) return u;
    patch.username = u.value;
  }
  if (email !== undefined && email !== null && String(email).trim() !== (row.email || '')) {
    const e = checkEmail(email); if (!e.ok) return e;
    patch.email = e.value;
  }
  if (!Object.keys(patch).length) return { ok: true, unchanged: true };

  if (!useDb()) return { ok: false, error: NO_DB };
  try {
    await sb.update('accounts', `id=eq.${sb.enc(accountId)}`, patch, { returning: false });
    return { ok: true };
  } catch (err) {
    if (err.raw && err.raw.includes('duplicate key')) {
      return { ok: false, error: 'الاسم أو الإيميل مستخدم بالفعل' };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * حذف حساب.
 *
 * ⚠ السجلّ المالي لا يُمحى أبداً. كان الحذف يمسح كل حركات الحساب
 * (transaction_log، transactions، game_rounds، balance_anomalies) ليتخطّى
 * قيود المفتاح الأجنبي — فكان كاشيرٌ يحذف لاعباً رصيده صفر فتختفي من دفتر
 * الإدارة كل إيداعاته وسحوباته له، وكان ماسترٌ يحذف كاشيراً عهدته صفر فيمحو
 * كل ما فعله ذلك الكاشير مع كل لاعبيه. أي أن من هم دون الإدارة كانوا يملكون
 * زرّاً يمحو آثارهم.
 *
 * القاعدة الآن — وهي ما تعد به اللوحات أصلاً: «لا يُحذف إن كان له رصيد أو
 * تابعون أو حركات مالية — أوقفه بدل ذلك». يُحذف فقط حساب لم يُستعمل (أُنشئ
 * بالخطأ مثلاً). ويسري على الإدارة أيضاً: مال اللاعب ودفترها أهمّ من زرّ حذف.
 */
async function deleteAccount({ accountId, ownerId, ownerField }) {
  const row = await byId(accountId);
  if (!row) return { ok: false, error: 'الحساب غير موجود' };
  const id = row.id;
  if (ownerId && row[ownerField] !== ownerId) {
    return { ok: false, error: 'هذا الحساب ليس من حساباتك' };
  }
  if (Number(row.balance) > 0) {
    return {
      ok: false,
      error: row.role === 'player'
        ? `رصيد اللاعب ${row.balance} — اسحبه أولاً، أو أوقف الحساب بدل حذفه`
        : `عهدته ${row.balance} — أعدها أولاً، أو أوقف الحساب بدل حذفه`
    };
  }
  const HISTORY = 'للحساب سجلّ مالي، والسجلّ لا يُمحى — أوقف الحساب بدل حذفه';
  const DEPENDANTS = row.role === 'master'
    ? 'له كاشيرية — انقلهم إلى ماستر آخر أو أوقف الحساب'
    : 'له لاعبون — انقلهم أو أوقف الحساب';

  if (useDb()) {
    const e = sb.enc(id);
    try {
      const deps = await sb.select('accounts', `select=id&or=(cashier_id.eq.${e},master_id.eq.${e})&limit=1`);
      if (deps.length) return { ok: false, error: DEPENDANTS };

      const tx = await sb.select('transaction_log',
        `select=id&or=(player_id.eq.${e},cashier_id.eq.${e},master_id.eq.${e})&limit=1`);
      if (tx.length) return { ok: false, error: HISTORY };
      if (row.role === 'player') {
        const rounds = await sb.select('game_rounds', `select=id&player_id=eq.${e}&limit=1`);
        if (rounds.length) return { ok: false, error: HISTORY };
      }

      // لا رصيد ولا تابعون ولا سجلّ: حساب لم يُستعمل. نفكّ ما يشير إليه دون
      // قيمة مالية (من أنشأه، رموز إقلاع الألعاب) ثم نحذفه.
      await sb.request(`/rest/v1/accounts?created_by=eq.${e}`, { method: 'PATCH', body: { created_by: null } });
      await sb.request(`/rest/v1/game_sessions?player_id=eq.${e}`, { method: 'DELETE' }).catch(() => {});
      await sb.request(`/rest/v1/accounts?id=eq.${e}`, { method: 'DELETE' });
    } catch (err) {
      // قيد مفتاح أجنبي هنا = سجلّ في جدول لم نفحصه — والجواب نفسه: لا يُحذف
      if (err.code === '23503') return { ok: false, error: HISTORY };
      return { ok: false, error: err.message || DB_DOWN };
    }
    console.log(`[accounts] حُذف حساب غير مستعمل: ${row.username} (${id})`);
    return { ok: true, id, username: row.username };
  }

  if (!localAllowed()) return { ok: false, error: NO_DB };
  const db = getLocal();
  if (db.accounts.some((a) => a.cashier_id === id || a.master_id === id)) return { ok: false, error: DEPENDANTS };
  if ((db.transactions || []).some((t) => t.player_id === id || t.cashier_id === id || t.master_id === id)) {
    return { ok: false, error: HISTORY };
  }
  db.accounts = db.accounts.filter((a) => a.id !== id);
  for (const a of db.accounts) if (a.created_by === id) a.created_by = null;
  saveLocal();
  return { ok: true, id, username: row.username };
}

module.exports = {
  EMAIL_DOMAIN, MIN_PASSWORD,
  createMaster, allMasters, masterSelf, masterCashiers, masterPlayers,
  adjustMasterFloat, masterAdjustCashier, setCashierMaster,
  chainLedger, updateAccount, deleteAccount,
  setCashierCountry, commissionTiers, setCommissionTiers,
  hashPassword, verifyPassword, shortId, newToken,
  checkUsername, checkEmail, checkPassword, checkAmount,
  createCashier, createPlayer, strip,
  login, logout, byToken, byId,
  setPlayerPassword, setCashierPassword, setActive,
  deposit, withdraw, adjustCashierFloat,
  cashierPlayers, cashierSelf, allCashiers, allPlayers, transactions, anomalies,
  queueDelta, flushDeltas, flushPlayer, hasPending,
  pendingCount: () => pending.size,
  isUsingSupabase: () => supabaseReady,
  recheckSupabase: checkSupabase
};
