'use strict';

const fs = require('fs');
const path = require('path');
const { SERVER } = require('./config');

/**
 * إعدادات الموقع التي يملكها المالك:
 * - أي لعبة تعمل وأيها موقوفة.
 * - دومين الإدارة المخصص (adminDomain) لعزل لوحة الإدارة عن دومين اللاعبين.
 */

const DATA_DIR = path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const FILE = path.join(DATA_DIR, 'site.json');

const GAMES = {
  cards: { key: 'cards', name: 'كروت الحظ', href: '/lucky-cards' },
  slots: { key: 'slots', name: 'صيّاد الجوائز', href: '/bounty-hunter' },
  tank:  { key: 'tank',  name: 'معركة الدبابات', href: '/battle-tanks' },
  'neon-slots': { key: 'neon-slots', name: 'نيون فيغاس', href: '/neon-slots' },
  mines: { key: 'mines', name: 'مناجم الحظ', href: '/mines' },
  plinko: { key: 'plinko', name: 'بلينكو', href: '/plinko' },
  bullseye: { key: 'bullseye', name: 'بولزآي X', href: '/bullseye' }
};

const DEFAULTS = {
  games: { cards: true, slots: true, tank: true, 'neon-slots': true, mines: true, plinko: true, bullseye: true },
  adminDomain: null
};

let state = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const games = { ...DEFAULTS.games };
      for (const k of Object.keys(games)) {
        if (raw && raw.games && typeof raw.games[k] === 'boolean') games[k] = raw.games[k];
      }
      const adminDomain = (typeof raw.adminDomain === 'string' && raw.adminDomain.trim())
        ? raw.adminDomain.trim().toLowerCase()
        : (process.env.ICHANCE_ADMIN_DOMAIN || null);
      return { games, adminDomain };
    }
  } catch (err) {
    console.error('[site] إعدادات الموقع تالفة، نعود للافتراضي:', err.message);
  }
  return {
    games: { ...DEFAULTS.games },
    adminDomain: process.env.ICHANCE_ADMIN_DOMAIN || null
  };
}

function get() {
  if (!state) state = load();
  return state;
}

function save() {
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
  const g = get().games;
  return g[key] !== false;
}

function setGame(key, enabled) {
  if (!GAMES[key]) return { ok: false, error: 'لعبة غير معروفة' };
  get().games[key] = !!enabled;
  if (!save()) return { ok: false, error: 'تعذّر حفظ الإعداد' };
  console.log(`[site] ${GAMES[key].name}: ${enabled ? 'تشغيل' : 'إيقاف'}`);
  return { ok: true, games: { ...get().games } };
}

function getAdminDomain() {
  return get().adminDomain || null;
}

function setAdminDomain(domain) {
  const clean = domain ? String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
  get().adminDomain = clean || null;
  if (!save()) return { ok: false, error: 'تعذّر حفظ دومين الإدارة' };
  console.log(`[site] دومين الإدارة: ${clean || 'غير محدد (يعمل بالرابط السري)'}`);
  return { ok: true, adminDomain: get().adminDomain };
}

function report() {
  const g = get().games;
  return Object.values(GAMES).map((meta) => ({ ...meta, enabled: g[meta.key] !== false }));
}

function publicGames() {
  return { ...get().games };
}

module.exports = {
  GAMES, gameEnabled, setGame, report, publicGames,
  getAdminDomain, setAdminDomain, FILE
};
