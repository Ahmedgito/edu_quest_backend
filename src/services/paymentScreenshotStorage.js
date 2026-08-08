const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

/**
 * Storage for manually-submitted payment screenshots.
 *
 * Files live outside the web root and are only ever served back through an
 * authenticated route, so a screenshot (which shows a bank account) is never
 * reachable by guessing a URL.
 *
 * Uploads are taken into memory first: the declared mime type is attacker
 * controlled, so the real file signature is checked before anything is written
 * to disk, and the stored name is generated rather than derived from the
 * client's filename (which would allow path traversal).
 */

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'payments');
const MAX_BYTES = 5 * 1024 * 1024;

/** Accepted formats, keyed by the extension we store them under. */
const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) =>
      b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP'
  },
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.slice(0, 4).toString('ascii') === '%PDF' }
];

const ACCEPTED_LABEL = 'JPG, PNG, WEBP or PDF';

/** Multer instance: memory only, hard size cap, cheap mime pre-filter. */
const uploadScreenshot = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(String(file.mimetype).toLowerCase())) {
      const err = new Error(`Screenshot must be ${ACCEPTED_LABEL}`);
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  }
}).single('screenshot');

/**
 * Express middleware wrapper turning multer's errors into clean 400s instead of
 * an unhandled 500 from the generic handler.
 */
const receiveScreenshot = (req, res, next) => {
  uploadScreenshot(req, res, (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'Screenshot exceeds the 5MB size limit'
          : err.message || 'Upload failed';
      return next(Object.assign(new Error(message), { status: err.status || 400 }));
    }
    return next();
  });
};

/** Identify the real format from the file's own bytes, or null if unsupported. */
const detectFormat = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return SIGNATURES.find((sig) => sig.test(buffer)) || null;
};

/**
 * Persist an uploaded buffer. Returns the record to store on the payment row.
 * Throws a 400-tagged error when the bytes are not a supported format.
 */
const saveScreenshot = async (file) => {
  if (!file || !file.buffer) {
    const err = new Error('Payment screenshot is required');
    err.status = 400;
    throw err;
  }

  const format = detectFormat(file.buffer);
  if (!format) {
    const err = new Error(`Screenshot must be a valid ${ACCEPTED_LABEL} file`);
    err.status = 400;
    throw err;
  }

  await fsp.mkdir(UPLOAD_ROOT, { recursive: true });

  // Generated name — the client's filename never reaches the filesystem.
  const storedName = `${Date.now()}-${crypto.randomUUID()}.${format.ext}`;
  await fsp.writeFile(path.join(UPLOAD_ROOT, storedName), file.buffer);

  return {
    path: storedName,
    mime: format.mime,
    size: file.buffer.length
  };
};

/** Best-effort cleanup, used when the database write fails after the file landed. */
const deleteScreenshot = async (storedName) => {
  if (!storedName) return;
  try {
    await fsp.unlink(resolveScreenshotPath(storedName));
  } catch {
    // Already gone, or never written — nothing to undo.
  }
};

/**
 * Absolute path for a stored screenshot. Rejects anything that escapes the
 * upload directory, so a tampered database value cannot read arbitrary files.
 */
function resolveScreenshotPath(storedName) {
  const resolved = path.resolve(UPLOAD_ROOT, String(storedName || ''));
  const root = path.resolve(UPLOAD_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const err = new Error('Invalid screenshot path');
    err.status = 400;
    throw err;
  }
  return resolved;
}

/** True when the file is still on disk. */
const screenshotExists = (storedName) => {
  try {
    return fs.existsSync(resolveScreenshotPath(storedName));
  } catch {
    return false;
  }
};

module.exports = {
  MAX_BYTES,
  ACCEPTED_LABEL,
  receiveScreenshot,
  saveScreenshot,
  deleteScreenshot,
  resolveScreenshotPath,
  screenshotExists
};
