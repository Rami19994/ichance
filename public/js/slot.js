/* ==========================================================================
   LuckyArena — لعبة "صيّاد الجوائز" (منطق المتصفح)
   --------------------------------------------------------------------------
   الخادم يقرر كل شيء. هذا الملف يطلب دورة ويعرض ما يصله.
   لا توليد عشوائي هنا ولا حساب أرباح — حتى لو عُدّل الملف لا تتغيّر النتيجة.
   ========================================================================== */
'use strict';

const el = (id) => document.getElementById(id);

let CFG = null;
let betIndex = 0;
let spinning = false;
let auto = false;
let turbo = false;
let feature = null;      // حالة الميزة الجارية
let lastFair = null;

/* ------------------------------- بناء اللوحة ------------------------------- */
function buildReels() {
  const wrap = el('reels');
  let html = '';
  for (let r = 0; r < CFG.reels; r++) {
    html += `<div class="reel" data-reel="${r}">`;
    for (let row = 0; row < CFG.rows; row++) {
      html += `<div class="cell" data-r="${r}" data-row="${row}"></div>`;
    }
    html += '</div>';
  }
  wrap.innerHTML = html;
}

function buildLadder() {
  el('multiLadder').innerHTML = CFG.multiplierLadder
    .map((m) => `<span class="multi-step" data-m="${m}">×${m}</span>`).join('');
  paintLadder(1);
}

function paintLadder(current) {
  const idx = CFG.multiplierLadder.indexOf(current);
  [...el('multiLadder').children].forEach((node, i) => {
    node.classList.toggle('is-active', i === idx);
    node.classList.toggle('is-passed', i < idx);
  });
}

/** يرسم رمزاً في خانة. */
function paintCell(cell, symbol) {
  cell.innerHTML = SYMBOL_ART[symbol] || '';
  cell.classList.toggle('is-wild', symbol === 'WILD');
  cell.classList.toggle('is-scatter', symbol === 'SCATTER');
  cell.classList.remove('is-win');
}

/** لوحة عشوائية للعرض أثناء الدوران — زخرفة بحتة لا علاقة لها بالنتيجة. */
function paintRandom() {
  const pool = Object.keys(SYMBOL_ART);
  document.querySelectorAll('.cell').forEach((cell) => {
    paintCell(cell, pool[Math.floor(Math.random() * pool.length)]);
  });
}

function paintGrid(grid) {
  for (let r = 0; r < grid.length; r++) {
    for (let row = 0; row < grid[r].length; row++) {
      const cell = document.querySelector(`.cell[data-r="${r}"][data-row="${row}"]`);
      if (cell) paintCell(cell, grid[r][row]);
    }
  }
}

function highlightWins(lines, scatterCells) {
  const mark = ([r, row]) => {
    const cell = document.querySelector(`.cell[data-r="${r}"][data-row="${row}"]`);
    if (cell) cell.classList.add('is-win');
  };
  for (const line of lines) line.cells.forEach(mark);
  if (scatterCells && scatterCells.length >= 3) scatterCells.forEach(mark);
}

/* ------------------------------- الرهان ------------------------------- */
function currentBet() { return CFG.stakes[betIndex]; }

function renderBet() {
  el('betValue').textContent = fmt(currentBet());
  el('betDown').disabled = betIndex === 0 || spinning || !!feature;
  el('betUp').disabled = betIndex === CFG.stakes.length - 1 || spinning || !!feature;
  el('buyCost').textContent = fmt(currentBet() * CFG.featureBuyCost);

  const balance = Session.player ? Session.player.balance : 0;
  el('buyBtn').disabled = spinning || !!feature || balance < currentBet() * CFG.featureBuyCost;
}

/* ------------------------------- الميزة ------------------------------- */
function renderFeature() {
  const bar = el('featureBar');
  if (!feature) {
    bar.hidden = true;
    paintLadder(1);
    el('spinLabel').textContent = 'أدر';
    return;
  }
  bar.hidden = false;
  el('fsLeft').textContent = feature.spinsLeft;
  el('fsMult').textContent = `×${feature.multiplier}`;
  el('fsTotal').textContent = fmt(feature.totalWin);
  paintLadder(feature.multiplier);
  el('spinLabel').textContent = 'مجاني';
}

/* ------------------------------- الرسائل ------------------------------- */
function showOverlay(html, ms) {
  el('overlayMsg').innerHTML = html;
  el('boardOverlay').hidden = false;
  if (ms) setTimeout(() => { el('boardOverlay').hidden = true; }, ms);
}
function hideOverlay() { el('boardOverlay').hidden = true; }

function showWin(amount, big) {
  const pop = el('winPop');
  el('winPopAmount').textContent = `+${fmt(amount)}`;
  el('winPopLabel').textContent = big ? 'ربح كبير!' : 'ربح';
  pop.classList.toggle('is-big', !!big);
  pop.hidden = false;
}
function hideWin() { el('winPop').hidden = true; }

/* ------------------------------- الدورة ------------------------------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function doSpin() {
  if (spinning) return;
  if (!feature && Session.player && Session.player.balance < currentBet()) {
    toast('رصيدك لا يكفي لهذا الرهان', 'error');
    auto = false; el('autoBtn').classList.remove('is-on');
    return;
  }

  spinning = true;
  hideWin();
  hideOverlay();
  el('spinBtn').classList.add('is-spinning');
  el('spinBtn').disabled = true;
  renderBet();

  const reels = [...document.querySelectorAll('.reel')];
  reels.forEach((r) => r.classList.add('is-spinning'));
  const shuffle = setInterval(paintRandom, turbo ? 60 : 90);

  let res = null;
  let failed = null;
  try {
    res = await API.post('/api/slot/spin', { bet: currentBet() });
  } catch (err) {
    failed = err.message;
  }

  // زمن دوران مريح حتى لو ردّ الخادم فوراً
  await wait(turbo ? 220 : 520);
  clearInterval(shuffle);

  if (failed) {
    reels.forEach((r) => r.classList.remove('is-spinning'));
    spinning = false;
    auto = false; el('autoBtn').classList.remove('is-on');
    el('spinBtn').classList.remove('is-spinning');
    el('spinBtn').disabled = false;
    renderBet();
    toast(failed, 'error');
    return;
  }

  // توقّف البكرات واحدة تلو الأخرى
  for (let r = 0; r < reels.length; r++) {
    reels[r].classList.remove('is-spinning');
    reels[r].classList.add('is-landing');
    for (let row = 0; row < CFG.rows; row++) {
      const cell = reels[r].children[row];
      if (cell) paintCell(cell, res.grid[r][row]);
    }
    setTimeout(((node) => () => node.classList.remove('is-landing'))(reels[r]), 320);
    if (!turbo) await wait(110);
  }

  Session.setPlayer({ ...Session.player, balance: res.balance });
  feature = res.feature || null;
  renderFeature();

  if (res.win > 0) {
    highlightWins(res.lines, res.scatterCells);
    showWin(res.win, res.win >= currentBet() * 10);
    el('lastWin').textContent = fmt(res.win);
    if (res.win >= currentBet() * 20) confettiBurst();
  } else {
    el('lastWin').textContent = '0';
  }

  if (res.retrigger) {
    showOverlay(`+${res.retrigger} دورات إضافية!`, 1400);
  }

  // فتحت الدورة الميزة؟
  if (res.feature && res.feature.spinsUsed === 0 && !res.featureEnded) {
    highlightWins([], res.scatterCells);
    showOverlay(`3 سبائك ذهب!<small>${res.feature.spinsLeft} دورة مجانية</small>`, 1800);
    await wait(1800);
  }

  // انتهت الميزة؟
  if (res.featureEnded) {
    const f = res.featureEnded;
    showOverlay(
      `انتهت الدورات المجانية<small>المجموع: ${fmt(f.totalWin)} من ${f.spins} دورة${f.capped ? ' · بلغت السقف' : ''}</small>`,
      2600
    );
    if (f.totalWin >= currentBet() * 20) confettiBurst();
    await wait(2600);
  }

  if (res.fair) { lastFair = res.fair; renderFair(); }

  spinning = false;
  el('spinBtn').classList.remove('is-spinning');
  el('spinBtn').disabled = false;
  renderBet();

  // التسلسل التالي: الميزة تُكمل نفسها، واللعب التلقائي يواصل
  if (feature) { await wait(turbo ? 260 : 700); doSpin(); }
  else if (auto) { await wait(turbo ? 300 : 800); doSpin(); }
}

/* ------------------------------- شراء الميزة ------------------------------- */
async function buyFeature() {
  const cost = currentBet() * CFG.featureBuyCost;
  const okBuy = window.confirm(
    `شراء الدورات المجانية بـ ${fmt(cost)} عملة؟\n` +
    `(${CFG.featureBuyCost}× الرهان الحالي ${fmt(currentBet())})`
  );
  if (!okBuy) return;

  try {
    const res = await API.post('/api/slot/buy', { bet: currentBet() });
    Session.setPlayer({ ...Session.player, balance: res.balance });
    feature = res.feature;
    renderFeature();
    toast(`اشتريت ${feature.spinsLeft} دورة مجانية`, 'win');
    showOverlay(`الدورات المجانية<small>${feature.spinsLeft} دورة — بالتوفيق</small>`, 1600);
    await wait(1600);
    doSpin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------- جدول الأرباح ------------------------------- */
function buildPaytable() {
  const perWay = `الربح = (الرهان ÷ ${CFG.ways}) × القيمة × عدد الطرق`;

  const cells = Object.entries(CFG.paytable).map(([key, pays]) => `
    <div class="pay-cell">
      ${SYMBOL_ART[key] || ''}
      <div class="pay-cell__name">${escapeHtml(CFG.symbols[key] ? CFG.symbols[key].name : key)}</div>
      <div class="pay-cell__rows">
        ${[5, 4, 3].map((n) => pays[n]
          ? `<div><span>${n} بكرات</span><b>${fmt(pays[n])}</b></div>` : '').join('')}
        ${pays[3] ? '' : '<div style="color:var(--muted);font-size:10.5px">3 بكرات لا تدفع</div>'}
      </div>
    </div>`).join('');

  const special = `
    <div class="pay-cell pay-cell--special">
      ${SYMBOL_ART.WILD}
      <div class="pay-cell__name">وايلد</div>
      <p>يعوّض كل الرموز عدا سبائك الذهب. يظهر على البكرات 2 إلى 5 فقط.</p>
    </div>
    <div class="pay-cell pay-cell--special">
      ${SYMBOL_ART.SCATTER}
      <div class="pay-cell__name">سبائك الذهب (سكاتر)</div>
      <p>3 منها في أي مكان تفتح ${CFG.freeSpins.base} دورات مجانية،
         و${CFG.freeSpins.perExtra} دورات إضافية لكل سبيكة زائدة.</p>
    </div>`;

  el('payGrid').innerHTML = cells + special;

  el('payRules').innerHTML = `
    <div><b>${CFG.ways} طريقة للفوز</b> — لا خطوط. أي تطابق على بكرات متجاورة يبدأ من البكرة الأولى يُحتسب. ${perWay}.</div>
    <div><b>الحد الأدنى للفوز ${CFG.minReelsToWin || 4} بكرات</b> — ثلاث بكرات لا تدفع شيئاً.
         هذا يجعل الفوز حدثاً فعلياً: ${CFG.hitRate}% من الدورات رابحة بدل أن يمتلئ اللعب بأرباح أقل من الرهان.</div>
    <div><b>عدّاد المضاعفات</b> — داخل الدورات المجانية يتقدّم خطوة مع كل دورة رابحة
         (${CFG.multiplierLadder.join(' ← ×').replace(/^/, '×')})،
         ${CFG.multiplierResetsOnLoss ? 'ويعود إلى ×1 عند أول دورة خاسرة.' : 'ولا يعود للخلف.'}</div>
    <div><b>سقف الربح</b> — ×${fmt(CFG.maxWinMultiplier)} من الرهان للدورة الواحدة،
         و×${fmt(CFG.maxSessionMultiplier)} لجولة الدورات المجانية كاملة.</div>
    <div><b>أقصى رهان</b> — ${fmt(CFG.maxStake)} للدورة، بلا أي سقف على المضاعف يميّز رهاناً عن آخر.</div>
    <div><b>شراء الميزة</b> — ${CFG.featureBuyCost}× الرهان مقابل ${CFG.freeSpins.base} دورات مجانية.</div>
    <div><b>الأرقام المعلنة</b> — نسبة الدورات الرابحة ${CFG.hitRate}% ·
         الدورات المجانية تظهر مرة كل ${CFG.featureOdds} دورة تقريباً.</div>`;
}

/* ------------------------------- العدالة ------------------------------- */
function renderFair() {
  // عرض العدالة أُزيل من واجهة اللاعب؛ الآلية نفسها ما زالت تعمل في
  // الخادم وهي التي تمنع التلاعب. نخرج بهدوء إن لم تعد العناصر موجودة.
  if (!el('fairHashNow')) return;
  if (!lastFair) return;
  el('fairHashNow').textContent = lastFair.seedHash;
  el('fairNonce').textContent = lastFair.nonce;
  const prev = lastFair.previous;
  el('fairPrev').hidden = !prev;
  if (prev) {
    el('fairPrevSeed').textContent = prev.seed;
    el('fairPrevHash').textContent = prev.seedHash;
  }
}

/* ------------------------------- الاحتفال ------------------------------- */
function confettiBurst() {
  const canvas = el('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ['#f7c948', '#ffeaa7', '#29d98c', '#c065d8', '#e3ecf4'];
  const parts = [];
  for (let i = 0; i < 90; i++) {
    parts.push({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 200,
      y: window.innerHeight * 0.4,
      vx: (Math.random() - 0.5) * 10,
      vy: Math.random() * -12 - 4,
      size: Math.random() * 7 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 1
    });
  }
  const started = performance.now();
  (function frame() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    let alive = false;
    for (const p of parts) {
      p.vy += 0.34; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 0.009;
      if (p.life <= 0 || p.y > window.innerHeight + 40) continue;
      alive = true;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
      ctx.restore();
    }
    if (alive && performance.now() - started < 4200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  })();
}

/* ------------------------------- الأزرار ------------------------------- */
function initControls() {
  el('spinBtn').addEventListener('click', doSpin);
  el('buyBtn').addEventListener('click', buyFeature);

  el('betDown').addEventListener('click', () => { if (betIndex > 0) { betIndex -= 1; saveBet(); renderBet(); } });
  el('betUp').addEventListener('click', () => {
    if (betIndex < CFG.stakes.length - 1) { betIndex += 1; saveBet(); renderBet(); }
  });

  el('autoBtn').addEventListener('click', () => {
    auto = !auto;
    el('autoBtn').classList.toggle('is-on', auto);
    if (auto && !spinning && !feature) doSpin();
  });

  el('turboBtn').addEventListener('click', () => {
    turbo = !turbo;
    el('turboBtn').classList.toggle('is-on', turbo);
  });

  // الموسيقى: تبدأ عند أول تفاعل وتتوقف مع إغلاق الصفحة (انظر music.js)
  const music = initMusic('western');
  const paintMusic = () => {
    el('musicBtn').classList.toggle('is-on', music.enabled);
    el('musicBtn').title = music.enabled ? 'إيقاف الموسيقى' : 'تشغيل الموسيقى';
  };
  paintMusic();
  el('musicBtn').addEventListener('click', () => { music.toggle('western'); paintMusic(); });

  el('paytableBtn').addEventListener('click', () => { el('paytableModal').hidden = false; });
  if (el('fairBtn')) {
    el('fairBtn').addEventListener('click', () => { renderFair(); el('fairModal').hidden = false; });
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => { el(btn.dataset.close).hidden = true; });
  });
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => { if (e.target === bd) bd.hidden = true; });
  });

  if (el('rotateBtn')) el('rotateBtn').addEventListener('click', async () => {
    try {
      const res = await API.post('/api/slot/rotate');
      lastFair = res.next;
      lastFair.previous = { seed: res.revealed, seedHash: res.seedHash, spins: res.spins };
      renderFair();
      toast(`كُشفت البذرة بعد ${res.spins} دورة — يمكنك التحقق منها الآن`, 'win', 5000);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // مسافة = دورة
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); doSpin(); }
  });
}

function saveBet() {
  try { localStorage.setItem('ichance.slotBet', String(CFG.stakes[betIndex])); } catch { /* تجاهل */ }
}

/* ------------------------------- الإقلاع ------------------------------- */
(async function boot() {
  await bootSession();
  mountShell('slots');

  try {
    CFG = await API.get('/api/slot/config');
  } catch (err) {
    toast('تعذّر تحميل اللعبة — حدّث الصفحة', 'error', 8000);
    return;
  }

  el('backdrop').innerHTML = BACKDROP_SVG;
  document.querySelectorAll('.ways-badge').forEach((b) => {
    b.innerHTML = `${CFG.ways}<br><b>طريقة</b>`;
  });

  let saved = null;
  try { saved = Number(localStorage.getItem('ichance.slotBet')); } catch { /* تجاهل */ }
  const idx = CFG.stakes.indexOf(saved);
  betIndex = idx >= 0 ? idx : 0;

  buildReels();
  buildLadder();
  buildPaytable();
  initControls();
  paintRandom();

  try {
    const state = await API.get('/api/slot/state');
    feature = state.feature;
    lastFair = state.fair;
    renderFeature();
    renderFair();
    if (feature) {
      showOverlay(`لديك ميزة جارية<small>${feature.spinsLeft} دورة متبقية — اضغط أدر</small>`, 2600);
    }
  } catch { /* الحالة الأولية اختيارية */ }

  Session.onChange(renderBet);
  renderBet();
})();
