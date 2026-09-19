'use strict';

/**
 * دول الكاشيرية وعملاتها.
 *
 * العملة تتبع الدولة ولا تُكتب يدوياً: كتابتها بحرّية تعني أن كاشيرين في
 * البلد نفسه قد يسجّلان عملتين مختلفتين فتصير التقارير غير قابلة للجمع.
 *
 * الرمز ثلاثي (ISO 4217) والاسم عربي للعرض. `minor` عدد الخانات العشرية —
 * أكثر عملات المنطقة بلا كسور عملياً، فنعرضها أعداداً صحيحة.
 */
const COUNTRIES = [
  { code: 'SY', name: 'سوريا',          currency: 'SYP', symbol: 'ل.س' },
  { code: 'LB', name: 'لبنان',          currency: 'LBP', symbol: 'ل.ل' },
  { code: 'TR', name: 'تركيا',          currency: 'TRY', symbol: '₺' },
  { code: 'IQ', name: 'العراق',         currency: 'IQD', symbol: 'د.ع' },
  { code: 'JO', name: 'الأردن',         currency: 'JOD', symbol: 'د.أ' },
  { code: 'EG', name: 'مصر',            currency: 'EGP', symbol: 'ج.م' },
  { code: 'SA', name: 'السعودية',       currency: 'SAR', symbol: 'ر.س' },
  { code: 'AE', name: 'الإمارات',       currency: 'AED', symbol: 'د.إ' },
  { code: 'KW', name: 'الكويت',         currency: 'KWD', symbol: 'د.ك' },
  { code: 'QA', name: 'قطر',            currency: 'QAR', symbol: 'ر.ق' },
  { code: 'BH', name: 'البحرين',        currency: 'BHD', symbol: 'د.ب' },
  { code: 'OM', name: 'عُمان',           currency: 'OMR', symbol: 'ر.ع' },
  { code: 'YE', name: 'اليمن',          currency: 'YER', symbol: 'ر.ي' },
  { code: 'LY', name: 'ليبيا',          currency: 'LYD', symbol: 'د.ل' },
  { code: 'SD', name: 'السودان',        currency: 'SDG', symbol: 'ج.س' },
  { code: 'DZ', name: 'الجزائر',        currency: 'DZD', symbol: 'د.ج' },
  { code: 'MA', name: 'المغرب',         currency: 'MAD', symbol: 'د.م' },
  { code: 'TN', name: 'تونس',           currency: 'TND', symbol: 'د.ت' },
  { code: 'PS', name: 'فلسطين',         currency: 'ILS', symbol: '₪' },
  { code: 'DE', name: 'ألمانيا',        currency: 'EUR', symbol: '€' },
  { code: 'SE', name: 'السويد',         currency: 'SEK', symbol: 'kr' },
  { code: 'GB', name: 'بريطانيا',       currency: 'GBP', symbol: '£' },
  { code: 'US', name: 'الولايات المتحدة', currency: 'USD', symbol: '$' }
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

function get(code) {
  return BY_CODE.get(String(code || '').trim().toUpperCase()) || null;
}

function list() {
  return COUNTRIES.map((c) => ({ ...c }));
}

/** يتحقّق من الدولة ويرجّع عملتها — مصدر واحد للاثنين. */
function resolve(code) {
  const c = get(code);
  if (!c) return { ok: false, error: 'دولة غير معروفة' };
  return { ok: true, country: c.code, currency: c.currency, symbol: c.symbol, name: c.name };
}

module.exports = { list, get, resolve };
