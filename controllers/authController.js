const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const token = jwt.sign(
      { user_id: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" } // Changed to 7 days
    );

    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: "Login error" });
  }
};
exports.loginForm = (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Login</title>
        <style>
          body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial, sans-serif; background-color: #f5f5f5; }
          form { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
          input { display: block; width: 250px; padding: 10px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 4px; }
          button { width: 100%; padding: 10px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
          button:hover { background-color: #0056b3; }
        </style>
      </head>
      <body>
        <form method="POST" action="/login">
          <input type="password" name="password" placeholder="Enter password" required>
          <button type="submit">Login</button>
        </form>
      </body>
    </html>
  `);
};
