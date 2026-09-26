/**
 * CHICKEN ROAD - Procedural Audio Engine (Web Audio API)
 * محرك الصوتيات الإجرائي بدون أي ملفات خارجية
 */

class SoundEngine {
    constructor() {
        this.ctx = null;
        this.isMuted = false;
        this.masterVolume = 0.45;
        this.isInitialized = false;

        // استرجاع تفضيل كتم الصوت من التخزين المحلي
        try {
            const savedMute = localStorage.getItem('chicken_road_muted');
            if (savedMute !== null) {
                this.isMuted = savedMute === 'true';
            }
        } catch (e) {
            console.warn('LocalStorage not accessible for sound settings');
        }
    }

    init() {
        if (this.isInitialized && this.ctx) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            this.isInitialized = true;
        } catch (e) {
            console.error('Web Audio API not supported', e);
        }
    }

    resume() {
        if (!this.ctx) this.init();
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        try {
            localStorage.setItem('chicken_road_muted', this.isMuted);
        } catch (e) {}
        return this.isMuted;
    }

    // 1. صوت قفزة الدجاجة الكرتونية (Cartoon Hop / Boing)
    playHop() {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        // انزلاق تردد سريع للأعلى يعطي طابع القفزة
        osc.frequency.setValueAtTime(260, now);
        osc.frequency.exponentialRampToValueAtTime(620, now + 0.12);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.22);

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.35 * this.masterVolume, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.25);
    }

    // 2. صوت الأمان وتحديث المضاعف (Safe / Ding)
    playSafe(stepIndex = 1) {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        const now = this.ctx.currentTime;
        
        // نغمة مبهجة ثنائية تصاعدية حسب رقم الخطوة
        const baseFreq = 440 * Math.pow(1.05, Math.min(stepIndex, 12));
        const notes = [baseFreq, baseFreq * 1.25, baseFreq * 1.5];

        notes.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const noteStart = now + i * 0.06;

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, noteStart);

            gain.gain.setValueAtTime(0, noteStart);
            gain.gain.linearRampToValueAtTime(0.28 * this.masterVolume, noteStart + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.35);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(noteStart);
            osc.stop(noteStart + 0.38);
        });
    }

    // 3. صوت فرامل حاد (Brake Screech)
    playBrake() {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        const now = this.ctx.currentTime;
        const bufferSize = this.ctx.sampleRate * 0.35;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(2800, now);
        filter.frequency.exponentialRampToValueAtTime(1400, now + 0.3);
        filter.Q.setValueAtTime(8, now);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.4 * this.masterVolume, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);

        noise.start(now);
        noise.stop(now + 0.35);
    }

    // 4. صوت بوق السيارة (Car Honk)
    playHonk() {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        const now = this.ctx.currentTime;
        const freqs = [380, 475]; // بوق سيارة ثنائي التردد

        freqs.forEach(f => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(f, now);

            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.18 * this.masterVolume, now + 0.03);
            gain.gain.setValueAtTime(0.18 * this.masterVolume, now + 0.18);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + 0.26);
        });
    }

    // 5. صوت الاصطدام الكرتوني الخفيف الممتع (Cartoon Crash / Thud / Feathers)
    playCrash() {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        this.playBrake();
        this.playHonk();

        const now = this.ctx.currentTime + 0.08;

        // ارتطام جهوري كرتوني ناعم
        const thudOsc = this.ctx.createOscillator();
        const thudGain = this.ctx.createGain();

        thudOsc.type = 'sine';
        thudOsc.frequency.setValueAtTime(180, now);
        thudOsc.frequency.exponentialRampToValueAtTime(45, now + 0.25);

        thudGain.gain.setValueAtTime(0.5 * this.masterVolume, now);
        thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

        thudOsc.connect(thudGain);
        thudGain.connect(this.ctx.destination);

        thudOsc.start(now);
        thudOsc.stop(now + 0.32);

        // صوت صفير طريف متطاير للنجوم (Cartoon chirp)
        const chirpOsc = this.ctx.createOscillator();
        const chirpGain = this.ctx.createGain();
        chirpOsc.type = 'triangle';
        chirpOsc.frequency.setValueAtTime(700, now + 0.15);
        chirpOsc.frequency.exponentialRampToValueAtTime(250, now + 0.45);

        chirpGain.gain.setValueAtTime(0.2 * this.masterVolume, now + 0.15);
        chirpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

        chirpOsc.connect(chirpGain);
        chirpGain.connect(this.ctx.destination);

        chirpOsc.start(now + 0.15);
        chirpOsc.stop(now + 0.52);
    }

    // 6. صوت جمع الجائزة الاحتفالي (Cash Out Fanfare)
    playCashOut() {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        const now = this.ctx.currentTime;
        // أربيجيو نغمات نصر سريعة ومبهجة
        const chordNotes = [523.25, 659.25, 783.99, 1046.50, 1318.51]; // C major fanfare

        chordNotes.forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const noteTime = now + idx * 0.08;

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, noteTime);

            gain.gain.setValueAtTime(0, noteTime);
            gain.gain.linearRampToValueAtTime(0.3 * this.masterVolume, noteTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.55);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(noteTime);
            osc.stop(noteTime + 0.6);
        });
    }

    // 7. صوت نقرة زر عادي
    playClick() {
        if (this.isMuted) return;
        this.resume();
        if (!this.ctx) return;

        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.05);

        gain.gain.setValueAtTime(0.12 * this.masterVolume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.06);
    }
}

// تصدير كائن الصوت الموحد
const audio = new SoundEngine();
