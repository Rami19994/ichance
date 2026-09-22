/**
 * LuckyArena — مناجم الحظ (Stake Mines Clone Controller)
 * تحكم كامل باللعبة، الربط الذري بالمحفظة، والمؤثرات الصوتية والعدالة المثبتة
 */

(function () {
  'use strict';

  // ------------------------- عناصر الواجهة -------------------------
  var balValEl = document.getElementById('walletBalance');
  var balCurEl = document.getElementById('walletCurrency');
  var betInput = document.getElementById('betAmount');
  var minesSelect = document.getElementById('minesCount');
  var gemsCountEl = document.getElementById('gemsCountDisplay');
  var minesCountEl = document.getElementById('minesCountDisplay');
  var actionBtn = document.getElementById('mainActionBtn');
  var actionBtnText = document.getElementById('actionBtnText');
  var actionBtnSub = document.getElementById('actionBtnSub');
  var randomBtn = document.getElementById('randomPickBtn');
  var gridEl = document.getElementById('minesGrid');
  var winOverlay = document.getElementById('winOverlay');
  var winMultEl = document.getElementById('winMultiplier');
  var winValEl = document.getElementById('winValue');
  var soundBtn = document.getElementById('soundBtn');
  var fsBtn = document.getElementById('fullscreenBtn');
  var pfBtn = document.getElementById('pfBtn');
  var pfModal = document.getElementById('pfModal');
  var pfClose = document.getElementById('pfClose');
  var pfServerHash = document.getElementById('pfServerHash');
  var pfClientSeed = document.getElementById('pfClientSeed');
  var pfServerSeed = document.getElementById('pfServerSeed');
  var bannerEl = document.getElementById('demoBanner');

  var statCurrentProfit = document.getElementById('statCurrentProfit');
  var statCurrentMult = document.getElementById('statCurrentMult');
  var statNextProfit = document.getElementById('statNextProfit');
  var statNextMult = document.getElementById('statNextMult');

  // ------------------------- حالة اللعبة -------------------------
  var token = localStorage.getItem('ichance_token') || '';
  var balance = 1000;
  var currency = 'IQD';
  var isGameActive = false;
  var isProcessing = false;
  var isMuted = localStorage.getItem('ichance_sound_muted') === 'true';

  var currentBet = 1000;
  var currentMines = 3;
  var currentMultiplier = 1.0;
  var revealedTiles = [];
  var currentSeedHash = '';

  // ------------------------- نظام المؤثرات الصوتية -------------------------
  var sounds = {
    click: new Audio('/assets/mines/audio/click.mp3'),
    start: new Audio('/assets/mines/audio/start.mp3'),
    gem: new Audio('/assets/mines/audio/gem.mp3'),
    bomb: new Audio('/assets/mines/audio/bomb.mp3'),
    cashout: new Audio('/assets/mines/audio/cashout.mp3'),
    reveal: new Audio('/assets/mines/audio/reveal.mp3')
  };

  function playSound(name, rate) {
    if (isMuted) return;
    var audio = sounds[name];
    if (audio) {
      audio.currentTime = 0;
      if (rate && isFinite(rate)) audio.playbackRate = Math.min(2.0, Math.max(0.7, rate));
      else audio.playbackRate = 1.0;
      audio.play().catch(function () {});
    }
  }

  function updateSoundIcon() {
    if (soundBtn) {
      soundBtn.textContent = isMuted ? '🔇' : '🔊';
    }
  }
  updateSoundIcon();

  if (soundBtn) {
    soundBtn.addEventListener('click', function () {
      isMuted = !isMuted;
      localStorage.setItem('ichance_sound_muted', isMuted ? 'true' : 'false');
      updateSoundIcon();
    });
  }

  // ------------------------- المساعدات والتنسيق -------------------------
  function fmt(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast-bubble toast-' + (type || 'info');
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:' + (type === 'error' ? '#ff3344' : type === 'success' ? '#00e701' : '#1a242d') + ';' +
      'color:' + (type === 'success' ? '#000' : '#fff') + ';' +
      'padding:12px 24px;border-radius:10px;font-weight:800;font-size:0.95rem;z-index:9999;' +
      'box-shadow:0 10px 30px rgba(0,0,0,0.5);transition:opacity 0.3s;';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 300);
    }, 3200);
  }

  // ------------------------- تهيئة مربعات الشبكة (5×5) -------------------------
  function buildGrid() {
    gridEl.innerHTML = '';
    for (var i = 0; i < 25; i++) {
      var tile = document.createElement('div');
      tile.className = 'mines-tile';
      tile.dataset.index = i;
      tile.addEventListener('click', onTileClick);
      gridEl.appendChild(tile);
    }
  }

  // ------------------------- مزامنة المحفظة والحالة -------------------------
  async function syncWallet() {
    if (!token) {
      balValEl.textContent = fmt(balance);
      balCurEl.textContent = 'DEMO';
      if (bannerEl) {
        bannerEl.innerHTML = '⚡ وضع تجريبي للتسلية. <a href="/login">سجّل دخولك</a> للّعب برصيدك الحقيقي وسحب الأرباح.';
      }
      return;
    }

    try {
      var res = await fetch('/api/mines/state', {
        headers: { 'x-player-token': token }
      });
      if (res.ok) {
        var data = await res.json();
        balance = data.balance;
        currency = data.currency || 'IQD';
        balValEl.textContent = fmt(balance);
        balCurEl.textContent = currency;
        if (bannerEl) bannerEl.hidden = true;

        // استعادة جولة جارية إن وجدت
        if (data.active && !isGameActive) {
          restoreActiveGame(data);
        }
      } else if (res.status === 401) {
        token = '';
        localStorage.removeItem('ichance_token');
        syncWallet();
      }
    } catch (err) {
      console.warn('[Mines] Wallet sync error:', err.message);
    }
  }

  // استعادة جلسة نشطة عند تحديث الصفحة
  function restoreActiveGame(data) {
    isGameActive = true;
    currentBet = data.bet;
    currentMines = data.minesCount;
    currentMultiplier = data.currentMultiplier || 1.0;
    revealedTiles = data.revealedTiles || [];
    currentSeedHash = data.seedHash || '';

    betInput.value = currentBet;
    minesSelect.value = currentMines;
    betInput.disabled = true;
    minesSelect.disabled = true;

    updateCounts();
    revealedTiles.forEach(function (idx) {
      var tile = gridEl.children[idx];
      if (tile) {
        tile.className = 'mines-tile revealed gem-tile';
        tile.innerHTML = '<img src="/assets/mines/diamond.svg" alt="Gem">';
      }
    });

    updateStats(data.currentMultiplier, data.currentProfit, data.nextMultiplier, data.nextProfit);
    updateActionBtn();
  }

  function updateCounts() {
    var m = parseInt(minesSelect.value, 10) || 3;
    var g = 25 - m;
    gemsCountEl.textContent = g;
    minesCountEl.textContent = m;
  }
  minesSelect.addEventListener('change', updateCounts);
  updateCounts();

  function updateStats(curM, curP, nextM, nextP) {
    statCurrentMult.textContent = '×' + (curM || 1.0).toFixed(2);
    statCurrentProfit.textContent = (curP > 0 ? '+' : '') + fmt(curP || 0) + ' ' + currency;

    if (nextM) {
      statNextMult.textContent = '×' + Number(nextM).toFixed(2);
      statNextProfit.textContent = '+' + fmt(nextP || 0) + ' ' + currency;
    } else {
      statNextMult.textContent = '—';
      statNextProfit.textContent = '—';
    }
  }

  function updateActionBtn() {
    if (!isGameActive) {
      actionBtn.className = 'mines-main-btn';
      actionBtnText.textContent = 'ابدأ الرهان (Bet)';
      actionBtnSub.textContent = 'اختر رهانك والألغام وابدأ اللعب';
      randomBtn.disabled = true;
      betInput.disabled = false;
      minesSelect.disabled = false;
    } else {
      actionBtn.className = 'mines-main-btn mines-main-btn--cashout';
      var cashoutVal = Math.round(currentBet * currentMultiplier);
      if (revealedTiles.length === 0) {
        actionBtnText.textContent = 'اكشف المربعات...';
        actionBtnSub.textContent = 'اكشف جوهرة واحدة على الأقل لتتمكن من السحب';
        actionBtn.disabled = true;
      } else {
        actionBtnText.textContent = 'سحب الأرباح (Cash Out)';
        actionBtnSub.textContent = fmt(cashoutVal) + ' ' + currency + ' (×' + currentMultiplier.toFixed(2) + ')';
        actionBtn.disabled = false;
      }
      randomBtn.disabled = false;
      betInput.disabled = true;
      minesSelect.disabled = true;
    }
  }

  // ------------------------- أزرار الرهان السريع -------------------------
  document.querySelectorAll('.mines-btn-quick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (isGameActive) return;
      var cur = Math.max(100, Math.floor(Number(betInput.value) || 100));
      var action = btn.dataset.action;
      if (action === 'half') cur = Math.max(100, Math.floor(cur / 2));
      else if (action === 'double') cur = Math.min(1000000, cur * 2);
      else if (action === 'min') cur = 100;
      else if (action === 'max') cur = Math.min(1000000, balance > 0 ? balance : 50000);
      betInput.value = cur;
    });
  });

  // ------------------------- بدء اللعبة -------------------------
  async function onStartGame() {
    if (isProcessing) return;
    var bet = Math.max(100, Math.floor(Number(betInput.value) || 100));
    var mines = parseInt(minesSelect.value, 10) || 3;

    if (token && balance < bet) {
      toast('رصيدك لا يكفي لإتمام هذا الرهان. يرجى شحن الرصيد.', 'error');
      return;
    }

    isProcessing = true;
    actionBtn.disabled = true;

    // الوضع التجريبي للزوار غير المسجلين
    if (!token) {
      if (balance < bet) balance = 5000;
      balance -= bet;
      balValEl.textContent = fmt(balance);
      startLocalDemoGame(bet, mines);
      isProcessing = false;
      return;
    }

    try {
      var res = await fetch('/api/mines/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-player-token': token
        },
        body: JSON.stringify({ bet: bet, minesCount: mines })
      });
      var data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error || 'تعذّر بدء اللعبة', 'error');
        isProcessing = false;
        actionBtn.disabled = false;
        return;
      }

      isGameActive = true;
      currentBet = data.bet;
      currentMines = data.minesCount;
      currentMultiplier = 1.0;
      revealedTiles = [];
      currentSeedHash = data.seedHash;
      balance = data.balance;
      balValEl.textContent = fmt(balance);

      buildGrid();
      winOverlay.classList.remove('show');
      playSound('start');

      updateStats(1.0, 0, data.nextMultiplier, Math.round(currentBet * data.nextMultiplier) - currentBet);
      updateActionBtn();
    } catch (err) {
      toast('خطأ في الاتصال بالخادم', 'error');
    } finally {
      isProcessing = false;
    }
  }

  // محاكاة وضع التجربة محلياً
  var demoMines = new Set();
  function startLocalDemoGame(bet, mines) {
    isGameActive = true;
    currentBet = bet;
    currentMines = mines;
    currentMultiplier = 1.0;
    revealedTiles = [];
    demoMines = new Set();
    while (demoMines.size < mines) {
      demoMines.add(Math.floor(Math.random() * 25));
    }
    buildGrid();
    winOverlay.classList.remove('show');
    playSound('start');

    var nextM = calculateDemoMultiplier(mines, 1);
    updateStats(1.0, 0, nextM, Math.round(bet * nextM) - bet);
    updateActionBtn();
  }

  function calculateDemoMultiplier(m, k) {
    var mult = 1.0;
    for (var i = 0; i < k; i++) mult *= (25 - i) / (25 - m - i);
    return Number((mult * 0.97).toFixed(2));
  }

  // ------------------------- نقر مربع -------------------------
  async function onTileClick(e) {
    var tile = e.currentTarget;
    var idx = parseInt(tile.dataset.index, 10);

    if (!isGameActive || isProcessing) return;
    if (tile.classList.contains('revealed')) return;

    isProcessing = true;

    // وضع الديمو
    if (!token) {
      handleDemoTileClick(tile, idx);
      isProcessing = false;
      return;
    }

    try {
      var res = await fetch('/api/mines/reveal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-player-token': token
        },
        body: JSON.stringify({ tileIndex: idx })
      });
      var data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error || 'خطأ في كشف المربع', 'error');
        isProcessing = false;
        return;
      }

      // هل انفجر اللغم؟
      if (data.hitMine) {
        onMineExploded(data, idx);
      } else {
        // جوهرة
        onGemRevealed(data, idx);
      }
    } catch (err) {
      toast('خطأ في الاتصال بالخادم', 'error');
    } finally {
      isProcessing = false;
    }
  }

  function onGemRevealed(data, idx) {
    var tile = gridEl.children[idx];
    tile.className = 'mines-tile revealed gem-tile';
    tile.innerHTML = '<img src="/assets/mines/diamond.svg" alt="Gem">';
    revealedTiles = data.revealedTiles;
    currentMultiplier = data.multiplier;

    // تدرج صوتي لنغمات الجواهر مع كل نجاح
    var pitch = 1.0 + (revealedTiles.length * 0.04);
    playSound('gem', pitch);

    if (data.allGemsFound) {
      // الفوز بجميع الجواهر الممكنة
      isGameActive = false;
      balance = data.balance;
      balValEl.textContent = fmt(balance);
      playSound('cashout');
      showWinOverlay(data.multiplier, data.win);
      revealRemainingBoard(data.mines, []);
      updateActionBtn();
      syncWallet();
    } else {
      updateStats(data.multiplier, data.currentProfit, data.nextMultiplier, data.nextProfit);
      updateActionBtn();
    }
  }

  function onMineExploded(data, explodedIdx) {
    isGameActive = false;
    balance = data.balance;
    balValEl.textContent = fmt(balance);

    var explodedTile = gridEl.children[explodedIdx];
    explodedTile.className = 'mines-tile revealed bomb-tile';
    explodedTile.innerHTML = '<img src="/assets/mines/bomb.svg" alt="Mine">';

    playSound('bomb');
    toast('💥 انفجر اللغم! خسرت الجولة.', 'error');

    // كشف باقي الألغام المتبقية بشفافية خافتة
    revealRemainingBoard(data.mines, [explodedIdx]);

    if (data.serverSeed && pfServerSeed) {
      pfServerSeed.value = data.serverSeed;
    }

    updateActionBtn();
    syncWallet();
  }

  function revealRemainingBoard(mines, ignoreList) {
    var mineSet = new Set(mines);
    for (var i = 0; i < 25; i++) {
      if (ignoreList.indexOf(i) !== -1) continue;
      var tile = gridEl.children[i];
      if (tile.classList.contains('revealed')) continue;

      tile.classList.add('revealed', 'faded');
      if (mineSet.has(i)) {
        tile.innerHTML = '<img src="/assets/mines/bomb.svg" alt="Mine">';
      } else {
        tile.innerHTML = '<img src="/assets/mines/diamond.svg" alt="Gem">';
      }
    }
  }

  function handleDemoTileClick(tile, idx) {
    if (demoMines.has(idx)) {
      isGameActive = false;
      tile.className = 'mines-tile revealed bomb-tile';
      tile.innerHTML = '<img src="/assets/mines/bomb.svg" alt="Mine">';
      playSound('bomb');
      toast('💥 انفجر اللغم (وضع تجريبي)!', 'error');
      revealRemainingBoard(Array.from(demoMines), [idx]);
      updateActionBtn();
    } else {
      tile.className = 'mines-tile revealed gem-tile';
      tile.innerHTML = '<img src="/assets/mines/diamond.svg" alt="Gem">';
      revealedTiles.push(idx);

      var pitch = 1.0 + (revealedTiles.length * 0.04);
      playSound('gem', pitch);

      var k = revealedTiles.length;
      var mult = calculateDemoMultiplier(currentMines, k);
      currentMultiplier = mult;

      var currentProfit = Math.round(currentBet * mult) - currentBet;
      var nextMult = calculateDemoMultiplier(currentMines, k + 1);
      var nextProfit = Math.round(currentBet * nextMult) - currentBet;

      updateStats(mult, currentProfit, nextMult, nextProfit);
      updateActionBtn();
    }
  }

  // ------------------------- سحب الأرباح (Cash Out) -------------------------
  async function onCashOut() {
    if (!isGameActive || isProcessing) return;
    if (revealedTiles.length === 0) return;

    isProcessing = true;
    actionBtn.disabled = true;

    // وضع الديمو
    if (!token) {
      isGameActive = false;
      var win = Math.round(currentBet * currentMultiplier);
      balance += win;
      balValEl.textContent = fmt(balance);
      playSound('cashout');
      showWinOverlay(currentMultiplier, win);
      revealRemainingBoard(Array.from(demoMines), []);
      updateActionBtn();
      isProcessing = false;
      return;
    }

    try {
      var res = await fetch('/api/mines/cashout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-player-token': token
        }
      });
      var data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error || 'تعذّر سحب الأرباح', 'error');
        isProcessing = false;
        actionBtn.disabled = false;
        return;
      }

      isGameActive = false;
      balance = data.balance;
      balValEl.textContent = fmt(balance);

      playSound('cashout');
      showWinOverlay(data.multiplier, data.win);
      revealRemainingBoard(data.mines, []);

      if (data.serverSeed && pfServerSeed) {
        pfServerSeed.value = data.serverSeed;
      }

      updateActionBtn();
      syncWallet();
    } catch (err) {
      toast('خطأ في الاتصال بالخادم', 'error');
    } finally {
      isProcessing = false;
    }
  }

  function showWinOverlay(mult, amount) {
    winMultEl.textContent = '×' + mult.toFixed(2);
    winValEl.textContent = fmt(amount) + ' ' + currency;
    winOverlay.classList.add('show');
    setTimeout(function () {
      winOverlay.classList.remove('show');
    }, 3800);
  }

  // ------------------------- زر الإجراء المشترك -------------------------
  actionBtn.addEventListener('click', function () {
    if (!isGameActive) {
      onStartGame();
    } else {
      onCashOut();
    }
  });

  // ------------------------- الاختيار العشوائي (Random Pick) -------------------------
  randomBtn.addEventListener('click', async function () {
    if (!isGameActive || isProcessing) return;

    if (!token) {
      var unrevealed = [];
      for (var i = 0; i < 25; i++) {
        if (revealedTiles.indexOf(i) === -1) unrevealed.push(i);
      }
      if (unrevealed.length) {
        var pick = unrevealed[Math.floor(Math.random() * unrevealed.length)];
        var tile = gridEl.children[pick];
        handleDemoTileClick(tile, pick);
      }
      return;
    }

    isProcessing = true;
    try {
      var res = await fetch('/api/mines/random-pick', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-player-token': token
        }
      });
      var data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error || 'خطأ في الاختيار', 'error');
        return;
      }

      if (data.hitMine) {
        onMineExploded(data, data.explodedTile);
      } else {
        onGemRevealed(data, data.revealedTile);
      }
    } catch (err) {
      toast('خطأ في الاتصال بالخادم', 'error');
    } finally {
      isProcessing = false;
    }
  });

  // ------------------------- ملء الشاشة -------------------------
  if (fsBtn) {
    fsBtn.addEventListener('click', function () {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () {});
      } else {
        document.exitFullscreen().catch(function () {});
      }
    });
  }

  // ------------------------- نافذة العدالة المثبتة -------------------------
  if (pfBtn && pfModal) {
    pfBtn.addEventListener('click', function () {
      if (pfServerHash) pfServerHash.value = currentSeedHash || 'تبدأ مع أول جولة';
      pfModal.hidden = false;
    });
    pfClose.addEventListener('click', function () {
      pfModal.hidden = true;
    });
    pfModal.addEventListener('click', function (e) {
      if (e.target === pfModal) pfModal.hidden = true;
    });
  }

  // ------------------------- التهيئة عند الإقلاع -------------------------
  buildGrid();
  syncWallet();
  setInterval(syncWallet, 8000);
})();
