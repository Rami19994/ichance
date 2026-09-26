/**
 * CHICKEN ROAD - Full HD Realistic 3D Models
 * مجسمات واقعية عالية الدقة باستخدام خامات PBR (MeshStandardMaterial)
 */

const Models = {
    // خامات مشتركة عالية الدقة
    sharedMaterials: {
        chrome: new THREE.MeshStandardMaterial({
            color: 0xeeeeee,
            metalness: 0.95,
            roughness: 0.1
        }),
        rubber: new THREE.MeshStandardMaterial({
            color: 0x181818,
            metalness: 0.1,
            roughness: 0.85
        }),
        glass: new THREE.MeshStandardMaterial({
            color: 0x111e2e,
            metalness: 0.9,
            roughness: 0.05,
            transparent: true,
            opacity: 0.75
        }),
        brakeDisc: new THREE.MeshStandardMaterial({
            color: 0x888888,
            metalness: 0.9,
            roughness: 0.3
        }),
        caliper: new THREE.MeshStandardMaterial({
            color: 0xe11d48, // أحمر بريمبو الرياضي
            metalness: 0.4,
            roughness: 0.3
        }),
        headlightGlow: new THREE.MeshBasicMaterial({
            color: 0xffffff
        }),
        taillightGlow: new THREE.MeshBasicMaterial({
            color: 0xff1744
        }),
        mirrorGlass: new THREE.MeshStandardMaterial({
            color: 0xcccccc,
            metalness: 1.0,
            roughness: 0.05
        })
    },

    // 1. صناعة مجسم الدجاجة بتفاصيل واقعية وأنيقة
    createChicken() {
        const chickenGroup = new THREE.Group();
        chickenGroup.name = "chicken_main";

        // خامات الدجاجة الواقعية
        const featherWhiteMat = new THREE.MeshStandardMaterial({
            color: 0xfdfdfd,
            roughness: 0.65,
            metalness: 0.05
        });
        const featherChestMat = new THREE.MeshStandardMaterial({
            color: 0xf1f5f9,
            roughness: 0.7,
            metalness: 0.02
        });
        const combMat = new THREE.MeshStandardMaterial({
            color: 0xd90429, // أحمر حيوي
            roughness: 0.35,
            metalness: 0.05
        });
        const beakMat = new THREE.MeshStandardMaterial({
            color: 0xf59e0b,
            roughness: 0.25,
            metalness: 0.1
        });
        const eyeMat = new THREE.MeshStandardMaterial({
            color: 0x0a0a0a,
            roughness: 0.05,
            metalness: 0.2
        });
        const eyeGlintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const legMat = new THREE.MeshStandardMaterial({
            color: 0xea580c,
            roughness: 0.4,
            metalness: 0.1
        });

        // 1.1 جذع الجسم الانسيابي
        const bodyGeo = new THREE.CylinderGeometry(0.38, 0.44, 0.85, 16);
        const body = new THREE.Mesh(bodyGeo, featherWhiteMat);
        body.rotation.x = Math.PI / 3;
        body.position.set(0, 0.75, 0);
        body.castShadow = true;
        chickenGroup.add(body);

        // صدر الدجاجة الممتلئ
        const chestGeo = new THREE.SphereGeometry(0.42, 16, 16);
        const chest = new THREE.Mesh(chestGeo, featherChestMat);
        chest.scale.set(1.0, 1.15, 1.0);
        chest.position.set(0, 0.8, 0.28);
        chest.castShadow = true;
        chickenGroup.add(chest);

        // ريش الذيل المرتفع والمتدرج
        const tailGroup = new THREE.Group();
        for (let i = -2; i <= 2; i++) {
            const tailGeo = new THREE.BoxGeometry(0.08, 0.45 - Math.abs(i) * 0.06, 0.18);
            const tailFeather = new THREE.Mesh(tailGeo, featherWhiteMat);
            tailFeather.position.set(i * 0.07, 0.35 - Math.abs(i) * 0.03, -0.42);
            tailFeather.rotation.x = -0.55;
            tailFeather.rotation.y = i * 0.12;
            tailFeather.castShadow = true;
            tailGroup.add(tailFeather);
        }
        chickenGroup.add(tailGroup);

        // 1.2 الرقبة والرأس
        const neckGeo = new THREE.CylinderGeometry(0.24, 0.32, 0.45, 14);
        const neck = new THREE.Mesh(neckGeo, featherWhiteMat);
        neck.position.set(0, 1.18, 0.26);
        neck.rotation.x = 0.2;
        neck.castShadow = true;
        chickenGroup.add(neck);

        const headGeo = new THREE.SphereGeometry(0.28, 16, 16);
        const head = new THREE.Mesh(headGeo, featherWhiteMat);
        head.position.set(0, 1.42, 0.32);
        head.scale.set(0.9, 1.05, 1.1);
        head.castShadow = true;
        chickenGroup.add(head);

        // 1.3 عرف الدجاجة الأحمر المموج
        const combGroup = new THREE.Group();
        const combSegments = [
            { h: 0.18, z: 0.42, y: 1.64 },
            { h: 0.28, z: 0.32, y: 1.72 },
            { h: 0.32, z: 0.20, y: 1.74 },
            { h: 0.26, z: 0.08, y: 1.68 }
        ];
        combSegments.forEach(seg => {
            const spikeGeo = new THREE.BoxGeometry(0.09, seg.h, 0.12);
            const spike = new THREE.Mesh(spikeGeo, combMat);
            spike.position.set(0, seg.y, seg.z);
            spike.rotation.x = 0.1;
            spike.castShadow = true;
            combGroup.add(spike);
        });
        chickenGroup.add(combGroup);

        // الدلايات الحمراء أسفل المنقار (Wattles)
        const wattleGeo = new THREE.SphereGeometry(0.09, 10, 10);
        const wattleL = new THREE.Mesh(wattleGeo, combMat);
        wattleL.position.set(-0.06, 1.25, 0.52);
        wattleL.scale.set(0.7, 1.4, 0.9);
        const wattleR = wattleL.clone();
        wattleR.position.x = 0.06;
        chickenGroup.add(wattleL, wattleR);

        // المنقار الواقعي المنحني
        const beakGeo = new THREE.ConeGeometry(0.12, 0.32, 6);
        const beak = new THREE.Mesh(beakGeo, beakMat);
        beak.rotation.x = Math.PI / 2 + 0.15;
        beak.position.set(0, 1.38, 0.62);
        beak.castShadow = true;
        chickenGroup.add(beak);

        // العيون الواقعية ذات اللمعان
        const createRealisticEye = (xPos) => {
            const eyeGroup = new THREE.Group();
            const eyeballGeo = new THREE.SphereGeometry(0.075, 12, 12);
            const eyeball = new THREE.Mesh(eyeballGeo, eyeMat);

            const glintGeo = new THREE.SphereGeometry(0.024, 8, 8);
            const glint = new THREE.Mesh(glintGeo, eyeGlintMat);
            glint.position.set(0.02 * (xPos > 0 ? 1 : -1), 0.02, 0.055);

            eyeGroup.add(eyeball);
            eyeGroup.add(glint);
            eyeGroup.position.set(xPos, 1.46, 0.46);
            return eyeGroup;
        };
        chickenGroup.add(createRealisticEye(-0.21));
        chickenGroup.add(createRealisticEye(0.21));

        // 1.4 الأجنحة المفصلة
        const createWing = (isLeft) => {
            const wingGroup = new THREE.Group();
            wingGroup.name = isLeft ? "wingL" : "wingR";

            const wingBaseGeo = new THREE.BoxGeometry(0.08, 0.46, 0.62);
            const wingBase = new THREE.Mesh(wingBaseGeo, featherWhiteMat);
            wingBase.castShadow = true;
            wingGroup.add(wingBase);

            // ريش أطراف الجناح
            for (let j = 0; j < 3; j++) {
                const featherGeo = new THREE.BoxGeometry(0.06, 0.15, 0.35);
                const feather = new THREE.Mesh(featherGeo, featherChestMat);
                feather.position.set(isLeft ? -0.02 : 0.02, -0.22 - j * 0.04, -0.05 + j * 0.12);
                feather.rotation.z = isLeft ? 0.15 : -0.15;
                wingGroup.add(feather);
            }

            wingGroup.position.set(isLeft ? -0.42 : 0.42, 0.78, 0.08);
            return wingGroup;
        };
        chickenGroup.add(createWing(true));
        chickenGroup.add(createWing(false));

        // 1.5 الأرجل والمخالب
        const createLeg = (xPos) => {
            const leg = new THREE.Group();
            // الفخذ المغطى بريش ناعم
            const thighGeo = new THREE.CylinderGeometry(0.12, 0.08, 0.28, 8);
            const thigh = new THREE.Mesh(thighGeo, featherWhiteMat);
            thigh.position.y = 0.42;
            thigh.castShadow = true;

            // الساق العظمية
            const shankGeo = new THREE.CylinderGeometry(0.04, 0.038, 0.38, 8);
            const shank = new THREE.Mesh(shankGeo, legMat);
            shank.position.y = 0.22;
            shank.castShadow = true;

            // كف القدم و3 أصابع أمامية + إصبع خلفي
            const footGroup = new THREE.Group();
            footGroup.position.y = 0.04;

            [-0.32, 0, 0.32].forEach(angle => {
                const toeGeo = new THREE.CylinderGeometry(0.022, 0.018, 0.25, 6);
                const toe = new THREE.Mesh(toeGeo, legMat);
                toe.rotation.x = Math.PI / 2;
                toe.rotation.y = angle;
                toe.position.set(Math.sin(angle) * 0.1, 0, Math.cos(angle) * 0.12);
                toe.castShadow = true;
                footGroup.add(toe);
            });

            // إصبع خلفي (Spur)
            const spurGeo = new THREE.CylinderGeometry(0.02, 0.015, 0.12, 6);
            const spur = new THREE.Mesh(spurGeo, legMat);
            spur.rotation.x = -Math.PI / 2;
            spur.position.set(0, 0, -0.06);
            footGroup.add(spur);

            leg.add(thigh, shank, footGroup);
            leg.position.set(xPos, 0, -0.05);
            return leg;
        };
        chickenGroup.add(createLeg(-0.2));
        chickenGroup.add(createLeg(0.2));

        // ظل ناعم واقعي أسفل الدجاجة
        const shadowGeo = new THREE.CircleGeometry(0.62, 24);
        const shadowMat = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.38,
            depthWrite: false
        });
        const fakeShadow = new THREE.Mesh(shadowGeo, shadowMat);
        fakeShadow.rotation.x = -Math.PI / 2;
        fakeShadow.position.y = 0.015;
        chickenGroup.add(fakeShadow);

        chickenGroup.scale.set(1.15, 1.15, 1.15);
        return chickenGroup;
    },

    // 2. صناعة عجلة سيارة واقعية مع جنوط ألمنيوم وأقراص فرامل
    createRealisticWheel(radius = 0.38, width = 0.28, isSport = false) {
        const wheel = new THREE.Group();

        // إطار مطاطي واقعي مع حواف مصبوبة
        const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 24);
        const tire = new THREE.Mesh(tireGeo, this.sharedMaterials.rubber);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        wheel.add(tire);

        // قرص الفرامل المعدني
        const discGeo = new THREE.CylinderGeometry(radius * 0.65, radius * 0.65, width * 0.4, 16);
        const disc = new THREE.Mesh(discGeo, this.sharedMaterials.brakeDisc);
        disc.rotation.z = Math.PI / 2;
        wheel.add(disc);

        // مكبس فرامل أحمر رياضي (Brembo Caliper)
        const calGeo = new THREE.BoxGeometry(width * 0.5, radius * 0.3, radius * 0.35);
        const caliper = new THREE.Mesh(calGeo, this.sharedMaterials.caliper);
        caliper.position.set(0, radius * 0.45, 0);
        wheel.add(caliper);

        // جنط ألمنيوم مع أذرع رياضية (Multi-spoke Rim)
        const rimOuterGeo = new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, width + 0.01, 20);
        const rimOuter = new THREE.Mesh(rimOuterGeo, this.sharedMaterials.chrome);
        rimOuter.rotation.z = Math.PI / 2;
        wheel.add(rimOuter);

        const spokeCount = isSport ? 7 : 5;
        for (let i = 0; i < spokeCount; i++) {
            const spokeGeo = new THREE.BoxGeometry(width + 0.02, radius * 0.62, 0.045);
            const spoke = new THREE.Mesh(spokeGeo, this.sharedMaterials.chrome);
            spoke.rotation.x = (i / spokeCount) * Math.PI;
            wheel.add(spoke);
        }

        return wheel;
    },

    // 3. سيدان فاخرة واقعية (Executive Luxury Sedan)
    createSedan(colorHex = 0x1e3a8a) {
        const car = new THREE.Group();
        const paintMat = new THREE.MeshStandardMaterial({
            color: colorHex,
            metalness: 0.85,
            roughness: 0.16
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x111827,
            metalness: 0.3,
            roughness: 0.6
        });

        // الهيكل الرئيسي السفلي المنحوت
        const bodyGeo = new THREE.BoxGeometry(1.65, 0.58, 3.8);
        const body = new THREE.Mesh(bodyGeo, paintMat);
        body.position.y = 0.52;
        body.castShadow = true;
        body.receiveShadow = true;
        car.add(body);

        // كابينة الركاب والزجاج الانسيابي
        const cabinGeo = new THREE.BoxGeometry(1.48, 0.52, 2.1);
        const cabin = new THREE.Mesh(cabinGeo, this.sharedMaterials.glass);
        cabin.position.set(0, 0.98, -0.2);
        car.add(cabin);

        // سقف السيارة المعدني
        const roofGeo = new THREE.BoxGeometry(1.46, 0.08, 1.7);
        const roof = new THREE.Mesh(roofGeo, paintMat);
        roof.position.set(0, 1.25, -0.3);
        roof.castShadow = true;
        car.add(roof);

        // شبك أمامي من الكروم اللامع (Chrome Grille)
        const grilleGeo = new THREE.BoxGeometry(1.1, 0.28, 0.08);
        const grille = new THREE.Mesh(grilleGeo, this.sharedMaterials.chrome);
        grille.position.set(0, 0.48, 1.92);
        car.add(grille);

        // مصابيح LED أمامية حديثة
        const hlGeo = new THREE.BoxGeometry(0.36, 0.14, 0.1);
        const hlL = new THREE.Mesh(hlGeo, this.sharedMaterials.headlightGlow);
        hlL.position.set(-0.58, 0.58, 1.9);
        const hlR = hlL.clone();
        hlR.position.x = 0.58;
        car.add(hlL, hlR);

        // مصابيح خلفية LED حمراء أنيقة
        const tlGeo = new THREE.BoxGeometry(0.42, 0.12, 0.08);
        const tlL = new THREE.Mesh(tlGeo, this.sharedMaterials.taillightGlow);
        tlL.position.set(-0.56, 0.62, -1.91);
        const tlR = tlL.clone();
        tlR.position.x = 0.56;
        car.add(tlL, tlR);

        // مرايا جانبية واقعية
        const mirrorGeo = new THREE.BoxGeometry(0.18, 0.1, 0.12);
        const mirL = new THREE.Mesh(mirrorGeo, paintMat);
        mirL.position.set(-0.84, 0.88, 0.45);
        const mirR = mirL.clone();
        mirR.position.x = 0.84;
        car.add(mirL, mirR);

        // 4 عجلات واقعية
        const wFL = this.createRealisticWheel(0.36, 0.26); wFL.position.set(-0.82, 0.36, 1.15);
        const wFR = this.createRealisticWheel(0.36, 0.26); wFR.position.set(0.82, 0.36, 1.15);
        const wRL = this.createRealisticWheel(0.36, 0.26); wRL.position.set(-0.82, 0.36, -1.15);
        const wRR = this.createRealisticWheel(0.36, 0.26); wRR.position.set(0.82, 0.36, -1.15);
        car.add(wFL, wFR, wRL, wRR);

        return car;
    },

    // 4. تاكسي واقعي عالي الدقة (Metro Taxi)
    createTaxi() {
        const car = this.createSedan(0xf59e0b); // طلاء أصفر ميتاليك

        // شعار التاكسي المضيء على السقف مع تفاصيل دقيقة
        const signBaseGeo = new THREE.BoxGeometry(0.65, 0.08, 0.32);
        const signBase = new THREE.Mesh(signBaseGeo, this.sharedMaterials.chrome);
        signBase.position.set(0, 1.32, -0.3);

        const signBoxGeo = new THREE.BoxGeometry(0.58, 0.22, 0.26);
        const signBoxMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const signBox = new THREE.Mesh(signBoxGeo, signBoxMat);
        signBox.position.set(0, 1.45, -0.3);

        // كتابة كلمة TAXI على الشعار
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(0, 0, 256, 128);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 72px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('TAXI', 128, 64);
        const tex = new THREE.CanvasTexture(canvas);
        const decalMat = new THREE.MeshBasicMaterial({ map: tex });
        const decalGeo = new THREE.PlaneGeometry(0.55, 0.2);
        const decalF = new THREE.Mesh(decalGeo, decalMat);
        decalF.position.set(0, 1.45, -0.16);
        car.add(signBase, signBox, decalF);

        // شريط رقعة الشطرنج على طول جانبي السيارة
        const checkerGeo = new THREE.BoxGeometry(1.68, 0.12, 2.6);
        const checkerMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.8 });
        const checker = new THREE.Mesh(checkerGeo, checkerMat);
        checker.position.set(0, 0.62, 0);
        car.add(checker);

        return car;
    },

    // 5. سيارة رياضية خارقة واقعية (Supercar GT)
    createSportsCar(colorHex = 0xdc2626) {
        const car = new THREE.Group();
        const paintMat = new THREE.MeshStandardMaterial({
            color: colorHex,
            metalness: 0.92,
            roughness: 0.12
        });
        const carbonMat = new THREE.MeshStandardMaterial({
            color: 0x18181b,
            metalness: 0.4,
            roughness: 0.4
        });

        // هيكل رياضي عريض ومنخفض جداً
        const baseGeo = new THREE.BoxGeometry(1.78, 0.42, 4.2);
        const base = new THREE.Mesh(baseGeo, paintMat);
        base.position.y = 0.38;
        base.castShadow = true;
        car.add(base);

        // كابينة زجاجية منحدرة ذات شكل انسيابي
        const cabinGeo = new THREE.BoxGeometry(1.35, 0.44, 1.9);
        const cabin = new THREE.Mesh(cabinGeo, this.sharedMaterials.glass);
        cabin.position.set(0, 0.72, -0.2);
        car.add(cabin);

        // مشتت هواء أمامي من ألياف الكربون (Front Splitter)
        const splitGeo = new THREE.BoxGeometry(1.82, 0.06, 0.4);
        const splitter = new THREE.Mesh(splitGeo, carbonMat);
        splitter.position.set(0, 0.2, 2.05);
        car.add(splitter);

        // جناح خلفي ديناميكي ضخم (Rear GT Spoiler)
        const wMountGeo = new THREE.BoxGeometry(0.08, 0.35, 0.15);
        const wML = new THREE.Mesh(wMountGeo, carbonMat); wML.position.set(-0.55, 0.75, -1.85);
        const wMR = new THREE.Mesh(wMountGeo, carbonMat); wMR.position.set(0.55, 0.75, -1.85);
        const wingBladeGeo = new THREE.BoxGeometry(1.78, 0.06, 0.35);
        const wingBlade = new THREE.Mesh(wingBladeGeo, carbonMat);
        wingBlade.position.set(0, 0.95, -1.88);
        car.add(wML, wMR, wingBlade);

        // عوادم رياضية مزدوجة من الكروم
        const exhaustGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.2, 12);
        const exL = new THREE.Mesh(exhaustGeo, this.sharedMaterials.chrome);
        exL.rotation.x = Math.PI / 2;
        exL.position.set(-0.35, 0.28, -2.12);
        const exR = exL.clone();
        exR.position.x = 0.35;
        car.add(exL, exR);

        // عجلات رياضية عريضة منخفضة الارتفاع
        const wFL = this.createRealisticWheel(0.34, 0.3, true); wFL.position.set(-0.9, 0.34, 1.25);
        const wFR = this.createRealisticWheel(0.34, 0.3, true); wFR.position.set(0.9, 0.34, 1.25);
        const wRL = this.createRealisticWheel(0.37, 0.35, true); wRL.position.set(-0.92, 0.37, -1.25);
        const wRR = this.createRealisticWheel(0.37, 0.35, true); wRR.position.set(0.92, 0.37, -1.25);
        car.add(wFL, wFR, wRL, wRR);

        return car;
    },

    // 6. شاحنة نقل بضائع واقعية (Heavy Cargo Hauler)
    createTruck(colorHex = 0x334155) {
        const truck = new THREE.Group();
        const cabMat = new THREE.MeshStandardMaterial({
            color: colorHex,
            metalness: 0.7,
            roughness: 0.25
        });
        const containerMat = new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            metalness: 0.2,
            roughness: 0.5
        });

        // كابينة السائق العملاقة
        const cabGeo = new THREE.BoxGeometry(1.85, 1.6, 1.7);
        const cab = new THREE.Mesh(cabGeo, cabMat);
        cab.position.set(0, 1.25, 1.8);
        cab.castShadow = true;
        truck.add(cab);

        // واجهة كابينة أمامية مع شبك عملاق
        const grilleGeo = new THREE.BoxGeometry(1.4, 0.8, 0.1);
        const grille = new THREE.Mesh(grilleGeo, this.sharedMaterials.chrome);
        grille.position.set(0, 0.85, 2.66);
        truck.add(grille);

        // مواسير عادم عمودية كلاسيكية من الكروم اللامع
        const pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.9, 12);
        const pL = new THREE.Mesh(pipeGeo, this.sharedMaterials.chrome); pL.position.set(-0.96, 1.6, 0.95);
        const pR = new THREE.Mesh(pipeGeo, this.sharedMaterials.chrome); pR.position.set(0.96, 1.6, 0.95);
        truck.add(pL, pR);

        // حاوية بضائع ضخمة مضلعة (Ribbed Container)
        const contGeo = new THREE.BoxGeometry(1.92, 1.95, 3.9);
        const container = new THREE.Mesh(contGeo, containerMat);
        container.position.set(0, 1.5, -0.9);
        container.castShadow = true;
        truck.add(container);

        // خزان وقود أسطواني من الكروم على الجانب
        const tankGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.4, 16);
        const tankL = new THREE.Mesh(tankGeo, this.sharedMaterials.chrome);
        tankL.rotation.z = Math.PI / 2;
        tankL.position.set(-0.95, 0.5, 0.2);
        const tankR = tankL.clone();
        tankR.position.x = 0.95;
        truck.add(tankL, tankR);

        // 6 عجلات ثقيلة
        const positions = [
            [-0.96, 0.44, 1.8],   [0.96, 0.44, 1.8],   // أمامية
            [-0.98, 0.44, -1.2],  [0.98, 0.44, -1.2],  // وسطى
            [-0.98, 0.44, -2.3],  [0.98, 0.44, -2.3]   // خلفية
        ];
        positions.forEach(pos => {
            const w = this.createRealisticWheel(0.44, 0.32);
            w.position.set(pos[0], pos[1], pos[2]);
            truck.add(w);
        });

        return truck;
    },

    // 7. حافلة ركاب عصرية واقعية (Transit Express Bus)
    createBus(colorHex = 0x2563eb) {
        const bus = new THREE.Group();
        const bodyMat = new THREE.MeshStandardMaterial({
            color: colorHex,
            metalness: 0.65,
            roughness: 0.22
        });
        const whiteMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.3
        });

        // الهيكل الرئيسي الانسيابي
        const bodyGeo = new THREE.BoxGeometry(1.92, 1.9, 6.4);
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 1.35;
        body.castShadow = true;
        bus.add(body);

        // شريط النوافذ البانورامية العريضة
        const winGeo = new THREE.BoxGeometry(1.96, 0.65, 5.4);
        const win = new THREE.Mesh(winGeo, this.sharedMaterials.glass);
        win.position.set(0, 1.55, -0.2);
        bus.add(win);

        // زجاج أمامي مقوس
        const fWinGeo = new THREE.BoxGeometry(1.75, 0.9, 0.12);
        const fWin = new THREE.Mesh(fWinGeo, this.sharedMaterials.glass);
        fWin.position.set(0, 1.45, 3.21);
        bus.add(fWin);

        // شاشة الوجهة الرقمية LED أعلى الزجاج الأمامي
        const destGeo = new THREE.BoxGeometry(1.3, 0.2, 0.08);
        const destMat = new THREE.MeshBasicMaterial({ color: 0xffa500 });
        const dest = new THREE.Mesh(destGeo, destMat);
        dest.position.set(0, 2.05, 3.22);
        bus.add(dest);

        // وحدات تكييف الهواء على السقف
        const acGeo = new THREE.BoxGeometry(1.1, 0.2, 2.0);
        const ac = new THREE.Mesh(acGeo, whiteMat);
        ac.position.set(0, 2.38, 0);
        bus.add(ac);

        // عجلات الحافلة
        const positions = [
            [-0.98, 0.44, 2.1],   [0.98, 0.44, 2.1],
            [-0.98, 0.44, -1.8],  [0.98, 0.44, -1.8],
            [-0.98, 0.44, -2.8],  [0.98, 0.44, -2.8]
        ];
        positions.forEach(pos => {
            const w = this.createRealisticWheel(0.44, 0.32);
            w.position.set(pos[0], pos[1], pos[2]);
            bus.add(w);
        });

        return bus;
    },

    // 8. أشجار واقعية بظلال متعددة الطبقات
    createTree() {
        const tree = new THREE.Group();
        const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 1.4, 8);
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a2e18, roughness: 0.9 });
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = 0.7;
        trunk.castShadow = true;
        tree.add(trunk);

        // طبقات أوراق شجر غنية (Multi-tier Foliage)
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.65 });
        [
            { r: 0.95, y: 1.8, s: 1.0 },
            { r: 0.78, y: 2.4, s: 0.85 },
            { r: 0.55, y: 2.9, s: 0.7 }
        ].forEach(layer => {
            const leavesGeo = new THREE.DodecahedronGeometry(layer.r, 1);
            const leaves = new THREE.Mesh(leavesGeo, leafMat);
            leaves.position.y = layer.y;
            leaves.castShadow = true;
            tree.add(leaves);
        });

        return tree;
    },

    // 9. عمود إنارة طريق سريع واقعي (Highway Light Mast)
    createStreetLight() {
        const lamp = new THREE.Group();
        const mastMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.7, roughness: 0.3 });
        const ledGlowMat = new THREE.MeshBasicMaterial({ color: 0xfffaed });

        const poleGeo = new THREE.CylinderGeometry(0.1, 0.16, 4.2, 10);
        const pole = new THREE.Mesh(poleGeo, mastMat);
        pole.position.y = 2.1;
        pole.castShadow = true;
        lamp.add(pole);

        const armGeo = new THREE.BoxGeometry(1.2, 0.09, 0.09);
        const arm = new THREE.Mesh(armGeo, mastMat);
        arm.position.set(0.55, 4.15, 0);
        lamp.add(arm);

        const lumGeo = new THREE.BoxGeometry(0.45, 0.1, 0.25);
        const lum = new THREE.Mesh(lumGeo, ledGlowMat);
        lum.position.set(1.05, 4.08, 0);
        lamp.add(lum);

        return lamp;
    },

    // 10. ناطحة سحاب للمدينة في الخلفية (City Skyscraper)
    createSkyscraper(width, height, depth, colorHex) {
        const building = new THREE.Group();
        const wallMat = new THREE.MeshStandardMaterial({
            color: colorHex || 0x1e293b,
            roughness: 0.4,
            metalness: 0.6
        });
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x38bdf8,
            roughness: 0.1,
            metalness: 0.8
        });

        const mainGeo = new THREE.BoxGeometry(width, height, depth);
        const main = new THREE.Mesh(mainGeo, wallMat);
        main.position.y = height / 2;
        building.add(main);

        // خطوط النوافذ الزجاجية المضيئة
        const rows = Math.floor(height / 4);
        for (let r = 1; r < rows; r++) {
            const winBandGeo = new THREE.BoxGeometry(width + 0.1, 1.2, depth + 0.1);
            const winBand = new THREE.Mesh(winBandGeo, glassMat);
            winBand.position.y = r * 4;
            building.add(winBand);
        }

        return building;
    },

    // بناء مركبة بحسب النوع
    buildVehicle(type, customColor = null) {
        switch (type) {
            case "taxi":
                return this.createTaxi();
            case "sports":
                return this.createSportsCar(customColor);
            case "truck":
                return this.createTruck(customColor);
            case "bus":
                return this.createBus(customColor);
            case "sedan":
            default:
                return this.createSedan(customColor);
        }
    }
};
