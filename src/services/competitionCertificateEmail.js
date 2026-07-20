const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { createMailTransport } = require('./mailTransport');
const { runBulkPaced } = require('../config/bulkEmailRules');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'certificate.html');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCertificateHtml({
  studentName,
  competitionTitle,
  competitionCode,
  competitionDate,
  venue
}) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replace(/\{\{studentName\}\}/g, escapeHtml(studentName || 'Participant'))
    .replace(/\{\{competitionTitle\}\}/g, escapeHtml(competitionTitle || ''))
    .replace(/\{\{competitionCode\}\}/g, escapeHtml(competitionCode || ''))
    .replace(/\{\{competitionDate\}\}/g, escapeHtml(competitionDate || ''))
    .replace(/\{\{venue\}\}/g, escapeHtml(venue || ''));
}

/**
 * Sends one HTML email per participant using bulk pacing rules.
 * @returns {{ sentStudentIds: string[], failures: { studentId: string, error: string }[] }}
 */
async function sendCertificateEmailsBatched({ competition, rows }) {
  const transport = createMailTransport();
  if (!transport) {
    const err = new Error(
      'SMTP is not configured. Set SMTP_HOST (and SMTP_FROM / credentials as needed).'
    );
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const from = env.smtpFrom;
  if (!from) {
    const err = new Error('SMTP_FROM is not set.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const subjectBase = `Certificate — ${competition.title}`;
  const competitionDate = competition.start_date || '';
  const venue = competition.venue || '';

  const sentStudentIds = [];
  const failures = [];

  const jobs = rows.map((row) => ({
    studentId: row.student_id,
    to: row.email,
    html: renderCertificateHtml({
      studentName: row.name || row.email,
      competitionTitle: competition.title,
      competitionCode: competition.code,
      competitionDate,
      venue
    }),
    subject: subjectBase
  }));

  await runBulkPaced(jobs, async (job) => {
    try {
      await transport.sendMail({
        from,
        to: job.to,
        subject: job.subject,
        html: job.html
      });
      sentStudentIds.push(job.studentId);
    } catch (e) {
      failures.push({ studentId: job.studentId, error: e.message || 'Send failed' });
    }
  });

  return { sentStudentIds, failures };
}

module.exports = { renderCertificateHtml, sendCertificateEmailsBatched };
