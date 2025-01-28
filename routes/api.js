const express = require("express");
const router = express.Router();
const apiController = require("../controllers/apiController.js");
const cors = require('cors');
const { fetchUri } = require("../utils/fetchData");

const customOrigins = ['https://data-dz.com', 'https://www.data-dz.com'];
const corsOptions = { origin: customOrigins };

// Root route handler
router.get("/info", async (req, res) => {
    try {
      const data = await fetchUri(`${process.env.CLOUD_STORAGE_URL}/datas_description.json`);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch data descriptions" });
    }
  });
router.get("/details/:slug", cors(corsOptions), apiController.getDetails);
router.get('/random/:slug', cors(corsOptions), apiController.getRandomItems);
router.get('/random/:count/:slug', cors(corsOptions), apiController.getRandomItems);
router.get('/sample/:slug', cors(corsOptions), apiController.getSampleItems);
router.get("/download/:slug/:format/:token", cors(corsOptions), apiController.downloadFile);
router.get("/purchase/:slug/:format", cors(corsOptions), apiController.generateDownloadLink);
router.post('/notify', cors(corsOptions), apiController.sendNotification);

module.exports = router;
