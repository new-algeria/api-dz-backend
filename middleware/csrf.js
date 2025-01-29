const csrf = require('csurf');

const csrfProtection = csrf({ 
  cookie: true, 
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  sessionKey: 'session'
});

const handleCSRFError = (err, req, res, next) => {
  if (err.code !== 'EBADCSRFTOKEN') return next(err);
  
  // Handle CSRF token errors
  res.status(403).json({
    error: 'Invalid or expired CSRF token',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
};

module.exports = {
  csrfProtection,
  handleCSRFError
};
