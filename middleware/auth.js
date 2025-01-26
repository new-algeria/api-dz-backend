const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const token = req.headers['x-access-token'] || req.headers['authorization'];
  
  if (!token) {
    return res.status(403).json({ error: "A token is required for authentication" });
  }

  try {
    const bearer = token.startsWith('Bearer ') ? token.slice(7) : token;
    const decoded = jwt.verify(bearer, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid Token" });
  }
};

module.exports = verifyToken;
