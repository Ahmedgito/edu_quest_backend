const { parse } = require('csv-parse/sync');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { env } = require('../config/env');
const { ok, fail } = require('../utils/response');

const template = 'name,email,class,whatsappNumber,city\n';

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

    const records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    let successful = 0;
    const errors = [];

    for (let i = 0; i < records.length; i += 1) {
      const row = records[i];
      const rowNumber = i + 2; // account for header

      const name = row.name || null;
      const email = row.email;
      const grade = row.class;
      const whatsappNumber = row.whatsappNumber || null;
      const city = row.city || null;

      if (!email || !grade) {
        errors.push({ row: rowNumber, email: email || '', error: 'Missing required fields (email, class)' });
        continue;
      }

      const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rowCount > 0) {
        errors.push({ row: rowNumber, email, error: 'Email already exists' });
        continue;
      }

      const tempPassword = uuidv4().slice(0, 8) + '!';
      const hash = await bcrypt.hash(tempPassword, env.bcryptSaltRounds);

      const userResult = await query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
        [email, hash, 'student']
      );

      await query(
        'INSERT INTO students (user_id, name, email, class, school_name, city, whatsapp_number, school_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [userResult.rows[0].id, name, email, grade, school.school_name, city, whatsappNumber, school.id]
      );

      successful += 1;
    }

    return ok(res, {
      success: true,
      totalRecords: records.length,
      successfulRegistrations: successful,
      failedRegistrations: errors.length,
      errors
    }, 'Bulk registration processed');
  } catch (err) {
    return next(err);
  }
};

module.exports = { downloadTemplate, bulkRegistration };
