'use strict';

const crypto = require('crypto');
const { TEMPLATES, CARD_COUNT } = require('./config');

/**
 * نظام "قابل للإثبات" (Provably Fair)
 * ------------------------------------
 * 1) قبل بداية الجولة يولّد الخادم بذرة عشوائية (serverSeed) وينشر بصمتها SHA-256 فقط.
 * 2) توزيع الكروت يُشتق حسابياً من البذرة — الخادم لا يستطيع تغييره بعد نشر البصمة.
 * 3) بعد انتهاء الجولة تُنشر البذرة، فيستطيع أي لاعب إعادة الحساب والتأكد.
 *
 * ⚠️ الخوارزمية هنا مطابقة حرفياً لنسخة المتصفح في public/js/fair.js
 *    أي تعديل هنا يجب أن ينعكس هناك، وإلا فشل تحقق اللاعبين.
 */

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function newServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/** مولّد أعداد شبه عشوائية حتمي مبني على SHA-256 بعدّاد. */
function createStream(seedHex) {
  let block = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;
  return function nextU32() {
    if (offset + 4 > block.length) {
      block = crypto.createHash('sha256').update(`${seedHex}:${counter}`, 'utf8').digest();
      counter += 1;
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  };
}

const U32 = 4294967296; // 2^32

/**
 * يشتق لوحة الجولة من البذرة.
 * الترتيب مهم: نختار النمط أولاً ثم نخلط الكروت.
 */
function deriveBoard(serverSeed, roundId) {
  const next = createStream(`${serverSeed}:${roundId}`);

  // 1) اختيار النمط بالوزن
  const totalWeight = TEMPLATES.reduce((a, t) => a + t.weight, 0);
  let ticket = (next() / U32) * totalWeight;
  let template = TEMPLATES[TEMPLATES.length - 1];
  for (const t of TEMPLATES) {
    ticket -= t.weight;
    if (ticket < 0) { template = t; break; }
  }

  // 2) خلط فيشر-ييتس
  const cards = template.cards.slice();
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor((next() / U32) * (i + 1));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }

  if (cards.length !== CARD_COUNT) throw new Error('لوحة غير صالحة');
  return { cards, templateKey: template.key, templateName: template.name };
}

/** عدد صحيح عشوائي [0, max) بدون انحياز — للاستخدامات غير المرتبطة بالجولة (البوتات). */
function randInt(max) {
  if (max <= 0) return 0;
  const limit = Math.floor(U32 / max) * max;
  let v;
  do { v = crypto.randomBytes(4).readUInt32BE(0); } while (v >= limit);
  return v % max;
}

function pickOne(arr) {
  return arr[randInt(arr.length)];
}

module.exports = { sha256Hex, newServerSeed, deriveBoard, createStream, randInt, pickOne };
