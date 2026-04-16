const { query } = require('../db');
const { ok, created, fail } = require('../utils/response');
const { getPagination } = require('../utils/pagination');

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

const timeToMinutes = (time) => {
  if (!time || typeof time !== 'string' || !timeRegex.test(time)) return null;
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
};

const validateCompetitionRules = ({ startDate, registrationDeadline, startTime, endTime }) => {
  if (startDate && registrationDeadline) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const deadline = new Date(`${registrationDeadline}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(deadline.getTime())) {
      return 'Invalid competition dates';
    }
    if (deadline > start) {
      return 'Registration deadline cannot be after competition date';
    }
  }

  if (startTime && endTime) {
    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);
    if (startMinutes == null || endMinutes == null) {
      return 'Invalid competition time';
    }
    if (endMinutes <= startMinutes) {
      return 'End time must be after start time';
    }
  }

  return null;
};

const normalizeGradeRange = ({ grade, gradeMin, gradeMax }) => {
  if (gradeMin !== undefined || gradeMax !== undefined) {
    const min = Number(gradeMin);
    const max = Number(gradeMax);
    const text = min === max ? String(min) : `${min}-${max}`;
    return { gradeMin: min, gradeMax: max, gradeText: text };
  }

  const raw = String(grade || '').trim();
  if (/^\d+$/.test(raw)) {
    const g = Number(raw);
    return { gradeMin: g, gradeMax: g, gradeText: raw };
  }

  const m = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    const text = min === max ? String(min) : `${min}-${max}`;
    return { gradeMin: min, gradeMax: max, gradeText: text };
  }

  return { gradeMin: null, gradeMax: null, gradeText: raw };
};

const adminDashboard = async (req, res, next) => {
  try {
    const schools = await query('SELECT COUNT(*)::int AS count FROM schools');
    const students = await query('SELECT COUNT(*)::int AS count FROM students');
    const bulkStudents = await query('SELECT COUNT(*)::int AS count FROM students WHERE school_id IS NOT NULL');
    const individualStudents = await query('SELECT COUNT(*)::int AS count FROM students WHERE school_id IS NULL');
    const pendingSchools = await query("SELECT COUNT(*)::int AS count FROM schools WHERE status = 'pending'");
    const competitions = await query("SELECT COUNT(*)::int AS count FROM competitions WHERE status = 'active'");
    return ok(res, {
      totalSchools: schools.rows[0].count,
      totalStudents: students.rows[0].count,
      activeCompetitions: competitions.rows[0].count,
      pendingSchools: pendingSchools.rows[0].count,
      bulkStudents: bulkStudents.rows[0].count,
      individualStudents: individualStudents.rows[0].count
    });
  } catch (err) {
    return next(err);
  }
};

const listSchools = async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`s.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`s.school_name ILIKE $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalResult = await query(`SELECT COUNT(*)::int AS count FROM schools s ${whereSql}`, params);
    const listResult = await query(
      `SELECT
        s.*,
        COALESCE(student_stats.student_count, 0) AS student_count,
        u.is_active AS account_active,
        u.created_at AS account_created_at
      FROM schools s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN (
        SELECT school_id, COUNT(*)::int AS student_count
        FROM students
        WHERE school_id IS NOT NULL
        GROUP BY school_id
      ) student_stats ON student_stats.school_id = s.id
      ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}`,
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

const getSchool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT * FROM schools WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'School not found');
    }
    return ok(res, result.rows[0]);
  } catch (err) {
    return next(err);
  }
};

const approveSchool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('UPDATE schools SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', ['approved', id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'School not found');
    }
    return ok(res, result.rows[0], 'School approved');
  } catch (err) {
    return next(err);
  }
};

const rejectSchool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('UPDATE schools SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', ['rejected', id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'School not found');
    }
    return ok(res, result.rows[0], 'School rejected');
  } catch (err) {
    return next(err);
  }
};

const listStudents = async (req, res, next) => {
  try {
    const { schoolId, search, grade, source } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = [];
    const params = [];

    if (source && !['school_bulk', 'individual'].includes(source)) {
      return fail(res, 400, 'Invalid source filter. Use school_bulk or individual');
    }

    if (schoolId) {
      params.push(schoolId);
      where.push(`s.school_id = $${params.length}`);
    }
    if (grade) {
      params.push(grade);
      where.push(`s.class = $${params.length}`);
    }
    if (source === 'school_bulk') {
      where.push('s.school_id IS NOT NULL');
    }
    if (source === 'individual') {
      where.push('s.school_id IS NULL');
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        s.email ILIKE $${params.length}
        OR COALESCE(s.name, '') ILIKE $${params.length}
        OR COALESCE(s.school_name, '') ILIKE $${params.length}
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalResult = await query(`SELECT COUNT(*)::int AS count FROM students s ${whereSql}`, params);
    const listResult = await query(
      `SELECT
        s.*,
        u.is_active AS account_active,
        u.created_at AS account_created_at,
        u.updated_at AS account_updated_at,
        CASE WHEN s.school_id IS NULL THEN 'individual' ELSE 'school_bulk' END AS registration_source,
        COALESCE(sc.school_name, s.school_name) AS resolved_school_name,
        COALESCE(sc.status, 'unlinked') AS school_status,
        CASE
          WHEN s.school_id IS NULL AND (s.school_name IS NULL OR BTRIM(s.school_name) = '') THEN TRUE
          ELSE FALSE
        END AS missing_school_info,
        COALESCE(participant_stats.competitions_count, 0) AS competitions_count
      FROM students s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN schools sc ON sc.id = s.school_id
      LEFT JOIN (
        SELECT student_id, COUNT(*)::int AS competitions_count
        FROM competition_participants
        GROUP BY student_id
      ) participant_stats ON participant_stats.student_id = s.id
      ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}`,
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

const deleteStudent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM students WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'Student not found');
    }
    return ok(res, result.rows[0], 'Student removed');
  } catch (err) {
    return next(err);
  }
};

const createCompetition = async (req, res, next) => {
  try {
    const {
      code,
      title,
      description,
      grade,
      gradeMin,
      gradeMax,
      subjects,
      startDate,
      startTime,
      endTime,
      venue,
      fee,
      registrationDeadline,
      duration,
      status
    } = req.body;

    const gradeInfo = normalizeGradeRange({ grade, gradeMin, gradeMax });
    const dateTimeError = validateCompetitionRules({ startDate, registrationDeadline, startTime, endTime });
    if (dateTimeError) {
      return fail(res, 400, dateTimeError);
    }

    const result = await query(
      `INSERT INTO competitions (code, title, description, grade, grade_min, grade_max, subjects, start_date, start_time, end_time, venue, fee, registration_deadline, duration, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        code,
        title,
        description || null,
        gradeInfo.gradeText,
        gradeInfo.gradeMin,
        gradeInfo.gradeMax,
        subjects || [],
        startDate || null,
        startTime || null,
        endTime || null,
        venue || null,
        fee || 0,
        registrationDeadline || null,
        duration || null,
        status || 'active'
      ]
    );
    return created(res, result.rows[0], 'Competition created');
  } catch (err) {
    return next(err);
  }
};

const listCompetitions = async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(title ILIKE $${params.length} OR code ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalResult = await query(`SELECT COUNT(*)::int AS count FROM competitions ${whereSql}`, params);
    const listResult = await query(
      `SELECT * FROM competitions ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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

const getCompetition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT * FROM competitions WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'Competition not found');
    }
    return ok(res, result.rows[0]);
  } catch (err) {
    return next(err);
  }
};

const updateCompetition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const fields = req.body || {};
    const existing = await query('SELECT * FROM competitions WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      return fail(res, 404, 'Competition not found');
    }
    const current = existing.rows[0];

    const set = [];
    const params = [];

    const pushSet = (col, val) => {
      params.push(val);
      set.push(`${col} = $${params.length}`);
    };

    if (fields.code !== undefined) pushSet('code', fields.code);
    if (fields.title !== undefined) pushSet('title', fields.title);
    if (fields.description !== undefined) pushSet('description', fields.description);
    if (fields.subjects !== undefined) pushSet('subjects', fields.subjects);
    if (fields.startDate !== undefined) pushSet('start_date', fields.startDate);
    if (fields.startTime !== undefined) pushSet('start_time', fields.startTime);
    if (fields.endTime !== undefined) pushSet('end_time', fields.endTime);
    if (fields.venue !== undefined) pushSet('venue', fields.venue);
    if (fields.fee !== undefined) pushSet('fee', fields.fee);
    if (fields.registrationDeadline !== undefined) pushSet('registration_deadline', fields.registrationDeadline);
    if (fields.duration !== undefined) pushSet('duration', fields.duration);
    if (fields.status !== undefined) pushSet('status', fields.status);

    const hasGradeUpdates =
      fields.grade !== undefined || fields.gradeMin !== undefined || fields.gradeMax !== undefined;
    if (hasGradeUpdates) {
      const gradeInfo = normalizeGradeRange({
        grade: fields.grade,
        gradeMin: fields.gradeMin,
        gradeMax: fields.gradeMax
      });
      if (gradeInfo.gradeText) pushSet('grade', gradeInfo.gradeText);
      if (gradeInfo.gradeMin !== null) pushSet('grade_min', gradeInfo.gradeMin);
      if (gradeInfo.gradeMax !== null) pushSet('grade_max', gradeInfo.gradeMax);
    }

    if (set.length === 0) {
      return fail(res, 400, 'No valid fields to update');
    }

    const merged = {
      startDate: fields.startDate !== undefined ? fields.startDate : current.start_date,
      registrationDeadline: fields.registrationDeadline !== undefined ? fields.registrationDeadline : current.registration_deadline,
      startTime: fields.startTime !== undefined ? fields.startTime : current.start_time,
      endTime: fields.endTime !== undefined ? fields.endTime : current.end_time
    };
    const dateTimeError = validateCompetitionRules(merged);
    if (dateTimeError) {
      return fail(res, 400, dateTimeError);
    }

    params.push(id);

    const result = await query(
      `UPDATE competitions SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );

    return ok(res, result.rows[0], 'Competition updated');
  } catch (err) {
    return next(err);
  }
};

const deleteCompetition = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM competitions WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'Competition not found');
    }
    return ok(res, result.rows[0], 'Competition removed');
  } catch (err) {
    return next(err);
  }
};

const competitionParticipants = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT cp.student_id, s.name, s.email, s.class, cp.joined_at
       FROM competition_participants cp
       JOIN students s ON s.id = cp.student_id
       WHERE cp.competition_id = $1
       ORDER BY cp.joined_at DESC`,
      [id]
    );
    return ok(res, result.rows);
  } catch (err) {
    return next(err);
  }
};

const removeParticipant = async (req, res, next) => {
  try {
    const { id, studentId } = req.params;
    const result = await query(
      'DELETE FROM competition_participants WHERE competition_id = $1 AND student_id = $2 RETURNING *',
      [id, studentId]
    );
    if (result.rowCount === 0) {
      return fail(res, 404, 'Participant not found');
    }
    return ok(res, result.rows[0], 'Participant removed');
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  adminDashboard,
  listSchools,
  getSchool,
  approveSchool,
  rejectSchool,
  listStudents,
  deleteStudent,
  createCompetition,
  listCompetitions,
  getCompetition,
  updateCompetition,
  deleteCompetition,
  competitionParticipants,
  removeParticipant
};
