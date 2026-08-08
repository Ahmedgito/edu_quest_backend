const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { env } = require('../config/env');
const { ok, fail } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { initialPaymentStatus } = require('./paymentController');

const getProfile = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.* FROM students s
       WHERE s.user_id = $1`,
      [req.user.id]
    );
    if (result.rowCount === 0) {
      return fail(res, 404, 'Profile not found');
    }
    return ok(res, result.rows[0]);
  } catch (err) {
    return next(err);
  }
};

// First-login step 1: replace the temporary bulk password with the student's own.
const setPassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    const hash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2',
      [hash, req.user.id]
    );
    return ok(res, { mustChangePassword: false }, 'Password updated');
  } catch (err) {
    return next(err);
  }
};

// First-login step 2: fill in the profile fields collected at individual registration.
const completeProfile = async (req, res, next) => {
  try {
    const { name, class: grade, schoolName, city, whatsappNumber, country } = req.body;
    const result = await query(
      `UPDATE students SET
         name = COALESCE($1, name),
         class = COALESCE($2, class),
         school_name = COALESCE($3, school_name),
         city = COALESCE($4, city),
         whatsapp_number = COALESCE($5, whatsapp_number),
         country = COALESCE($6, country),
         profile_completed = TRUE,
         updated_at = NOW()
       WHERE user_id = $7 RETURNING *`,
      [name || null, grade || null, schoolName || null, city || null, whatsappNumber || null, country || null, req.user.id]
    );
    if (result.rowCount === 0) {
      return fail(res, 404, 'Profile not found');
    }
    return ok(res, result.rows[0], 'Profile completed');
  } catch (err) {
    return next(err);
  }
};

/**
 * Update the signed-in student's own profile. Only the fields present in the
 * body are touched, so the settings screen can send partial updates.
 *
 * Email is not editable here (it is the login identity), and a student attached
 * to a school cannot rewrite their school name — that link is the school's to
 * manage.
 */
const updateProfile = async (req, res, next) => {
  try {
    const fields = req.body || {};

    const existing = await query('SELECT id, school_id FROM students WHERE user_id = $1', [req.user.id]);
    if (existing.rowCount === 0) {
      return fail(res, 404, 'Profile not found');
    }
    const isSchoolLinked = Boolean(existing.rows[0].school_id);

    const set = [];
    const params = [];
    const pushSet = (col, val) => {
      params.push(val);
      set.push(`${col} = $${params.length}`);
    };

    if (fields.name !== undefined) pushSet('name', fields.name);
    if (fields.class !== undefined) pushSet('class', fields.class);
    if (fields.city !== undefined) pushSet('city', fields.city);
    if (fields.country !== undefined) pushSet('country', fields.country || null);
    if (fields.whatsappNumber !== undefined) pushSet('whatsapp_number', fields.whatsappNumber);

    if (fields.schoolName !== undefined) {
      if (isSchoolLinked) {
        return fail(res, 400, 'Your school is managed by your school coordinator and cannot be changed here');
      }
      pushSet('school_name', fields.schoolName || null);
    }

    if (set.length === 0) {
      return fail(res, 400, 'No valid fields to update');
    }

    params.push(req.user.id);
    const result = await query(
      `UPDATE students SET ${set.join(', ')}, updated_at = NOW() WHERE user_id = $${params.length} RETURNING *`,
      params
    );

    return ok(res, result.rows[0], 'Profile updated');
  } catch (err) {
    return next(err);
  }
};

/** Change password from the settings screen — the current one must be proved. */
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rowCount === 0) {
      return fail(res, 404, 'User not found');
    }

    const matches = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!matches) {
      return fail(res, 400, 'Current password is incorrect');
    }

    if (currentPassword === newPassword) {
      return fail(res, 400, 'New password must be different from the current one');
    }

    const hash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2',
      [hash, req.user.id]
    );

    return ok(res, { changed: true }, 'Password changed');
  } catch (err) {
    return next(err);
  }
};

const myCompetitions = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, cp.payment_status, cp.payment_id, p.reference_code, p.rejection_reason
       FROM competition_participants cp
       JOIN students s ON s.id = cp.student_id
       JOIN competitions c ON c.id = cp.competition_id
       LEFT JOIN payments p ON p.id = cp.payment_id
       WHERE s.user_id = $1
       ORDER BY cp.joined_at DESC`,
      [req.user.id]
    );
    return ok(res, result.rows);
  } catch (err) {
    return next(err);
  }
};

const availableCompetitions = async (req, res, next) => {
  try {
    const profileResult = await query('SELECT id, class FROM students WHERE user_id = $1', [req.user.id]);
    if (profileResult.rowCount === 0) {
      return fail(res, 404, 'Profile not found');
    }

    const { class: grade } = profileResult.rows[0];
    const gradeInt = Number.parseInt(String(grade), 10);
    if (Number.isNaN(gradeInt)) {
      return fail(res, 400, 'Invalid student grade');
    }
    const { search, subject } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const params = [gradeInt];
    let where = `WHERE c.status = 'active'
      -- Only competitions still open for registration: deadline not passed and event not over
      AND (c.registration_deadline IS NULL OR c.registration_deadline >= CURRENT_DATE)
      AND (c.start_date IS NULL OR c.start_date >= CURRENT_DATE)
      AND (
      ($1 BETWEEN c.grade_min AND c.grade_max)
      OR (
        c.grade_min IS NULL AND c.grade_max IS NULL AND (
          (c.grade ~ '^[0-9]+$' AND c.grade::int = $1)
          OR (c.grade ~ '^[0-9]+\\s*-\\s*[0-9]+$' AND $1 BETWEEN trim(split_part(c.grade, '-', 1))::int AND trim(split_part(c.grade, '-', 2))::int)
        )
      )
    )`;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.title ILIKE $${params.length} OR c.code ILIKE $${params.length})`;
    }

    if (subject) {
      params.push(subject);
      where += ` AND $${params.length} = ANY (c.subjects)`;
    }

    params.push(req.user.id);
    const exclusionClause = `AND c.id NOT IN (SELECT competition_id FROM competition_participants cp
                        JOIN students s ON s.id = cp.student_id
                        WHERE s.user_id = $${params.length})`;

    const totalResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM competitions c
       ${where}
       ${exclusionClause}`,
      params
    );

    const listResult = await query(
      `SELECT c.* FROM competitions c
       ${where}
       ${exclusionClause}
       ORDER BY c.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return ok(res, {
      items: listResult.rows,
      pagination: { page, limit, total: totalResult.rows[0].count, totalPages: Math.ceil(totalResult.rows[0].count / limit) }
    });
  } catch (err) {
    return next(err);
  }
};

const joinCompetition = async (req, res, next) => {
  try {
    const { id } = req.params;

    const studentResult = await query('SELECT id, class FROM students WHERE user_id = $1', [req.user.id]);
    if (studentResult.rowCount === 0) {
      return fail(res, 404, 'Profile not found');
    }

    const student = studentResult.rows[0];
    const competitionResult = await query('SELECT * FROM competitions WHERE code = $1 OR id::text = $1', [id]);
    if (competitionResult.rowCount === 0) {
      return fail(res, 404, 'Competition not found');
    }

    const competition = competitionResult.rows[0];
    const competitionId = competition.id;
    if (competition.status !== 'active') {
      return fail(res, 400, 'Competition is not open');
    }

    if (competition.registration_deadline && new Date(competition.registration_deadline) < new Date()) {
      return fail(res, 400, 'Registration deadline has passed');
    }

    if (competition.start_date && new Date(competition.start_date) < new Date(new Date().toDateString())) {
      return fail(res, 400, 'This competition has already taken place');
    }

    const studentGradeInt = Number.parseInt(String(student.class), 10);
    if (Number.isNaN(studentGradeInt)) {
      return fail(res, 400, 'Invalid student grade');
    }

    let min = competition.grade_min;
    let max = competition.grade_max;
    if (min == null || max == null) {
      const raw = String(competition.grade || '').trim();
      const single = raw.match(/^\\d+$/);
      const range = raw.match(/^(\\d+)\\s*-\\s*(\\d+)$/);
      if (single) {
        min = Number(raw);
        max = Number(raw);
      } else if (range) {
        min = Number(range[1]);
        max = Number(range[2]);
      }
    }

    if (min == null || max == null || studentGradeInt < min || studentGradeInt > max) {
      const eligibleText = min != null && max != null ? (min === max ? `Grade ${min}` : `Grades ${min}-${max}`) : 'the eligible grade level';
      return fail(res, 400, `You are not eligible for this competition. Eligible: ${eligibleText}`);
    }

    const existing = await query(
      'SELECT id, payment_status FROM competition_participants WHERE competition_id = $1 AND student_id = $2',
      [competitionId, student.id]
    );
    if (existing.rowCount > 0) {
      return ok(
        res,
        {
          alreadyJoined: true,
          competitionId,
          fee: Number(competition.fee || 0),
          paymentStatus: existing.rows[0].payment_status
        },
        'Already joined'
      );
    }

    // The seat is held straight away; a paid competition then waits on the
    // student's payment screenshot being verified by an admin.
    const paymentStatus = initialPaymentStatus(competition);
    await query(
      'INSERT INTO competition_participants (competition_id, student_id, payment_status) VALUES ($1, $2, $3)',
      [competitionId, student.id, paymentStatus]
    );

    return ok(
      res,
      {
        competitionId,
        fee: Number(competition.fee || 0),
        paymentStatus,
        paymentRequired: paymentStatus === 'pending_payment'
      },
      paymentStatus === 'pending_payment'
        ? 'Registered — submit your payment to confirm your seat'
        : 'Registration successful'
    );
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getProfile,
  setPassword,
  changePassword,
  completeProfile,
  updateProfile,
  myCompetitions,
  availableCompetitions,
  joinCompetition
};
