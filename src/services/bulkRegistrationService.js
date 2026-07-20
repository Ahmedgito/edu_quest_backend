const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const { query, withTransaction } = require('../db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TEMPLATE = 'name,email,class,whatsappNumber,city\n';

// Canonical output field per accepted header spelling. Keys are compared
// case-insensitively with spaces/underscores stripped, so "WhatsApp Number",
// "whatsapp_number" and "whatsappnumber" all map to the same field.
const HEADER_MAP = {
  name: 'name',
  studentname: 'name',
  email: 'email',
  emailaddress: 'email',
  class: 'grade',
  grade: 'grade',
  whatsappnumber: 'whatsappNumber',
  whatsapp: 'whatsappNumber',
  phone: 'whatsappNumber',
  mobile: 'whatsappNumber',
  city: 'city'
};

// Fields that must be present as columns in the header row.
const REQUIRED_FIELDS = ['name', 'email', 'grade', 'whatsappNumber', 'city'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHATSAPP_REGEX = /^\+?[0-9]{7,15}$/;
const MAX_ROWS = 1000; // synchronous safety cap; larger files must be split
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const normalize = (value) => String(value ?? '').trim();

const canonicalHeaderKey = (header) => {
  const key = String(header || '').toLowerCase().replace(/[\s_]+/g, '');
  return HEADER_MAP[key] || null;
};

const fileHash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const generateTemporaryPassword = () => {
  const random = crypto.randomBytes(4).toString('hex');
  return `Eq!${random}A1`;
};

/**
 * Guard against CSV/formula injection: values beginning with =, +, -, @, tab or
 * CR are prefixed with a quote so spreadsheet apps treat them as text.
 */
const sanitizeForCsv = (value) => {
  const s = String(value ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------
/**
 * Parse the CSV buffer into canonical rows, validating headers first.
 * Returns { headerError, mappedFields, extraHeaders, dataRows }.
 * Never throws for row-level issues; throws a tagged 400 only for a file that
 * cannot be parsed at all.
 */
const parseCsv = (buffer) => {
  let rows;
  try {
    rows = parse(buffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true, // tolerate ragged rows; we validate per field
      trim: true
    });
  } catch (e) {
    throw httpError(400, 'CSV could not be parsed. Ensure it is a valid comma-separated file.');
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { headerError: 'CSV header is missing or invalid', mappedFields: [], extraHeaders: [], dataRows: [] };
  }

  const rawHeaders = rows[0].map(normalize);
  const mappedFields = rawHeaders.map(canonicalHeaderKey);
  const extraHeaders = rawHeaders.filter((_, i) => mappedFields[i] === null);

  // Duplicate mapped columns (e.g. both "phone" and "whatsappNumber") are ambiguous.
  const present = mappedFields.filter(Boolean);
  const duplicates = present.filter((field, i) => present.indexOf(field) !== i);
  if (duplicates.length > 0) {
    return {
      headerError: `Duplicate column(s) for: ${[...new Set(duplicates)].join(', ')}`,
      mappedFields, extraHeaders, dataRows: []
    };
  }

  const missing = REQUIRED_FIELDS.filter((field) => !present.includes(field));
  if (missing.length > 0) {
    // Report using the template's header spelling for clarity.
    const label = { name: 'name', email: 'email', grade: 'class', whatsappNumber: 'whatsappNumber', city: 'city' };
    return {
      headerError: `CSV is missing required header(s): ${missing.map((m) => label[m]).join(', ')}`,
      mappedFields, extraHeaders, dataRows: []
    };
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return { headerError: 'CSV has no student rows', mappedFields, extraHeaders, dataRows: [] };
  }
  if (dataRows.length > MAX_ROWS) {
    return {
      headerError: `File has ${dataRows.length} rows which exceeds the limit of ${MAX_ROWS}. Split it into smaller files.`,
      mappedFields, extraHeaders, dataRows: []
    };
  }

  return { headerError: null, mappedFields, extraHeaders, dataRows };
};

const buildRow = (cells, mappedFields, rowNumber) => {
  const record = { rowNumber, name: '', email: '', grade: '', whatsappNumber: '', city: '' };
  mappedFields.forEach((field, i) => {
    if (field) record[field] = normalize(cells[i]);
  });
  record.email = record.email.toLowerCase();
  return record;
};

const isEmptyRow = (record) =>
  !record.name && !record.email && !record.grade && !record.whatsappNumber && !record.city;

/**
 * Validate a single normalized row. Returns an error message or null.
 * Also normalizes grade in-place ("07" -> "7").
 */
const validateRow = (row) => {
  if (!row.name) return 'Missing required field: name';
  if (row.name.length > MAX_NAME_LENGTH) return `Name exceeds ${MAX_NAME_LENGTH} characters`;
  if (!row.email) return 'Missing required field: email';
  if (row.email.length > MAX_EMAIL_LENGTH) return 'Email is too long';
  if (!EMAIL_REGEX.test(row.email)) return 'Invalid email format';
  if (!row.grade) return 'Missing required field: class';
  if (!/^\d+$/.test(row.grade)) return 'Class must be a numeric grade between 1 and 12';
  const gradeNumber = Number(row.grade);
  if (gradeNumber < 1 || gradeNumber > 12) return 'Class must be between 1 and 12';
  row.grade = String(gradeNumber); // normalize "07" -> "7"
  if (!row.city) return 'Missing required field: city';
  if (row.whatsappNumber && !WHATSAPP_REGEX.test(row.whatsappNumber)) return 'Invalid whatsappNumber format';
  return null;
};

/**
 * Parse + validate the whole file. Returns:
 * { headerError, totalRecords, validRows, rowErrors, extraHeaders }
 */
const validateFile = (buffer) => {
  const { headerError, mappedFields, extraHeaders, dataRows } = parseCsv(buffer);
  if (headerError) {
    return { headerError, totalRecords: 0, validRows: [], rowErrors: [], extraHeaders };
  }

  const validRows = [];
  const rowErrors = [];
  const seenEmails = new Set();
  let totalRecords = 0;

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 2; // +1 for header, +1 for 1-based
    const row = buildRow(cells, mappedFields, rowNumber);

    if (isEmptyRow(row)) return; // silently skip blank lines

    totalRecords += 1;

    const error = validateRow(row);
    if (error) {
      rowErrors.push({ row: rowNumber, email: row.email, error });
      return;
    }
    if (seenEmails.has(row.email)) {
      rowErrors.push({ row: rowNumber, email: row.email, error: 'Duplicate email in uploaded CSV' });
      return;
    }
    seenEmails.add(row.email);
    validRows.push(row);
  });

  return { headerError: null, totalRecords, validRows, rowErrors, extraHeaders };
};

// ---------------------------------------------------------------------------
// Account creation (atomic per student)
// ---------------------------------------------------------------------------
const createStudents = async (school, validRows) => {
  const created = [];
  const skipped = [];
  const failed = [];

  const emails = validRows.map((r) => r.email);
  const existing = new Set();
  if (emails.length > 0) {
    const { rows } = await query(
      'SELECT LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])',
      [emails]
    );
    rows.forEach((r) => existing.add(r.email));
  }

  for (const row of validRows) {
    if (existing.has(row.email)) {
      skipped.push({ row: row.rowNumber, email: row.email, error: 'Email already exists in system' });
      continue;
    }

    const temporaryPassword = generateTemporaryPassword();
    try {
      const hash = await bcrypt.hash(temporaryPassword, env.bcryptSaltRounds);
      // Atomic: user + student created together or not at all (no orphaned users).
      const studentId = await withTransaction(async (client) => {
        // Bulk accounts get a temp password → must change it on first login,
        // and must complete their profile before using the platform.
        const userResult = await client.query(
          'INSERT INTO users (email, password_hash, role, must_change_password) VALUES ($1, $2, $3, TRUE) RETURNING id',
          [row.email, hash, 'student']
        );
        const studentResult = await client.query(
          `INSERT INTO students (user_id, name, email, class, school_name, city, whatsapp_number, school_id, profile_completed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE) RETURNING id`,
          [userResult.rows[0].id, row.name, row.email, row.grade, school.school_name, row.city, row.whatsappNumber || null, school.id]
        );
        return studentResult.rows[0].id;
      });

      existing.add(row.email);
      created.push({
        row: row.rowNumber,
        name: row.name,
        email: row.email,
        grade: row.grade,
        temporaryPassword,
        studentId
      });
    } catch (e) {
      if (e && e.code === '23505') {
        // Lost the race to a concurrent insert of the same email.
        skipped.push({ row: row.rowNumber, email: row.email, error: 'Email already exists in system' });
      } else {
        console.error(`Bulk registration row ${row.rowNumber} failed:`, e.message);
        failed.push({ row: row.rowNumber, email: row.email, error: 'Could not create account' });
      }
    }
  }

  return { created, skipped, failed };
};

// ---------------------------------------------------------------------------
// Audit persistence
// ---------------------------------------------------------------------------
const recordBatch = async ({ school, uploadedBy, filename, hash, report, status }) => {
  return withTransaction(async (client) => {
    const batchResult = await client.query(
      `INSERT INTO bulk_registration_batches
         (school_id, uploaded_by, filename, file_hash, total_records, successful_registrations, failed_registrations, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW()) RETURNING id`,
      [
        school.id,
        uploadedBy || null,
        filename || null,
        hash,
        report.totalRecords,
        report.created.length,
        report.rowErrors.length + report.skipped.length + report.failed.length,
        status
      ]
    );
    const batchId = batchResult.rows[0].id;

    const recordRows = [
      ...report.created.map((r) => ({ ...r, status: 'created' })),
      ...report.skipped.map((r) => ({ ...r, status: 'skipped_duplicate' })),
      ...report.failed.map((r) => ({ ...r, status: 'failed' })),
      ...report.rowErrors.map((r) => ({ ...r, status: 'failed' }))
    ];

    for (const r of recordRows) {
      await client.query(
        `INSERT INTO bulk_registration_records (batch_id, row_number, email, name, grade, status, error, student_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batchId, r.row || null, r.email || null, r.name || null, r.grade || null, r.status, r.error || null, r.studentId || null]
      );
    }

    return batchId;
  });
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * Validate (and optionally create). Returns a normalized report object; the
 * controller shapes the HTTP response and persists the audit batch.
 */
const process = async ({ buffer, school, dryRun }) => {
  const { headerError, totalRecords, validRows, rowErrors, extraHeaders } = validateFile(buffer);
  if (headerError) {
    return { headerError, totalRecords: 0, validRows: [], rowErrors: [], extraHeaders: [], created: [], skipped: [], failed: [] };
  }

  const warnings = [];
  if (extraHeaders.length > 0) {
    warnings.push({ type: 'extra_headers', message: `Extra header(s) ignored: ${extraHeaders.join(', ')}` });
  }

  if (dryRun) {
    return { headerError: null, totalRecords, validCount: validRows.length, rowErrors, warnings, created: [], skipped: [], failed: [] };
  }

  const { created, skipped, failed } = await createStudents(school, validRows);
  return { headerError: null, totalRecords, validCount: validRows.length, rowErrors, warnings, created, skipped, failed };
};

module.exports = {
  TEMPLATE,
  MAX_ROWS,
  fileHash,
  sanitizeForCsv,
  validateFile,
  process,
  recordBatch
};
