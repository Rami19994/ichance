'use strict';

/**
 * إعدادات المنصة واللعبة.
 * كل الأرقام هنا في مكان واحد حتى يسهل ضبط توازن اللعبة.
 */

// ---------------------------------------------------------------------------
// مبالغ المشاركة: تبدأ من 200 وتتضاعف تدريجياً حتى 100000
// ---------------------------------------------------------------------------
const STAKES = [200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 100000];

// ---------------------------------------------------------------------------
// سقف المضاعف على الرهانات الكبيرة
// أي مشاركة بمبلغ >= هذا الحد لا تُصرف بأكثر من HIGH_STAKE_MAX_MULTIPLIER
// (القاعدة معلنة في الواجهة وفي /api/config قبل أن يراهن أحد)
// ---------------------------------------------------------------------------
const HIGH_STAKE_THRESHOLD = 12800;
const HIGH_STAKE_MAX_MULTIPLIER = 5;

// ---------------------------------------------------------------------------
// توقيت الجولة (بالملّي ثانية)
// ---------------------------------------------------------------------------
const TIMING = {
  betting: 5_000,    // مرحلة المشاركة: 5 ثوانٍ
  playing: 15_000,   // مرحلة اللعب: 15 ثانية
  results: 5_000     // عرض النتائج بعد الكشف
};

// عند اكتمال العدد تبدأ اللعبة فوراً.
// المهلة قصيرة عمداً: مع نافذة مشاركة من 5 ثوانٍ، انتظار 3 ثوانٍ يبتلع معظمها.
const FULL_TABLE_LAUNCH_MS = 2_000;

// إذا حجز جميع اللاعبين كروتهم نقفز إلى آخر 3 ثوانٍ بدل انتظار الـ15 كاملة
const ALL_PICKED_TAIL_MS = 3_000;

const GRID = { cols: 3, rows: 4 };
const CARD_COUNT = GRID.cols * GRID.rows; // 12
const MAX_PLAYERS = CARD_COUNT;           // 12 مشترك كحد أقصى لكل جولة

// ---------------------------------------------------------------------------
// قواعد التوزيع الصارمة (تُفحص آلياً عند الإقلاع)
// ---------------------------------------------------------------------------
const RULES = {
  winnersPerRound: 3,      // عدد الكروت الرابحة (مضاعف > 1) في كل جولة — ثابت لا يتغيّر
  maxBigCardsPerRound: 1,  // أقصى عدد كروت فوق ×5
  bigCardFrom: 5           // ما فوق هذا الرقم يُعد كرتاً كبيراً
};

// ---------------------------------------------------------------------------
// أنماط توزيع المضاعفات على الـ12 كرت. كل نمط يحتوي بالضبط 12 قيمة.
//   0  = كرت خاسر (يذهب المبلغ) — 65% من الكروت
//   1  = استرداد المبلغ فقط (ليس ربحاً) — 10%
//  >1 = ربح فعلي — 3 كروت بالضبط في كل نمط بلا استثناء، ومداها ×2 إلى ×100
//
// الأوزان من 1000 لا من 100: الكروت الكبيرة تحتاج دقّة أعلى من 1%.
// الكرت ×100 يظهر في جولة واحدة من كل ألف — وهو ما يسمح بوجوده أصلاً،
// إذ إن كرتاً واحداً بـ×100 يساوي وحده 8.3 نقطة من نسبة العائد.
//
// "3 كروت رابحة" لا تعني أن اللاعبين يربحون كل جولة: الكروت الرابحة قد لا
// يلتقطها أحد. احتمال ألا يربح أي لاعب = C(9,n)/C(12,n)
//   لاعبان 54.5% · أربعة 25.5% · ستة 9.1% · ثمانية 1.8%
// وعند اكتمال الطاولة (12) يربح 3 لاعبين بالضبط.
//
// المتوسط الموزون = 9.65 => نسبة العائد 80.42% وهامش الموقع 19.58%
// ---------------------------------------------------------------------------
const TEMPLATES = [
  { key: 'trio',     name: 'ثلاثي متواضع',  weight: 260, cards: [0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2] },
  { key: 'balanced', name: 'متوازن',        weight: 230, cards: [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 3] },
  { key: 'rising',   name: 'صاعد',          weight: 190, cards: [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3] },
  { key: 'five',     name: 'الخمسة',        weight: 150, cards: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 5] },
  { key: 'five2',    name: 'خمسة مزدوجة',   weight: 100, cards: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 5] },
  { key: 'ten',      name: 'العشرة',        weight:  50, cards: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 10] },
  { key: 'twenty',   name: 'العشرون',       weight:  14, cards: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 20] },
  { key: 'fifty',    name: 'الخمسون',       weight:   5, cards: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 50] },
  { key: 'hundred',  name: 'المئة',         weight:   1, cards: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 100] }
];

// ---------------------------------------------------------------------------
// المحفظة الافتراضية (عملة وهمية — لا يوجد مال حقيقي في هذا المشروع)
// ---------------------------------------------------------------------------
const WALLET = {
  startingBalance: 25_000,
  faucetAmount: 10_000,        // شحن تجريبي
  faucetThreshold: STAKES[0],  // يُسمح بالشحن فقط إذا نزل الرصيد تحت أصغر مبلغ
  faucetCooldownMs: 60_000
};

// ---------------------------------------------------------------------------
// اللاعبون الآليون (لتجربة اللعبة منفرداً). يظهرون دائماً بشارة BOT.
// ---------------------------------------------------------------------------
const BOTS = {
  enabled: process.env.ICHANCE_BOTS === '1',
  minTarget: 0,
  maxTarget: 0
};

// ---------------------------------------------------------------------------
// لوحة الإدارة
// المفتاح لم يعد هنا: كان يُولَّد عشوائياً عند كل إقلاع فيبطل المفتاح المحفوظ
// مع أول إعادة تشغيل. صار في server/adminAuth.js مفتاحاً دائماً يُحفظ على القرص.
// ---------------------------------------------------------------------------

const path = require('path');
const SERVER = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataFile: process.env.ICHANCE_DATA || (process.env.VERCEL ? path.join('/tmp', 'players.json') : null),
  historySize: 200
};

// ---------------------------------------------------------------------------
// فحص ذاتي: يمنع أي خطأ في الجداول أعلاه من المرور بصمت
// ---------------------------------------------------------------------------
function selfCheck() {
  let totalWeight = 0;
  let weightedSum = 0;
  let weightedSquares = 0;
  let dryWeight = 0;
  let maxWinners = 0;

  for (const t of TEMPLATES) {
    if (t.cards.length !== CARD_COUNT) {
      throw new Error(`النمط "${t.key}" يحتوي ${t.cards.length} كرت بدل ${CARD_COUNT}`);
    }
    if (t.cards.some((m) => typeof m !== 'number' || m < 0 || !Number.isFinite(m))) {
      throw new Error(`النمط "${t.key}" يحتوي مضاعفاً غير صالح`);
    }
    if (!(t.weight > 0)) throw new Error(`النمط "${t.key}" وزنه غير صالح`);

    const winners = t.cards.filter((m) => m > 1).length;
    const bigCards = t.cards.filter((m) => m > RULES.bigCardFrom).length;
    if (winners !== RULES.winnersPerRound) {
      throw new Error(`النمط "${t.key}" فيه ${winners} كرت رابح — المطلوب ${RULES.winnersPerRound} بالضبط`);
    }
    if (bigCards > RULES.maxBigCardsPerRound) {
      throw new Error(`النمط "${t.key}" فيه ${bigCards} كرت كبير — الحد ${RULES.maxBigCardsPerRound}`);
    }

    if (winners === 0) dryWeight += t.weight;
    if (winners > maxWinners) maxWinners = winners;
    totalWeight += t.weight;
    weightedSum += t.weight * t.cards.reduce((a, b) => a + b, 0);
    weightedSquares += t.weight * t.cards.reduce((a, b) => a + b * b, 0) / CARD_COUNT;
  }

  const rtp = weightedSum / totalWeight / CARD_COUNT;
  // تباين المضاعف: يحدد مقدار تذبذب أرباح الموقع على المدى القصير.
  // ارتفع كثيراً بعد إدخال ×100 — راجع betsForConfidence في لوحة الإدارة.
  const variance = weightedSquares / totalWeight - rtp * rtp;
  if (rtp <= 0.5 || rtp >= 1) {
    throw new Error(`نسبة العائد خارج النطاق المعقول: ${rtp}`);
  }
  for (let i = 1; i < STAKES.length; i++) {
    if (STAKES[i] <= STAKES[i - 1]) throw new Error('مبالغ المشاركة يجب أن تكون تصاعدية');
  }
  if (!STAKES.includes(HIGH_STAKE_THRESHOLD)) {
    throw new Error('حد الرهان الكبير يجب أن يكون أحد المبالغ المعتمدة');
  }

  return {
    rtp,
    houseEdge: 1 - rtp,
    totalWeight,
    maxWinners,
    winnersPerRound: RULES.winnersPerRound,
    variance,
    stdDev: Math.sqrt(variance),
    dryRoundChance: dryWeight / totalWeight
  };
}

/** سقف المضاعف حسب المبلغ — قاعدة معلنة ومطبّقة على الخادم. */
function cappedMultiplier(stake, multiplier) {
  if (stake >= HIGH_STAKE_THRESHOLD) return Math.min(multiplier, HIGH_STAKE_MAX_MULTIPLIER);
  return multiplier;
}

module.exports = {
  STAKES, TIMING, FULL_TABLE_LAUNCH_MS, ALL_PICKED_TAIL_MS,
  GRID, CARD_COUNT, MAX_PLAYERS, TEMPLATES, RULES, WALLET, BOTS, SERVER,
  HIGH_STAKE_THRESHOLD, HIGH_STAKE_MAX_MULTIPLIER,
  selfCheck, cappedMultiplier
};
