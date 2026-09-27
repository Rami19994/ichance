'use strict';

const fs = require('fs');
const supabase = require('./supabase');
const accounts = require('./accounts');
const path = require('path');
const crypto = require('crypto');
const { WALLET, SERVER } = require('./config');
const { merge3, clone } = require('./merge3');
const roundArchive = require('./roundLog');
const countries = require('./countries');

/**
 * تخزين بسيط للاعبين في ملف JSON.
 * العملة هنا افتراضية بالكامل — لا يوجد أي ربط بمال حقيقي.
 * الدخول بالرمز (token) المحفوظ في المتصفح، بدون كلمات مرور.
 */

const DATA_FILE = process.env.VERCEL
  ? path.join('/tmp', 'ichance_players.json')
  : (SERVER.dataFile || path.join(__dirname, '..', 'data', 'players.json'));

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
  games: { cards: emptyBucket(), slots: emptyBucket(), tank: emptyBucket(), 'neon-slots': emptyBucket(), mines: emptyBucket(), plinko: emptyBucket(), bullseye: emptyBucket(), chicken: emptyBucket(), 'buffalo-ways': emptyBucket() },
  // شراء الميزة صفقة واحدة بمبلغ يعادل مئات الدورات. لو خُلط مع الدورات
  // العادية في عدّاد واحد لقفز "متوسط الرهان" وصار التقرير مضلّلاً.
  slotBuys: { count: 0, wagered: 0 },
  faucet: 0,
  since: Date.now()
};

const STAT_FIELDS = ['stats', 'slotStats', 'neonStats', 'tankStats', 'minesStats', 'plinkoStats', 'bullseyeStats', 'chickenStats', 'buffaloStats'];

/** دفتر بصيغة قديمة جداً (مسطّح بلا real/bot) يُقرأ كدلو البشر. */
function upgradeLedger(L) {
  if (!L || typeof L !== 'object' || L.real || L.bot) return L;
  const real = {};
  for (const k of Object.keys(emptyBucket())) if (Number.isFinite(L[k])) real[k] = L[k];
  return { ...L, real };
}

/**
 * ما تحفظه هذه النسخة في store_data: الدفتر وإحصاءات اللاعبين. (سجلّ
 * الجولات لم يعد هنا — كل جولة صفّ دائم في roundLog.)
 */
function currentPayload() {
  return clone({ ledger, playerStats: extractPlayerStats() });
}

/**
 * يضع حالة كاملة (ناتج دمج) في الذاكرة مكان الحالية. لا يُستدعى إلّا بقيم
 * ناتجة عن merge3 — أي بعد إضافة ما في الذاكرة إليها، فلا يضيع منها شيء.
 */
function applyPayload(raw) {
  if (!raw) return;
  const L = upgradeLedger(raw.ledger);
  if (L && typeof L === 'object') {
    for (const bucket of ['real', 'bot']) {
      ledger[bucket] = { ...emptyBucket(), ...(L[bucket] || {}) };
    }
    const games = {};
    for (const g of new Set([...Object.keys(ledger.games), ...Object.keys(L.games || {})])) {
      games[g] = { ...emptyBucket(), ...((L.games || {})[g] || {}) };
    }
    ledger.games = games;
    if (L.tankByDifficulty && typeof L.tankByDifficulty === 'object') ledger.tankByDifficulty = clone(L.tankByDifficulty);
    ledger.slotBuys = { count: 0, wagered: 0, ...(L.slotBuys || {}) };
    if (Number.isFinite(L.faucet)) ledger.faucet = L.faucet;
    if (Number.isFinite(L.since)) ledger.since = L.since;
  }
  if (raw.playerStats && typeof raw.playerStats === 'object') {
    for (const [id, st] of Object.entries(raw.playerStats)) {
      if (!st) continue;
      let p = players.get(id);
      if (!p) {
        p = normalize({
          id,
          token: st.token || '',
          balance: Number.isFinite(st.balance) ? st.balance : WALLET.startingBalance,
          createdAt: st.createdAt || Date.now()
        });
        players.set(id, p);
        if (p.token) tokenIndex.set(p.token, id);
      }
      if (st.accountId && !p.accountId) p.accountId = st.accountId;
      if (st.username && !p.username) p.username = st.username;
      for (const f of STAT_FIELDS) {
        if (st[f] && typeof st[f] === 'object') p[f] = f === 'stats' ? { ...p.stats, ...clone(st[f]) } : clone(st[f]);
      }
    }
  }
}

/**
 * ما كانت عليه القاعدة حين تزامنت هذه النسخة آخر مرّة. ما في الذاكرة فوقه
 * هو ما أضافته هذه النسخة ولم يُكتب بعد. null = لم تُقرأ القاعدة بعد، فكل ما
 * في الذاكرة إضافة (نسخة فتيّة تبدأ بأصفار، فلا تمحو شيئاً).
 */
let syncBase = null;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const p of raw.players || []) {
        if (!p || !p.id || !p.token) continue;
        players.set(p.id, normalize(p));
        tokenIndex.set(p.token, p.id);
      }
      if (Array.isArray(raw.rounds)) roundLog.push(...raw.rounds.slice(0, SERVER.historySize));
      applyPayload(raw);
      // ما في الملف كان قد تزامن حتى syncBase المحفوظ معه؛ ملف أقدم بلا
      // syncBase نعدّه متزامناً كلّه — كي لا يُضاف تاريخ القاعدة إليها مرّتين.
      syncBase = raw.syncBase ? raw.syncBase : currentPayload();
      console.log(`[store] تم تحميل ${players.size} لاعب من الملف`);
    }
  } catch (err) {
    console.error('[store] فشل تحميل الملف، سنبدأ من جديد:', err.message);
  }
  syncWithDb().catch(() => {});
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

function updatePlayerTotalStats(player, wagered, won) {
  if (!player.stats) {
    player.stats = { rounds: 0, wagered: 0, won: 0, best: 0, bestMultiplier: 0 };
  }
  player.stats.rounds = (player.stats.rounds || 0) + 1;
  player.stats.wagered = (player.stats.wagered || 0) + wagered;
  player.stats.won = (player.stats.won || 0) + won;
  if (won > (player.stats.best || 0)) player.stats.best = won;
  const mult = wagered > 0 ? (won / wagered) : 0;
  if (mult > (player.stats.bestMultiplier || 0)) player.stats.bestMultiplier = mult;
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

  updatePlayerTotalStats(player, wagered, win);

  recordRoundLog({
    roundId: `slot-${Date.now().toString(36).toUpperCase()}`,
    ts: Date.now(),
    game: 'slots',
    patternName: 'صيّاد الجوائز سلوتس',
    cards: [],
    seats: [{
      id: player.id,
      stake: wagered,
      cardIndex: 0,
      cardValue: wagered > 0 ? (win / wagered) : 0,
      net: win - wagered,
      multiplier: wagered > 0 ? (win / wagered) : 0,
      isBot: false
    }],
    house: {
      real: { wagered, paid: win, profit: wagered - win, bets: free ? 0 : 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered, paid: win, profit: wagered - win, bets: free ? 0 : 1 }
    }
  });

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

  updatePlayerTotalStats(player, bet, win);

  recordRoundLog({
    roundId: `tank-${Date.now().toString(36).toUpperCase()}`,
    ts: Date.now(),
    game: 'tank',
    patternName: `معركة دبابات (${difficulty})`,
    cards: [],
    seats: [{
      id: player.id,
      stake: bet,
      cardIndex: 0,
      cardValue: bet > 0 ? (win / bet) : 0,
      net: win - bet,
      multiplier: bet > 0 ? (win / bet) : 0,
      isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * دورة نيون فيغاس سلوتس واحدة.
 * 20 خط دفع، رموز Wild وScatter، أرباح ومضاعفات فورية.
 */
function recordNeonSlots(player, { bet, win }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;
  ledger.real.rounds += 1;

  const g = ledger.games['neon-slots'];
  if (g) {
    g.wagered += bet;
    g.paid += win;
    g.bets += 1;
    g.rounds += 1;
  }

  if (!player.neonStats) {
    player.neonStats = { spins: 0, wagered: 0, won: 0, best: 0 };
  }
  const st = player.neonStats;
  st.spins = (st.spins || 0) + 1;
  st.wagered = (st.wagered || 0) + bet;
  st.won = (st.won || 0) + win;
  if (win > (st.best || 0)) st.best = win;

  updatePlayerTotalStats(player, bet, win);

  const mult = bet > 0 ? (win / bet) : 0;
  recordRoundLog({
    roundId: `neon-${Date.now().toString(36).toUpperCase()}`,
    ts: Date.now(),
    game: 'neon-slots',
    patternName: 'نيون فيغاس سلوتس',
    cards: [],
    seats: [{
      id: player.id,
      stake: bet,
      cardIndex: 0,
      cardValue: mult,
      net: win - bet,
      multiplier: mult,
      isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * جولة مناجم الحظ (Stake Mines) واحدة.
 */
function recordMines(player, { bet, win }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;
  ledger.real.rounds += 1;

  const g = ledger.games.mines;
  if (g) {
    g.wagered += bet;
    g.paid += win;
    g.bets += 1;
    g.rounds += 1;
  }

  if (!player.minesStats) {
    player.minesStats = { games: 0, wagered: 0, won: 0, best: 0 };
  }
  const st = player.minesStats;
  st.games = (st.games || 0) + 1;
  st.wagered = (st.wagered || 0) + bet;
  st.won = (st.won || 0) + win;
  if (win > (st.best || 0)) st.best = win;

  updatePlayerTotalStats(player, bet, win);

  const mult = bet > 0 ? (win / bet) : 0;
  recordRoundLog({
    roundId: `mines-${Date.now().toString(36).toUpperCase()}`,
    ts: Date.now(),
    game: 'mines',
    patternName: 'مناجم الحظ',
    cards: [],
    seats: [{
      id: player.id,
      stake: bet,
      cardIndex: 0,
      cardValue: mult,
      net: win - bet,
      multiplier: mult,
      isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * جولة بلينكو (Plinko) واحدة.
 */
function recordPlinko(player, { bet, win, multiplier }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;
  ledger.real.rounds += 1;

  const g = ledger.games.plinko;
  if (g) {
    g.wagered += bet;
    g.paid += win;
    g.bets += 1;
    g.rounds += 1;
  }

  if (!player.plinkoStats) {
    player.plinkoStats = { drops: 0, wagered: 0, won: 0, best: 0 };
  }
  const st = player.plinkoStats;
  st.drops = (st.drops || 0) + 1;
  st.wagered = (st.wagered || 0) + bet;
  st.won = (st.won || 0) + win;
  if (win > (st.best || 0)) st.best = win;

  updatePlayerTotalStats(player, bet, win);

  recordRoundLog({
    roundId: `plinko-${Date.now().toString(36).toUpperCase()}`,
    ts: Date.now(),
    game: 'plinko',
    patternName: 'بلينكو',
    cards: [],
    seats: [{
      id: player.id,
      stake: bet,
      cardIndex: 0,
      cardValue: multiplier,
      net: win - bet,
      multiplier: multiplier,
      isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * رمية بولزآي واحدة (أو «ضاعف أو اخسر» — رهان مستقل بمبلغ الربح السابق).
 */
function recordBullseye(player, { bet, win, multiplier, mode }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;
  ledger.real.rounds += 1;

  const g = ledger.games.bullseye;
  if (g) {
    g.wagered += bet;
    g.paid += win;
    g.bets += 1;
    g.rounds += 1;
  }

  if (!player.bullseyeStats) {
    player.bullseyeStats = { throws: 0, wagered: 0, won: 0, best: 0 };
  }
  const st = player.bullseyeStats;
  st.throws = (st.throws || 0) + 1;
  st.wagered = (st.wagered || 0) + bet;
  st.won = (st.won || 0) + win;
  if (win > (st.best || 0)) st.best = win;

  updatePlayerTotalStats(player, bet, win);

  const MODE_NAMES = { classic: 'كلاسيك', risk: 'المخاطرة', double: 'السهم المزدوج', gamble: 'ضاعف أو اخسر' };
  const name = `بولزآي — ${MODE_NAMES[mode] || mode}`;
  const now = Date.now();
  recordRoundLog({
    roundId: `bullseye-${now.toString(36).toUpperCase()}`,
    ts: now,
    endedAt: now,
    game: 'bullseye',
    patternName: name,
    templateName: name,
    cards: [],
    seats: [{
      id: player.id,
      stake: bet,
      cardIndex: 0,
      cardValue: multiplier,
      net: win - bet,
      multiplier,
      isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * جولة طريق الدجاجة منتهية (اصطدام أو جمع).
 */
function recordChicken(player, { bet, win, multiplier, difficulty, steps }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;
  ledger.real.rounds += 1;

  const g = ledger.games.chicken;
  if (g) {
    g.wagered += bet;
    g.paid += win;
    g.bets += 1;
    g.rounds += 1;
  }

  if (!player.chickenStats) player.chickenStats = { rounds: 0, wagered: 0, won: 0, best: 0 };
  const st = player.chickenStats;
  st.rounds = (st.rounds || 0) + 1;
  st.wagered = (st.wagered || 0) + bet;
  st.won = (st.won || 0) + win;
  if (win > (st.best || 0)) st.best = win;

  updatePlayerTotalStats(player, bet, win);

  const DIFF = { easy: 'سهل', normal: 'قياسي', hard: 'تحدي' };
  const name = `طريق الدجاجة — ${DIFF[difficulty] || difficulty} · ${steps} خطوة`;
  const now = Date.now();
  recordRoundLog({
    roundId: `chicken-${now.toString(36).toUpperCase()}`,
    ts: now,
    endedAt: now,
    game: 'chicken',
    patternName: name,
    templateName: name,
    cards: [],
    seats: [{
      id: player.id, stake: bet, cardIndex: 0, cardValue: multiplier,
      net: win - bet, multiplier, isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * جولة بافالو وايز 3600 (لفة، أو شراء علاوة مع لفاتها المجانية) — تُسجَّل
 * جولةً واحدة: الرهان كاملاً والربح كاملاً.
 */
function recordBuffaloWays(player, { bet, win, buy = false, freeSpins = 0, multiplier = 0 }) {
  ledger.real.wagered += bet;
  ledger.real.paid += win;
  ledger.real.bets += 1;
  ledger.real.rounds += 1;

  if (!ledger.games['buffalo-ways']) ledger.games['buffalo-ways'] = emptyBucket();
  const g = ledger.games['buffalo-ways'];
  g.wagered += bet;
  g.paid += win;
  g.bets += 1;
  g.rounds += 1;

  if (!player.buffaloStats) player.buffaloStats = { spins: 0, buys: 0, freeSpins: 0, wagered: 0, won: 0, best: 0 };
  const st = player.buffaloStats;
  st.spins = (st.spins || 0) + 1;
  if (buy) st.buys = (st.buys || 0) + 1;
  st.freeSpins = (st.freeSpins || 0) + freeSpins;
  st.wagered = (st.wagered || 0) + bet;
  st.won = (st.won || 0) + win;
  if (win > (st.best || 0)) st.best = win;

  updatePlayerTotalStats(player, bet, win);

  const name = buy
    ? `بافالو وايز — شراء علاوة · ${freeSpins} لفة مجانية`
    : (freeSpins ? `بافالو وايز — لفة + ${freeSpins} لفة مجانية` : 'بافالو وايز 3600');
  const now = Date.now();
  recordRoundLog({
    roundId: `buffalo-${now.toString(36).toUpperCase()}`,
    ts: now,
    endedAt: now,
    game: 'buffalo-ways',
    patternName: name,
    templateName: name,
    cards: [],
    seats: [{
      id: player.id, stake: bet, cardIndex: 0, cardValue: multiplier,
      net: win - bet, multiplier, isBot: false
    }],
    house: {
      real: { wagered: bet, paid: win, profit: bet - win, bets: 1 },
      bot: { wagered: 0, paid: 0, profit: 0, bets: 0 },
      total: { wagered: bet, paid: win, profit: bet - win, bets: 1 }
    }
  });

  persistSoon();
}

/**
 * جولة منتهية: إلى السجلّ الدائم (صفّ لا يُحذف — roundLog.js)، وإلى قائمة
 * الذاكرة القصيرة التي يعرضها تاريخ كروت الحظ.
 */
function recordRoundLog(summary) {
  roundArchive.add(summary);
  roundLog.unshift(summary);
  if (roundLog.length > SERVER.historySize) roundLog.length = SERVER.historySize;
  persistSoon();
}

/** صفحة من السجلّ الدائم للوحة الإدارة، الأحدث أولاً. */
async function roundHistory({ before, game, limit } = {}) {
  const page = await roundArchive.list({ before, game, limit });
  return { rounds: page.rounds.map(normalizeRound), next: page.next };
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

function extractPlayerStats() {
  const map = {};
  for (const [id, p] of players.entries()) {
    if (!p) continue;
    map[id] = {
      id: p.id,
      accountId: p.accountId || null,
      username: p.username || null,
      balance: p.balance,
      stats: p.stats,
      neonStats: p.neonStats,
      tankStats: p.tankStats,
      minesStats: p.minesStats,
      plinkoStats: p.plinkoStats,
      bullseyeStats: p.bullseyeStats,
      chickenStats: p.chickenStats,
      buffaloStats: p.buffaloStats,
      slotStats: p.slotStats
    };
  }
  return map;
}

// ------------------------------------------------------------ الحفظ في القاعدة
//
// store_data صفّ واحد تتشاركه كل نسخ الخادم. كانت كل نسخة تكتب ذاكرتها فوقه
// كلّه كل ثانية ونصف — فنسخة فتيّة (ذاكرتها أصفار) أو متأخّرة تمحو تاريخاً
// كاملاً، ونسختان متزامنتان تمحو إحداهما عمل الأخرى. الآن:
//   • ما يُكتب = القاعدة الآن + ما أضافته هذه النسخة منذ آخر مزامنة (merge3)
//   • الكتابة «قارن ثم بدّل» على updated_at: إن كتبت نسخة أخرى بين قراءتنا
//     وكتابتنا نعيد القراءة والدمج — لا تُكتب قيمة محسوبة من حالة قديمة
//   • صفّ لا يُقرأ (تالف) لا يُكتب فوقه أبداً
//   • لا كتابة إن لم يتغيّر شيء

let lastDbSync = 0;
let dbInitialSyncDone = false;
const DB_SYNC_INTERVAL_MS = 3000;
const STORE_KEY = 'store_data';

// كل تعديل يرفع changeSeq، والحفظ الناجح يسجّل ما وصل إليه
let changeSeq = 0;
let savedSeq = 0;

// السجلّ القديم (آخر 100 جولة داخل store_data) يُنسخ إلى السجلّ الدائم مرّة
// واحدة ثم يُعلَّم roundsArchived. لا يُحذف من store_data.
let legacyQueued = false;
let legacyArchived = false;

let casBroken = false;

/** نداءات store_data تمرّ واحداً بعد الآخر داخل النسخة. */
let dbChain = Promise.resolve();
function exclusive(fn) {
  const run = dbChain.then(fn, fn);
  dbChain = run.catch(() => {});
  return run;
}

function parseValue(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** { value, tag } أو null إن لم يوجد الصفّ. صفّ موجود لا يُقرأ يرمي — كي لا نكتب فوقه. */
async function readStoreRow() {
  const row = await supabase.selectOne('site_secrets', `select=value,updated_at&key=eq.${STORE_KEY}`);
  if (!row) return null;
  const value = row.value == null ? {} : parseValue(row.value);
  if (!value || typeof value !== 'object') {
    throw new Error('قيمة store_data في القاعدة غير مقروءة — لن نكتب فوقها');
  }
  return { value: { ...value, ledger: upgradeLedger(value.ledger) }, tag: row.updated_at };
}

function noteLegacy(db) {
  if (legacyQueued || db.roundsArchived || !Array.isArray(db.rounds) || !db.rounds.length) return;
  roundArchive.addLegacy(db.rounds);
  legacyQueued = true;
}

function payloadForSave() {
  const p = currentPayload();
  if (legacyArchived) p.roundsArchived = true;
  return p;
}

function nextStamp(prevTag) {
  const prev = prevTag ? Date.parse(prevTag) : 0;
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString();
}

async function writeStoreRow(row, value) {
  const raw = JSON.stringify(value);
  if (!row) {
    try {
      await supabase.request('/rest/v1/site_secrets', {
        method: 'POST',
        body: [{ key: STORE_KEY, value: raw, updated_at: nextStamp(null) }],
        prefer: 'return=minimal'
      });
      return true;
    } catch (err) {
      if (err && (err.code === '23505' || err.status === 409)) return false;   // سبقتنا نسخة
      throw err;
    }
  }
  const cond = casBroken ? '' : `&updated_at=eq.${supabase.enc(row.tag)}`;
  const rows = await supabase.request(`/rest/v1/site_secrets?key=eq.${STORE_KEY}${cond}&select=key`, {
    method: 'PATCH',
    body: { value: raw, updated_at: nextStamp(row.tag) },
    prefer: 'return=representation'
  });
  return Array.isArray(rows) && rows.length === 1;
}

async function syncWithDb({ force = false } = {}) {
  if (!supabase.configured()) return false;
  if (!force && dbInitialSyncDone && (Date.now() - lastDbSync < DB_SYNC_INTERVAL_MS)) {
    return true;
  }
  return exclusive(async () => {
    try {
      const row = await readStoreRow();
      const db = row ? row.value : {};
      noteLegacy(db);
      // القاعدة + ما في ذاكرتنا ولم يُكتب بعد؛ ثم القاعدة هي الأساس الجديد
      applyPayload(merge3(db, payloadForSave(), syncBase || {}));
      syncBase = clone(db);
      lastDbSync = Date.now();
      dbInitialSyncDone = true;
      return true;
    } catch (err) {
      console.warn('[store] تعذّرت مزامنة البيانات من Supabase:', err.message);
      return false;
    }
  });
}

async function ensureDbLoaded() {
  if (!dbInitialSyncDone) {
    await syncWithDb({ force: true });
  }
}

function saveToDb() {
  if (!supabase.configured()) return Promise.resolve(false);
  return exclusive(saveOnce);
}

async function saveOnce() {
  const roundsOk = await roundArchive.flush();
  if (roundsOk && legacyQueued && !legacyArchived) {
    legacyArchived = true;
    changeSeq += 1;
  }
  if (changeSeq === savedSeq) return roundsOk;

  try {
    let failedTag = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await readStoreRow();
      // فشلت المقارنة والوسم لم يتغيّر: لا منافس — المرشّح نفسه لا يطابق في
      // هذه القاعدة. نكتب بالمفتاح وحده (ما زال دمجاً فوق أحدث قراءة).
      if (row && failedTag !== null && row.tag === failedTag && !casBroken) {
        casBroken = true;
        console.warn('[store] مقارنة updated_at لا تطابق في هذه القاعدة — الكتابة بالمفتاح وحده');
      }
      const db = row ? row.value : {};
      noteLegacy(db);
      const seq = changeSeq;
      const local = payloadForSave();
      const merged = merge3(db, local, syncBase || {});
      merged.savedAt = Date.now();
      if (!(await writeStoreRow(row, merged))) {
        failedTag = row ? row.tag : null;
        continue;
      }
      // ما أُضيف إلى الذاكرة أثناء انتظار الكتابة يبقى فوق ما كُتب
      applyPayload(merge3(merged, payloadForSave(), local));
      syncBase = merged;
      savedSeq = seq;
      lastDbSync = Date.now();
      dbInitialSyncDone = true;
      return roundsOk;
    }
    console.warn('[store] تزاحم متواصل على store_data — يُعاد في الحفظ التالي');
    return false;
  } catch (err) {
    console.error('[store] فشل الحفظ في Supabase:', err.message);
    return false;
  }
}

function persistSoon() {
  dirty = true;
  changeSeq += 1;
}

const hasUnsaved = () => changeSeq !== savedSeq || roundArchive.pendingCount() > 0;

async function flushLocal() {
  if (writing) return;
  writing = true;
  const payload = JSON.stringify({
    savedAt: Date.now(),
    ledger,
    rounds: roundLog.slice(0, SERVER.historySize),
    playerStats: extractPlayerStats(),
    syncBase,
    players: [...players.values()]
  });
  const tmp = `${DATA_FILE}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (err) {
    if (!process.env.VERCEL) {
      console.warn('[store] تعذر الحفظ المحلي:', err.message);
    }
  } finally {
    writing = false;
  }
}

async function flush() {
  dirty = false;
  if (supabase.configured()) {
    await Promise.allSettled([flushLocal(), saveToDb()]);
    return;
  }
  // بلا قاعدة: الملف هو المخزن، والجولات تُلحق بـ rounds.jsonl
  const seq = changeSeq;
  const [, rounds] = await Promise.allSettled([flushLocal(), roundArchive.flush()]);
  if (rounds.status === 'fulfilled' && rounds.value) savedSeq = seq;
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
function attachAccount(row, { quiet = false } = {}) {
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
  // عملة اللاعب ودولته من حسابه (يرثهما من كاشيره) — كل لعبة تعرض عملته
  if (row.currency) player.currency = row.currency;
  if (row.country) player.country = row.country;

  // الرصيد: القاعدة هي الدفتر، فنأخذ رصيدها صعوداً ونزولاً — إلّا إن كان
  // للاعب فروق لعب لم يؤكّد الدفتر كتابتها بعد، فالذاكرة حينها أحدث.
  //
  // ⚠ لا تأخذ «الأعلى بين الذاكرة والقاعدة». جُرِّب ذلك لمنع رصيد يعود
  // للوراء بعد التحديث، فصار كل نقصٍ حقيقي يُتجاهل: سحب الكاشير، وخصم
  // الألعاب الخارجية — القاعدة تنقص والذاكرة باقية على رقمها، فيراهن
  // اللاعب بمال سُحب منه. علّة الرصيد العائد كانت في طابور الفروق
  // (يحذف قبل الكتابة) وأُصلحت هناك.
  if (!accounts.hasPending(row.id)) {
    player.balance = Math.max(0, Math.round(row.balance));
  }

  player.lastSeen = Date.now();
  // إعادة التحقّق الدورية (quiet) لا تكتب store_data: لا إحصاء تغيّر
  if (!quiet) persistSoon();
  return player;
}

/** رمز لم يعد صالحاً (حساب موقوف أو رمز مستبدل): لا يدلّ على لاعب بعد الآن. */
function forgetToken(token) {
  const id = tokenIndex.get(token);
  tokenIndex.delete(token);
  const p = id ? players.get(id) : null;
  if (p && p.token === token) p.token = '';
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
  if (player.accountId) {
    accounts.queueDelta(player.accountId, Math.round(amount));
    if (process.env.VERCEL) {
      accounts.flushDeltas().catch((e) => console.error('[store] flushDeltas error:', e.message));
    }
  }
  persistSoon();
  return true;
}

// ------------------------------------------------------------ محفظة الألعاب
//
// كل رهان وكل ربح يمرّ على القاعدة بنداء ذرّي (gw_debit / gw_credit) يقفل
// صفّ اللاعب ويعيد رصيده الجديد. السؤال كلّه: ماذا نفعل حين لا يعود النداء
// بتأكيد؟ الجواب يتبع ما نعرفه يقيناً عن مصيره:
//
//   رفض      القاعدة قالت لا: رصيد لا يكفي، لاعب غير موجود، مبلغ غير صالح.
//            ← لا رهان. كان الكود يعامل كل خطأ كأنه انقطاع ويخصم من الذاكرة
//              رغم الرفض — أي رهاناً بمال قالت القاعدة إنه غير موجود.
//   مرفوض    ردّت القاعدة بخطأ آخر (قيد، مفتاح أجنبي…) فتراجعت عن النداء
//            كلّه. لم يُطبَّق شيء يقيناً ← عبر طابور الفروق.
//   لم يصل   لا اتصال، لم يُرسَل شيء. الرهان: لا رهان بلا دفتر. الربح: لا
//            يضيع، يدخل الطابور حتى تعود القاعدة.
//   مجهول    انتهت المهلة أو خطأ خادم: ربما نُفِّذ وضاع الردّ وحده. نسأل
//            جدول الجولات عن رقم الحركة قبل أن نقرّر، كي لا نخصم مرّتين ولا
//            نصرف مرّتين.

const REFUSALS = /INSUFFICIENT_BALANCE|PLAYER_NOT_FOUND|PLAYER_INACTIVE|AMOUNT_INVALID/;

function walletOutcome(err, out) {
  if (!err) {
    // ردّت الدالّة بلا تأكيد. إن قالت صراحةً ok:false فهي لم تطبّق شيئاً،
    // والسبب يحدّد أهو رفض أم خلل بنيوي. غير ذلك ردٌّ لا نفهمه ← مجهول.
    if (out && out.ok === false) {
      return REFUSALS.test(String(out.error || out.code || '')) ? 'refused' : 'rejected';
    }
    return 'unknown';
  }
  if (err.kind === 'network') return 'unreached';
  if (err.kind === 'timeout') return 'unknown';
  if (REFUSALS.test(String(err.raw || err.message || ''))) return 'refused';
  if (err.code === '23505') return 'duplicate';   // رقم الحركة مسجّل من قبل
  if (err.status >= 500) return 'unknown';
  if (err.status >= 400) return 'rejected';
  return 'unknown';
}

/** هل سُجّلت هذه الحركة في القاعدة؟ true / false، أو null إن تعذّر السؤال. */
async function wasApplied(accountId, txRef, action) {
  try {
    const rows = await supabase.select('game_rounds',
      `select=id&player_id=eq.${supabase.enc(accountId)}`
      + `&tx_ref=eq.${supabase.enc(txRef)}&action=eq.${action}&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return null;
  }
}

const warnedOnce = new Set();
function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.error(message);
}

/**
 * يمرّر حركة عبر طابور الفروق **وينتظر** كتابتها.
 * على Vercel قد تُجمَّد الدالّة بعد إرسال الردّ، فكتابةٌ لم تُنتظر قد لا
 * تكتمل أبداً — وهذا ما كان يُرجع الرصيد بعد التحديث.
 */
async function throughQueue(player, amount) {
  if (!adjustBalance(player, amount)) return { ok: false, written: false };
  const written = await accounts.flushPlayer(player.accountId);
  return { ok: true, written };
}

function describe(err, out) {
  if (err) return `${err.code || err.status || ''} ${err.raw || err.message || ''}`.trim();
  return out && out.error ? String(out.error) : 'ردّ بلا تأكيد';
}

/** مفتاح تحذير واحد لكل لعبة وسبب — كي لا يغرق السجلّ برسالة لكل رهان. */
function reasonKey(err, out) {
  return (err && (err.code || err.status)) || (out && (out.code || out.error)) || 'unconfirmed';
}

async function gameDebit(gameId, player, amount, txRef) {
  if (amount === 0) return true;
  if (!player.accountId || !supabase.configured()) return adjustBalance(player, -amount);

  let out = null, err = null;
  try {
    out = await supabase.rpc('gw_debit', {
      p_game: gameId,
      p_player: player.accountId,
      p_amount: Math.round(amount),
      p_tx_ref: txRef
    });
  } catch (e) { err = e; }

  if (!err && out && out.ok) {
    player.balance = Math.max(0, Math.round(out.balance));
    return true;
  }

  switch (walletOutcome(err, out)) {
    case 'refused':
      return false;

    case 'rejected': {
      // القاعدة ترفض تسجيل الجولة لسبب بنيوي (لعبة غير مسجّلة في games مثلاً)
      // فتراجعت عن النداء كلّه — الخصم لم يقع. نمرّره عبر الطابور ولا نقبل
      // الرهان حتى يثبت في الدفتر.
      warnOnce(`debit:${gameId}:${reasonKey(err, out)}`,
        `[wallet] ${gameId}: القاعدة لا تسجّل جولاتها (${describe(err, out)}) — الرهانات تمرّ عبر طابور الفروق.`);
      const r = await throughQueue(player, -amount);
      if (!r.ok) return false;
      if (!r.written) {
        // لم يثبت في الدفتر: نلغيه كاملاً — لا رهان يعيش في الذاكرة وحدها
        player.balance = Math.round(player.balance + amount);
        accounts.queueDelta(player.accountId, amount);
        persistSoon();
        return false;
      }
      return true;
    }

    case 'unknown': {
      const applied = await wasApplied(player.accountId, txRef, 'debit');
      if (applied === true) {
        // نُفِّذ وضاع الردّ فقط — الرهان قائم
        player.balance = Math.max(0, Math.round(player.balance - amount));
        return true;
      }
      if (applied === null) {
        console.error(`[wallet] مصير خصم ${txRef} (${amount}) للّاعب ${player.accountId} مجهول — `
          + `رُفض الرهان؛ راجعه يدوياً: قد يكون خُصم بلا جولة.`);
      }
      return false;
    }

    case 'duplicate':
      console.error(`[wallet] رقم الحركة ${txRef} مسجّل من قبل — رُفض الخصم كي لا يتكرّر.`);
      return false;

    default:                                      // unreached: لا رهان بلا دفتر
      return false;
  }
}

async function gameCredit(gameId, player, amount, txRef) {
  if (amount === 0) return true;
  if (!player.accountId || !supabase.configured()) return adjustBalance(player, amount);

  let out = null, err = null;
  try {
    out = await supabase.rpc('gw_credit', {
      p_game: gameId,
      p_player: player.accountId,
      p_amount: Math.round(amount),
      p_tx_ref: txRef
    });
  } catch (e) { err = e; }

  if (!err && out && out.ok) {
    player.balance = Math.max(0, Math.round(out.balance));
    return true;
  }

  const outcome = walletOutcome(err, out);

  if (outcome === 'refused') {
    console.error(`[wallet] القاعدة رفضت صرف ${amount} للّاعب ${player.accountId} (${txRef}): ${describe(err, out)}`);
    return false;
  }
  if (outcome === 'duplicate') {
    console.error(`[wallet] الربح ${txRef} مسجّل من قبل — لم يُصرف مرّة ثانية.`);
    return true;
  }
  if (outcome === 'unknown') {
    const applied = await wasApplied(player.accountId, txRef, 'credit');
    if (applied === true) {
      player.balance = Math.round(player.balance + amount);
      return true;
    }
    if (applied === null) {
      console.error(`[wallet] مصير ربح ${txRef} (${amount}) للّاعب ${player.accountId} مجهول — `
        + `صُرف عبر الطابور؛ راجعه يدوياً فقد يكون مكرّراً.`);
    }
  }
  if (outcome === 'rejected') {
    warnOnce(`credit:${gameId}:${reasonKey(err, out)}`,
      `[wallet] ${gameId}: القاعدة لا تسجّل جولاتها (${describe(err, out)}) — الأرباح تمرّ عبر طابور الفروق.`);
  }

  // الرهان أُخذ والنتيجة حُسمت: الربح لا يضيع. يدخل الطابور حتى يثبت.
  const r = await throughQueue(player, amount);
  if (r.ok && !r.written) {
    console.error(`[wallet] ربح ${amount} للّاعب ${player.accountId} (${txRef}) لم يُكتب بعد — `
      + `معلّق في الطابور ويُعاد المحاولة.`);
  }
  return r.ok;
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
    .map((p) => {
      const s = p.stats || { rounds: 0, wagered: 0, won: 0, best: 0, bestMultiplier: 0 };
      const slot = p.slotStats || { spins: 0, wagered: 0, won: 0 };
      const tank = p.tankStats || { battles: 0, wagered: 0, won: 0 };
      const neon = p.neonStats || { spins: 0, wagered: 0, won: 0 };
      const mines = p.minesStats || { games: 0, wagered: 0, won: 0 };

      const totalRounds = Math.max(s.rounds || 0, (slot.spins || 0) + (tank.battles || 0) + (neon.spins || 0) + (mines.games || 0));
      const totalWagered = Math.max(s.wagered || 0, (slot.wagered || 0) + (tank.wagered || 0) + (neon.wagered || 0) + (mines.wagered || 0));
      const totalWon = Math.max(s.won || 0, (slot.won || 0) + (tank.won || 0) + (neon.won || 0) + (mines.won || 0));

      return {
        id: p.id,
        accountId: p.accountId || null,
        username: p.username || null,
        balance: p.balance,
        rounds: totalRounds,
        wagered: totalWagered,
        won: totalWon,
        net: totalWon - totalWagered,
        houseNet: totalWagered - totalWon,
        best: s.best || 0,
        bestMultiplier: s.bestMultiplier || 0,
        createdAt: p.createdAt,
        lastSeen: p.lastSeen
      };
    })
    .sort((a, b) => b.wagered - a.wagered);
}

/** ملف اللاعب كما يراه هو. الاسم غير مُدرج عمداً: الهوية المعروضة هي المعرّف. */
function publicProfile(player) {
  return {
    id: player.id,
    username: player.username || null,
    balance: player.balance,
    currency: player.currency || 'IQD',
    currencySymbol: (countries.get(player.country) || {}).symbol || null,
    country: player.country || null,
    stats: player.stats
  };
}

roundArchive.setLocalFile(DATA_FILE);
load();
// يكتب فقط حين يوجد ما لم يُحفظ — الكتابة الدورية بلا تغيير كانت تمحو التاريخ
const flushTimer = setInterval(() => { if (hasUnsaved()) flush().catch(() => {}); }, 1500);
if (flushTimer.unref) flushTimer.unref();

module.exports = {
  createPlayer, byToken, forgetToken, byId, adjustBalance, gameDebit, gameCredit, recordRound, attachAccount,
  canUseFaucet, useFaucet, leaderboard, publicProfile, flush, DATA_FILE,
  recordLedger, recordSlot, recordTank, recordNeonSlots, recordMines, recordPlinko, recordBullseye, recordChicken, recordBuffaloWays, ledgerSummary,
  tankDifficultyLedger: () => ledger.tankByDifficulty || {}, recordRoundLog, rounds, roundHistory, allPlayers, playerCount: () => players.size,
  syncWithDb, saveToDb, ensureDbLoaded, isDirty: () => dirty || hasUnsaved()
};
