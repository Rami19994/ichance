'use strict';

// يُقرأ قبل أي وحدة أخرى: بقيّة الملفات تقرأ process.env عند تحميلها
require('./env').load();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const game = require('./luckyCards');
const BotDirector = require('./bots');
const slots = require('./slots');
const slotSession = require('./slotSession');
const adminAuth = require('./adminAuth');
const tankGame = require('./tankGame');
const supabase = require('./supabase');
const accounts = require('./accounts');
const siteConfig = require('./siteConfig');
const adminGate = require('./adminGate');
const gameRegistry = require('./gameRegistry');
const countries = require('./countries');
const neonSlots = require('./neonSlots');
const minesGame = require('./minesGame');
const plinkoGame = require('./plinkoGame');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// فحص الإعدادات قبل الإقلاع — أفضل من اكتشاف خطأ توازن اللعبة بعد النشر
// ---------------------------------------------------------------------------
const check = config.selfCheck();

// ---------------------------------------------------------------------------
// خدمة الملفات الثابتة
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel));

  // حماية من الخروج خارج مجلد public
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'ممنوع' });

  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      // صفحات غير موجودة -> صفحة 404 بسيطة
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><body style="background:#080a0f;color:#e8edf6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:64px;margin:0;color:#f5c542">404</h1><p>الصفحة غير موجودة</p><a href="/" style="color:#f5c542">العودة للرئيسية</a></div></body>');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}"`;

    // no-cache = المتصفح يحتفظ بالنسخة لكنه يسأل الخادم أولاً.
    // هكذا لا نخدم CSS/JS قديماً بعد أي تعديل، وفي نفس الوقت لا نعيد الإرسال بلا داعٍ.
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-XSS-Protection': '1; mode=block',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
async function sendJson(res, status, body) {
  if (store.isDirty()) {
    try { await store.flush(); } catch (e) { console.error('[store] flush error:', e.message); }
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Gate, Authorization, X-Player-Token'
  });
  res.end(payload);
}

function readBody(req, limit = 8 * 1024) {
  if (req.body) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    try { return Promise.resolve(JSON.parse(req.body)); } catch {}
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('الطلب كبير جداً')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('صيغة JSON غير صالحة')); }
    });
    req.on('error', reject);
  });
}

/**
 * يقرأ الجسم نصّاً كما وصل.
 * توقيع المحفظة محسوب على هذا النصّ بالذات؛ التحقّق على كائن أُعيد تركيبه
 * من JSON يقبل أجساماً لم تُوقَّع فعلاً (ترتيب مفاتيح أو مسافات مختلفة).
 */
function readRawBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('الطلب كبير جداً')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenFrom(req, url) {
  return req.headers['x-player-token'] || url.searchParams.get('token') || null;
}

// حدّ بسيط لمعدل الطلبات لمنع الضغط الآلي
const buckets = new Map();
/**
 * عنوان الزائر الحقيقي.
 *
 * خلف وسيط (Vercel، Nginx، Cloudflare) يعطي remoteAddress عنوان الوسيط
 * نفسه، فيتشارك كل زوّار الموقع دلو حدّ واحداً: محاولات أي شخص تقفل على
 * الباقين. أول عنوان في x-forwarded-for هو الزائر الأصلي.
 *
 * تزوير هذه الترويسة ممكن نظرياً، لكن أثره أن يتهرّب المزوِّر من حدّ
 * نفسه لا أن ينتحل غيره — والحماية الحقيقية هنا مسار سرّي 128 بت،
 * والحدّ طبقة إضافية فوقه لا أساسه.
 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const first = String(fwd).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(key, max = 30, windowMs = 10_000) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 30_000).unref?.();

// ---------------------------------------------------------------------------
// البث اللحظي (Server-Sent Events)
// ---------------------------------------------------------------------------
/** @type {Set<{res: import('http').ServerResponse, playerId: string|null}>} */
const clients = new Set();
const bots = new BotDirector(game);

function pushTo(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function broadcastState() {
  for (const client of clients) pushTo(client, 'state', game.stateFor(client.playerId));
  bots.setViewers(countHumanViewers());
}

function countHumanViewers() {
  const ids = new Set();
  let anon = 0;
  for (const c of clients) { if (c.playerId) ids.add(c.playerId); else anon += 1; }
  return ids.size + Math.min(anon, 3);
}

let broadcastQueued = false;
game.on('update', () => {
  // تجميع التحديثات المتقاربة في إطار واحد
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => { broadcastQueued = false; broadcastState(); }, 40);
});

game.on('round-end', (summary) => {
  for (const client of clients) {
    const mine = summary.seats.find((s) => s.id === client.playerId);
    pushTo(client, 'round-end', {
      roundId: summary.roundId,
      templateName: summary.templateName,
      serverSeed: summary.serverSeed,
      seedHash: summary.seedHash,
      cards: summary.cards,
      you: mine || null,
      seats: summary.seats
    });
  }
});

// مزامنة احتياطية + نبضة تبقي الاتصال مفتوحاً
setInterval(() => {
  for (const client of clients) {
    client.res.write(': ping\n\n');
    pushTo(client, 'state', game.stateFor(client.playerId));
  }
  bots.setViewers(countHumanViewers());
}, 5_000).unref?.();

// ---------------------------------------------------------------------------
// المسارات
// ---------------------------------------------------------------------------
/**
 * يحوّل رمز الجلسة إلى لاعب.
 *
 * الذاكرة أولاً (الطريق السريع لكل طلب)، وعند عدم وجوده نسأل قاعدة البيانات
 * مرة واحدة ثم نثبّته في الذاكرة. بلا هذا التخزين كان كل طلب لعب سيدفع
 * ~450 مللي ثانية للوصول إلى Supabase.
 */
async function resolvePlayer(token) {
  if (!token) return null;
  const cached = store.byToken(token);
  if (cached) return cached;
  const row = await accounts.byToken(token);
  if (!row || row.role !== 'player') return null;
  return store.attachAccount(row);
}

/** رمز الكاشير منفصل عن رمز اللاعب: حسابان مختلفان قد يعملان على جهاز واحد. */
async function resolveCashier(req, url) {
  const token = String(req.headers['x-cashier-token'] || url.searchParams.get('ctoken') || '').trim();
  if (!token) return null;
  const row = await accounts.byToken(token);
  return row && row.role === 'cashier' && row.active ? row : null;
}

/**
 * التحقق من صلاحية الوصول إلى مسارات الإدارة:
 * 1. إذا كان الطلب قادماً من دومين الإدارة المخصص (adminDomain).
 * 2. أو إذا كان يحمل برهان البوابة السرية (query ?gate=... أو cookie أو header).
 * 3. أو إذا كان يحمل مفتاح إدارة صحيح ومصادقاً.
 */
async function isAdminAllowed(req, url) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const adminDomain = siteConfig.getAdminDomain();
  if (adminDomain && host === adminDomain) return true;

  const gateProof = url.searchParams.get('gate') ||
                    (req.headers['x-gate'] || '') ||
                    (req.headers['cookie'] || '').match(/ichance_admin_gate=([A-Za-z0-9_-]+)/)?.[1];
  if (gateProof && await adminGate.matches('/' + gateProof)) return true;

  const key = String(req.headers['x-admin-key'] || url.searchParams.get('key') || '').trim();
  if (key && await adminAuth.verify(key)) return true;

  return false;
}

/**
 * اللعبة الموقوفة تُمنع في الخادم لا في الواجهة فقط.
 * إخفاء البطاقة من الردهة وحده لا يمنع من يعرف المسار من الاستمرار باللعب.
 */
const ROUTE_GAME = {
  '/api/join': 'cards', '/api/pick': 'cards',
  '/api/slot/spin': 'slots', '/api/slot/buy': 'slots',
  '/api/tank/start': 'tank',
  '/api/neon-slots/spin': 'neon-slots',
  '/api/mines/start': 'mines',
  '/api/plinko/drop': 'plinko'
};

/** رمز الماستر منفصل عن رمز الكاشير واللاعب: ثلاثة أدوار قد تعمل على جهاز واحد. */
async function resolveMaster(req, url) {
  const token = String(req.headers['x-master-token'] || url.searchParams.get('mtoken') || '').trim();
  if (!token) return null;
  const row = await accounts.byToken(token);
  return row && row.role === 'master' && row.active ? row : null;
}

async function handleApi(req, res, url) {
  await store.ensureDbLoaded();
  const route = url.pathname;
  const token = tokenFrom(req, url);
  const player = await resolvePlayer(token);
  const ip = clientIp(req);

  const gatedGame = ROUTE_GAME[route];
  if (gatedGame && !siteConfig.gameEnabled(gatedGame)) {
    return sendJson(res, 403, { error: 'هذه اللعبة متوقفة مؤقتاً', gameDisabled: gatedGame });
  }

  // ---- إعدادات عامة
  if (route === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      stakes: config.STAKES,
      grid: config.GRID,
      cardCount: config.CARD_COUNT,
      maxPlayers: config.MAX_PLAYERS,
      timing: config.TIMING,
      rtp: Number((check.rtp * 100).toFixed(2)),
      houseEdge: Number((check.houseEdge * 100).toFixed(2)),
      winnersPerRound: config.RULES.winnersPerRound,
      highStake: {
        threshold: config.HIGH_STAKE_THRESHOLD,
        maxMultiplier: config.HIGH_STAKE_MAX_MULTIPLIER
      },
      // جدول الأنماط منشور عمداً: بدونه لا يستطيع اللاعب التحقق من عدالة الجولة
      templates: config.TEMPLATES.map((t) => ({ key: t.key, name: t.name, weight: t.weight, cards: t.cards })),
      botsEnabled: config.BOTS.enabled,
      games: siteConfig.publicGames(),
      faucet: { amount: config.WALLET.faucetAmount, threshold: config.WALLET.faucetThreshold }
    });
  }

  // ---- جلسة اللاعب
  if (route === '/api/session' && req.method === 'POST') {
    if (!rateLimit(`sess:${ip}`, 20, 10_000)) return sendJson(res, 429, { error: 'طلبات كثيرة' });
    if (player) {
      return sendJson(res, 200, { token: player.token, player: store.publicProfile(player) });
    }
    // لا يوجد لعب مجهول — الدخول إلزامي عبر حساب ينشئه الكاشير
    return sendJson(res, 401, { error: 'سجّل الدخول للّعب', needsLogin: true });
  }

  // ---- دخول اللاعب
  if (route === '/api/auth/login' && req.method === 'POST') {
    if (!rateLimit(`login:${ip}`, 12, 60_000)) {
      return sendJson(res, 429, { error: 'محاولات كثيرة — انتظر دقيقة' });
    }
    const body = await readBody(req);
    const out = await accounts.login(body.identifier, body.password, { expectRole: 'player' });
    if (!out.ok) return sendJson(res, 401, { error: out.error });
    const row = await accounts.byToken(out.token);
    const p = store.attachAccount(row);
    return sendJson(res, 200, { token: out.token, player: store.publicProfile(p) });
  }

  if (route === '/api/auth/logout' && req.method === 'POST') {
    await accounts.logout(token);
    return sendJson(res, 200, { ok: true });
  }

  // ═══════════════════════════════ الكاشير ═══════════════════════════════
  // ══════════════════ المحفظة المتصلة (ينادي عليها خادم اللعبة) ══════════════════
  //
  // لا رمز لاعب هنا: الهوية تأتي من رمز الإقلاع، والصلاحية من توقيع HMAC
  // بمفتاح اللعبة. أي نداء بلا توقيع صحيح يُرفض قبل لمس أي رصيد.
  if (route.startsWith('/api/gw/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'طريقة غير مسموحة' });

    const raw = await readRawBody(req);
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { return sendJson(res, 400, { error: 'صيغة JSON غير صالحة' }); }

    const gameId = String(req.headers['x-game-id'] || body.game_id || '').trim();
    const game = gameId ? await gameRegistry.getById(gameId) : null;
    if (!game) return sendJson(res, 401, { error: 'لعبة غير معروفة' });
    if (!game.enabled) return sendJson(res, 403, { error: 'هذه اللعبة متوقفة' });

    const sig = gameRegistry.verifySignature(
      game, raw, req.headers['x-signature'], req.headers['x-timestamp']
    );
    if (!sig.ok) return sendJson(res, 401, { error: sig.error });

    // الهوية من رمز الإقلاع وحده
    const session = await gameRegistry.resolveLaunch(body.token, game.id);
    if (!session) return sendJson(res, 401, { error: 'رمز الإقلاع منتهٍ أو غير صالح' });

    // فروق اللعب الداخلي تُكتب أولاً كي لا يُحسب الرهان على رصيد قديم.
    // إن تعذّرت كتابتها فرصيد القاعدة ناقص الحقيقة — لا نتعامل عليه.
    if (!(await accounts.flushPlayer(session.player_id))) {
      return sendJson(res, 503, { error: 'تعذّرت مزامنة رصيد اللاعب مع قاعدة البيانات — أعد المحاولة بعد لحظات' });
    }

    let out;
    if (route === '/api/gw/balance') {
      out = await gameRegistry.walletBalance(game, session.player_id);
    } else if (route === '/api/gw/debit') {
      out = await gameRegistry.walletDebit(game, session.player_id, {
        amount: body.amount, txRef: body.tx_ref, roundRef: body.round_ref
      });
    } else if (route === '/api/gw/credit') {
      out = await gameRegistry.walletCredit(game, session.player_id, {
        amount: body.amount, txRef: body.tx_ref, roundRef: body.round_ref
      });
    } else if (route === '/api/gw/rollback') {
      out = await gameRegistry.walletRollback(game, {
        targetRef: body.target_ref, txRef: body.tx_ref
      });
    } else {
      return sendJson(res, 404, { error: 'مسار محفظة غير معروف' });
    }

    if (!out.ok) return sendJson(res, 400, { error: out.error });

    // الذاكرة تتبع قاعدة البيانات فوراً كي يرى اللاعب رصيده الصحيح
    // العملية تمّت؛ تعذّر تحديث الذاكرة لا يجعلها «فشلت» — يُحدَّث لاحقاً
    const fresh = await accounts.byId(session.player_id).catch(() => null);
    if (fresh) store.attachAccount(fresh);
    return sendJson(res, 200, out);
  }

  // ═══════════════════════════════ الماستر ═══════════════════════════════
  if (route === '/api/master/login' && req.method === 'POST') {
    if (!rateLimit(`mlogin:${ip}`, 8, 60_000)) {
      return sendJson(res, 429, { error: 'محاولات كثيرة — انتظر دقيقة' });
    }
    const body = await readBody(req);
    const out = await accounts.login(body.identifier, body.password, { expectRole: 'master' });
    if (!out.ok) return sendJson(res, 401, { error: out.error });
    return sendJson(res, 200, { token: out.token, master: out.account });
  }

  if (route.startsWith('/api/master/')) {
    const master = await resolveMaster(req, url);
    if (!master) return sendJson(res, 401, { error: 'جلسة الماستر منتهية — سجّل الدخول' });

    if (route === '/api/master/overview' && req.method === 'GET') {
      const [self, cashiers] = await Promise.all([
        accounts.masterSelf(master.id),
        accounts.masterCashiers(master.id)
      ]);
      return sendJson(res, 200, { master: self, cashiers });
    }

    // لاعبو كاشيريته: يراهم ولا يتصرّف بهم — الإيداع والسحب من صلاحية الكاشير
    if (route === '/api/master/players' && req.method === 'GET') {
      return sendJson(res, 200, { players: await accounts.masterPlayers(master.id) });
    }

    if (route === '/api/master/transactions' && req.method === 'GET') {
      const rows = await accounts.chainLedger({
        masterId: master.id,
        cashierId: url.searchParams.get('cashier') || null,
        limit: url.searchParams.get('limit')
      });
      return sendJson(res, 200, { transactions: rows });
    }

    if (route === '/api/master/cashier' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.createCashier({
        username: body.username, email: body.email, password: body.password,
        country: body.country || master.country,
        startingFloat: 0,              // العهدة تُعطى بعد الإنشاء من عهدة الماستر
        masterId: master.id
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/master/cashier/float' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.masterAdjustCashier({
        masterId: master.id, cashierId: body.cashierId,
        amount: body.amount, topup: body.topup !== false, note: body.note
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/master/cashier/password' && req.method === 'POST') {
      const body = await readBody(req);
      const target = await accounts.byId(body.cashierId);
      if (!target || target.master_id !== master.id) {
        return sendJson(res, 400, { error: 'هذا الكاشير ليس من حساباتك' });
      }
      const out = await accounts.setCashierPassword({
        cashierId: body.cashierId, newPassword: body.password
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/master/cashier/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setActive({
        accountId: body.cashierId, active: !!body.active,
        ownerId: master.id, ownerField: 'master_id'
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/master/cashier/update' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.updateAccount({
        accountId: body.cashierId, username: body.username, email: body.email,
        ownerId: master.id, ownerField: 'master_id'
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/master/cashier/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.deleteAccount({
        accountId: body.cashierId, ownerId: master.id, ownerField: 'master_id'
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: 'مسار ماستر غير معروف' });
  }

  if (route === '/api/cashier/login' && req.method === 'POST') {
    if (!rateLimit(`clogin:${ip}`, 12, 60_000)) {
      return sendJson(res, 429, { error: 'محاولات كثيرة — انتظر دقيقة' });
    }
    const body = await readBody(req);
    const out = await accounts.login(body.identifier, body.password, { expectRole: 'cashier' });
    if (!out.ok) return sendJson(res, 401, { error: out.error });
    return sendJson(res, 200, { token: out.token, cashier: out.account });
  }

  if (route.startsWith('/api/cashier/')) {
    const cashier = await resolveCashier(req, url);
    if (!cashier) return sendJson(res, 401, { error: 'جلسة الكاشير منتهية — سجّل الدخول' });

    if (route === '/api/cashier/overview' && req.method === 'GET') {
      const [self, list] = await Promise.all([
        accounts.cashierSelf(cashier.id),
        accounts.cashierPlayers(cashier.id)
      ]);
      return sendJson(res, 200, { cashier: self, players: list });
    }

    if (route === '/api/cashier/transactions' && req.method === 'GET') {
      const playerId = url.searchParams.get('player') || null;
      const rows = await accounts.transactions({
        cashierId: cashier.id, playerId, limit: url.searchParams.get('limit')
      });
      return sendJson(res, 200, { transactions: rows });
    }

    if (route === '/api/cashier/player' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.createPlayer({
        cashierId: cashier.id,
        username: body.username, email: body.email, password: body.password,
        createdBy: cashier.id
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if ((route === '/api/cashier/deposit' || route === '/api/cashier/withdraw') && req.method === 'POST') {
      const body = await readBody(req);
      const target = await accounts.byId(body.playerId);
      if (!target) return sendJson(res, 400, { error: 'اللاعب غير موجود' });

      // نكتب فروق اللعب المعلّقة أولاً: بدونها قد تُحسب التعبئة على رصيد قديم.
      // وإن تعذّرت كتابتها لا نمضي — سحبٌ على رصيد ناقص يُخرج مالاً غير موجود.
      if (!(await accounts.flushPlayer(target.id))) {
        return sendJson(res, 503, { error: 'تعذّرت مزامنة رصيد اللاعب مع قاعدة البيانات — أعد المحاولة بعد لحظات' });
      }

      const fn = route.endsWith('deposit') ? accounts.deposit : accounts.withdraw;
      const out = await fn({
        cashierId: cashier.id, playerId: body.playerId,
        amount: body.amount, note: body.note
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });

      // الذاكرة تتبع قاعدة البيانات فوراً كي يرى اللاعب رصيده الجديد
      const fresh = await accounts.byId(body.playerId).catch(() => null);
      if (fresh) store.attachAccount(fresh);
      return sendJson(res, 200, out);
    }

    if (route === '/api/cashier/password' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setPlayerPassword({
        playerId: body.playerId, newPassword: body.password, ownerId: cashier.id
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/cashier/player/update' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.updateAccount({
        accountId: body.playerId, username: body.username, email: body.email,
        ownerId: cashier.id, ownerField: 'cashier_id'
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/cashier/player/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.deleteAccount({
        accountId: body.playerId, ownerId: cashier.id, ownerField: 'cashier_id'
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/cashier/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setActive({
        accountId: body.playerId, active: !!body.active, ownerId: cashier.id
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: 'مسار كاشير غير معروف' });
  }

  // كل ما يلي يحتاج لاعباً معروفاً
  const needsPlayer = ['/api/me', '/api/join', '/api/leave', '/api/pick', '/api/faucet'];
  if (needsPlayer.includes(route) && !player) {
    return sendJson(res, 401, { error: 'جلسة غير معروفة، حدّث الصفحة' });
  }

  if (route === '/api/me' && req.method === 'GET') {
    return sendJson(res, 200, { player: store.publicProfile(player) });
  }

  if (route === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, game.stateFor(player ? player.id : null));
  }

  if (route === '/api/join' && req.method === 'POST') {
    if (!rateLimit(`act:${player.id}`, 40, 10_000)) return sendJson(res, 429, { error: 'طلبات كثيرة' });
    const body = await readBody(req);
    const result = await game.join(player.id, Number(body.stake));
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, { ...result, player: store.publicProfile(player) });
  }

  if (route === '/api/leave' && req.method === 'POST') {
    if (!rateLimit(`act:${player.id}`, 40, 10_000)) return sendJson(res, 429, { error: 'طلبات كثيرة' });
    const result = await game.leave(player.id);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, { ...result, player: store.publicProfile(player) });
  }

  if (route === '/api/pick' && req.method === 'POST') {
    if (!rateLimit(`act:${player.id}`, 40, 10_000)) return sendJson(res, 429, { error: 'طلبات كثيرة' });
    const body = await readBody(req);
    const result = game.pick(player.id, Number(body.cardIndex));
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/faucet' && req.method === 'POST') {
    if (!rateLimit(`faucet:${player.id}`, 5, 60_000)) return sendJson(res, 429, { error: 'طلبات كثيرة' });
    const result = store.useFaucet(player);
    if (!result.ok) return sendJson(res, 400, { error: result.reason });
    return sendJson(res, 200, { ...result, player: store.publicProfile(player) });
  }

  if (route === '/api/history' && req.method === 'GET') {
    return sendJson(res, 200, { rounds: game.recentHistory(12) });
  }

  if (route === '/api/leaderboard' && req.method === 'GET') {
    return sendJson(res, 200, { top: store.leaderboard(10) });
  }

  // ------------------------------------------------------------------ السلوتس
  if (route === '/api/slot/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      name: 'صيّاد الجوائز',
      reels: slots.REELS,
      rows: slots.ROWS,
      ways: slots.WAYS,
      stakes: slotSession.SLOT_STAKES,
      maxStake: slots.MAX_STAKE,
      symbols: slots.SYMBOLS,
      paytable: slots.PAYTABLE,
      multiplierLadder: slots.MULTIPLIER_LADDER,
      multiplierResetsOnLoss: slots.MULTIPLIER_RESETS_ON_LOSS,
      freeSpins: slots.FREE_SPINS,
      featureBuyCost: slots.FEATURE_BUY_COST,
      maxWinMultiplier: slots.MAX_WIN_MULTIPLIER,
      maxSessionMultiplier: slots.MAX_SESSION_MULTIPLIER,
      // مقيسة لا مكتوبة يدوياً — انظر slots.MEASURED
      rtp: slots.MEASURED.rtp,
      hitRate: slots.MEASURED.hitRate,
      featureOdds: slots.MEASURED.featureOdds,
      minReelsToWin: slots.MIN_REELS_TO_WIN,
      // الأشرطة منشورة: بدونها لا يستطيع اللاعب التحقق من أي دورة
      strips: { base: slots.STRIPS, free: slots.FREE_STRIPS }
    });
  }

  const slotRoutes = ['/api/slot/state', '/api/slot/spin', '/api/slot/buy', '/api/slot/rotate'];
  if (slotRoutes.includes(route) && !player) {
    return sendJson(res, 401, { error: 'جلسة غير معروفة، حدّث الصفحة' });
  }

  if (route === '/api/slot/state' && req.method === 'GET') {
    return sendJson(res, 200, slotSession.stateFor(player));
  }

  if (route === '/api/slot/spin' && req.method === 'POST') {
    // حدّ أعلى من لعبة الكروت: السلوتس لعبة سريعة بطبعها
    if (!rateLimit(`slot:${player.id}`, 120, 10_000)) {
      return sendJson(res, 429, { error: 'دورات كثيرة جداً — تمهّل قليلاً' });
    }
    const body = await readBody(req);
    const result = await slotSession.spin(player, body.bet);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/slot/buy' && req.method === 'POST') {
    if (!rateLimit(`slotbuy:${player.id}`, 20, 10_000)) {
      return sendJson(res, 429, { error: 'طلبات كثيرة' });
    }
    const body = await readBody(req);
    const result = await slotSession.buyFeature(player, Number(body.bet));
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/slot/rotate' && req.method === 'POST') {
    if (slotSession.activeFeatures.has(player.id)) {
      return sendJson(res, 400, { error: 'لا يمكن تدوير البذرة أثناء ميزة جارية' });
    }
    return sendJson(res, 200, slotSession.rotateSeed(player));
  }

  // ───────────────────────── بوابة الإدارة السرّية ─────────────────────────
  // البرهان هنا هو معرفة المسار السرّي، لا مفتاح الإدارة — فهذه البوابة
  // وُجدت أصلاً لمن فقد المفتاح أو لا يريد حفظه.
  // تشخيص مفتوح: لا يكشف المسار، ويقول ما الذي يمنع البوابة من العمل.
  // بدونه يبقى المالك يخمّن بين 404 و429 بلا دليل.
  if (route === '/api/admin/gate/status' && req.method === 'GET') {
    return sendJson(res, 200, await adminGate.status());
  }

  if (route === '/api/admin/gate' || route === '/api/admin/gate/path') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'طريقة غير مسموحة' });

    // نفحص المسار أولاً ثم نحدّ.
    //
    // معرفة المسار السرّي هي إثبات الهوية هنا؛ من يعرفه هو المالك، ومن
    // لا يعرفه مهاجم. خنق الاثنين بدلو واحد كان يقفل على المالك — وهو
    // يولّد مفتاحاً كل مرة يدخل — بسبب تخمينات غيره، بينما المهاجم لا
    // يخسر شيئاً. فالحدّ الصارم يقع على المحاولات **الخاطئة** وحدها.
    // بوابة غير مضبوطة أصلاً ≠ مسار خاطئ.
    // على Serverless لا قرص دائم، فالمسار يأتي من متغيّر البيئة. لو كان
    // ناقصاً يفشل كل نداء بـ404 ثم يصطدم بحدّ المحاولات، فيظنّ المالك أن
    // رمزه خطأ وهو صحيح. نقولها صراحةً — وهذا لا يكشف المسار لأحد.
    const gateState = await adminGate.current();
    if (!gateState.path) {
      return sendJson(res, 503, {
        error: 'تعذّر حفظ مسار البوابة — تأكّد من اتصال قاعدة البيانات'
      });
    }

    const proof = String(req.headers['x-gate'] || '').trim();
    if (!(await adminGate.matches(`/${proof}`))) {
      if (!rateLimit(`gatebad:${ip}`, 8, 10 * 60_000)) {
        return sendJson(res, 429, { error: 'محاولات كثيرة — انتظر قليلاً' });
      }
      return sendJson(res, 404, { error: 'غير موجود' });
    }

    // مسار صحيح: حدّ واسع يمنع حلقة مفتوحة أو ضغطاً متكرّراً بالخطأ فقط
    if (!rateLimit(`gateok:${ip}`, 40, 60_000)) {
      return sendJson(res, 429, { error: 'طلبات كثيرة جداً — انتظر دقيقة' });
    }

    if (route === '/api/admin/gate') {
      const out = await adminAuth.rotate();
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      console.log('[gate] وُلّد مفتاح إدارة جديد من البوابة');
      return sendJson(res, 200, { ok: true, key: out.key });
    }

    const moved = await adminGate.rotatePath();
    if (!moved.ok) return sendJson(res, 400, { error: moved.error });
    return sendJson(res, 200, { ok: true, path: moved.path });
  }

  // ───────────────────── إقلاع لعبة خارجية ─────────────────────
  if (route === '/api/game/launch' && req.method === 'POST') {
    if (!player) return sendJson(res, 401, { error: 'سجّل الدخول للّعب', needsLogin: true });
    const body = await readBody(req);
    const game = await gameRegistry.getBySlug(body.slug);
    if (!game) return sendJson(res, 404, { error: 'لعبة غير معروفة' });
    if (!game.enabled) return sendJson(res, 403, { error: 'هذه اللعبة متوقفة مؤقتاً' });

    const launch = await gameRegistry.createLaunch(game, {
      accountId: player.accountId, displayId: player.id
    });
    if (!launch.ok) return sendJson(res, 500, { error: launch.error });
    return sendJson(res, 200, {
      url: launch.url,
      expiresAt: launch.expiresAt,
      game: { slug: game.slug, name: game.name, config: game.config }
    });
  }

  // قائمة الألعاب الخارجية للردهة — بلا مفاتيح
  if (route === '/api/games' && req.method === 'GET') {
    const list = await gameRegistry.listGames({ onlyEnabled: true });
    return sendJson(res, 200, {
      games: list.map((g) => ({
        slug: g.slug, name: g.name, category: g.category,
        cover_url: g.cover_url, accent: g.accent
      }))
    });
  }

  // ------------------------------------------------------ معركة الدبابات
  if (route === '/api/tank/config' && req.method === 'GET') {
    return sendJson(res, 200, tankGame.publicConfig());
  }

  const tankRoutes = ['/api/tank/state', '/api/tank/start', '/api/tank/finish', '/api/tank/rotate'];
  if (tankRoutes.includes(route) && !player) {
    return sendJson(res, 401, { error: 'جلسة غير معروفة، حدّث الصفحة' });
  }

  if (route === '/api/tank/state' && req.method === 'GET') {
    return sendJson(res, 200, tankGame.stateFor(player));
  }

  if (route === '/api/tank/start' && req.method === 'POST') {
    if (!rateLimit(`tank:${player.id}`, 20, 30_000)) {
      return sendJson(res, 429, { error: 'معارك كثيرة بسرعة — تمهّل قليلاً' });
    }
    const body = await readBody(req);
    const result = await tankGame.start(player, {
      bet: body.bet, difficulty: body.difficulty, clientSeed: body.clientSeed
    });
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/tank/finish' && req.method === 'POST') {
    // سجلّ الضغطات أكبر بكثير من أي طلب آخر: 2400 نبضة قد تحمل تغيّراً في كلٍّ
    // منها. الحدّ الافتراضي 8 كيلوبايت يقطع المعارك الطويلة، فنرفعه هنا وحده.
    const body = await readBody(req, 96 * 1024);
    const result = await tankGame.finish(player, { inputs: body.inputs });
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/tank/rotate' && req.method === 'POST') {
    const state = tankGame.stateFor(player);
    if (state.active) return sendJson(res, 400, { error: 'لا يمكن تدوير البذرة أثناء معركة' });
    return sendJson(res, 200, tankGame.rotateSeed(player));
  }

  // ------------------------------------------------------------- نيون فيغاس سلوتس
  const neonRoutes = ['/api/neon-slots/state', '/api/neon-slots/spin'];
  if (neonRoutes.includes(route) && !player) {
    return sendJson(res, 401, { error: 'سجّل الدخول للّعب', needsLogin: true });
  }

  if (route === '/api/neon-slots/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      player: store.publicProfile(player),
      symbols: neonSlots.SYMBOLS,
      paylines: neonSlots.PAYLINES,
      reels: neonSlots.REEL_STRIPS
    });
  }

  if (route === '/api/neon-slots/spin' && req.method === 'POST') {
    if (!rateLimit(`neon-spin:${player.id}`, 30, 10_000)) {
      return sendJson(res, 429, { error: 'دورات سريعة جداً — تمهّل قليلاً' });
    }
    const body = await readBody(req);
    const result = await neonSlots.playSpin(player, {
      bet: body.bet,
      lineCount: body.lines || body.lineCount
    });
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, { ...result, player: store.publicProfile(player) });
  }

  // ------------------------------------------------------------- مناجم الحظ (Stake Mines)
  if (route === '/api/mines/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      totalTiles: minesGame.TOTAL_TILES,
      minMines: minesGame.MIN_MINES,
      maxMines: minesGame.MAX_MINES,
      rtp: Number((minesGame.DEFAULT_RTP * 100).toFixed(1)),
      minStake: minesGame.MIN_STAKE,
      maxStake: minesGame.MAX_STAKE
    });
  }

  const minesRoutes = [
    '/api/mines/state',
    '/api/mines/start',
    '/api/mines/reveal',
    '/api/mines/cashout',
    '/api/mines/random-pick'
  ];
  if (minesRoutes.includes(route) && !player) {
    return sendJson(res, 401, { error: 'سجّل الدخول للّعب', needsLogin: true });
  }

  if (route === '/api/mines/state' && req.method === 'GET') {
    return sendJson(res, 200, minesGame.stateFor(player));
  }

  if (route === '/api/mines/start' && req.method === 'POST') {
    if (!rateLimit(`mines-start:${player.id}`, 20, 10_000)) {
      return sendJson(res, 429, { error: 'طلبات كثيرة — تمهّل قليلاً' });
    }
    const body = await readBody(req);
    const result = await minesGame.startGame(player, {
      bet: body.bet,
      minesCount: body.minesCount || body.mines,
      clientSeed: body.clientSeed
    });
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/mines/reveal' && req.method === 'POST') {
    if (!rateLimit(`mines-act:${player.id}`, 60, 10_000)) {
      return sendJson(res, 429, { error: 'نقرات سريعة جداً' });
    }
    const body = await readBody(req);
    const result = await minesGame.revealTile(player, body.tileIndex !== undefined ? body.tileIndex : body.tile);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/mines/cashout' && req.method === 'POST') {
    if (!rateLimit(`mines-act:${player.id}`, 30, 10_000)) {
      return sendJson(res, 429, { error: 'طلبات كثيرة' });
    }
    const result = await minesGame.cashOut(player);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  if (route === '/api/mines/random-pick' && req.method === 'POST') {
    if (!rateLimit(`mines-act:${player.id}`, 60, 10_000)) {
      return sendJson(res, 429, { error: 'نقرات سريعة جداً' });
    }
    const result = await minesGame.randomPick(player);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  // ------------------------------------------------------------- بلينكو (Plinko)
  if (route === '/api/plinko/state' && req.method === 'GET') {
    return sendJson(res, 200, plinkoGame.stateFor(player));
  }

  if (route === '/api/plinko/drop' && req.method === 'POST') {
    if (!player) return sendJson(res, 401, { error: 'سجّل الدخول للّعب', needsLogin: true });
    if (!rateLimit(`plinko-drop:${player.id}`, 20, 10_000)) {
      return sendJson(res, 429, { error: 'طلبات كثيرة — تمهّل قليلاً' });
    }
    const body = await readBody(req);
    const result = await plinkoGame.dropBall(player, { bet: body.bet, clientSeed: body.clientSeed });
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, result);
  }

  // ------------------------------------------------------------------ الإدارة
  if (route === '/api/countries' && req.method === 'GET') {
    return sendJson(res, 200, { countries: countries.list() });
  }

  if (route.startsWith('/api/admin/')) {
    // قائمة الدول لا تحتاج سرّاً — متاحة للقوائم المنسدلة في اللوحة وخارجها دائماً
    if (route === '/api/admin/countries' && req.method === 'GET') {
      return sendJson(res, 200, { countries: countries.list() });
    }

    // حالة المفتاح: تُقرأ بلا مصادقة لأن الصفحة تحتاجها قبل الدخول لتعرف
    // أي شاشة تعرض. لا تكشف أي سرّ — انظر adminAuth.publicStatus().
    if (route === '/api/admin/status' && req.method === 'GET') {
      return sendJson(res, 200, await adminAuth.publicStatus());
    }

    // إنشاء المفتاح أول مرة من المتصفح. بلا مصادقة بالضرورة (لا مفتاح بعد)،
    // لذا تحميه نافذة زمنية في adminAuth + حدّ صارم للمحاولات هنا.
    if (route === '/api/admin/claim' && req.method === 'POST') {
      if (!rateLimit(`claim:${ip}`, 5, 60_000)) return sendJson(res, 429, { error: 'محاولات كثيرة' });
      const body = await readBody(req);
      const result = await adminAuth.claim(body.key);
      if (!result.ok) return sendJson(res, 400, { error: result.error });
      return sendJson(res, 200, { ok: true });
    }

    const key = String(req.headers['x-admin-key'] || url.searchParams.get('key') || '').trim();
    const isAuthed = key ? (await adminAuth.verify(key)) : false;

    // فحص عزل دومين الإدارة أو برهان البوابة السرية
    if (!isAuthed) {
      const allowedByGate = await isAdminAllowed(req, url);
      if (!allowedByGate) {
        if (key) {
          if (!rateLimit(`admin:${ip}`, 10, 60_000)) return sendJson(res, 429, { error: 'محاولات كثيرة' });
          return sendJson(res, 401, { error: 'مفتاح الإدارة غير صحيح أو تم إلغاؤه' });
        }
        return sendJson(res, 404, { error: 'الصفحة غير موجودة' });
      }
    }

    if (!isAuthed) {
      if (!rateLimit(`admin:${ip}`, 10, 60_000)) return sendJson(res, 429, { error: 'محاولات كثيرة' });
      return sendJson(res, 401, { error: 'مفتاح الإدارة غير صحيح أو تم إلغاؤه' });
    }

    // إدارة مفاتيح وأجهزة الأدمن المتعددة
    if (route === '/api/admin/keys' && req.method === 'GET') {
      return sendJson(res, 200, { keys: await adminAuth.listKeys() });
    }

    if (route === '/api/admin/keys/add' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await adminAuth.addKey(body.key || adminAuth.generateKey(), { name: body.name });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/keys/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await adminAuth.revokeKey(body.keyId);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    // إعدادات دومين الإدارة المخصص
    if (route === '/api/admin/domain' && req.method === 'GET') {
      return sendJson(res, 200, {
        adminDomain: siteConfig.getAdminDomain(),
        currentHost: req.headers.host || null
      });
    }

    if (route === '/api/admin/domain' && req.method === 'POST') {
      const body = await readBody(req);
      const out = siteConfig.setAdminDomain(body.domain);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/games' && req.method === 'GET') {
      return sendJson(res, 200, { games: siteConfig.report() });
    }

    if (route === '/api/admin/games' && req.method === 'POST') {
      const body = await readBody(req);
      const out = siteConfig.setGame(body.game, body.enabled);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, { games: siteConfig.report() });
    }


    if (route === '/api/admin/tiers' && req.method === 'GET') {
      return sendJson(res, 200, { tiers: await accounts.commissionTiers() });
    }

    if (route === '/api/admin/tiers' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setCommissionTiers(body.tiers);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, { tiers: await accounts.commissionTiers() });
    }

    if (route === '/api/admin/cashier/country' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setCashierCountry(body.cashierId, body.country);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/games/external' && req.method === 'GET') {
      const list = await gameRegistry.listGames();
      return sendJson(res, 200, {
        games: list.map(gameRegistry.publicGame),
        rounds: await gameRegistry.recentRounds({ limit: 40 })
      });
    }

    if (route === '/api/admin/games/external' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await gameRegistry.createGame({
        slug: body.slug, name: body.name, category: body.category,
        launchUrl: body.launchUrl, coverUrl: body.coverUrl, accent: body.accent,
        config: body.config, sortOrder: body.sortOrder
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/games/external/update' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await gameRegistry.updateGame(body.id, body);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/games/external/secret' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await gameRegistry.rotateSecret(body.id);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/games/external/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await gameRegistry.deleteGame(body.id);
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/masters' && req.method === 'GET') {
      return sendJson(res, 200, { masters: await accounts.allMasters() });
    }

    if (route === '/api/admin/master' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.createMaster({
        username: body.username, email: body.email, password: body.password,
        country: body.country, startingFloat: body.startingFloat, unlimited: body.unlimited
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/master/float' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.adjustMasterFloat({
        masterId: body.masterId, amount: body.amount,
        topup: body.topup !== false, note: body.note
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/master/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setActive({ accountId: body.masterId, active: !!body.active });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/master/cashiers' && req.method === 'GET') {
      const id = url.searchParams.get('master');
      if (!id) return sendJson(res, 400, { error: 'حدّد الماستر' });
      const [master, cashiers, players] = await Promise.all([
        accounts.masterSelf(id),
        accounts.masterCashiers(id),
        accounts.masterPlayers(id)
      ]);
      return sendJson(res, 200, { master, cashiers, players });
    }

    // شبكة الكاشير وتفاصيل اللاعبين المسجلين عن طريقه
    if (route === '/api/admin/cashier/network' && req.method === 'GET') {
      const id = url.searchParams.get('cashier');
      if (!id) return sendJson(res, 400, { error: 'حدّد الكاشير' });
      const [cashier, players] = await Promise.all([
        accounts.cashierSelf(id),
        accounts.cashierPlayers(id)
      ]);
      return sendJson(res, 200, { cashier, players });
    }

    // إنشاء حساب لاعب جديد من لوحة الإدارة
    if (route === '/api/admin/player' && req.method === 'POST') {
      const body = await readBody(req);
      // الرصيد الافتتاحي كان يُكتب في الحساب مباشرة بلا أي حركة في الدفتر —
      // مالٌ يظهر من لا شيء ولا يراه تقرير. الآن: حساب بصفر، ثم إيداع مسجَّل
      // عبر كاشير اللاعب كأي إيداع آخر.
      const opening = Math.max(0, Math.round(Number(body.balance) || 0));
      if (opening > 0 && !body.cashierId) {
        return sendJson(res, 400, { error: 'الرصيد الافتتاحي يمرّ عبر كاشير — اختر كاشيراً للّاعب أو اتركه صفراً' });
      }
      const out = await accounts.createPlayer({
        username: body.username,
        email: body.email,
        password: body.password,
        cashierId: body.cashierId || null,
        createdBy: null
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      if (opening > 0) {
        const dep = await accounts.deposit({
          cashierId: body.cashierId, playerId: out.player.id,
          amount: opening, note: 'رصيد افتتاحي من الإدارة'
        });
        if (!dep.ok) {
          return sendJson(res, 200, { ...out, warning: `أُنشئ الحساب لكن الرصيد الافتتاحي لم يُودَع: ${dep.error}` });
        }
        out.player.balance = dep.player_balance != null ? dep.player_balance : opening;
      }
      return sendJson(res, 200, out);
    }

    // نقل كاشير بين الماسترية — للإدارة وحدها
    if (route === '/api/admin/cashier/master' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setCashierMaster({
        cashierId: body.cashierId, masterId: body.masterId || null
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    // كشف السلسلة كاملاً: أدمن←ماستر، ماستر←كاشير، كاشير←لاعب
    if (route === '/api/admin/chain' && req.method === 'GET') {
      const kindsParam = url.searchParams.get('kinds');
      const rows = await accounts.chainLedger({
        masterId: url.searchParams.get('master') || null,
        cashierId: url.searchParams.get('cashier') || null,
        playerId: url.searchParams.get('player') || null,
        kinds: kindsParam ? kindsParam.split(',').filter(Boolean) : null,
        limit: url.searchParams.get('limit')
      });
      return sendJson(res, 200, { transactions: rows });
    }

    // الإدارة تودع وتسحب لأي لاعب مباشرة، عبر كاشيره كي يبقى الأثر متّصلاً
    if ((route === '/api/admin/player/deposit' || route === '/api/admin/player/withdraw')
        && req.method === 'POST') {
      const body = await readBody(req);
      const target = await accounts.byId(body.playerId);
      if (!target || target.role !== 'player') return sendJson(res, 400, { error: 'اللاعب غير موجود' });
      if (!target.cashier_id) return sendJson(res, 400, { error: 'اللاعب بلا كاشير — اربطه بكاشير أولاً' });

      if (!(await accounts.flushPlayer(target.id))) {
        return sendJson(res, 503, { error: 'تعذّرت مزامنة رصيد اللاعب مع قاعدة البيانات — أعد المحاولة بعد لحظات' });
      }
      const fn = route.endsWith('deposit') ? accounts.deposit : accounts.withdraw;
      const out = await fn({
        cashierId: target.cashier_id, playerId: target.id,
        amount: body.amount, note: body.note || 'من الإدارة'
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      const fresh = await accounts.byId(target.id).catch(() => null);
      if (fresh) store.attachAccount(fresh);
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/account/update' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.updateAccount({
        accountId: body.accountId, username: body.username, email: body.email
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if ((route === '/api/admin/account/delete' || route === '/api/admin/master/delete' || route === '/api/admin/cashier/delete') && req.method === 'POST') {
      const body = await readBody(req);
      const accountId = body.accountId || body.id || body.masterId || body.cashierId || body.playerId;
      if (!accountId) return sendJson(res, 400, { error: 'معرّف الحساب مطلوب' });
      // الإدارة أيضاً لا تمحو مال لاعب ولا سجلّاً مالياً — انظر accounts.deleteAccount
      const out = await accounts.deleteAccount({ accountId });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/players' && req.method === 'GET') {
      return sendJson(res, 200, { players: await accounts.allPlayers({ limit: 500 }) });
    }

    if (route === '/api/admin/cashiers' && req.method === 'GET') {
      const [list, tx] = await Promise.all([
        accounts.allCashiers(),
        accounts.transactions({ limit: 60 })
      ]);
      return sendJson(res, 200, { connected: true, cashiers: list, transactions: tx });
    }

    if (route === '/api/admin/cashier' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.createCashier({
        username: body.username,
        email: body.email,
        password: body.password,
        startingFloat: body.startingFloat,
        unlimited: body.unlimited,
        country: body.country
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/cashier/float' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.adjustCashierFloat({
        cashierId: body.cashierId, amount: body.amount,
        topup: body.topup !== false, note: body.note
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/cashier/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setActive({ accountId: body.cashierId, active: !!body.active });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (route === '/api/admin/cashier/password' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await accounts.setCashierPassword({
        cashierId: body.cashierId,
        newPassword: body.password
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/admin/database' && req.method === 'GET') {
      const status = supabase.configured() ? await supabase.ping() : { ok: false, error: 'غير مربوطة' };
      return sendJson(res, 200, {
        configured: supabase.configured(),
        source: supabase.configured() ? supabase.config().source : null,
        url: supabase.configured() ? supabase.config().url : null,
        reachable: status.ok,
        error: status.ok ? null : status.error,
        pendingDeltas: accounts.pendingCount()
      });
    }

    if (route === '/api/admin/database' && req.method === 'POST') {
      const body = await readBody(req);
      const out = supabase.saveConfig({ url: body.url, key: body.key });
      if (!out.ok) return sendJson(res, 400, { error: out.error });
      const ping = await supabase.ping();
      if (!ping.ok) return sendJson(res, 400, { error: `حُفظت لكن الاتصال فشل: ${ping.error}` });
      return sendJson(res, 200, { ok: true });
    }

    // تغيير المفتاح من داخل اللوحة — بلا تيرمنال. بلا `key` يولّد مفتاحاً قوياً.
    if (route === '/api/admin/rotate' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await adminAuth.rotate(body.key);
      if (!result.ok) return sendJson(res, 400, { error: result.error });
      return sendJson(res, 200, { ok: true, key: result.key, generated: result.generated });
    }

    if (route === '/api/admin/overview' && req.method === 'GET') {
      await store.syncWithDb({ force: true });
      const ledger = store.ledgerSummary();
      const rounds = store.rounds(60);
      // جلب اللاعبين الحقيقيين من قاعدة البيانات (Supabase أو محلي)
      const realAccounts = await accounts.allPlayers({ limit: 200 }).catch(() => []);
      // دمج بيانات اللعب مع بيانات الحسابات
      const gamePlayersMap = {};
      for (const p of store.allPlayers()) {
        if (p.id) gamePlayersMap[p.id] = p;
        if (p.accountId) gamePlayersMap[p.accountId] = p;
      }
      const mergedPlayers = realAccounts.map((acc) => {
        const gp = gamePlayersMap[acc.id] || gamePlayersMap[acc.display_id] || {};
        const liveBalance = (gp.balance !== undefined && gp.balance !== null) ? gp.balance : Number(acc.balance || 0);
        return {
          id: acc.display_id || acc.id,
          realId: acc.id,
          balance: liveBalance,
          rounds: gp.rounds || 0,
          wagered: gp.wagered || 0,
          won: gp.won || 0,
          houseNet: gp.houseNet || 0,
          username: acc.username,
          cashierId: acc.cashier_id || null,
          cashierName: acc.cashier_username || null,
          masterId: acc.master_id || null,
          masterName: acc.master_username || null,
          country: acc.country
        };
      });
      // أضف أي لاعبين في الجلسة غير موجودين في Supabase (ضيوف)
      const realIds = new Set(realAccounts.map((a) => a.id).concat(realAccounts.map((a) => a.display_id)));
      for (const p of store.allPlayers()) {
        if (!realIds.has(p.id) && (!p.accountId || !realIds.has(p.accountId))) {
          mergedPlayers.push({
            id: p.id,
            realId: p.accountId || p.id,
            balance: p.balance,
            rounds: p.rounds || 0,
            wagered: p.wagered || 0,
            won: p.won || 0,
            houseNet: p.houseNet || 0,
            username: p.username || p.id,
            cashierId: null,
            cashierName: null,
            masterId: null,
            masterName: null,
            country: 'IQ'
          });
        }
      }
      return sendJson(res, 200, {
        ledger,
        tank: tankGame.difficultyReport(store.tankDifficultyLedger()),
        economics: buildEconomics(rounds, ledger),
        live: game.adminSnapshot(),
        rounds,
        players: mergedPlayers,
        playerCount: Math.max(mergedPlayers.length, store.playerCount()),
        online: countHumanViewers(),
        settings: {
          theoreticalRtp: Number((check.rtp * 100).toFixed(2)),
          houseEdge: Number((check.houseEdge * 100).toFixed(2)),
          winnersPerRound: config.RULES.winnersPerRound,
          stdDev: Number(check.stdDev.toFixed(4)),
          timing: config.TIMING,
          highStakeThreshold: config.HIGH_STAKE_THRESHOLD,
          highStakeMaxMultiplier: config.HIGH_STAKE_MAX_MULTIPLIER,
          stakes: config.STAKES,
          maxPlayers: config.MAX_PLAYERS,
          botsEnabled: config.BOTS.enabled,
          templates: config.TEMPLATES.map((t) => ({
            key: t.key,
            name: t.name,
            weight: t.weight,
            sum: t.cards.reduce((a, b) => a + b, 0),
            winners: t.cards.filter((m) => m > 1).length,
            losers: t.cards.filter((m) => m === 0).length,
            refunds: t.cards.filter((m) => m === 1).length,
            top: Math.max(...t.cards)
          }))
        }
      });

    }

    return sendJson(res, 404, { error: 'مسار إدارة غير معروف' });
  }

  return sendJson(res, 404, { error: 'مسار غير معروف' });
}

/**
 * مؤشرات دراسة الجدوى، مقيسة من الجولات الفعلية لا مفترضة.
 * كل رقم هنا مصدره سجل الجولات، وتُفصل أرقام البوتات عن البشر.
 */
function buildEconomics(rounds, ledger) {
  const played = rounds.filter((r) => r.house?.total?.bets > 0);

  // الدورة النظرية الكاملة. أي جولة تتجاوز ضِعفها لم تكن جولة حقيقية بل توقّفاً
  // (نوم الجهاز، تعليق العملية)، فاستبعادها أدقّ من إدخالها في الحساب.
  const nominalCycleMs = config.TIMING.betting + config.TIMING.playing + config.TIMING.results;
  const cycleCeilingMs = nominalCycleMs * 2;

  const rawDurations = played.map((r) => r.durationMs).filter((d) => Number.isFinite(d) && d > 0);
  const durations = rawDurations.filter((d) => d <= cycleCeilingMs);
  const stalled = rawDurations.length - durations.length;

  // الوسيط لا المتوسط: جولة واحدة شاذة تكفي لتحريف المتوسط وتخريب كل التوقعات.
  const median = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const avgDurationMs = durations.length ? median(durations) : nominalCycleMs;

  const seatsPerRound = played.length
    ? played.reduce((a, r) => a + r.seats.length, 0) / played.length
    : 0;
  const humansPerRound = played.length
    ? played.reduce((a, r) => a + (r.house.real?.bets || 0), 0) / played.length
    : 0;

  const roundsPerHour = avgDurationMs > 0 ? 3_600_000 / avgDurationMs : 0;
  const T = ledger.total;
  const profitPerRound = played.length
    ? played.reduce((a, r) => a + (r.house.total?.profit || 0), 0) / played.length
    : 0;

  // كم جولة نحتاج حتى يصبح الربح شبه مؤكد إحصائياً؟
  // ربح الموقع لكل رهان: متوسطه = الهامش، وانحرافه = stdDev (بوحدات المبلغ).
  // نطلب أن يكون المتوسط 3 انحرافات فوق الصفر: edge*n >= 3*sd*sqrt(n)
  const edge = check.houseEdge;
  const sd = check.stdDev;
  const betsForConfidence = edge > 0 ? Math.ceil(Math.pow((3 * sd) / edge, 2)) : null;

  return {
    sampleRounds: played.length,
    stalledRounds: stalled,
    nominalCycleSeconds: Number((nominalCycleMs / 1000).toFixed(1)),
    avgRoundSeconds: Number((avgDurationMs / 1000).toFixed(1)),
    roundsPerHour: Number(roundsPerHour.toFixed(1)),
    avgSeatsPerRound: Number(seatsPerRound.toFixed(2)),
    avgHumansPerRound: Number(humansPerRound.toFixed(2)),
    avgBet: Math.round(T.avgBet),
    profitPerRound: Math.round(profitPerRound),
    projected: {
      hour: Math.round(profitPerRound * roundsPerHour),
      day: Math.round(profitPerRound * roundsPerHour * 24),
      month: Math.round(profitPerRound * roundsPerHour * 24 * 30)
    },
    theoreticalEdge: Number((edge * 100).toFixed(2)),
    stdDev: Number(sd.toFixed(4)),
    betsForConfidence,
    // كم يلزم من الرهانات حتى تغطي عائدات الهامش مبلغاً معيّناً — يحسبه المتصفح
    note: 'مدة الجولة وسيط لا متوسط، والجولات المتوقّفة مستبعدة. التوقعات تشمل البوتات إن كانت مفعّلة.'
  };
}

async function handleStream(req, res, url) {
  const token = tokenFrom(req, url);
  const player = await resolvePlayer(token);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 3000\n\n');

  const client = { res, playerId: player ? player.id : null };
  clients.add(client);
  pushTo(client, 'state', game.stateFor(client.playerId));
  bots.setViewers(countHumanViewers());

  const close = () => { clients.delete(client); bots.setViewers(countHumanViewers()); };
  req.on('close', close);
  req.on('error', close);
}

/** يخدم صفحة البوابة إن طابق المسار، وإلا 404 كأي مسار مجهول. */
async function serveGate(req, res, url) {
  if (!(await adminGate.matches(url.pathname))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('غير موجود');
  }
  const buf = await fs.promises.readFile(path.join(__dirname, 'gatePage.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    const rawPath = req.headers['x-forwarded-uri'] || req.headers['x-matched-path'] || req.url;
    url = new URL(rawPath, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'طلب غير صالح' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Gate, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (url.pathname === '/api/stream') return handleStream(req, res, url);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((err) => {
      console.error('[api]', url.pathname, err.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'خطأ في الخادم' });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'طريقة غير مسموحة' });
  }

  // عزل دومين الإدارة
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const adminDomain = siteConfig.getAdminDomain();
  const isDedicatedAdminHost = !!(adminDomain && host === adminDomain);

  if (isDedicatedAdminHost) {
    if (url.pathname === '/' || url.pathname === '/admin') return sendStatic(req, res, '/admin.html');
  }

  // مسار البوابة السرّية.
  // فحص الشكل متزامن وبلا شبكة، فالصفحات العادية لا تدفع ثمن رحلة إلى
  // قاعدة البيانات؛ ولا نذهب إليها إلا إذا بدا المسار مسارَ بوابة.
  if (adminGate.looksLikeGate(url.pathname)) {
    return serveGate(req, res, url).catch((err) => {
      console.error('[gate]', err.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'خطأ في الخادم' });
    });
  }

  // مسار الإدارة — يخدم صفحة الإدارة التي تطلب المفتاح وتتحقق منه
  if (url.pathname === '/admin') {
    return sendStatic(req, res, '/admin.html');
  }

  // مسارات الموقع
  if (url.pathname === '/') return sendStatic(req, res, '/index.html');
  if (url.pathname === '/lucky-cards') return sendStatic(req, res, '/game.html');
  if (url.pathname === '/bounty-hunter') return sendStatic(req, res, '/slot.html');
  if (url.pathname === '/battle-tanks') return sendStatic(req, res, '/tank.html');
  if (url.pathname === '/neon-slots') return sendStatic(req, res, '/neon-slots.html');
  if (url.pathname === '/mines') return sendStatic(req, res, '/mines.html');
  if (url.pathname === '/plinko') return sendStatic(req, res, '/plinko.html');
  if (url.pathname === '/login') return sendStatic(req, res, '/login.html');
  if (url.pathname === '/cashier') return sendStatic(req, res, '/cashier.html');
  if (url.pathname === '/master') return sendStatic(req, res, '/master.html');
  if (url.pathname.startsWith('/play/')) return sendStatic(req, res, '/play.html');
  return sendStatic(req, res, url.pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// إغلاق نظيف يحفظ الأرصدة
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] إيقاف (${signal})...`);
  game.stop();
  bots.stop();
  for (const c of clients) { try { c.res.end(); } catch { /* تجاهل */ } }
  try { await accounts.flushDeltas(); } catch { /* تجاهل */ }
  await store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

if (!process.env.VERCEL) {
  game.start();
  bots.start();

  server.listen(config.SERVER.port, config.SERVER.host, () => {
    const line = '─'.repeat(52);
    console.log(`\n${line}`);
    console.log('  LuckyArena — منصة ألعاب كازينو ومراهنات فاخرة');
    console.log(line);
    console.log(`  الرابط        : http://localhost:${config.SERVER.port}`);
    console.log(`  اللعبة 1      : كروت الحظ (${config.CARD_COUNT} كرت — ${config.GRID.cols}×${config.GRID.rows})`);
    console.log(`  اللعبة 2      : صيّاد الجوائز (سلوتس ${slots.REELS}×${slots.ROWS} — ${slots.WAYS} طريقة · عائد ${slots.MEASURED.rtp}%)`);
    console.log(`  اللعبة 3      : معركة الدبابات (مهارة · 4 مستويات · عائد 79-80%)`);
    console.log(`  نسبة العائد   : ${(check.rtp * 100).toFixed(2)}%`);
    console.log(`  مبالغ المشاركة: ${config.STAKES[0]} ← ${config.STAKES[config.STAKES.length - 1]}`);
    console.log(`  الحد الأقصى   : ${config.MAX_PLAYERS} مشترك لكل جولة`);
    console.log(`  اللاعبون الآليون: ${config.BOTS.enabled ? 'مفعّل' : 'متوقف'}`);
    console.log(`  ملف البيانات  : ${store.DATA_FILE}`);
    console.log(`  قاعدة البيانات: ${supabase.configured() ? supabase.config().url : 'غير مربوطة — لا حسابات ولا كاشير'}`);
    if (supabase.configured()) console.log('  لوحة الكاشير  : /cashier');
    const off = siteConfig.report().filter((g) => !g.enabled);
    if (off.length) console.log(`  ألعاب موقوفة  : ${off.map((g) => g.name).join(' · ')}`);
    for (const l of adminAuth.bootLines(config.SERVER.port)) console.log(l);
    adminGate.bootLines()
      .then((lines) => lines.forEach((l) => console.log(l)))
      .catch(() => {});
    console.log(`${line}\n`);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = server;
