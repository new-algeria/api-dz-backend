const express = require("express");
const router = express.Router();
const apiController = require("../controllers/apiController.js");
const cors = require('cors');
const customOrigins = ['https://data-dz.com'];

// Route: /api/details/:slug
router.get("/details/:slug", apiController.getDetails);

// Route: /api/random/:slug
router.get('/random/:slug', cors({ origin: customOrigins }), apiController.getRandomItems);

module.exports = router;
