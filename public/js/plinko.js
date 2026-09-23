'use strict';

/**
 * LuckyArena — محرك لعبة بلينكو عالي التذبذب (16 صفاً • 96.28% RTP)
 * مصفوفة العوائد الدقيقة:
 * [150, 100, 50, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10, 50, 100, 150]
 */

const canvas = document.getElementById('plinkoCanvas');
const ctx = canvas.getContext('2d');

// إعداد دقة الكانفاس لتكون فائقة الوضوح (Retina 2x Scaling)
const VIRTUAL_WIDTH = 800;
const VIRTUAL_HEIGHT = 640;
canvas.width = VIRTUAL_WIDTH * 2;
canvas.height = VIRTUAL_HEIGHT * 2;
ctx.scale(2, 2);

const betInput = document.getElementById('betAmount');
const actionBtn = document.getElementById('mainActionBtn');
const actionBtnText = document.getElementById('actionBtnText');
const walletBalance = document.getElementById('walletBalance');
const walletCurrency = document.getElementById('walletCurrency');
const lastWinDisplay = document.getElementById('lastWin');
const lastMultDisplay = document.getElementById('lastMultiplier');
const activeBallsDisplay = document.getElementById('activeBallsCount');
const historyBar = document.getElementById('historyBar');

const ROWS = 16;
// مصفوفة المضاعفات الـ 17 المعتمدة رياضياً (4 فئات ربح + 7 أوعية منطقة ميتة 0x)
const MULTIPLIERS = [150, 100, 50, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10, 50, 100, 150];
const PIN_RADIUS = 3.8;
const BALL_RADIUS = 7.5;
const BUCKET_HEIGHT = 36;
const BUCKET_MARGIN = 3;

// الأبعاد وتوزيع المسافات
const startY = 55;
const rowSpacing = (VIRTUAL_HEIGHT - BUCKET_HEIGHT - startY - 30) / ROWS;
const colSpacing = Math.min(rowSpacing * 1.15, VIRTUAL_WIDTH / (ROWS + 2.8));

// حالات الحركة والفيزياء
let balls = [];
let particles = [];
let pinHits = []; // { x, y, startTime }
let bucketHits = new Array(MULTIPLIERS.length).fill(0); // timestamp of hit
let lastTime = 0;
let isAnimating = false;
let isDropping = false;

// ----------------------- نظام الصوت (Web Audio API) -----------------------
let audioCtx = null;
let bgmOsc = null;
let bgmGain = null;
let isMuted = localStorage.getItem('ichance_muted') === 'true';

const soundBtn = document.getElementById('soundBtn');
if (soundBtn) {
  soundBtn.textContent = isMuted ? '🔇' : '🔊';
  soundBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    localStorage.setItem('ichance_muted', isMuted);
    soundBtn.textContent = isMuted ? '🔇' : '🔊';
    if (isMuted) stopBGM();
    else playBGM();
  });
}

function initAudio() {
  if (audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();
}

function playBGM() {
  if (isMuted) return;
  initAudio();
  if (bgmOsc) return;

  try {
    bgmOsc = audioCtx.createOscillator();
    bgmGain = audioCtx.createGain();
    
    bgmOsc.type = 'triangle';
    bgmOsc.frequency.setValueAtTime(110, audioCtx.currentTime);
    
    bgmGain.gain.setValueAtTime(0, audioCtx.currentTime);
    bgmGain.gain.linearRampToValueAtTime(0.04, audioCtx.currentTime + 2);
    
    bgmOsc.connect(bgmGain);
    bgmGain.connect(audioCtx.destination);
    
    bgmOsc.start();
    
    setInterval(() => {
      if (!bgmOsc || isMuted) return;
      const now = audioCtx.currentTime;
      bgmOsc.frequency.linearRampToValueAtTime(115, now + 2);
      bgmOsc.frequency.linearRampToValueAtTime(105, now + 4);
    }, 4000);
  } catch (e) {
    console.warn('Audio BGM failed to start', e);
  }
}

function stopBGM() {
  if (bgmGain) {
    bgmGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.5);
    setTimeout(() => {
      if (bgmOsc) {
        bgmOsc.stop();
        bgmOsc.disconnect();
        bgmOsc = null;
      }
    }, 500);
  }
}

function playTink(row = 0) {
  if (isMuted) return;
  initAudio();
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    const baseFreq = 750 + (row * 35) + (Math.random() * 40 - 20);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, audioCtx.currentTime);
    
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.08);
  } catch (e) {}
}

function playWinSound(multiplier) {
  if (isMuted) return;
  initAudio();
  try {
    const now = audioCtx.currentTime;
    
    if (multiplier >= 50) {
      // نغمة فوز ضخم ثلاثية الأوتار (Fanfare Chord)
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.07);
        gain.gain.setValueAtTime(0.14, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + 0.65);
      });
    } else if (multiplier >= 10) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.2);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else {
      // نغمة خفيفة للمنطقة الميتة (0x)
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch (e) {}
}

document.body.addEventListener('click', () => {
  if (!bgmOsc && !isMuted) playBGM();
}, { once: true });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopBGM();
  else if (!isMuted) playBGM();
});

// ----------------------- الألوان والتنسيقات -----------------------
let state = {
  balance: 0,
  currency: 'IQD',
  minStake: 100,
  maxStake: 1000000
};

function formatIQD(num) {
  return Math.floor(num).toLocaleString('en-US');
}

/**
 * ألوان الأوعية لتمييز فئات الربح الأربعة بدقة عن المنطقة الميتة (0x)
 */
function getBucketColors(mult) {
  if (mult >= 150) return { bg: '#ff0055', glow: 'rgba(255, 0, 85, 0.85)', text: '#ffffff', border: '#ff3377' };
  if (mult >= 100) return { bg: '#ff2a6d', glow: 'rgba(255, 42, 109, 0.75)', text: '#ffffff', border: '#ff5c8d' };
  if (mult >= 50)  return { bg: '#ff6200', glow: 'rgba(255, 98, 0, 0.70)', text: '#ffffff', border: '#ff8533' };
  if (mult >= 10)  return { bg: '#ffd000', glow: 'rgba(255, 208, 0, 0.60)', text: '#0b0e14', border: '#ffdc33' };
  // المنطقة الميتة (0x) — لون داكن أنيق منسجم مع الهوية
  return { bg: '#141d27', glow: 'rgba(0, 0, 0, 0.3)', text: '#56697d', border: '#1f2b38' };
}

function addHistoryBadge(mult) {
  if (!historyBar) return;
  const badge = document.createElement('div');
  badge.className = 'plinko-badge';
  
  if (mult >= 100) badge.classList.add('plinko-badge--extreme');
  else if (mult >= 50) badge.classList.add('plinko-badge--high');
  else if (mult >= 10) badge.classList.add('plinko-badge--medium');
  else badge.classList.add('plinko-badge--loss');
  
  badge.textContent = `×${mult}`;
  
  historyBar.insertBefore(badge, historyBar.firstChild);
  if (historyBar.children.length > 7) {
    historyBar.removeChild(historyBar.lastChild);
  }
}

// ----------------------- رمز المصادقة وحالة اللاعب -----------------------
let token = localStorage.getItem('ichance.token') || localStorage.getItem('ichance_token') || '';
let isDemoMode = !token;

async function syncWallet() {
  const banner = document.getElementById('demoBanner');
  token = localStorage.getItem('ichance.token') || localStorage.getItem('ichance_token') || '';

  if (!token) {
    isDemoMode = true;
    if (banner) banner.style.display = 'block';
    state.balance = parseInt(localStorage.getItem('ichance_demo_balance'), 10) || 100000;
    walletBalance.textContent = formatIQD(state.balance);
    if (walletCurrency) walletCurrency.textContent = 'DEMO';
    return;
  }

  try {
    const res = await fetch('/api/plinko/state', {
      headers: {
        'x-player-token': token
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.loggedIn === false) {
        // الرمز غير صالح أو لاعب مجهول
        isDemoMode = true;
        if (banner) banner.style.display = 'block';
        state.balance = parseInt(localStorage.getItem('ichance_demo_balance'), 10) || 100000;
        walletBalance.textContent = formatIQD(state.balance);
        if (walletCurrency) walletCurrency.textContent = 'DEMO';
      } else {
        // لاعب مسجل برصيد حقيقي
        isDemoMode = false;
        state.balance = Number(data.balance) || 0;
        state.currency = data.currency || 'IQD';
        walletBalance.textContent = formatIQD(state.balance);
        if (walletCurrency) walletCurrency.textContent = state.currency;
        if (banner) banner.style.display = 'none';
      }
    } else if (res.status === 401) {
      isDemoMode = true;
      if (banner) banner.style.display = 'block';
      state.balance = parseInt(localStorage.getItem('ichance_demo_balance'), 10) || 100000;
      walletBalance.textContent = formatIQD(state.balance);
      if (walletCurrency) walletCurrency.textContent = 'DEMO';
    }
  } catch (err) {
    console.warn('[Plinko] Wallet sync error:', err.message);
  }
}

// ----------------------- فيزياء ورسم اللوحة -----------------------

function drawBoard() {
  ctx.clearRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  const now = performance.now();

  // 1. هالة إضاءة خلفية الهرم (Ambient Pyramid Glow)
  const ambientGrad = ctx.createRadialGradient(
    VIRTUAL_WIDTH / 2, startY + 60, 20,
    VIRTUAL_WIDTH / 2, startY + 260, 360
  );
  ambientGrad.addColorStop(0, 'rgba(28, 48, 74, 0.45)');
  ambientGrad.addColorStop(0.6, 'rgba(16, 26, 40, 0.2)');
  ambientGrad.addColorStop(1, 'rgba(10, 16, 24, 0)');
  ctx.fillStyle = ambientGrad;
  ctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

  // 2. رسم المسامير (Pins) مع تأثيرات 3D ولمعان معدني
  for (let r = 0; r < ROWS; r++) {
    const pinsInRow = r + 3;
    const rowWidth = (pinsInRow - 1) * colSpacing;
    const startX = (VIRTUAL_WIDTH - rowWidth) / 2;
    const y = startY + r * rowSpacing;

    for (let c = 0; c < pinsInRow; c++) {
      const x = startX + c * colSpacing;

      let hitPulse = 0;
      for (let i = pinHits.length - 1; i >= 0; i--) {
        const h = pinHits[i];
        if (Math.hypot(h.x - x, h.y - y) < 8) {
          const elapsed = now - h.startTime;
          if (elapsed < 240) {
            hitPulse = 1 - (elapsed / 240);
          } else {
            pinHits.splice(i, 1);
          }
        }
      }

      if (hitPulse > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, PIN_RADIUS + hitPulse * 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 197, 66, ${hitPulse * 0.9})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = '#f5c542';
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.restore();
      }

      ctx.beginPath();
      ctx.arc(x, y + 1.5, PIN_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fill();

      const pinGrad = ctx.createRadialGradient(
        x - 1, y - 1, 0.5,
        x, y, PIN_RADIUS
      );
      if (hitPulse > 0) {
        pinGrad.addColorStop(0, '#ffffff');
        pinGrad.addColorStop(0.5, '#ffd24d');
        pinGrad.addColorStop(1, '#ff9900');
      } else {
        pinGrad.addColorStop(0, '#ffffff');
        pinGrad.addColorStop(0.4, '#e2ecf5');
        pinGrad.addColorStop(0.85, '#8da2b5');
        pinGrad.addColorStop(1, '#4e6275');
      }

      ctx.beginPath();
      ctx.arc(x, y, PIN_RADIUS + (hitPulse * 1.5), 0, Math.PI * 2);
      ctx.fillStyle = pinGrad;
      ctx.fill();
    }
  }

  // 3. رسم أوعية المضاعفات في الأسفل (Multiplier Buckets)
  const bucketY = startY + ROWS * rowSpacing;
  const bucketsCount = MULTIPLIERS.length;
  const bucketRowWidth = bucketsCount * colSpacing;
  const bucketStartX = (VIRTUAL_WIDTH - bucketRowWidth) / 2;

  for (let i = 0; i < bucketsCount; i++) {
    const x = bucketStartX + i * colSpacing;
    const mult = MULTIPLIERS[i];
    const styles = getBucketColors(mult);
    const boxW = colSpacing - BUCKET_MARGIN * 2;

    let bounceY = 0;
    let isHit = false;
    const hitElapsed = now - bucketHits[i];
    if (hitElapsed < 320) {
      isHit = true;
      const progress = hitElapsed / 320;
      bounceY = Math.sin(progress * Math.PI) * 5;
    }

    const currentY = bucketY + bounceY;

    if (isHit || mult >= 10) {
      ctx.save();
      ctx.shadowColor = styles.glow;
      ctx.shadowBlur = isHit ? 22 : 8;
    }

    // بطاقة الوعاء بزوايا علوية مستديرة
    ctx.beginPath();
    const r = 6;
    ctx.moveTo(x + BUCKET_MARGIN + r, currentY);
    ctx.lineTo(x + BUCKET_MARGIN + boxW - r, currentY);
    ctx.quadraticCurveTo(x + BUCKET_MARGIN + boxW, currentY, x + BUCKET_MARGIN + boxW, currentY + r);
    ctx.lineTo(x + BUCKET_MARGIN + boxW, currentY + BUCKET_HEIGHT);
    ctx.lineTo(x + BUCKET_MARGIN, currentY + BUCKET_HEIGHT);
    ctx.lineTo(x + BUCKET_MARGIN, currentY + r);
    ctx.quadraticCurveTo(x + BUCKET_MARGIN, currentY, x + BUCKET_MARGIN + r, currentY);
    ctx.closePath();

    const boxGrad = ctx.createLinearGradient(0, currentY, 0, currentY + BUCKET_HEIGHT);
    boxGrad.addColorStop(0, styles.bg);
    boxGrad.addColorStop(1, '#0b111a');
    ctx.fillStyle = boxGrad;
    ctx.fill();

    ctx.strokeStyle = isHit ? '#ffffff' : styles.border;
    ctx.lineWidth = isHit ? 2 : 1;
    ctx.stroke();

    if (isHit || mult >= 10) {
      ctx.restore();
    }

    // نص المضاعف (×150, ×100, ×50, ×10, 0x)
    ctx.fillStyle = styles.text;
    ctx.font = mult >= 100 ? '900 10px Tajawal' : '800 11.5px Tajawal';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${mult}x`, x + BUCKET_MARGIN + boxW / 2, currentY + BUCKET_HEIGHT / 2 - 1);
  }
}

function updatePhysics(dt) {
  const gravity = 860;
  const now = performance.now();

  for (let i = balls.length - 1; i >= 0; i--) {
    let b = balls[i];

    b.vy += gravity * dt;
    b.y += b.vy * dt;
    b.x += b.vx * dt;

    b.trail.unshift({ x: b.x, y: b.y, alpha: 1 });
    if (b.trail.length > 5) b.trail.pop();

    const currentRow = Math.floor((b.y - startY) / rowSpacing);

    if (currentRow >= 0 && currentRow < ROWS && currentRow > b.lastRowHit) {
      b.lastRowHit = currentRow;

      const dir = b.path[currentRow];

      b.vy = b.vy * -0.28;
      if (b.vy > -110) b.vy = -110;

      b.vx = dir * (colSpacing * 2.3) + (Math.random() * 20 - 10);

      pinHits.push({ x: b.x, y: b.y, startTime: now });

      for (let p = 0; p < 4; p++) {
        particles.push({
          x: b.x,
          y: b.y,
          vx: (Math.random() - 0.5) * 120,
          vy: (Math.random() - 0.5) * 100 - 30,
          color: '#f5c542',
          alpha: 1,
          size: Math.random() * 2.5 + 1
        });
      }

      playTink(currentRow);
    }

    b.vx = b.vx * 0.96;

    const bucketY = startY + ROWS * rowSpacing;
    if (b.y >= bucketY + 12) {
      bucketHits[b.bucketIndex] = now;
      playWinSound(b.multiplier);

      addHistoryBadge(b.multiplier);

      // تحديث الأرباح في الواجهة
      if (b.multiplier === 0) {
        lastWinDisplay.textContent = '0 IQD';
        lastWinDisplay.style.color = '#ff3344';
        lastMultDisplay.textContent = '×0';
        lastMultDisplay.style.color = '#64748b';
      } else {
        lastWinDisplay.textContent = formatIQD(b.win) + ' ' + (state.currency || 'IQD');
        lastWinDisplay.style.color = '#00e701';
        lastMultDisplay.textContent = `×${b.multiplier}`;
        const multStyle = getBucketColors(b.multiplier);
        lastMultDisplay.style.color = multStyle.bg;
      }

      // تحديث رصيد المحفظة
      walletBalance.textContent = formatIQD(b.balance);

      // شرارات احتفالية إذا كان المضاعف رابحاً
      if (b.multiplier >= 10) {
        const multStyle = getBucketColors(b.multiplier);
        for (let p = 0; p < 24; p++) {
          particles.push({
            x: b.x,
            y: bucketY,
            vx: (Math.random() - 0.5) * 220,
            vy: -Math.random() * 180 - 60,
            color: multStyle.bg,
            alpha: 1,
            size: Math.random() * 3 + 1.5
          });
        }
      }

      // إشعار التوست للفوز الضخم
      if (b.multiplier >= 50 && typeof Toastify === 'function') {
        Toastify({
          text: `🎉 فوز استثنائي! ربحت ${formatIQD(b.win)} بمضاعف ×${b.multiplier}!`,
          duration: 4000,
          gravity: "top",
          position: "center",
          style: {
            background: "linear-gradient(135deg, #e11d48, #9f1239)",
            borderRadius: "12px",
            fontWeight: "800",
            boxShadow: "0 10px 30px rgba(225, 29, 72, 0.5)"
          }
        }).showToast();
      }

      balls.splice(i, 1);
    }
  }

  for (let j = particles.length - 1; j >= 0; j--) {
    let p = particles[j];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 300 * dt;
    p.alpha -= dt * 2.2;
    if (p.alpha <= 0) particles.splice(j, 1);
  }

  if (activeBallsDisplay) {
    activeBallsDisplay.textContent = balls.length;
  }
}

function drawBallsAndEffects() {
  for (let p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.alpha);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (let b of balls) {
    for (let t = 0; t < b.trail.length; t++) {
      const tr = b.trail[t];
      const trailAlpha = (1 - (t / b.trail.length)) * 0.45;
      const trailRadius = BALL_RADIUS * (1 - (t / (b.trail.length * 1.6)));

      ctx.beginPath();
      ctx.arc(tr.x, tr.y, Math.max(1, trailRadius), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 36, 83, ${trailAlpha})`;
      ctx.fill();
    }

    ctx.save();
    ctx.shadowColor = 'rgba(255, 23, 68, 0.85)';
    ctx.shadowBlur = 18;

    const ballGrad = ctx.createRadialGradient(
      b.x - 2, b.y - 2, 0.5,
      b.x, b.y, BALL_RADIUS
    );
    ballGrad.addColorStop(0, '#ffffff');
    ballGrad.addColorStop(0.35, '#ff4d79');
    ballGrad.addColorStop(0.8, '#ff1744');
    ballGrad.addColorStop(1, '#b70028');

    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = ballGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(b.x - 2, b.y - 2.5, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();

    ctx.restore();
  }
}

function loop(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.08);
  lastTime = time;

  drawBoard();

  if (balls.length > 0 || particles.length > 0 || pinHits.length > 0) {
    updatePhysics(dt);
    drawBallsAndEffects();
    requestAnimationFrame(loop);
  } else {
    isAnimating = false;
    if (activeBallsDisplay) activeBallsDisplay.textContent = '0';
  }
}

function startLoopIfNeeded() {
  if (!isAnimating) {
    isAnimating = true;
    lastTime = performance.now();
    requestAnimationFrame(loop);
  }
}

function spawnBall(serverData, betAmount) {
  const startX = VIRTUAL_WIDTH / 2;
  const dropY = startY - 25;

  balls.push({
    x: startX + (Math.random() * 6 - 3),
    y: dropY,
    vx: (Math.random() - 0.5) * 20,
    vy: 10,
    path: serverData.path || serverData.trajectory,
    bucketIndex: serverData.index,
    multiplier: serverData.multiplier,
    win: serverData.win,
    balance: serverData.balance,
    bet: betAmount,
    lastRowHit: -1,
    trail: []
  });

  startLoopIfNeeded();
}

// ----------------------- أزرار التحكم والرهان السريع -----------------------

document.querySelectorAll('.mines-btn-quick').forEach(btn => {
  btn.addEventListener('click', (e) => {
    let current = parseInt(betInput.value) || 0;
    const action = e.target.dataset.action;
    if (action === 'half') current = Math.floor(current / 2);
    if (action === 'double') current = current * 2;
    if (action === 'max') current = state.maxStake || 1000000;
    if (current < (state.minStake || 100)) current = state.minStake || 100;
    if (current > (state.maxStake || 1000000)) current = state.maxStake || 1000000;
    betInput.value = current;
  });
});

document.querySelectorAll('.plinko-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const val = parseInt(chip.dataset.chip);
    if (val) {
      betInput.value = val;
    }
  });
});

// إسقاط الكرة
actionBtn.addEventListener('click', async () => {
  if (isDropping) return;
  const bet = parseInt(betInput.value, 10);

  if (isNaN(bet) || bet < (state.minStake || 100)) {
    if (typeof Toastify === 'function') {
      Toastify({ text: "مبلغ الرهان غير صالح (الحد الأدنى 100 IQD)", duration: 2500, style: { background: "#e11d48" } }).showToast();
    }
    return;
  }

  isDropping = true;
  setTimeout(() => { isDropping = false; }, 200);

  // 1. في الوضع التجريبي (Demo Mode)
  if (isDemoMode) {
    if (state.balance < bet) {
      state.balance = 50000; // إعادة شحن رصيد الديمو تلقائياً
      Toastify({ text: "تمت إعادة شحن رصيد التجربة 50,000 DEMO تلقائياً", duration: 2000, style: { background: "#3b82f6" } }).showToast();
    }
    state.balance -= bet;
    walletBalance.textContent = formatIQD(state.balance);
    localStorage.setItem('ichance_demo_balance', state.balance);

    // تطبيق النموذج الرياضي التوافقي الدقيق في المتصفح
    const path = [];
    let index = 0;
    for (let r = 0; r < ROWS; r++) {
      const step = Math.random() < 0.5 ? -1 : 1;
      path.push(step);
      if (step === 1) index++;
    }
    const multiplier = MULTIPLIERS[index];
    const win = Math.round(bet * multiplier);
    state.balance += win;

    const demoData = {
      path,
      index,
      multiplier,
      win,
      balance: state.balance,
      seedHash: 'demo-' + Math.random().toString(16).substring(2, 10),
      serverSeed: 'demo-seed-' + Math.random().toString(16).substring(2, 10)
    };

    const pfHash = document.getElementById('pfServerHash');
    const pfSeed = document.getElementById('pfServerSeed');
    if (pfHash) pfHash.value = demoData.seedHash;
    if (pfSeed) pfSeed.value = demoData.serverSeed;

    spawnBall(demoData, bet);
    return;
  }

  // 2. في وضع الرصيد الحقيقي (Real Money)
  if (bet > state.balance) {
    if (typeof Toastify === 'function') {
      Toastify({
        text: `رصيدك لا يكفي لإتمام هذا الرهان. رصيدك الحالي: ${formatIQD(state.balance)} ${state.currency || 'IQD'}. اضغط على "شحن" للإيداع.`,
        duration: 3500,
        style: { background: "#e11d48" }
      }).showToast();
    }
    return;
  }

  try {
    const clientSeed = Math.random().toString(36).substring(2, 15);

    const res = await fetch('/api/plinko/drop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-player-token': token
      },
      body: JSON.stringify({ bet, clientSeed })
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login?next=/plinko';
      } else if (typeof Toastify === 'function') {
        Toastify({ text: data.error || 'حدث خطأ في الرهان', duration: 3500, style: { background: "#e11d48" } }).showToast();
      }
    } else {
      const currentVisual = parseInt(walletBalance.textContent.replace(/,/g, '')) || 0;
      walletBalance.textContent = formatIQD(Math.max(0, currentVisual - bet));
      state.balance = data.balance;

      const pfHash = document.getElementById('pfServerHash');
      const pfSeed = document.getElementById('pfServerSeed');
      if (pfHash) pfHash.value = data.seedHash;
      if (pfSeed) pfSeed.value = data.serverSeed;

      spawnBall(data, bet);
    }
  } catch (err) {
    console.error('Plinko drop request failed:', err);
    if (typeof Toastify === 'function') {
      Toastify({ text: "خطأ في الاتصال بالخادم", duration: 3000, style: { background: "#e11d48" } }).showToast();
    }
  }
});

// النوافذ المنبثقة
const pfBtn = document.getElementById('pfBtn');
const pfModal = document.getElementById('pfModal');
const pfClose = document.getElementById('pfClose');

if (pfBtn) pfBtn.addEventListener('click', () => pfModal.hidden = false);
if (pfClose) pfClose.addEventListener('click', () => pfModal.hidden = true);
if (pfModal) {
  pfModal.addEventListener('click', (e) => {
    if (e.target === pfModal) pfModal.hidden = true;
  });
}

// البدء الأولي
drawBoard();
syncWallet();
setInterval(syncWallet, 8000);
