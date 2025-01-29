const verifyToken = require('./auth');

const excludePath = (pathOrPaths) => {
  // Convert single path to array if not already an array
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  
  console.log('Excluded paths:', paths); // Log the excluded paths

  return (req, res, next) => {
    const currentPath = `${req.protocol}://${req.get('host')}`;
    console.log('Current request path:', currentPath); // Log the current request path

    if (paths.includes(currentPath)) {
      console.log('Path excluded from verification'); // Log when path is excluded
      next(); // Bypass JWT verification for these paths
    } else {
      console.log('Path requires verification'); // Log when verification is needed
      verifyToken(req, res, next); // Otherwise, use JWT verification
    }
  };
};

module.exports = excludePath;
