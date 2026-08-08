const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { ok, created, fail } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const {
  saveScreenshot,
  deleteScreenshot,
  resolveScreenshotPath,
  screenshotExists
} = require('../services/paymentScreenshotStorage');

/**
 * Manual payment workflow.
 *
 * Registration and payment are separate: a student joins immediately and their
 * participant row carries the payment state. Free competitions register as
 * 'not_required'; paid ones start at 'pending_payment' and move
 * submitted → verified | rejected as an admin reviews the screenshot.
 *
 * A participant is confirmed when payment_status is 'not_required' or 'verified'.
 */

const CONFIRMED_STATUSES = ['not_required', 'verified'];

/** Human-friendly code the payer quotes in the bank transfer. */
const generateReferenceCode = () => {
  // Ambiguous characters (0/O, 1/I) left out so the code survives being read
  // off a screen and typed into a banking app.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `EQ-${body}`;
};

/** Insert with a fresh code, retrying the (vanishingly rare) collision. */
const insertPaymentWithReference = async (client, columns, values) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const reference = generateReferenceCode();
      const params = [...values, reference];
      const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
      const result = await client.query(
        `INSERT INTO payments (${columns.join(',')},reference_code)
         VALUES (${placeholders}) RETURNING *`,
        params
      );
      return result.rows[0];
    } catch (err) {
      // 23505 = unique_violation. Only the reference code is worth retrying;
      // any other unique clash is a real conflict the caller must see.
      if (err.code === '23505' && String(err.constraint || '').includes('reference_code')) continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a payment reference code');
};

const feeOf = (competition) => Number(competition.fee || 0);
const isPaid = (competition) => feeOf(competition) > 0;

/** Registration state a new participant row should start in. */
const initialPaymentStatus = (competition) => (isPaid(competition) ? 'pending_payment' : 'not_required');

// ============================================================================
// Shared: bank details
// ============================================================================

const getPaymentSettings = async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO payment_settings (id) VALUES (1)
       ON CONFLICT (id) DO UPDATE SET id = 1
       RETURNING *`
    );
    return ok(res, result.rows[0]);
  } catch (err) {
    return next(err);
  }
};

const updatePaymentSettings = async (req, res, next) => {
  try {
    const fields = req.body || {};
    const columns = {
      bankName: 'bank_name',
      accountTitle: 'account_title',
      accountNumber: 'account_number',
      iban: 'iban',
      branch: 'branch',
      currency: 'currency',
      instructions: 'instructions'
    };

    const set = [];
    const params = [];
    Object.entries(columns).forEach(([key, column]) => {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        set.push(`${column} = $${params.length}`);
      }
    });

    if (set.length === 0) {
      return fail(res, 400, 'No valid fields to update');
    }

    await query('INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    const result = await query(
      `UPDATE payment_settings SET ${set.join(', ')}, updated_at = NOW() WHERE id = 1 RETURNING *`,
      params
    );
    return ok(res, result.rows[0], 'Payment settings updated');
  } catch (err) {
    return next(err);
  }
};

// ============================================================================
// Student
// ============================================================================

/** Competitions this student has joined that still owe a payment. */
const studentDuePayments = async (req, res, next) => {
  try {
    const studentRes = await query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
    if (studentRes.rowCount === 0) return fail(res, 404, 'Profile not found');
    const studentId = studentRes.rows[0].id;

    const result = await query(
      `SELECT c.id AS competition_id, c.code, c.title, c.fee, c.start_date, c.registration_deadline,
              cp.payment_status, cp.joined_at,
              p.id AS payment_id, p.status AS payment_state, p.reference_code, p.amount,
              p.rejection_reason, p.created_at AS submitted_at, p.payer_type
       FROM competition_participants cp
       JOIN competitions c ON c.id = cp.competition_id
       LEFT JOIN payments p ON p.id = cp.payment_id
       WHERE cp.student_id = $1
       ORDER BY cp.joined_at DESC`,
      [studentId]
    );

    return ok(res, result.rows);
  } catch (err) {
    return next(err);
  }
};

const submitStudentPayment = async (req, res, next) => {
  let stored;
  try {
    const { competitionId, amount, payerNote } = req.body || {};

    const studentRes = await query('SELECT id, school_id FROM students WHERE user_id = $1', [req.user.id]);
    if (studentRes.rowCount === 0) return fail(res, 404, 'Profile not found');
    const student = studentRes.rows[0];

    // id is a uuid and code is text, so the parameter is compared as text against
    // both — binding it straight to the uuid column breaks the code lookup.
    const compRes = await query('SELECT * FROM competitions WHERE id::text = $1 OR code = $1', [competitionId]);
    if (compRes.rowCount === 0) return fail(res, 404, 'Competition not found');
    const competition = compRes.rows[0];

    if (!isPaid(competition)) {
      return fail(res, 400, 'This competition is free — no payment is required');
    }

    const participantRes = await query(
      'SELECT * FROM competition_participants WHERE competition_id = $1 AND student_id = $2',
      [competition.id, student.id]
    );
    if (participantRes.rowCount === 0) {
      return fail(res, 400, 'Join the competition before submitting a payment');
    }
    const participant = participantRes.rows[0];

    if (participant.payment_status === 'verified') {
      return fail(res, 400, 'Your payment for this competition is already verified');
    }
    if (participant.payment_status === 'submitted') {
      return fail(res, 400, 'A payment is already awaiting verification for this competition');
    }
    // A student covered by their school's payment must not pay again.
    if (participant.payment_id) {
      const coveringRes = await query('SELECT payer_type, status FROM payments WHERE id = $1', [
        participant.payment_id
      ]);
      const covering = coveringRes.rows[0];
      if (covering && covering.payer_type === 'school' && covering.status !== 'rejected') {
        return fail(res, 400, 'Your school has submitted a payment covering you for this competition');
      }
    }

    // The event being over is the real cut-off — a student who registered
    // before the deadline may still settle up afterwards.
    if (competition.start_date) {
      const ended = await query('SELECT ($1::date < CURRENT_DATE) AS ended', [competition.start_date]);
      if (ended.rows[0]?.ended) {
        return fail(res, 400, 'This competition has already taken place');
      }
    }

    stored = await saveScreenshot(req.file);

    const payment = await withTransaction(async (client) => {
      const row = await insertPaymentWithReference(
        client,
        [
          'competition_id',
          'payer_type',
          'student_id',
          'submitted_by',
          'amount',
          'unit_fee',
          'student_count',
          'payer_note',
          'screenshot_path',
          'screenshot_mime',
          'screenshot_size'
        ],
        [
          competition.id,
          'student',
          student.id,
          req.user.id,
          amount,
          feeOf(competition),
          1,
          payerNote || null,
          stored.path,
          stored.mime,
          stored.size
        ]
      );

      await client.query(
        `UPDATE competition_participants
         SET payment_status = 'submitted', payment_id = $1
         WHERE competition_id = $2 AND student_id = $3`,
        [row.id, competition.id, student.id]
      );

      return row;
    });

    return created(res, payment, 'Payment submitted for verification');
  } catch (err) {
    // Never leave an orphan file behind if the database write failed.
    if (stored) await deleteScreenshot(stored.path);
    if (err.code === '23505') {
      return fail(res, 409, 'A payment for this competition is already awaiting verification');
    }
    return next(err);
  }
};

// ============================================================================
// School
// ============================================================================

const getSchoolForUser = async (userId) => {
  const result = await query('SELECT id, school_name, status FROM schools WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
};

/** This school's students who have joined a competition and still owe payment. */
const schoolPayableStudents = async (req, res, next) => {
  try {
    const school = await getSchoolForUser(req.user.id);
    if (!school) return fail(res, 404, 'School profile not found');

    const { competitionId } = req.query;
    const params = [school.id];
    let competitionFilter = '';
    if (competitionId) {
      params.push(competitionId);
      competitionFilter = `AND c.id = $${params.length}`;
    }

    const result = await query(
      `SELECT c.id AS competition_id, c.code, c.title, c.fee, c.start_date, c.registration_deadline,
              s.id AS student_id, s.name, s.email, s.class,
              cp.payment_status, cp.joined_at,
              p.reference_code, p.status AS payment_state, p.rejection_reason
       FROM competition_participants cp
       JOIN students s ON s.id = cp.student_id
       JOIN competitions c ON c.id = cp.competition_id
       LEFT JOIN payments p ON p.id = cp.payment_id
       WHERE s.school_id = $1
         AND c.fee > 0
         AND NOT (c.start_date IS NOT NULL AND c.start_date < CURRENT_DATE)
         ${competitionFilter}
       ORDER BY c.start_date ASC NULLS LAST, s.name ASC`,
      params
    );

    return ok(res, result.rows);
  } catch (err) {
    return next(err);
  }
};

const schoolPayments = async (req, res, next) => {
  try {
    const school = await getSchoolForUser(req.user.id);
    if (!school) return fail(res, 404, 'School profile not found');

    const result = await query(
      `SELECT p.*, c.title AS competition_title, c.code AS competition_code
       FROM payments p
       JOIN competitions c ON c.id = p.competition_id
       WHERE p.school_id = $1
       ORDER BY p.created_at DESC`,
      [school.id]
    );
    return ok(res, result.rows);
  } catch (err) {
    return next(err);
  }
};

const submitSchoolPayment = async (req, res, next) => {
  let stored;
  try {
    const { competitionId, amount, payerNote } = req.body || {};
    let { studentIds } = req.body || {};

    // multipart/form-data cannot express arrays natively; accept JSON or repeats.
    if (typeof studentIds === 'string') {
      try {
        studentIds = JSON.parse(studentIds);
      } catch {
        studentIds = studentIds.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return fail(res, 400, 'Select at least one student to pay for');
    }
    studentIds = [...new Set(studentIds)];

    const school = await getSchoolForUser(req.user.id);
    if (!school) return fail(res, 404, 'School profile not found');

    // id is a uuid and code is text, so the parameter is compared as text against
    // both — binding it straight to the uuid column breaks the code lookup.
    const compRes = await query('SELECT * FROM competitions WHERE id::text = $1 OR code = $1', [competitionId]);
    if (compRes.rowCount === 0) return fail(res, 404, 'Competition not found');
    const competition = compRes.rows[0];

    if (!isPaid(competition)) {
      return fail(res, 400, 'This competition is free — no payment is required');
    }
    if (competition.start_date) {
      const ended = await query('SELECT ($1::date < CURRENT_DATE) AS ended', [competition.start_date]);
      if (ended.rows[0]?.ended) {
        return fail(res, 400, 'This competition has already taken place');
      }
    }

    // Every selected student must belong to this school, be registered for the
    // competition, and not already be covered by a live payment.
    const eligible = await query(
      `SELECT cp.student_id, cp.payment_status
       FROM competition_participants cp
       JOIN students s ON s.id = cp.student_id
       WHERE cp.competition_id = $1
         AND s.school_id = $2
         AND cp.student_id = ANY($3::uuid[])`,
      [competition.id, school.id, studentIds]
    );

    if (eligible.rowCount !== studentIds.length) {
      return fail(res, 400, 'Some selected students are not your school\'s registered participants for this competition');
    }

    const alreadyCovered = eligible.rows.filter((r) => ['submitted', 'verified'].includes(r.payment_status));
    if (alreadyCovered.length > 0) {
      return fail(
        res,
        400,
        `${alreadyCovered.length} selected student(s) already have a payment awaiting verification or verified`
      );
    }

    stored = await saveScreenshot(req.file);

    const payment = await withTransaction(async (client) => {
      const row = await insertPaymentWithReference(
        client,
        [
          'competition_id',
          'payer_type',
          'school_id',
          'submitted_by',
          'amount',
          'unit_fee',
          'student_count',
          'payer_note',
          'screenshot_path',
          'screenshot_mime',
          'screenshot_size'
        ],
        [
          competition.id,
          'school',
          school.id,
          req.user.id,
          amount,
          feeOf(competition),
          studentIds.length,
          payerNote || null,
          stored.path,
          stored.mime,
          stored.size
        ]
      );

      // Re-check inside the transaction so two coordinators submitting at once
      // cannot both claim the same students.
      const claimed = await client.query(
        `UPDATE competition_participants
         SET payment_status = 'submitted', payment_id = $1
         WHERE competition_id = $2
           AND student_id = ANY($3::uuid[])
           AND payment_status IN ('pending_payment','rejected')
         RETURNING student_id`,
        [row.id, competition.id, studentIds]
      );

      if (claimed.rowCount !== studentIds.length) {
        const err = new Error('Some selected students were claimed by another payment. Refresh and try again.');
        err.status = 409;
        throw err;
      }

      return row;
    });

    return created(res, payment, 'Payment submitted for verification');
  } catch (err) {
    if (stored) await deleteScreenshot(stored.path);
    if (err.status === 409) return fail(res, 409, err.message);
    return next(err);
  }
};

// ============================================================================
// Admin
// ============================================================================

const listPayments = async (req, res, next) => {
  try {
    const { status, competitionId, schoolId, payerType, search } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = [];
    const params = [];
    const push = (clause, value) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (status) push('p.status = $?', status);
    if (competitionId) push('p.competition_id = $?', competitionId);
    if (schoolId) push('p.school_id = $?', schoolId);
    if (payerType) push('p.payer_type = $?', payerType);
    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(p.reference_code ILIKE $${params.length}
          OR c.title ILIKE $${params.length}
          OR c.code ILIKE $${params.length}
          OR sch.school_name ILIKE $${params.length}
          OR st.name ILIKE $${params.length}
          OR st.email ILIKE $${params.length})`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `
      FROM payments p
      JOIN competitions c ON c.id = p.competition_id
      LEFT JOIN schools sch ON sch.id = p.school_id
      LEFT JOIN students st ON st.id = p.student_id
    `;

    const totalResult = await query(`SELECT COUNT(*)::int AS count ${from} ${whereSql}`, params);
    const listResult = await query(
      `SELECT p.*,
              c.title AS competition_title, c.code AS competition_code, c.fee AS competition_fee,
              c.start_date AS competition_date,
              sch.school_name, sch.city AS school_city,
              st.name AS student_name, st.email AS student_email, st.class AS student_class,
              st.school_name AS student_school_name,
              reviewer.email AS reviewed_by_email
       ${from}
       LEFT JOIN users reviewer ON reviewer.id = p.reviewed_by
       ${whereSql}
       ORDER BY
         CASE p.status WHEN 'submitted' THEN 0 ELSE 1 END,
         p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const counts = await query(
      `SELECT status, COUNT(*)::int AS count FROM payments GROUP BY status`
    );
    const summary = counts.rows.reduce(
      (acc, row) => ({ ...acc, [row.status]: row.count }),
      { submitted: 0, verified: 0, rejected: 0 }
    );

    return ok(res, {
      items: listResult.rows,
      summary,
      pagination: {
        page,
        limit,
        total: totalResult.rows[0].count,
        totalPages: Math.ceil(totalResult.rows[0].count / limit)
      }
    });
  } catch (err) {
    return next(err);
  }
};

/** One payment plus every registration it covers. */
const getPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT p.*,
              c.title AS competition_title, c.code AS competition_code, c.fee AS competition_fee,
              c.start_date AS competition_date, c.venue AS competition_venue,
              sch.school_name, sch.city AS school_city, sch.coordinator_name,
              st.name AS student_name, st.email AS student_email, st.class AS student_class,
              st.school_name AS student_school_name,
              submitter.email AS submitted_by_email,
              reviewer.email AS reviewed_by_email
       FROM payments p
       JOIN competitions c ON c.id = p.competition_id
       LEFT JOIN schools sch ON sch.id = p.school_id
       LEFT JOIN students st ON st.id = p.student_id
       LEFT JOIN users submitter ON submitter.id = p.submitted_by
       LEFT JOIN users reviewer ON reviewer.id = p.reviewed_by
       WHERE p.id = $1`,
      [id]
    );
    if (result.rowCount === 0) return fail(res, 404, 'Payment not found');

    const covered = await query(
      `SELECT cp.student_id, cp.payment_status, s.name, s.email, s.class, s.school_name
       FROM competition_participants cp
       JOIN students s ON s.id = cp.student_id
       WHERE cp.payment_id = $1
       ORDER BY s.name ASC`,
      [id]
    );

    return ok(res, {
      ...result.rows[0],
      coveredStudents: covered.rows,
      screenshotAvailable: screenshotExists(result.rows[0].screenshot_path)
    });
  } catch (err) {
    return next(err);
  }
};

/** Stream the screenshot to the admin. Never served from a public directory. */
const getPaymentScreenshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT screenshot_path, screenshot_mime FROM payments WHERE id = $1', [id]);
    if (result.rowCount === 0) return fail(res, 404, 'Payment not found');

    const { screenshot_path: storedName, screenshot_mime: mime } = result.rows[0];
    if (!screenshotExists(storedName)) {
      return fail(res, 404, 'Screenshot file is missing from storage');
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(resolveScreenshotPath(storedName));
  } catch (err) {
    return next(err);
  }
};

/**
 * Approve or reject. The status guard in the UPDATE makes this safe when two
 * admins open the same payment: the second one is told it was already reviewed
 * instead of silently overwriting the first decision.
 */
const reviewPayment = (decision) => async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    if (decision === 'rejected' && !String(reason || '').trim()) {
      return fail(res, 400, 'A rejection reason is required');
    }

    const result = await withTransaction(async (client) => {
      const paymentRes = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
      if (paymentRes.rowCount === 0) {
        return { error: { status: 404, message: 'Payment not found' } };
      }
      const payment = paymentRes.rows[0];
      if (payment.status !== 'submitted') {
        return {
          error: {
            status: 409,
            message: `This payment was already ${payment.status}${
              payment.reviewed_at ? ` on ${new Date(payment.reviewed_at).toISOString().slice(0, 10)}` : ''
            }`
          }
        };
      }

      const updated = await client.query(
        `UPDATE payments
         SET status = $1,
             rejection_reason = $2,
             reviewed_by = $3,
             reviewed_at = NOW(),
             updated_at = NOW()
         WHERE id = $4 AND status = 'submitted'
         RETURNING *`,
        [decision, decision === 'rejected' ? String(reason).trim() : null, req.user.id, id]
      );

      // Registrations covered by this payment follow its verdict.
      const participants = await client.query(
        `UPDATE competition_participants
         SET payment_status = $1
         WHERE payment_id = $2
         RETURNING student_id`,
        [decision, id]
      );

      return { payment: updated.rows[0], affected: participants.rowCount };
    });

    if (result.error) return fail(res, result.error.status, result.error.message);

    return ok(
      res,
      { ...result.payment, affectedParticipants: result.affected },
      decision === 'verified'
        ? `Payment verified — ${result.affected} registration(s) confirmed`
        : `Payment rejected — ${result.affected} registration(s) returned to unpaid`
    );
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  CONFIRMED_STATUSES,
  initialPaymentStatus,
  isPaid,
  getPaymentSettings,
  updatePaymentSettings,
  studentDuePayments,
  submitStudentPayment,
  schoolPayableStudents,
  schoolPayments,
  submitSchoolPayment,
  listPayments,
  getPayment,
  getPaymentScreenshot,
  verifyPayment: reviewPayment('verified'),
  rejectPayment: reviewPayment('rejected')
};
