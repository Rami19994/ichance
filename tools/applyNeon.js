'use strict';

/**
 * يكتب تصميم نيون فيغاس في مكانيه: محرّك الخادم وصفحة اللعبة.
 *
 * الأشرطة مكرّرة في الموضعين بالضرورة: الخادم يقرّر مواضع التوقّف، والمتصفّح
 * يرسم الشريط الذي يتوقّف عليه. لو اختلفا لعرضت الشاشة رموزاً غير التي
 * حُسب عليها الربح — أسوأ خلل ممكن في لعبة نقود. لذلك يُكتب الاثنان من
 * هذا الملف وحده، ويفحص المتصفّح تطابقهما عند الإقلاع.
 */

const fs = require('fs');
const path = require('path');
const final = require('./finalNeon');

const ROOT = path.join(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'server', 'neonSlots.js');
const PAGE_FILE = path.join(ROOT, 'public', 'neon-slots.html');

const strips = final.STRIPS;
const symbols = final.symbols;

// ─────────────────────────────────────────── 1) الخادم
let srv = fs.readFileSync(SERVER_FILE, 'utf8');

const symbolLines = symbols.map((s) => {
  const flags = `scatter: ${!!s.scatter}, wild: ${!!s.wild}`;
  const pays = Object.keys(s.pays).length
    ? `pays: { ${Object.entries(s.pays).map(([k, v]) => `${k}: ${v}`).join(', ')} }`
    : 'pays: {}';
  return `  { id: ${s.id}, key: '${s.key}', filename: '${s.filename}', ${flags}, ${pays} }`;
}).join(',\n');

const newSymbols = 'const SYMBOLS = [\n' + symbolLines + '\n];';
srv = srv.replace(/const SYMBOLS = \[[\s\S]*?\n\];/, newSymbols);

const newStrips = 'const REEL_STRIPS = [\n'
  + strips.map((s) => '  [' + s.join(', ') + ']').join(',\n') + '\n];';
srv = srv.replace(/const REEL_STRIPS = \[[\s\S]*?\n\];/, newStrips);

fs.writeFileSync(SERVER_FILE, srv, 'utf8');
console.log('✔ server/neonSlots.js');

// ─────────────────────────────────────────── 2) الصفحة
let page = fs.readFileSync(PAGE_FILE, 'utf8');

const clientSymbols = symbols.map((s) => {
  const p = s.pays;
  return '        { filename: ' + JSON.stringify(s.filename).padEnd(16)
    + ', scatter: ' + String(!!s.scatter).padEnd(5)
    + ', wild: ' + String(!!s.wild).padEnd(5)
    + ', w1: 0, w2: ' + String(p[2] || 0).padStart(3)
    + ', w3: ' + String(p[3] || 0).padStart(4)
    + ', w4: ' + String(p[4] || 0).padStart(4)
    + ', w5: ' + String(p[5] || 0).padStart(4) + ' }';
}).join(',\n');

const clientReels = strips.map((s) => '        [' + s.join(', ') + ']').join(',\n');

const block =
  '      // ⚠ الأشرطة والجدول نسخة طبق الأصل عمّا في server/neonSlots.js.\n'
  + '      // الخادم يقرّر مواضع التوقّف وهذه الصفحة ترسمها — فلو اختلفا لعُرضت\n'
  + '      // رموز غير التي حُسب عليها الربح. يولّدهما tools/applyNeon.js معاً،\n'
  + '      // ويفحص السكربت أدناه تطابقهما مع الخادم عند الإقلاع.\n'
  + '      symbols: [\n' + clientSymbols + '\n      ],\n'
  + '      reels: [\n' + clientReels + '\n      ]';

// نستبدل كتلة reels الحالية (وsymbols إن وُجدت) بالكتلة الجديدة
const re = /(\n\s*)(?:\/\/[^\n]*\n\s*)*symbols: \[[\s\S]*?\n\s*\],\n\s*reels: \[[\s\S]*?\n\s*\]|(\n\s*)reels: \[[\s\S]*?\n\s*\]/;
if (!re.test(page)) throw new Error('لم يُعثر على كتلة reels في الصفحة');
page = page.replace(re, '\n' + block);

fs.writeFileSync(PAGE_FILE, page, 'utf8');
console.log('✔ public/neon-slots.html');

console.log('\nالعائد المثبّت: ' + (final.exact.rtp * 100).toFixed(3) + '%');
