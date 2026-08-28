const { createHash } = require('node:crypto');
const { databaseQuery } = require('../db');

class SharedRateLimitUnavailableError extends Error {
  constructor() {
    super('ระบบจำกัดอัตราการใช้งานไม่พร้อม กรุณาลองใหม่ภายหลัง');
    this.name = 'SharedRateLimitUnavailableError';
    this.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
    this.status = 503;
  }
}

function hashIdentity(domain, identity, windowMs) {
  return createHash('sha256')
    .update(`${domain}\u0000${identity}\u0000${windowMs}`)
    .digest('hex');
}

function createPostgresRateLimitRepository({ queryFn = databaseQuery } = {}) {
  return {
    async consume({ keyHash, domain, limit, windowMs, at }) {
      const result = await queryFn(`
        INSERT INTO shared_rate_limit_windows (
          key_hash, domain, window_started_at, window_expires_at, request_count, updated_at
        ) VALUES ($1, $2, $3::timestamptz, $3::timestamptz + ($4::bigint * interval '1 millisecond'), 1, $3::timestamptz)
        ON CONFLICT (key_hash) DO UPDATE SET
          domain = EXCLUDED.domain,
          request_count = CASE
            WHEN shared_rate_limit_windows.window_expires_at <= EXCLUDED.window_started_at THEN 1
            ELSE LEAST(shared_rate_limit_windows.request_count + 1, $5::integer + 1)
          END,
          window_started_at = CASE
            WHEN shared_rate_limit_windows.window_expires_at <= EXCLUDED.window_started_at THEN EXCLUDED.window_started_at
            ELSE shared_rate_limit_windows.window_started_at
          END,
          window_expires_at = CASE
            WHEN shared_rate_limit_windows.window_expires_at <= EXCLUDED.window_started_at THEN EXCLUDED.window_expires_at
            ELSE shared_rate_limit_windows.window_expires_at
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING request_count, window_expires_at
      `, [keyHash, domain, at.toISOString(), windowMs, limit]);
      return result.rows[0];
    },
    async cleanupExpired({ at, limit }) {
      const result = await queryFn(`
        WITH expired AS (
          SELECT key_hash FROM shared_rate_limit_windows
          WHERE window_expires_at < $1::timestamptz - interval '1 hour'
          ORDER BY window_expires_at
          LIMIT $2
        )
        DELETE FROM shared_rate_limit_windows target
        USING expired
        WHERE target.key_hash = expired.key_hash
      `, [at.toISOString(), limit]);
      return { removed: Number(result.rowCount || 0) };
    },
    async health() {
      const result = await queryFn("SELECT to_regclass('public.shared_rate_limit_windows') AS table_name");
      if (!result.rows?.[0]?.table_name) throw new Error('SHARED_RATE_LIMIT_SCHEMA_MISSING');
      return { available:true, shared:true };
    },
    reset() {},
  };
}

function createMemoryRateLimitRepository() {
  const windows = new Map();
  return {
    async consume({ keyHash, domain, limit, windowMs, at }) {
      const currentTime = at.getTime();
      let current = windows.get(keyHash);
      if (!current || current.windowExpiresAt <= currentTime) {
        current = { domain, requestCount: 0, windowExpiresAt: currentTime + windowMs };
      }
      current.requestCount = Math.min(limit + 1, current.requestCount + 1);
      windows.set(keyHash, current);
      return {
        request_count: current.requestCount,
        window_expires_at: new Date(current.windowExpiresAt).toISOString(),
      };
    },
    async cleanupExpired({ at }) {
      let removed = 0;
      for (const [key, value] of windows.entries()) {
        if (value.windowExpiresAt < at.getTime() - 60 * 60 * 1000) {
          windows.delete(key); removed += 1;
        }
      }
      return { removed };
    },
    async health() { return { available:true, shared:true, testStore:true }; },
    reset() { windows.clear(); },
    size() { return windows.size; },
    snapshot() { return [...windows.entries()].map(([keyHash, value]) => ({ keyHash, ...value })); },
  };
}

function createSharedRateLimitService({ repository, now = () => new Date() } = {}) {
  const store = repository || (process.env.NODE_ENV === 'test'
    ? createMemoryRateLimitRepository() : createPostgresRateLimitRepository());

  async function checkAndRecord(identity, limit, windowMs, options = {}) {
    const cleanIdentity = String(identity || '').trim();
    const domain = String(options.domain || 'generic_api').trim();
    const boundedLimit = Math.max(1, Math.min(100000, Number(limit) || 1));
    const boundedWindowMs = Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(windowMs) || 60000));
    if (!cleanIdentity || cleanIdentity.length > 512 || !/^[a-z][a-z0-9_.:-]{0,79}$/i.test(domain)) {
      throw new SharedRateLimitUnavailableError();
    }
    const at = now();
    try {
      const row = await store.consume({
        keyHash: hashIdentity(domain, cleanIdentity, boundedWindowMs), domain,
        limit: boundedLimit, windowMs: boundedWindowMs, at,
      });
      const count = Number(row?.request_count);
      const expiresAt = new Date(row?.window_expires_at).getTime();
      if (!Number.isFinite(count) || !Number.isFinite(expiresAt)) throw new Error('INVALID_RATE_LIMIT_RESULT');
      const allowed = count <= boundedLimit;
      return {
        allowed, remaining: Math.max(0, boundedLimit - count),
        retryAfterMs: allowed ? 0 : Math.max(1000, expiresAt - at.getTime()),
      };
    } catch (error) {
      if (error instanceof SharedRateLimitUnavailableError) throw error;
      throw new SharedRateLimitUnavailableError();
    }
  }

  async function cleanupExpired(limit = 1000) {
    try { return await store.cleanupExpired({ at: now(), limit: Math.max(1, Math.min(10000, Number(limit) || 1000)) }); }
    catch (_) { throw new SharedRateLimitUnavailableError(); }
  }

  async function getHealth() {
    try { return await store.health(); }
    catch (_) { return { available:false, shared:true }; }
  }

  function reset() { store.reset?.(); }
  return { checkAndRecord, cleanupExpired, getHealth, reset, repository: store };
}

module.exports = {
  SharedRateLimitUnavailableError, hashIdentity,
  createPostgresRateLimitRepository, createMemoryRateLimitRepository, createSharedRateLimitService,
};
