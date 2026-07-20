const nodemailer = require('nodemailer');
const { env } = require('../config/env');

function createMailTransport() {
  if (!env.smtpHost) {
    return null;
  }
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth:
      env.smtpUser && env.smtpPass
        ? {
            user: env.smtpUser,
            pass: env.smtpPass
          }
        : undefined
  });
}

module.exports = { createMailTransport };
