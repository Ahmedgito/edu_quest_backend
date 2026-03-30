const bcrypt = require('bcryptjs');
const { query, pool } = require('./index');
const { env } = require('../config/env');

const seed = async () => {
  const adminPassword = env.adminPassword || 'Admin@12345';
  const hash = await bcrypt.hash(adminPassword, env.bcryptSaltRounds);

  const admin = await query('SELECT id FROM users WHERE email = $1', [env.adminEmail]);
  let adminId = admin.rows[0]?.id;
  if (!adminId) {
    const res = await query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [env.adminEmail || 'admin@eduquest.local', hash, 'admin']
    );
    adminId = res.rows[0].id;
  }

  const schoolUserEmail = 'school1@eduquest.local';
  const schoolUserRes = await query('SELECT id FROM users WHERE email = $1', [schoolUserEmail]);
  let schoolUserId = schoolUserRes.rows[0]?.id;
  if (!schoolUserId) {
    const sHash = await bcrypt.hash('School@123', env.bcryptSaltRounds);
    const res = await query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [schoolUserEmail, sHash, 'school']
    );
    schoolUserId = res.rows[0].id;
  }

  const schoolRes = await query('SELECT id FROM schools WHERE user_id = $1', [schoolUserId]);
  let schoolId = schoolRes.rows[0]?.id;
  if (!schoolId) {
    const res = await query(
      `INSERT INTO schools (user_id, school_name, coordinator_name, designation, principal_name, principal_email, branch_name, city, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [schoolUserId, 'EduQuest Public School', 'Adeel Khan', 'Coordinator', 'Sarah Ali', 'principal@eduquest.local', 'Main Campus', 'Karachi', 'approved']
    );
    schoolId = res.rows[0].id;
  }

  const studentSeeds = [
    { email: 'student1@eduquest.local', name: 'Hassan', class: '7', city: 'Karachi' },
    { email: 'student2@eduquest.local', name: 'Ayesha', class: '7', city: 'Lahore' },
    { email: 'student3@eduquest.local', name: 'Usman', class: '8', city: 'Islamabad' }
  ];

  for (const student of studentSeeds) {
    const existing = await query('SELECT id FROM users WHERE email = $1', [student.email]);
    if (existing.rowCount > 0) {
      continue;
    }
    const sHash = await bcrypt.hash('Student@123', env.bcryptSaltRounds);
    const userRes = await query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [student.email, sHash, 'student']
    );
    await query(
      'INSERT INTO students (user_id, name, email, class, school_name, city, whatsapp_number, school_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userRes.rows[0].id, student.name, student.email, student.class, 'EduQuest Public School', student.city, null, schoolId]
    );
  }

  const competitions = [
    {
      code: 'MATH-7-A',
      title: 'Math Sprint Grade 7',
      grade: '7',
      subjects: ['Math'],
      venue: 'Hall A',
      status: 'active'
    },
    {
      code: 'SCI-7-B',
      title: 'Science Quest Grade 7',
      grade: '7',
      subjects: ['Science'],
      venue: 'Hall B',
      status: 'active'
    },
    {
      code: 'ENG-8-A',
      title: 'English Challenge Grade 8',
      grade: '8',
      subjects: ['English'],
      venue: 'Hall C',
      status: 'active'
    }
  ];

  for (const comp of competitions) {
    const existing = await query('SELECT id FROM competitions WHERE code = $1', [comp.code]);
    if (existing.rowCount > 0) {
      continue;
    }
    await query(
      `INSERT INTO competitions (code, title, description, grade, subjects, venue, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [comp.code, comp.title, `${comp.title} description`, comp.grade, comp.subjects, comp.venue, comp.status]
    );
  }

  console.log('Seed complete');
};

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
