const express = require('express');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const schoolController = require('../controllers/schoolController');

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isCsvMime = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel';
    const isCsvExt = String(file.originalname || '').toLowerCase().endsWith('.csv');
    if (!isCsvMime && !isCsvExt) {
      const err = new Error('Only CSV files are allowed');
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  }
});
const router = express.Router();

router.use(auth, requireRole('school'));

router.get('/bulk-registration-template', schoolController.downloadTemplate);
router.post('/bulk-registration', upload.single('file'), schoolController.bulkRegistration);

module.exports = router;
