'use strict';

/**
 * حاسبة عائد نيون فيغاس — **دقيقة**، لا تقديرية.
 *
 * كان يمكن تشغيل ملايين الدورات وقياس المتوسط، لكن المحاكاة تعطي رقماً
 * يرتجف في المنزلة الثانية، ونحن نضبط هامش الموقع عند كسور المئة. الحساب
 * هنا مغلق الصيغة.
 *
 * ── لماذا يصحّ الحساب المغلق
 * رمز الخط في العمود c هو strip[c][(stop_c + row_c) % L]. و stop_c منتظم
 * على L، فإضافة row_c مجرّد إزاحة دائرية: توزيع الرمز على أي خط هو نفسه
 * توزيع أعمدة الشريط، والأعمدة مستقلّة. ينتج عن ذلك أمران:
 *
 *   • كل خطّ من العشرين له **نفس** توزيع الربح مهما كان شكله الهندسي،
 *     فعائد الخطوط = توقّع ربح خطٍّ واحد بوحدات رهان الخط.
 *   • لا حاجة لتعداد 20^5 حالة لحساب العائد.
 *
 * أما المبعثر (Scatter) فيُحسب على الشاشة كلّها، والصفوف الثلاثة داخل
 * العمود الواحد متجاورة على الشريط فهي مرتبطة — لذلك نعدّ نوافذ العمود
 * العشرين بالضبط ثم نلفّ الأعمدة (convolution).
 *
 * تردّد الفوز يحتاج الشبكة كاملة لأن الخطوط تتقاسم الأعمدة، فنعدّده
 * كاملاً (20^5) عند الطلب.
 */

// ---------------------------------------------------------------- أدوات
/** توزيع الرموز في شريط واحد: احتمال كل رمز. */
function stripDist(strip, symbolCount) {
  const p = new Array(symbolCount).fill(0);
  for (const s of strip) p[s] += 1 / strip.length;
  return p;
}

/**
 * توقّع ربح خطٍّ واحد بوحدات رهان الخط — تعداد تامّ لكل تركيبات الرموز
 * الخمسة (11^5 = 161,051) موزونةً باحتمالاتها.
 */
function lineExpectation({ symbols, strips, wildId, scatterId }) {
  const n = symbols.length;
  const dists = strips.map((s) => stripDist(s, n));

  let ev = 0;
  let pWin = 0;                       // احتمال فوز خطّ واحد
  const line = new Array(5);

  (function walk(col, prob) {
    if (prob === 0) return;
    if (col === 5) {
      // الرمز الأساس: أوّل رمز ليس Wild ولا Scatter
      let base = null;
      for (let i = 0; i < 5; i++) {
        const s = line[i];
        if (s !== wildId && s !== scatterId) { base = s; break; }
      }
      if (base === null) base = wildId;

      // طول التتابع من اليسار
      let run = 0;
      for (let i = 0; i < 5; i++) {
        if (line[i] === base || line[i] === wildId) run++;
        else break;
      }

      const pays = symbols[base] && symbols[base].pays;
      const pay = pays ? pays[run] : undefined;
      if (pay) { ev += prob * pay; pWin += prob; }
      return;
    }
    const d = dists[col];
    for (let s = 0; s < n; s++) {
      if (d[s] === 0) continue;
      line[col] = s;
      walk(col + 1, prob * d[s]);
    }
  })(0, 1);

  return { ev, pWin };
}

/**
 * توزيع عدد المبعثرات على الشاشة.
 * لكل عمود: نمسح نوافذه الـL (ثلاثة صفوف متتالية) ونعدّ المبعثرات فيها،
 * فنحصل على توزيع دقيق لهذا العمود؛ ثم نلفّ الأعمدة الخمسة.
 */
function scatterDist({ strips, scatterId }) {
  let dist = [1];
  for (const strip of strips) {
    const L = strip.length;
    const col = [0, 0, 0, 0];
    for (let stop = 0; stop < L; stop++) {
      let k = 0;
      for (let r = 0; r < 3; r++) if (strip[(stop + r) % L] === scatterId) k++;
      col[k] += 1 / L;
    }
    const next = new Array(dist.length + 3).fill(0);
    for (let a = 0; a < dist.length; a++) {
      if (dist[a] === 0) continue;
      for (let b = 0; b < col.length; b++) {
        if (col[b] === 0) continue;
        next[a + b] += dist[a] * col[b];
      }
    }
    dist = next;
  }
  return dist;
}

/**
 * العائد الكلّي الدقيق.
 * الرهان الكلّي = رهان الخط × عدد الخطوط، وأرباح المبعثر مضروبة بالرهان
 * الكلّي لا برهان الخط — لذلك يُقسم كلٌّ على أساسه.
 */
function exactRtp({ symbols, strips, wildId, scatterId, lineCount = 20 }) {
  const { ev, pWin } = lineExpectation({ symbols, strips, wildId, scatterId });

  const sDist = scatterDist({ strips, scatterId });
  const sPays = (symbols[scatterId] && symbols[scatterId].pays) || {};
  let scatterEv = 0;                  // بوحدات الرهان الكلّي
  let pScatterWin = 0;
  for (let k = 0; k < sDist.length; k++) {
    if (sPays[k]) { scatterEv += sDist[k] * sPays[k]; pScatterWin += sDist[k]; }
  }

  // عائد الخطوط: lineCount × ev × lineBet مقسوماً على lineCount × lineBet
  const linesRtp = ev;
  return {
    rtp: linesRtp + scatterEv,
    linesRtp,
    scatterRtp: scatterEv,
    perLineWinProb: pWin,
    scatterWinProb: pScatterWin,
    scatterDist: sDist
  };
}

/**
 * تعداد تامّ للشبكة (L^5) — لتردّد الفوز وأكبر ربح وتقلّب العائد.
 * أبطأ بكثير، فيُستدعى للمرشّح النهائي لا داخل حلقة الضبط.
 */
function fullEnumerate({ symbols, strips, paylines, wildId, scatterId, lineCount = 20 }) {
  const L = strips[0].length;
  for (const s of strips) if (s.length !== L) throw new Error('الأشرطة بأطوال مختلفة');

  const total = Math.pow(L, 5);
  const lineBet = 1;                  // رهان الخط = 1 → الرهان الكلّي = lineCount
  const totalBet = lineCount * lineBet;

  let sumWin = 0, sumWinSq = 0, hits = 0, maxWin = 0;
  const buckets = new Map();          // الربح/الرهان → عدد الحالات

  const grid = [[], [], [], [], []];
  const stops = new Array(5);

  function evalGrid() {
    let win = 0;
    for (let li = 0; li < lineCount; li++) {
      const def = paylines[li];
      let base = null;
      for (let c = 0; c < 5; c++) {
        const s = grid[c][def[c]];
        if (s !== wildId && s !== scatterId) { base = s; break; }
      }
      if (base === null) base = wildId;
      let run = 0;
      for (let c = 0; c < 5; c++) {
        const s = grid[c][def[c]];
        if (s === base || s === wildId) run++;
        else break;
      }
      const pays = symbols[base] && symbols[base].pays;
      if (pays && pays[run]) win += lineBet * pays[run];
    }
    let sc = 0;
    for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) if (grid[c][r] === scatterId) sc++;
    const sPays = (symbols[scatterId] && symbols[scatterId].pays) || {};
    if (sPays[sc]) win += totalBet * sPays[sc];
    return win;
  }

  (function walk(col) {
    if (col === 5) {
      const win = evalGrid();
      sumWin += win;
      sumWinSq += win * win;
      if (win > 0) hits++;
      if (win > maxWin) maxWin = win;
      const x = Math.round((win / totalBet) * 100) / 100;
      buckets.set(x, (buckets.get(x) || 0) + 1);
      return;
    }
    const strip = strips[col];
    for (let stop = 0; stop < L; stop++) {
      stops[col] = stop;
      grid[col][0] = strip[stop % L];
      grid[col][1] = strip[(stop + 1) % L];
      grid[col][2] = strip[(stop + 2) % L];
      walk(col + 1);
    }
  })(0);

  const meanX = sumWin / total / totalBet;
  const varX = sumWinSq / total / (totalBet * totalBet) - meanX * meanX;

  return {
    rtp: meanX,
    hitFrequency: hits / total,
    maxWinX: maxWin / totalBet,
    stdDevX: Math.sqrt(varX),
    combos: total,
    buckets
  };
}

module.exports = { exactRtp, fullEnumerate, stripDist, lineExpectation, scatterDist };
