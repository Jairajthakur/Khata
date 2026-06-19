-- KhataBill PostgreSQL Schema
-- Run this file to set up the entire database

-- ─────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────
-- USERS / BUSINESSES
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(150) NOT NULL,
  email           VARCHAR(150) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  mobile          VARCHAR(15),
  whatsapp_number VARCHAR(15),
  plan            VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free','pro','annual')),
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS businesses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  gstin           VARCHAR(15) UNIQUE,
  pan             VARCHAR(10),
  business_type   VARCHAR(50) DEFAULT 'retail',
  gst_scheme      VARCHAR(30) DEFAULT 'regular' CHECK (gst_scheme IN ('regular','composition')),
  address         TEXT,
  city            VARCHAR(100),
  state_code      VARCHAR(5) DEFAULT '27',
  state_name      VARCHAR(50) DEFAULT 'Maharashtra',
  pincode         VARCHAR(6),
  gstin_verified  BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- PARTIES (Customers & Suppliers)
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS parties (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  mobile          VARCHAR(15),
  gstin           VARCHAR(15),
  pan             VARCHAR(10),
  party_type      VARCHAR(20) NOT NULL CHECK (party_type IN ('customer','supplier','both')),
  address         TEXT,
  city            VARCHAR(100),
  state_code      VARCHAR(5),
  opening_balance NUMERIC(15,2) DEFAULT 0,
  balance_type    VARCHAR(10) DEFAULT 'credit' CHECK (balance_type IN ('credit','debit')),
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- INVOICES
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_id        UUID REFERENCES parties(id),
  invoice_number  VARCHAR(50) NOT NULL,
  invoice_type    VARCHAR(20) DEFAULT 'sale' CHECK (invoice_type IN ('sale','purchase','credit_note','debit_note')),
  invoice_date    DATE NOT NULL,
  due_date        DATE,
  place_of_supply VARCHAR(5),
  is_igst         BOOLEAN DEFAULT FALSE,
  subtotal        NUMERIC(15,2) DEFAULT 0,
  discount_amount NUMERIC(15,2) DEFAULT 0,
  taxable_amount  NUMERIC(15,2) DEFAULT 0,
  igst_amount     NUMERIC(15,2) DEFAULT 0,
  cgst_amount     NUMERIC(15,2) DEFAULT 0,
  sgst_amount     NUMERIC(15,2) DEFAULT 0,
  total_tax       NUMERIC(15,2) DEFAULT 0,
  total_amount    NUMERIC(15,2) DEFAULT 0,
  paid_amount     NUMERIC(15,2) DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'unpaid' CHECK (status IN ('paid','unpaid','partial','overdue','cancelled')),
  notes           TEXT,
  gstr1_filed     BOOLEAN DEFAULT FALSE,
  gstr1_period    VARCHAR(7),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  hsn_sac         VARCHAR(10),
  quantity        NUMERIC(10,3) DEFAULT 1,
  unit            VARCHAR(20) DEFAULT 'pcs',
  rate            NUMERIC(15,2) NOT NULL,
  discount_pct    NUMERIC(5,2) DEFAULT 0,
  taxable_amount  NUMERIC(15,2) NOT NULL,
  gst_rate        NUMERIC(5,2) DEFAULT 18,
  igst_amount     NUMERIC(15,2) DEFAULT 0,
  cgst_amount     NUMERIC(15,2) DEFAULT 0,
  sgst_amount     NUMERIC(15,2) DEFAULT 0,
  total_amount    NUMERIC(15,2) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- EXPENSES
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_id        UUID REFERENCES parties(id),
  expense_date    DATE NOT NULL,
  category        VARCHAR(50) NOT NULL,
  description     TEXT,
  vendor_name     VARCHAR(200),
  vendor_gstin    VARCHAR(15),
  vendor_invoice  VARCHAR(100),
  amount          NUMERIC(15,2) NOT NULL,
  gst_rate        NUMERIC(5,2) DEFAULT 0,
  gst_amount      NUMERIC(15,2) DEFAULT 0,
  total_amount    NUMERIC(15,2) NOT NULL,
  itc_eligible    BOOLEAN DEFAULT FALSE,
  gstr2a_matched  BOOLEAN DEFAULT FALSE,
  payment_mode    VARCHAR(20) DEFAULT 'cash' CHECK (payment_mode IN ('cash','upi','bank','cheque','credit')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- KHATA (Cash Book / Ledger)
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS khata_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  party_id        UUID REFERENCES parties(id),
  entry_date      DATE NOT NULL,
  entry_type      VARCHAR(10) NOT NULL CHECK (entry_type IN ('credit','debit')),
  amount          NUMERIC(15,2) NOT NULL,
  description     TEXT,
  reference_type  VARCHAR(20),
  reference_id    UUID,
  balance_after   NUMERIC(15,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- GST RETURNS
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS gst_returns (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  return_type     VARCHAR(20) NOT NULL CHECK (return_type IN ('GSTR-1','GSTR-3B','GSTR-9','GSTR-4')),
  period          VARCHAR(7) NOT NULL,
  financial_year  VARCHAR(7),
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','draft','filed','rejected')),
  arn             VARCHAR(50),
  filed_on        TIMESTAMPTZ,
  due_date        DATE,
  taxable_amount  NUMERIC(15,2) DEFAULT 0,
  output_igst     NUMERIC(15,2) DEFAULT 0,
  output_cgst     NUMERIC(15,2) DEFAULT 0,
  output_sgst     NUMERIC(15,2) DEFAULT 0,
  itc_igst        NUMERIC(15,2) DEFAULT 0,
  itc_cgst        NUMERIC(15,2) DEFAULT 0,
  itc_sgst        NUMERIC(15,2) DEFAULT 0,
  net_igst        NUMERIC(15,2) DEFAULT 0,
  net_cgst        NUMERIC(15,2) DEFAULT 0,
  net_sgst        NUMERIC(15,2) DEFAULT 0,
  net_payable     NUMERIC(15,2) DEFAULT 0,
  late_fee        NUMERIC(15,2) DEFAULT 0,
  gsp_response    JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, return_type, period)
);

-- ─────────────────────────────────
-- PAYMENTS
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES invoices(id),
  party_id        UUID REFERENCES parties(id),
  payment_date    DATE NOT NULL,
  amount          NUMERIC(15,2) NOT NULL,
  payment_mode    VARCHAR(20) DEFAULT 'cash' CHECK (payment_mode IN ('cash','upi','bank','cheque','neft','rtgs')),
  reference       VARCHAR(100),
  notes           TEXT,
  payment_type    VARCHAR(10) DEFAULT 'received' CHECK (payment_type IN ('received','made')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- ITR FILINGS
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS itr_filings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  financial_year  VARCHAR(7) NOT NULL,
  itr_form        VARCHAR(10) DEFAULT 'ITR-4',
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','in_progress','filed','verified')),
  gross_turnover  NUMERIC(15,2) DEFAULT 0,
  presumptive_income NUMERIC(15,2) DEFAULT 0,
  deductions_80c  NUMERIC(15,2) DEFAULT 0,
  taxable_income  NUMERIC(15,2) DEFAULT 0,
  tax_payable     NUMERIC(15,2) DEFAULT 0,
  tds_amount      NUMERIC(15,2) DEFAULT 0,
  refund_amount   NUMERIC(15,2) DEFAULT 0,
  acknowledgement_no VARCHAR(50),
  filed_on        TIMESTAMPTZ,
  eri_response    JSONB,
  checklist       JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- ACTIVITY LOG
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  action          VARCHAR(100) NOT NULL,
  entity_type     VARCHAR(50),
  entity_id       UUID,
  description     TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- WHATSAPP SESSION LOG
-- ─────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID REFERENCES businesses(id) ON DELETE CASCADE,
  from_number     VARCHAR(20),
  to_number       VARCHAR(20),
  direction       VARCHAR(10) CHECK (direction IN ('inbound','outbound')),
  command         TEXT,
  response        TEXT,
  status          VARCHAR(20) DEFAULT 'sent',
  wa_message_id   VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────
-- INDEXES
-- ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_invoices_business    ON invoices(business_id);
CREATE INDEX IF NOT EXISTS idx_invoices_party       ON invoices(party_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date        ON invoices(invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status      ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_expenses_business    ON expenses(business_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date        ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_khata_business       ON khata_entries(business_id);
CREATE INDEX IF NOT EXISTS idx_khata_party          ON khata_entries(party_id);
CREATE INDEX IF NOT EXISTS idx_parties_business     ON parties(business_id);
CREATE INDEX IF NOT EXISTS idx_gst_returns_business ON gst_returns(business_id);
CREATE INDEX IF NOT EXISTS idx_payments_business    ON payments(business_id);
CREATE INDEX IF NOT EXISTS idx_activity_business    ON activity_log(business_id);
CREATE INDEX IF NOT EXISTS idx_activity_created     ON activity_log(created_at DESC);
