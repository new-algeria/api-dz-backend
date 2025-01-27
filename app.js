require('dotenv').config({ path: '.env.local' });  // Specify the correct .env file
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');
const authController = require("./controllers/authController");
const verifyToken = require("./middleware/auth");

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
const allowedOrigins = ['https://data-dz.com', 
            'https://www.data-dz.com',
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

// Auth routes at root level
app.get("/login", authController.loginForm);
app.post("/login", authController.login);

// Protect all /api routes with JWT
app.use("/api", verifyToken, apiRoutes);

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});