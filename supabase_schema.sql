-- ============================================================================
-- iCHANCE — مخطط قاعدة البيانات النظيف لـ Supabase (PostgreSQL)
-- ============================================================================
-- طريقة الاستخدام:
-- 1. افتح لوحة تحكم Supabase الخاصة بمشروعك (https://supabase.com/dashboard)
-- 2. توجّه إلى: SQL Editor من القائمة الجانبية
-- 3. انسخ كامل هذا الكود والصقه في المحرر ثم اضغط على زر [Run]
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. تنظيف أي جداول أو عروض سابقة بأمان تام بغض النظر عن نوعها (Table أم View)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' 
      AND c.relname IN ('player_summary', 'cashier_summary', 'transaction_log', 'accounts', 'commission_tiers')
    ORDER BY (c.relkind = 'v') DESC -- إسقاط الـ Views أولاً ثم الـ Tables
  ) LOOP
    BEGIN
      IF r.relkind = 'v' THEN
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'r' THEN
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'm' THEN
        EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', r.relname);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- تم حذفه مسبقاً عبر CASCADE
    END;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.admin_adjust_cashier CASCADE;
DROP FUNCTION IF EXISTS public.cashier_deposit CASCADE;
DROP FUNCTION IF EXISTS public.cashier_withdraw CASCADE;
DROP FUNCTION IF EXISTS public.apply_game_deltas CASCADE;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. جدول الحسابات (Accounts)
-- ----------------------------------------------------------------------------
CREATE TABLE public.accounts (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('cashier', 'player')),
  username TEXT NOT NULL,
  username_key TEXT GENERATED ALWAYS AS (lower(username)) STORED,
  email TEXT,
  email_key TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_id TEXT NOT NULL,
  cashier_id TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
  balance BIGINT NOT NULL DEFAULT 0 CONSTRAINT balance_not_negative CHECK (balance >= 0),
  unlimited_float BOOLEAN NOT NULL DEFAULT FALSE,
  country TEXT DEFAULT 'SY',
  currency TEXT DEFAULT 'SYP',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  play_token TEXT,
  CONSTRAINT accounts_username_uniq UNIQUE (username_key),
  CONSTRAINT accounts_email_uniq UNIQUE (email_key),
  CONSTRAINT accounts_display_uniq UNIQUE (display_id)
);

-- دالة ومحفّز لتوليد معرّف الحساب تلقائياً عند الإنشاء (csh_... أو ply_...)
CREATE OR REPLACE FUNCTION public.trg_set_account_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NULL OR NEW.id = '' THEN
    IF NEW.role = 'cashier' THEN
      NEW.id := 'csh_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
    ELSE
      NEW.id := 'ply_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_accounts_id
BEFORE INSERT ON public.accounts
FOR EACH ROW
EXECUTE FUNCTION public.trg_set_account_id();

-- فهارس تسريع الاستعلامات
CREATE INDEX idx_accounts_role ON public.accounts(role);
CREATE INDEX idx_accounts_cashier_id ON public.accounts(cashier_id);
CREATE INDEX idx_accounts_play_token ON public.accounts(play_token) WHERE play_token IS NOT NULL;
CREATE INDEX idx_accounts_created_at ON public.accounts(created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. جدول سجل العمليات المالية (Transaction Log)
-- ----------------------------------------------------------------------------
CREATE TABLE public.transaction_log (
  id TEXT PRIMARY KEY,
  cashier_id TEXT NOT NULL REFERENCES public.accounts(id),
  player_id TEXT REFERENCES public.accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdraw', 'topup', 'deduct')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  cashier_balance_after BIGINT NOT NULL,
  player_balance_after BIGINT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- دالة ومحفّز لتوليد معرّف العملية تلقائياً عند الإنشاء (tx_...)
CREATE OR REPLACE FUNCTION public.trg_set_tx_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NULL OR NEW.id = '' THEN
    NEW.id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_id
BEFORE INSERT ON public.transaction_log
FOR EACH ROW
EXECUTE FUNCTION public.trg_set_tx_id();

CREATE INDEX idx_tx_cashier_id ON public.transaction_log(cashier_id);
CREATE INDEX idx_tx_player_id ON public.transaction_log(player_id);
CREATE INDEX idx_tx_created_at ON public.transaction_log(created_at DESC);

-- ----------------------------------------------------------------------------
-- 3. جدول شرائح العمولات (Commission Tiers)
-- ----------------------------------------------------------------------------
CREATE TABLE public.commission_tiers (
  id SERIAL PRIMARY KEY,
  min_burn BIGINT NOT NULL DEFAULT 0,
  rate NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  label TEXT
);

INSERT INTO public.commission_tiers (min_burn, rate, label)
VALUES (0, 5.00, 'افتراضي');

-- ----------------------------------------------------------------------------
-- 4. العروض التجميعية (Views)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.player_summary AS
SELECT
  id,
  role,
  username,
  email,
  display_id,
  cashier_id,
  created_by,
  balance,
  active,
  created_at,
  last_login_at
FROM public.accounts
WHERE role = 'player';

CREATE OR REPLACE VIEW public.cashier_summary AS
SELECT
  c.id,
  c.role,
  c.username,
  c.email,
  c.display_id,
  c.balance,
  c.unlimited_float,
  c.country,
  c.currency,
  c.active,
  c.created_at,
  c.last_login_at,
  (SELECT count(*)::INT FROM public.accounts p WHERE p.cashier_id = c.id AND p.role = 'player') AS player_count,
  (SELECT count(*)::INT FROM public.accounts p WHERE p.cashier_id = c.id AND p.role = 'player' AND p.active = true) AS active_players
FROM public.accounts c
WHERE c.role = 'cashier';

-- ----------------------------------------------------------------------------
-- 5. الدوال المخزّنة (RPCs)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_adjust_cashier(TEXT, BIGINT, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.cashier_deposit(TEXT, TEXT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.cashier_withdraw(TEXT, TEXT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.apply_game_deltas(JSONB);

-- دالة: تعبئة أو سحب عهدة كاشير من لوحة الإدارة
CREATE OR REPLACE FUNCTION public.admin_adjust_cashier(
  p_cashier TEXT,
  p_amount BIGINT,
  p_topup BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cashier public.accounts%ROWTYPE;
  v_new_bal BIGINT;
  v_tx_id TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_cashier
  FROM public.accounts
  WHERE (id = p_cashier OR display_id = p_cashier)
  FOR UPDATE;

  IF NOT FOUND OR v_cashier.role <> 'cashier' THEN
    RAISE EXCEPTION 'CASHIER_NOT_FOUND';
  END IF;

  IF p_topup THEN
    v_new_bal := v_cashier.balance + p_amount;
  ELSE
    v_new_bal := GREATEST(0, v_cashier.balance - p_amount);
  END IF;

  UPDATE public.accounts
  SET balance = v_new_bal
  WHERE id = v_cashier.id;

  v_tx_id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.transaction_log (
    id, cashier_id, player_id, kind, amount,
    cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id,
    v_cashier.id,
    NULL,
    CASE WHEN p_topup THEN 'topup' ELSE 'deduct' END,
    p_amount,
    v_new_bal,
    NULL,
    COALESCE(p_note, CASE WHEN p_topup THEN 'تعبئة عهدة من الإدارة' ELSE 'سحب عهدة من الإدارة' END)
  );

  RETURN jsonb_build_object('ok', true, 'cashier_balance', v_new_bal);
END;
$$;

-- دالة: إيداع رصيد من عهدة الكاشير إلى حساب اللاعب
CREATE OR REPLACE FUNCTION public.cashier_deposit(
  p_cashier TEXT,
  p_player TEXT,
  p_amount BIGINT,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cashier public.accounts%ROWTYPE;
  v_player public.accounts%ROWTYPE;
  v_new_cashier_bal BIGINT;
  v_new_player_bal BIGINT;
  v_tx_id TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_cashier
  FROM public.accounts
  WHERE (id = p_cashier OR display_id = p_cashier)
  FOR UPDATE;

  IF NOT FOUND OR v_cashier.role <> 'cashier' THEN
    RAISE EXCEPTION 'CASHIER_NOT_FOUND';
  END IF;
  IF NOT v_cashier.active THEN
    RAISE EXCEPTION 'CASHIER_INACTIVE';
  END IF;

  SELECT * INTO v_player
  FROM public.accounts
  WHERE (id = p_player OR display_id = p_player)
  FOR UPDATE;

  IF NOT FOUND OR v_player.role <> 'player' THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;
  IF NOT v_player.active THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  IF v_player.cashier_id IS NOT NULL AND v_player.cashier_id <> v_cashier.id THEN
    RAISE EXCEPTION 'NOT_YOUR_PLAYER';
  END IF;

  IF NOT v_cashier.unlimited_float AND v_cashier.balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FLOAT';
  END IF;

  IF v_cashier.unlimited_float THEN
    v_new_cashier_bal := v_cashier.balance;
  ELSE
    v_new_cashier_bal := v_cashier.balance - p_amount;
  END IF;

  v_new_player_bal := v_player.balance + p_amount;

  UPDATE public.accounts SET balance = v_new_cashier_bal WHERE id = v_cashier.id;
  UPDATE public.accounts SET balance = v_new_player_bal WHERE id = v_player.id;

  v_tx_id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.transaction_log (
    id, cashier_id, player_id, kind, amount,
    cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id,
    v_cashier.id,
    v_player.id,
    'deposit',
    p_amount,
    v_new_cashier_bal,
    v_new_player_bal,
    COALESCE(p_note, 'إيداع للاعب')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cashier_balance', v_new_cashier_bal,
    'player_balance', v_new_player_bal
  );
END;
$$;

-- دالة: سحب رصيد من اللاعب وإرجاعه إلى عهدة الكاشير
CREATE OR REPLACE FUNCTION public.cashier_withdraw(
  p_cashier TEXT,
  p_player TEXT,
  p_amount BIGINT,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cashier public.accounts%ROWTYPE;
  v_player public.accounts%ROWTYPE;
  v_new_cashier_bal BIGINT;
  v_new_player_bal BIGINT;
  v_tx_id TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_cashier
  FROM public.accounts
  WHERE (id = p_cashier OR display_id = p_cashier)
  FOR UPDATE;

  IF NOT FOUND OR v_cashier.role <> 'cashier' THEN
    RAISE EXCEPTION 'CASHIER_NOT_FOUND';
  END IF;
  IF NOT v_cashier.active THEN
    RAISE EXCEPTION 'CASHIER_INACTIVE';
  END IF;

  SELECT * INTO v_player
  FROM public.accounts
  WHERE (id = p_player OR display_id = p_player)
  FOR UPDATE;

  IF NOT FOUND OR v_player.role <> 'player' THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;
  IF NOT v_player.active THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  IF v_player.cashier_id IS NOT NULL AND v_player.cashier_id <> v_cashier.id THEN
    RAISE EXCEPTION 'NOT_YOUR_PLAYER';
  END IF;

  IF v_player.balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
  END IF;

  v_new_player_bal := v_player.balance - p_amount;
  IF v_cashier.unlimited_float THEN
    v_new_cashier_bal := v_cashier.balance;
  ELSE
    v_new_cashier_bal := v_cashier.balance + p_amount;
  END IF;

  UPDATE public.accounts SET balance = v_new_cashier_bal WHERE id = v_cashier.id;
  UPDATE public.accounts SET balance = v_new_player_bal WHERE id = v_player.id;

  v_tx_id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.transaction_log (
    id, cashier_id, player_id, kind, amount,
    cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id,
    v_cashier.id,
    v_player.id,
    'withdraw',
    p_amount,
    v_new_cashier_bal,
    v_new_player_bal,
    COALESCE(p_note, 'سحب من اللاعب')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cashier_balance', v_new_cashier_bal,
    'player_balance', v_new_player_bal
  );
END;
$$;

-- دالة: تطبيق فروقات رصيد الألعاب دفعة واحدة
CREATE OR REPLACE FUNCTION public.apply_game_deltas(
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  elem JSONB;
  v_id TEXT;
  v_delta BIGINT;
BEGIN
  FOR elem IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_id := elem->>'id';
    v_delta := (elem->>'delta')::BIGINT;
    IF v_id IS NOT NULL AND v_delta IS NOT NULL THEN
      UPDATE public.accounts
      SET balance = GREATEST(0, balance + v_delta)
      WHERE id = v_id OR display_id = v_id;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. الصلاحيات والأمان (Permissions & RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_tiers ENABLE ROW LEVEL SECURITY;

-- سياسات الوصول الشاملة للـ service_role و anon و authenticated
DROP POLICY IF EXISTS "service_role_all_accounts" ON public.accounts;
CREATE POLICY "service_role_all_accounts" ON public.accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_tx" ON public.transaction_log;
CREATE POLICY "service_role_all_tx" ON public.transaction_log FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_tiers" ON public.commission_tiers;
CREATE POLICY "service_role_all_tiers" ON public.commission_tiers FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_all_accounts" ON public.accounts;
CREATE POLICY "anon_all_accounts" ON public.accounts FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_all_tx" ON public.transaction_log;
CREATE POLICY "anon_all_tx" ON public.transaction_log FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_all_tiers" ON public.commission_tiers;
CREATE POLICY "anon_all_tiers" ON public.commission_tiers FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_all_accounts" ON public.accounts;
CREATE POLICY "auth_all_accounts" ON public.accounts FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_all_tx" ON public.transaction_log;
CREATE POLICY "auth_all_tx" ON public.transaction_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_all_tiers" ON public.commission_tiers;
CREATE POLICY "auth_all_tiers" ON public.commission_tiers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- منح كافة الصلاحيات
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;
