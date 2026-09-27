'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sb = require('./supabase');

/**
 * سجلّ الجولات الدائم — لا يُحذف منه شيء ولا يُكتب فوقه.
 *
 * كان السجلّ آخر 100 جولة داخل صفّ واحد (store_data) تكتبه كل نسخة خادم
 * فوق الأخرى، فكانت الجولات تختفي. الآن كل جولة صفّ مستقلّ يُضاف مرّة
 * واحدة:
 *
 *   القاعدة  site_secrets، المفتاح  rlog:<الوقت 13 رقماً>:<اللعبة>:<عشوائي>
 *            (الوقت بعرض ثابت، فترتيب المفاتيح = ترتيب الزمن، واللعبة في
 *            المفتاح تسمح بتصفيتها دون قراءة القيم)
 *   محلياً   rounds.jsonl بجانب ملف البيانات، سطر لكل جولة، إلحاق فقط
 *
 * الكتابة بـ ignore-duplicates على المفتاح: إعادة المحاولة بعد مهلة لا تكرّر
 * جولة. جولة لم تُكتب بعد تبقى في الطابور حتى تُكتب.
 *
 * جولات كروت الحظ التي فيها بوتات فقط محاكاة لا مال فيها — لا تدخل السجلّ
 * الدائم (كانت ستملؤه بآلاف الجولات يومياً). دفتر البوتات يبقى محسوباً.
 */

const PREFIX = 'rlog:';
const GAME_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** @type {{key: string, round: object}[]} */
const pending = [];
let flushing = null;

let localFile = null;
function setLocalFile(dataFile) {
  localFile = path.join(path.dirname(dataFile), 'rounds.jsonl');
}

const useDb = () => sb.configured();

function hasRealBet(round) {
  const seats = Array.isArray(round && round.seats) ? round.seats : [];
  return seats.some((s) => s && !s.isBot);
}

function gameOf(round) {
  const g = String((round && round.game) || 'cards');
  return GAME_RE.test(g) ? g : 'other';
}

function tsOf(round) {
  const t = Number(round && (round.endedAt || round.ts));
  return Number.isFinite(t) && t > 0 ? Math.round(t) : Date.now();
}

function keyFor(round, suffix) {
  return `${PREFIX}${String(tsOf(round)).padStart(13, '0')}:${gameOf(round)}:${suffix}`;
}

/** يضيف جولة منتهية للطابور. يرجّع مفتاحها، أو null إن لم يكن فيها لاعب حقيقي. */
function add(round) {
  if (!hasRealBet(round)) return null;
  const key = keyFor(round, crypto.randomBytes(5).toString('hex'));
  round.logKey = key;
  pending.push({ key, round });
  return key;
}

/**
 * جولات السجلّ القديم (داخل store_data): مفتاح ثابت من محتواها، فأرشفتها من
 * نسختين في آن أو مرّتين لا تكرّر شيئاً.
 */
function addLegacy(rounds) {
  let n = 0;
  for (const r of Array.isArray(rounds) ? rounds : []) {
    if (!r || typeof r !== 'object') continue;
    const h = crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex').slice(0, 10);
    const key = keyFor(r, `L${h}`);
    if (pending.some((p) => p.key === key)) continue;
    pending.push({ key, round: { ...r, logKey: key } });
    n += 1;
  }
  return n;
}

const pendingCount = () => pending.length;

/** يكتب الطابور. true إن كُتب كلّه. */
function flush() {
  if (flushing) return flushing.then(() => (pending.length ? flush() : true));
  if (!pending.length) return Promise.resolve(true);
  flushing = writeBatch().finally(() => { flushing = null; });
  return flushing;
}

async function writeBatch() {
  const batch = pending.slice(0, 200);
  try {
    if (useDb()) {
      const now = new Date().toISOString();
      await sb.request('/rest/v1/site_secrets?on_conflict=key', {
        method: 'POST',
        body: batch.map(({ key, round }) => ({ key, value: JSON.stringify(round), updated_at: now })),
        prefer: 'resolution=ignore-duplicates,return=minimal'
      });
    } else if (localFile) {
      await fs.promises.mkdir(path.dirname(localFile), { recursive: true });
      await fs.promises.appendFile(localFile,
        batch.map(({ round }) => JSON.stringify(round)).join('\n') + '\n', 'utf8');
    } else {
      return false;
    }
  } catch (err) {
    console.error('[rounds] تعذّرت كتابة الجولات — تبقى في الطابور:', err.message);
    return false;
  }
  pending.splice(0, batch.length);
  return pending.length === 0 ? true : writeBatch();
}

function parse(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * صفحة من السجلّ، الأحدث أولاً.
 *   before  مفتاح آخر جولة في الصفحة السابقة (للأقدم منها)
 *   game    تصفية بلعبة واحدة
 * يرجّع { rounds, next } — next مفتاح المتابعة أو null إن انتهى السجلّ.
 */
async function list({ before = null, game = null, limit = 60 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const g = game && GAME_RE.test(game) ? game : null;
  const cursor = before && String(before).startsWith(PREFIX) ? String(before) : null;

  let rows = [];
  if (useDb()) {
    const parts = [
      'select=key,value',
      `key=like.${sb.enc(g ? `${PREFIX}*:${g}:*` : `${PREFIX}*`)}`,
      'order=key.desc',
      `limit=${n}`
    ];
    if (cursor) parts.push(`key=lt.${sb.enc(cursor)}`);
    const got = await sb.request(`/rest/v1/site_secrets?${parts.join('&')}`);
    rows = (Array.isArray(got) ? got : [])
      .map((r) => {
        const round = parse(r.value);
        return round ? { ...round, logKey: r.key } : null;
      })
      .filter(Boolean);
  } else if (localFile && fs.existsSync(localFile)) {
    const all = (await fs.promises.readFile(localFile, 'utf8')).split('\n').map(parse).filter(Boolean);
    rows = all
      .filter((r) => r.logKey && (!g || gameOf(r) === g) && (!cursor || r.logKey < cursor))
      .sort((a, b) => (a.logKey < b.logKey ? 1 : -1))
      .slice(0, n);
  }

  // جولات هذه النسخة التي لم تُكتب بعد تظهر أيضاً — لا فجوة في العرض
  const seen = new Set(rows.map((r) => r.logKey));
  const extra = pending
    .filter(({ key, round }) => !seen.has(key) && (!g || gameOf(round) === g) && (!cursor || key < cursor))
    .map(({ key, round }) => ({ ...round, logKey: key }));
  if (extra.length) {
    rows = rows.concat(extra).sort((a, b) => (a.logKey < b.logKey ? 1 : -1)).slice(0, n);
  }

  return { rounds: rows, next: rows.length === n ? rows[rows.length - 1].logKey : null };
}

module.exports = { add, addLegacy, flush, list, pendingCount, setLocalFile, hasRealBet, PREFIX, _pending: pending };
