const verifyToken = require('./auth');

const excludePath = (whitelistedOrigins, excludedPaths) => {
  const origins = Array.isArray(whitelistedOrigins) ? whitelistedOrigins : [whitelistedOrigins];
  const paths = Array.isArray(excludedPaths) ? excludedPaths : [excludedPaths];
  
  console.log(`[DEBUG] Whitelist initialized with origins: ${origins.join(', ')}`);
  console.log(`[DEBUG] Excluded paths: ${paths.join(', ')}`);

  return (req, res, next) => {
    console.log('\n=== NEW REQUEST ===');
    console.log(`[DEBUG] Incoming request: ${req.method} ${req.originalUrl}`);
    console.log('[DEBUG] Request headers:', req.headers);
    console.log('[DEBUG] Query parameters:', req.query);
    
    // Get referring website information
    const referer = req.get('Referer');
    console.log(`[DEBUG] Raw Referer header: ${referer || 'null'}`);

    let refererOrigin = null;
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        refererOrigin = refererUrl.origin;
        console.log(`[DEBUG] Parsed Referer details:
          - Origin: ${refererOrigin}
          - Protocol: ${refererUrl.protocol}
          - Hostname: ${refererUrl.hostname}
          - Port: ${refererUrl.port || 'default'}
          - Path: ${refererUrl.pathname}`);
      } catch (error) {
        console.error('[ERROR] Invalid Referer URL:', error.message);
        console.log('[DEBUG] Malformed Referer value:', referer);
      }
    }

    console.log(`[DEBUG] Computed Referer origin: ${refererOrigin || 'null'}`);
    console.log(`[DEBUG] Current whitelist: ${JSON.stringify(origins, null, 2)}`);

    // Check localhost variations
    const isLocalhost = refererOrigin ? 
      new URL(refererOrigin).hostname.match(/(localhost|127\.0\.0\.1)$/) : 
      false;
    
    console.log(`[DEBUG] Localhost check: ${isLocalhost ? 'MATCH' : 'NO MATCH'}`);

    // Check if path is in excluded list
    const isExcludedPath = paths.some(path => {
      const pathPattern = new RegExp('^/' + path + '(/[^/]+)?$');
      return pathPattern.test(req.path);
    });

    // If path is excluded, only check origin
    if (isExcludedPath) {
      console.log('[DEBUG] Path is excluded, checking origin only');
      // Whitelist verification logic
      let isWhitelisted = false;
      if (refererOrigin) {
        isWhitelisted = origins.includes(refererOrigin) || isLocalhost;
        console.log(`[DEBUG] Whitelist check:
          - Exact match: ${origins.includes(refererOrigin)}
          - Localhost match: ${isLocalhost}
          - Final whitelist status: ${isWhitelisted ? 'APPROVED' : 'REJECTED'}`);
      } else {
        console.log('[DEBUG] No Referer origin - skipping whitelist check');
      }

      if (isWhitelisted) {
        console.log(`[ACCESS] Allowing request from whitelisted origin: ${refererOrigin}`);
        console.log(`[DEBUG] Bypassing auth for ${req.method} ${req.originalUrl}`);
        return next();
      }
    }

    console.log('[AUTH] Origin not whitelisted or missing Referer - requiring authentication');
    console.log(`[DEBUG] Proceeding to verifyToken for ${req.method} ${req.originalUrl}`);
    
    verifyToken(req, res, (error) => {
      if (error) {
        console.error('[AUTH ERROR] Token verification failed:', error.message);
        console.log('[DEBUG] Failed request details:', {
          method: req.method,
          path: req.originalUrl,
          headers: req.headers,
          query: req.query
        });
        return res.status(401).json({ error: 'Unauthorized' });
      }
      console.log('[AUTH SUCCESS] Token verified successfully');
      next();
    });
  };
};

module.exports = excludePath;