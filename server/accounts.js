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
let supabaseReady = sb.configured();
let pingChecked = false;
let pingPromise = null;

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
  if (pingChecked) return supabaseReady;
  if (!pingPromise) {
    pingPromise = sb.ping().then((res) => {
      pingChecked = true;
      supabaseReady = res.ok;
      if (res.ok) console.log('[accounts] متصل بـ Supabase بنجاح');
      else console.warn('[accounts] تعذّر الاتصال بـ Supabase:', res.error);
      return supabaseReady;
    }).catch((err) => {
      pingChecked = true;
      supabaseReady = false;
      return false;
    });
  }
  return pingPromise;
}

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

  await ensureSupabase();
  if (supabaseReady) {
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

async function createPlayer({ cashierId, username, email, password, createdBy }) {
  const u = checkUsername(username); if (!u.ok) return u;
  const e = checkEmail(email); if (!e.ok) return e;
  const p = checkPassword(password); if (!p.ok) return p;

  const { hash, salt } = hashPassword(p.value);

  await ensureSupabase();
  if (supabaseReady) {
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
        created_by: createdBy || cashierId || null
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
    created_by: createdBy || cashierId || null,
    balance: 0,
    active: true,
    created_at: new Date().toISOString(),
    last_login_at: null
  };

  db.accounts.push(player);
  saveLocal();
  return { ok: true, player: strip(player) };
}

// ------------------------------------------------------------------- تسجيل الدخول
async function login(identifier, password, { expectRole } = {}) {
  const rawId = String(identifier || '').trim();
  const id = rawId.toLowerCase();
  const pwd = String(password || '');
  if (!rawId || !pwd) return { ok: false, error: 'أدخل اسم المستخدم وكلمة المرور' };

  await ensureSupabase();
  if (supabaseReady || sb.configured()) {
    try {
      const q = `or=(username_key.eq.${sb.enc(id)},email_key.eq.${sb.enc(id)},display_id.eq.${sb.enc(rawId)},display_id.eq.${sb.enc(rawId.toUpperCase())},id.eq.${sb.enc(rawId)})`;
      const row = await sb.selectOne('accounts', `select=*&${q}`);
      if (row) {
        const isMatch = verifyPassword(pwd, row.password_hash, row.password_salt) ||
                        verifyPassword(pwd.trim(), row.password_hash, row.password_salt);
        if (!isMatch) {
          return { ok: false, error: 'كلمة المرور غير صحيحة' };
        }
        if (!row.active) {
          return { ok: false, error: 'هذا الحساب موقوف — راجع الإدارة' };
        }
        if (expectRole && row.role !== expectRole) {
          return { ok: false, error: `هذا الحساب ليس حساب ${expectRole === 'cashier' ? 'كاشير' : expectRole === 'master' ? 'ماستر' : 'لاعب'}` };
        }
        const token = newToken();
        await sb.update('accounts', `id=eq.${row.id}`,
          { play_token: token, last_login_at: new Date().toISOString() }, { returning: false });
        return { ok: true, token, account: strip({ ...row, play_token: undefined }) };
      }
      return { ok: false, error: 'اسم المستخدم أو المعرّف غير مسجّل' };
    } catch (err) {
      console.warn('[accounts] خطأ الدخول عبر Supabase:', err.message);
    }
  }

  // المحرك المحلي
  const db = getLocal();
  const row = db.accounts.find((a) =>
    a.username_key === id ||
    a.email_key === id ||
    a.display_id === rawId ||
    a.display_id === rawId.toUpperCase() ||
    a.id === rawId
  );
  if (!row) {
    return { ok: false, error: 'اسم المستخدم أو المعرّف غير مسجّل' };
  }
  const isMatch = verifyPassword(pwd, row.password_hash, row.password_salt) ||
                  verifyPassword(pwd.trim(), row.password_hash, row.password_salt);
  if (!isMatch) {
    return { ok: false, error: 'كلمة المرور غير صحيحة' };
  }
  if (!row.active) return { ok: false, error: 'هذا الحساب موقوف — راجع الإدارة' };
  if (expectRole && row.role !== expectRole) {
    return { ok: false, error: `هذا الحساب ليس حساب ${expectRole === 'cashier' ? 'كاشير' : expectRole === 'master' ? 'ماستر' : 'لاعب'}` };
  }

  const token = newToken();
  row.play_token = token;
  row.last_login_at = new Date().toISOString();
  saveLocal();

  return { ok: true, token, account: strip(row) };
}

async function byToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;

  await ensureSupabase();
  if (supabaseReady) {
    try {
      const row = await sb.selectOne('accounts', `select=*&play_token=eq.${sb.enc(t)}`);
      if (row && row.active) return row;
    } catch { /* تجاهل */ }
  }

  const db = getLocal();
  const row = db.accounts.find((a) => a.play_token === t);
  return row && row.active ? row : null;
}

async function byId(id) {
  if (!id) return null;
  await ensureSupabase();
  if (supabaseReady) {
    try {
      const row = await sb.selectOne('accounts', `select=*&id=eq.${sb.enc(String(id))}`);
      if (row) return row;
    } catch { /* تجاهل */ }
  }
  const db = getLocal();
  return db.accounts.find((a) => a.id === String(id) || a.display_id === String(id)) || null;
}

async function logout(token) {
  const t = String(token || '').trim();
  if (!t) return;
  if (supabaseReady) {
    try { await sb.update('accounts', `play_token=eq.${sb.enc(t)}`, { play_token: null }, { returning: false }); }
    catch { /* تجاهل */ }
  }
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

  if (supabaseReady) {
    try {
      await sb.update('accounts', `id=eq.${row.id}`,
        { password_hash: hash, password_salt: salt, play_token: null }, { returning: false });
      return { ok: true };
    } catch (err) {
      console.warn('[accounts] فشل تحديث كلمة المرور في Supabase:', err.message);
    }
  }

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
  if (supabaseReady) {
    try {
      await sb.update('accounts', `id=eq.${sb.enc(target.id)}`,
        { password_hash: hash, password_salt: salt, play_token: null }, { returning: false });
      return { ok: true };
    } catch (err) { /* fallback */ }
  }
  target.password_hash = hash;
  target.password_salt = salt;
  target.play_token = null;
  saveLocal();
  return { ok: true };
}

async function setActive({ accountId, active, ownerId }) {
  const row = await byId(accountId);
  if (!row) return { ok: false, error: 'الحساب غير موجود' };
  if (ownerId && row.cashier_id !== ownerId) return { ok: false, error: 'هذا الحساب ليس من حساباتك' };

  if (supabaseReady) {
    try {
      const patch = { active: !!active };
      if (!active) patch.play_token = null;
      await sb.update('accounts', `id=eq.${row.id}`, patch, { returning: false });
      return { ok: true };
    } catch (err) {
      console.warn('[accounts] فشل تغيير الحالة في Supabase:', err.message);
    }
  }

  row.active = !!active;
  if (!active) row.play_token = null;
  saveLocal();
  return { ok: true };
}

// ---------------------------------------------------------------- حركة المال
async function deposit({ cashierId, playerId, amount, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;

  await ensureSupabase();
  if (supabaseReady) {
    try {
      const out = await sb.rpc('cashier_deposit', {
        p_cashier: cashierId, p_player: playerId, p_amount: a.value, p_note: note || null
      });
      return { ok: true, ...out };
    } catch (err) {
      console.warn('[accounts] فشل الإيداع عبر Supabase، تجربة المحلي:', err.message);
    }
  }

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

  await ensureSupabase();
  if (supabaseReady) {
    try {
      const out = await sb.rpc('cashier_withdraw', {
        p_cashier: cashierId, p_player: playerId, p_amount: a.value, p_note: note || null
      });
      return { ok: true, ...out };
    } catch (err) {
      console.warn('[accounts] فشل السحب عبر Supabase، تجربة المحلي:', err.message);
    }
  }

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

  await ensureSupabase();
  if (supabaseReady) {
    try {
      const out = await sb.rpc('admin_adjust_cashier', {
        p_cashier: cashierId, p_amount: a.value, p_topup: !!topup, p_note: note || null
      });
      return { ok: true, ...out };
    } catch (err) {
      console.warn('[accounts] فشل تعديل عهدة الكاشير عبر Supabase:', err.message);
    }
  }

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
async function cashierPlayers(cashierId) {
  await ensureSupabase();
  if (supabaseReady) {
    try {
      return await sb.select('player_summary', `select=*&cashier_id=eq.${sb.enc(cashierId)}&order=created_at.desc`);
    } catch { /* تجاهل */ }
  }
  const db = getLocal();
  return db.accounts
    .filter((a) => a.role === 'player' && a.cashier_id === cashierId)
    .map(strip)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function cashierSelf(cashierId) {
  await ensureSupabase();
  let row = null;
  if (supabaseReady) {
    try {
      row = await sb.selectOne('cashier_summary', `select=*&id=eq.${sb.enc(cashierId)}`);
    } catch { /* تجاهل */ }
  }
  if (!row) {
    const db = getLocal();
    const c = db.accounts.find((a) => a.id === cashierId && a.role === 'cashier');
    if (!c) return null;
    const players = db.accounts.filter((a) => a.role === 'player' && a.cashier_id === cashierId);
    row = {
      ...strip(c),
      player_count: players.length,
      active_players: players.filter((p) => p.active).length,
      players_balance: players.reduce((sum, p) => sum + Number(p.balance || 0), 0)
    };
  }
  if (!row) return null;
  const float_balance = Number(row.float_balance != null ? row.float_balance : (row.balance || 0));
  return {
    ...row,
    balance: float_balance,
    float_balance,
    players_balance: Number(row.players_balance || 0)
  };
}

async function allCashiers() {
  await ensureSupabase();
  let list = null;
  if (supabaseReady) {
    try {
      list = await sb.select('cashier_summary', 'select=*&order=created_at.desc');
    } catch { /* تجاهل */ }
  }
  if (!list || !Array.isArray(list)) {
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

async function allPlayers({ limit = 200 } = {}) {
  await ensureSupabase();
  if (supabaseReady) {
    try {
      return await sb.select('player_summary', `select=*&order=created_at.desc&limit=${Number(limit) || 200}`);
    } catch { /* تجاهل */ }
  }
  const db = getLocal();
  return db.accounts
    .filter((a) => a.role === 'player')
    .slice(0, Number(limit) || 200)
    .map(strip);
}

async function transactions({ cashierId, playerId, limit = 100 } = {}) {
  await ensureSupabase();
  if (supabaseReady) {
    try {
      const parts = ['select=*', 'order=created_at.desc', `limit=${Math.min(Number(limit) || 100, 500)}`];
      if (cashierId) parts.push(`cashier_id=eq.${sb.enc(cashierId)}`);
      if (playerId) parts.push(`player_id=eq.${sb.enc(playerId)}`);
      return await sb.select('transaction_log', parts.join('&'));
    } catch { /* تجاهل */ }
  }
  const db = getLocal();
  let list = db.transactions;
  if (cashierId) list = list.filter((t) => t.cashier_id === cashierId);
  if (playerId) list = list.filter((t) => t.player_id === playerId);
  return list.slice(-Math.min(Number(limit) || 100, 500)).reverse();
}

async function anomalies(limit = 50) {
  return [];
}

// ----------------------------------------------- مزامنة رصيد اللعب
const pending = new Map();
let flushing = false;
let flushTimer = null;

function queueDelta(accountId, delta) {
  if (!accountId || !delta) return;
  pending.set(accountId, (pending.get(accountId) || 0) + Math.round(delta));
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushDeltas(); }, FLUSH_MS);
}

function hasPending(accountId) { return pending.has(accountId); }

async function flushDeltas() {
  if (flushing || !pending.size) return { applied: 0 };
  flushing = true;

  const batch = [...pending.entries()].map(([id, delta]) => ({ id, delta }));
  pending.clear();

  if (supabaseReady) {
    try {
      const out = await sb.rpc('apply_game_deltas', { p_items: batch });
      return { applied: batch.length };
    } catch (err) {
      console.warn('[accounts] تعذّر دفع الفروق إلى Supabase، تطبيق محلي:', err.message);
    }
  }

  // تطبيق محلي
  const db = getLocal();
  for (const item of batch) {
    const acc = db.accounts.find((a) => a.id === item.id || a.display_id === item.id);
    if (acc) {
      acc.balance = Math.max(0, Math.round((acc.balance || 0) + item.delta));
    }
  }
  saveLocal();
  flushing = false;
  return { applied: batch.length };
}

async function flushPlayer(accountId) {
  if (!pending.has(accountId)) return;
  await flushDeltas();
}

async function setCashierCountry(cashierId, country) {
  const c = countries.resolve(country); if (!c.ok) return c;
  await ensureSupabase();
  if (supabaseReady) {
    try {
      await sb.update('accounts', `id=eq.${sb.enc(String(cashierId))}`,
        { country: c.country, currency: c.currency }, { returning: false });
      return { ok: true, ...c };
    } catch (err) { /* تجاهل */ }
  }
  const db = getLocal();
  const cashier = db.accounts.find((x) => x.id === cashierId);
  if (cashier) {
    cashier.country = c.country;
    cashier.currency = c.currency;
    saveLocal();
  }
  return { ok: true, ...c };
}

async function commissionTiers() {
  const db = getLocal();
  return db.tiers || [];
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

  await ensureSupabase();
  if (supabaseReady) {
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

/** كل الماسترية بملخّصاتهم — للإدارة. */
async function allMasters() {
  await ensureSupabase();
  if (supabaseReady) {
    try { return await sb.select('master_summary', 'select=*&order=created_at.desc'); }
    catch (err) { console.warn('[accounts] master_summary:', err.message); }
  }
  return getLocal().accounts.filter((a) => a.role === 'master').map(strip);
}

async function masterSelf(masterId) {
  await ensureSupabase();
  if (supabaseReady) {
    try { return await sb.selectOne('master_summary', `select=*&id=eq.${sb.enc(masterId)}`); }
    catch (err) { console.warn('[accounts] masterSelf:', err.message); }
  }
  return strip(getLocal().accounts.find((a) => a.id === masterId) || null);
}

/** كاشيرية ماستر بعينه. */
async function masterCashiers(masterId) {
  await ensureSupabase();
  if (supabaseReady) {
    try {
      return await sb.select('cashier_summary',
        `select=*&master_id=eq.${sb.enc(masterId)}&order=created_at.desc`);
    } catch (err) { console.warn('[accounts] masterCashiers:', err.message); }
  }
  return getLocal().accounts.filter((a) => a.role === 'cashier' && a.master_id === masterId).map(strip);
}

/** لاعبو كاشيرية ماستر بعينه — يراهم ولا يتصرّف بهم. */
async function masterPlayers(masterId) {
  await ensureSupabase();
  if (supabaseReady) {
    try {
      return await sb.select('player_summary',
        `select=*&master_id=eq.${sb.enc(masterId)}&order=created_at.desc`);
    } catch (err) { console.warn('[accounts] masterPlayers:', err.message); }
  }
  const db = getLocal();
  const mine = new Set(db.accounts.filter((a) => a.role === 'cashier' && a.master_id === masterId).map((a) => a.id));
  return db.accounts.filter((a) => a.role === 'player' && mine.has(a.cashier_id)).map(strip);
}

/** الإدارة تعبّئ عهدة ماستر أو تسحب منها. */
async function adjustMasterFloat({ masterId, amount, topup, note }) {
  const a = checkAmount(amount); if (!a.ok) return a;
  await ensureSupabase();
  if (!supabaseReady) return { ok: false, error: 'قاعدة البيانات غير متاحة الآن' };
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
  await ensureSupabase();
  if (!supabaseReady) return { ok: false, error: 'قاعدة البيانات غير متاحة الآن' };
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
  await ensureSupabase();
  if (!supabaseReady) return { ok: false, error: 'قاعدة البيانات غير متاحة الآن' };
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

/**
 * كشف السلسلة: كل حركة مع أطرافها واتجاهها.
 * `masterId` يضيّقه إلى ماستر وكاشيريته، و`cashierId` إلى كاشير واحد.
 */
async function chainLedger({ masterId, cashierId, playerId, kinds, limit = 120 } = {}) {
  await ensureSupabase();
  if (!supabaseReady) return [];
  const parts = ['select=*', 'order=created_at.desc',
                 `limit=${Math.min(Number(limit) || 120, 500)}`];
  if (masterId) parts.push(`master_id=eq.${sb.enc(masterId)}`);
  if (cashierId) parts.push(`cashier_id=eq.${sb.enc(cashierId)}`);
  if (playerId) parts.push(`player_id=eq.${sb.enc(playerId)}`);
  if (Array.isArray(kinds) && kinds.length) {
    parts.push(`kind=in.(${kinds.map((k) => sb.enc(k)).join(',')})`);
  }
  try { return await sb.select('chain_ledger', parts.join('&')); }
  catch (err) { console.warn('[accounts] chainLedger:', err.message); return []; }
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

  await ensureSupabase();
  if (!supabaseReady) return { ok: false, error: 'قاعدة البيانات غير متاحة الآن' };
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
 * ⚠ الحذف ممنوع على أي حساب له حركات مالية أو رصيد أو تابعون. سجلّ المال
 * يجب أن يبقى متّصلاً — محو حساب وسط السلسلة يترك حركات بلا طرف ويُفسد كل
 * تقرير لاحق. البديل الصحيح هو إيقاف التنشيط، وهو يمنع الدخول ويُبقي الأثر.
 */
async function deleteAccount({ accountId, ownerId, ownerField, force = false }) {
  const row = await byId(accountId);
  if (!row) return { ok: false, error: 'الحساب غير موجود' };
  const targetId = row.id;
  if (ownerId && row[ownerField] !== ownerId) {
    return { ok: false, error: 'هذا الحساب ليس من حساباتك' };
  }
  if (!force && row.balance > 0) {
    return { ok: false, error: `لا يمكن الحذف ورصيده ${row.balance} — اسحبه أولاً` };
  }

  await ensureSupabase();
  if (supabaseReady) {
    try {
      // 1. فك ارتباط الحسابات التابعة (سواء للاعبين أو كاشيرية)
      await sb.request(`/rest/v1/accounts?cashier_id=eq.${sb.enc(targetId)}`, {
        method: 'PATCH',
        body: { cashier_id: null }
      }).catch(() => {});

      await sb.request(`/rest/v1/accounts?master_id=eq.${sb.enc(targetId)}`, {
        method: 'PATCH',
        body: { master_id: null }
      }).catch(() => {});

      await sb.request(`/rest/v1/accounts?created_by=eq.${sb.enc(targetId)}`, {
        method: 'PATCH',
        body: { created_by: null }
      }).catch(() => {});

      // 2. مسح السجلات المرتبطة لتجنب قيود المفتاح الخارجي في PostgreSQL
      await sb.request(`/rest/v1/transaction_log?cashier_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      await sb.request(`/rest/v1/transaction_log?player_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      await sb.request(`/rest/v1/transactions?cashier_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      await sb.request(`/rest/v1/transactions?player_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      await sb.request(`/rest/v1/game_rounds?player_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      await sb.request(`/rest/v1/game_sessions?player_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      await sb.request(`/rest/v1/balance_anomalies?account_id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      }).catch(() => {});

      // 3. حذف الحساب نهائياً من جدول accounts في قاعدة البيانات
      await sb.request(`/rest/v1/accounts?id=eq.${sb.enc(targetId)}`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.error('[accounts] خطأ أثناء حذف الحساب من Supabase:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // حذف الحساب من التخزين المحلي إن وجد
  if (localDb && localDb.accounts) {
    localDb.accounts = localDb.accounts.filter((a) => a.id !== targetId && a.id !== accountId);
    for (const a of localDb.accounts) {
      if (a.cashier_id === targetId || a.cashier_id === accountId) a.cashier_id = null;
      if (a.master_id === targetId || a.master_id === accountId) a.master_id = null;
      if (a.created_by === targetId || a.created_by === accountId) a.created_by = null;
    }
    if (localDb.transactions) {
      localDb.transactions = localDb.transactions.filter((tx) => tx.cashier_id !== targetId && tx.player_id !== targetId);
    }
    saveLocal();
  }

  console.log(`[accounts] تم حذف الحساب ${row.username} (${targetId}) نهائياً`);
  return { ok: true, id: targetId, username: row.username };
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
