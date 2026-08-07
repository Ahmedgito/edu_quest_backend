const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { createMailTransport } = require('./mailTransport');
const { runBulkPaced } = require('../config/bulkEmailRules');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'certificate.html');
const AWARD_TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'certificate-award.html');

/**
 * Podium metadata. `award` values are the ones stored on
 * competition_participants; anything else is an ordinary participant.
 */
const AWARDS = {
  first: { label: 'First Place', color: '#b8860b', rank: 1 },
  second: { label: 'Second Place', color: '#8c8c94', rank: 2 },
  third: { label: 'Third Place', color: '#a9622f', rank: 3 }
};

/** Certificate type a participant should receive right now. */
const certificateTypeForAward = (award) => (AWARDS[award] ? award : 'participation');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce(
    (html, [key, value]) => html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), escapeHtml(value || '')),
    template
  );
}

function renderCertificateHtml({
  studentName,
  competitionTitle,
  competitionCode,
  competitionDate,
  venue,
  award
}) {
  const meta = AWARDS[award];
  const template = fs.readFileSync(meta ? AWARD_TEMPLATE_PATH : TEMPLATE_PATH, 'utf8');

  return fillTemplate(template, {
    studentName: studentName || 'Participant',
    competitionTitle,
    competitionCode,
    competitionDate,
    venue,
    // Colour is injected into a CSS value, so keep it to the known palette.
    awardLabel: meta ? meta.label : '',
    awardColor: meta ? meta.color : '#c4b08a'
  });
}

/**
 * Sends one HTML email per participant using bulk pacing rules. Each row may
 * carry an `award`, which selects the achievement certificate instead of the
 * participation one.
 *
 * @returns {{ sent: { studentId: string, certificateType: string }[], failures: { studentId: string, error: string }[] }}
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

  const competitionDate = competition.start_date || '';
  const venue = competition.venue || '';

  const sent = [];
  const failures = [];

  const jobs = rows.map((row) => {
    const meta = AWARDS[row.award];
    return {
      studentId: row.student_id,
      // The type is captured here, from the same snapshot the email is built
      // from, so what gets recorded always matches what was actually sent.
      certificateType: certificateTypeForAward(row.award),
      to: row.email,
      subject: meta
        ? `Congratulations — ${meta.label} in ${competition.title}`
        : `Certificate — ${competition.title}`,
      html: renderCertificateHtml({
        studentName: row.name || row.email,
        competitionTitle: competition.title,
        competitionCode: competition.code,
        competitionDate,
        venue,
        award: row.award
      })
    };
  });

  await runBulkPaced(jobs, async (job) => {
    try {
      await transport.sendMail({
        from,
        to: job.to,
        subject: job.subject,
        html: job.html
      });
      sent.push({ studentId: job.studentId, certificateType: job.certificateType });
    } catch (e) {
      failures.push({ studentId: job.studentId, error: e.message || 'Send failed' });
    }
  });

  return { sent, failures };
}

module.exports = {
  AWARDS,
  certificateTypeForAward,
  renderCertificateHtml,
  sendCertificateEmailsBatched
};
