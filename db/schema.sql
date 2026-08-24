-- EduQuest schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','school','student')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  school_name TEXT NOT NULL,
  coordinator_name TEXT NOT NULL,
  designation TEXT NOT NULL,
  principal_name TEXT NOT NULL,
  principal_email TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  city TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT NOT NULL,
  class TEXT NOT NULL,
  school_name TEXT,
  city TEXT,
  whatsapp_number TEXT,
  school_id UUID REFERENCES schools(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  grade TEXT NOT NULL,
  grade_min INT,
  grade_max INT,
  subjects TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  start_date DATE,
  start_time TIME,
  end_time TIME,
  venue TEXT,
  fee NUMERIC(10,2) DEFAULT 0,
  registration_deadline DATE,
  duration TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Onboarding: bulk-created students must set a password and complete their profile on first login
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS country TEXT;

-- Backward-compatible migration: existing DBs may already have competitions(grade)
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS grade_min INT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS grade_max INT;

-- Best-effort backfill from grade text when it looks like "8" or "1-8"
UPDATE competitions
SET
  grade_min = COALESCE(
    grade_min,
    CASE
      WHEN grade ~ '^[0-9]+$' THEN grade::int
      WHEN grade ~ '^[0-9]+\\s*-\\s*[0-9]+$' THEN trim(split_part(grade, '-', 1))::int
      ELSE NULL
    END
  ),
  grade_max = COALESCE(
    grade_max,
    CASE
      WHEN grade ~ '^[0-9]+$' THEN grade::int
      WHEN grade ~ '^[0-9]+\\s*-\\s*[0-9]+$' THEN trim(split_part(grade, '-', 2))::int
      ELSE NULL
    END
  )
WHERE grade_min IS NULL OR grade_max IS NULL;

CREATE TABLE IF NOT EXISTS competition_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
  certificate_sent_at TIMESTAMPTZ,
  UNIQUE (competition_id, student_id)
);

-- Existing databases: add certificate tracking column
ALTER TABLE competition_participants ADD COLUMN IF NOT EXISTS certificate_sent_at TIMESTAMPTZ;

-- Podium awards. `award` is the admin's assignment (NULL = ordinary participant);
-- `certificate_type` records which certificate was actually emailed, so a podium
-- assigned after a participation certificate went out is detected as out of date.
ALTER TABLE competition_participants ADD COLUMN IF NOT EXISTS award TEXT;
ALTER TABLE competition_participants ADD COLUMN IF NOT EXISTS certificate_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competition_participants_award_check') THEN
    ALTER TABLE competition_participants
      ADD CONSTRAINT competition_participants_award_check
      CHECK (award IS NULL OR award IN ('first','second','third'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competition_participants_certificate_type_check') THEN
    ALTER TABLE competition_participants
      ADD CONSTRAINT competition_participants_certificate_type_check
      CHECK (certificate_type IS NULL OR certificate_type IN ('first','second','third','participation'));
  END IF;
END$$;

-- One holder per podium position, per competition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_unique_award
  ON competition_participants (competition_id, award)
  WHERE award IS NOT NULL;

-- Certificates sent before award tracking existed were participation certificates.
UPDATE competition_participants
SET certificate_type = 'participation'
WHERE certificate_sent_at IS NOT NULL AND certificate_type IS NULL;

-- Audit trail + idempotency for bulk student registration uploads
CREATE TABLE IF NOT EXISTS bulk_registration_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  filename TEXT,
  file_hash TEXT NOT NULL,
  total_records INT NOT NULL DEFAULT 0,
  successful_registrations INT NOT NULL DEFAULT 0,
  failed_registrations INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','partial','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bulk_registration_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES bulk_registration_batches(id) ON DELETE CASCADE,
  row_number INT,
  email TEXT,
  name TEXT,
  grade TEXT,
  status TEXT NOT NULL CHECK (status IN ('created','skipped_duplicate','failed')),
  error TEXT,
  student_id UUID REFERENCES students(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_batches_school ON bulk_registration_batches(school_id);
CREATE INDEX IF NOT EXISTS idx_bulk_batches_hash ON bulk_registration_batches(school_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_bulk_records_batch ON bulk_registration_records(batch_id);

CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- PAYMENTS
--
-- Payment is manual: the payer transfers to our bank account and uploads a
-- screenshot, which a human verifies in the admin panel. There is no gateway.
--
-- A payment covers one competition and one or more participants:
--   payer_type = 'student' → one self-registered student paying their own fee
--   payer_type = 'school'  → a coordinator paying for N of their students at once
-- ============================================================================

-- Bank details shown to payers. Single row (id = 1), edited by the admin.
CREATE TABLE IF NOT EXISTS payment_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bank_name TEXT NOT NULL DEFAULT '',
  account_title TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  iban TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'PKR',
  instructions TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  payer_type TEXT NOT NULL CHECK (payer_type IN ('student','school')),
  -- Exactly one of these is set, matching payer_type (enforced below).
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Amount actually claimed by the payer, and the per-head fee at submission
  -- time, so a later fee change cannot retroactively invalidate a payment.
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  unit_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  student_count INT NOT NULL DEFAULT 1 CHECK (student_count > 0),
  reference_code TEXT NOT NULL UNIQUE,
  payer_note TEXT,
  screenshot_path TEXT NOT NULL,
  screenshot_mime TEXT NOT NULL,
  screenshot_size INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
  rejection_reason TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_payer_shape CHECK (
    (payer_type = 'student' AND student_id IS NOT NULL AND school_id IS NULL)
    OR (payer_type = 'school' AND school_id IS NOT NULL AND student_id IS NULL)
  ),
  CONSTRAINT payments_rejection_reason CHECK (
    status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_competition ON payments(competition_id);
CREATE INDEX IF NOT EXISTS idx_payments_school ON payments(school_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);

-- Registration carries its own payment state so eligibility can be read off a
-- single row. 'not_required' is used for free competitions.
ALTER TABLE competition_participants
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE competition_participants
  ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competition_participants_payment_status_check') THEN
    ALTER TABLE competition_participants
      ADD CONSTRAINT competition_participants_payment_status_check
      CHECK (payment_status IN ('not_required','pending_payment','submitted','verified','rejected'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_participants_payment_status ON competition_participants(payment_status);

-- Only one payment may be in flight (or already accepted) per student per
-- competition; rejected attempts stay for audit and allow a fresh submission.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_active_per_student
  ON payments (competition_id, student_id)
  WHERE payer_type = 'student' AND status IN ('submitted','verified');

-- Site-wide announcement banner. Single row (id = 1) edited from the admin panel.
-- All announcement content comes from a live competition: `competition_id` pins a
-- specific one, or NULL means "whichever competition is next up".
CREATE TABLE IF NOT EXISTS announcement_banner (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  heading TEXT NOT NULL DEFAULT 'IMPORTANT ANNOUNCEMENT',
  competition_id UUID REFERENCES competitions(id) ON DELETE SET NULL,
  cta_label TEXT NOT NULL DEFAULT 'View Details',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing databases: the banner used to hold hand-typed title/detail text.
-- Content is now always read from the competitions table, so drop the stale copies.
ALTER TABLE announcement_banner ADD COLUMN IF NOT EXISTS competition_id UUID REFERENCES competitions(id) ON DELETE SET NULL;
ALTER TABLE announcement_banner DROP COLUMN IF EXISTS title;
ALTER TABLE announcement_banner DROP COLUMN IF EXISTS items;
ALTER TABLE announcement_banner DROP COLUMN IF EXISTS cta_url;
ALTER TABLE announcement_banner ALTER COLUMN cta_label SET DEFAULT 'View Details';
UPDATE announcement_banner SET cta_label = 'View Details' WHERE cta_label IS NULL OR btrim(cta_label) = '';
ALTER TABLE announcement_banner ALTER COLUMN cta_label SET NOT NULL;

INSERT INTO announcement_banner (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_students_school_id ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions(status);
CREATE INDEX IF NOT EXISTS idx_competitions_grade ON competitions(grade);
CREATE INDEX IF NOT EXISTS idx_competitions_grade_min ON competitions(grade_min);
CREATE INDEX IF NOT EXISTS idx_competitions_grade_max ON competitions(grade_max);
CREATE INDEX IF NOT EXISTS idx_participants_competition_id ON competition_participants(competition_id);

-- Contest identity artwork attached to a competition (numerava, lexivara, ...).
-- Stored as a slug; the frontend maps it to the badge image.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS logo TEXT;

-- Downloadable study material (syllabus / manual / preparation guide) attached
-- to a competition. The file itself lives in uploads/materials and is streamed
-- through the public download route; only its metadata is stored here.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS material_path TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS material_name TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS material_mime TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS material_size INT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS material_label TEXT;
