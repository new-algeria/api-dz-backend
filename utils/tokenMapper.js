const crypto = require('crypto');
const { console } = require('inspector');

// In-memory store (could be replaced with Redis or DB in production)
const tokenMappings = new Map();

function generateShortToken() {
  return crypto.randomBytes(6).toString('hex');
}

function createTokenMapping(slug, format, downloadToken) {
  const shortToken = generateShortToken();
  tokenMappings.set(shortToken, {
    slug,
    format,
    downloadToken,
    createdAt: Date.now()
  });
  return shortToken;
}

function getTokenMapping(shortToken) {
  console.log('Getting token mapping for:', shortToken);
  console.log('Available mappings:', [...tokenMappings.entries()]);
  const mapping = tokenMappings.get(shortToken);
  console.log('Found mapping:', mapping);
  if (!mapping) return null;
  
  // Optional: Clean up old tokens (older than 30 days)
  if (Date.now() - mapping.createdAt > 30 * 24 * 60 * 60 * 1000) {
    console.log('Token expired, removing mapping');
    tokenMappings.delete(shortToken);
    return null;
  }
  
  return mapping;
}

module.exports = {
  createTokenMapping,
  getTokenMapping
};
