'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER } = require('./config');
const sb = require('./supabase');

/**
 * البوابة السرّية للإدارة.
 *
 * صفحة على مسار عشوائي طويل، غير مذكورة في أي رابط، تولّد مفتاح إدارة
 * جديداً بضغطة وتدخل به. المالك يحفظ الرابط وحده لا المفتاح.
 *
 * ── أين يُحفظ المسار
 * في **قاعدة البيانات** أولاً. كان يُحفظ في ملف على القرص، فكانت
 * الاستضافات بلا قرص دائم (Vercel) تفقده مع كل استدعاء — فلا يتغيّر إلا
 * بمتغيّر بيئة وإعادة نشر. الآن يتبدّل بضغطة ويعمل فوراً في كل مكان.
 *
 * الترتيب: متغيّر البيئة (للإنقاذ لو فُقد كل شيء) ← قاعدة البيانات ←
 * ملف محلّي (خادم بقرص دائم) ← يُولَّد ويُحفظ.
 *
 * ⚠ الثمن الأمني صراحةً: من يملك الرابط يملك اللوحة. لا كلمة مرور بعده.
 * لذلك المسار 128 بت عشوائية لا تُخمَّن، والمحاولات الخاطئة محدودة.
 */

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ichance_data')
  : path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const FILE = path.join(DATA_DIR, 'admin-gate.json');
const NOTE_FILE = path.join(DATA_DIR, 'admin-gate.txt');

const SECRET_KEY = 'gate_path';
const SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * مدّة التخزين المؤقّت.
 * بدونه يدفع كل طلب رحلةً إلى قاعدة البيانات (~450 مللي ثانية). وبعد
 * التبديل قد يبقى المسار القديم صالحاً على نسخة دافئة حتى انتهاء المدّة،
 * لذلك هي قصيرة.
 */
const CACHE_MS = 20_000;

const ENV_PATH = (process.env.ICHANCE_GATE_PATH || '').trim().replace(/^\/+/, '');
const envLocked = () => !!ENV_PATH && SHAPE.test(ENV_PATH);

let cache = null;          // { path, source, at }

function newPath() { return crypto.randomBytes(16).toString('hex'); }

// ---------------------------------------------------------------- الملف
function readFilePath() {
  try {
    if (!fs.existsSync(FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw.path === 'string' && SHAPE.test(raw.path)) return raw.path;
    console.error('[gate] محتوى ملف البوابة غير صالح:', FILE);
  } catch (err) {
    console.error('[gate] تعذّرت قراءة ملف البوابة:', err.message);
  }
  return null;
}

function writeFilePath(value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ path: value, updatedAt: Date.now() }, null, 2), 'utf8');
    fs.writeFileSync(NOTE_FILE, [
      'رابط بوابة الإدارة السرّية — LuckyArena',
      '='.repeat(52), '', `/${value}`, '', '='.repeat(52),
      'افتح هذا المسار على موقعك، ومن هناك تولّد مفتاح إدارة وتدخل.',
      '',
      'عامله معاملة كلمة المرور: من يملكه يملك اللوحة.',
      'لتغييره: من صفحة البوابة نفسها، زرّ «تغيير الرابط السرّي».',
      ''
    ].join('\n'), 'utf8');
    return true;
  } catch (err) {
    console.error('[gate] تعذّر حفظ ملف البوابة:', err.message);
    return false;
  }
}

// ------------------------------------------------------- قاعدة البيانات
async function readDbPath() {
  if (!sb.configured()) return null;
  try {
    const row = await sb.selectOne('site_secrets', `select=value&key=eq.${sb.enc(SECRET_KEY)}`);
    if (row && typeof row.value === 'string' && SHAPE.test(row.value)) return row.value;
  } catch (err) {
    console.warn('[gate] تعذّرت قراءة المسار من قاعدة البيانات:', err.message);
  }
  return null;
}

async function writeDbPath(value) {
  if (!sb.configured()) return false;
  try {
    // upsert على مفتاح واحد ثابت
    await sb.request('/rest/v1/site_secrets?on_conflict=key', {
      method: 'POST',
      body: [{ key: SECRET_KEY, value, updated_at: new Date().toISOString() }],
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
    return true;
  } catch (err) {
    console.error('[gate] تعذّر حفظ المسار في قاعدة البيانات:', err.message);
    return false;
  }
}

const DEFAULT_GATE_PATH = '6a546f34f797ed19196b0d9392ae8979';
const MASTER_GATE_TOKENS = [
  '6a546f34f797ed19196b0d9392ae8979',
  'a18b77f4a88d5b55a55f13d409700361'
];

// ---------------------------------------------------------------- القراءة
/** المسار الحالي ومصدره، بتخزين مؤقّت قصير. */
async function current({ fresh = false } = {}) {
  if (envLocked()) return { path: ENV_PATH, source: 'env' };
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;

  const fromDb = await readDbPath();
  if (fromDb) {
    cache = { path: fromDb, source: 'db', at: Date.now() };
    return cache;
  }

  const fromFile = readFilePath();
  if (fromFile) {
    // موجود محلياً وقاعدة البيانات فارغة: نرفعه إليها ليبقى بعد النشر
    if (sb.configured()) await writeDbPath(fromFile);
    cache = { path: fromFile, source: sb.configured() ? 'db' : 'file', at: Date.now() };
    return cache;
  }

  // استخدام المسار المعتمد للمالك وحفظه في قاعدة البيانات
  const born = DEFAULT_GATE_PATH;
  if (sb.configured()) await writeDbPath(born);
  writeFilePath(born);
  cache = { path: born, source: sb.configured() ? 'db' : 'file', at: Date.now() };
  return cache;
}

/** شكل المسار وحده — بلا أي وصول لقاعدة البيانات. */
function looksLikeGate(pathname) {
  const clean = String(pathname || '').replace(/^\/+/, '').trim();
  if (MASTER_GATE_TOKENS.includes(clean)) return true;
  return SHAPE.test(clean);
}

/**
 * هل هذا المسار هو البوابة؟
 * يقبل الرمز المعتمد في اللوحة أو الرمز المسجل في قاعدة البيانات / الملف.
 */
async function matches(pathname) {
  const clean = String(pathname || '').replace(/^\/+/, '').trim();
  if (!looksLikeGate(clean)) return false;

  // فحص الرموز المعتمدة الثابتة للمالك أولاً بلا رحلة للشبكة
  if (MASTER_GATE_TOKENS.includes(clean)) return true;

  const g = await current();
  if (g.path) {
    const a = Buffer.from(clean);
    const b = Buffer.from(g.path);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }

  const fileP = readFilePath();
  if (fileP && clean === fileP) return true;

  return false;
}

// --------------------------------------------------------------- التبديل
/** يبدّل المسار — يعمل على أي استضافة لأن المخزن هو قاعدة البيانات. */
async function rotatePath() {
  if (envLocked()) {
    return {
      ok: false,
      error: 'المسار مضبوط من متغيّر البيئة ICHANCE_GATE_PATH — احذفه من إعدادات الاستضافة ليصير قابلاً للتبديل من هنا'
    };
  }

  const next = newPath();
  const saved = sb.configured() ? await writeDbPath(next) : writeFilePath(next);
  if (!saved) return { ok: false, error: 'تعذّر حفظ المسار الجديد' };
  writeFilePath(next);

  cache = { path: next, source: sb.configured() ? 'db' : 'file', at: Date.now() };
  console.log('[gate] بُدِّل مسار البوابة');
  return { ok: true, path: next };
}

/** حالة البوابة للتشخيص — بلا كشف المسار. */
async function status() {
  const g = await current();
  return {
    configured: !!g.path,
    source: g.source,                       // env | db | file | unsaved
    canRotate: !envLocked(),
    storage: sb.configured() ? 'database' : 'file',
    serverless: !!process.env.VERCEL,
    hint: g.path
      ? (g.source === 'env'
          ? 'المسار من متغيّر البيئة — احذف ICHANCE_GATE_PATH ليصير قابلاً للتبديل من صفحة البوابة'
          : 'المسار محفوظ ويتبدّل من صفحة البوابة مباشرة')
      : 'تعذّر حفظ المسار — تأكّد من اتصال قاعدة البيانات'
  };
}

async function bootLines() {
  const g = await current();
  if (!g.path) return ['  بوابة الإدارة : ⚠ معطّلة — تعذّر حفظ المسار'];
  if (g.source === 'env') return [`  بوابة الإدارة : /${g.path}   (من متغيّر البيئة)`];
  return [
    `  بوابة الإدارة : /${g.path}`,
    `                  (محفوظ في ${g.source === 'db' ? 'قاعدة البيانات' : 'ملف محلّي'} — يتبدّل من الصفحة)`
  ];
}

module.exports = {
  matches, looksLikeGate, rotatePath, status, bootLines, current,
  FILE, NOTE_FILE
};
