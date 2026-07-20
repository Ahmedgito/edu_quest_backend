const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { env } = require('../config/env');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/token');
const { ok, created, fail } = require('../utils/response');

const registerIndividual = async (req, res, next) => {
  try {
    const { email, password, class: grade, schoolName, whatsappNumber, city } = req.body;

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      return fail(res, 400, 'Email already registered');
    }

    const hash = await bcrypt.hash(password, env.bcryptSaltRounds);
    const userResult = await query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, hash, 'student']
    );

    const user = userResult.rows[0];
    await query(
      'INSERT INTO students (user_id, name, email, class, school_name, city, whatsapp_number) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [user.id, null, email, grade, schoolName || null, city || null, whatsappNumber || null]
    );

    return created(res, { id: user.id, email: user.email, role: user.role }, 'Registered successfully');
  } catch (err) {
    return next(err);
  }
};

const registerSchool = async (req, res, next) => {
  try {
    const { coordinatorName, designation, email, password, schoolName, principalName, principalEmail, branchName, city } = req.body;

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      return fail(res, 400, 'Email already registered');
    }

    const hash = await bcrypt.hash(password, env.bcryptSaltRounds);
    const userResult = await query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, hash, 'school']
    );

    const user = userResult.rows[0];
    await query(
      `INSERT INTO schools (user_id, school_name, coordinator_name, designation, principal_name, principal_email, branch_name, city, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [user.id, schoolName, coordinatorName, designation, principalName, principalEmail, branchName, city]
    );

    return created(res, { id: user.id, email: user.email, role: user.role, status: 'pending' }, 'School registered. Please wait a few minutes for approval.');
  } catch (err) {
    return next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await query('SELECT id, email, password_hash, role, must_change_password FROM users WHERE email = $1', [email]);

    if (result.rowCount === 0) {
      return fail(res, 401, 'Invalid credentials');
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return fail(res, 401, 'Invalid credentials');
    }

    if (user.role === 'school') {
      const schoolResult = await query('SELECT status FROM schools WHERE user_id = $1', [user.id]);
      const status = schoolResult.rows[0]?.status || 'pending';
      if (status !== 'approved') {
        return fail(res, 403, 'School account awaiting approval.Please wait a few minutes for approval.');
      } 
    }

    // Onboarding state (students created via bulk upload must change password + complete profile)
    let profileCompleted = true;
    if (user.role === 'student') {
      const studentResult = await query('SELECT profile_completed FROM students WHERE user_id = $1', [user.id]);
      profileCompleted = studentResult.rows[0]?.profile_completed ?? true;
    }

    const token = signAccessToken({ id: user.id, role: user.role, email: user.email });
    const refreshToken = signRefreshToken({ id: user.id, role: user.role });

    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')',
      [user.id, refreshToken]
    );

    return ok(res, {
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
        profileCompleted
      }
    }, 'Login successful');
  } catch (err) {
    return next(err);
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const result = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return ok(res, { }, 'If the email exists, a reset token has been generated');
    }

    const userId = result.rows[0].id;
    const token = uuidv4().replace(/-/g, '');
    await query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\')',
      [userId, token]
    );

    return ok(res, { resetToken: token }, 'Password reset token generated');
  } catch (err) {
    return next(err);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { email, resetToken, newPassword } = req.body;
    const userResult = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rowCount === 0) {
      return fail(res, 400, 'Invalid reset token');
    }

    const userId = userResult.rows[0].id;
    const tokenResult = await query(
      'SELECT id, expires_at, used_at FROM password_reset_tokens WHERE user_id = $1 AND token = $2',
      [userId, resetToken]
    );

    if (tokenResult.rowCount === 0) {
      return fail(res, 400, 'Invalid reset token');
    }

    const tokenRow = tokenResult.rows[0];
    if (tokenRow.used_at) {
      return fail(res, 400, 'Reset token already used');
    }
    if (new Date(tokenRow.expires_at) < new Date()) {
      return fail(res, 400, 'Reset token expired');
    }

    const hash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, userId]);
    await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [tokenRow.id]);

    return ok(res, {}, 'Password updated');
  } catch (err) {
    return next(err);
  }
};

const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const payload = verifyRefreshToken(refreshToken);

    const tokenResult = await query(
      'SELECT id, revoked_at, expires_at FROM refresh_tokens WHERE token = $1',
      [refreshToken]
    );

    if (tokenResult.rowCount === 0) {
      return fail(res, 401, 'Invalid refresh token');
    }

    const tokenRow = tokenResult.rows[0];
    if (tokenRow.revoked_at || new Date(tokenRow.expires_at) < new Date()) {
      return fail(res, 401, 'Refresh token expired');
    }

    const accessToken = signAccessToken({ id: payload.id, role: payload.role });
    return ok(res, { token: accessToken }, 'Token refreshed');
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  registerIndividual,
  registerSchool,
  login,
  forgotPassword,
  resetPassword,
  refreshToken
};
