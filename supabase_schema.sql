-- ============================================================================
-- LuckyArena / iCHANCE — المخطط الشامل والنهائي لقاعدة بيانات Supabase (PostgreSQL)
-- ============================================================================
-- يغطي هذا المخطط النظام المالي والتشغيلي بأكمله:
-- 1. الهيكل الهرمي للحسابات: الإدارة العليا ← الوكيل الرئيسي (Master) ← الكاشير (Cashier) ← اللاعب (Player)
-- 2. سجل المعاملات المالية المترابطة وسلسلة التغذية (Transaction Log & Chain Ledger)
-- 3. شرائح عمولات الكاشيرية والماسترية (Commission Tiers)
-- 4. سجل الألعاب الخارجية والمحفظة المتصلة (Games Gateway, Sessions & Rounds)
-- 5. أسرار الموقع والمفاتيح المشفرة (Site Secrets & Multi-Admin Keys)
-- 6. الإجراءات المخزنة الذرية (RPCs) لخصم وإيداع الأرصدة ومنع التلاعب
-- 7. التحصين الأمني الشامل وسياسات RLS (Row Level Security)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. جدول الحسابات الشامل (Accounts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('master', 'cashier', 'player')),
  username TEXT NOT NULL,
  username_key TEXT GENERATED ALWAYS AS (lower(username)) STORED,
  email TEXT,
  email_key TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_id TEXT NOT NULL,
  master_id TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
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

-- تحديث القيد في حال كان الجدول منشأ سابقاً بقيد قديم
DO $$
BEGIN
  ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
  ALTER TABLE public.accounts ADD CONSTRAINT accounts_role_check CHECK (role IN ('master', 'cashier', 'player'));
  
  -- إضافة عمود master_id إن لم يكن موجوداً
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'master_id'
  ) THEN
    ALTER TABLE public.accounts ADD COLUMN master_id TEXT REFERENCES public.accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- دالة ومحفّز لتوليد معرّف الحساب تلقائياً عند الإنشاء (mst_... أو csh_... أو ply_...)
CREATE OR REPLACE FUNCTION public.trg_set_account_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NULL OR NEW.id = '' THEN
    IF NEW.role = 'master' THEN
      NEW.id := 'mst_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
    ELSIF NEW.role = 'cashier' THEN
      NEW.id := 'csh_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
    ELSE
      NEW.id := 'ply_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_id ON public.accounts;
CREATE TRIGGER trg_accounts_id
BEFORE INSERT ON public.accounts
FOR EACH ROW
EXECUTE FUNCTION public.trg_set_account_id();

-- فهارس تسريع الاستعلامات
CREATE INDEX IF NOT EXISTS idx_accounts_role ON public.accounts(role);
CREATE INDEX IF NOT EXISTS idx_accounts_master_id ON public.accounts(master_id);
CREATE INDEX IF NOT EXISTS idx_accounts_cashier_id ON public.accounts(cashier_id);
CREATE INDEX IF NOT EXISTS idx_accounts_play_token ON public.accounts(play_token) WHERE play_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON public.accounts(created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. جدول سجل العمليات المالية الشامل (Transaction Log)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transaction_log (
  id TEXT PRIMARY KEY,
  master_id TEXT REFERENCES public.accounts(id),
  cashier_id TEXT REFERENCES public.accounts(id),
  player_id TEXT REFERENCES public.accounts(id),
  kind TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  master_balance_after BIGINT,
  cashier_balance_after BIGINT,
  player_balance_after BIGINT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- تحديث الحقول في حال كان الجدول موجوداً مسبقاً
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'transaction_log' AND column_name = 'master_id'
  ) THEN
    ALTER TABLE public.transaction_log ADD COLUMN master_id TEXT REFERENCES public.accounts(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'transaction_log' AND column_name = 'master_balance_after'
  ) THEN
    ALTER TABLE public.transaction_log ADD COLUMN master_balance_after BIGINT;
  END IF;
  -- جعل cashier_id قابلاً للقيمة الخالية لدعم تحويلات الإدارة للماستر المباشرة
  ALTER TABLE public.transaction_log ALTER COLUMN cashier_id DROP NOT NULL;
END $$;

-- دالة ومحفّز لتوليد معرّف العملية تلقائياً (tx_...)
CREATE OR REPLACE FUNCTION public.trg_set_tx_id()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NULL OR NEW.id = '' THEN
    NEW.id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tx_id ON public.transaction_log;
CREATE TRIGGER trg_tx_id
BEFORE INSERT ON public.transaction_log
FOR EACH ROW
EXECUTE FUNCTION public.trg_set_tx_id();

CREATE INDEX IF NOT EXISTS idx_tx_master_id ON public.transaction_log(master_id);
CREATE INDEX IF NOT EXISTS idx_tx_cashier_id ON public.transaction_log(cashier_id);
CREATE INDEX IF NOT EXISTS idx_tx_player_id ON public.transaction_log(player_id);
CREATE INDEX IF NOT EXISTS idx_tx_created_at ON public.transaction_log(created_at DESC);

-- ----------------------------------------------------------------------------
-- 3. جدول شرائح العمولات (Commission Tiers)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.commission_tiers (
  id SERIAL PRIMARY KEY,
  min_burn BIGINT NOT NULL DEFAULT 0,
  rate NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  label TEXT
);

INSERT INTO public.commission_tiers (min_burn, rate, label)
SELECT 0, 5.00, 'افتراضي'
WHERE NOT EXISTS (SELECT 1 FROM public.commission_tiers);

-- ----------------------------------------------------------------------------
-- 4. جدول أسرار الموقع والمفاتيح المشفرة (Site Secrets)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 5. جداول بوابة الألعاب والمحفظة الخارجية (Games, Sessions, Rounds)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.games (
  id TEXT PRIMARY KEY DEFAULT ('gm_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16)),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fast',
  launch_url TEXT NOT NULL,
  cover_url TEXT,
  accent TEXT,
  api_secret TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.game_sessions (
  token TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_game_sessions_player ON public.game_sessions(player_id);

CREATE TABLE IF NOT EXISTS public.game_rounds (
  id TEXT PRIMARY KEY DEFAULT ('rnd_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16)),
  game_id TEXT NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  round_ref TEXT,
  tx_ref TEXT,
  action TEXT NOT NULL CHECK (action IN ('debit', 'credit', 'rollback')),
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_game_rounds_game ON public.game_rounds(game_id);
CREATE INDEX IF NOT EXISTS idx_game_rounds_player ON public.game_rounds(player_id);
CREATE INDEX IF NOT EXISTS idx_game_rounds_created ON public.game_rounds(created_at DESC);

CREATE TABLE IF NOT EXISTS public.balance_anomalies (
  id TEXT PRIMARY KEY DEFAULT ('anm_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16)),
  account_id TEXT REFERENCES public.accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  expected BIGINT,
  actual BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 6. دالة حساب نسبة العمولة بناءً على الاستهلاك (Burn Rate)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commission_rate_for(p_burn BIGINT)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  SELECT rate INTO v_rate
  FROM public.commission_tiers
  WHERE min_burn <= COALESCE(p_burn, 0)
  ORDER BY min_burn DESC
  LIMIT 1;

  RETURN COALESCE(v_rate, 5.00);
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. العروض التحليلية التجميعية (Views)
-- ----------------------------------------------------------------------------

-- عرض ملخص اللاعب (Player Summary)
CREATE OR REPLACE VIEW public.player_summary AS
SELECT
  p.id,
  p.username,
  p.email,
  p.display_id,
  p.balance,
  p.active,
  p.cashier_id,
  c.username AS cashier_username,
  c.master_id AS master_id,
  m.username AS master_username,
  p.created_at,
  p.last_login_at,
  COALESCE((
    SELECT sum(t.amount)::BIGINT FROM public.transaction_log t
    WHERE t.player_id = p.id AND t.kind = 'deposit'
  ), 0) AS total_deposited,
  COALESCE((
    SELECT sum(t.amount)::BIGINT FROM public.transaction_log t
    WHERE t.player_id = p.id AND t.kind = 'withdraw'
  ), 0) AS total_withdrawn,
  COALESCE((
    SELECT count(*)::BIGINT FROM public.transaction_log t
    WHERE t.player_id = p.id
  ), 0) AS tx_count,
  (
    SELECT max(t.created_at) FROM public.transaction_log t
    WHERE t.player_id = p.id
  ) AS last_tx_at,
  (
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.player_id = p.id AND t.kind = 'deposit'), 0) -
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.player_id = p.id AND t.kind = 'withdraw'), 0)
  ) AS net_in,
  (
    p.balance - (
      COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.player_id = p.id AND t.kind = 'deposit'), 0) -
      COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.player_id = p.id AND t.kind = 'withdraw'), 0)
    )
  ) AS game_pl
FROM public.accounts p
LEFT JOIN public.accounts c ON p.cashier_id = c.id
LEFT JOIN public.accounts m ON c.master_id = m.id
WHERE p.role = 'player';

-- عرض ملخص الكاشير (Cashier Summary)
CREATE OR REPLACE VIEW public.cashier_summary AS
WITH cashier_stats AS (
  SELECT
    c.id,
    COALESCE((SELECT count(*)::BIGINT FROM public.accounts p WHERE p.cashier_id = c.id AND p.role = 'player'), 0) AS player_count,
    COALESCE((SELECT count(*)::BIGINT FROM public.accounts p WHERE p.cashier_id = c.id AND p.role = 'player' AND p.active = true), 0) AS active_players,
    COALESCE((SELECT sum(p.balance)::BIGINT FROM public.accounts p WHERE p.cashier_id = c.id AND p.role = 'player'), 0) AS players_balance,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.cashier_id = c.id AND t.kind = 'deposit'), 0) AS total_deposited,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.cashier_id = c.id AND t.kind = 'withdraw'), 0) AS total_withdrawn,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.cashier_id = c.id AND t.kind IN ('topup', 'master_fund_cashier')), 0) AS received_from_master,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.cashier_id = c.id AND t.kind IN ('deduct', 'master_recall_cashier')), 0) AS returned_to_master
  FROM public.accounts c
  WHERE c.role = 'cashier'
)
SELECT
  c.id,
  c.username,
  c.email,
  c.display_id,
  c.balance AS float_balance,
  c.unlimited_float,
  c.active,
  c.country,
  c.currency,
  c.created_at,
  c.last_login_at,
  c.master_id,
  m.username AS master_username,
  s.player_count,
  s.active_players,
  s.players_balance,
  s.total_deposited,
  s.total_withdrawn,
  s.received_from_master,
  s.returned_to_master,
  (s.total_deposited - s.total_withdrawn) AS net_out,
  GREATEST(0, s.total_deposited - s.total_withdrawn) AS burn,
  public.commission_rate_for(GREATEST(0, s.total_deposited - s.total_withdrawn)) AS commission_rate,
  ROUND(GREATEST(0, s.total_deposited - s.total_withdrawn) * (public.commission_rate_for(GREATEST(0, s.total_deposited - s.total_withdrawn)) / 100))::BIGINT AS commission_amount
FROM public.accounts c
JOIN cashier_stats s ON c.id = s.id
LEFT JOIN public.accounts m ON c.master_id = m.id
WHERE c.role = 'cashier';

-- عرض ملخص الماستر (Master Summary)
CREATE OR REPLACE VIEW public.master_summary AS
WITH master_stats AS (
  SELECT
    m.id,
    COALESCE((SELECT count(*)::BIGINT FROM public.accounts c WHERE c.master_id = m.id AND c.role = 'cashier'), 0) AS cashier_count,
    COALESCE((SELECT count(*)::BIGINT FROM public.accounts c WHERE c.master_id = m.id AND c.role = 'cashier' AND c.active = true), 0) AS active_cashiers,
    COALESCE((SELECT sum(c.balance)::BIGINT FROM public.accounts c WHERE c.master_id = m.id AND c.role = 'cashier'), 0) AS cashiers_float,
    COALESCE((SELECT count(*)::BIGINT FROM public.accounts p JOIN public.accounts c ON p.cashier_id = c.id WHERE c.master_id = m.id AND p.role = 'player'), 0) AS player_count,
    COALESCE((SELECT sum(p.balance)::BIGINT FROM public.accounts p JOIN public.accounts c ON p.cashier_id = c.id WHERE c.master_id = m.id AND p.role = 'player'), 0) AS players_balance,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.master_id = m.id AND t.kind = 'master_topup'), 0) AS received_from_admin,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.master_id = m.id AND t.kind = 'master_deduct'), 0) AS returned_to_admin,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.master_id = m.id AND t.kind = 'master_fund_cashier'), 0) AS gave_cashiers,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t WHERE t.master_id = m.id AND t.kind = 'master_recall_cashier'), 0) AS took_cashiers,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t JOIN public.accounts c ON t.cashier_id = c.id WHERE c.master_id = m.id AND t.kind = 'deposit'), 0) AS net_deposited,
    COALESCE((SELECT sum(t.amount)::BIGINT FROM public.transaction_log t JOIN public.accounts c ON t.cashier_id = c.id WHERE c.master_id = m.id AND t.kind = 'withdraw'), 0) AS net_withdrawn
  FROM public.accounts m
  WHERE m.role = 'master'
)
SELECT
  m.id,
  m.username,
  m.email,
  m.display_id,
  m.balance AS float_balance,
  m.unlimited_float,
  m.active,
  m.country,
  m.currency,
  m.created_at,
  m.last_login_at,
  s.cashier_count,
  s.active_cashiers,
  s.cashiers_float,
  s.player_count,
  s.players_balance,
  s.received_from_admin,
  s.returned_to_admin,
  s.gave_cashiers,
  s.took_cashiers,
  GREATEST(0, s.net_deposited - s.net_withdrawn) AS burn,
  public.commission_rate_for(GREATEST(0, s.net_deposited - s.net_withdrawn)) AS commission_rate,
  ROUND(GREATEST(0, s.net_deposited - s.net_withdrawn) * (public.commission_rate_for(GREATEST(0, s.net_deposited - s.net_withdrawn)) / 100))::BIGINT AS commission_amount
FROM public.accounts m
JOIN master_stats s ON m.id = s.id
WHERE m.role = 'master';

-- عرض كشف السلسلة المالية الكاملة (Chain Ledger View)
CREATE OR REPLACE VIEW public.chain_ledger AS
SELECT
  t.id,
  t.created_at,
  t.kind,
  t.amount,
  t.note,
  CASE
    WHEN t.kind IN ('master_topup', 'master_deduct') THEN 'الإدارة ← ماستر'
    WHEN t.kind IN ('topup', 'deduct') THEN 'الإدارة ← كاشير'
    WHEN t.kind IN ('master_fund_cashier', 'master_recall_cashier') THEN 'ماستر ← كاشير'
    WHEN t.kind = 'deposit' THEN 'كاشير ← لاعب'
    WHEN t.kind = 'withdraw' THEN 'لاعب ← كاشير'
    ELSE 'حركة مالية'
  END AS direction,
  t.master_id,
  m.username AS master_username,
  t.cashier_id,
  c.username AS cashier_username,
  t.player_id,
  COALESCE(p.username, c.username, m.username) AS subject_username,
  COALESCE(p.role, c.role, m.role) AS subject_role,
  t.player_balance_after,
  t.cashier_balance_after
FROM public.transaction_log t
LEFT JOIN public.accounts m ON t.master_id = m.id
LEFT JOIN public.accounts c ON t.cashier_id = c.id
LEFT JOIN public.accounts p ON t.player_id = p.id;

-- ----------------------------------------------------------------------------
-- 8. الإجراءات المخزنة والتحويلات الذرية (RPC Functions)
-- ----------------------------------------------------------------------------

-- دالة: تعبئة أو سحب عهدة ماستر من الإدارة العليا
CREATE OR REPLACE FUNCTION public.admin_adjust_master(
  p_master TEXT,
  p_amount BIGINT,
  p_topup BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_master public.accounts%ROWTYPE;
  v_new_bal BIGINT;
  v_tx_id TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_master
  FROM public.accounts
  WHERE (id = p_master OR display_id = p_master)
  FOR UPDATE;

  IF NOT FOUND OR v_master.role <> 'master' THEN
    RAISE EXCEPTION 'MASTER_NOT_FOUND';
  END IF;

  IF p_topup THEN
    v_new_bal := v_master.balance + p_amount;
  ELSE
    v_new_bal := GREATEST(0, v_master.balance - p_amount);
  END IF;

  UPDATE public.accounts SET balance = v_new_bal WHERE id = v_master.id;

  v_tx_id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.transaction_log (
    id, master_id, cashier_id, player_id, kind, amount,
    master_balance_after, cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id, v_master.id, NULL, v_master.id,
    CASE WHEN p_topup THEN 'master_topup' ELSE 'master_deduct' END,
    p_amount, v_new_bal, NULL, v_new_bal,
    COALESCE(p_note, CASE WHEN p_topup THEN 'تعبئة عهدة ماستر من الإدارة' ELSE 'سحب عهدة ماستر من الإدارة' END)
  );

  RETURN jsonb_build_object('ok', true, 'master_balance', v_new_bal);
END;
$$;

-- دالة: تعبئة أو سحب عهدة كاشير من الإدارة العليا
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

  UPDATE public.accounts SET balance = v_new_bal WHERE id = v_cashier.id;

  v_tx_id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.transaction_log (
    id, master_id, cashier_id, player_id, kind, amount,
    master_balance_after, cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id, v_cashier.master_id, v_cashier.id, v_cashier.id,
    CASE WHEN p_topup THEN 'topup' ELSE 'deduct' END,
    p_amount, NULL, v_new_bal, v_new_bal,
    COALESCE(p_note, CASE WHEN p_topup THEN 'تعبئة عهدة من الإدارة' ELSE 'سحب عهدة من الإدارة' END)
  );

  RETURN jsonb_build_object('ok', true, 'cashier_balance', v_new_bal);
END;
$$;

-- دالة: الماستر يعبئ أو يسحب من عهدة الكاشير التابع له
CREATE OR REPLACE FUNCTION public.master_adjust_cashier(
  p_master TEXT,
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
  v_master public.accounts%ROWTYPE;
  v_cashier public.accounts%ROWTYPE;
  v_new_master_bal BIGINT;
  v_new_cashier_bal BIGINT;
  v_tx_id TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_master
  FROM public.accounts
  WHERE (id = p_master OR display_id = p_master)
  FOR UPDATE;

  IF NOT FOUND OR v_master.role <> 'master' THEN
    RAISE EXCEPTION 'MASTER_NOT_FOUND';
  END IF;
  IF NOT v_master.active THEN
    RAISE EXCEPTION 'MASTER_INACTIVE';
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

  IF v_cashier.master_id IS NULL OR v_cashier.master_id <> v_master.id THEN
    RAISE EXCEPTION 'NOT_YOUR_CASHIER';
  END IF;

  IF p_topup THEN
    IF NOT v_master.unlimited_float AND v_master.balance < p_amount THEN
      RAISE EXCEPTION 'INSUFFICIENT_FLOAT';
    END IF;

    IF v_master.unlimited_float THEN
      v_new_master_bal := v_master.balance;
    ELSE
      v_new_master_bal := v_master.balance - p_amount;
    END IF;
    v_new_cashier_bal := v_cashier.balance + p_amount;
  ELSE
    IF v_cashier.balance < p_amount THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;
    v_new_cashier_bal := v_cashier.balance - p_amount;
    v_new_master_bal := v_master.balance + p_amount;
  END IF;

  UPDATE public.accounts SET balance = v_new_master_bal WHERE id = v_master.id;
  UPDATE public.accounts SET balance = v_new_cashier_bal WHERE id = v_cashier.id;

  v_tx_id := 'tx_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.transaction_log (
    id, master_id, cashier_id, player_id, kind, amount,
    master_balance_after, cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id, v_master.id, v_cashier.id, v_cashier.id,
    CASE WHEN p_topup THEN 'master_fund_cashier' ELSE 'master_recall_cashier' END,
    p_amount, v_new_master_bal, v_new_cashier_bal, v_new_cashier_bal,
    COALESCE(p_note, CASE WHEN p_topup THEN 'تعبئة كاشير من الماستر' ELSE 'سحب من الكاشير إلى الماستر' END)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'master_balance', v_new_master_bal,
    'cashier_balance', v_new_cashier_bal
  );
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
    id, master_id, cashier_id, player_id, kind, amount,
    master_balance_after, cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id, v_cashier.master_id, v_cashier.id, v_player.id, 'deposit',
    p_amount, NULL, v_new_cashier_bal, v_new_player_bal,
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
    id, master_id, cashier_id, player_id, kind, amount,
    master_balance_after, cashier_balance_after, player_balance_after, note
  )
  VALUES (
    v_tx_id, v_cashier.master_id, v_cashier.id, v_player.id, 'withdraw',
    p_amount, NULL, v_new_cashier_bal, v_new_player_bal,
    COALESCE(p_note, 'سحب من اللاعب')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cashier_balance', v_new_cashier_bal,
    'player_balance', v_new_player_bal
  );
END;
$$;

-- دالة: تطبيق فروقات رصيد الألعاب السريعة دفعة واحدة (apply_game_deltas)
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
-- 9. دوال نداءات المحفظة للألعاب الخارجية (Gateway RPCs)
-- ----------------------------------------------------------------------------

-- فحص رصيد اللاعب
CREATE OR REPLACE FUNCTION public.gw_balance(
  p_game TEXT,
  p_player TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_player public.accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_player
  FROM public.accounts
  WHERE (id = p_player OR display_id = p_player) AND role = 'player';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'player_id', v_player.id,
    'display_id', v_player.display_id,
    'balance', v_player.balance,
    'currency', v_player.currency
  );
END;
$$;

-- خصم رهان من رصيد اللاعب
CREATE OR REPLACE FUNCTION public.gw_debit(
  p_game TEXT,
  p_player TEXT,
  p_amount BIGINT,
  p_tx_ref TEXT,
  p_round_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_player public.accounts%ROWTYPE;
  v_new_bal BIGINT;
  v_rnd_id TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_player
  FROM public.accounts
  WHERE (id = p_player OR display_id = p_player) AND role = 'player'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF v_player.balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
  END IF;

  v_new_bal := v_player.balance - p_amount;
  UPDATE public.accounts SET balance = v_new_bal WHERE id = v_player.id;

  v_rnd_id := 'rnd_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.game_rounds (
    id, game_id, player_id, round_ref, tx_ref, action, amount, balance_after
  ) VALUES (
    v_rnd_id, p_game, v_player.id, p_round_ref, p_tx_ref, 'debit', p_amount, v_new_bal
  );

  RETURN jsonb_build_object(
    'ok', true,
    'balance', v_new_bal,
    'tx_id', v_rnd_id
  );
END;
$$;

-- إضافة ربح إلى رصيد اللاعب
CREATE OR REPLACE FUNCTION public.gw_credit(
  p_game TEXT,
  p_player TEXT,
  p_amount BIGINT,
  p_tx_ref TEXT,
  p_round_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_player public.accounts%ROWTYPE;
  v_new_bal BIGINT;
  v_rnd_id TEXT;
BEGIN
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  SELECT * INTO v_player
  FROM public.accounts
  WHERE (id = p_player OR display_id = p_player) AND role = 'player'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  v_new_bal := v_player.balance + p_amount;
  UPDATE public.accounts SET balance = v_new_bal WHERE id = v_player.id;

  v_rnd_id := 'rnd_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.game_rounds (
    id, game_id, player_id, round_ref, tx_ref, action, amount, balance_after
  ) VALUES (
    v_rnd_id, p_game, v_player.id, p_round_ref, p_tx_ref, 'credit', p_amount, v_new_bal
  );

  RETURN jsonb_build_object(
    'ok', true,
    'balance', v_new_bal,
    'tx_id', v_rnd_id
  );
END;
$$;

-- استرجاع حركة رهان أو إلغاؤها (Rollback)
CREATE OR REPLACE FUNCTION public.gw_rollback(
  p_game TEXT,
  p_target_ref TEXT,
  p_tx_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_prev public.game_rounds%ROWTYPE;
  v_player public.accounts%ROWTYPE;
  v_new_bal BIGINT;
  v_rnd_id TEXT;
BEGIN
  SELECT * INTO v_prev
  FROM public.game_rounds
  WHERE game_id = p_game AND (tx_ref = p_target_ref OR round_ref = p_target_ref OR id = p_target_ref)
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;

  SELECT * INTO v_player
  FROM public.accounts
  WHERE id = v_prev.player_id
  FOR UPDATE;

  IF v_prev.action = 'debit' THEN
    v_new_bal := v_player.balance + v_prev.amount;
  ELSIF v_prev.action = 'credit' THEN
    v_new_bal := GREATEST(0, v_player.balance - v_prev.amount);
  ELSE
    RAISE EXCEPTION 'CANNOT_ROLLBACK_ACTION';
  END IF;

  UPDATE public.accounts SET balance = v_new_bal WHERE id = v_player.id;

  v_rnd_id := 'rnd_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  INSERT INTO public.game_rounds (
    id, game_id, player_id, round_ref, tx_ref, action, amount, balance_after
  ) VALUES (
    v_rnd_id, p_game, v_player.id, v_prev.round_ref, p_tx_ref, 'rollback', v_prev.amount, v_new_bal
  );

  RETURN jsonb_build_object(
    'ok', true,
    'balance', v_new_bal,
    'rollback_tx_id', v_rnd_id
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. التحصين الأمني وسياسات RLS (Row Level Security)
-- ----------------------------------------------------------------------------
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_anomalies ENABLE ROW LEVEL SECURITY;

-- حظر الوصول المباشر من الأدوار العامة (anon / authenticated) على الجداول الحساسة
REVOKE ALL ON TABLE public.accounts FROM anon, authenticated;
REVOKE ALL ON TABLE public.transaction_log FROM anon, authenticated;
REVOKE ALL ON TABLE public.commission_tiers FROM anon, authenticated;
REVOKE ALL ON TABLE public.site_secrets FROM anon, authenticated;
REVOKE ALL ON TABLE public.games FROM anon, authenticated;
REVOKE ALL ON TABLE public.game_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.game_rounds FROM anon, authenticated;
REVOKE ALL ON TABLE public.balance_anomalies FROM anon, authenticated;

-- منح كامل الصلاحيات لخادم Node.js المحمي (service_role)
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;

-- سياسات الوصول الشاملة للـ service_role
DROP POLICY IF EXISTS "service_role_accounts" ON public.accounts;
CREATE POLICY "service_role_accounts" ON public.accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_tx" ON public.transaction_log;
CREATE POLICY "service_role_tx" ON public.transaction_log FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_tiers" ON public.commission_tiers;
CREATE POLICY "service_role_tiers" ON public.commission_tiers FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_secrets" ON public.site_secrets;
CREATE POLICY "service_role_secrets" ON public.site_secrets FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_games" ON public.games;
CREATE POLICY "service_role_games" ON public.games FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_sessions" ON public.game_sessions;
CREATE POLICY "service_role_sessions" ON public.game_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_rounds" ON public.game_rounds;
CREATE POLICY "service_role_rounds" ON public.game_rounds FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_anomalies" ON public.balance_anomalies;
CREATE POLICY "service_role_anomalies" ON public.balance_anomalies FOR ALL TO service_role USING (true) WITH CHECK (true);
