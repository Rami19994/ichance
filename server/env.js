'use strict';

const fs = require('fs');
const path = require('path');

/**
 * قارئ ملف `.env` — بلا مكتبة خارجية.
 *
 * المشروع بلا تبعيات، و`dotenv` كانت ستفرض `npm install` على الاستضافة.
 * الصيغة بسيطة: `KEY=value` سطراً سطراً.
 *
 * ⚠ لا يطغى على متغيّر موجود أصلاً في البيئة. على Vercel وHostinger تأتي
 * القيم من لوحة الاستضافة، وهي المرجع؛ ملف `.env` للتشغيل المحلي أو على
 * خادم تملكه. لو طغى الملف لصار تعديل المتغيّر من لوحة الاستضافة بلا أثر
 * وقضيت ساعات تبحث عن السبب.
 *
 * ⚠ الملف يحمل أسرارك (مفتاح Supabase، مسار البوابة) — وهو مستثنى في
 * `.gitignore`. لا ترفعه إلى أي مستودع.
 */

const ROOT = path.join(__dirname, '..');

function parse(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // علامات اقتباس اختيارية — تُزال، وما بينها يبقى كما هو
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function load(file = path.join(ROOT, '.env')) {
  let text;
  try {
    if (!fs.existsSync(file)) return { loaded: false, count: 0 };
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('[env] تعذّرت قراءة .env:', err.message);
    return { loaded: false, count: 0 };
  }

  const vars = parse(text);
  let count = 0;
  for (const [k, v] of Object.entries(vars)) {
    // الموجود في البيئة يبقى — لوحة الاستضافة هي المرجع
    if (process.env[k] !== undefined && process.env[k] !== '') continue;
    process.env[k] = v;
    count++;
  }
  return { loaded: true, count, total: Object.keys(vars).length };
}

module.exports = { load, parse };
