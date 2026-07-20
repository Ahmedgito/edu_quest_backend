const express = require('express');
const rateLimit = require('express-rate-limit');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { validate } = require('../middleware/validate');
const { fail } = require('../utils/response');
const adminController = require('../controllers/adminController');
const adminSchemas = require('../validators/admin');

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
router.get('/competition/:id', validate(adminSchemas.idParam), adminController.getCompetition);
router.put('/competition/:id', validate(adminSchemas.competitionUpdate), adminController.updateCompetition);
router.delete('/competition/:id', validate(adminSchemas.idParam), adminController.deleteCompetition);
router.get('/competition-participants/:id', validate(adminSchemas.idParam), adminController.competitionParticipants);
router.delete('/competition-participant/:id/:studentId', validate(adminSchemas.participants), adminController.removeParticipant);

module.exports = router;
