const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

/**
 * Storage for competition study material (syllabus, manual, preparation guide).
 *
 * Unlike payment screenshots these are meant to be downloaded by the public, so
 * the download route is unauthenticated. They still live outside the web root
 * and are streamed through a route rather than served statically, which keeps
 * the stored filename an implementation detail and lets us force a download
 * instead of letting a browser render the file inline.
 *
 * Uploads are taken into memory first so the real file signature can be checked
 * before anything is written: the declared mime type is client controlled. The
 * stored name is generated, never derived from the client's filename, so a name
 * like "../../app.js" cannot escape the upload directory.
 */

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'materials');
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Accepted formats. DOCX and PPTX are ZIP containers, so their bytes are
 * indistinguishable from each other; the declared mime picks between them and
 * only decides the stored extension. That is acceptable because uploading is
 * admin-only and every download is sent as an attachment, never rendered.
 */
const ZIP_MAGIC = (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);

const SIGNATURES = [
  {
    ext: 'pdf',
    mime: 'application/pdf',
    mimes: ['application/pdf'],
    test: (b) => b.slice(0, 4).toString('ascii') === '%PDF'
  },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    test: ZIP_MAGIC
  },
  {
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    test: ZIP_MAGIC
  }
];

const ACCEPTED_MIMES = SIGNATURES.flatMap((s) => s.mimes);
const ACCEPTED_LABEL = 'PDF, DOCX or PPTX';

/** What the download button is called. Kept in sync with the client's list. */
const MATERIAL_LABELS = ['Syllabus', 'Manual', 'How to Prepare', 'Study Material', 'Past Paper'];
const DEFAULT_LABEL = 'Study Material';

const uploadMaterial = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_MIMES.includes(String(file.mimetype).toLowerCase())) {
      const err = new Error(`Material must be ${ACCEPTED_LABEL}`);
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  }
}).single('material');

/** Turns multer's errors into clean 400s instead of an unhandled 500. */
const receiveMaterial = (req, res, next) => {
  uploadMaterial(req, res, (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'Material exceeds the 20MB size limit'
          : err.message || 'Upload failed';
      return next(Object.assign(new Error(message), { status: err.status || 400 }));
    }
    return next();
  });
};

/** Identify the format from the file's own bytes plus its declared mime. */
const detectFormat = (buffer, declaredMime) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  const mime = String(declaredMime || '').toLowerCase();
  const byMime = SIGNATURES.find((sig) => sig.mimes.includes(mime));
  if (byMime && byMime.test(buffer)) return byMime;
  return SIGNATURES.find((sig) => sig.test(buffer)) || null;
};

/** Strip anything that is not a plain filename, for the Content-Disposition. */
const safeDownloadName = (original, ext) => {
  const base = path
    .basename(String(original || ''))
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w \-.]/g, '')
    .trim()
    .slice(0, 80);
  return `${base || 'material'}.${ext}`;
};

/**
 * Persist an uploaded buffer. Returns the record to store on the competition.
 * Throws a 400-tagged error when the bytes are not a supported format.
 */
const saveMaterial = async (file) => {
  if (!file || !file.buffer) {
    const err = new Error('Material file is required');
    err.status = 400;
    throw err;
  }

  const format = detectFormat(file.buffer, file.mimetype);
  if (!format) {
    const err = new Error(`Material must be a valid ${ACCEPTED_LABEL} file`);
    err.status = 400;
    throw err;
  }

  await fsp.mkdir(UPLOAD_ROOT, { recursive: true });

  const storedName = `${Date.now()}-${crypto.randomUUID()}.${format.ext}`;
  await fsp.writeFile(path.join(UPLOAD_ROOT, storedName), file.buffer);

  return {
    path: storedName,
    name: safeDownloadName(file.originalname, format.ext),
    mime: format.mime,
    size: file.buffer.length
  };
};

/** Best-effort cleanup, used when the database write fails after the file landed. */
const deleteMaterial = async (storedName) => {
  if (!storedName) return;
  try {
    await fsp.unlink(resolveMaterialPath(storedName));
  } catch {
    // Already gone, or never written.
  }
};

/**
 * Absolute path for a stored file. Rejects anything that escapes the upload
 * directory, so a tampered database value cannot read arbitrary files.
 */
function resolveMaterialPath(storedName) {
  const resolved = path.resolve(UPLOAD_ROOT, String(storedName || ''));
  const root = path.resolve(UPLOAD_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const err = new Error('Invalid material path');
    err.status = 400;
    throw err;
  }
  return resolved;
}

/** True when the file is still on disk. */
const materialExists = (storedName) => {
  try {
    return Boolean(storedName) && fs.existsSync(resolveMaterialPath(storedName));
  } catch {
    return false;
  }
};

module.exports = {
  MAX_BYTES,
  ACCEPTED_LABEL,
  MATERIAL_LABELS,
  DEFAULT_LABEL,
  receiveMaterial,
  saveMaterial,
  deleteMaterial,
  resolveMaterialPath,
  materialExists
};
