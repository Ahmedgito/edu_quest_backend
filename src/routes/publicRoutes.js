const express = require('express');
const { validate } = require('../middleware/validate');
const publicController = require('../controllers/publicController');
const publicSchemas = require('../validators/public');

const router = express.Router();

router.get('/competitions', validate(publicSchemas.competitions), publicController.listCompetitions);
router.get('/competitions-search', validate(publicSchemas.competitionsSearch), publicController.searchCompetitions);
router.get('/competition/:id', validate(publicSchemas.competitionDetail), publicController.competitionDetail);
router.get('/announcement', publicController.announcementBanner);
router.post('/contact', validate(publicSchemas.contact), publicController.contact);

module.exports = router;
