'use strict';

/**
 * إعادة بناء التعديلات التي لم تُرفع (ولم تكن منّي) في store.js وaccounts.js،
 * فوق الكود المرفوع — نصّاً بنصّ من الفرق الذي كان في شجرة العمل. تُستعمل
 * مع tools/mutationCheck.js لإثبات أن الاختبارات تكشف علّتيها:
 *
 *   node tools/mutationCheck.js HEAD tools/mutations/uncommitted.js
 */

module.exports = [
  {
    // «الأعلى بين الذاكرة والقاعدة»
    file: 'store.js',
    find: '  if (!accounts.hasPending(row.id)) player.balance = Math.max(0, Math.round(row.balance));',
    replace: `  if (!accounts.hasPending(row.id)) {
    const dbBal = Math.max(0, Math.round(row.balance));
    if (dbBal >= player.balance) {
      player.balance = dbBal;
    }
  }`
  },
  {
    // يُبقي الدفعة حتى التأكيد — لكن يطبّقها على الملف عند الفشل ويعيد كل 5 ثوانٍ
    file: 'accounts.js',
    fn: 'flushDeltas',
    replace: `async function flushDeltas() {
  if (flushing || !pending.size) return { applied: 0 };
  flushing = true;
  const batch = [...pending.entries()].map(([id, delta]) => ({ id, delta }));
  try {
    if (supabaseReady) {
      try {
        await sb.rpc('apply_game_deltas', { p_items: batch });
        for (const item of batch) {
          const current = pending.get(item.id);
          if (current === item.delta) {
            pending.delete(item.id);
          } else if (current !== undefined) {
            pending.set(item.id, current - item.delta);
          }
        }
        return { applied: batch.length };
      } catch (err) {
        console.warn('[accounts] تعذّر دفع الفروق إلى Supabase، تطبيق محلي:', err.message);
      }
    }
    const db = getLocal();
    for (const item of batch) {
      const acc = db.accounts.find((a) => a.id === item.id || a.display_id === item.id);
      if (acc) {
        acc.balance = Math.max(0, Math.round((acc.balance || 0) + item.delta));
      }
    }
    saveLocal();
    if (pending.size > 0) {
      setTimeout(() => flushDeltas().catch(() => {}), 5000);
    }
    return { applied: batch.length };
  } finally {
    flushing = false;
  }
}
`
  }
];
