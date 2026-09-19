/* ==========================================================================
   iCHANCE — رسومات لعبة "صيّاد الجوائز"
   كل الرسوم هنا أصلية ومرسومة بـ SVG، لا صور خارجية ولا أصول منسوخة.
   ========================================================================== */
'use strict';

/** ألوان لوحات الحروف — كل حرف بلونه كما في ألعاب الغرب الكلاسيكية. */
const LETTER_STYLE = {
  J: { plate: '#2f6f9e', edge: '#1b4a6b', ink: '#dff1ff' },
  Q: { plate: '#3e8f5a', edge: '#215c38', ink: '#e4ffe9' },
  K: { plate: '#b8402f', edge: '#7d2618', ink: '#ffe3d8' },
  A: { plate: '#c9952a', edge: '#8a6014', ink: '#fff6d8' }
};

/** لوحة خشبية للحروف J Q K A */
function letterSymbol(ch) {
  const s = LETTER_STYLE[ch];
  return `
  <svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
    <defs>
      <linearGradient id="lg${ch}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${s.plate}"/>
        <stop offset="1" stop-color="${s.edge}"/>
      </linearGradient>
    </defs>
    <rect x="16" y="10" width="68" height="80" rx="9" fill="url(#lg${ch})"
          stroke="rgba(0,0,0,.45)" stroke-width="2.5"/>
    <rect x="22" y="16" width="56" height="68" rx="6" fill="none"
          stroke="rgba(255,255,255,.22)" stroke-width="2"/>
    <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
          font-family="Georgia, 'Times New Roman', serif" font-size="52" font-weight="700"
          fill="${s.ink}" stroke="rgba(0,0,0,.35)" stroke-width="1.2">${ch}</text>
  </svg>`;
}

/** قنينة ويسكي */
const BOTTLE_SVG = `
<svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
  <defs>
    <linearGradient id="whis" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d98f2b"/><stop offset="1" stop-color="#8a4a08"/>
    </linearGradient>
  </defs>
  <path d="M42 12h16v13c0 4 10 10 10 19v40a6 6 0 0 1-6 6H38a6 6 0 0 1-6-6V44c0-9 10-15 10-19z"
        fill="rgba(215,230,240,.28)" stroke="#9fb6c4" stroke-width="2.5"/>
  <path d="M34 52h32v30a4 4 0 0 1-4 4H38a4 4 0 0 1-4-4z" fill="url(#whis)"/>
  <rect x="40" y="7" width="20" height="9" rx="2.5" fill="#5a3410" stroke="#2f1a06" stroke-width="1.6"/>
  <rect x="36" y="58" width="28" height="17" rx="2" fill="#f0e2c0" stroke="#b09a6a" stroke-width="1.4"/>
  <text x="50" y="67" text-anchor="middle" font-family="Georgia, serif" font-size="11"
        font-weight="700" fill="#6b3b12">XXX</text>
  <ellipse cx="44" cy="46" rx="3.5" ry="9" fill="rgba(255,255,255,.35)"/>
</svg>`;

/** قبعة الشريف */
const HAT_SVG = `
<svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
  <defs>
    <linearGradient id="hatg2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c065d8"/><stop offset="1" stop-color="#5e2170"/>
    </linearGradient>
  </defs>
  <ellipse cx="50" cy="70" rx="44" ry="13" fill="url(#hatg2)" stroke="#3d1049" stroke-width="2.5"/>
  <path d="M28 68c0-22 4-34 22-34s22 12 22 34c-6 4-38 4-44 0z" fill="url(#hatg2)"
        stroke="#3d1049" stroke-width="2.5"/>
  <path d="M38 40c6-5 18-5 24 0" fill="none" stroke="#3d1049" stroke-width="2.5"/>
  <rect x="26" y="58" width="48" height="9" rx="3" fill="#2b0d36"/>
  <circle cx="50" cy="62.5" r="4.5" fill="#f7c948" stroke="#8a6014" stroke-width="1.4"/>
</svg>`;

/** المسدس */
const GUN_SVG = `
<svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
  <defs>
    <linearGradient id="steel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e3ecf4"/><stop offset="1" stop-color="#7f929f"/>
    </linearGradient>
  </defs>
  <path d="M12 38h62v13H50l-2 6H18a6 6 0 0 1-6-6z" fill="url(#steel)" stroke="#42535e" stroke-width="2.4"/>
  <rect x="66" y="34" width="22" height="9" rx="3" fill="url(#steel)" stroke="#42535e" stroke-width="2.4"/>
  <circle cx="32" cy="45" r="12" fill="url(#steel)" stroke="#42535e" stroke-width="2.4"/>
  <circle cx="32" cy="45" r="4.5" fill="#42535e"/>
  <circle cx="32" cy="37" r="2" fill="#42535e"/><circle cx="39" cy="45" r="2" fill="#42535e"/>
  <circle cx="32" cy="53" r="2" fill="#42535e"/><circle cx="25" cy="45" r="2" fill="#42535e"/>
  <path d="M24 57c-2 12-6 18-12 26l16 4c6-12 8-20 8-30z" fill="#8a5a20" stroke="#4d3110" stroke-width="2.4"/>
  <path d="M40 56c0 6-3 10-8 11" fill="none" stroke="#42535e" stroke-width="2.6"/>
</svg>`;

/** الخارج عن القانون */
const OUTLAW_SVG = `
<svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
  <defs>
    <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e8b98c"/><stop offset="1" stop-color="#c08f61"/>
    </linearGradient>
  </defs>
  <ellipse cx="50" cy="30" rx="40" ry="11" fill="#6b3a15" stroke="#3a1e07" stroke-width="2.4"/>
  <path d="M30 28c0-16 3-22 20-22s20 6 20 22c-6 3-34 3-40 0z" fill="#7d4419"
        stroke="#3a1e07" stroke-width="2.4"/>
  <rect x="28" y="20" width="44" height="7" rx="2.5" fill="#40210a"/>
  <path d="M28 36h44v22c0 13-9 22-22 22S28 71 28 58z" fill="url(#skin)" stroke="#8a5f38" stroke-width="2"/>
  <path d="M30 56h40c0 14-8 24-20 24S30 70 30 56z" fill="#c2313a" stroke="#7d151d" stroke-width="2.2"/>
  <path d="M30 56h40" stroke="#7d151d" stroke-width="2.2"/>
  <ellipse cx="40" cy="47" rx="5.5" ry="4" fill="#fff"/>
  <ellipse cx="60" cy="47" rx="5.5" ry="4" fill="#fff"/>
  <circle cx="41" cy="47.5" r="2.6" fill="#2b1a0c"/>
  <circle cx="59" cy="47.5" r="2.6" fill="#2b1a0c"/>
  <path d="M33 41c3-2 8-2 11 0M56 41c3-2 8-2 11 0" fill="none" stroke="#3a1e07" stroke-width="2.4"/>
</svg>`;

/** وايلد — إطار ذهبي */
const WILD_SVG = `
<svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
  <defs>
    <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff3cd"/><stop offset="45%" stop-color="#f7c948"/>
      <stop offset="1" stop-color="#b9820a"/>
    </linearGradient>
  </defs>
  <rect x="8" y="12" width="84" height="76" rx="10" fill="url(#wg)" stroke="#7a5406" stroke-width="3"/>
  <rect x="15" y="19" width="70" height="62" rx="6" fill="#3a1f05" stroke="rgba(255,255,255,.35)" stroke-width="1.6"/>
  <path d="M50 26l6.5 13.5L71 41.5 60.5 52l2.6 15L50 59.8 36.9 67l2.6-15L29 41.5l14.5-2z"
        fill="url(#wg)" stroke="#7a5406" stroke-width="1.6"/>
  <text x="50" y="76" text-anchor="middle" font-family="Georgia, serif" font-size="14"
        font-weight="700" fill="#f7c948" letter-spacing="2">WILD</text>
</svg>`;

/** سبائك الذهب — سكاتر */
const SCATTER_SVG = `
<svg viewBox="0 0 100 100" class="sym-svg" aria-hidden="true">
  <defs>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff0b8"/><stop offset="50%" stop-color="#f5c542"/>
      <stop offset="1" stop-color="#c58c0b"/>
    </linearGradient>
  </defs>
  <g stroke="#7a5406" stroke-width="2.2" fill="url(#bar)">
    <path d="M18 74h30l5-13H23z"/>
    <path d="M52 74h30l-5-13H57z"/>
    <path d="M35 58h30l5-13H40z"/>
  </g>
  <path d="M50 12l3.4 7 7.6 1-5.5 5.4 1.3 7.6L50 29.4 43.2 33l1.3-7.6L39 20l7.6-1z"
        fill="#fff3cd" opacity=".9"/>
</svg>`;

const SYMBOL_ART = {
  J: letterSymbol('J'),
  Q: letterSymbol('Q'),
  K: letterSymbol('K'),
  A: letterSymbol('A'),
  BOTTLE: BOTTLE_SVG,
  HAT: HAT_SVG,
  GUN: GUN_SVG,
  OUTLAW: OUTLAW_SVG,
  WILD: WILD_SVG,
  SCATTER: SCATTER_SVG
};

/** طبقة الخلفية: سماء الغرب وتلال وصبّار — مرسومة لا مستوردة. */
const BACKDROP_SVG = `
<svg viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid slice" class="backdrop-svg" aria-hidden="true">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a3d57"/><stop offset="45%" stop-color="#7d6a52"/>
      <stop offset="100%" stop-color="#c2955c"/>
    </linearGradient>
    <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6b4a2c"/><stop offset="1" stop-color="#432d19"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="700" fill="url(#sky)"/>
  <circle cx="930" cy="180" r="78" fill="#f0c56a" opacity=".45"/>
  <path d="M0 430l150-90 120 60 130-110 160 120 140-70 180 100 120-50 200 90v150H0z" fill="url(#hill)" opacity=".75"/>
  <path d="M0 520l180-70 200 60 190-80 210 90 240-60 180 70v170H0z" fill="#3b2715" opacity=".9"/>
  <g fill="#2c4a2a" opacity=".55">
    <rect x="120" y="470" width="16" height="90" rx="8"/>
    <rect x="96" y="500" width="14" height="40" rx="7"/><rect x="96" y="500" width="40" height="13" rx="6"/>
    <rect x="146" y="490" width="14" height="50" rx="7"/><rect x="128" y="490" width="32" height="13" rx="6"/>
    <rect x="1040" y="480" width="16" height="90" rx="8"/>
    <rect x="1016" y="510" width="14" height="40" rx="7"/><rect x="1016" y="510" width="40" height="13" rx="6"/>
  </g>
</svg>`;
