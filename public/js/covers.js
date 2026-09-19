/* ==========================================================================
   iCHANCE — أغلفة الألعاب
   --------------------------------------------------------------------------
   رسوم SVG أصلية مكتوبة هنا، لا صور ولا أصول خارجية:
   لا تحميل ولا اعتماد على سيرفر غيرنا، وتبقى حادّة على أي دقّة شاشة.
   كل غلاف مبني على الشكل الذي تلعبه فعلاً في اللعبة — لا زينة عامة.
   ========================================================================== */
'use strict';

/** تدرّجات مشتركة: نعرّفها مرة لكل غلاف بمعرّف فريد كي لا تتضارب. */
function defs(id, stops, extra = '') {
  return `<defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>
    ${extra}
  </defs>`;
}

/* ─────────────────────────── كروت الحظ ─────────────────────────── */
function cardsCover() {
  const card = (x, y, rot, face, tone) => `
    <g transform="translate(${x} ${y}) rotate(${rot})">
      <rect x="-27" y="-38" width="54" height="76" rx="7"
            fill="${tone}" stroke="rgba(255,231,168,.55)" stroke-width="2"/>
      <rect x="-21" y="-32" width="42" height="64" rx="4"
            fill="none" stroke="rgba(255,231,168,.25)" stroke-width="1.5"/>
      ${face}
    </g>`;

  return `
<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  ${defs('cardsBg',
    '<stop offset="0" stop-color="#123028"/><stop offset="1" stop-color="#050d0a"/>',
    `<radialGradient id="cardsGlow" cx="50%" cy="42%" r="58%">
       <stop offset="0" stop-color="#f7c948" stop-opacity=".30"/>
       <stop offset="1" stop-color="#f7c948" stop-opacity="0"/>
     </radialGradient>`)}
  <rect width="400" height="250" fill="url(#cardsBg)"/>
  <rect width="400" height="250" fill="url(#cardsGlow)"/>

  <!-- نسيج الطاولة -->
  <g opacity=".14" stroke="#7ce0b0" stroke-width="1">
    ${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${i * 30}" x2="400" y2="${i * 30 - 60}"/>`).join('')}
  </g>

  <!-- ثلاثة كروت: اثنان مقلوبان وواحد كاشف عن مضاعف -->
  ${card(130, 140, -16, `
    <text x="0" y="12" text-anchor="middle" font-size="34" font-weight="900"
          fill="rgba(255,231,168,.85)" font-family="Tajawal,sans-serif">؟</text>`, '#1b4a3c')}
  ${card(270, 140, 16, `
    <text x="0" y="12" text-anchor="middle" font-size="34" font-weight="900"
          fill="rgba(255,231,168,.85)" font-family="Tajawal,sans-serif">؟</text>`, '#1b4a3c')}
  ${card(200, 122, 0, `
    <text x="0" y="10" text-anchor="middle" font-size="28" font-weight="900"
          fill="#0f1a14" font-family="Tajawal,sans-serif"
          style="direction:ltr">×5</text>`, '#f7c948')}

  <!-- بريق -->
  <g fill="#ffe7a8">
    <circle cx="96"  cy="64"  r="3" opacity=".9"/>
    <circle cx="318" cy="82"  r="2.4" opacity=".7"/>
    <circle cx="352" cy="176" r="3.2" opacity=".55"/>
    <circle cx="62"  cy="182" r="2.2" opacity=".6"/>
  </g>
</svg>`;
}

/* ─────────────────────────── صيّاد الجوائز ─────────────────────────── */
function slotCover() {
  const coin = (x, y, r) => `
    <g transform="translate(${x} ${y})">
      <ellipse cx="0" cy="0" rx="${r}" ry="${r * 0.82}" fill="#d99a0b"/>
      <ellipse cx="0" cy="-1.5" rx="${r * 0.78}" ry="${r * 0.62}" fill="#ffd873"/>
    </g>`;

  return `
<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  ${defs('slotSky',
    '<stop offset="0" stop-color="#3a1d08"/><stop offset=".55" stop-color="#8a4a12"/><stop offset="1" stop-color="#1a0d04"/>',
    `<radialGradient id="sun" cx="50%" cy="50%" r="50%">
       <stop offset="0" stop-color="#ffd873"/><stop offset="1" stop-color="#e8890f"/>
     </radialGradient>`)}
  <rect width="400" height="250" fill="url(#slotSky)"/>

  <!-- الشمس -->
  <circle cx="200" cy="112" r="56" fill="url(#sun)" opacity=".92"/>
  <g stroke="#2a1405" stroke-width="5" opacity=".45">
    <line x1="144" y1="100" x2="256" y2="100"/>
    <line x1="144" y1="118" x2="256" y2="118"/>
    <line x1="150" y1="136" x2="250" y2="136"/>
  </g>

  <!-- هضاب -->
  <path d="M0 250 L0 186 L38 186 L38 160 L86 160 L86 186 L150 186 L150 250 Z" fill="#201004"/>
  <path d="M250 250 L250 172 L300 172 L300 148 L344 148 L344 172 L400 172 L400 250 Z" fill="#201004"/>
  <path d="M0 250 L400 250 L400 208 Q200 186 0 208 Z" fill="#160a02"/>

  <!-- صبّار -->
  <g fill="#1d4a2a">
    <rect x="86" y="176" width="13" height="46" rx="6"/>
    <rect x="72" y="190" width="11" height="9" rx="4"/>
    <rect x="72" y="190" width="9" height="24" rx="4"/>
    <rect x="102" y="182" width="11" height="9" rx="4"/>
    <rect x="104" y="182" width="9" height="28" rx="4"/>
  </g>

  <!-- نجمة الشريف -->
  <g transform="translate(316 92)">
    <path d="M0,-26 L7,-8 L26,-8 L11,3 L17,21 L0,10 L-17,21 L-11,3 L-26,-8 L-7,-8 Z"
          fill="#f7c948" stroke="#8a5a10" stroke-width="2"/>
    <circle cx="0" cy="-2" r="5" fill="#3a2405"/>
  </g>

  <!-- عملات -->
  ${coin(96, 224, 16)}
  ${coin(128, 232, 12)}
  ${coin(70, 236, 10)}
</svg>`;
}

/* ─────────────────────────── معركة الدبابات ─────────────────────────── */
function tankCover() {
  return `
<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  ${defs('tankBg',
    '<stop offset="0" stop-color="#16202c"/><stop offset="1" stop-color="#070c12"/>',
    `<radialGradient id="blast" cx="50%" cy="50%" r="50%">
       <stop offset="0" stop-color="#fff3c4"/>
       <stop offset=".4" stop-color="#ff9a3c" stop-opacity=".85"/>
       <stop offset="1" stop-color="#ff5b3c" stop-opacity="0"/>
     </radialGradient>`)}
  <rect width="400" height="250" fill="url(#tankBg)"/>

  <!-- شبكة الساحة -->
  <g stroke="#2a3a4d" stroke-width="1" opacity=".55">
    ${Array.from({ length: 13 }, (_, i) => `<line x1="${i * 32}" y1="0" x2="${i * 32}" y2="250"/>`).join('')}
    ${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${i * 32}" x2="400" y2="${i * 32}"/>`).join('')}
  </g>

  <!-- جدران طوب -->
  <g fill="#8a3f1f">
    <rect x="64"  y="64"  width="32" height="32"/>
    <rect x="96"  y="64"  width="32" height="32"/>
    <rect x="288" y="128" width="32" height="32"/>
  </g>
  <g fill="#b5552b">
    <rect x="66" y="66" width="28" height="12"/><rect x="66" y="82" width="28" height="12"/>
    <rect x="98" y="66" width="28" height="12"/><rect x="98" y="82" width="28" height="12"/>
    <rect x="290" y="130" width="28" height="12"/><rect x="290" y="146" width="28" height="12"/>
  </g>

  <!-- انفجار -->
  <circle cx="300" cy="86" r="46" fill="url(#blast)"/>

  <!-- أثر الطلقة -->
  <g stroke="#ffd166" stroke-width="3" stroke-linecap="round" opacity=".85">
    <line x1="196" y1="150" x2="238" y2="122"/>
    <line x1="248" y1="115" x2="262" y2="106"/>
  </g>

  <!-- الدبابة: نفس تصميم اللعبة (جنزير + هيكل + برج + سبطانة) -->
  <g transform="translate(140 172) rotate(-32)">
    <rect x="-34" y="-26" width="16" height="52" rx="4" fill="#1c3a2c"/>
    <rect x="18"  y="-26" width="16" height="52" rx="4" fill="#1c3a2c"/>
    <g fill="#2f5f47">
      <rect x="-32" y="-20" width="12" height="4"/><rect x="-32" y="-6" width="12" height="4"/>
      <rect x="-32" y="8"   width="12" height="4"/>
      <rect x="20"  y="-20" width="12" height="4"/><rect x="20"  y="-6" width="12" height="4"/>
      <rect x="20"  y="8"   width="12" height="4"/>
    </g>
    <rect x="-20" y="-24" width="40" height="50" rx="5" fill="#1f9d63"/>
    <rect x="-15" y="-19" width="13" height="40" rx="3" fill="#39c884"/>
    <circle cx="0" cy="2" r="15" fill="#2bbd7c"/>
    <rect x="-4" y="-44" width="8" height="30" rx="2" fill="#d6f5e6"/>
  </g>
</svg>`;
}

/* ───────────────────── غلاف عام للألعاب القادمة ───────────────────── */
function soonCover(seedText, tone) {
  // نمط هندسي مشتقّ من اسم اللعبة: كل بطاقة مختلفة بلا رسم يدوي لكل واحدة
  let h = 0;
  for (let i = 0; i < seedText.length; i++) h = (h * 31 + seedText.charCodeAt(i)) >>> 0;
  const id = `soon${h.toString(36)}`;
  const shapes = Array.from({ length: 7 }, (_, i) => {
    // إزاحة بلا إشارة (>>>): الإزاحة العادية تُنتج أعداداً سالبة فيصير
    // نصف القطر سالباً ويرفضه SVG
    const x = 40 + ((h >>> (i % 12)) % 320);
    const y = 30 + ((h >>> ((i * 2 + 5) % 20)) % 190);
    const r = 12 + ((h >>> ((i + 3) % 16)) % 26);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${0.04 + (i % 3) * 0.02}"/>`;
  }).join('');

  return `
<svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  ${defs(id, `<stop offset="0" stop-color="${tone[0]}"/><stop offset="1" stop-color="${tone[1]}"/>`)}
  <rect width="400" height="250" fill="url(#${id})"/>
  ${shapes}
  <g stroke="#fff" stroke-width="1" opacity=".06">
    ${Array.from({ length: 10 }, (_, i) => `<line x1="${i * 44}" y1="0" x2="${i * 44 - 70}" y2="250"/>`).join('')}
  </g>
</svg>`;
}

const COVERS = {
  'lucky-cards': cardsCover,
  bounty: slotCover,
  tank: tankCover
};

/** غلاف اللعبة — المرسوم خصيصاً إن وُجد، وإلا نمط مولَّد. */
function coverFor(game) {
  if (COVERS[game.id]) return COVERS[game.id]();
  return soonCover(game.id, game.tone || ['#243044', '#0c121b']);
}

window.Covers = { coverFor };
