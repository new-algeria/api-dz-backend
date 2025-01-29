const verifyToken = require('./auth');

const excludePath = (pathOrPaths) => {
  // Convert single path to array if not already an array
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];

  return (req, res, next) => {
    console.log(">>> before Excluding path : " + `${req.protocol}://${req.hostname}`);
    if (paths.includes(`${req.protocol}://${req.hostname}`)) {
      console.log("Excluding path : " + `${req.protocol}://${req.hostname}`);
      next(); // Bypass JWT verification for these paths
    } else {
      verifyToken(req, res, next); // Otherwise, use JWT verification
    }
  };
};

module.exports = excludePath;
