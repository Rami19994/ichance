'use strict';

const crypto = require('crypto');
const sb = require('./supabase');

/**
 * سجلّ الألعاب الخارجية + المحفظة المتصلة.
 *
 * الفكرة: اللعبة تُبنى وتُستضاف خارج هذا الموقع، وتُسجَّل هنا بمعلوماتها
 * ورابطها ومفتاح توقيعها. عند اللعب تنادي اللعبةُ الخادمَ فيُخصم الرهان
 * ويُضاف الربح من محفظة اللاعب داخل الموقع. لا كود لعبة داخل المشروع.
 *
 * ── الأمن
 * كل نداء من اللعبة موقّع بـHMAC-SHA256 على **نصّ الجسم كما وصل**، لا على
 * كائن مُعاد تركيبه: إعادة الترتيب أو المسافات تغيّر التوقيع، والتحقّق على
 * نصّ مختلف عمّا وُقِّع عليه ثغرة صامتة.
 *
 * ── الوقت
 * كل نداء يحمل طابعاً زمنياً، ويُرفض ما مضى عليه أكثر من خمس دقائق. بدونه
 * يستطيع من التقط نداءً صحيحاً أن يعيد إرساله إلى الأبد.
 */

const SIGNATURE_WINDOW_MS = 5 * 60_000;
const LAUNCH_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------- أدوات
function newSecret() { return 'gsk_' + crypto.randomBytes(24).toString('base64url'); }
function newLaunchToken() { return crypto.randomBytes(24).toString('base64url'); }

function checkSlug(slug) {
  const v = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(v)) {
    return { ok: false, error: 'المعرّف: حروف إنجليزية صغيرة وأرقام وشرطات، يبدأ بحرف أو رقم' };
  }
  return { ok: true, value: v };
}

function checkUrl(url) {
  const v = String(url || '').trim();
  if (!/^https?:\/\/.+/i.test(v)) return { ok: false, error: 'رابط اللعبة يجب أن يبدأ بـ http أو https' };
  if (v.length > 500) return { ok: false, error: 'الرابط طويل جداً' };
  return { ok: true, value: v };
}

/** ما يُسمح بخروجه إلى المتصفح — بلا مفتاح التوقيع إطلاقاً. */
function publicGame(row) {
  if (!row) return null;
  const { api_secret, ...safe } = row;
  return safe;
}

// ------------------------------------------------------------ التسجيل
async function listGames({ onlyEnabled = false } = {}) {
  const q = ['select=*', 'order=sort_order.asc,created_at.desc'];
  if (onlyEnabled) q.push('enabled=is.true');
  try { return await sb.select('games', q.join('&')); }
  catch (err) { console.warn('[games] تعذّر الجلب:', err.message); return []; }
}

async function getBySlug(slug) {
  try { return await sb.selectOne('games', `select=*&slug=eq.${sb.enc(String(slug))}`); }
  catch { return null; }
}

async function getById(id) {
  try { return await sb.selectOne('games', `select=*&id=eq.${sb.enc(String(id))}`); }
  catch { return null; }
}

async function createGame({ slug, name, category, launchUrl, coverUrl, accent, config, sortOrder }) {
  const s = checkSlug(slug); if (!s.ok) return s;
  const u = checkUrl(launchUrl); if (!u.ok) return u;
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 60) return { ok: false, error: 'اسم اللعبة بين حرفين و60' };

  let cfg = {};
  if (config) {
    if (typeof config === 'string') {
      try { cfg = JSON.parse(config); } catch { return { ok: false, error: 'التبعيات ليست JSON صالحاً' }; }
    } else if (typeof config === 'object') cfg = config;
    if (Array.isArray(cfg) || cfg === null) return { ok: false, error: 'التبعيات يجب أن تكون كائن JSON' };
  }

  const secret = newSecret();
  try {
    const rows = await sb.insert('games', {
      slug: s.value,
      name: n,
      category: String(category || 'fast').trim() || 'fast',
      launch_url: u.value,
      cover_url: coverUrl ? String(coverUrl).trim() : null,
      accent: accent ? String(accent).trim() : null,
      api_secret: secret,
      config: cfg,
      sort_order: Number(sortOrder) || 0
    });
    // المفتاح يُعرض مرة واحدة هنا فقط — بعدها لا يُخرَج من الخادم
    return { ok: true, game: publicGame(rows[0]), secret };
  } catch (err) {
    if (err.raw && err.raw.includes('duplicate key')) {
      return { ok: false, error: 'هذا المعرّف مستخدم بالفعل' };
    }
    if (err.raw && err.raw.includes('slug_shape')) {
      return { ok: false, error: 'صيغة المعرّف غير صالحة' };
    }
    return { ok: false, error: err.message };
  }
}

async function updateGame(id, patch) {
  const body = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (n.length < 2) return { ok: false, error: 'الاسم قصير' };
    body.name = n;
  }
  if (patch.launchUrl !== undefined) {
    const u = checkUrl(patch.launchUrl); if (!u.ok) return u;
    body.launch_url = u.value;
  }
  if (patch.category !== undefined) body.category = String(patch.category).trim() || 'fast';
  if (patch.coverUrl !== undefined) body.cover_url = patch.coverUrl ? String(patch.coverUrl).trim() : null;
  if (patch.accent !== undefined) body.accent = patch.accent || null;
  if (patch.enabled !== undefined) body.enabled = !!patch.enabled;
  if (patch.sortOrder !== undefined) body.sort_order = Number(patch.sortOrder) || 0;
  if (patch.config !== undefined) {
    let cfg = patch.config;
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch { return { ok: false, error: 'التبعيات ليست JSON صالحاً' }; }
    }
    if (Array.isArray(cfg) || typeof cfg !== 'object' || cfg === null) {
      return { ok: false, error: 'التبعيات يجب أن تكون كائن JSON' };
    }
    body.config = cfg;
  }
  if (!Object.keys(body).length) return { ok: true, unchanged: true };

  try {
    await sb.update('games', `id=eq.${sb.enc(id)}`, body, { returning: false });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** يبدّل مفتاح التوقيع — يُبطل كل نداء موقّع بالقديم فوراً. */
async function rotateSecret(id) {
  const secret = newSecret();
  try {
    await sb.update('games', `id=eq.${sb.enc(id)}`, { api_secret: secret }, { returning: false });
    return { ok: true, secret };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function deleteGame(id) {
  try {
    const played = await sb.select('game_rounds', `select=id&game_id=eq.${sb.enc(id)}&limit=1`);
    if (played.length) {
      return { ok: false, error: 'لهذه اللعبة حركات لعب مسجّلة — أوقفها بدل حذفها كي يبقى السجلّ متّصلاً' };
    }
    await sb.request(`/rest/v1/games?id=eq.${sb.enc(id)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ------------------------------------------------------------- الإقلاع
/**
 * ينشئ رمز إقلاع قصير العمر ويبني رابط اللعبة.
 * لا نمرّر رمز جلسة اللاعب إلى اللعبة: ذاك يفتح كل شيء، وهذا لا يصلح
 * إلا لنداءات المحفظة لهذه اللعبة وحدها ولعشر دقائق.
 */
async function createLaunch(game, { accountId, displayId }) {
  // ⚠ معرّفان مختلفان للاعب الواحد: معرّف الحساب (ply_…) هو المفتاح في
  // قاعدة البيانات، والمعرّف الظاهر (6 خانات) هو ما يراه الناس. خلطهما
  // يخالف المفتاح الأجنبي بصمت — نأخذهما منفصلين فلا يلتبسان.
  if (!accountId) return { ok: false, error: 'معرّف حساب اللاعب مفقود' };

  const token = newLaunchToken();
  const expires = new Date(Date.now() + LAUNCH_TTL_MS).toISOString();
  try {
    await sb.insert('game_sessions', {
      token, game_id: game.id, player_id: accountId, expires_at: expires
    }, { returning: false });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const sep = game.launch_url.includes('?') ? '&' : '?';
  const url = `${game.launch_url}${sep}token=${encodeURIComponent(token)}`
            + `&game=${encodeURIComponent(game.id)}`
            + `&player=${encodeURIComponent(displayId || '')}`;
  return { ok: true, token, url, expiresAt: expires };
}

/** يحوّل رمز الإقلاع إلى لاعب — تستعمله اللعبة في أول نداء. */
async function resolveLaunch(token, gameId) {
  if (!token) return null;
  try {
    const row = await sb.selectOne('game_sessions',
      `select=*&token=eq.${sb.enc(String(token))}`);
    if (!row) return null;
    if (gameId && row.game_id !== gameId) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  } catch { return null; }
}

async function sweepLaunches() {
  try {
    await sb.request(`/rest/v1/game_sessions?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      { method: 'DELETE' });
  } catch { /* التنظيف ليس حرجاً */ }
}

// ------------------------------------------------------------- التوقيع
/**
 * يتحقّق من توقيع نداء المحفظة.
 * `rawBody` نصّ الجسم كما وصل حرفياً — التحقّق على كائن مُعاد تركيبه
 * يقبل أجساماً لم تُوقَّع فعلاً.
 */
function verifySignature(game, rawBody, signature, timestamp) {
  if (!game || !game.api_secret) return { ok: false, error: 'لعبة غير معروفة' };
  if (!signature) return { ok: false, error: 'التوقيع مفقود' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, error: 'الطابع الزمني مفقود' };
  if (Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) {
    return { ok: false, error: 'الطابع الزمني خارج النافذة المسموحة' };
  }

  const expected = crypto.createHmac('sha256', game.api_secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, error: 'توقيع غير صالح' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, error: 'توقيع غير صالح' };
  return { ok: true };
}

// -------------------------------------------------------- نداءات المحفظة
async function walletBalance(game, playerId) {
  try {
    const out = await sb.rpc('gw_balance', { p_game: game.id, p_player: playerId });
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function walletDebit(game, playerId, { amount, txRef, roundRef }) {
  try {
    const out = await sb.rpc('gw_debit', {
      p_game: game.id, p_player: playerId,
      p_amount: Math.round(Number(amount)), p_tx_ref: String(txRef || ''),
      p_round_ref: roundRef ? String(roundRef) : null
    });
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function walletCredit(game, playerId, { amount, txRef, roundRef }) {
  try {
    const out = await sb.rpc('gw_credit', {
      p_game: game.id, p_player: playerId,
      p_amount: Math.round(Number(amount)), p_tx_ref: String(txRef || ''),
      p_round_ref: roundRef ? String(roundRef) : null
    });
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function walletRollback(game, { targetRef, txRef }) {
  try {
    const out = await sb.rpc('gw_rollback', {
      p_game: game.id, p_target_ref: String(targetRef || ''), p_tx_ref: String(txRef || '')
    });
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** آخر حركات اللعب — للوحة الإدارة. */
async function recentRounds({ gameId, playerId, limit = 100 } = {}) {
  const parts = ['select=*', 'order=created_at.desc', `limit=${Math.min(Number(limit) || 100, 500)}`];
  if (gameId) parts.push(`game_id=eq.${sb.enc(gameId)}`);
  if (playerId) parts.push(`player_id=eq.${sb.enc(playerId)}`);
  try { return await sb.select('game_rounds', parts.join('&')); }
  catch { return []; }
}

const sweeper = setInterval(sweepLaunches, 10 * 60_000);
if (sweeper.unref) sweeper.unref();

module.exports = {
  SIGNATURE_WINDOW_MS, LAUNCH_TTL_MS,
  listGames, getBySlug, getById, createGame, updateGame, rotateSecret, deleteGame,
  createLaunch, resolveLaunch, verifySignature, publicGame,
  walletBalance, walletDebit, walletCredit, walletRollback, recentRounds
};
