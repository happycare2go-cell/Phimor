(function initRuntimeConfig(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorRuntimeConfig = api;
}(typeof window !== 'undefined' ? window : globalThis, function runtimeConfigFactory() {
  class RuntimeConfigurationError extends Error {
    constructor(code) {
      super('LIFF runtime configuration is unavailable');
      this.name = 'RuntimeConfigurationError';
      this.code = code;
    }
  }

  function normalizeBackendUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      const localDevelopment = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) return null;
      if (url.username || url.password || url.search || url.hash) return null;
      if (url.pathname !== '/' && url.pathname !== '') return null;
      return url.origin;
    } catch (_) {
      return null;
    }
  }

  function requireBackendUrl(value) {
    const normalized = normalizeBackendUrl(value);
    if (!normalized) throw new RuntimeConfigurationError('PUBLIC_BACKEND_URL_MISSING');
    return normalized;
  }

  function assertBackendConfig(runtimeUrl, backendConfig = {}) {
    const expected = requireBackendUrl(runtimeUrl);
    const reported = normalizeBackendUrl(backendConfig.publicBackendUrl);
    if (!reported) throw new RuntimeConfigurationError('BACKEND_PUBLIC_URL_MISSING');
    if (reported !== expected) throw new RuntimeConfigurationError('BACKEND_URL_MISMATCH');
    return expected;
  }

  return { RuntimeConfigurationError, normalizeBackendUrl, requireBackendUrl, assertBackendConfig };
}));
