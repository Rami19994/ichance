'use strict';

const fs = require('fs');
const path = require('path');
const { SERVER } = require('./config');
const sb = require('./supabase');

/**
 * إعدادات الموقع التي يملكها المالك:
 * - أي لعبة تعمل وأيها موقوفة.
 * - دومين الإدارة المخصص (adminDomain) لعزل لوحة الإدارة عن دومين اللاعبين.
 *
 * كانت تُحفظ في data/site.json وحده. على Vercel ذلك المجلّد للقراءة فقط،
 * فكان «أوقفها» في الإدارة يفشل أو يثبت على نسخة خادم واحدة ثم يضيع مع
 * أول تشغيل بارد — واللعبة الموقوفة تعود للعمل. الآن حين تكون قاعدة البيانات
 * مربوطة تُحفظ في site_secrets تحت مفتاح site_config (كشرائح العمولة)، وكل
 * نسخة تعيد قراءتها كل بضع ثوانٍ. الملف المحلّي للتطوير بلا قاعدة فقط.
 */

const DATA_DIR = path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const FILE = path.join(DATA_DIR, 'site.json');
const DB_KEY = 'site_config';
const REFRESH_MS = 8000;

const GAMES = {
  cards: { key: 'cards', name: 'كروت الحظ', href: '/lucky-cards' },
  slots: { key: 'slots', name: 'صيّاد الجوائز', href: '/bounty-hunter' },
  tank:  { key: 'tank',  name: 'معركة الدبابات', href: '/battle-tanks' },
  'neon-slots': { key: 'neon-slots', name: 'نيون فيغاس', href: '/neon-slots' },
  mines: { key: 'mines', name: 'مناجم الحظ', href: '/mines' },
  plinko: { key: 'plinko', name: 'بلينكو', href: '/plinko' },
  bullseye: { key: 'bullseye', name: 'بولزآي X', href: '/bullseye' },
  chicken: { key: 'chicken', name: 'طريق الدجاجة', href: '/chicken-road' }
};

const DEFAULT_GAMES = Object.fromEntries(Object.keys(GAMES).map((k) => [k, true]));

let state = null;
let refreshedAt = 0;
let refreshing = null;

/** يدمج إعدادات محفوظة (من ملف أو قاعدة) فوق الافتراضي — المفاتيح المجهولة تُهمل. */
function normalize(raw) {
  const games = { ...DEFAULT_GAMES };
  if (raw && raw.games) {
    for (const k of Object.keys(games)) {
      if (typeof raw.games[k] === 'boolean') games[k] = raw.games[k];
    }
  }
  const adminDomain = (raw && typeof raw.adminDomain === 'string' && raw.adminDomain.trim())
    ? raw.adminDomain.trim().toLowerCase()
    : (process.env.ICHANCE_ADMIN_DOMAIN || null);
  return { games, adminDomain };
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

async function setGame(key, enabled) {
  if (!GAMES[key]) return { ok: false, error: 'لعبة غير معروفة' };
  await refresh({ force: true });          // لا نكتب فوق تعديل حفظته نسخة أخرى للتو
  const prev = get().games[key];
  state.games[key] = !!enabled;
  if (!(await save())) {
    state.games[key] = prev;
    return { ok: false, error: 'تعذّر حفظ الإعداد' };
  }
  console.log(`[site] ${GAMES[key].name}: ${enabled ? 'تشغيل' : 'إيقاف'}`);
  return { ok: true, games: { ...state.games } };
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
  return Object.values(GAMES).map((meta) => ({ ...meta, enabled: g[meta.key] !== false }));
}

function publicGames() {
  return { ...get().games };
}

module.exports = {
  GAMES, gameEnabled, setGame, report, publicGames, refresh,
  getAdminDomain, setAdminDomain, FILE
};
