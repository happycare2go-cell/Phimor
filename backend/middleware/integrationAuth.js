const { tenantResolver } = require('../services/tenantResolver');

function bearerToken(req) {
  const value = String(req.header('Authorization') || '');
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : null;
}

function createRequireIntegration(overrides = {}) {
  const resolver = overrides.tenantResolver || tenantResolver;
  return async function requireIntegration(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'unauthorized', message: 'ไม่พบ Integration credential' });
    try {
      req.integration = await resolver.resolveIntegrationCredential(token);
      return next();
    } catch (error) {
      if (Number(error?.status) < 500) {
        return res.status(error.status).json({ error: 'unauthorized', errorCode: error.code, message: 'Integration credential ไม่ถูกต้องหรือถูกเพิกถอนแล้ว' });
      }
      return next(error);
    }
  };
}

module.exports = { bearerToken, createRequireIntegration };
