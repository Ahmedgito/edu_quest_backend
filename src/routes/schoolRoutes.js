const express = require('express');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const schoolController = require('../controllers/schoolController');

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
const router = express.Router();

router.use(auth, requireRole('school'));

router.get('/bulk-registration-template', schoolController.downloadTemplate);
router.post('/bulk-registration', upload.single('file'), schoolController.bulkRegistration);

module.exports = router;
