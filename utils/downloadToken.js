const crypto = require("crypto");

const SECRET_TOKEN_LINK = process.env.SECRET_TOKEN_LINK;

function generateDownloadToken(slug, format) {
  // Create data string
  const dataString = `${slug}.${format}`;

  // Compute HMAC
  const signature = crypto
    .createHmac("sha256", SECRET_TOKEN_LINK)
    .update(dataString)
    .digest("hex");

  // Combine and encode
  const tokenString = `${dataString}.${signature}`;
  return Buffer.from(tokenString).toString("base64url");
}

function verifyDownloadToken(token, slug, format) {
  try {
    const tokenString = Buffer.from(token, "base64url").toString("utf8");
    const [tokenSlug, tokenFormat, providedSignature] = tokenString.split(".");
    
    if (!tokenSlug || !tokenFormat || !providedSignature) {
      return false;
    }

    // Verify slug and format match
    if (tokenSlug !== slug || tokenFormat !== format) {
      return false;
    }

    // Verify signature
    const dataString = `${tokenSlug}.${tokenFormat}`;
    const expectedSignature = crypto
      .createHmac("sha256", SECRET_TOKEN_LINK)
      .update(dataString)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(providedSignature),
      Buffer.from(expectedSignature)
    );
  } catch (err) {
    return false;
  }
}

module.exports = {
  generateDownloadToken,
  verifyDownloadToken
};