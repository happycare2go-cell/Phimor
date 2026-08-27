const { tenantResolver } = require('../services/tenantResolver');
const { publicIntegrationError } = require('../domain/integrationErrorContract');

function bearerToken(req) {
  const value = String(req.header('Authorization') || '');
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : null;
}

function createRequireIntegration(overrides = {}) {
  const resolver = overrides.tenantResolver || tenantResolver;
  return async function requireIntegration(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ status:'rejected', error:publicIntegrationError('INVALID_CREDENTIAL', { status:401 }) });
    try {
      req.integration = await resolver.resolveIntegrationCredential(token);
      return next();
    } catch (error) {
      if (Number(error?.status) < 500) {
        return res.status(error.status).json({ status:'rejected', error:publicIntegrationError(error, { status:error.status }) });
      }
      const safe = publicIntegrationError(error, { status:500 });
      console.error('[Integration Auth]', JSON.stringify({ event:'integration_auth_unavailable', requestId:safe.request_id, code:safe.code, retryable:safe.retryable }));
      return res.status(500).json({ status:'retrying', error:safe });
    }
  };
}

module.exports = { bearerToken, createRequireIntegration };
