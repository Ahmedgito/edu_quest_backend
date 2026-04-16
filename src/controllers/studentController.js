const { query } = require('../db');
const { ok, fail } = require('../utils/response');
const { getPagination } = require('../utils/pagination');

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

const updateProfile = async (req, res, next) => {
  try {
    const { city, whatsappNumber } = req.body;
    const result = await query(
      'UPDATE students SET city = COALESCE($1, city), whatsapp_number = COALESCE($2, whatsapp_number), updated_at = NOW() WHERE user_id = $3 RETURNING *',
      [city || null, whatsappNumber || null, req.user.id]
    );
    if (result.rowCount === 0) {
      return fail(res, 404, 'Profile not found');
    }
    return ok(res, result.rows[0], 'Profile updated');
  } catch (err) {
    return next(err);
  }
};

const myCompetitions = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*
       FROM competition_participants cp
       JOIN students s ON s.id = cp.student_id
       JOIN competitions c ON c.id = cp.competition_id
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
    let where = `WHERE c.status = 'active' AND (
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
      'SELECT id FROM competition_participants WHERE competition_id = $1 AND student_id = $2',
      [competitionId, student.id]
    );
    if (existing.rowCount > 0) {
      return ok(res, { alreadyJoined: true }, 'Already joined');
    }

    await query(
      'INSERT INTO competition_participants (competition_id, student_id) VALUES ($1, $2)',
      [competitionId, student.id]
    );

    return ok(res, { competitionId }, 'Registration successful');
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getProfile,
  updateProfile,
  myCompetitions,
  availableCompetitions,
  joinCompetition
};
