const express = require("express");
const router = express.Router();
const apiController = require("../controllers/apiController.js");
const cors = require('cors');

const customOrigins = ['https://data-dz.com'];
const corsOptions = { origin: customOrigins };

router.get("/details/:slug", apiController.getDetails);
router.get('/random/:slug', cors(corsOptions), apiController.getRandomItems);
router.get('/random/:count/:slug', cors(corsOptions), apiController.getRandomItems);
router.get('/sample/:slug', cors(corsOptions), apiController.getSampleItems);

module.exports = router;
