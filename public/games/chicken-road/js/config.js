/**
 * CHICKEN ROAD — LuckyArena
 * إعدادات العالم ثلاثي الأبعاد فقط. المال والنتائج في الخادم
 * (server/chickenGame.js): الرصيد رصيد المحفظة، وكل خطوة يقرّرها الخادم،
 * والمضاعفات تأتي منه حسب الصعوبة. لا عملات افتراضية ولا احتمالات هنا.
 */

const CONFIG = {
    gameTitle: "CHICKEN ROAD",

    // الخيارات السريعة للرهان (الحدود الفعلية من الخادم)
    quickBets: [500, 1000, 5000, 10000, 25000, 100000],
    defaultBet: 1000,
    minBet: 100,
    maxBet: 500000,

    // 12 مساراً؛ المضاعفات تُملأ من الخادم حسب الصعوبة (setLadder)
    stages: Array.from({ length: 12 }, (_, i) => ({ lane: i + 1, multiplier: 1, label: `الخانة ${i + 1}` })),

    defaultDifficulty: "normal",

    // توقيت قفزة الدجاجة الواقعية
    hopDuration: 620, // بالمللي ثانية

    // أبعاد العالم الواقعي
    world: {
        laneWidth: 4.2,      // عرض المسار الواقعي
        roadSpanX: 42,       // الامتداد العرضي للشارع
        curbWidth: 6.0,      // رصيف واسع وواقعي
        trafficBoundX: 28,   // حدود حركة المرور
    },

    // إعدادات المركبات الواقعية (ألوان معدنية ميتاليك وأشكال دقيقة)
    vehicles: [
        {
            type: "sedan",
            name: "سيدان فاخرة",
            nameEn: "Executive Sedan",
            length: 2.8,
            width: 1.5,
            height: 1.15,
            speedMin: 9,
            speedMax: 13,
            colors: [0x1f2937, 0x1e3a8a, 0x065f46, 0x374151, 0x991b1b, 0xe2e8f0],
            metalness: 0.85,
            roughness: 0.18,
            weight: 35
        },
        {
            type: "taxi",
            name: "تاكسي المدينة",
            nameEn: "Metro Taxi",
            length: 2.8,
            width: 1.5,
            height: 1.25,
            speedMin: 12,
            speedMax: 16,
            colors: [0xf59e0b],
            metalness: 0.65,
            roughness: 0.25,
            weight: 25
        },
        {
            type: "sports",
            name: "سيارة خارقة GT",
            nameEn: "Supercar GT",
            length: 3.1,
            width: 1.6,
            height: 0.95,
            speedMin: 17,
            speedMax: 24,
            colors: [0xdc2626, 0x0284c7, 0x7c3aed, 0x0f172a],
            metalness: 0.9,
            roughness: 0.12,
            weight: 15
        },
        {
            type: "truck",
            name: "شاحنة نقل عملاقة",
            nameEn: "Heavy Hauler",
            length: 5.4,
            width: 1.85,
            height: 2.1,
            speedMin: 7,
            speedMax: 10,
            colors: [0x475569, 0x0f766e, 0x9a3412],
            metalness: 0.5,
            roughness: 0.4,
            weight: 15
        },
        {
            type: "bus",
            name: "حافلة ركاب عصرية",
            nameEn: "Transit Express",
            length: 6.2,
            width: 1.9,
            height: 2.2,
            speedMin: 8,
            speedMax: 11,
            colors: [0x2563eb, 0xb91c1c],
            metalness: 0.6,
            roughness: 0.3,
            weight: 10
        }
    ]
};

/** يضع مضاعفات الصعوبة المختارة (من الخادم) في المسارات الـ 12. */
function setLadder(ladder) {
    CONFIG.stages.forEach((st, i) => { st.multiplier = Number(ladder[i]) || 1; });
}
