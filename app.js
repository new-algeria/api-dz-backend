require('dotenv').config({ path: '.env.local' });  // Specify the correct .env file
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');
const authController = require("./controllers/authController");
const excludePath = require('./middleware/excludePath');
const { getTokenMapping } = require('./utils/tokenMapper');
const { handleDownload } = require('./utils/downloadHandler');


const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
const allowedOrigins = ['https://www.data-dz.com',
            'https://api.data-dz.com'
            ];

// Add localhost regex pattern
const localhostRegex = /^http:\/\/localhost(:[0-9]+)?$/;
  
app.use(cors({
  origin: function (origin, callback) {
  if (!origin || allowedOrigins.includes(origin) || localhostRegex.test(origin)) {
    callback(null, true);
  } else {
    callback(new Error('Not allowed by CORS'));
  }
  },
  methods: ["GET", "POST"],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Add this line to parse JSON bodies

// Auth routes at root level
app.get("/login", authController.loginForm);
app.post("/login", authController.login);

// Short URL handler (before API routes)
app.get('/:token([a-f0-9]{12})', async (req, res) => {
  try {
    const mapping = getTokenMapping(req.params.token);
    if (!mapping) {
      return res.status(404).json({ error: "Download link not found or expired" });
    }
    
    // Destructure mapping and assign to req.params
    const { slug, format, downloadToken } = mapping;
    Object.assign(req.params, { slug, format, token: downloadToken });
    
    // Handle download directly
    await handleDownload(req, res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Protect all /api routes with JWT except specific paths
app.use("/api", excludePath(allowedOrigins), apiRoutes);

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});