const { query } = require('../db');
const { ok, created, fail } = require('../utils/response');
const { getPagination } = require('../utils/pagination');

const listCompetitions = async (req, res, next) => {
  try {
    const { grade, subject, status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = [];
    const params = [];
    // Hide competitions that are already over (event date passed, or deadline
    // passed when there is no event date). Passed-out competitions never surface.
    where.push(`NOT (
      (start_date IS NOT NULL AND start_date < CURRENT_DATE)
      OR (start_date IS NULL AND registration_deadline IS NOT NULL AND registration_deadline < CURRENT_DATE)
    )`);
    if (grade) {
      const gradeInt = Number.parseInt(grade, 10);
      if (!Number.isNaN(gradeInt)) {
        params.push(gradeInt);
        const gIdx = params.length;
        where.push(`(
          ($${gIdx} BETWEEN grade_min AND grade_max)
          OR (
            grade_min IS NULL AND grade_max IS NULL AND (
              (grade ~ '^[0-9]+$' AND grade::int = $${gIdx})
              OR (grade ~ '^[0-9]+\\s*-\\s*[0-9]+$' AND $${gIdx} BETWEEN trim(split_part(grade, '-', 1))::int AND trim(split_part(grade, '-', 2))::int)
            )
          )
        )`);
      } else {
        params.push(String(grade));
        where.push(`grade = $${params.length}`);
      }
    }
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (subject) {
      params.push(subject);
      where.push(`$${params.length} = ANY (subjects)`);
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

const searchCompetitions = async (req, res, next) => {
  try {
    const { q, grade, subject } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const where = ['(title ILIKE $1 OR code ILIKE $1)'];
    const params = [`%${q}%`];

    // Hide competitions that are already over (see listCompetitions).
    where.push(`NOT (
      (start_date IS NOT NULL AND start_date < CURRENT_DATE)
      OR (start_date IS NULL AND registration_deadline IS NOT NULL AND registration_deadline < CURRENT_DATE)
    )`);

    if (grade) {
      const gradeInt = Number.parseInt(grade, 10);
      if (!Number.isNaN(gradeInt)) {
        params.push(gradeInt);
        const gIdx = params.length;
        where.push(`(
          ($${gIdx} BETWEEN grade_min AND grade_max)
          OR (
            grade_min IS NULL AND grade_max IS NULL AND (
              (grade ~ '^[0-9]+$' AND grade::int = $${gIdx})
              OR (grade ~ '^[0-9]+\\s*-\\s*[0-9]+$' AND $${gIdx} BETWEEN trim(split_part(grade, '-', 1))::int AND trim(split_part(grade, '-', 2))::int)
            )
          )
        )`);
      } else {
        params.push(String(grade));
        where.push(`grade = $${params.length}`);
      }
    }
    if (subject) {
      params.push(subject);
      where.push(`$${params.length} = ANY (subjects)`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
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

const competitionDetail = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT * FROM competitions WHERE code = $1 OR id::text = $1', [id]);
    if (result.rowCount === 0) {
      return fail(res, 404, 'Competition not found');
    }
    return ok(res, result.rows[0]);
  } catch (err) {
    return next(err);
  }
};

const contact = async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, subject, message } = req.body;
    const result = await query(
      `INSERT INTO contact_messages (first_name, last_name, email, phone, subject, message)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [firstName, lastName, email, phone || null, subject, message]
    );
    return created(res, result.rows[0], 'Message received');
  } catch (err) {
    return next(err);
  }
};

module.exports = { listCompetitions, searchCompetitions, competitionDetail, contact };
