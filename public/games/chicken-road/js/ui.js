/**
 * CHICKEN ROAD — LuckyArena: ربط الواجهة
 * الرصيد رصيد المحفظة الحقيقي (أو التجريبي للزائر)، والشحن عبر الكاشير.
 */

document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const fmt = (n) => Math.floor(Number(n) || 0).toLocaleString('en-US');

    // 1. المحرك ثلاثي الأبعاد واللعبة
    const world = new GameWorld($('game-canvas-container'));
    const game = new ChickenRoadGame();
    game.init(world);

    // 2. عناصر الواجهة
    const uiBalance = $('ui-balance');
    const uiCurrency = $('ui-currency');
    const uiBestScore = $('ui-best-score');
    const uiCurrentStep = $('ui-current-step');
    const uiUsedCoins = $('ui-used-coins');
    const uiPotentialPrize = $('ui-potential-prize');
    const uiFirstMult = $('ui-first-mult');
    const modeBadge = $('ui-mode-badge');
    const demoBanner = $('demo-banner');

    const panelBetting = $('panel-betting');
    const panelInGame = $('panel-in-game');
    const btnStart = $('btn-start');
    const btnCross = $('btn-cross');
    const btnCrossLabel = $('btn-cross-label');
    const btnCashout = $('btn-cashout');
    const btnCashoutAmount = $('btn-cashout-amount');
    const inGameMultiplier = $('in-game-multiplier');
    const inGamePrize = $('in-game-prize');
    const inGameNextMult = $('in-game-next-mult');

    const ladderList = $('ladder-list');
    const safeToast = $('safe-toast');
    const modalCashout = $('modal-cashout');
    const modalCrash = $('modal-crash');
    const modalHistory = $('modal-history');
    const btnPlayAgain = $('btn-play-again');
    const btnTryAgain = $('btn-try-again');
    const soundIcon = $('sound-icon');
    const selectDifficulty = $('select-difficulty');
    const historyList = $('history-list');

    // 3. تنبيه قصير أسفل الشاشة
    let toastTimer = null;
    function notice(msg) {
        const el = $('cr-notice');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
    }
    game.onError = notice;

    // 4. سلّم المضاعفات
    function buildMultiplierLadder() {
        ladderList.innerHTML = '';
        [...CONFIG.stages].reverse().forEach(stage => {
            const item = document.createElement('div');
            item.className = 'ladder-item' + (stage.lane >= 10 ? ' high-tier' : '');
            item.id = `ladder-item-${stage.lane}`;
            item.innerHTML = `<span class="lane-no">${stage.lane}</span><span class="lane-mult">x${stage.multiplier.toFixed(2)}</span>`;
            ladderList.appendChild(item);
        });
        updateLadderUI(game.currentStep);
    }

    function updateLadderUI(currentStep) {
        document.querySelectorAll('.ladder-item').forEach(el => el.classList.remove('active', 'next'));
        if (currentStep > 0) {
            const activeEl = $(`ladder-item-${currentStep}`);
            if (activeEl) {
                activeEl.classList.add('active');
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
        const nextEl = $(`ladder-item-${currentStep + 1}`);
        if (nextEl) nextEl.classList.add('next');
    }

    game.onLadderChange = () => {
        buildMultiplierLadder();
        updateBetDisplays();
        selectDifficulty.value = game.difficulty;
    };

    game.onModeChange = () => {
        modeBadge.textContent = game.demo ? 'تجريبي' : 'رصيد حقيقي';
        modeBadge.classList.toggle('is-real', !game.demo);
        demoBanner.hidden = !game.demo;
        uiCurrency.textContent = game.currency;
        if (!game.enabled) {
            btnStart.disabled = true;
            btnStart.querySelector('.btn-text-main').textContent = 'اللعبة متوقفة مؤقتاً';
        }
    };

    // 5. الرصيد والرهان
    game.onBalanceChange = (balance, bestScore) => {
        uiBalance.textContent = fmt(balance);
        uiBestScore.textContent = fmt(bestScore);
        updateBetDisplays();
    };

    function updateBetDisplays() {
        uiUsedCoins.textContent = fmt(game.currentBet);
        const first = CONFIG.stages[0].multiplier;
        uiFirstMult.textContent = `x${first.toFixed(2)}`;
        uiPotentialPrize.textContent = fmt(game.currentBet * first);
        document.querySelectorAll('.btn-chip').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.bet, 10) === game.currentBet);
        });
    }

    game.onStateChange = (state) => {
        const total = CONFIG.stages.length;
        switch (state) {
            case GameState.BETTING:
                panelBetting.style.display = 'flex';
                panelInGame.style.display = 'none';
                selectDifficulty.disabled = false;
                uiCurrentStep.textContent = `0 / ${total}`;
                updateLadderUI(0);
                updateBetDisplays();
                closeAllModals();
                break;

            case GameState.WAITING_STEP: {
                panelBetting.style.display = 'none';
                panelInGame.style.display = 'flex';
                selectDifficulty.disabled = true;
                uiCurrentStep.textContent = `${game.currentStep} / ${total}`;
                inGameMultiplier.textContent = `x${game.currentMultiplier.toFixed(2)}`;
                inGamePrize.textContent = fmt(game.currentPrize);

                if (game.currentStep < total) {
                    inGameNextMult.textContent = `x${CONFIG.stages[game.currentStep].multiplier.toFixed(2)}`;
                    btnCross.disabled = false;
                    btnCrossLabel.textContent = game.currentStep === 0 ? 'تقدّم خطوة' : 'استمر للمسار التالي';
                } else {
                    inGameNextMult.textContent = '🏆 خط النهاية';
                    btnCross.disabled = true;
                }
                btnCashout.disabled = game.currentStep === 0;
                btnCashoutAmount.textContent = game.currentStep > 0 ? fmt(game.currentPrize) : '0';
                updateLadderUI(game.currentStep);
                break;
            }

            case GameState.CROSSING:
                btnCross.disabled = true;
                btnCashout.disabled = true;
                break;

            case GameState.CRASHED:
            case GameState.CASHED_OUT:
            case GameState.FINISHED_ALL:
                panelInGame.style.display = 'none';
                break;
        }
    };

    game.onStepSuccess = ({ step, multiplier, prize }) => {
        $('toast-step').textContent = step;
        $('toast-mult').textContent = `x${multiplier.toFixed(2)}`;
        $('toast-prize').textContent = fmt(prize);
        safeToast.classList.add('show');
        setTimeout(() => safeToast.classList.remove('show'), 1200);
    };

    game.onCrash = ({ step }) => {
        $('crash-step').textContent = `المسار ${step + 1}`;
        $('crash-bet').textContent = fmt(game.currentBet);
        setTimeout(() => modalCrash.classList.add('open'), 300);
    };

    game.onCashOut = ({ steps, multiplier, prize, isGrandWin }) => {
        $('cashout-title').textContent = isGrandWin ? '🏆 فوز ساحق! عبرت كل المسارات!' : '🏆 تم جمع الجائزة!';
        $('cashout-steps').textContent = steps;
        $('cashout-mult').textContent = `x${multiplier.toFixed(2)}`;
        $('cashout-prize').textContent = fmt(prize);
        setTimeout(() => modalCashout.classList.add('open'), 200);
    };

    // 6. أزرار الرهان
    document.querySelectorAll('.btn-chip').forEach(btn => {
        btn.addEventListener('click', () => game.setBet(parseInt(btn.dataset.bet, 10)));
    });
    $('btn-bet-half').addEventListener('click', () => game.multiplyBet(0.5));
    $('btn-bet-double').addEventListener('click', () => game.multiplyBet(2.0));
    $('btn-bet-max').addEventListener('click', () => game.setMaxBet());

    btnStart.addEventListener('click', () => { audio.resume(); game.startRound(); });
    btnCross.addEventListener('click', () => game.crossNextStep());
    btnCashout.addEventListener('click', () => game.cashOut());

    btnPlayAgain.addEventListener('click', () => {
        audio.playClick();
        modalCashout.classList.remove('open');
        game.resetForNewRound();
    });
    btnTryAgain.addEventListener('click', () => {
        audio.playClick();
        modalCrash.classList.remove('open');
        game.resetForNewRound();
    });

    $('btn-deposit').addEventListener('click', () => {
        if (game.demo) { location.href = '/login?next=/chicken-road'; return; }
        notice(game.username
            ? `للشحن تواصل مع الكاشير الخاص بك وأعطه اسم المستخدم: ${game.username}`
            : 'للشحن تواصل مع الكاشير الخاص بك');
    });

    $('btn-sound').addEventListener('click', () => {
        audio.resume();
        soundIcon.textContent = audio.toggleMute() ? '🔇' : '🔊';
    });
    soundIcon.textContent = audio.isMuted ? '🔇' : '🔊';

    selectDifficulty.addEventListener('change', (e) => {
        game.setDifficulty(e.target.value);
        audio.playClick();
    });

    // 7. سجل الجولات
    $('btn-history').addEventListener('click', () => {
        audio.playClick();
        renderHistory();
        modalHistory.classList.add('open');
    });
    $('btn-close-history').addEventListener('click', () => modalHistory.classList.remove('open'));
    modalHistory.addEventListener('click', (e) => { if (e.target === modalHistory) modalHistory.classList.remove('open'); });

    function renderHistory() {
        if (!game.history.length) {
            historyList.innerHTML = '<p class="empty-history">لا توجد جولات بعد. ابدأ اللعب الآن!</p>';
            return;
        }
        historyList.innerHTML = '';
        game.history.forEach(item => {
            const div = document.createElement('div');
            div.className = `history-item ${item.won ? 'win' : 'loss'}`;
            const top = document.createElement('div');
            top.className = 'history-top';
            top.innerHTML = `<span>${item.won ? '🏆 فوز' : '💥 خسارة'}</span><span class="history-time"></span>`;
            top.querySelector('.history-time').textContent = item.time;
            const mid = document.createElement('div');
            mid.innerHTML = `الخطوات: <b>${Number(item.steps) || 0}</b> · الرهان: <b>${fmt(item.bet)}</b>`;
            const res = document.createElement('div');
            res.className = item.won ? 'highlight-green' : 'highlight-red';
            res.style.fontWeight = '800';
            res.textContent = item.won ? `+${fmt(item.prize)} (x${Number(item.multiplier).toFixed(2)})` : '0';
            div.append(top, mid, res);
            historyList.appendChild(div);
        });
    }

    function closeAllModals() {
        modalCashout.classList.remove('open');
        modalCrash.classList.remove('open');
        modalHistory.classList.remove('open');
    }

    // 8. اختصارات لوحة المفاتيح
    window.addEventListener('keydown', (e) => {
        audio.resume();
        if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
            e.preventDefault();
            if (modalCashout.classList.contains('open')) return btnPlayAgain.click();
            if (modalCrash.classList.contains('open')) return btnTryAgain.click();
            if (game.state === GameState.BETTING) return game.startRound();
            if (game.state === GameState.WAITING_STEP) return game.crossNextStep();
        }
        if ((e.code === 'KeyC' || e.code === 'Escape') && game.state === GameState.WAITING_STEP && game.currentStep > 0) {
            e.preventDefault();
            game.cashOut();
        }
    });

    // 9. الإقلاع: الحالة من الخادم، ثم مزامنة الرصيد دورياً
    (async function boot() {
        for (let attempt = 0; ; attempt++) {
            try { await game.load(); break; }
            catch (err) {
                if (attempt === 0) notice(err.message || 'تعذّر تحميل اللعبة');
                await new Promise(r => setTimeout(r, 3000));
            }
        }
        setInterval(() => { if (!document.hidden && game.state === GameState.BETTING) game.syncBalance(); }, 10000);
    })();
});
