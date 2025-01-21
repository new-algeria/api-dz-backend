const express = require("express");
const router = express.Router();
const apiController = require("../controllers/apiController.js");

// Route: /api/details/:slug
router.get("/details/:slug", apiController.getDetails);

module.exports = router;
