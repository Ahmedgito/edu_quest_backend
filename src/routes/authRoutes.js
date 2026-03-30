const express = require('express');
const { validate } = require('../middleware/validate');
const authController = require('../controllers/authController');
const authSchemas = require('../validators/auth');

const router = express.Router();

router.post('/register-individual', validate(authSchemas.registerIndividual), authController.registerIndividual);
router.post('/register-school', validate(authSchemas.registerSchool), authController.registerSchool);
router.post('/login', validate(authSchemas.login), authController.login);
router.post('/forgot-password', validate(authSchemas.forgotPassword), authController.forgotPassword);
router.post('/reset-password', validate(authSchemas.resetPassword), authController.resetPassword);
router.post('/refresh-token', validate(authSchemas.refreshToken), authController.refreshToken);

module.exports = router;
