const { query, withTransaction } = require('../db');
const { ok, created, fail } = require('../utils/response');
const {
  withPricing,
  participantFeeSql,
  entryPricing,
  registrationWindow,
  todayForPricing
} = require('../utils/competitionPricing');

/**
 * School registration.
 *
 * A coordinator enters their students into one competition at a time by typing
 * each child's full name, father's name and class. No student login is
 * created: the student row has no user_id and no email, and the school pays
 * and is contacted on the child's behalf.
 *
 * Each entry locks its price at the moment it is made (see entryPricing), so
 * students added during Early Bird keep that price and students added later
 * pay the standard fee, whenever the school gets round to paying.
 */

const UNPAID_STATUSES = ['pending_payment', 'rejected'];
// Statuses an entry can still be corrected in; a payment under review or
// accepted freezes it.
const EDITABLE_STATUSES = ['pending_payment', 'rejected', 'not_required'];

const getSchoolForUser = async (userId) => {
  const result = await query(
    'SELECT id, school_name, city, status FROM schools WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
};

/** Load the signed-in school, failing the request when it may not register. */
const requireApprovedSchool = async (req, res) => {
  const school = await getSchoolForUser(req.user.id);
  if (!school) {
    fail(res, 404, 'School profile not found');
    return null;
  }
  if (school.status !== 'approved') {
    fail(res, 403, 'Your school account has not been approved yet');
    return null;
  }
  return school;
};

const findCompetition = async (idOrCode) => {
  // id is a uuid and code is text, so the parameter is compared as text against both.
  const result = await query('SELECT * FROM competitions WHERE id::text = $1 OR code = $1', [idOrCode]);
  return result.rows[0] ? withPricing(result.rows[0]) : null;
};

/** The competition's eligible grades, from grade_min/grade_max or its grade text. */
const gradeRange = (competition) => {
  let min = competition.grade_min;
  let max = competition.grade_max;
  if (min == null || max == null) {
    const raw = String(competition.grade || '').trim();
    const range = raw.match(/^(\d+)\s*-\s*(\d+)$/);
    if (/^\d+$/.test(raw)) {
      min = Number(raw);
      max = Number(raw);
    } else if (range) {
      min = Number(range[1]);
      max = Number(range[2]);
    }
  }
  return { min: min ?? 1, max: max ?? 12 };
};

/** Collapse runs of whitespace so "Ali  Khan " and "Ali Khan" are one person. */
const tidyName = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const nameKey = (fullName, fatherName) => `${tidyName(fullName).toLowerCase()}|${tidyName(fatherName).toLowerCase()}`;

/** Competition fields the school screens need, priced and with its registration window. */
const presentCompetition = (competition) => {
  const window = registrationWindow(competition);
  const { min, max } = gradeRange(competition);
  return {
    id: competition.id,
    code: competition.code,
    title: competition.title,
    description: competition.description,
    logo: competition.logo,
    subjects: competition.subjects,
    grade: competition.grade,
    grade_min: min,
    grade_max: max,
    start_date: competition.start_date,
    start_time: competition.start_time,
    end_time: competition.end_time,
    venue: competition.venue,
    registration_deadline: competition.registration_deadline,
    status: competition.status,
    fee: competition.fee,
    standard_fee: competition.standard_fee,
    early_bird_fee: competition.early_bird_fee,
    early_bird_deadline: competition.early_bird_deadline,
    early_bird_active: competition.early_bird_active,
    registration_open: window.open,
    registration_closed_reason: window.reason,
    ended: window.ended
  };
};

const ENTRY_COLUMNS = `
  s.id AS student_id, s.name, s.father_name, s.class, s.email,
  (s.user_id IS NOT NULL) AS has_account,
  cp.joined_at AS added_at,
  cp.payment_status, cp.fee_tier,
  (cp.unit_fee IS NULL) AS fee_unlocked,
  ${participantFeeSql('cp', 'c')} AS unit_fee,
  p.reference_code AS payment_reference, p.status AS payment_state, p.rejection_reason
`;

const ENTRY_FROM = `
  FROM competition_participants cp
  JOIN students s ON s.id = cp.student_id
  JOIN competitions c ON c.id = cp.competition_id
  LEFT JOIN payments p ON p.id = cp.payment_id
`;

/** Decorate an entry row with what the coordinator may still do to it. */
const presentEntry = (row, window) => {
  const unpaid = UNPAID_STATUSES.includes(row.payment_status);
  return {
    ...row,
    unit_fee: Number(row.unit_fee || 0),
    // Entries made before prices were locked carry no tier; describe them by
    // what they cost today.
    fee_tier: row.fee_tier || (Number(row.unit_fee || 0) > 0 ? 'standard' : 'free'),
    can_edit: !window.ended && !row.has_account && EDITABLE_STATUSES.includes(row.payment_status),
    // A free entry costs nothing to keep, so it can only be withdrawn while
    // registration is open; an unpaid one can be dropped until the event.
    can_remove: !window.ended && (unpaid || (row.payment_status === 'not_required' && window.open))
  };
};

const summarize = (entries) => {
  const unpaid = entries.filter((e) => UNPAID_STATUSES.includes(e.payment_status));
  return {
    total: entries.length,
    unpaid: unpaid.length,
    submitted: entries.filter((e) => e.payment_status === 'submitted').length,
    confirmed: entries.filter((e) => ['verified', 'not_required'].includes(e.payment_status)).length,
    amountDue: unpaid.reduce((sum, e) => sum + Number(e.unit_fee || 0), 0)
  };
};

const loadEntries = async (competition, school, window) => {
  const result = await query(
    `SELECT ${ENTRY_COLUMNS}
     ${ENTRY_FROM}
     WHERE cp.competition_id = $1 AND s.school_id = $2
     ORDER BY cp.joined_at ASC, s.name ASC`,
    [competition.id, school.id]
  );
  return result.rows.map((row) => presentEntry(row, window));
};

// ============================================================================
// Competitions
// ============================================================================

/**
 * Competitions the school can register for, plus any it already has students
 * in that have not taken place yet, each with the school's own tally.
 */
const listCompetitions = async (req, res, next) => {
  try {
    const school = await getSchoolForUser(req.user.id);
    if (!school) return fail(res, 404, 'School profile not found');

    const result = await query(
      `WITH tally AS (
         SELECT cp.competition_id,
                COUNT(*)::int AS entry_count,
                COUNT(*) FILTER (WHERE cp.payment_status IN ('pending_payment','rejected'))::int AS unpaid_count,
                COUNT(*) FILTER (WHERE cp.payment_status = 'submitted')::int AS submitted_count,
                COUNT(*) FILTER (WHERE cp.payment_status IN ('verified','not_required'))::int AS confirmed_count,
                COALESCE(SUM(${participantFeeSql('cp', 'c')})
                  FILTER (WHERE cp.payment_status IN ('pending_payment','rejected')), 0) AS amount_due
         FROM competition_participants cp
         JOIN students s ON s.id = cp.student_id
         JOIN competitions c ON c.id = cp.competition_id
         WHERE s.school_id = $1
         GROUP BY cp.competition_id
       )
       SELECT c.*,
              COALESCE(t.entry_count, 0) AS entry_count,
              COALESCE(t.unpaid_count, 0) AS unpaid_count,
              COALESCE(t.submitted_count, 0) AS submitted_count,
              COALESCE(t.confirmed_count, 0) AS confirmed_count,
              COALESCE(t.amount_due, 0) AS amount_due
       FROM competitions c
       LEFT JOIN tally t ON t.competition_id = c.id
       WHERE NOT (c.start_date IS NOT NULL AND c.start_date < $2::date)
         AND (c.status = 'active' OR t.entry_count > 0)
       ORDER BY c.start_date ASC NULLS LAST, c.title ASC`,
      [school.id, todayForPricing()]
    );

    return ok(
      res,
      result.rows.map((row) => {
        const competition = withPricing(row);
        return {
          ...presentCompetition(competition),
          entry_count: row.entry_count,
          unpaid_count: row.unpaid_count,
          submitted_count: row.submitted_count,
          confirmed_count: row.confirmed_count,
          amount_due: Number(row.amount_due || 0)
        };
      })
    );
  } catch (err) {
    return next(err);
  }
};

// ============================================================================
// Entries
// ============================================================================

const listEntries = async (req, res, next) => {
  try {
    const school = await getSchoolForUser(req.user.id);
    if (!school) return fail(res, 404, 'School profile not found');

    const competition = await findCompetition(req.params.id);
    if (!competition) return fail(res, 404, 'Competition not found');

    const window = registrationWindow(competition);
    const entries = await loadEntries(competition, school, window);

    return ok(res, {
      competition: presentCompetition(competition),
      pricing: entryPricing(competition),
      entries,
      summary: summarize(entries)
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * Add students to a competition. All-or-nothing: if any row is invalid or a
 * duplicate, nothing is saved and every problem is reported at once.
 */
const addEntries = async (req, res, next) => {
  try {
    const school = await requireApprovedSchool(req, res);
    if (!school) return undefined;

    const competition = await findCompetition(req.params.id);
    if (!competition) return fail(res, 404, 'Competition not found');

    const window = registrationWindow(competition);
    if (!window.open) return fail(res, 400, window.reason);

    const { min, max } = gradeRange(competition);
    const rows = req.body.students.map((s, index) => ({
      index,
      fullName: tidyName(s.fullName),
      fatherName: tidyName(s.fatherName),
      grade: String(s.class),
      key: nameKey(s.fullName, s.fatherName)
    }));

    const errors = [];
    const seen = new Map();
    rows.forEach((row) => {
      const grade = Number(row.grade);
      if (grade < min || grade > max) {
        errors.push({
          path: ['students', row.index, 'class'],
          message: `${row.fullName}: class ${row.grade} is not eligible (${min === max ? `Grade ${min}` : `Grades ${min}–${max}`})`
        });
      }
      if (seen.has(row.key)) {
        errors.push({
          path: ['students', row.index, 'fullName'],
          message: `${row.fullName} s/o ${row.fatherName} is listed twice`
        });
      }
      seen.set(row.key, row.index);
    });
    if (errors.length) return fail(res, 400, 'Some students could not be added', errors);

    const pricing = entryPricing(competition);
    const paymentStatus = pricing.unitFee > 0 ? 'pending_payment' : 'not_required';

    const result = await withTransaction(async (client) => {
      // One coordinator double-submitting, or two tabs saving at once, must not
      // slip the same child in twice: serialize writes per school+competition.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entries:${school.id}:${competition.id}`]);

      const existing = await client.query(
        `SELECT s.name, s.father_name
         FROM competition_participants cp
         JOIN students s ON s.id = cp.student_id
         WHERE cp.competition_id = $1 AND s.school_id = $2`,
        [competition.id, school.id]
      );
      const taken = new Set(existing.rows.map((r) => nameKey(r.name, r.father_name)));
      const duplicates = rows.filter((row) => taken.has(row.key));
      if (duplicates.length) {
        return {
          conflict: duplicates.map((row) => ({
            path: ['students', row.index, 'fullName'],
            message: `${row.fullName} s/o ${row.fatherName} is already registered for this competition`
          }))
        };
      }

      const addedIds = [];
      for (const row of rows) {
        // Reuse the child's roster row from another competition when the
        // details match exactly; otherwise start a new one.
        const reuse = await client.query(
          `SELECT s.id FROM students s
           WHERE s.school_id = $1 AND s.user_id IS NULL
             AND lower(btrim(s.name)) = lower($2)
             AND lower(btrim(COALESCE(s.father_name, ''))) = lower($3)
             AND s.class = $4
             AND NOT EXISTS (
               SELECT 1 FROM competition_participants cp
               WHERE cp.student_id = s.id AND cp.competition_id = $5
             )
           ORDER BY s.created_at ASC
           LIMIT 1`,
          [school.id, row.fullName, row.fatherName, row.grade, competition.id]
        );

        let studentId = reuse.rows[0]?.id;
        if (!studentId) {
          const inserted = await client.query(
            `INSERT INTO students (user_id, name, father_name, email, class, school_name, city, school_id, profile_completed)
             VALUES (NULL, $1, $2, NULL, $3, $4, $5, $6, TRUE)
             RETURNING id`,
            [row.fullName, row.fatherName, row.grade, school.school_name, school.city, school.id]
          );
          studentId = inserted.rows[0].id;
        }

        await client.query(
          `INSERT INTO competition_participants
             (competition_id, student_id, payment_status, unit_fee, fee_tier, added_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [competition.id, studentId, paymentStatus, pricing.unitFee, pricing.feeTier, req.user.id]
        );
        addedIds.push(studentId);
      }

      return { addedIds };
    });

    if (result.conflict) {
      return fail(res, 409, 'Some students are already registered for this competition', result.conflict);
    }

    const entries = await loadEntries(competition, school, window);
    const added = entries.filter((e) => result.addedIds.includes(e.student_id));

    return created(
      res,
      {
        competition: presentCompetition(competition),
        pricing,
        added,
        addedAmount: added.reduce((sum, e) => sum + e.unit_fee, 0),
        entries,
        summary: summarize(entries)
      },
      `${added.length} student${added.length === 1 ? '' : 's'} registered`
    );
  } catch (err) {
    return next(err);
  }
};

/** The school's own entry in a competition, locked for the rest of the transaction. */
const lockEntry = async (client, competitionId, studentId, schoolId) => {
  const result = await client.query(
    `SELECT cp.id AS participant_id, cp.payment_status, s.id AS student_id, s.user_id, s.name, s.father_name, s.class
     FROM competition_participants cp
     JOIN students s ON s.id = cp.student_id
     WHERE cp.competition_id = $1 AND cp.student_id = $2 AND s.school_id = $3
     FOR UPDATE OF cp`,
    [competitionId, studentId, schoolId]
  );
  return result.rows[0] || null;
};

/**
 * Correct a student's details. Only while the entry is unpaid (or free), so a
 * payment under review always matches what the reviewer sees. The entry keeps
 * its locked price — fixing a typo must not cost the school its Early Bird rate.
 */
const updateEntry = async (req, res, next) => {
  try {
    const school = await requireApprovedSchool(req, res);
    if (!school) return undefined;

    const competition = await findCompetition(req.params.id);
    if (!competition) return fail(res, 404, 'Competition not found');

    const window = registrationWindow(competition);
    if (window.ended) return fail(res, 400, 'This competition has already taken place');

    const { min, max } = gradeRange(competition);

    const result = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entries:${school.id}:${competition.id}`]);

      const entry = await lockEntry(client, competition.id, req.params.studentId, school.id);
      if (!entry) return { error: [404, 'Student is not registered for this competition'] };
      if (entry.user_id) {
        return { error: [400, 'This student manages their own account, so their details cannot be changed here'] };
      }
      if (!EDITABLE_STATUSES.includes(entry.payment_status)) {
        return {
          error: [400, entry.payment_status === 'submitted'
            ? 'A payment covering this student is being reviewed, so their details are locked'
            : 'This student\'s payment is verified, so their details are locked. Contact support to correct them.']
        };
      }

      const updated = {
        fullName: tidyName(req.body.fullName ?? entry.name),
        fatherName: tidyName(req.body.fatherName ?? entry.father_name),
        grade: String(req.body.class ?? entry.class)
      };
      const gradeNumber = Number(updated.grade);
      if (gradeNumber < min || gradeNumber > max) {
        return { error: [400, `Class ${updated.grade} is not eligible (${min === max ? `Grade ${min}` : `Grades ${min}–${max}`})`] };
      }

      const clash = await client.query(
        `SELECT 1 FROM competition_participants cp
         JOIN students s ON s.id = cp.student_id
         WHERE cp.competition_id = $1 AND s.school_id = $2 AND s.id <> $3
           AND lower(btrim(s.name)) = lower($4)
           AND lower(btrim(COALESCE(s.father_name, ''))) = lower($5)`,
        [competition.id, school.id, entry.student_id, updated.fullName, updated.fatherName]
      );
      if (clash.rowCount > 0) {
        return { error: [409, `${updated.fullName} s/o ${updated.fatherName} is already registered for this competition`] };
      }

      // The roster row may be shared with this child's other competitions.
      // Correcting it here must not silently rewrite a paid entry elsewhere,
      // so a shared row is split off before it is changed.
      const shared = await client.query(
        'SELECT COUNT(*)::int AS count FROM competition_participants WHERE student_id = $1',
        [entry.student_id]
      );
      let studentId = entry.student_id;
      if (shared.rows[0].count > 1) {
        const copy = await client.query(
          `INSERT INTO students (user_id, name, father_name, email, class, school_name, city, school_id, profile_completed)
           VALUES (NULL, $1, $2, NULL, $3, $4, $5, $6, TRUE)
           RETURNING id`,
          [updated.fullName, updated.fatherName, updated.grade, school.school_name, school.city, school.id]
        );
        studentId = copy.rows[0].id;
        await client.query('UPDATE competition_participants SET student_id = $1 WHERE id = $2', [
          studentId,
          entry.participant_id
        ]);
      } else {
        await client.query(
          'UPDATE students SET name = $1, father_name = $2, class = $3, updated_at = NOW() WHERE id = $4',
          [updated.fullName, updated.fatherName, updated.grade, studentId]
        );
      }
      return { studentId };
    });

    if (result.error) return fail(res, result.error[0], result.error[1]);

    const entries = await loadEntries(competition, school, window);
    return ok(
      res,
      {
        entry: entries.find((e) => e.student_id === result.studentId) || null,
        entries,
        summary: summarize(entries)
      },
      'Student updated'
    );
  } catch (err) {
    return next(err);
  }
};

/** Withdraw an unpaid (or free) entry. Paid and in-review entries stay put. */
const removeEntry = async (req, res, next) => {
  try {
    const school = await requireApprovedSchool(req, res);
    if (!school) return undefined;

    const competition = await findCompetition(req.params.id);
    if (!competition) return fail(res, 404, 'Competition not found');

    const window = registrationWindow(competition);

    const result = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entries:${school.id}:${competition.id}`]);

      const entry = await lockEntry(client, competition.id, req.params.studentId, school.id);
      if (!entry) return { error: [404, 'Student is not registered for this competition'] };

      const decorated = presentEntry({ ...entry, has_account: Boolean(entry.user_id) }, window);
      if (!decorated.can_remove) {
        if (window.ended) return { error: [400, 'This competition has already taken place'] };
        if (entry.payment_status === 'submitted') {
          return { error: [400, 'A payment covering this student is being reviewed, so they cannot be removed'] };
        }
        if (entry.payment_status === 'verified') {
          return { error: [400, 'This student\'s payment is verified, so they cannot be removed. Contact support.'] };
        }
        return { error: [400, 'Registration has closed, so this student cannot be removed'] };
      }

      await client.query('DELETE FROM competition_participants WHERE id = $1', [entry.participant_id]);

      // Tidy up a roster row that no longer belongs to anything.
      if (!entry.user_id) {
        await client.query(
          `DELETE FROM students s
           WHERE s.id = $1 AND s.user_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM competition_participants cp WHERE cp.student_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.student_id = s.id)`,
          [entry.student_id]
        );
      }
      return { removed: entry };
    });

    if (result.error) return fail(res, result.error[0], result.error[1]);

    const entries = await loadEntries(competition, school, window);
    return ok(res, { entries, summary: summarize(entries) }, `${result.removed.name} removed`);
  } catch (err) {
    return next(err);
  }
};

// ============================================================================
// Roster
// ============================================================================

/**
 * Every student the school has entered, with the competitions they are in.
 *
 * Students entered by the school have no login (`account_status` 'school').
 * Older rosters may still hold students whose logins were created by the
 * retired CSV upload; those keep reporting their onboarding state.
 */
const listSchoolStudents = async (req, res, next) => {
  try {
    const school = await getSchoolForUser(req.user.id);
    if (!school) return fail(res, 404, 'School profile not found');

    const { search, status, grade } = req.query;
    const params = [school.id];
    const where = ['s.school_id = $1'];

    const ACCOUNT_STATUS_SQL = `CASE
      WHEN u.id IS NULL THEN 'school'
      WHEN u.is_active = FALSE THEN 'disabled'
      WHEN u.must_change_password = TRUE OR s.profile_completed = FALSE THEN 'pending'
      ELSE 'active'
    END`;

    if (grade) {
      params.push(String(grade));
      where.push(`s.class = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(COALESCE(s.name,'') ILIKE $${params.length}
        OR COALESCE(s.father_name,'') ILIKE $${params.length}
        OR COALESCE(s.email,'') ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`${ACCOUNT_STATUS_SQL} = $${params.length}`);
    }

    const result = await query(
      `SELECT
         s.id, s.name, s.father_name, s.email, s.class, s.city, s.whatsapp_number,
         s.profile_completed, s.created_at,
         u.is_active, u.must_change_password, u.created_at AS account_created_at,
         ${ACCOUNT_STATUS_SQL} AS account_status,
         COALESCE(upcoming.items, '[]'::json) AS competitions,
         COALESCE(upcoming.active_count, 0) AS active_competitions,
         COALESCE(upcoming.unpaid_count, 0) AS unpaid_competitions,
         COALESCE(lifetime.total_count, 0) AS total_competitions
       FROM students s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN LATERAL (
         SELECT
           json_agg(json_build_object(
             'competitionId', c.id,
             'title', c.title,
             'code', c.code,
             'startDate', c.start_date,
             'fee', ${participantFeeSql('cp', 'c')},
             'feeTier', cp.fee_tier,
             'addedAt', cp.joined_at,
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
         COUNT(*) FILTER (WHERE u.id IS NULL)::int AS school,
         COUNT(*) FILTER (WHERE u.is_active = FALSE)::int AS disabled,
         COUNT(*) FILTER (
           WHERE u.is_active = TRUE AND (u.must_change_password = TRUE OR s.profile_completed = FALSE)
         )::int AS pending,
         COUNT(*) FILTER (
           WHERE u.is_active = TRUE AND u.must_change_password = FALSE AND s.profile_completed = TRUE
         )::int AS active
       FROM students s
       LEFT JOIN users u ON u.id = s.user_id
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

module.exports = {
  listCompetitions,
  listEntries,
  addEntries,
  updateEntry,
  removeEntry,
  listSchoolStudents
};
