const express = require('express');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { validate } = require('../middleware/validate');
const studentController = require('../controllers/studentController');
const paymentController = require('../controllers/paymentController');
const studentSchemas = require('../validators/student');
const paymentSchemas = require('../validators/payment');
const { receiveScreenshot } = require('../services/paymentScreenshotStorage');

const router = express.Router();

router.use(auth, requireRole('student'));

router.get('/profile', studentController.getProfile);
router.post('/set-password', validate(studentSchemas.setPassword), studentController.setPassword);
router.post('/complete-profile', validate(studentSchemas.completeProfile), studentController.completeProfile);
router.put('/profile', validate(studentSchemas.updateProfile), studentController.updateProfile);
router.post('/change-password', validate(studentSchemas.changePassword), studentController.changePassword);
router.get('/my-competitions', studentController.myCompetitions);
router.get('/available-competitions', validate(studentSchemas.availableCompetitions), studentController.availableCompetitions);
router.post('/competition-join/:id', validate(studentSchemas.joinCompetition), studentController.joinCompetition);

// Payments — the screenshot arrives as multipart, so it is parsed before validation.
router.get('/payment-settings', paymentController.getPaymentSettings);
router.get('/payments', paymentController.studentDuePayments);
router.post(
  '/payments',
  receiveScreenshot,
  validate(paymentSchemas.studentPayment),
  paymentController.submitStudentPayment
);

module.exports = router;
