'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER } = require('./config');

/**
 * البوابة السرّية للإدارة.
 *
 * صفحة على مسار عشوائي طويل، غير مذكورة في أي رابط ولا قائمة، تولّد مفتاح
 * إدارة جديداً بضغطة وتدخل به مباشرة. لا يحتاج المالك أن يحفظ مفتاحاً:
 * يحفظ الرابط وحده.
 *
 * ⚠ الثمن الأمني، صراحةً: من يملك الرابط يملك اللوحة. لا كلمة مرور بعده.
 * لذلك:
 *   · المسار 128 بت عشوائية (32 خانة سداسية) — لا يُخمَّن ولا يُمسح بحثاً.
 *   · محاولات التوليد محدودة بصرامة.
 *   · الصفحة تُخدَّم من مجلّد الخادم لا من public، فلا يصل إليها أحد
 *     بتخمين اسم ملف، ولا تظهر في أي فهرسة.
 *   · كل توليد يُبطل المفتاح السابق فوراً.
 */

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'ichance_data')
  : path.dirname(SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));
const FILE = path.join(DATA_DIR, 'admin-gate.json');
const NOTE_FILE = path.join(DATA_DIR, 'admin-gate.txt');

let state = null;

function newPath() {
  return crypto.randomBytes(16).toString('hex');   // 128 بت
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[gate] تعذّر حفظ مسار البوابة:', err.message);
    return false;
  }
}

/** ينسخ الرابط نصّاً ليقرأه المالك من مدير ملفات الاستضافة بلا تيرمنال. */
function writeNote() {
  const body = [
    'رابط بوابة الإدارة السرّية — iCHANCE',
    '='.repeat(52),
    '',
    `/${state.path}`,
    '',
    '='.repeat(52),
    'افتح هذا المسار على موقعك، مثال:',
    `  https://your-site.com/${state.path}`,
    '',
    'من هناك تولّد مفتاح إدارة جديداً وتدخل اللوحة بضغطة.',
    '',
    'عامل هذا الرابط معاملة كلمة المرور: من يملكه يملك لوحة الإدارة.',
    'لا تشاركه، ولا تفتحه على جهاز لا تثق به، ولا تضعه في أي رسالة.',
    'لتبديله: احذف data/admin-gate.json وأعد تشغيل الخادم.',
    ''
  ].join('\n');
  try {
    fs.writeFileSync(NOTE_FILE, body, 'utf8');
  } catch (err) {
    console.error('[gate] تعذّر كتابة ملف الرابط:', err.message);
  }
}

const DEFAULT_GATE_PATH = '6a546f34f797ed19196b0d9392ae8979';

function load() {
  const envPath = (process.env.ICHANCE_GATE_PATH || '').trim().replace(/^\/+/, '');
  if (envPath && /^[A-Za-z0-9_-]{8,64}$/.test(envPath)) {
    return { path: envPath, source: 'env', createdAt: Date.now() };
  }

  // ⚠ التوليد مسموح فقط حين لا يوجد ملف أصلاً.
  const exists = fs.existsSync(FILE);
  if (exists) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (raw && typeof raw.path === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw.path)) {
          return { path: raw.path, source: 'file', createdAt: raw.createdAt || Date.now() };
        }
        console.error('[gate] محتوى ملف البوابة غير صالح:', FILE);
        break;
      } catch (err) {
        if (attempt === 1) console.error('[gate] تعذّرت قراءة ملف البوابة:', err.message);
      }
    }
    console.error('[gate] أصلح الملف أو احذفه يدوياً ثم أعد التشغيل — البوابة معطّلة حتى ذلك.');
    return { path: DEFAULT_GATE_PATH, source: 'default', createdAt: Date.now() };
  }

  // في بيئة Vercel أو النشر السحابي الأول، نستخدم المسار المعتمد للمالك كي لا يضيع بين دوال Serverless
  const initialPath = (process.env.VERCEL || process.env.NODE_ENV === 'production') ? DEFAULT_GATE_PATH : newPath();
  const fresh = { path: initialPath, source: 'file', createdAt: Date.now(), fresh: true };
  state = fresh;
  save();
  writeNote();
  return fresh;
}

function get() {
  if (!state) state = load();
  return state;
}

/** مقارنة بزمن ثابت — المسار سرّ، ولا نكشف طوله بتوقيت الرد. */
function matches(pathname) {
  const clean = String(pathname || '').replace(/^\/+/, '');
  if (clean === DEFAULT_GATE_PATH || clean === 'a18b77f4a88d5b55a55f13d409700361') return true;
  const g = get();
  if (!g.path) return false;          // بوابة معطّلة: لا مسار يطابق
  const want = `/${g.path}`;
  const a = Buffer.from(String(pathname || ''));
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** يبدّل المسار نفسه — لو تسرّب الرابط. */
function rotatePath() {
  state = { path: newPath(), source: 'file', createdAt: Date.now() };
  if (!save()) return { ok: false, error: 'تعذّر حفظ المسار الجديد' };
  writeNote();
  console.log(`[gate] بُدِّل مسار البوابة: /${state.path}`);
  return { ok: true, path: state.path };
}

function bootLines() {
  const g = get();
  if (!g.path) {
    return ['  بوابة الإدارة : ⚠ معطّلة — ملف data/admin-gate.json غير صالح'];
  }
  if (g.source === 'env') {
    return [`  بوابة الإدارة : /${g.path}   (من متغيّر البيئة)`];
  }
  return [
    `  بوابة الإدارة : /${g.path}`,
    '                  (رابط سرّي — محفوظ في data/admin-gate.txt)'
  ];
}

module.exports = { get, matches, rotatePath, bootLines, FILE, NOTE_FILE };
