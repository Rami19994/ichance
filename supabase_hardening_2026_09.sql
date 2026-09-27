-- =============================================================================
-- LuckyArena — تحصين قاعدة البيانات (أيلول 2026)
--
-- يُشغَّل مرّة واحدة: Supabase → SQL Editor → الصق الملف كاملاً → Run.
-- آمن للتكرار، ولا يحذف أي بيانات. كل خطوة تطبع NOTICE بما فعلته.
--
-- الدوال تُعدَّل من تعريفها الحالي في القاعدة نفسها (pg_get_functiondef) بتبديل
-- الشرط المقصود وحده — فلا يُكتب فوق أي تعديل سابق عليها. إن لم يوجد النصّ
-- المتوقّع تُترك الدالّة كما هي مع NOTICE.
-- =============================================================================

BEGIN;

-- أداة: تبديلات داخل تعريف دالّة ثم إعادة إنشائها — كلّها أو لا شيء.
-- كل نصّ قديم يجب أن يوجد مرّة واحدة بالضبط، وإلّا تُترك الدالّة كما هي.
CREATE OR REPLACE FUNCTION pg_temp.patch_fn(p_name TEXT, p_olds TEXT[], p_news TEXT[], p_label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  def TEXT;
  patched TEXT;
  hits INT;
  i INT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name
  LIMIT 1;
  IF def IS NULL THEN
    RAISE NOTICE '[%] الدالّة % غير موجودة — تُركت', p_label, p_name;
    RETURN;
  END IF;
  IF position(p_news[1] IN def) > 0 THEN
    RAISE NOTICE '[%] % مُعدَّلة من قبل — لا شيء', p_label, p_name;
    RETURN;
  END IF;
  patched := def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    hits := (length(patched) - length(replace(patched, p_olds[i], ''))) / greatest(length(p_olds[i]), 1);
    IF hits <> 1 THEN
      RAISE NOTICE '[%] % : النصّ «%» وُجد % مرّة (المطلوب 1) — تُركت الدالّة كما هي', p_label, p_name, p_olds[i], hits;
      RETURN;
    END IF;
    patched := replace(patched, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE patched;
  RAISE NOTICE '[%] % : تمّ', p_label, p_name;
END;
$$;

-- -----------------------------------------------------------------------------
-- 1) الكاشير لا يلمس إلا لاعبيه
--    كان الشرط يقبل لاعباً بلا كاشير (أنشأته الإدارة مباشرة) من أيّ كاشير،
--    فيسحب أيّ كاشير رصيده إلى عهدته.
-- -----------------------------------------------------------------------------
SELECT pg_temp.patch_fn('cashier_deposit',
  ARRAY['v_player.cashier_id IS NOT NULL AND v_player.cashier_id <> v_cashier.id'],
  ARRAY['v_player.cashier_id IS DISTINCT FROM v_cashier.id'],
  'كاشير-إيداع');
SELECT pg_temp.patch_fn('cashier_withdraw',
  ARRAY['v_player.cashier_id IS NOT NULL AND v_player.cashier_id <> v_cashier.id'],
  ARRAY['v_player.cashier_id IS DISTINCT FROM v_cashier.id'],
  'كاشير-سحب');

-- -----------------------------------------------------------------------------
-- 2) حساب موقوف لا يراهن (gw_debit لم يكن يفحص الإيقاف)
--    الربح والتراجع يبقيان مسموحين كي لا يضيع مال رهانٍ قائم.
-- -----------------------------------------------------------------------------
SELECT pg_temp.patch_fn('gw_debit',
  ARRAY['IF v_player.balance < p_amount THEN'],
  ARRAY['IF NOT v_player.active THEN RAISE EXCEPTION ''PLAYER_INACTIVE''; END IF; IF v_player.balance < p_amount THEN'],
  'رهان-موقوف');

-- -----------------------------------------------------------------------------
-- 3) رقم الحركة لا يُطبَّق مرّتين
--    إعادة إرسال بعد مهلة، أو طلب موقَّع يُعاد، كان يُصرف مرّتين.
--    (خادم الموقع يتعامل مع رفض التكرار: 23505 = «مسجّلة من قبل».)
-- -----------------------------------------------------------------------------
DO $$
DECLARE dup INT;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM public.game_rounds
    WHERE tx_ref IS NOT NULL AND tx_ref <> ''
    GROUP BY game_id, tx_ref HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE NOTICE '[حركات] يوجد % رقم حركة مكرّر سابقاً — لم يُنشأ الفهرس الفريد. للمراجعة: SELECT game_id, tx_ref, count(*) FROM public.game_rounds WHERE tx_ref <> '''' GROUP BY 1,2 HAVING count(*) > 1;', dup;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_game_rounds_game_tx
      ON public.game_rounds (game_id, tx_ref)
      WHERE tx_ref IS NOT NULL AND tx_ref <> '';
    RAISE NOTICE '[حركات] فهرس فريد على (game_id, tx_ref): تمّ';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4) الحركة الواحدة لا يُتراجع عنها إلا مرّة
--    gw_rollback كان يعيد الرهان نفسه في كل نداء برقم تراجع جديد.
-- -----------------------------------------------------------------------------
ALTER TABLE public.game_rounds ADD COLUMN IF NOT EXISTS rollback_of TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_rounds_rollback_of
  ON public.game_rounds (rollback_of) WHERE rollback_of IS NOT NULL;

SELECT pg_temp.patch_fn('gw_rollback',
  ARRAY['tx_ref, action, amount, balance_after', '''rollback'', v_prev.amount, v_new_bal'],
  ARRAY['tx_ref, action, amount, balance_after, rollback_of', '''rollback'', v_prev.amount, v_new_bal, v_prev.id'],
  'تراجع');

-- -----------------------------------------------------------------------------
-- 5) دوال المال لا يستدعيها إلا مفتاح الخادم
--    Postgres يمنح EXECUTE على كل دالّة جديدة للجميع (PUBLIC)، وSupabase
--    يمنحها لـ anon. المفتاح العام (publishable) ما زال فعّالاً وهو في تاريخ
--    المستودع العام — فحص للقراءة فقط أكّد أنه يستطيع استدعاء الدوال.
--    الموقع نفسه لا يستدعي القاعدة من المتصفح أبداً (كل شيء عبر الخادم).
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

COMMIT;

-- -----------------------------------------------------------------------------
-- تحقّق: كل الأسطر يجب أن تكون anon_can_execute = false
-- -----------------------------------------------------------------------------
SELECT p.proname AS function_name,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS server_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY 1;
