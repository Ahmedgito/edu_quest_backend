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

module.exports = { downloadTemplate, bulkRegistration };
