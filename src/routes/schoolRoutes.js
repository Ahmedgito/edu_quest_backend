const express = require('express');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { validate } = require('../middleware/validate');
const schoolController = require('../controllers/schoolController');
const paymentController = require('../controllers/paymentController');
const paymentSchemas = require('../validators/payment');
const schoolSchemas = require('../validators/school');
const { receiveScreenshot } = require('../services/paymentScreenshotStorage');

const router = express.Router();

router.use(auth, requireRole('school'));

router.get('/students', validate(schoolSchemas.listStudents), schoolController.listSchoolStudents);

// Registering students into a competition — typed in by the coordinator, no
// student logins are created.
router.get('/competitions', schoolController.listCompetitions);
router.get(
  '/competition/:id/entries',
  validate(schoolSchemas.competitionEntries),
  schoolController.listEntries
);
router.post('/competition/:id/entries', validate(schoolSchemas.addEntries), schoolController.addEntries);
router.patch(
  '/competition/:id/entries/:studentId',
  validate(schoolSchemas.updateEntry),
  schoolController.updateEntry
);
router.delete(
  '/competition/:id/entries/:studentId',
  validate(schoolSchemas.removeEntry),
  schoolController.removeEntry
);

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
