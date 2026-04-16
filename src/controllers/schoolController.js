const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { env } = require('../config/env');
const { ok, fail } = require('../utils/response');

const template = 'name,email,class,whatsappNumber,city\n';
const REQUIRED_HEADERS = ['name', 'email', 'class', 'whatsappNumber', 'city'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHATSAPP_REGEX = /^\+?[0-9]{7,15}$/;

const normalizeHeader = (header) => String(header || '').trim();
const normalizeCell = (value) => String(value || '').trim();

const parseCsvHeaders = (buffer) => {
  const rows = parse(buffer, {
    bom: true,
    to_line: 1,
    skip_empty_lines: true
  });
  if (!rows || rows.length === 0 || !Array.isArray(rows[0])) {
    return [];
  }
  return rows[0].map(normalizeHeader);
};

const generateTemporaryPassword = () => {
  const random = crypto.randomBytes(4).toString('hex');
  return `Eq!${random}A1`;
};

const downloadTemplate = async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="students_template.csv"');
    return res.status(200).send(template);
  } catch (err) {
    return next(err);
  }
};

const bulkRegistration = async (req, res, next) => {
  try {
    if (!req.file) {
      return fail(res, 400, 'CSV file is required');
    }

    const schoolResult = await query('SELECT id, school_name, status FROM schools WHERE user_id = $1', [req.user.id]);
    if (schoolResult.rowCount === 0) {
      return fail(res, 404, 'School profile not found');
    }
    const school = schoolResult.rows[0];
    if (school.status !== 'approved') {
      return fail(res, 403, 'School is not approved');
    }

    const headers = parseCsvHeaders(req.file.buffer);
    const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
    const extraHeaders = headers.filter((header) => !REQUIRED_HEADERS.includes(header));

    if (headers.length === 0) {
      return fail(res, 400, 'CSV header is missing or invalid');
    }

    if (missingHeaders.length > 0) {
      return fail(res, 400, `CSV is missing required header(s): ${missingHeaders.join(', ')}`);
    }

    const records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });

    if (!records.length) {
      return fail(res, 400, 'CSV has no student rows');
    }

    let successful = 0;
    const errors = [];
    const warnings = [];
    const credentials = [];
    const seenEmailsInFile = new Set();
    const normalizedRows = [];

    for (let i = 0; i < records.length; i += 1) {
      const row = records[i];
      const rowNumber = i + 2; // account for header

      const normalized = {
        rowNumber,
        name: normalizeCell(row.name),
        email: normalizeCell(row.email).toLowerCase(),
        grade: normalizeCell(row.class),
        whatsappNumber: normalizeCell(row.whatsappNumber),
        city: normalizeCell(row.city)
      };

      if (!normalized.name) {
        errors.push({ row: rowNumber, email: normalized.email || '', error: 'Missing required field: name' });
        continue;
      }

      if (!normalized.email) {
        errors.push({ row: rowNumber, email: '', error: 'Missing required field: email' });
        continue;
      }

      if (!EMAIL_REGEX.test(normalized.email)) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Invalid email format' });
        continue;
      }

      if (!normalized.grade) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Missing required field: class' });
        continue;
      }

      if (!/^\d+$/.test(normalized.grade)) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Class must be a numeric grade between 1 and 12' });
        continue;
      }

      const gradeNumber = Number(normalized.grade);
      if (gradeNumber < 1 || gradeNumber > 12) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Class must be between 1 and 12' });
        continue;
      }

      if (!normalized.city) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Missing required field: city' });
        continue;
      }

      if (normalized.whatsappNumber && !WHATSAPP_REGEX.test(normalized.whatsappNumber)) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Invalid whatsappNumber format' });
        continue;
      }

      if (seenEmailsInFile.has(normalized.email)) {
        errors.push({ row: rowNumber, email: normalized.email, error: 'Duplicate email in uploaded CSV' });
        continue;
      }

      seenEmailsInFile.add(normalized.email);
      normalizedRows.push(normalized);
    }

    const distinctEmails = [...seenEmailsInFile];
    const existingEmailsInSystem = new Set();
    if (distinctEmails.length > 0) {
      const existingResult = await query(
        'SELECT LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])',
        [distinctEmails]
      );
      existingResult.rows.forEach((item) => existingEmailsInSystem.add(item.email));
    }

    for (let i = 0; i < normalizedRows.length; i += 1) {
      const student = normalizedRows[i];
      if (existingEmailsInSystem.has(student.email)) {
        errors.push({ row: student.rowNumber, email: student.email, error: 'Email already exists in system' });
        continue;
      }

      const tempPassword = generateTemporaryPassword();
      const hash = await bcrypt.hash(tempPassword, env.bcryptSaltRounds);

      try {
        const userResult = await query(
          'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
          [student.email, hash, 'student']
        );

        await query(
          'INSERT INTO students (user_id, name, email, class, school_name, city, whatsapp_number, school_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            userResult.rows[0].id,
            student.name,
            student.email,
            student.grade,
            school.school_name,
            student.city,
            student.whatsappNumber || null,
            school.id
          ]
        );

        credentials.push({
          row: student.rowNumber,
          name: student.name,
          email: student.email,
          temporaryPassword: tempPassword
        });

        successful += 1;
      } catch (insertError) {
        if (insertError && insertError.code === '23505') {
          errors.push({ row: student.rowNumber, email: student.email, error: 'Email already exists in system' });
          continue;
        }
        throw insertError;
      }
    }

    if (extraHeaders.length > 0) {
      warnings.push({
        type: 'extra_headers',
        message: `Extra header(s) ignored: ${extraHeaders.join(', ')}`
      });
    }

    return ok(res, {
      success: true,
      totalRecords: records.length,
      successfulRegistrations: successful,
      failedRegistrations: errors.length,
      errors,
      warnings,
      credentials,
      passwordPolicy: 'A strong temporary password is auto-generated per student and returned once in this response.'
    }, 'Bulk registration processed');
  } catch (err) {
    return next(err);
  }
};

module.exports = { downloadTemplate, bulkRegistration };
