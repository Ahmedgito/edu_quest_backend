const express = require('express');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { validate } = require('../middleware/validate');
const schoolController = require('../controllers/schoolController');
const paymentController = require('../controllers/paymentController');
const paymentSchemas = require('../validators/payment');
const schoolSchemas = require('../validators/school');
const { receiveScreenshot } = require('../services/paymentScreenshotStorage');

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

// Wrap multer so its errors (file too large, wrong type) become clean 400s
// instead of an unhandled 500 from the generic error handler.
const uploadCsv = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? 'CSV file exceeds the 5MB size limit'
          : `Upload error: ${err.message}`;
        return next(Object.assign(new Error(message), { status: 400 }));
      }
      return next(Object.assign(err, { status: err.status || 400 }));
    }
    return next();
  });
};

const router = express.Router();

router.use(auth, requireRole('school'));

router.get('/students', validate(schoolSchemas.listStudents), schoolController.listSchoolStudents);
router.get('/bulk-registration-template', schoolController.downloadTemplate);
router.post('/bulk-registration', uploadCsv, schoolController.bulkRegistration);

// Payments — one screenshot can cover many of the school's students.
router.get('/payment-settings', paymentController.getPaymentSettings);
router.get('/payments', paymentController.schoolPayments);
router.get(
  '/payable-students',
  validate(paymentSchemas.payableStudents),
  paymentController.schoolPayableStudents
);
router.post(
  '/payments',
  receiveScreenshot,
  validate(paymentSchemas.schoolPayment),
  paymentController.submitSchoolPayment
);

module.exports = router;
