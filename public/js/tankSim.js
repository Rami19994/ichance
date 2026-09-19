/* ==========================================================================
   iCHANCE — محرك معركة الدبابات (محاكاة حتمية)
   --------------------------------------------------------------------------
   هذا الملف يعمل في المتصفح وفي الخادم **بنفس النسخة حرفياً** (لا نسختين
   متطابقتين كما في rng/fair، بل الملف ذاته يُحمَّل في الطرفين). السبب أن
   الخادم يعيد تشغيل المعركة من البذرة نفسها ومن ضغطات اللاعب نفسها ليحسب
   النتيجة بنفسه؛ أي اختلاف بفاصلة واحدة بين النسختين يجعل كل جولة تُرفض.

   قواعد الحتمية — انتهاكها يكسر اللعبة كلها:
     · أعداد صحيحة فقط. لا Math.random ولا كسور عشرية ولا Date.now.
     · كل عشوائية من xorshift32 المبذور من بذرة الخادم.
     · ترتيب الخطوات داخل الـ tick ثابت لا يتغيّر.

   الإحداثيات بوحدات صحيحة: البلاطة = 512 وحدة.
   ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TankSim = api;
}(typeof self !== 'undefined' ? self : this, function () {

  // --------------------------------------------------------------- الأبعاد
  const TILE = 512;
  const COLS = 20;
  const ROWS = 15;
  const W = COLS * TILE;
  const H = ROWS * TILE;

  const TANK = 384;              // ضلع الدبابة (أصغر من البلاطة كي تمرّ في الممرات)
  const HALF = TANK >> 1;
  const BULLET = 72;
  const BHALF = BULLET >> 1;

  const TICK_HZ = 30;            // نبضة المحاكاة — ثابتة، لا تتبع معدّل الرسم

  const PLAYER_SPEED = 52;
  const PLAYER_BULLET_SPEED = 150;
  const PLAYER_COOL = 7;         // نبضات بين طلقة وأخرى
  const PLAYER_MAX_SHOTS = 2;    // طلقتان في الجو كحدّ أقصى (قاعدة كلاسيكية)

  const SPAWN_EVERY = 30;        // نبضات بين ظهور عدوّ وآخر

  /**
   * بعد كل إصابة تمرّ نبضات لا يتأذّى فيها اللاعب.
   * بدونها تأكل الطلقةُ الواحدة أو الالتحامُ كلَّ الدروع في جزء من ثانية،
   * فيصير الدرع رقماً بلا معنى.
   */
  const HURT_TICKS = 36;

  // الاتجاهات: 0=أعلى 1=يمين 2=أسفل 3=يسار
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  // مفاتيح الإدخال (bitmask)
  const IN_UP = 1, IN_RIGHT = 2, IN_DOWN = 4, IN_LEFT = 8, IN_FIRE = 16;

  // ------------------------------------------------------------- الصعوبات
  /**
   * `payout` بالمئة (170 = ×1.70) كي تبقى الأرقام صحيحة في مسار المحاكاة.
   *
   * `measured` نسبة نجاة **مقيسة** ببوت قوي على 3000 معركة لكل صعوبة، وليست
   * تقديراً. المضاعف مشتقّ منها: payout = 0.80 / measured. لذلك الأرقام غير
   * مدوّرة — التدوير «الجميل» يزيح العائد عن 80%.
   *
   * ⚠ أي تعديل على أرقام الصعوبة يوجب إعادة القياس (tune_tank) وتحديث
   * `measured` و`payout` معاً، وإلا انفلت العائد بلا أن يظهر ذلك في أي اختبار.
   * `measured` لا تدخل حساب المحاكاة إطلاقاً — هي للعرض والفحص الذاتي فقط،
   * فوجود كسر عشري فيها لا يمسّ الحتمية.
   */
  const DIFFICULTY = {
    easy: {
      key: 'easy', name: 'سهل', order: 1, armor: 4,
      enemies: 5, maxAlive: 2, speed: 18, fireEvery: 66, bulletSpeed: 106,
      aggression: 45, timeLimit: 70 * TICK_HZ, payout: 112, measured: 0.714
    },
    normal: {
      key: 'normal', name: 'متوسط', order: 2, armor: 3,
      enemies: 6, maxAlive: 3, speed: 23, fireEvery: 58, bulletSpeed: 116,
      aggression: 54, timeLimit: 70 * TICK_HZ, payout: 170, measured: 0.470
    },
    hard: {
      key: 'hard', name: 'صعب', order: 3, armor: 4,
      enemies: 8, maxAlive: 3, speed: 26, fireEvery: 52, bulletSpeed: 126,
      aggression: 60, timeLimit: 75 * TICK_HZ, payout: 250, measured: 0.317
    },
    inferno: {
      key: 'inferno', name: 'جهنم', order: 4, armor: 4,
      enemies: 9, maxAlive: 4, speed: 28, fireEvery: 46, bulletSpeed: 134,
      aggression: 68, timeLimit: 80 * TICK_HZ, payout: 640, measured: 0.125
    }
  };

  // ------------------------------------------------------------ العشوائية
  /** xorshift32 — سريع وحتمي ومتطابق بين المتصفح والخادم. */
  function makeRng(seed32) {
    let s = seed32 | 0;
    if (s === 0) s = 0x1a2b3c4d;
    return function next() {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s |= 0;
      return s >>> 0;
    };
  }

  /** FNV-1a على نص البذرة — يحوّل البذرة السداسية إلى رقم 32-بت. */
  function seedFromHex(hex) {
    let h = 0x811c9dc5;
    const s = String(hex);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h | 0;
  }

  // ------------------------------------------------------------ الخريطة
  const EMPTY = 0, BRICK = 1, STEEL = 2;

  /**
   * خريطة متماثلة أفقياً: نبني النصف الأيسر ثم نعكسه.
   * التماثل ليس زينة — يمنع أن تكون إحدى الجهتين أسهل من الأخرى فينحرف
   * معدّل النجاة حسب مكان الظهور بدل مهارة اللاعب.
   */
  function buildMap(rnd) {
    const map = new Int8Array(COLS * ROWS);
    const half = COLS >> 1;

    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < half; c++) {
        const roll = rnd() % 100;
        let t = EMPTY;
        if (roll < 26) t = BRICK;
        else if (roll < 33) t = STEEL;
        map[r * COLS + c] = t;
        map[r * COLS + (COLS - 1 - c)] = t;
      }
    }

    // مناطق حرة: مكان ظهور اللاعب (الأسفل وسطاً) ومكان ظهور الأعداء (الأعلى)
    clear(map, (ROWS - 3), 2, ROWS - 1, COLS - 2);
    clear(map, 0, 0, 2, COLS);
    return map;
  }

  function clear(map, r0, c0, r1, c1) {
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) map[r * COLS + c] = EMPTY;
      }
    }
  }

  // ------------------------------------------------------------- التصادم
  function tileAt(map, x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return STEEL;   // الحدود جدار
    const c = (x / TILE) | 0;
    const r = (y / TILE) | 0;
    return map[r * COLS + c];
  }

  /** هل صندوق الدبابة عند (x,y) يصطدم بجدار؟ نفحص الأركان الأربعة. */
  function boxBlocked(map, x, y) {
    const l = x - HALF, r = x + HALF - 1, t = y - HALF, b = y + HALF - 1;
    return tileAt(map, l, t) !== EMPTY || tileAt(map, r, t) !== EMPTY
        || tileAt(map, l, b) !== EMPTY || tileAt(map, r, b) !== EMPTY;
  }

  function boxesOverlap(ax, ay, ah, bx, by, bh) {
    return Math.abs(ax - bx) < (ah + bh) && Math.abs(ay - by) < (ah + bh);
  }

  // =========================================================================
  // المحاكاة
  // =========================================================================
  function createSim(seedHex, difficultyKey) {
    const diff = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
    const rnd = makeRng(seedFromHex(seedHex));
    const map = buildMap(rnd);

    const sim = {
      diff,
      rnd,
      map,
      tick: 0,
      over: false,
      won: false,
      reason: null,          // 'killed' | 'timeout' | 'cleared'
      deathCause: null,      // 'bullet' | 'ram' — يلزم لضبط التوازن
      killed: 0,
      spawned: 0,
      spawnCool: 0,
      shake: 0,
      events: [],            // أحداث هذه النبضة — للصوت والومضات في المتصفح
      player: {
        x: (COLS >> 1) * TILE, y: (ROWS - 2) * TILE + (TILE >> 1),
        dir: 0, alive: true, cool: 0, shots: 0, moving: false, tread: 0,
        armor: diff.armor, maxArmor: diff.armor, hurt: 0
      },
      enemies: [],
      bullets: [],
      prevInput: 0
    };
    return sim;
  }

  /** مواقع ظهور الأعداء: الزوايا العليا والوسط. */
  const SPAWNS = [
    { x: TILE + (TILE >> 1), y: TILE >> 1 },
    { x: (COLS >> 1) * TILE, y: TILE >> 1 },
    { x: (COLS - 2) * TILE + (TILE >> 1), y: TILE >> 1 }
  ];

  function trySpawn(sim) {
    if (sim.spawned >= sim.diff.enemies) return;
    if (sim.enemies.length >= sim.diff.maxAlive) return;
    if (sim.spawnCool > 0) { sim.spawnCool--; return; }

    const base = SPAWNS[sim.rnd() % SPAWNS.length];
    // لا نُظهر عدوّاً فوق عدوّ: نجرّب المواقع بالترتيب حتى نجد فارغاً
    let spot = null;
    for (let i = 0; i < SPAWNS.length; i++) {
      const s = SPAWNS[(i + (sim.rnd() % SPAWNS.length)) % SPAWNS.length];
      let free = true;
      for (const e of sim.enemies) {
        if (boxesOverlap(s.x, s.y, HALF, e.x, e.y, HALF)) { free = false; break; }
      }
      if (free) { spot = s; break; }
    }
    if (!spot) spot = base;

    sim.enemies.push({
      id: sim.spawned,
      x: spot.x, y: spot.y,
      dir: 2, alive: true,
      cool: 20 + (sim.rnd() % 30),
      moveTimer: 0,
      born: sim.tick
    });
    sim.spawned++;
    sim.spawnCool = SPAWN_EVERY;
    sim.events.push({ t: 'spawn', x: spot.x, y: spot.y });
  }

  /**
   * إصابة اللاعب. مصدر واحد للحقيقة: الطلقة والالتحام يمرّان من هنا،
   * فلا يختلف حساب الدروع بين الاثنين.
   */
  function hurtPlayer(sim, cause) {
    const p = sim.player;
    if (!p.alive || p.hurt > 0) return false;
    p.armor--;
    p.hurt = HURT_TICKS;
    if (p.armor <= 0) {
      p.alive = false;
      sim.deathCause = cause;
      sim.shake = 14;
      sim.events.push({ t: 'death', x: p.x, y: p.y });
    } else {
      sim.shake = 8;
      sim.events.push({ t: 'hit', x: p.x, y: p.y, armor: p.armor });
    }
    return true;
  }

  /** تحريك دبابة مع منع المرور عبر الجدران والدبابات الأخرى. */
  function moveTank(sim, tank, dir, speed, isPlayer) {
    const nx = tank.x + DX[dir] * speed;
    const ny = tank.y + DY[dir] * speed;
    if (boxBlocked(sim.map, nx, ny)) return false;

    // تصادم الدبابات ببعضها — الأعداء لا يتراكبون
    if (!isPlayer) {
      for (const o of sim.enemies) {
        if (o === tank) continue;
        if (boxesOverlap(nx, ny, HALF, o.x, o.y, HALF)) return false;
      }
    }
    tank.x = nx; tank.y = ny;
    return true;
  }

  function fire(sim, tank, ownerId, speed) {
    sim.bullets.push({
      x: tank.x + DX[tank.dir] * HALF,
      y: tank.y + DY[tank.dir] * HALF,
      dir: tank.dir,
      speed,
      owner: ownerId              // -1 للاعب
    });
    sim.events.push({ t: 'fire', player: ownerId === -1 });
  }

  /**
   * تقدّم الطلقات على خطوات صغيرة.
   * الخطوة الكاملة قد تتجاوز بلاطة كاملة، فتمرّ الطلقة عبر الجدار بلا اصطدام
   * («النفق»). نقسّمها إلى خطوات أقصر من نصف بلاطة فيستحيل ذلك.
   */
  function advanceBullets(sim) {
    const step = TILE >> 1;
    const alive = [];

    for (const b of sim.bullets) {
      let left = b.speed;
      let dead = false;

      while (left > 0 && !dead) {
        const d = left > step ? step : left;
        left -= d;
        b.x += DX[b.dir] * d;
        b.y += DY[b.dir] * d;

        // خارج الساحة
        if (b.x < 0 || b.y < 0 || b.x >= W || b.y >= H) { dead = true; break; }

        // جدار
        const t = tileAt(sim.map, b.x, b.y);
        if (t !== EMPTY) {
          if (t === BRICK) {
            const c = (b.x / TILE) | 0, r = (b.y / TILE) | 0;
            sim.map[r * COLS + c] = EMPTY;
            sim.events.push({ t: 'brick', x: c * TILE + (TILE >> 1), y: r * TILE + (TILE >> 1) });
          } else {
            sim.events.push({ t: 'clank', x: b.x, y: b.y });
          }
          dead = true;
          break;
        }

        if (b.owner === -1) {
          // طلقة اللاعب: تصيب الأعداء
          for (const e of sim.enemies) {
            if (boxesOverlap(b.x, b.y, BHALF, e.x, e.y, HALF)) {
              e.alive = false;
              sim.killed++;
              sim.shake = 6;
              sim.events.push({ t: 'kill', x: e.x, y: e.y });
              dead = true;
              break;
            }
          }
        } else if (sim.player.alive
                   && boxesOverlap(b.x, b.y, BHALF, sim.player.x, sim.player.y, HALF)) {
          // الطلقة تنتهي حتى لو كان اللاعب في لحظة مناعة — وإلا اخترقته
          hurtPlayer(sim, 'bullet');
          dead = true;
          break;
        }
      }

      if (!dead) alive.push(b);
      else if (b.owner === -1) sim.player.shots--;
    }

    sim.bullets = alive;
  }

  /** هل الخط بين نقطتين على المحور خالٍ من الفولاذ؟ (الطوب يُخترق بالإطلاق) */
  function clearShot(sim, fromX, fromY, toX, toY, dir) {
    let x = fromX, y = fromY;
    const stepX = DX[dir] * (TILE >> 1);
    const stepY = DY[dir] * (TILE >> 1);
    for (let i = 0; i < 40; i++) {
      x += stepX; y += stepY;
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (tileAt(sim.map, x, y) === STEEL) return false;
      if (Math.abs(x - toX) < TILE && Math.abs(y - toY) < TILE) return true;
    }
    return false;
  }

  function enemyThink(sim, e) {
    const p = sim.player;
    const dx = p.x - e.x;
    const dy = p.y - e.y;

    // اختيار الاتجاه: نحو اللاعب غالباً، وعشوائي أحياناً كي لا يصير سلوكه محفوظاً
    if (e.moveTimer <= 0) {
      const roll = sim.rnd() % 100;
      let dir;
      if (roll < sim.diff.aggression) {
        dir = Math.abs(dx) > Math.abs(dy)
          ? (dx > 0 ? 1 : 3)
          : (dy > 0 ? 2 : 0);
      } else {
        dir = sim.rnd() % 4;
      }
      e.dir = dir;
      e.moveTimer = 12 + (sim.rnd() % 26);
    }

    if (!moveTank(sim, e, e.dir, sim.diff.speed, false)) {
      e.moveTimer = 0;          // اصطدم: يعيد الاختيار في النبضة التالية
    } else {
      e.moveTimer--;
    }

    // الإطلاق: عند المحاذاة مع خطّ نار خالٍ، أو عشوائياً بنسبة ضئيلة
    if (e.cool > 0) { e.cool--; return; }

    let shoot = false;
    if (Math.abs(dy) < TANK && Math.abs(dx) > TANK) {
      const d = dx > 0 ? 1 : 3;
      if (clearShot(sim, e.x, e.y, p.x, p.y, d)) { e.dir = d; shoot = true; }
    } else if (Math.abs(dx) < TANK && Math.abs(dy) > TANK) {
      const d = dy > 0 ? 2 : 0;
      if (clearShot(sim, e.x, e.y, p.x, p.y, d)) { e.dir = d; shoot = true; }
    }
    if (!shoot && (sim.rnd() % 100) < 3) shoot = true;

    if (shoot) {
      fire(sim, e, e.id, sim.diff.bulletSpeed);
      e.cool = sim.diff.fireEvery;
    }
  }

  // ------------------------------------------------------------- النبضة
  /**
   * نبضة واحدة. ترتيب الخطوات جزء من العقد بين الخادم والمتصفح:
   * أي تبديل فيه يغيّر النتيجة ويُبطل كل الجولات.
   */
  function step(sim, input) {
    if (sim.over) return sim;
    sim.events.length = 0;
    if (sim.shake > 0) sim.shake--;

    // 1) الطلقات أولاً: من أطلق في النبضة الماضية تصل طلقته الآن
    advanceBullets(sim);

    // 2) اللاعب
    const p = sim.player;
    if (p.hurt > 0) p.hurt--;
    if (p.alive) {
      let dir = -1;
      if (input & IN_UP) dir = 0;
      else if (input & IN_RIGHT) dir = 1;
      else if (input & IN_DOWN) dir = 2;
      else if (input & IN_LEFT) dir = 3;

      p.moving = false;
      if (dir >= 0) {
        p.dir = dir;
        if (moveTank(sim, p, dir, PLAYER_SPEED, true)) {
          p.moving = true;
          p.tread = (p.tread + 1) & 63;
        }
      }

      if (p.cool > 0) p.cool--;
      // الإطلاق على حافة الضغط فقط: الاستمرار بالضغط لا يرشّ طلقات
      const firePressed = (input & IN_FIRE) && !(sim.prevInput & IN_FIRE);
      if (firePressed && p.cool === 0 && p.shots < PLAYER_MAX_SHOTS) {
        fire(sim, p, -1, PLAYER_BULLET_SPEED);
        p.shots++;
        p.cool = PLAYER_COOL;
      }
    }
    sim.prevInput = input;

    // 3) الأعداء
    for (const e of sim.enemies) if (e.alive) enemyThink(sim, e);

    // 4) الالتحام: دبابة عدوّ تلمس اللاعب تقتله — كي لا ينفع الاختباء
    if (p.alive) {
      for (const e of sim.enemies) {
        if (e.alive && boxesOverlap(p.x, p.y, HALF, e.x, e.y, HALF)) {
          hurtPlayer(sim, 'ram');
          break;
        }
      }
    }

    // 5) إزالة القتلى وإظهار الجدد
    if (sim.enemies.length) sim.enemies = sim.enemies.filter((e) => e.alive);
    trySpawn(sim);

    // 6) النهاية
    sim.tick++;
    if (!p.alive) {
      sim.over = true; sim.won = false; sim.reason = 'killed';
    } else if (sim.killed >= sim.diff.enemies) {
      sim.over = true; sim.won = true; sim.reason = 'cleared';
    } else if (sim.tick >= sim.diff.timeLimit) {
      sim.over = true; sim.won = false; sim.reason = 'timeout';
    }
    return sim;
  }

  // =========================================================================
  // إعادة التشغيل للتحقق — هذه هي الدالة التي يحكم بها الخادم
  // =========================================================================
  /**
   * `inputs` مصفوفة مسطّحة [نبضة, قناع, نبضة, قناع, ...] بالتغيّرات فقط.
   * مسطّحة لا أزواجاً: أصغر في النقل وأسرع في القراءة وأصعب في التلاعب بالشكل.
   */
  function runReplay(seedHex, difficultyKey, inputs) {
    const sim = createSim(seedHex, difficultyKey);
    const diff = sim.diff;
    const n = inputs ? inputs.length : 0;

    let idx = 0;
    let mask = 0;
    let lastTick = -1;

    while (!sim.over && sim.tick < diff.timeLimit) {
      while (idx + 1 < n && inputs[idx] <= sim.tick) {
        const t = inputs[idx] | 0;
        // النبضات يجب أن تتقدّم: أي رجوع للخلف تلاعب بالسجلّ
        if (t < lastTick) return { valid: false, error: 'ترتيب الإدخال غير صالح' };
        lastTick = t;
        mask = inputs[idx + 1] | 0;
        if (mask < 0 || mask > 31) return { valid: false, error: 'قناع إدخال غير صالح' };
        idx += 2;
      }
      step(sim, mask);
    }

    return {
      valid: true,
      won: !!sim.won,
      reason: sim.reason || 'timeout',
      ticks: sim.tick,
      killed: sim.killed,
      total: diff.enemies
    };
  }

  return {
    TILE, COLS, ROWS, W, H, TANK, HALF, BULLET, BHALF, TICK_HZ,
    PLAYER_SPEED, PLAYER_MAX_SHOTS,
    EMPTY, BRICK, STEEL, HURT_TICKS,
    IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT, IN_FIRE,
    DX, DY, DIFFICULTY,
    createSim, step, runReplay, seedFromHex, makeRng, tileAt, boxesOverlap
  };
}));
