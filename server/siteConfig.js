'use strict';

const fs = require('fs');
const path = require('path');
const { SERVER } = require('./config');
const sb = require('./supabase');

/**
 * إعدادات الموقع التي يملكها المالك:
 * - تشغيل/إيقاف كل لعبة (enabled).
 * - نسبة العائد للاعب (RTP) لكل لعبة محسوبة ومطبقة بقاعدة البيانات وفي المحركات.
 * - دومين الإدارة المخصص (adminDomain) لعزل لوحة الإدارة عن دومين اللاعبين.
 *
 * تُحفظ في Supabase بجدول site_secrets تحت مفتاح site_config، مع ملف data/site.json
 * كبديل محلي عند غياب الربط مع القاعدة.
 */

const DATA_DIR = path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const FILE = path.join(DATA_DIR, 'site.json');
const DB_KEY = 'site_config';
const REFRESH_MS = 8000;

const GAMES = {
  cards: {
    key: 'cards',
    name: 'كروت الحظ',
    href: '/lucky-cards',
    category: 'fast',
    categoryName: 'سريعة',
    defaultRtp: 96.0,
    emoji: '🎴'
  },
  slots: {
    key: 'slots',
    name: 'صيّاد الجوائز',
    href: '/bounty-hunter',
    category: 'slots',
    categoryName: 'سلوتس',
    defaultRtp: 96.2,
    emoji: '🤠'
  },
  tank: {
    key: 'tank',
    name: 'معركة الدبابات',
    href: '/battle-tanks',
    category: 'skill',
    categoryName: 'مهارة',
    defaultRtp: 80.0,
    emoji: '🛡️'
  },
  'neon-slots': {
    key: 'neon-slots',
    name: 'نيون فيغاس',
    href: '/neon-slots',
    category: 'slots',
    categoryName: 'سلوتس',
    defaultRtp: 96.01,
    emoji: '🎰'
  },
  mines: {
    key: 'mines',
    name: 'مناجم الحظ',
    href: '/mines',
    category: 'fast',
    categoryName: 'سريعة',
    defaultRtp: 97.0,
    emoji: '💣'
  },
  plinko: {
    key: 'plinko',
    name: 'بلينكو',
    href: '/plinko',
    category: 'fast',
    categoryName: 'سريعة',
    defaultRtp: 96.28,
    emoji: '🔻'
  },
  bullseye: {
    key: 'bullseye',
    name: 'بولزآي X',
    href: '/bullseye',
    category: 'fast',
    categoryName: 'سريعة',
    defaultRtp: 96.0,
    emoji: '🎯'
  },
  chicken: {
    key: 'chicken',
    name: 'طريق الدجاجة',
    href: '/chicken-road',
    category: 'fast',
    categoryName: 'سريعة',
    defaultRtp: 96.0,
    emoji: '🐔'
  },
  'buffalo-ways': {
    key: 'buffalo-ways',
    name: 'بافالو وايز 3600',
    href: '/buffalo-ways',
    category: 'slots',
    categoryName: 'سلوتس',
    defaultRtp: 96.0,
    emoji: '🦬'
  }
};

const DEFAULT_GAMES = Object.fromEntries(Object.keys(GAMES).map((k) => [k, true]));
const DEFAULT_RTP = Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [k, g.defaultRtp]));

let state = null;
let refreshedAt = 0;
let refreshing = null;

function clampRtp(val, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 50 || n > 99.9) return fallback;
  return Math.round(n * 100) / 100;
}

/** يدمج إعدادات محفوظة (من ملف أو قاعدة) فوق الافتراضي */
function normalize(raw) {
  const games = { ...DEFAULT_GAMES };
  const gameRtp = { ...DEFAULT_RTP };

  if (raw) {
    if (raw.games && typeof raw.games === 'object') {
      for (const k of Object.keys(DEFAULT_GAMES)) {
        const item = raw.games[k];
        if (typeof item === 'boolean') {
          games[k] = item;
        } else if (item && typeof item === 'object') {
          if (typeof item.enabled === 'boolean') games[k] = item.enabled;
          if (item.rtp != null) gameRtp[k] = clampRtp(item.rtp, DEFAULT_RTP[k]);
        }
      }
    }

    if (raw.gameRtp && typeof raw.gameRtp === 'object') {
      for (const k of Object.keys(DEFAULT_RTP)) {
        if (raw.gameRtp[k] != null) {
          gameRtp[k] = clampRtp(raw.gameRtp[k], DEFAULT_RTP[k]);
        }
      }
    }
  }

  const adminDomain = (raw && typeof raw.adminDomain === 'string' && raw.adminDomain.trim())
    ? raw.adminDomain.trim().toLowerCase()
    : (process.env.ICHANCE_ADMIN_DOMAIN || null);

  return { games, gameRtp, adminDomain };
}

function loadFile() {
  try {
    if (fs.existsSync(FILE)) return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (err) {
    console.error('[site] إعدادات الموقع تالفة، نعود للافتراضي:', err.message);
  }
  return normalize(null);
}

function get() {
  if (!state) state = sb.configured() ? normalize(null) : loadFile();
  return state;
}

/**
 * يعيد قراءة الإعدادات من القاعدة إن مرّت REFRESH_MS. فشل القراءة لا يُسقط
 * الطلب: تبقى آخر قيمة معروفة. طلبات متزامنة تنتظر قراءة واحدة.
 */
async function refresh({ force = false } = {}) {
  if (!sb.configured()) { get(); return; }
  if (!force && state && Date.now() - refreshedAt < REFRESH_MS) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const row = await sb.selectOne('site_secrets', `select=value&key=eq.${sb.enc(DB_KEY)}`);
      state = normalize(row && row.value ? JSON.parse(row.value) : null);
      refreshedAt = Date.now();
    } catch (err) {
      get();
      console.error('[site] تعذّرت قراءة إعدادات الموقع من القاعدة:', err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function save() {
  if (sb.configured()) {
    try {
      await sb.request('/rest/v1/site_secrets?on_conflict=key', {
        method: 'POST',
        body: [{ key: DB_KEY, value: JSON.stringify(state), updated_at: new Date().toISOString() }],
        prefer: 'resolution=merge-duplicates,return=minimal'
      });
      refreshedAt = Date.now();
      return true;
    } catch (err) {
      console.error('[site] تعذّر حفظ الإعدادات في القاعدة:', err.message);
      return false;
    }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[site] تعذّر حفظ الإعدادات:', err.message);
    return false;
  }
}

function gameEnabled(key) {
  return get().games[key] !== false;
}

function getGameRtp(key, fallback) {
  const current = get().gameRtp;
  if (current && current[key] != null) return current[key];
  if (fallback != null) return fallback;
  return (GAMES[key] && GAMES[key].defaultRtp) || 96.0;
}

function getGameRtpScale(key, baseRtp) {
  const rtp = getGameRtp(key, baseRtp);
  return baseRtp > 0 ? rtp / baseRtp : 1.0;
}

/**
 * تحديث حالة اللعبة و/أو نسبة العائد (RTP)
 * يقبل:
 *   setGame(key, enabled)
 *   setGame(key, enabled, rtp)
 *   setGame(key, { enabled, rtp })
 */
async function setGame(key, enabledOrPatch, maybeRtp) {
  if (!GAMES[key]) return { ok: false, error: 'لعبة غير معروفة' };
  await refresh({ force: true });

  const prevEnabled = get().games[key];
  const prevRtp = get().gameRtp[key];

  let nextEnabled = prevEnabled;
  let nextRtp = prevRtp;

  if (typeof enabledOrPatch === 'object' && enabledOrPatch !== null) {
    if (enabledOrPatch.enabled !== undefined) nextEnabled = !!enabledOrPatch.enabled;
    if (enabledOrPatch.rtp !== undefined) {
      const parsed = Number(enabledOrPatch.rtp);
      if (!Number.isFinite(parsed) || parsed < 50 || parsed > 99.9) {
        return { ok: false, error: 'نسبة العائد (RTP) يجب أن تكون رقماً بين 50% و 99.9%' };
      }
      nextRtp = Math.round(parsed * 100) / 100;
    }
  } else {
    if (enabledOrPatch !== undefined) nextEnabled = !!enabledOrPatch;
    if (maybeRtp !== undefined) {
      const parsed = Number(maybeRtp);
      if (!Number.isFinite(parsed) || parsed < 50 || parsed > 99.9) {
        return { ok: false, error: 'نسبة العائد (RTP) يجب أن تكون رقماً بين 50% و 99.9%' };
      }
      nextRtp = Math.round(parsed * 100) / 100;
    }
  }

  state.games[key] = nextEnabled;
  state.gameRtp[key] = nextRtp;

  if (!(await save())) {
    state.games[key] = prevEnabled;
    state.gameRtp[key] = prevRtp;
    return { ok: false, error: 'تعذّر حفظ الإعداد' };
  }

  console.log(`[site] ${GAMES[key].name}: ${nextEnabled ? 'تشغيل' : 'إيقاف'} · RTP = ${nextRtp}%`);
  return { ok: true, games: { ...state.games }, gameRtp: { ...state.gameRtp } };
}

function getAdminDomain() {
  return get().adminDomain || null;
}

async function setAdminDomain(domain) {
  const clean = domain ? String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
  await refresh({ force: true });
  const prev = get().adminDomain;
  state.adminDomain = clean || null;
  if (!(await save())) {
    state.adminDomain = prev;
    return { ok: false, error: 'تعذّر حفظ دومين الإدارة' };
  }
  console.log(`[site] دومين الإدارة: ${clean || 'غير محدد (يعمل بالرابط السري)'}`);
  return { ok: true, adminDomain: state.adminDomain };
}

function report() {
  const g = get().games;
  const rtp = get().gameRtp;
  return Object.values(GAMES).map((meta) => ({
    ...meta,
    enabled: g[meta.key] !== false,
    rtp: rtp[meta.key] != null ? rtp[meta.key] : meta.defaultRtp
  }));
}

function publicGames() {
  return { ...get().games };
}

module.exports = {
  GAMES, gameEnabled, isGameEnabled: gameEnabled, getGameRtp, getGameRtpScale, setGame, report, publicGames, refresh,
  getAdminDomain, setAdminDomain, FILE
};
