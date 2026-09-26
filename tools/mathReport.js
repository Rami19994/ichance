'use strict';

require('./harness');

const crypto = require('crypto');
const { exactRtp } = require('./slotMath');

const pct = (x) => (x * 100).toFixed(2) + '%';
const line = (label, value, note) =>
  '  ' + label.padEnd(24) + String(value).padStart(9) + (note ? '   ' + note : '');

const TARGET = 0.96;

function verdict(rtp) {
  if (rtp >= 1) return '✖ الموقع يخسر';
  if (rtp >= 0.94) return '✔ ممتاز';
  if (rtp >= 0.90) return '~ مقبول';
  return '✖ هامش الموقع مرتفع جداً';
}

// ═════════════════════════════════════════════ 1) كروت الحظ
function luckyCards() {
  const { TEMPLATES, CARD_COUNT } = require('../server/config');
  let w = 0, sum = 0, winCards = 0, maxCard = 0;
  for (const t of TEMPLATES) {
    w += t.weight;
    sum += t.weight * t.cards.reduce((a, b) => a + b, 0);
    winCards += t.weight * t.cards.filter((m) => m > 1).length;
    for (const m of t.cards) if (m > maxCard) maxCard = m;
  }
  const rtp = sum / w / CARD_COUNT;
  // احتمال أن يصيب لاعب واحد كرتاً يربح أكثر من رهانه
  const pProfit = winCards / w / CARD_COUNT;
  // احتمال استرداد الرهان فقط (مضاعف = 1)
  let evenCards = 0;
  for (const t of TEMPLATES) evenCards += t.weight * t.cards.filter((m) => m === 1).length;
  const pEven = evenCards / w / CARD_COUNT;

  console.log('\n■ كروت الحظ');
  console.log(line('العائد للاعب', pct(rtp), verdict(rtp)));
  console.log(line('هامش الموقع', pct(1 - rtp)));
  console.log(line('احتمال ربح فعلي', pct(pProfit), 'مضاعف أكبر من ×1'));
  console.log(line('احتمال استرداد', pct(pEven)));
  console.log(line('احتمال خسارة', pct(1 - pProfit - pEven)));
  console.log(line('أكبر مضاعف', '×' + maxCard));
  return rtp;
}

// ═════════════════════════════════════════════ 2) نيون فيغاس
function neonSlots() {
  const neon = require('../server/neonSlots');
  const e = exactRtp({
    symbols: neon.SYMBOLS, strips: neon.REEL_STRIPS, wildId: 9, scatterId: 10, lineCount: 20
  });
  // تعداد الشبكة كاملة غير ممكن بعد التعديل: الأشرطة طويلة ومختلفة الأطوال
  // فالحالات بمئات الملايين. العائد محسوب بدقّة أعلاه؛ المعاينة هنا لما لا
  // يُحسب بصيغة مغلقة — تردّد الفوز (الخطوط تتقاسم الأعمدة فليست مستقلّة)
  // وشكل الأرباح. مولّد سريع يكفي: المطلوب توزيع إحصائي لا عدالة.
  const S = neon.REEL_STRIPS, P = neon.PAYLINES, SY = neon.SYMBOLS;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    return (seed >>> 0) / 4294967296;
  };
  const N = 600000;
  let sum = 0, hits = 0, maxX = 0, belowStake = 0, sumSq = 0;
  for (let i = 0; i < N; i++) {
    const grid = [];
    for (let c = 0; c < 5; c++) {
      const st = S[c], k = Math.floor(rnd() * st.length);
      grid.push([st[k % st.length], st[(k + 1) % st.length], st[(k + 2) % st.length]]);
    }
    let w = 0;
    for (const def of P) {
      let base = null;
      for (let c = 0; c < 5; c++) {
        const y = grid[c][def[c]];
        if (y !== 9 && y !== 10) { base = y; break; }
      }
      if (base === null) base = 9;
      let run = 0;
      for (let c = 0; c < 5; c++) {
        const y = grid[c][def[c]];
        if (y === base || y === 9) run++; else break;
      }
      const pay = SY[base].pays[run];
      if (pay) w += pay;
    }
    let sc = 0;
    for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) if (grid[c][r] === 10) sc++;
    if (SY[10].pays[sc]) w += SY[10].pays[sc] * 20;
    const x = w / 20;
    sum += x; sumSq += x * x;
    if (x > 0) { hits++; if (x < 1) belowStake++; }
    if (x > maxX) maxX = x;
  }
  const f = {
    hitFrequency: hits / N,
    maxWinX: maxX,
    stdDevX: Math.sqrt(sumSq / N - (sum / N) * (sum / N)),
    belowStakeShare: hits ? belowStake / hits : 0
  };
  console.log('\n■ نيون فيغاس سلوتس   (عائد دقيق · شكل الأرباح بمعاينة ' + N.toLocaleString('en-US') + ' دورة)');
  console.log(line('العائد للاعب', pct(e.rtp), verdict(e.rtp)));
  console.log(line('  منه الخطوط', pct(e.linesRtp)));
  console.log(line('  منه المبعثر', pct(e.scatterRtp),
    e.scatterRtp > e.linesRtp ? '← المبعثر يطغى على الخطوط' : ''));
  console.log(line('هامش الموقع', pct(1 - e.rtp)));
  console.log(line('تردّد الفوز', pct(f.hitFrequency)));
  console.log(line('أكبر ربح', '×' + f.maxWinX.toFixed(1)));
  console.log(line('تذبذب الدورة', '×' + f.stdDevX.toFixed(2)));
  console.log(line('فوز أقلّ من الرهان', pct(f.belowStakeShare),
    f.belowStakeShare > 0.2 ? '← «فوز» والرصيد ينقص' : 'كل فوز يُعيد الرهان على الأقل'));

  // الصفحة ترسم الأشرطة التي يتوقّف عليها الخادم — يجب أن تتطابق حرفياً
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'neon-slots.html'), 'utf8');
  const m = html.match(/reels:\s*(\[[\s\S]*?\n\s*\])\s*\n\s*\};/);
  let same = false;
  try { same = !!m && JSON.stringify(JSON.parse(m[1])) === JSON.stringify(S); } catch { same = false; }
  console.log(line('أشرطة الصفحة = الخادم', same ? 'نعم' : 'لا',
    same ? '' : '← الشاشة ستعرض رموزاً غير التي حُسب عليها الربح'));
  return e.rtp;
}

// ═════════════════════════════════════════════ 3) صيّاد الجوائز
function bountyHunter(rounds = 400_000) {
  const s = require('../server/slots');
  const BET = 1000;
  let wagered = 0, returned = 0, hits = 0, maxWin = 0;
  let feature = 0, sumSq = 0;

  for (let i = 0; i < rounds; i++) {
    const seed = crypto.randomBytes(16).toString('hex');
    let nonce = 0;
    wagered += BET;

    const base = s.playSpin({ seedHex: seed, nonce: nonce++, bet: BET, free: false, multiplier: 1 });
    let win = base.win;

    let spins = s.freeSpinsFor(base.scatters);
    if (spins > 0) {
      feature++;
      let mult = s.MULTIPLIER_LADDER[0];
      let used = 0;
      while (used < spins && used < s.FREE_SPINS.maxTotal) {
        const fs = s.playSpin({ seedHex: seed, nonce: nonce++, bet: BET, free: true, multiplier: mult });
        win += fs.win;
        if (fs.scatters >= 3) spins = Math.min(spins + s.FREE_SPINS.retrigger, s.FREE_SPINS.maxTotal);
        mult = s.stepMultiplier(mult, fs.win);
        used++;
      }
    }
    win = s.capSession(win, BET);
    returned += win;
    sumSq += (win / BET) * (win / BET);
    if (win > 0) hits++;
    if (win > maxWin) maxWin = win;
  }

  const rtp = returned / wagered;
  const mean = returned / rounds / BET;
  const sd = Math.sqrt(sumSq / rounds - mean * mean);
  // هامش الخطأ عند ثقة 95%. تذبذب الجولة هنا نحو ×13 من الرهان، فعيّنة
  // صغيرة تعطي رقماً قد يبعد عشر نقاط عن الحقيقة. نطبعه صريحاً بدل أن
  // نُصدر حكماً على ضجيج — والرقم الدقيق من tools/tuneBounty.js (تفكيك).
  const moe = 1.96 * sd / Math.sqrt(rounds);
  const noisy = moe > 0.01;
  console.log('\n■ صيّاد الجوائز   (محاكاة ' + rounds.toLocaleString('en-US') + ' جولة)');
  console.log(line('العائد للاعب', pct(rtp),
    '±' + (moe * 100).toFixed(1) + ' نقطة   ' + (noisy ? '← عيّنة صغيرة: الرقم المعتمد ' + s.MEASURED.rtp + '% (مقيس بالتفكيك)' : verdict(rtp))));
  console.log(line('هامش الموقع', pct(1 - rtp)));
  console.log(line('تردّد الفوز', pct(hits / rounds)));
  console.log(line('تكرار الميزة', '1:' + Math.round(rounds / Math.max(feature, 1))));
  console.log(line('أكبر ربح', '×' + (maxWin / BET).toFixed(0)));
  console.log(line('تذبذب الجولة', '×' + sd.toFixed(2)));
  // في الخلاصة نعتمد الرقم الدقيق إن كانت العيّنة أضعف من أن تحكم
  return noisy ? s.MEASURED.rtp / 100 : rtp;
}

// ═════════════════════════════════════════════ 4) بلينكو
function plinko() {
  const p = require('../server/plinkoGame');
  const M = p.MULTIPLIERS || require('../server/plinkoGame').MULTIPLIERS;
  const n = M.length - 1;
  const C = [1];
  for (let k = 1; k <= n; k++) C[k] = C[k - 1] * (n - k + 1) / k;
  const total = Math.pow(2, n);

  let ev = 0, pWin = 0, pDead = 0, maxM = 0, sumSq = 0;
  for (let k = 0; k <= n; k++) {
    const prob = C[k] / total;
    ev += prob * M[k];
    sumSq += prob * M[k] * M[k];
    if (M[k] > 0) pWin += prob; else pDead += prob;
    if (M[k] > maxM) maxM = M[k];
  }
  console.log('\n■ بلينكو   (حساب دقيق — توزيع ذات الحدّين)');
  console.log(line('العائد للاعب', pct(ev), verdict(ev)));
  console.log(line('هامش الموقع', pct(1 - ev)));
  console.log(line('تردّد الفوز', pct(pWin),
    pWin < 0.2 ? '← اللاعب يخسر ' + pct(pDead) + ' من رمياته' : ''));
  console.log(line('أكبر مضاعف', '×' + maxM));
  console.log(line('تذبذب الرمية', '×' + Math.sqrt(sumSq - ev * ev).toFixed(2)));
  return ev;
}

// ═════════════════════════════════════════════ 5) الألغام
function mines() {
  const m = require('../server/minesGame');
  // العائد ثابت بحكم البناء: المضاعف = المضاعف العادل × RTP.
  // نتحقّق من ذلك عملياً عند عدّة نقاط سحب.
  const checks = [];
  for (const minesCount of [1, 3, 5, 10, 24]) {
    for (const reveal of [1, 3, 5]) {
      const cells = 25;
      if (reveal > cells - minesCount) continue;
      let fair = 1;
      for (let i = 0; i < reveal; i++) fair *= (cells - i) / (cells - minesCount - i);
      const got = m.calculateMultiplier(minesCount, reveal);
      // المضاعف يُقرَّب لرقمين عشريين، فالمقارنة مع القيمة المقرّبة نفسها
      const expected = Number((fair * m.DEFAULT_RTP).toFixed(2));
      checks.push({ exact: Math.abs(got - expected), rtp: got / fair });
    }
  }
  const mismatch = Math.max(...checks.map((c) => c.exact));
  const highest = Math.max(...checks.map((c) => c.rtp));
  console.log('\n■ الألغام   (حساب دقيق — مضاعف عادل × نسبة العائد)');
  console.log(line('العائد للاعب', pct(m.DEFAULT_RTP), verdict(m.DEFAULT_RTP)));
  console.log(line('هامش الموقع', pct(1 - m.DEFAULT_RTP)));
  console.log(line('الصيغة', mismatch < 1e-9 ? 'مطابقة' : 'لا تطابق',
    mismatch < 1e-9 ? 'عند كل نقطة سحب مفحوصة' : '← المضاعف المصروف غير المحسوب'));
  console.log(line('أعلى عائد بعد التقريب', pct(highest),
    highest < 1 ? 'التقريب لرقمين لا يبلغ 100% أبداً' : '← الموقع يخسر عند هذه النقطة'));
  return m.DEFAULT_RTP;
}

// ═════════════════════════════════════════════ 5ب) بولزآي
function bullseye() {
  const b = require('../server/bullseyeGame');
  console.log('\n■ بولزآي X   (حساب دقيق — حجم القطاع = احتماله)');
  const worst = [];
  for (const [mode, cfg] of Object.entries({ ...b.MODES, gamble: { wheel: 'gamble', arrows: 1, label: 'ضاعف أو اخسر' } })) {
    const wheel = b.WHEELS[cfg.wheel];
    const W = wheel.reduce((a, s) => a + s.w, 0);
    const ev = b.wheelRtp(wheel);
    const hit = b.wheelHitRate(wheel);
    const maxM = Math.max(...wheel.map((s) => s.m));
    // التذبذب لسهم واحد؛ السهمان المستقلان بنصف الرهان يقسمانه على √2
    const sd = Math.sqrt(wheel.reduce((a, s) => a + (s.w / W) * s.m * s.m, 0) - ev * ev) / Math.sqrt(cfg.arrows);
    worst.push(ev);
    console.log(line(cfg.label, pct(ev), verdict(ev)));
    console.log(line('  تردّد الفوز', pct(cfg.arrows === 2 ? 1 - (1 - hit) ** 2 : hit),
      cfg.arrows === 2 ? 'سهم واحد على الأقل يصيب' : ''));
    console.log(line('  أكبر مضاعف', '×' + maxM, '  تذبذب ×' + sd.toFixed(2)));
  }
  return Math.max(...worst);
}

// ═════════════════════════════════════════════ 6) معركة الدبابات
function tanks() {
  const T = require('../public/js/tankSim.js');
  console.log('\n■ معركة الدبابات   (لعبة مهارة — العائد يتبع مهارة اللاعب)');
  let worst = 1;
  for (const d of Object.values(T.DIFFICULTY).sort((a, b) => a.order - b.order)) {
    const rtp = d.measured * d.payout / 100;
    if (rtp < worst) worst = rtp;
    console.log(line(d.name, pct(rtp),
      'فوز ' + pct(d.measured) + ' × ' + (d.payout / 100).toFixed(2)));
  }
  console.log(line('التعادل عند', '', 'معدّل فوز أعلى من هذا يقلب الربح للاعب:'));
  for (const d of Object.values(T.DIFFICULTY).sort((a, b) => a.order - b.order)) {
    console.log(line('  ' + d.name, pct(100 / d.payout)));
  }
  return worst;
}

// ═════════════════════════════════════════════
console.log('══════════════════════════════════════════════════════════');
console.log('  رياضيات LuckyArena — الهدف: عائد ' + pct(TARGET) + ' لكل لعبة');
console.log('══════════════════════════════════════════════════════════');

const results = {
  'كروت الحظ': luckyCards(),
  'نيون فيغاس': neonSlots(),
  'صيّاد الجوائز': bountyHunter(Number(process.env.ROUNDS || 400000)),
  'بلينكو': plinko(),
  'الألغام': mines(),
  'بولزآي X': bullseye(),
  'الدبابات': tanks()
};

console.log('\n══════════════════════════════════════════════════════════');
console.log('  الخلاصة');
console.log('══════════════════════════════════════════════════════════');
for (const [name, rtp] of Object.entries(results)) {
  const gap = (rtp - TARGET) * 100;
  console.log('  ' + name.padEnd(16) + pct(rtp).padStart(8)
    + '   ' + (gap >= 0 ? '+' : '') + gap.toFixed(1) + ' نقطة عن الهدف'
    + '   ' + verdict(rtp));
}
