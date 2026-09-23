'use strict';

/**
 * محرك البلينكو - الواجهة الأمامية والفيزياء
 */

const canvas = document.getElementById('plinkoCanvas');
const ctx = canvas.getContext('2d');

const betInput = document.getElementById('betAmount');
const actionBtn = document.getElementById('mainActionBtn');
const actionBtnText = document.getElementById('actionBtnText');
const walletBalance = document.getElementById('walletBalance');
const lastWinDisplay = document.getElementById('lastWin');
const lastMultDisplay = document.getElementById('lastMultiplier');

const ROWS = 16;
const MULTIPLIERS = [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000];
const PIN_RADIUS = 4;
const BALL_RADIUS = 8;
const BUCKET_HEIGHT = 40;

// Dimensions
let width = canvas.width;
let height = canvas.height;
let rowSpacing = (height - BUCKET_HEIGHT - 60) / ROWS;
let colSpacing = Math.min(rowSpacing * 1.2, width / (ROWS + 2));

// Physics & Animation state
let balls = [];
let lastTime = 0;
let isAnimating = false;

// Audio System (Web Audio API)
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
  if (bgmOsc) return; // Already playing

  bgmOsc = audioCtx.createOscillator();
  bgmGain = audioCtx.createGain();
  
  bgmOsc.type = 'triangle';
  bgmOsc.frequency.setValueAtTime(110, audioCtx.currentTime); // A2
  
  bgmGain.gain.setValueAtTime(0, audioCtx.currentTime);
  bgmGain.gain.linearRampToValueAtTime(0.05, audioCtx.currentTime + 2); // Soft volume
  
  bgmOsc.connect(bgmGain);
  bgmGain.connect(audioCtx.destination);
  
  bgmOsc.start();
  
  // Simple LFO for ambient modulation
  setInterval(() => {
    if (!bgmOsc || isMuted) return;
    const now = audioCtx.currentTime;
    bgmOsc.frequency.linearRampToValueAtTime(115, now + 2);
    bgmOsc.frequency.linearRampToValueAtTime(105, now + 4);
  }, 4000);
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

function playTink() {
  if (isMuted) return;
  initAudio();
  
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800 + Math.random() * 200, audioCtx.currentTime);
  
  gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  osc.start();
  osc.stop(audioCtx.currentTime + 0.1);
}

function playWinSound(multiplier) {
  if (isMuted) return;
  initAudio();
  
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  
  osc.type = 'square';
  const freq = multiplier > 2 ? 600 : (multiplier < 1 ? 200 : 400);
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  if (multiplier > 10) {
    osc.frequency.linearRampToValueAtTime(800, audioCtx.currentTime + 0.2);
    osc.frequency.linearRampToValueAtTime(1200, audioCtx.currentTime + 0.4);
  }
  
  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (multiplier > 10 ? 0.6 : 0.3));
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  osc.start();
  osc.stop(audioCtx.currentTime + (multiplier > 10 ? 0.6 : 0.3));
}

// Page visibility API to stop music when tab is hidden
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopBGM();
  else if (!isMuted) playBGM();
});

// Start BGM on first interaction
document.body.addEventListener('click', () => {
  if (!bgmOsc && !isMuted) playBGM();
}, { once: true });


// ----------------------- UI -----------------------
let state = {
  balance: 0,
  minStake: 100,
  maxStake: 1000000
};

function formatIQD(num) {
  return Math.floor(num).toLocaleString('en-US');
}

function getBucketColor(mult) {
  if (mult >= 1000) return '#e11d48'; // Red
  if (mult >= 130) return '#f43f5e';
  if (mult >= 26) return '#f97316'; // Orange
  if (mult >= 9) return '#f59e0b'; // Amber
  if (mult >= 4) return '#eab308'; // Yellow
  if (mult >= 2) return '#84cc16'; // Lime
  return '#1e293b'; // Dark Grey for low mults
}

async function fetchState() {
  try {
    const res = await fetch('/api/plinko/state');
    if (res.ok) {
      state = await res.json();
      walletBalance.textContent = formatIQD(state.balance);
    } else if (res.status === 401) {
      document.getElementById('demoBanner').style.display = 'block';
    }
  } catch (err) {
    console.error(err);
  }
}

// ----------------------- PHYSICS -----------------------

function drawBoard() {
  ctx.clearRect(0, 0, width, height);
  
  const startY = 40;
  
  // Draw Pins
  ctx.fillStyle = '#38bdf8'; // Neon Cyan
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#0284c7';
  
  for (let r = 0; r < ROWS; r++) {
    const pinsInRow = r + 3;
    const rowWidth = (pinsInRow - 1) * colSpacing;
    const startX = (width - rowWidth) / 2;
    const y = startY + r * rowSpacing;
    
    for (let c = 0; c < pinsInRow; c++) {
      const x = startX + c * colSpacing;
      ctx.beginPath();
      ctx.arc(x, y, PIN_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0; // Reset
  
  // Draw Buckets
  const bucketY = startY + ROWS * rowSpacing;
  const bucketsCount = MULTIPLIERS.length; // 17
  const bucketRowWidth = bucketsCount * colSpacing;
  const bucketStartX = (width - bucketRowWidth) / 2;
  
  for (let i = 0; i < bucketsCount; i++) {
    const x = bucketStartX + i * colSpacing;
    const mult = MULTIPLIERS[i];
    const color = getBucketColor(mult);
    
    // Bucket Box
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(x, bucketY, colSpacing - 4, BUCKET_HEIGHT);
    ctx.globalAlpha = 1.0;
    
    // Text
    ctx.fillStyle = mult < 1 ? '#94a3b8' : '#ffffff';
    ctx.font = 'bold 12px Tajawal';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`×${mult}`, x + (colSpacing - 4) / 2, bucketY + BUCKET_HEIGHT / 2);
  }
}

function updatePhysics(dt) {
  const startY = 40;
  const gravity = 800; // pixels per second squared
  
  for (let i = balls.length - 1; i >= 0; i--) {
    let b = balls[i];
    
    b.vy += gravity * dt;
    b.y += b.vy * dt;
    b.x += b.vx * dt;
    
    // Check collision with rows
    // Calculate which row we are currently crossing
    const currentRow = Math.floor((b.y - startY) / rowSpacing);
    
    if (currentRow >= 0 && currentRow < ROWS && currentRow > b.lastRowHit) {
      // We hit a row!
      b.lastRowHit = currentRow;
      
      // Determine direction from server path
      const dir = b.path[currentRow]; // 1 (right) or -1 (left)
      
      // Apply bounce and horizontal push
      b.vy = b.vy * -0.3; // Bounce up slightly
      if (b.vy > -100) b.vy = -100;
      
      b.vx = dir * (colSpacing * 2.5); // Push sideways
      
      playTink();
    }
    
    // Sink horizontal velocity over time (friction)
    b.vx = b.vx * 0.95;
    
    // Check if reached bottom
    if (b.y > startY + ROWS * rowSpacing + BUCKET_HEIGHT / 2) {
      // Ball finished!
      playWinSound(b.multiplier);
      lastWinDisplay.textContent = formatIQD(b.win) + ' IQD';
      lastWinDisplay.style.color = b.win > b.bet ? '#22c55e' : '#f43f5e';
      lastMultDisplay.textContent = `×${b.multiplier}`;
      lastMultDisplay.style.color = getBucketColor(b.multiplier);
      
      walletBalance.textContent = formatIQD(b.balance);
      
      if (b.win >= b.bet * 10) {
        // Big win popup
        Toastify({
          text: `🎉 فوز ضخم! ربحت ${formatIQD(b.win)} بمضاعف ×${b.multiplier}`,
          duration: 3000,
          gravity: "bottom",
          position: "right",
          style: { background: "linear-gradient(to right, #e11d48, #9f1239)" }
        }).showToast();
      }
      
      balls.splice(i, 1);
    }
  }
}

function drawBalls() {
  ctx.shadowBlur = 15;
  
  for (let b of balls) {
    ctx.shadowColor = b.multiplier >= 10 ? '#e11d48' : '#fbbf24';
    ctx.fillStyle = b.multiplier >= 10 ? '#f43f5e' : '#fbbf24';
    
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    
    // Small inner highlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x - 2, b.y - 2, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function loop(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.1); // cap dt at 100ms
  lastTime = time;
  
  drawBoard();
  
  if (balls.length > 0) {
    updatePhysics(dt);
    drawBalls();
    requestAnimationFrame(loop);
  } else {
    isAnimating = false;
  }
}

function spawnBall(serverData, betAmount) {
  // Center start
  const startX = width / 2;
  const startY = 10;
  
  balls.push({
    x: startX + (Math.random() * 4 - 2), // slight random offset
    y: startY,
    vx: 0,
    vy: 0,
    path: serverData.path,
    multiplier: serverData.multiplier,
    win: serverData.win,
    balance: serverData.balance,
    bet: betAmount,
    lastRowHit: -1
  });
  
  if (!isAnimating) {
    isAnimating = true;
    lastTime = performance.now();
    requestAnimationFrame(loop);
  }
}


// ----------------------- CONTROLS -----------------------

document.querySelectorAll('.mines-btn-quick').forEach(btn => {
  btn.addEventListener('click', (e) => {
    let current = parseInt(betInput.value) || 0;
    const action = e.target.dataset.action;
    if (action === 'half') current = Math.floor(current / 2);
    if (action === 'double') current = current * 2;
    if (action === 'max') current = state.maxStake;
    if (current < state.minStake) current = state.minStake;
    if (current > state.maxStake) current = state.maxStake;
    betInput.value = current;
  });
});

actionBtn.addEventListener('click', async () => {
  const bet = parseInt(betInput.value);
  if (isNaN(bet) || bet < state.minStake) {
    Toastify({text: "مبلغ الرهان غير صالح", duration: 3000, style: {background:"#e11d48"}}).showToast();
    return;
  }
  
  actionBtn.disabled = true;
  actionBtnText.textContent = "جاري الإسقاط...";
  
  try {
    // Generate a random client seed
    const clientSeed = Math.random().toString(36).substring(2, 15);
    
    const res = await fetch('/api/plinko/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bet, clientSeed })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      if (res.status === 401) window.location.href = '/login?next=/plinko';
      else Toastify({text: data.error || 'حدث خطأ', duration: 3000, style: {background:"#e11d48"}}).showToast();
    } else {
      // Deduct visually immediately
      walletBalance.textContent = formatIQD(state.balance - bet);
      state.balance = data.balance; // Will be shown when ball lands
      
      // Update Provably Fair fields
      document.getElementById('pfServerHash').value = data.seedHash;
      document.getElementById('pfServerSeed').value = data.serverSeed; // Revealed instantly for Plinko!
      
      spawnBall(data, bet);
    }
  } catch (err) {
    console.error(err);
    Toastify({text: "خطأ في الاتصال بالخادم", duration: 3000, style: {background:"#e11d48"}}).showToast();
  } finally {
    actionBtn.disabled = false;
    actionBtnText.textContent = "أسقط الكرة الآن";
  }
});

// Modals
const pfBtn = document.getElementById('pfBtn');
const pfModal = document.getElementById('pfModal');
const pfClose = document.getElementById('pfClose');

if (pfBtn) pfBtn.addEventListener('click', () => pfModal.hidden = false);
if (pfClose) pfClose.addEventListener('click', () => pfModal.hidden = true);
pfModal.addEventListener('click', (e) => {
  if (e.target === pfModal) pfModal.hidden = true;
});

// Init
drawBoard(); // Draw initial static board
fetchState();
