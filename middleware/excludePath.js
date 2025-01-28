const verifyToken = require('./auth');

const excludePath = (pathOrPaths) => {
  // If pathOrPaths is an array, we'll check against any of the paths
  if (Array.isArray(pathOrPaths)) {
    return (req, res, next) => {
      if (pathOrPaths.includes(`${req.protocol}://${req.hostname}`)) {
        next(); // Bypass JWT verification for these paths
      } else {
        verifyToken(req, res, next); // Otherwise, use JWT verification
      }
    };
  } else {
    // If it's a single path, we check against it directly
    return (req, res, next) => {
      if (`${req.protocol}://${req.hostname}` === pathOrPaths) {
        next();
      } else {
        verifyToken(req, res, next);
      }
    };
  }
};

module.exports = excludePath;
