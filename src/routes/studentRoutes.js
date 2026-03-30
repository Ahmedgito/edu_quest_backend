const express = require('express');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { validate } = require('../middleware/validate');
const studentController = require('../controllers/studentController');
const studentSchemas = require('../validators/student');

const router = express.Router();

router.use(auth, requireRole('student'));

router.get('/profile', studentController.getProfile);
router.put('/profile', validate(studentSchemas.updateProfile), studentController.updateProfile);
router.get('/my-competitions', studentController.myCompetitions);
router.get('/available-competitions', validate(studentSchemas.availableCompetitions), studentController.availableCompetitions);
router.post('/competition-join/:id', validate(studentSchemas.joinCompetition), studentController.joinCompetition);

module.exports = router;
