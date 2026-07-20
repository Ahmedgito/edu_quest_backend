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
