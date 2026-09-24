'use strict';

/**
 * ضبط رياضيات نيون فيغاس.
 *
 * ── القيد الذي قاد التصميم
 * رفع نسبة العائد وحدها لا يكفي. الجدول يدفع بوحدات **رهان الخط**، والرهان
 * الكلّي عشرون منها — فأي فوز أقلّ من 20 هو خسارة في ثوب فوز: يضيء الخط،
 * يرقص الرقم، والرصيد ينقص. في الجدول القديم كان أدنى فوز 5، أي ربع الرهان.
 *
 * هنا **أصغر ربح ممكن = رهان كامل**: ثلاثة رموز من أرخص فئة تدفع 20.
 * فكلّما أضاء خطٌّ يكون اللاعب قد استرد رهانه على الأقل.
 *
 * ── ما يترتّب على ذلك
 * إن دفعنا أكثر في كل فوز وجب أن يكون الفوز أندر، وإلّا انفجر العائد. وأندر
 * يعني رموزاً أقلّ تكراراً على الأشرطة — وهذا هو المتغيّر الوحيد الذي نبحث
 * فيه؛ الجدول مثبّت بأرقام نظيفة يقرؤها اللاعب في اللوحة.
 *
 * ── لماذا تعداد شامل لا تحسين تدريجي
 * العائد دالّة تكعيبية على الأقل في أعداد الرموز، لكن فضاء البحث صغير
 * والعائد يُحسب بصيغة مغلقة دقيقة (slotMath.js). فالتعداد أصدق وأسرع.
 */

const { exactRtp } = require('./slotMath');

const TARGET_RTP = 0.96;
const LINES = 20;
const WILD = 9, SCATTER = 10;

const NAMES = ['A', 'DIAMONDS', 'J', 'CLUBS', 'K', 'HEARTS', 'Q', 'SPADES', 'SEVEN', 'WILD', 'SCATTER'];
const LOW = [0, 2, 4, 6];      // A · J · K · Q
const MID = [1, 3, 5, 7];      // ماس · سباتي · قلوب · بستوني
const HIGH = 8;                // السبعة

const PAYS = {
  low:  { 3: 20,  4: 60,  5: 200 },
  mid:  { 3: 40,  4: 120, 5: 400 },
  high: { 3: 100, 4: 400, 5: 1500 }
};
const TIER = ['low', 'mid', 'low', 'mid', 'low', 'mid', 'low', 'mid', 'high'];

/** المبعثر يدفع على الرهان الكلّي: ×100 هنا = مئة ضعف الرهان، حلم اللعبة. */
const SCATTER_PAYS = { 3: 5, 4: 25, 5: 100 };

const symbols = NAMES.map((key, id) => {
  if (id === WILD) return { id, key, wild: true, scatter: false, pays: {} };
  if (id === SCATTER) return { id, key, wild: false, scatter: true, pays: { ...SCATTER_PAYS } };
  return { id, key, wild: false, scatter: false, pays: { ...PAYS[TIER[id]] } };
});

/** يوزّع الرموز بتباعد منتظم — التكتّل يشوّه نافذة الصفوف الثلاثة. */
function buildStrip(counts, L) {
  const slots = new Array(L).fill(null);
  const order = counts.map((n, s) => [s, n]).filter(([, n]) => n > 0).sort((a, b) => a[1] - b[1]);
  for (const [sym, n] of order) {
    const step = L / n;
    for (let i = 0; i < n; i++) {
      const ideal = Math.round(i * step + step / 2) % L;
      let k = 0;
      while (slots[(ideal + k) % L] !== null) k++;
      slots[(ideal + k) % L] = sym;
    }
  }
  return slots;
}

function counts({ low, mid, high, wild, scatter }) {
  const c = new Array(11).fill(0);
  for (const id of LOW) c[id] = low;
  for (const id of MID) c[id] = mid;
  c[HIGH] = high; c[WILD] = wild; c[SCATTER] = scatter;
  return c;
}

// --------------------------------------------------------------- البحث
//
// البكرات تتقاسم نفس تركيبة الرموز، ويختلف عدد الوايلد وحده بين الطرف
// والوسط — فيختلف الطول تبعاً لذلك. لا يلزم أن تتساوى أطوال الأشرطة،
// وتثبيتها كان يقيّد البحث بلا داعٍ حتى لم يبقَ إلّا حلٌّ واحد مشوّه.
const pool = [];

function reel(spec) {
  const c = counts(spec);
  const L = c.reduce((a, b) => a + b, 0);
  return { c, L, strip: buildStrip(c, L), spec };
}

for (let low = 3; low <= 14; low++) {
  for (let mid = 2; mid <= low; mid++) {
    for (let high = 1; high <= Math.max(2, mid); high++) {
      for (let scatter = 1; scatter <= 2; scatter++) {
        // البكرتان الطرفيتان بلا وايلد: تمنع خمسة بدائل على خطّ، وتُبقي
        // البكرة الأولى صادقة فلا تَعِد بما لا تملك.
        const edge = reel({ low, mid, high, wild: 0, scatter });
        if (edge.L < 24 || edge.L > 90) continue;

        for (let wild = 1; wild <= 4; wild++) {
          const centre = reel({ low, mid, high, wild, scatter });
          const strips = [edge.strip, centre.strip, centre.strip, centre.strip, edge.strip];
          const e = exactRtp({ symbols, strips, wildId: WILD, scatterId: SCATTER, lineCount: LINES });
          if (Math.abs(e.rtp - TARGET_RTP) > 0.006) continue;

          const hit = 1 - Math.pow(1 - e.perLineWinProb, LINES);
          pool.push({
            edge, centre, low, mid, high, wild, scatter, strips, e, hit,
            desc: 'رخيص ' + low + ' · متوسط ' + mid + ' · سبعة ' + high
                + ' · مبعثر ' + scatter + ' · وايلد ' + wild
                + '  (طول ' + edge.L + '/' + centre.L + ')'
          });
        }
      }
    }
  }
}

pool.sort((a, b) => Math.abs(a.e.rtp - TARGET_RTP) - Math.abs(b.e.rtp - TARGET_RTP));

console.log('نيون فيغاس — التوزيعات التي تصيب ' + (TARGET_RTP * 100).toFixed(0) + '%');
console.log('  عُثر على ' + pool.length + ' توزيعاً مقبولاً\n');
for (const c of pool.slice(0, 25)) {
  console.log('  ' + c.desc.padEnd(52)
    + ' عائد ' + (c.e.rtp * 100).toFixed(2) + '%'
    + '  خطوط ' + (c.e.linesRtp * 100).toFixed(1) + '%'
    + '  مبعثر ' + (c.e.scatterRtp * 100).toFixed(1) + '%'
    + '  تردّد ' + (c.hit * 100).toFixed(1) + '%');
}

module.exports = { pool, symbols, PAYS, SCATTER_PAYS, TIER, NAMES, buildStrip, counts, TARGET_RTP };
