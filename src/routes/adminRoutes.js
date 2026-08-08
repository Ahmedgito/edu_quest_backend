const express = require('express');
const rateLimit = require('express-rate-limit');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { validate } = require('../middleware/validate');
const { fail } = require('../utils/response');
const adminController = require('../controllers/adminController');
const paymentController = require('../controllers/paymentController');
const adminSchemas = require('../validators/admin');
const paymentSchemas = require('../validators/payment');

const certificateSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => fail(res, 429, 'Too many certificate send requests. Try again later.')
});

const router = express.Router();

router.use(auth, requireRole('admin'));

router.get('/dashboard', adminController.adminDashboard);
router.get('/schools', adminController.listSchools);
router.get('/school/:id', validate(adminSchemas.idParam), adminController.getSchool);
router.post('/school-approve/:id', validate(adminSchemas.idParam), adminController.approveSchool);
router.post('/school-reject/:id', validate(adminSchemas.idParam), adminController.rejectSchool);
router.get('/students', adminController.listStudents);
router.delete('/student/:id', validate(adminSchemas.idParam), adminController.deleteStudent);

router.post('/competitions', validate(adminSchemas.competitionCreate), adminController.createCompetition);
router.get('/competitions', adminController.listCompetitions);
router.get('/certificate-competitions', adminController.listCertificateEligibleCompetitions);
router.post(
  '/competition/:id/send-certificates',
  certificateSendLimiter,
  validate(adminSchemas.sendCertificates),
  adminController.sendCompetitionCertificates
);
router.put('/competition/:id/winners', validate(adminSchemas.setWinners), adminController.setCompetitionWinners);
router.get('/competition/:id', validate(adminSchemas.idParam), adminController.getCompetition);
router.put('/competition/:id', validate(adminSchemas.competitionUpdate), adminController.updateCompetition);
router.delete('/competition/:id', validate(adminSchemas.idParam), adminController.deleteCompetition);
router.get('/competition-participants/:id', validate(adminSchemas.idParam), adminController.competitionParticipants);
router.delete('/competition-participant/:id/:studentId', validate(adminSchemas.participants), adminController.removeParticipant);

// Payment verification
router.get('/payments', validate(paymentSchemas.listPayments), paymentController.listPayments);
router.get('/payment-settings', paymentController.getPaymentSettings);
router.put('/payment-settings', validate(paymentSchemas.updateSettings), paymentController.updatePaymentSettings);
router.get('/payment/:id', validate(paymentSchemas.paymentIdParam), paymentController.getPayment);
router.get('/payment/:id/screenshot', validate(paymentSchemas.paymentIdParam), paymentController.getPaymentScreenshot);
router.post('/payment/:id/verify', validate(paymentSchemas.paymentIdParam), paymentController.verifyPayment);
router.post('/payment/:id/reject', validate(paymentSchemas.rejectPayment), paymentController.rejectPayment);

router.get('/announcement', adminController.getAnnouncement);
router.put('/announcement', validate(adminSchemas.announcementUpdate), adminController.updateAnnouncement);

module.exports = router;
