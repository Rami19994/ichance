-- ============================================================================
-- حماية وتحصين قاعدة بيانات Supabase (PostgreSQL Security Hardening)
-- ============================================================================
-- تهدف هذه التعليمات إلى منع أي شخص خارجي أو متسلل من استعلام جداول الحسابات
-- أو الأرصدة أو المعاملات مباشرة عبر واجهة PostgREST العامة (anon / authenticated).
--
-- طريقة التطبيق:
-- 1. توجّه إلى لوحة تحكم Supabase -> SQL Editor
-- 2. الصق هذا الملف واضغط على زر [Run]
-- ============================================================================

-- 1. تفعيل حماية السجلات على مستوى الصفوف (Row Level Security - RLS)
ALTER TABLE IF EXISTS public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.transaction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.commission_tiers ENABLE ROW LEVEL SECURITY;

-- 2. سحب كافة الصلاحيات المباشرة من الأدوار العامة (anon, authenticated)
REVOKE ALL ON TABLE public.accounts FROM anon, authenticated;
REVOKE ALL ON TABLE public.transaction_log FROM anon, authenticated;
REVOKE ALL ON TABLE public.commission_tiers FROM anon, authenticated;

-- 3. منح الصلاحيات الكاملة حصراً لخادم التطبيق المحمي (service_role)
GRANT ALL ON TABLE public.accounts TO service_role;
GRANT ALL ON TABLE public.transaction_log TO service_role;
GRANT ALL ON TABLE public.commission_tiers TO service_role;

-- 4. سياسات RLS المحكمة — لا أحد يقرأ أو يكتب إلا خادم Node.js عبر مفتاح service_role السري
DROP POLICY IF EXISTS "service_role_accounts_policy" ON public.accounts;
CREATE POLICY "service_role_accounts_policy"
  ON public.accounts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_tx_policy" ON public.transaction_log;
CREATE POLICY "service_role_tx_policy"
  ON public.transaction_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_tiers_policy" ON public.commission_tiers;
CREATE POLICY "service_role_tiers_policy"
  ON public.commission_tiers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. تأكيد عدم قبول أي رصيد سالب أو قيم غير صالحة
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'balance_not_negative'
  ) THEN
    ALTER TABLE public.accounts ADD CONSTRAINT balance_not_negative CHECK (balance >= 0);
  END IF;
END $$;
