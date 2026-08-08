const { query } = require('../db');
const { ok, fail } = require('../utils/response');
const svc = require('../services/bulkRegistrationService');

const PASSWORD_POLICY =
  'A strong temporary password is auto-generated per student and returned once in this response. Store it securely and have students change it on first login.';

const downloadTemplate = async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="students_template.csv"');
    return res.status(200).send(svc.TEMPLATE);
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

    const dryRun = String(req.query.mode || '').toLowerCase() === 'validate';
    const hash = svc.fileHash(req.file.buffer);

    // Idempotency (commit only): the exact same file already produced a batch.
    if (!dryRun) {
      let prior = { rows: [] };
      try {
        prior = await query(
          `SELECT id, total_records, successful_registrations, failed_registrations, status
             FROM bulk_registration_batches
            WHERE school_id = $1 AND file_hash = $2 AND status IN ('completed','partial')
            ORDER BY created_at DESC LIMIT 1`,
          [school.id, hash]
        );
      } catch (e) {
        // Audit table may not exist yet; idempotency is best-effort.
        console.error('Idempotency lookup skipped:', e.message);
      }
      if (prior.rows[0]) {
        const b = prior.rows[0];
        return ok(res, {
          alreadyProcessed: true,
          batchId: b.id,
          status: b.status,
          totalRecords: b.total_records,
          successfulRegistrations: b.successful_registrations,
          failedRegistrations: b.failed_registrations,
          errors: [],
          warnings: [{
            type: 'duplicate_upload',
            message: 'This exact file was already processed. No new accounts were created. Reset a student\'s password to re-issue credentials.'
          }],
          credentials: [],
          success: b.failed_registrations === 0
        }, 'Duplicate upload detected');
      }
    }

    const report = await svc.process({ buffer: req.file.buffer, school, dryRun });
    if (report.headerError) {
      return fail(res, 400, report.headerError);
    }

    // Validation-only (dry run): no accounts created, nothing persisted.
    if (dryRun) {
      return ok(res, {
        mode: 'validate',
        status: 'validated',
        totalRecords: report.totalRecords,
        validRecords: report.validCount,
        invalidRecords: report.rowErrors.length,
        errors: report.rowErrors,
        warnings: report.warnings,
        credentials: [],
        success: report.rowErrors.length === 0
      }, 'Validation complete');
    }

    const failedCount = report.rowErrors.length + report.skipped.length + report.failed.length;
    const status = report.created.length === 0
      ? 'failed'
      : (failedCount > 0 ? 'partial' : 'completed');

    // Persist audit batch (best-effort; must not block a successful registration).
    let batchId = null;
    try {
      batchId = await svc.recordBatch({
        school,
        uploadedBy: req.user.id,
        filename: req.file.originalname,
        hash,
        report,
        status
      });
    } catch (e) {
      console.error('Bulk registration audit persistence failed:', e.message);
    }

    return ok(res, {
      batchId,
      status,
      totalRecords: report.totalRecords,
      successfulRegistrations: report.created.length,
      failedRegistrations: failedCount,
      errors: [...report.rowErrors, ...report.skipped, ...report.failed],
      warnings: report.warnings,
      credentials: report.created.map((c) => ({
        row: c.row,
        name: c.name,
        email: c.email,
        temporaryPassword: c.temporaryPassword
      })),
      success: report.created.length > 0 && failedCount === 0,
      passwordPolicy: PASSWORD_POLICY
    }, 'Bulk registration processed');
  } catch (err) {
    return next(err);
  }
};

/**
 * Roster for the signed-in school: every student it registered, their account
 * state, and the competitions they are currently entered in.
 *
 * "Account status" reflects onboarding, not existence — a bulk-created student
 * has a login from day one but is only `active` once they have set their own
 * password and completed their profile.
 */
const listSchoolStudents = async (req, res, next) => {
  try {
    const schoolResult = await query('SELECT id, school_name FROM schools WHERE user_id = $1', [req.user.id]);
    if (schoolResult.rowCount === 0) {
      return fail(res, 404, 'School profile not found');
    }
    const school = schoolResult.rows[0];

    const { search, status, grade } = req.query;
    const params = [school.id];
    const where = ['s.school_id = $1'];

    if (grade) {
      params.push(String(grade));
      where.push(`s.class = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(COALESCE(s.name,'') ILIKE $${params.length} OR s.email ILIKE $${params.length})`);
    }
    if (status && ['active', 'pending', 'disabled'].includes(status)) {
      if (status === 'disabled') {
        where.push('u.is_active = FALSE');
      } else if (status === 'pending') {
        where.push('u.is_active = TRUE AND (u.must_change_password = TRUE OR s.profile_completed = FALSE)');
      } else {
        where.push('u.is_active = TRUE AND u.must_change_password = FALSE AND s.profile_completed = TRUE');
      }
    }

    const result = await query(
      `SELECT
         s.id, s.name, s.email, s.class, s.city, s.whatsapp_number,
         s.profile_completed, s.created_at,
         u.is_active, u.must_change_password, u.created_at AS account_created_at,
         CASE
           WHEN u.is_active = FALSE THEN 'disabled'
           WHEN u.must_change_password = TRUE OR s.profile_completed = FALSE THEN 'pending'
           ELSE 'active'
         END AS account_status,
         COALESCE(upcoming.items, '[]'::json) AS competitions,
         COALESCE(upcoming.active_count, 0) AS active_competitions,
         COALESCE(upcoming.unpaid_count, 0) AS unpaid_competitions,
         COALESCE(lifetime.total_count, 0) AS total_competitions
       FROM students s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN LATERAL (
         SELECT
           json_agg(json_build_object(
             'competitionId', c.id,
             'title', c.title,
             'code', c.code,
             'startDate', c.start_date,
             'fee', c.fee,
             'paymentStatus', cp.payment_status
           ) ORDER BY c.start_date ASC) AS items,
           COUNT(*)::int AS active_count,
           COUNT(*) FILTER (WHERE cp.payment_status IN ('pending_payment','rejected'))::int AS unpaid_count
         FROM competition_participants cp
         JOIN competitions c ON c.id = cp.competition_id
         WHERE cp.student_id = s.id
           AND NOT (c.start_date IS NOT NULL AND c.start_date < CURRENT_DATE)
       ) upcoming ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS total_count
         FROM competition_participants cp
         WHERE cp.student_id = s.id
       ) lifetime ON TRUE
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(NULLIF(BTRIM(s.name), ''), s.email) ASC`,
      params
    );

    // Totals describe the whole roster, so the cards do not move when filtering.
    const summaryResult = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE u.is_active = FALSE)::int AS disabled,
         COUNT(*) FILTER (
           WHERE u.is_active = TRUE AND (u.must_change_password = TRUE OR s.profile_completed = FALSE)
         )::int AS pending,
         COUNT(*) FILTER (
           WHERE u.is_active = TRUE AND u.must_change_password = FALSE AND s.profile_completed = TRUE
         )::int AS active
       FROM students s
       JOIN users u ON u.id = s.user_id
       WHERE s.school_id = $1`,
      [school.id]
    );

    return ok(res, {
      school: { id: school.id, name: school.school_name },
      items: result.rows,
      summary: summaryResult.rows[0]
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = { downloadTemplate, bulkRegistration, listSchoolStudents };
