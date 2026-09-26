/**
 * CHICKEN ROAD - Full HD Realistic World, Lighting, Traffic & City Environment
 * إدارة المشهد ثلاثي الأبعاد فائق الدقة، إضاءة سينمائية، حركة المرور وناطحات السحاب
 */

class GameWorld {
    constructor(canvasContainer) {
        this.container = canvasContainer;
        this.scene = null;
        this.camera = null;
        this.renderer = null;

        // عناصر اللعبة
        this.chicken = null;
        this.lanes = [];
        this.vehicles = [];
        this.particles = [];
        this.dizzyStars = [];
        this.skidMarks = [];

        // حركة المرور تحترم الدجاجة: في المسار الذي تقف فيه أو تقفز إليه
        // تتوقّف السيارات قبلها بدل أن تعبر من خلالها (كان هذا الخلل: السيارات
        // تتحرّك عمياء فتمرّ من جسم الدجاجة دون أثر).
        this.blockedLanes = new Set();
        this.crashCar = null;      // السيارة الوحيدة المسموح لها بالوصول للدجاجة
        this.currentLane = 0;

        // متغيرات الحركة والكاميرا
        this.cameraTarget = new THREE.Vector3(0, 0, 0);
        this.cameraOffset = new THREE.Vector3(0, 12.5, -13.5); // زاوية سينمائية فائقة الوضوح
        this.isScreenShaking = false;
        this.shakeIntensity = 0;
        
        // التوقيت
        this.clock = new THREE.Clock();
        this.isPaused = false;

        this.init();
    }

    init() {
        // 1. إنشاء المشهد وضباب جوي واقعي
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0f172a); // سماء المساء العصرية
        this.scene.fog = new THREE.FogExp2(0x1e293b, 0.012);

        // 2. إعداد الكاميرا
        const aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(46, aspect, 0.1, 200);
        this.updateCameraPosition(0);

        // 3. محرك التصيير Full HD مع ACESFilmicToneMapping & sRGBEncoding
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // دقة Full HD / Retina فائقة الحدة
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.25;
        this.renderer.outputEncoding = THREE.sRGBEncoding;

        this.container.appendChild(this.renderer.domElement);

        // 4. الإضاءة السينمائية الواقعية
        this.setupLighting();

        // 5. بناء بيئة الطريق السريع، ناطحات السحاب، والرصيف
        this.buildEnvironment();

        // 6. صناعة وإضافة مجسم الدجاجة الواقعي
        this.chicken = Models.createChicken();
        this.chicken.position.set(0, 0, this.getZForLane(0));
        this.scene.add(this.chicken);

        // 7. تهيئة حركة المرور الواقعية
        this.initTraffic();

        // 8. التعامل مع تغيير حجم النافذة
        window.addEventListener('resize', () => this.onWindowResize());

        // 9. بدء حلقة الأنيميشن
        this.animate();
    }

    setupLighting() {
        // ضوء نصفي محيطي يحاكي انعكاس السماء والأرض الواقعية
        const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x1e293b, 0.75);
        this.scene.add(hemiLight);

        // ضوء شمس مائل قوي يعطي ظلالاً دقيقة وميتاليك
        const sun = new THREE.DirectionalLight(0xfffaed, 1.35);
        sun.position.set(18, 32, -15);
        sun.castShadow = true;
        sun.shadow.mapSize.width = 2048;
        sun.shadow.mapSize.height = 2048;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 120;
        const d = 32;
        sun.shadow.camera.left = -d;
        sun.shadow.camera.right = d;
        sun.shadow.camera.top = d;
        sun.shadow.camera.bottom = -d;
        sun.shadow.bias = -0.0003;
        this.sunLight = sun;
        this.scene.add(sun);

        // ضوء أزرق خافت لحواف المجسمات (Rim Light)
        const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
        rimLight.position.set(-20, 15, 25);
        this.scene.add(rimLight);
    }

    getZForLane(laneIndex) {
        const laneW = CONFIG.world.laneWidth;
        if (laneIndex === 0) return 0;
        return laneIndex * laneW;
    }

    buildEnvironment() {
        const laneW = CONFIG.world.laneWidth;
        const totalLanes = CONFIG.stages.length;
        const roadSpanX = CONFIG.world.roadSpanX;

        // رصيف البداية الواقعي (الخانة 0)
        const startCurbGeo = new THREE.BoxGeometry(roadSpanX + 30, 0.6, CONFIG.world.curbWidth);
        const curbConcreteMat = new THREE.MeshStandardMaterial({
            color: 0x334155,
            roughness: 0.85,
            metalness: 0.1
        });
        const startCurb = new THREE.Mesh(startCurbGeo, curbConcreteMat);
        startCurb.position.set(0, -0.3, 0);
        startCurb.receiveShadow = true;
        this.scene.add(startCurb);

        // رصيف مشاة أخضر مع أشجار وأعمدة إنارة
        const grassMat = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.9 });
        const startGrassGeo = new THREE.BoxGeometry(roadSpanX + 30, 0.15, CONFIG.world.curbWidth - 1.0);
        const startGrass = new THREE.Mesh(startGrassGeo, grassMat);
        startGrass.position.set(0, 0.05, -1.2);
        startGrass.receiveShadow = true;
        this.scene.add(startGrass);

        // أشجار وأعمدة إنارة على رصيف البداية
        [-15, -9, 9, 15].forEach(x => {
            const tree = Models.createTree();
            tree.position.set(x, 0, -2.0);
            this.scene.add(tree);
        });
        const lamp1 = Models.createStreetLight(); lamp1.position.set(-12, 0, 0.2); this.scene.add(lamp1);
        const lamp2 = Models.createStreetLight(); lamp2.position.set(12, 0, 0.2); this.scene.add(lamp2);

        // بناء المسارات الـ 12 للطريق السريع (Highway Asphalt)
        const asphaltMatDark = new THREE.MeshStandardMaterial({ color: 0x1e242b, roughness: 0.85, metalness: 0.15 });
        const asphaltMatLight = new THREE.MeshStandardMaterial({ color: 0x242b33, roughness: 0.85, metalness: 0.15 });
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });
        const yellowLineMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.3, metalness: 0.1 });

        CONFIG.stages.forEach((stage, idx) => {
            const laneZ = this.getZForLane(stage.lane);
            const isEven = idx % 2 === 0;

            // مسطح الأسفلت
            const laneGeo = new THREE.BoxGeometry(roadSpanX, 0.5, laneW);
            const laneMat = isEven ? asphaltMatDark : asphaltMatLight;
            const laneMesh = new THREE.Mesh(laneGeo, laneMat);
            laneMesh.position.set(0, -0.25, laneZ);
            laneMesh.receiveShadow = true;
            this.scene.add(laneMesh);

            // خطوط الطريق المتقطعة البيضاء
            for (let i = -8; i <= 8; i++) {
                if (i % 2 === 0) {
                    const stripeGeo = new THREE.BoxGeometry(2.0, 0.02, 0.2);
                    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
                    stripe.position.set(i * 2.6, 0.01, laneZ - (laneW / 2));
                    this.scene.add(stripe);
                }
            }

            // لوحة المضاعف فائقة الوضوح على أرضية المسار
            const badge = this.createLaneBadgeHD(stage.lane, stage.multiplier);
            badge.position.set(0, 0.025, laneZ);
            this.scene.add(badge);

            this.lanes.push({
                index: stage.lane,
                z: laneZ,
                multiplier: stage.multiplier,
                direction: isEven ? 1 : -1,
                badgeMesh: badge
            });
        });

        // حواجز الطريق الجانبية المعدنية (Highway Guardrails)
        const guardrailMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });
        const totalRoadLength = (totalLanes + 1) * laneW;
        [-roadSpanX / 2, roadSpanX / 2].forEach(x => {
            const railGeo = new THREE.BoxGeometry(0.3, 0.8, totalRoadLength + 10);
            const rail = new THREE.Mesh(railGeo, guardrailMat);
            rail.position.set(x, 0.4, totalRoadLength / 2);
            rail.castShadow = true;
            this.scene.add(rail);
        });

        // رصيف النهاية الذهبي (الخانة 13 - خط النهاية الفائز)
        const finalZ = this.getZForLane(totalLanes + 1);
        const finalCurbGeo = new THREE.BoxGeometry(roadSpanX + 30, 0.7, CONFIG.world.curbWidth + 4);
        const goldFinishMat = new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.6, roughness: 0.3 });
        const finalCurb = new THREE.Mesh(finalCurbGeo, goldFinishMat);
        finalCurb.position.set(0, -0.2, finalZ);
        finalCurb.receiveShadow = true;
        this.scene.add(finalCurb);

        // قوس النصر عند النهاية
        this.createFinishArch(finalZ);

        // بناء ناطحات سحاب في الأفق تعطي منظراً واقعياً للمدينة (City Skyline)
        this.buildCitySkyline(finalZ);

        // أرضية خضراء داكنة محيطة واسعة
        const groundGeo = new THREE.PlaneGeometry(300, 300);
        const groundMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.95 });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.6;
        ground.receiveShadow = true;
        this.scene.add(ground);
    }

    // بناء ناطحات سحاب في الأفق
    buildCitySkyline(finalZ) {
        const buildings = [
            { x: -28, z: 15, w: 9, h: 42, d: 9, color: 0x1e293b },
            { x: -36, z: 35, w: 11, h: 56, d: 11, color: 0x0f172a },
            { x: 28, z: 12, w: 8, h: 38, d: 8, color: 0x1e293b },
            { x: 38, z: 32, w: 12, h: 62, d: 12, color: 0x0f172a },
            { x: -26, z: 50, w: 10, h: 48, d: 10, color: 0x1e293b },
            { x: 26, z: 52, w: 10, h: 45, d: 10, color: 0x1e293b },
            { x: 0, z: finalZ + 25, w: 14, h: 70, d: 14, color: 0x090d16 },
            { x: -18, z: finalZ + 28, w: 12, h: 54, d: 12, color: 0x111827 },
            { x: 18, z: finalZ + 28, w: 12, h: 58, d: 12, color: 0x111827 }
        ];

        buildings.forEach(b => {
            const tower = Models.createSkyscraper(b.w, b.h, b.d, b.color);
            tower.position.set(b.x, 0, b.z);
            this.scene.add(tower);
        });
    }

    // شارة المضاعف فائقة الوضوح (Full HD Canvas Decal)
    createLaneBadgeHD(laneNum, multiplier) {
        const group = new THREE.Group();

        // لوحة معدنية نفاثة
        const plateGeo = new THREE.BoxGeometry(4.6, 0.03, 1.55);
        const plateMat = new THREE.MeshStandardMaterial({ 
            color: 0x090d16,
            roughness: 0.2,
            metalness: 0.8
        });
        const plate = new THREE.Mesh(plateGeo, plateMat);
        group.add(plate);

        // إطار نيون مشع
        const borderGeo = new THREE.BoxGeometry(4.75, 0.02, 1.7);
        const borderMat = new THREE.MeshBasicMaterial({ 
            color: laneNum >= 10 ? 0xff0055 : (laneNum >= 5 ? 0xf59e0b : 0x10b981)
        });
        const border = new THREE.Mesh(borderGeo, borderMat);
        border.position.y = -0.01;
        group.add(border);

        // رسم بالـ Canvas بدقة 1024x512
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        ctx.direction = 'ltr';   // الصفحة RTL: بدونه تُرسم «x1.20» مقلوبة الترتيب

        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, 1024, 512);

        // خلفية بنمط ألياف كربونية دقيقة
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 4;
        for (let i = 0; i < 1024; i += 32) {
            ctx.beginPath();
            ctx.moveTo(i, 0); ctx.lineTo(i + 512, 512);
            ctx.stroke();
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 88px Outfit, sans-serif';
        ctx.fillText(`LANE ${laneNum}`, 512, 140);

        ctx.fillStyle = laneNum >= 10 ? '#ff1744' : (laneNum >= 5 ? '#f59e0b' : '#10b981');
        ctx.font = 'bold 192px Outfit, sans-serif';
        ctx.fillText(`x${multiplier.toFixed(2)}`, 512, 350);

        const texture = new THREE.CanvasTexture(canvas);
        texture.anisotropy = 8;
        const textGeo = new THREE.PlaneGeometry(4.3, 1.45);
        const textMat = new THREE.MeshBasicMaterial({ 
            map: texture, 
            transparent: true,
            side: THREE.DoubleSide 
        });
        const textMesh = new THREE.Mesh(textGeo, textMat);
        // مسطّحة ووجهها للأعلى، وأعلى النص بعيداً عن الكاميرا (كانت تدور 180° حول Y
        // فتُرى من ظهرها: «x1.18» تظهر معكوسة «81.1x»)
        textMesh.rotation.set(-Math.PI / 2, 0, Math.PI);
        textMesh.position.y = 0.03;
        group.add(textMesh);

        group.name = `badge_lane_${laneNum}`;
        return group;
    }

    /** يضع الدجاجة مباشرة على مسار (استئناف جولة بعد تحديث الصفحة). */
    placeChicken(laneIndex) {
        this.chicken.position.set(0, 0, this.getZForLane(laneIndex));
        this.currentLane = laneIndex;
        if (laneIndex > 0) {
            this.blockedLanes.add(laneIndex);
            // سيارة في نقطة الدجاجة لحظة الاستئناف تُنقل خلفها (يحدث عند التحميل فقط)
            this.vehicles.forEach(v => {
                if (v.laneIndex !== laneIndex) return;
                const pos = v.mesh.position.x * v.direction;
                const half = v.length / 2;
                if (pos + half > -1.6 && pos - half < 1.2) v.mesh.position.x = v.direction * (half + 2.5);
            });
        }
        this.updateCameraPosition(this.chicken.position.z);
    }

    /** يعيد رسم شارات المضاعفات على الأسفلت (تتغيّر مع الصعوبة). */
    updateLaneBadges() {
        this.lanes.forEach(lane => {
            const stage = CONFIG.stages[lane.index - 1];
            if (!stage) return;
            if (lane.badgeMesh) {
                this.scene.remove(lane.badgeMesh);
                lane.badgeMesh.traverse(o => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) {
                        if (o.material.map) o.material.map.dispose();
                        o.material.dispose();
                    }
                });
            }
            const badge = this.createLaneBadgeHD(stage.lane, stage.multiplier);
            badge.position.set(0, 0.025, lane.z);
            this.scene.add(badge);
            lane.badgeMesh = badge;
        });
    }

    createFinishArch(zPos) {
        const arch = new THREE.Group();
        const archMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.9, roughness: 0.15 });
        const postGeo = new THREE.BoxGeometry(1.0, 6.0, 1.0);

        const postL = new THREE.Mesh(postGeo, archMat);
        postL.position.set(-7, 3.0, zPos);
        postL.castShadow = true;

        const postR = new THREE.Mesh(postGeo, archMat);
        postR.position.set(7, 3.0, zPos);
        postR.castShadow = true;

        const beamGeo = new THREE.BoxGeometry(16.0, 1.2, 1.2);
        const beam = new THREE.Mesh(beamGeo, archMat);
        beam.position.set(0, 6.0, zPos);
        beam.castShadow = true;

        arch.add(postL, postR, beam);
        this.scene.add(arch);
    }

    // تهيئة حركة المرور الواقعية
    initTraffic() {
        this.lanes.forEach(lane => {
            const carCount = Math.random() > 0.35 ? 2 : 1;
            const dir = lane.direction;

            for (let i = 0; i < carCount; i++) {
                const vehicleData = this.getRandomVehicleConfig();
                const vehicleMesh = Models.buildVehicle(vehicleData.type, vehicleData.color);

                const speed = (Math.random() * (vehicleData.speedMax - vehicleData.speedMin) + vehicleData.speedMin) * dir;
                const startX = (i * 26 - 13) + (Math.random() * 6 - 3);

                vehicleMesh.position.set(startX, 0, lane.z);
                vehicleMesh.rotation.y = dir === 1 ? Math.PI / 2 : -Math.PI / 2;

                // إضافة إضاءة أمامية واقعية للسيارة (Headlight Cones)
                this.addVehicleHeadlightGlow(vehicleMesh, dir);

                this.scene.add(vehicleMesh);
                this.vehicles.push({
                    mesh: vehicleMesh,
                    laneIndex: lane.index,
                    laneZ: lane.z,
                    speed: speed,
                    cruise: speed,
                    type: vehicleData.type,
                    direction: dir,
                    length: vehicleData.length,
                    width: vehicleData.width
                });
            }
        });
    }

    // مخروط ضوء واقعي لمصابيح السيارة
    addVehicleHeadlightGlow(vehicleMesh, dir) {
        const coneGeo = new THREE.ConeGeometry(0.9, 4.5, 12, 1, true);
        const coneMat = new THREE.MeshBasicMaterial({
            color: 0xfffaed,
            transparent: true,
            opacity: 0.12,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const beamL = new THREE.Mesh(coneGeo, coneMat);
        beamL.rotation.x = -Math.PI / 2;
        beamL.position.set(-0.55, 0.45, 3.2);

        const beamR = beamL.clone();
        beamR.position.x = 0.55;

        vehicleMesh.add(beamL, beamR);
    }

    getRandomVehicleConfig() {
        const list = CONFIG.vehicles;
        const totalWeight = list.reduce((sum, v) => sum + v.weight, 0);
        let rnd = Math.random() * totalWeight;
        let selected = list[0];

        for (const v of list) {
            if (rnd < v.weight) {
                selected = v;
                break;
            }
            rnd -= v.weight;
        }

        const color = selected.colors[Math.floor(Math.random() * selected.colors.length)];
        return {
            type: selected.type,
            speedMin: selected.speedMin,
            speedMax: selected.speedMax,
            length: selected.length,
            width: selected.width,
            color: color
        };
    }

    /**
     * حركة المرور:
     * - السيارات في المسار الواحد تصطفّ ولا تعبر إحداها الأخرى (مسافة GAP).
     * - في مسار مغلق (فيه الدجاجة أو تقفز إليه) تفرمل السيارة القادمة وتقف
     *   قبل خط التوقّف، وتكمل حين يُفتح المسار. السيارة التي تجاوزت الدجاجة تكمل.
     * - سيارة الاصطدام تتحرّك بقفزة الدجاجة (scripted) لا هنا.
     * الحساب «على امتداد الاتجاه»: pos = x × dir، فالأمام دائماً قيمة أكبر.
     */
    updateTraffic(delta) {
        const boundX = CONFIG.world.trafficBoundX;
        const STOP = 1.6;   // مسافة وقوف مقدّمة السيارة عن مركز الدجاجة
        const GAP = 1.3;    // المسافة بين سيارتين متتاليتين

        const byLane = new Map();
        this.vehicles.forEach(v => {
            if (!byLane.has(v.laneIndex)) byLane.set(v.laneIndex, []);
            byLane.get(v.laneIndex).push(v);
        });

        byLane.forEach((list, laneIndex) => {
            const dir = list[0].direction;
            const blocked = this.blockedLanes.has(laneIndex);
            // الأمام أولاً
            list.sort((a, b) => (b.mesh.position.x - a.mesh.position.x) * dir);

            let aheadRear = null;   // مؤخرة السيارة التي أمامها (على امتداد الاتجاه)
            list.forEach(v => {
                const half = v.length / 2;
                const pos = v.mesh.position.x * dir;
                if (v.scripted) { aheadRear = pos - half; return; }

                let limit = Infinity;
                // مسار مغلق وما تزال قبل خط التوقّف: تقف عنده
                if (blocked && pos + half <= -STOP + 0.05) limit = -STOP - half;
                // لا تتجاوز السيارة التي أمامها
                if (aheadRear !== null) limit = Math.min(limit, aheadRear - GAP - half);

                const cruise = Math.abs(v.cruise);
                let speed = cruise;
                if (limit !== Infinity) {
                    // فرملة ناعمة: السرعة تتناسب مع المسافة المتبقّية
                    speed = Math.max(0, Math.min(cruise, (limit - pos) * 3.2));
                }
                v.speed = speed * dir;
                let next = pos + speed * delta;
                if (limit !== Infinity) next = Math.min(next, Math.max(pos, limit));
                v.mesh.position.x = next * dir;
                aheadRear = next - half;
            });
        });

        // سيارة خرجت من الطرف تعود من البداية — خلف آخر سيارة في مسارها لا فوقها
        // (سيارات تحرّرت معاً من طابور كانت تعود متراكبة)
        this.vehicles.forEach(veh => {
            if (veh.scripted) return;
            const dir = veh.direction;
            if (veh.mesh.position.x * dir <= boundX) return;
            let pos = -boundX - Math.random() * 4;
            this.vehicles.forEach(o => {
                if (o === veh || o.laneIndex !== veh.laneIndex) return;
                const oRear = o.mesh.position.x * dir - o.length / 2;
                pos = Math.min(pos, oRear - GAP - veh.length / 2);
            });
            veh.mesh.position.x = pos * dir;
            this.refreshVehicle(veh);
        });
    }

    refreshVehicle(veh) {
        const vData = this.getRandomVehicleConfig();
        veh.cruise = (Math.random() * (vData.speedMax - vData.speedMin) + vData.speedMin) * veh.direction;
        veh.speed = veh.cruise;
    }

    /**
     * هل في نقطة عبور الدجاجة من هذا المسار سيارة، أو سيارة تجاوزت خط التوقّف
     * ولم تبتعد بعد؟ (تلك لا تستطيع الفرملة — يجب أن تمرّ قبل القفز.)
     */
    laneCrossingBusy(laneIndex) {
        const STOP = 1.6;
        return this.vehicles.some(v => {
            if (v.scripted || v.laneIndex !== laneIndex) return false;
            const pos = v.mesh.position.x * v.direction;
            const half = v.length / 2;
            return pos + half > -STOP + 0.05 && pos - half < 1.2;
        });
    }

    /** يغلق المسار ثم ينتظر خلوّ نقطة العبور (سيارة كانت تمرّ تكمل وتبتعد). */
    whenLaneClear(laneIndex, cb) {
        this.blockedLanes.add(laneIndex);
        const t0 = performance.now();
        const check = () => {
            if (!this.laneCrossingBusy(laneIndex) || performance.now() - t0 > 2500) return cb();
            requestAnimationFrame(check);
        };
        check();
    }

    /** السيارة التي ستصل للدجاجة: الأقرب القادمة نحوها في ذلك المسار. */
    pickCrashCar(laneIndex) {
        const list = this.vehicles.filter(v => v.laneIndex === laneIndex);
        if (!list.length) return null;
        const dir = list[0].direction;
        const approaching = list
            .filter(v => (v.mesh.position.x * dir + v.length / 2) < -0.5)
            .sort((a, b) => (b.mesh.position.x - a.mesh.position.x) * dir);
        return approaching[0] || list[0];
    }

    // قفزة الدجاجة الواقعية والانسيابية
    hopChicken(targetLane, isSafe, onComplete) {
        const fromLane = this.currentLane || 0;
        // لا تقفز وسيارة ما تزال في نقطة العبور — وإلا مرّت من خلالها
        this.whenLaneClear(targetLane, () => {
            let crashCar = null;
            if (!isSafe) {
                crashCar = this.pickCrashCar(targetLane);
                if (crashCar) crashCar.scripted = true;   // لا فرملة لها ولا اصطفاف
            }
            this.runHop(fromLane, targetLane, isSafe, crashCar, onComplete);
        });
    }

    runHop(fromLane, targetLane, isSafe, crashCar, onComplete) {
        const startZ = this.chicken.position.z;
        const targetZ = this.getZForLane(targetLane);
        const duration = CONFIG.hopDuration;
        const startTime = performance.now();

        const wingL = this.chicken.getObjectByName("wingL");
        const wingR = this.chicken.getObjectByName("wingR");

        audio.playHop();

        // سيارة الاصطدام: تصل مقدّمتها للدجاجة لحظة هبوطها بالضبط
        let carFrom = 0, carTo = 0, carSpan = 1;
        if (crashCar) {
            const dir = crashCar.direction;
            carTo = -dir * (crashCar.length / 2 - 0.35);
            const edge = -dir * 11;
            const cur = crashCar.mesh.position.x;
            // أبعد من طرف الرؤية أو تجاوزت الدجاجة: تبدأ من طرف الرؤية
            const beyondEdge = (cur - edge) * dir < 0;
            const passed = (cur - carTo) * dir > 0;
            carFrom = (beyondEdge || passed) ? edge : cur;
            crashCar.mesh.position.x = carFrom;
            const speed = Math.max(Math.abs(crashCar.cruise), 14);          // وحدة/ثانية
            carSpan = Math.min(1, Math.abs(carTo - carFrom) / (speed * duration / 1000));
            if (audio.playHonk) audio.playHonk();
        }

        const animateHop = (now) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1.0);
            const easeProgress = 1 - (1 - progress) * (1 - progress);
            const jumpHeight = 1.45 * Math.sin(progress * Math.PI);

            this.chicken.position.y = jumpHeight;
            this.chicken.position.z = startZ + (targetZ - startZ) * easeProgress;

            if (wingL && wingR) {
                const wingFlap = Math.sin(progress * Math.PI * 4) * 0.4;
                wingL.rotation.z = wingFlap;
                wingR.rotation.z = -wingFlap;
            }

            if (crashCar) {
                // بسرعة سيارة حقيقية: القريبة تنطلق متأخّرة لا تزحف ببطء
                const t = carSpan > 0 ? Math.min(1, Math.max(0, (progress - (1 - carSpan)) / carSpan)) : 1;
                crashCar.mesh.position.x = carFrom + (carTo - carFrom) * t;
            }

            this.updateCameraPosition(this.chicken.position.z);

            if (progress < 1.0) {
                requestAnimationFrame(animateHop);
                return;
            }
            this.chicken.position.y = 0;
            this.chicken.position.z = targetZ;
            if (wingL && wingR) { wingL.rotation.z = 0; wingR.rotation.z = 0; }

            // الدجاجة غادرت مسارها القديم: تعود حركته
            if (fromLane !== targetLane) this.blockedLanes.delete(fromLane);
            this.currentLane = targetLane;

            if (isSafe) this.onSafeLanding(targetLane);
            else this.crashCar = crashCar;
            if (onComplete) onComplete();
        };

        requestAnimationFrame(animateHop);
    }

    onSafeLanding(laneIndex) {
        audio.playSafe(laneIndex);
        this.spawnSafeGlow(this.chicken.position.z);

        const wingL = this.chicken.getObjectByName("wingL");
        const wingR = this.chicken.getObjectByName("wingR");
        if (wingL && wingR) {
            wingL.rotation.z = 0.45;
            wingR.rotation.z = -0.45;
            setTimeout(() => {
                wingL.rotation.z = 0;
                wingR.rotation.z = 0;
            }, 300);
        }
    }

    spawnSafeGlow(zPos) {
        const ringGeo = new THREE.RingGeometry(0.4, 2.0, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x10b981,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.04, zPos);
        this.scene.add(ring);

        let scale = 1.0;
        let opacity = 0.9;

        const animateRing = () => {
            scale += 0.08;
            opacity -= 0.045;
            ring.scale.set(scale, scale, scale);
            ring.material.opacity = Math.max(0, opacity);

            if (opacity > 0) {
                requestAnimationFrame(animateRing);
            } else {
                this.scene.remove(ring);
                ring.geometry.dispose();
                ring.material.dispose();
            }
        };
        requestAnimationFrame(animateRing);
    }

    // اصطدام كرتوني ظريف بدون عنف
    triggerCrashAnimation(laneIndex, onFinished) {
        audio.playCrash();
        this.triggerScreenShake(0.5, 480);

        const hittingCar = this.crashCar;
        if (hittingCar) {
            if (audio.playBrake) audio.playBrake();
            this.spawnSkidMarks(hittingCar.mesh.position.x, hittingCar.laneZ, hittingCar.direction);
        }

        const startY = this.chicken.position.y;
        const startZ = this.chicken.position.z;
        const startTime = performance.now();
        const duration = 850;

        this.spawnFeathers(this.chicken.position.x, this.chicken.position.y + 1, this.chicken.position.z);
        this.spawnDizzyStars();

        const animateCrash = (now) => {
            const elapsed = now - startTime;
            const p = Math.min(elapsed / duration, 1.0);

            this.chicken.position.y = startY + Math.sin(p * Math.PI) * 2.4;
            this.chicken.position.z = startZ - p * 1.6;
            this.chicken.rotation.x = p * Math.PI * 2;
            this.chicken.rotation.z = Math.sin(p * Math.PI * 4) * 0.5;

            if (p < 1.0) {
                requestAnimationFrame(animateCrash);
            } else {
                this.chicken.position.y = 0;
                this.chicken.rotation.set(0, 0, Math.PI / 2);
                if (onFinished) onFinished();
            }
        };

        requestAnimationFrame(animateCrash);
    }

    spawnFeathers(x, y, z) {
        const count = 22;
        const featherGeo = new THREE.PlaneGeometry(0.22, 0.38);

        for (let i = 0; i < count; i++) {
            const isRed = Math.random() > 0.75;
            const featherMat = new THREE.MeshBasicMaterial({
                color: isRed ? 0xd90429 : 0xffffff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.95
            });
            const feather = new THREE.Mesh(featherGeo, featherMat);
            feather.position.set(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6);

            this.scene.add(feather);
            this.particles.push({
                mesh: feather,
                velX: (Math.random() - 0.5) * 5,
                velY: Math.random() * 3.5 + 2.5,
                velZ: (Math.random() - 0.5) * 5,
                rotSpeed: (Math.random() - 0.5) * 7,
                life: 1.0
            });
        }
    }

    spawnDizzyStars() {
        this.clearDizzyStars();
        const starCount = 4;
        const starGeo = new THREE.ConeGeometry(0.2, 0.38, 5);
        const starMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });

        for (let i = 0; i < starCount; i++) {
            const star = new THREE.Mesh(starGeo, starMat);
            this.scene.add(star);
            this.dizzyStars.push({
                mesh: star,
                angle: (i / starCount) * Math.PI * 2,
                radius: 0.9,
                height: 1.9
            });
        }
    }

    clearDizzyStars() {
        this.dizzyStars.forEach(s => {
            this.scene.remove(s.mesh);
            s.mesh.geometry.dispose();
            s.mesh.material.dispose();
        });
        this.dizzyStars = [];
    }

    spawnSkidMarks(x, z, dir) {
        const markGeo = new THREE.PlaneGeometry(3.5, 0.28);
        const markMat = new THREE.MeshBasicMaterial({
            color: 0x0a0a0a,
            transparent: true,
            opacity: 0.75
        });
        const mark1 = new THREE.Mesh(markGeo, markMat);
        const mark2 = mark1.clone();

        mark1.rotation.x = -Math.PI / 2;
        mark2.rotation.x = -Math.PI / 2;
        mark1.position.set(x - dir * 1.2, 0.015, z - 0.55);
        mark2.position.set(x - dir * 1.2, 0.015, z + 0.55);

        this.scene.add(mark1, mark2);
        this.skidMarks.push(mark1, mark2);
    }

    // احتفال جمع الجائزة مع قطع نقدية واقعية
    spawnCashOutCelebration(onComplete) {
        audio.playCashOut();
        const coinCount = 40;
        const coinGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.07, 16);
        const coinMat = new THREE.MeshStandardMaterial({
            color: 0xf59e0b,
            metalness: 0.95,
            roughness: 0.15
        });

        for (let i = 0; i < coinCount; i++) {
            const coin = new THREE.Mesh(coinGeo, coinMat);
            coin.position.set(
                this.chicken.position.x,
                this.chicken.position.y + 0.9,
                this.chicken.position.z
            );
            this.scene.add(coin);

            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 6 + 3.5;

            this.particles.push({
                mesh: coin,
                velX: Math.cos(angle) * speed,
                velY: Math.random() * 7 + 4,
                velZ: Math.sin(angle) * speed,
                rotSpeed: Math.random() * 9,
                life: 1.3
            });
        }

        const startY = this.chicken.position.y;
        let t = 0;
        const celebrateInterval = setInterval(() => {
            t += 0.15;
            this.chicken.position.y = startY + Math.abs(Math.sin(t * 3)) * 0.85;
            this.chicken.rotation.y += 0.22;
            if (t >= 3.0) {
                clearInterval(celebrateInterval);
                this.chicken.position.y = startY;
                this.chicken.rotation.y = 0;
                if (onComplete) onComplete();
            }
        }, 30);
    }

    triggerScreenShake(intensity = 0.4, durationMs = 450) {
        this.isScreenShaking = true;
        this.shakeIntensity = intensity;
        setTimeout(() => {
            this.isScreenShaking = false;
        }, durationMs);
    }

    resetChicken() {
        this.clearDizzyStars();
        this.blockedLanes.clear();
        this.currentLane = 0;
        this.crashCar = null;
        this.vehicles.forEach(v => { v.scripted = false; });
        this.chicken.position.set(0, 0, this.getZForLane(0));
        this.chicken.rotation.set(0, 0, 0);

        this.skidMarks.forEach(m => {
            this.scene.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        });
        this.skidMarks = [];

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            this.scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            p.mesh.material.dispose();
        }
        this.particles = [];

        this.updateCameraPosition(0);
    }

    updateCameraPosition(chickenZ) {
        const targetZ = chickenZ + 6.8;
        this.cameraTarget.set(0, 1.4, targetZ);

        let camX = this.cameraOffset.x;
        let camY = this.cameraOffset.y;
        let camZ = chickenZ + this.cameraOffset.z;

        if (this.isScreenShaking) {
            camX += (Math.random() - 0.5) * this.shakeIntensity;
            camY += (Math.random() - 0.5) * this.shakeIntensity;
            camZ += (Math.random() - 0.5) * this.shakeIntensity;
        }

        this.camera.position.set(camX, camY, camZ);
        this.camera.lookAt(this.cameraTarget);

        if (this.sunLight) {
            this.sunLight.position.set(18, 32, chickenZ + 6);
            this.sunLight.target.position.set(0, 0, chickenZ + 6);
            this.scene.add(this.sunLight.target);
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const delta = Math.min(this.clock.getDelta(), 0.1);

        if (!this.isPaused) {
            this.updateTraffic(delta);
            this.updateParticles(delta);
            this.updateDizzyStars(delta);

            if (this.chicken && this.chicken.position.y === 0 && this.dizzyStars.length === 0) {
                const idleTime = this.clock.getElapsedTime();
                this.chicken.position.y = Math.sin(idleTime * 4) * 0.04;
            }
        }

        this.renderer.render(this.scene, this.camera);
    }

    updateParticles(delta) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.mesh.position.x += p.velX * delta;
            p.mesh.position.y += p.velY * delta;
            p.mesh.position.z += p.velZ * delta;
            p.velY -= 9.8 * delta;
            p.mesh.rotation.y += p.rotSpeed * delta;
            p.life -= delta;

            if (p.mesh.material.opacity !== undefined) {
                p.mesh.material.opacity = Math.max(0, p.life);
            }

            if (p.life <= 0 || p.mesh.position.y < -0.5) {
                this.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                p.mesh.material.dispose();
                this.particles.splice(i, 1);
            }
        }
    }

    updateDizzyStars(delta) {
        if (this.dizzyStars.length === 0 || !this.chicken) return;

        const time = this.clock.getElapsedTime();
        const headPos = new THREE.Vector3();
        this.chicken.getWorldPosition(headPos);

        this.dizzyStars.forEach(s => {
            s.angle += delta * 4.5;
            const x = headPos.x + Math.cos(s.angle) * s.radius;
            const z = headPos.z + Math.sin(s.angle) * s.radius;
            const y = headPos.y + s.height + Math.sin(s.angle * 2) * 0.15;
            s.mesh.position.set(x, y, z);
            s.mesh.rotation.y += delta * 6;
        });
    }

    onWindowResize() {
        if (!this.container || !this.renderer || !this.camera) return;
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }
}
