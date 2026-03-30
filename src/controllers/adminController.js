const { query } = require('../db');
const { ok, created, fail } = require('../utils/response');
const { getPagination } = require('../utils/pagination');

const adminDashboard = async (req, res, next) => {
  try {
    const schools = await query('SELECT COUNT(*)::int AS count FROM schools');
    const students = await query('SELECT COUNT(*)::int AS count FROM students');
    const competitions = await query("SELECT COUNT(*)::int AS count FROM competitions WHERE status = 'active'");
    return ok(res, {
      totalSchools: schools.rows[0].count,
      totalStudents: students.rows[0].count,
      activeCompetitions: competitions.rows[0].count
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
      where.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`school_name ILIKE $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalResult = await query(`SELECT COUNT(*)::int AS count FROM schools ${whereSql}`, params);
    const listResult = await query(
      `SELECT * FROM schools ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
    const { schoolId, search, grade } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = [];
    const params = [];
    if (schoolId) {
      params.push(schoolId);
      where.push(`school_id = $${params.length}`);
    }
    if (grade) {
      params.push(grade);
      where.push(`class = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(email ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalResult = await query(`SELECT COUNT(*)::int AS count FROM students ${whereSql}`, params);
    const listResult = await query(
      `SELECT * FROM students ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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

    const result = await query(
      `INSERT INTO competitions (code, title, description, grade, subjects, start_date, start_time, end_time, venue, fee, registration_deadline, duration, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        code,
        title,
        description || null,
        grade,
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
    const fields = req.body;

    const allowed = {
      code: 'code',
      title: 'title',
      description: 'description',
      grade: 'grade',
      subjects: 'subjects',
      startDate: 'start_date',
      startTime: 'start_time',
      endTime: 'end_time',
      venue: 'venue',
      fee: 'fee',
      registrationDeadline: 'registration_deadline',
      duration: 'duration',
      status: 'status'
    };

    const keys = Object.keys(fields).filter((k) => allowed[k] !== undefined);
    if (keys.length === 0) {
      return fail(res, 400, 'No valid fields to update');
    }

    const set = [];
    const params = [];
    keys.forEach((key) => {
      params.push(fields[key]);
      set.push(`${allowed[key]} = $${params.length}`);
    });
    params.push(id);

    const result = await query(
      `UPDATE competitions SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rowCount === 0) {
      return fail(res, 404, 'Competition not found');
    }

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
