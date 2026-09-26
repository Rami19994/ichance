/**
 * CHICKEN ROAD — LuckyArena: منطق الجولة وربطها بالخادم
 * ----------------------------------------------------------------------------
 * الخادم (server/chickenGame.js) يقرّر كل خطوة ويمسك المال:
 *   start ← يخصم الرهان · cross ← ينجو أم يصطدم · cashout ← يدفع الجائزة.
 * المتصفح يرسم النتيجة فقط. الوضع التجريبي (بلا تسجيل دخول) رصيده وهمي في
 * المتصفح، ونتيجة كل خطوة فيه أيضاً من الخادم — لا احتمالات في هذا الملف.
 */

const GameState = {
    BETTING: "BETTING",           // اختيار الرهان قبل الانطلاق
    WAITING_STEP: "WAITING_STEP", // بانتظار قرار اللاعب (تقدّم أو اجمع)
    CROSSING: "CROSSING",         // طلب الخطوة وحركة القفزة
    CRASHED: "CRASHED",
    CASHED_OUT: "CASHED_OUT",
    FINISHED_ALL: "FINISHED_ALL"
};

const DEMO_KEY = 'ichance_demo_balance';

function readToken() {
    try { return localStorage.getItem('ichance.token') || localStorage.getItem('ichance_token') || ''; }
    catch (e) { return ''; }
}

class ChickenRoadGame {
    constructor() {
        this.state = GameState.BETTING;
        this.world = null;

        this.token = readToken();
        this.demo = true;
        this.enabled = true;
        this.currency = 'IQD';
        this.username = null;
        this.balance = 0;
        this.ladders = null;
        this.minBet = CONFIG.minBet;
        this.maxBet = CONFIG.maxBet;

        this.currentBet = CONFIG.defaultBet;
        this.difficulty = CONFIG.defaultDifficulty;
        this.currentStep = 0;
        this.currentMultiplier = 1.0;
        this.currentPrize = 0;
        this.busy = false;

        this.history = [];
        this.bestScore = 0;

        // معالجات الواجهة
        this.onStateChange = null;
        this.onBalanceChange = null;
        this.onStepSuccess = null;
        this.onCrash = null;
        this.onCashOut = null;
        this.onLadderChange = null;
        this.onError = null;
        this.onModeChange = null;
    }

    init(worldInstance) {
        this.world = worldInstance;
        this.setState(GameState.BETTING);
    }

    // ───────────────────────────────────────────── الاتصال
    async api(method, path, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['x-player-token'] = this.token;
        let res;
        try {
            res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch (e) {
            const err = new Error('تعذّر الاتصال بالخادم');
            err.network = true;
            throw err;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `خطأ ${res.status}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    /** يحمّل الحالة من الخادم: الرصيد، المضاعفات، وجولة جارية إن وُجدت. */
    async load() {
        this.token = readToken();
        const [st, cfg] = await Promise.all([
            this.api('GET', '/api/chicken/state'),
            this.api('GET', '/api/config').catch(() => null)
        ]);
        this.ladders = st.ladders;
        this.minBet = st.minStake;
        this.maxBet = st.maxStake;
        this.enabled = !(cfg && cfg.games && cfg.games.chicken === false);
        this.demo = !(this.token && st.loggedIn);
        this.username = st.username || null;
        this.currency = this.demo ? 'DEMO' : (st.currency || 'IQD');
        this.balance = this.demo ? this.demoBalance() : Number(st.balance) || 0;
        this.loadHistory();
        if (this.onModeChange) this.onModeChange();

        if (!this.demo && st.round) {
            this.resume(st.round);
        } else if (this.state === GameState.BETTING) {
            this.applyDifficulty(this.difficulty);
        }
        this.notifyBalanceUpdate();
        return st;
    }

    /** مزامنة الرصيد فقط (الكاشير قد يعبّئ أثناء اللعب). */
    async syncBalance() {
        if (this.demo || this.busy) return;
        try {
            const st = await this.api('GET', '/api/chicken/state');
            if (this.busy) return;
            this.balance = Number(st.balance) || 0;
            this.notifyBalanceUpdate();
        } catch (e) { /* تجاهل */ }
    }

    demoBalance() {
        try {
            const v = parseInt(localStorage.getItem(DEMO_KEY), 10);
            return Number.isFinite(v) ? v : 100000;
        } catch (e) { return 100000; }
    }

    saveDemoBalance() {
        try { localStorage.setItem(DEMO_KEY, String(this.balance)); } catch (e) {}
    }

    // ───────────────────────────────────────────── السجل وأفضل فوز (للاعب نفسه)
    storeKey(name) { return `chicken:${name}:${this.demo ? 'demo' : (this.username || 'me')}`; }

    loadHistory() {
        try {
            this.history = JSON.parse(localStorage.getItem(this.storeKey('hist')) || '[]');
            this.bestScore = parseInt(localStorage.getItem(this.storeKey('best')), 10) || 0;
        } catch (e) { this.history = []; this.bestScore = 0; }
    }

    addHistoryRecord(won, bet, steps, prize, multiplier = 1.0) {
        this.history.unshift({
            won, bet, steps, multiplier, prize,
            time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        });
        if (this.history.length > 20) this.history.length = 20;
        if (won && prize > this.bestScore) this.bestScore = prize;
        try {
            localStorage.setItem(this.storeKey('hist'), JSON.stringify(this.history));
            localStorage.setItem(this.storeKey('best'), String(this.bestScore));
        } catch (e) {}
    }

    notifyBalanceUpdate() {
        if (this.onBalanceChange) this.onBalanceChange(this.balance, this.bestScore);
    }

    setState(newState, payload = {}) {
        this.state = newState;
        if (this.onStateChange) {
            this.onStateChange(newState, {
                step: this.currentStep,
                multiplier: this.currentMultiplier,
                prize: this.currentPrize,
                bet: this.currentBet,
                ...payload
            });
        }
    }

    error(message) {
        if (this.onError) this.onError(message);
    }

    // ───────────────────────────────────────────── الرهان والصعوبة
    clampBet(amount) {
        const cap = this.demo ? this.maxBet : Math.min(this.maxBet, Math.max(this.minBet, Math.floor(this.balance)));
        return Math.min(Math.max(this.minBet, Math.floor(amount) || this.minBet), cap);
    }

    setBet(amount) {
        if (this.state !== GameState.BETTING) return;
        this.currentBet = this.clampBet(amount);
        audio.playClick();
        this.setState(GameState.BETTING);
    }

    multiplyBet(factor) {
        if (this.state !== GameState.BETTING) return;
        this.setBet(Math.round(this.currentBet * factor));
    }

    setMaxBet() {
        if (this.state !== GameState.BETTING) return;
        this.setBet(this.demo ? this.maxBet : this.balance);
    }

    applyDifficulty(diffKey) {
        if (!this.ladders || !this.ladders[diffKey]) return;
        this.difficulty = diffKey;
        setLadder(this.ladders[diffKey]);
        if (this.world) this.world.updateLaneBadges();
        if (this.onLadderChange) this.onLadderChange();
    }

    setDifficulty(diffKey) {
        if (this.state !== GameState.BETTING) return;
        this.applyDifficulty(diffKey);
        this.setState(GameState.BETTING);
    }

    /** جولة جارية من الخادم (بعد تحديث الصفحة): تُستأنف من خطوتها. */
    resume(round) {
        this.applyDifficulty(round.difficulty);
        this.currentBet = round.bet;
        this.currentStep = round.step;
        this.currentMultiplier = round.multiplier;
        this.currentPrize = round.step > 0 ? round.prize : round.bet;
        this.world.resetChicken();
        if (round.step > 0) this.world.placeChicken(round.step);
        this.setState(GameState.WAITING_STEP, { isInitial: round.step === 0, resumed: true });
    }

    // ───────────────────────────────────────────── الجولة
    async startRound() {
        if (this.state !== GameState.BETTING || this.busy) return;
        if (!this.enabled) { this.error('اللعبة متوقفة مؤقتاً'); return; }
        this.currentBet = this.clampBet(this.currentBet);

        if (this.demo) {
            if (this.balance < this.currentBet) {
                this.balance = 50000;
                this.error('أُعيد شحن رصيد التجربة 50,000 تلقائياً');
            }
            this.balance -= this.currentBet;
            this.saveDemoBalance();
        } else {
            if (this.balance < this.currentBet) {
                this.error('رصيدك لا يكفي لهذا الرهان — اضغط «شحن»');
                return;
            }
            this.busy = true;
            try {
                const out = await this.api('POST', '/api/chicken/start', { bet: this.currentBet, difficulty: this.difficulty });
                this.balance = Number(out.balance) || 0;
            } catch (err) {
                this.busy = false;
                if (err.status === 401) { location.href = '/login?next=/chicken-road'; return; }
                if (err.data && err.data.round) { this.resume(err.data.round); this.error('أكمل جولتك الجارية أولاً'); return; }
                this.error(err.message);
                return;
            }
            this.busy = false;
        }

        this.notifyBalanceUpdate();
        this.currentStep = 0;
        this.currentMultiplier = 1.0;
        this.currentPrize = this.currentBet;
        this.world.resetChicken();
        audio.playClick();
        this.setState(GameState.WAITING_STEP, { isInitial: true });
    }

    async crossNextStep() {
        if (this.state !== GameState.WAITING_STEP || this.busy) return;
        const totalStages = CONFIG.stages.length;
        if (this.currentStep >= totalStages) return;

        this.setState(GameState.CROSSING);
        this.busy = true;

        let out;
        try {
            out = this.demo
                ? await this.api('POST', '/api/chicken/demo-step', { difficulty: this.difficulty })
                : await this.api('POST', '/api/chicken/cross', {});
        } catch (err) {
            this.busy = false;
            await this.recover(err);
            return;
        }

        const lane = this.currentStep + 1;
        const safe = !!out.safe;
        this.world.hopChicken(lane, safe, () => {
            this.busy = false;
            if (!safe) { this.handleCrash(lane); return; }

            this.currentStep = lane;
            this.currentMultiplier = CONFIG.stages[lane - 1].multiplier;
            this.currentPrize = Math.floor(this.currentBet * this.currentMultiplier);
            if (this.onStepSuccess) {
                this.onStepSuccess({ step: lane, multiplier: this.currentMultiplier, prize: this.currentPrize, totalSteps: totalStages });
            }

            if (lane >= totalStages) {
                // الخادم جمعها تلقائياً عند آخر مسار
                if (this.demo) {
                    this.balance += this.currentPrize;
                    this.saveDemoBalance();
                } else {
                    this.balance = Number(out.balance) || this.balance;
                    if (out.win) this.currentPrize = out.win;
                }
                this.finishWin(true);
            } else {
                this.setState(GameState.WAITING_STEP, { isInitial: false });
            }
        });
    }

    handleCrash(laneNumber) {
        this.setState(GameState.CRASHED);
        this.world.triggerCrashAnimation(laneNumber, () => {
            this.addHistoryRecord(false, this.currentBet, this.currentStep, 0);
            this.notifyBalanceUpdate();
            if (this.onCrash) this.onCrash({ step: this.currentStep, lostPrize: this.currentPrize, bet: this.currentBet });
        });
    }

    async cashOut() {
        if (this.state !== GameState.WAITING_STEP || this.currentStep === 0 || this.busy) return;
        this.busy = true;
        if (this.demo) {
            this.balance += this.currentPrize;
            this.saveDemoBalance();
        } else {
            try {
                const out = await this.api('POST', '/api/chicken/cashout', {});
                this.balance = Number(out.balance) || 0;
                this.currentPrize = out.win;
            } catch (err) {
                this.busy = false;
                await this.recover(err);
                return;
            }
        }
        this.busy = false;
        this.finishWin(false);
    }

    finishWin(isGrandWin) {
        this.setState(isGrandWin ? GameState.FINISHED_ALL : GameState.CASHED_OUT);
        const wonPrize = this.currentPrize;
        this.addHistoryRecord(true, this.currentBet, this.currentStep, wonPrize, this.currentMultiplier);
        this.notifyBalanceUpdate();
        this.world.spawnCashOutCelebration(() => {
            if (this.onCashOut) {
                this.onCashOut({ steps: this.currentStep, multiplier: this.currentMultiplier, prize: wonPrize, isGrandWin });
            }
        });
    }

    /**
     * طلب فشل في منتصف الجولة: نعيد قراءة الجولة من الخادم ونكمل منها.
     * (انقطاع الشبكة لا يعني أن الخادم لم ينفّذ الخطوة — الحقيقة عنده.)
     */
    async recover(err) {
        if (err.status === 401) { location.href = '/login?next=/chicken-road'; return; }
        if (this.demo) {
            this.error(err.message);
            this.setState(GameState.WAITING_STEP, { isInitial: this.currentStep === 0 });
            return;
        }
        this.error(err.data && err.data.retry ? 'حاول مرّة أخرى' : err.message);
        try {
            const st = await this.api('GET', '/api/chicken/state');
            this.balance = Number(st.balance) || 0;
            this.notifyBalanceUpdate();
            if (st.round) {
                if (st.round.step !== this.currentStep) this.resume(st.round);
                else this.setState(GameState.WAITING_STEP, { isInitial: this.currentStep === 0 });
            } else {
                // الجولة حُسمت في الخادم (اصطدام أو جمع) ولم يصل الرد
                this.resetForNewRound();
                this.error('انتهت الجولة — تم تحديث رصيدك');
            }
        } catch (e) {
            this.setState(GameState.WAITING_STEP, { isInitial: this.currentStep === 0 });
        }
    }

    resetForNewRound() {
        this.world.resetChicken();
        this.currentStep = 0;
        this.currentMultiplier = 1.0;
        this.currentPrize = 0;
        this.setState(GameState.BETTING);
    }
}
