'use strict';

const fs = require('fs');
const supabase = require('./supabase');
const accounts = require('./accounts');
const path = require('path');
const crypto = require('crypto');
const { WALLET, SERVER } = require('./config');

/**
 * تخزين بسيط للاعبين في ملف JSON.
 * العملة هنا افتراضية بالكامل — لا يوجد أي ربط بمال حقيقي.
 * الدخول بالرمز (token) المحفوظ في المتصفح، بدون كلمات مرور.
 */

const DATA_FILE = SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json');

/** @type {Map<string, any>} id -> player */
const players = new Map();
/** @type {Map<string, string>} token -> id */
const tokenIndex = new Map();

let dirty = false;
let writing = false;

/**
 * دفتر حسابات الموقع.
 * يسجّل الأموال الحقيقية فقط (اللاعبون البشر) — البوتات لا تُحتسب إطلاقاً
 * لأن رهاناتها وأرباحها وهمية ولا تمر بأي محفظة.
 */
/** سجل الجولات المحفوظ — يبقى بعد إعادة تشغيل الخادم لتراجعه لوحة الإدارة. */
const roundLog = [];

/**
 * دفتر حسابات الموقع — بدلوين منفصلين:
 *   real = لاعبون بشر بمحافظ فعلية.
 *   bot  = لاعبون آليون. مالهم وهمي ولا يمرّ بأي محفظة، لكنه يُحتسب هنا
 *          لأنه يمثّل حجم اللعب المتوقع — وهو أساس دراسة الجدوى الاقتصادية.
 * لوحة الإدارة تعرض البدلوين منفصلين ومجموعهما، فلا يختلط المُقاس بالمُحاكى.
 */
function emptyBucket() {
  return { wagered: 0, paid: 0, bets: 0, rounds: 0 };
}

const ledger = {
  real: emptyBucket(),
  bot: emptyBucket(),
  // ربحية كل لعبة على حدة — بدونها لا يعرف المالك أي لعبة تكسب وأيها تخسر
  games: { cards: emptyBucket(), slots: emptyBucket(), tank: emptyBucket(), 'neon-slots': emptyBucket(), mines: emptyBucket() },
  // شراء الميزة صفقة واحدة بمبلغ يعادل مئات الدورات. لو خُلط مع الدورات
  // العادية في عدّاد واحد لقفز "متوسط الرهان" وصار التقرير مضلّلاً.
  slotBuys: { count: 0, wagered: 0 },
  faucet: 0,
  since: Date.now()
};

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const p of raw.players || []) {
      if (!p || !p.id || !p.token) continue;
      players.set(p.id, normalize(p));
      tokenIndex.set(p.token, p.id);
    }
    if (Array.isArray(raw.rounds)) {
      roundLog.push(...raw.rounds.slice(0, SERVER.historySize));
    }
    if (raw.ledger) {
      const L = raw.ledger;
      if (L.real || L.bot) {
        for (const bucket of ['real', 'bot']) {
          for (const k of Object.keys(ledger[bucket])) {
            if (Number.isFinite(L[bucket]?.[k])) ledger[bucket][k] = L[bucket][k];
          }
        }
      } else {
        // ترحيل الصيغة القديمة: كانت تسجّل البشر فقط في المستوى الأعلى
        for (const k of Object.keys(ledger.real)) {
          if (Number.isFinite(L[k])) ledger.real[k] = L[k];
        }
      }
      if (L.tankByDifficulty && typeof L.tankByDifficulty === 'object') {
        ledger.tankByDifficulty = L.tankByDifficulty;
      }
      if (L.games) {
        for (const g of Object.keys(ledger.games)) {
          for (const k of Object.keys(ledger.games[g])) {
            if (Number.isFinite(L.games[g]?.[k])) ledger.games[g][k] = L.games[g][k];
          }
        }
      }
      if (L.slotBuys) {
        if (Number.isFinite(L.slotBuys.count)) ledger.slotBuys.count = L.slotBuys.count;
        if (Number.isFinite(L.slotBuys.wagered)) ledger.slotBuys.wagered = L.slotBuys.wagered;
      }
      if (Number.isFinite(L.faucet)) ledger.faucet = L.faucet;
      if (Number.isFinite(L.since)) ledger.since = L.since;
    }
    console.log(`[store] تم تحميل ${players.size} لاعب`);
  } catch (err) {
    console.error('[store] فشل تحميل الملف، سنبدأ من جديد:', err.message);
  }
}

/** يُستدعى مرة واحدة في نهاية كل جولة بمجاميع البشر والبوتات منفصلة. */
function recordLedger({ real, bot, game = 'cards' }) {
  let touched = false;
  for (const [name, part] of [['real', real], ['bot', bot]]) {
    if (!part || !part.bets) continue;
    ledger[name].wagered += part.wagered;
    ledger[name].paid += part.paid;
    ledger[name].bets += part.bets;
    ledger[name].rounds += 1;
    touched = true;
  }
  // بدلو اللعبة يحتسب البشر فقط: البوتات محاكاة ولا تخصّ ربحية لعبة بعينها
  const bucket = ledger.games[game];
  if (bucket && real && real.bets) {
    bucket.wagered += real.wagered;
    bucket.paid += real.paid;
    bucket.bets += real.bets;
    bucket.rounds += 1;
  }
  if (touched) persistSoon();
}

/**
 * دورة سلوتس واحدة. لعبة فردية لا جولات جماعية، فتُسجَّل دورة بدورة.
 * الدورات المجانية تُسجَّل برهان صفر: هي صرف بلا مقابل جديد.
 */
function recordSlot(player, { bet, win, free, buy }) {
  const wagered = free ? 0 : bet;
  ledger.real.wagered += wagered;
  ledger.real.paid += win;
  if (!free) ledger.real.bets += 1;

  const g = ledger.games.slots;
  g.wagered += wagered;
  g.paid += win;
  if (!free) { g.bets += 1; g.rounds += 1; }

  if (buy) {
    ledger.slotBuys.count += 1;
    ledger.slotBuys.wagered += wagered;
  }

  if (!player.slotStats) {
    player.slotStats = { spins: 0, freeSpins: 0, buys: 0, wagered: 0, won: 0, best: 0 };
  }
  const st = player.slotStats;
  if (st.buys === undefined) st.buys = 0;
  if (free) st.freeSpins += 1;
  else if (buy) { st.buys += 1; st.wagered += bet; }
  else { st.spins += 1; st.wagered += bet; }
  st.won += win;
  if (win > st.best) st.best = win;

  persistSoon();
}

/**
 * معركة دبابات واحدة. لعبة مهارة بنتيجة ثنائية: إمّا المضاعف كاملاً أو صفر،
 * فلا حاجة لتفصيل كالسلوتس. نحفظ إحصاء اللاعب كي يرى سجلّه، ونحفظ نسبة
 * الفوز الفعلية لكل صعوبة لأن عائد هذه اللعبة يتبع مهارة اللاعبين لا الحظ
 * وحده — ولوحة الإدارة تحتاج أن تُظهر انحرافه فوراً.
 */
function recordTank(player, { bet, win, difficulty, won }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;

  const g = ledger.games.tank;
  g.wagered += bet;
  g.paid += win;
  g.bets += 1;
  g.rounds += 1;

  if (!ledger.tankByDifficulty) ledger.tankByDifficulty = {};
  const d = ledger.tankByDifficulty[difficulty]
    || (ledger.tankByDifficulty[difficulty] = { battles: 0, wins: 0, wagered: 0, paid: 0 });
  d.battles += 1;
  if (won) d.wins += 1;
  d.wagered += bet;
  d.paid += win;

  if (!player.tankStats) {
    player.tankStats = { battles: 0, wins: 0, wagered: 0, won: 0, best: 0, streak: 0, bestStreak: 0 };
  }
  const st = player.tankStats;
  st.battles += 1;
  st.wagered += bet;
  st.won += win;
  if (won) {
    st.wins += 1;
    st.streak += 1;
    if (st.streak > st.bestStreak) st.bestStreak = st.streak;
  } else {
    st.streak = 0;
  }
  if (win > st.best) st.best = win;

  persistSoon();
}

/** يحفظ ملخّص جولة منتهية في أعلى السجل. */
function recordRoundLog(summary) {
  roundLog.unshift(summary);
  if (roundLog.length > SERVER.historySize) roundLog.length = SERVER.historySize;
  persistSoon();
}

/**
 * جولات محفوظة بنسخة أقدم قد تحمل house بصيغة مسطّحة {wagered,paid,profit,bets}.
 * نطبّعها هنا مرة واحدة حتى لا تنكسر أي شاشة أو حساب لاحق.
 */
function normalizeRound(r) {
  const h = r.house;
  if (h && h.total && h.real && h.bot) return r;

  const flat = h || { wagered: 0, paid: 0, bets: 0 };
  const real = {
    wagered: flat.wagered || 0,
    paid: flat.paid || 0,
    bets: flat.bets || 0,
    profit: (flat.wagered || 0) - (flat.paid || 0)
  };
  const empty = { wagered: 0, paid: 0, bets: 0, profit: 0 };
  return {
    ...r,
    durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
    house: { real, bot: { ...empty }, total: { ...real } }
  };
}

function rounds(limit = 40) {
  return roundLog.slice(0, limit).map(normalizeRound);
}

/** يضيف المشتقات (الربح، الهامش، العائد، متوسط الرهان) إلى بدلو خام. */
function describeBucket(b) {
  const profit = b.wagered - b.paid;
  return {
    ...b,
    profit,
    margin: b.wagered ? profit / b.wagered : 0,
    actualRtp: b.wagered ? b.paid / b.wagered : 0,
    avgBet: b.bets ? b.wagered / b.bets : 0
  };
}

/**
 * ملخّص الدفتر: البشر، المحاكاة (البوتات)، ومجموعهما.
 * لوحة الإدارة تختار أيّها تعرض، فلا يختلط المال الفعلي بالمُحاكى.
 */
function ledgerSummary() {
  const total = {
    wagered: ledger.real.wagered + ledger.bot.wagered,
    paid: ledger.real.paid + ledger.bot.paid,
    bets: ledger.real.bets + ledger.bot.bets,
    rounds: Math.max(ledger.real.rounds, ledger.bot.rounds)
  };
  const games = {};
  for (const [name, b] of Object.entries(ledger.games)) games[name] = describeBucket(b);

  // متوسط الدورة العادية = ما بقي بعد استبعاد صفقات الشراء
  const buys = ledger.slotBuys;
  const spinWagered = games.slots.wagered - buys.wagered;
  const spinCount = games.slots.bets - buys.count;
  games.slots.buys = { ...buys, avg: buys.count ? buys.wagered / buys.count : 0 };
  games.slots.avgSpinBet = spinCount > 0 ? spinWagered / spinCount : 0;
  games.slots.spinCount = Math.max(0, spinCount);

  return {
    real: describeBucket(ledger.real),
    bot: describeBucket(ledger.bot),
    total: describeBucket(total),
    games,
    faucet: ledger.faucet,
    since: ledger.since
  };
}

function normalize(p) {
  return {
    id: String(p.id),
    token: String(p.token),
    balance: Number.isFinite(p.balance) ? Math.max(0, Math.round(p.balance)) : WALLET.startingBalance,
    createdAt: p.createdAt || Date.now(),
    lastSeen: p.lastSeen || Date.now(),
    lastFaucet: p.lastFaucet || 0,
    slotFair: p.slotFair || null,
    slotStats: p.slotStats || null,
    stats: {
      rounds: p.stats?.rounds || 0,
      wagered: p.stats?.wagered || 0,
      won: p.stats?.won || 0,
      best: p.stats?.best || 0,
      bestMultiplier: p.stats?.bestMultiplier || 0
    }
  };
}

function persistSoon() { dirty = true; }

async function flush() {
  if (!dirty || writing) return;
  writing = true;
  dirty = false;
  const payload = JSON.stringify({
    savedAt: Date.now(),
    ledger,
    rounds: roundLog.slice(0, SERVER.historySize),
    players: [...players.values()]
  });
  const tmp = `${DATA_FILE}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (err) {
    console.error('[store] فشل الحفظ:', err.message);
    dirty = true; // نعيد المحاولة في الدورة القادمة
  } finally {
    writing = false;
  }
}

function shortId() {
  // معرّف قصير يسهل على اللاعبين قراءته على الطاولة (بدون I و O المربكين)
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function createPlayer() {
  let id = shortId();
  while (players.has(id)) id = shortId();
  const player = normalize({
    id,
    token: crypto.randomBytes(24).toString('hex'),
    balance: WALLET.startingBalance,
    createdAt: Date.now()
  });
  players.set(id, player);
  tokenIndex.set(player.token, id);
  persistSoon();
  return player;
}

/**
 * يربط صفّ حساب من Supabase بكائن اللاعب في الذاكرة.
 *
 * التقسيم مقصود: Supabase تحفظ الهوية والرصيد (ما يهمّ الكاشير والمحاسبة)،
 * والذاكرة/الملف يحفظان إحصاءات اللعب وبذور العدالة (كتابات كثيفة لا قيمة
 * محاسبية لها). الرصيد يُؤخذ من Supabase لأنها المرجع — إلّا إن كانت هناك
 * فروق لعب لم تُكتب بعد، فحينها الذاكرة أحدث ولا يجوز أن نرجع بها للوراء.
 */
function attachAccount(row) {
  if (!row || !row.display_id) return null;
  let player = players.get(row.display_id);

  if (!player) {
    player = normalize({ id: row.display_id, token: row.play_token || '', balance: row.balance });
    players.set(player.id, player);
  }

  if (player.token && player.token !== row.play_token) tokenIndex.delete(player.token);
  player.token = row.play_token || player.token;
  if (player.token) tokenIndex.set(player.token, player.id);

  player.accountId = row.id;
  player.username = row.username;
  player.cashierId = row.cashier_id || null;
  if (!accounts.hasPending(row.id)) player.balance = Math.max(0, Math.round(row.balance));
  player.lastSeen = Date.now();
  persistSoon();
  return player;
}

function byToken(token) {
  if (!token) return null;
  const id = tokenIndex.get(token);
  if (!id) return null;
  const p = players.get(id) || null;
  if (p) p.lastSeen = Date.now();
  return p;
}

function byId(id) { return players.get(id) || null; }

/** تعديل الرصيد بأمان. amount موجب = إضافة، سالب = خصم. */
function adjustBalance(player, amount) {
  const next = Math.round(player.balance + amount);
  if (next < 0) return false;
  player.balance = next;
  // نتائج اللعب تُجمَّع وتُدفع دفعات: الكتابة الفورية تضيف ~450مللي ثانية
  // على كل دورة سلوتس. الفرق نسبي لا مطلق، فلا يمحو تعبئةً حدثت في الأثناء.
  if (player.accountId) accounts.queueDelta(player.accountId, Math.round(amount));
  persistSoon();
  return true;
}

function recordRound(player, { stake, payout, multiplier }) {
  const s = player.stats;
  s.rounds += 1;
  s.wagered += stake;
  s.won += payout;
  if (payout > s.best) s.best = payout;
  if (multiplier > s.bestMultiplier) s.bestMultiplier = multiplier;
  persistSoon();
}

function canUseFaucet(player) {
  // مع وجود الكاشير صار للمال مصدر واحد: عهدة الكاشير. إبقاء صنبور مجاني
  // يجعل نظام العهدة بلا معنى — أي لاعب يطبع رصيداً بضغطة.
  if (supabase.configured()) {
    return { ok: false, reason: 'الشحن يتم عبر الكاشير' };
  }
  if (player.balance >= WALLET.faucetThreshold) {
    return { ok: false, reason: 'رصيدك ما زال يكفي للمشاركة' };
  }
  const waited = Date.now() - (player.lastFaucet || 0);
  if (waited < WALLET.faucetCooldownMs) {
    return { ok: false, reason: `انتظر ${Math.ceil((WALLET.faucetCooldownMs - waited) / 1000)} ثانية` };
  }
  return { ok: true };
}

function useFaucet(player) {
  const check = canUseFaucet(player);
  if (!check.ok) return check;
  player.balance += WALLET.faucetAmount;
  player.lastFaucet = Date.now();
  ledger.faucet += WALLET.faucetAmount;
  persistSoon();
  return { ok: true, amount: WALLET.faucetAmount, balance: player.balance };
}

function leaderboard(limit = 10) {
  return [...players.values()]
    .filter((p) => p.stats.rounds > 0)
    .sort((a, b) => (b.stats.won - b.stats.wagered) - (a.stats.won - a.stats.wagered))
    .slice(0, limit)
    .map((p) => ({
      id: p.id,
      net: p.stats.won - p.stats.wagered,
      rounds: p.stats.rounds,
      bestMultiplier: p.stats.bestMultiplier
    }));
}

/** كل اللاعبين مع أرصدتهم وإحصاءاتهم — للوحة الإدارة فقط. */
function allPlayers() {
  return [...players.values()]
    .map((p) => ({
      id: p.id,
      balance: p.balance,
      rounds: p.stats.rounds,
      wagered: p.stats.wagered,
      won: p.stats.won,
      net: p.stats.won - p.stats.wagered,
      houseNet: p.stats.wagered - p.stats.won,
      best: p.stats.best,
      bestMultiplier: p.stats.bestMultiplier,
      createdAt: p.createdAt,
      lastSeen: p.lastSeen
    }))
    .sort((a, b) => b.wagered - a.wagered);
}

/** ملف اللاعب كما يراه هو. الاسم غير مُدرج عمداً: الهوية المعروضة هي المعرّف. */
function publicProfile(player) {
  return {
    id: player.id,
    username: player.username || null,
    balance: player.balance,
    stats: player.stats
  };
}

load();
const flushTimer = setInterval(flush, 1500);
if (flushTimer.unref) flushTimer.unref();

module.exports = {
  createPlayer, byToken, byId, adjustBalance, recordRound, attachAccount,
  canUseFaucet, useFaucet, leaderboard, publicProfile, flush, DATA_FILE,
  recordLedger, recordSlot, recordTank, ledgerSummary,
  tankDifficultyLedger: () => ledger.tankByDifficulty || {}, recordRoundLog, rounds, allPlayers, playerCount: () => players.size
};
