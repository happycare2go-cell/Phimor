const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { logOperationalError } = require('./utils/safeOperationalError');

const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS = 2000;

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function createDatabasePoolConfig(env = process.env) {
    return {
        connectionString: env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        // Keep the current small-deployment capacity explicit. Scheduler
        // serialization, rather than a larger pool, preserves request capacity.
        max: boundedInteger(env.DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_MAX, 4, 20),
        // node-postgres otherwise waits indefinitely for a checked-out client.
        connectionTimeoutMillis: boundedInteger(
            env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
            DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS,
            250,
            10000,
        ),
    };
}

// เชื่อมต่อ PostgreSQL ผ่านตัวแปร DATABASE_URL
const poolConfig = createDatabasePoolConfig();
const pool = new Pool(poolConfig);

function safePoolErrorCode(error) {
    const value = String(error?.code || '').trim();
    return /^[0-9A-Z_]{2,32}$/.test(value) ? value : 'DATABASE_POOL_ERROR';
}

pool.on('error', (err) => {
    console.error('[Database Pool]', { event:'idle_client_error', errorCode:safePoolErrorCode(err) });
});

const now = () => new Date().toISOString();
// IDs and bearer-like invite tokens must not be truncated.  A full UUID gives
// enough entropy for links which may be forwarded outside the application.
const id = (prefix) => `${prefix}-${randomUUID()}`;
const isTest = process.env.NODE_ENV === 'test';
const memoryTables = new Map();
const testLocks = new Map();
const transactionStore = new AsyncLocalStorage();
const initPromises = [];

const query = (...args) => {
    const client = transactionStore.getStore();
    return (client || pool).query(...args);
};

// ฟังก์ชันสร้างตารางอัตโนมัติ
const initTable = async (tableName) => {
    if (isTest) return;
    const query = `
        CREATE TABLE IF NOT EXISTS "${tableName}" (
            id VARCHAR PRIMARY KEY,
            data JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(query);
    } catch (err) {
        logOperationalError(console.error, {
            event:'database_table_initialization_failed', error:err, routeCategory:'database_startup',
        });
    }
};

const findOneOrNull = (rows, predicate) => rows.find(predicate) || null;

function safeJsonbField(field) {
    const value = String(field || '');
    if (!/^[a-z0-9_]+$/i.test(value)) throw new Error('INVALID_JSONB_FIELD');
    return value;
}

function normalizeExplicitCriteria(criteria) {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)
        || (Object.getPrototypeOf(criteria) !== Object.prototype && Object.getPrototypeOf(criteria) !== null)) {
        throw new Error('INVALID_JSONB_CRITERIA');
    }
    const entries = Object.entries(criteria);
    if (!entries.length) throw new Error('EMPTY_JSONB_CRITERIA');
    return entries.map(([field, value]) => {
        const key = safeJsonbField(field);
        if (value === null || value === undefined || !['string', 'number', 'boolean'].includes(typeof value)) {
            throw new Error('INVALID_JSONB_CRITERIA_VALUE');
        }
        return [key, String(value)];
    }).sort(([left], [right]) => left.localeCompare(right));
}

function recordMatchesExplicitCriteria(record, entries) {
    return entries.every(([field, value]) => (
        Object.hasOwn(record, field) && record[field] !== null && String(record[field]) === value
    ));
}

function buildExplicitFieldQuery(tableName, criteria, { limitOne = false } = {}) {
    const safeTable = String(tableName || '');
    if (!/^[a-z0-9_]+$/i.test(safeTable)) throw new Error('INVALID_TABLE_NAME');
    const entries = normalizeExplicitCriteria(criteria);
    const predicates = entries.map(([field], index) => `data->>'${field}' = $${index + 1}`);
    return {
        sql:`SELECT data FROM "${safeTable}" WHERE ${predicates.join(' AND ')} ORDER BY created_at ASC, id ASC${limitOne ? ' LIMIT 1' : ''}`,
        values:entries.map(([, value]) => value),
        entries,
    };
}

// ฟังก์ชันแปลงคำสั่งจัดการฐานข้อมูล ให้ทำงานเข้ากับระบบเก่าได้เป๊ะๆ
const makeTable = (tableName) => {
    initPromises.push(initTable(tableName));
    if (isTest && !memoryTables.has(tableName)) memoryTables.set(tableName, []);

    const memory = () => memoryTables.get(tableName);
    const safeField = safeJsonbField;

    return {
        insert: async (data) => {
            if (isTest) {
                const record = { ...data, _createdAt: now(), _updatedAt: now() };
                memory().push(record);
                return record;
            }
            const recordId = randomUUID();
            const record = { ...data, _createdAt: now(), _updatedAt: now() };
            await query(`INSERT INTO "${tableName}" (id, data) VALUES ($1, $2)`, [recordId, record]);
            return record;
        },
        findAll: async () => {
            if (isTest) return [...memory()].reverse();
            const res = await query(`SELECT data FROM "${tableName}" ORDER BY created_at DESC`);
            return res.rows.map(row => row.data);
        },
        findWhere: async (predicate) => {
            if (isTest) return memory().filter(predicate);
            const res = await query(`SELECT data FROM "${tableName}"`);
            const allData = res.rows.map(row => row.data);
            return allData.filter(predicate);
        },
        findOne: async (predicate) => {
            if (isTest) return findOneOrNull(memory(), predicate);
            const res = await query(`SELECT data FROM "${tableName}"`);
            const allData = res.rows.map(row => row.data);
            return findOneOrNull(allData, predicate);
        },
        findOneByField: async (field, value) => {
            const key = safeField(field);
            if (isTest) return memory().find((record) => record[key] === value) || null;
            const res = await query(
                `SELECT data FROM "${tableName}" WHERE data->>'${key}' = $1 ORDER BY created_at ASC LIMIT 1`,
                [String(value)]
            );
            return res.rows[0]?.data || null;
        },
        findOneByFieldForUpdate: async (field, value) => {
            const key = safeField(field);
            if (isTest) return memory().find((record) => record[key] === value) || null;
            const res = await query(
                `SELECT data FROM "${tableName}" WHERE data->>'${key}' = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
                [String(value)]
            );
            return res.rows[0]?.data || null;
        },
        findWhereByField: async (field, value) => {
            const key = safeField(field);
            if (isTest) return memory().filter((record) => record[key] === value);
            const res = await query(
                `SELECT data FROM "${tableName}" WHERE data->>'${key}' = $1 ORDER BY created_at ASC`,
                [String(value)]
            );
            return res.rows.map((row) => row.data);
        },
        findOneByFields: async (criteria) => {
            const entries = normalizeExplicitCriteria(criteria);
            if (isTest) return memory().find((record) => recordMatchesExplicitCriteria(record, entries)) || null;
            const statement = buildExplicitFieldQuery(tableName, criteria, { limitOne:true });
            const res = await query(statement.sql, statement.values);
            return res.rows[0]?.data || null;
        },
        findWhereByFields: async (criteria) => {
            const entries = normalizeExplicitCriteria(criteria);
            if (isTest) return memory().filter((record) => recordMatchesExplicitCriteria(record, entries));
            const statement = buildExplicitFieldQuery(tableName, criteria);
            const res = await query(statement.sql, statement.values);
            return res.rows.map((row) => row.data);
        },
        update: async (predicate, patch) => {
            if (isTest) {
                const index = memory().findIndex(predicate);
                if (index < 0) return null;
                memory()[index] = { ...memory()[index], ...patch, _updatedAt: now() };
                return memory()[index];
            }
            const res = await query(`SELECT id, data FROM "${tableName}"`);
            const target = res.rows.find(row => predicate(row.data));
            if (!target) return null;
            
            const updatedRecord = { ...target.data, ...patch, _updatedAt: now() };
            await query(
                `UPDATE "${tableName}" SET data = $1 WHERE id = $2`, 
                [updatedRecord, target.id]
            );
            return updatedRecord;
        },
        updateAll: async (predicate, patch) => {
            if (isTest) {
                const updated = [];
                for (let index = 0; index < memory().length; index += 1) {
                    if (!predicate(memory()[index])) continue;
                    memory()[index] = { ...memory()[index], ...patch, _updatedAt: now() };
                    updated.push(memory()[index]);
                }
                return updated;
            }
            const res = await query(`SELECT id, data FROM "${tableName}"`);
            const targets = res.rows.filter(row => predicate(row.data));
            const updatedRecords = [];
            for (const target of targets) {
                const updatedRecord = { ...target.data, ...patch, _updatedAt: now() };
                await query(`UPDATE "${tableName}" SET data = $1 WHERE id = $2`, [updatedRecord, target.id]);
                updatedRecords.push(updatedRecord);
            }
            return updatedRecords;
        },
        remove: async (predicate) => {
            if (isTest) {
                const index = memory().findIndex(predicate);
                if (index < 0) return false;
                memory().splice(index, 1);
                return true;
            }
            const res = await query(`SELECT id, data FROM "${tableName}"`);
            const target = res.rows.find(row => predicate(row.data));
            if (!target) return false;
            await query(`DELETE FROM "${tableName}" WHERE id = $1`, [target.id]);
            return true;
        },
        removeAll: async (predicate) => {
            if (isTest) {
                let removed = 0;
                for (let index = memory().length - 1; index >= 0; index -= 1) {
                    if (!predicate(memory()[index])) continue;
                    memory().splice(index, 1);
                    removed += 1;
                }
                return removed;
            }
            const res = await query(`SELECT id, data FROM "${tableName}"`);
            const targets = res.rows.filter((row) => predicate(row.data));
            for (const target of targets) {
                await query(`DELETE FROM "${tableName}" WHERE id = $1`, [target.id]);
            }
            return targets.length;
        }
    };
};

// --- จุดที่ผิดพลาดคราวก่อน: ลืม Export ชื่อตารางทั้งหมด ---
const Centers = makeTable('centers');
const CenterStaff = makeTable('centerStaff');
const StaffContexts = makeTable('staffContexts');
const Residents = makeTable('residents');
const CareProfiles = makeTable('careProfiles');
const PendingCards = makeTable('pendingCards');
const Invites = makeTable('invites');
const Appointments = makeTable('appointments');
const Medications = makeTable('medications');
const GroupBindings = makeTable('groupBindings');
const GroupBindingTokens = makeTable('groupBindingTokens');
const MedicationSnapshots = makeTable('medicationSnapshots');
const TransportPlans = makeTable('transportPlans');
const CenterRateCards = makeTable('centerRateCards');
const Bills = makeTable('bills');
const AccessRequests = makeTable('accessRequests');
const AuditLog = makeTable('auditLog');
const Consents = makeTable('consents');
const RichMenus = makeTable('richMenus');
const Vitals = makeTable('vitals');
const CareProfileMembers = makeTable('careProfileMembers');
const CareProfileShareInvites = makeTable('careProfileShareInvites');
const NotificationOutbox = makeTable('notificationOutbox');
const WebhookInbox = makeTable('webhookInbox');
const DataSubjectRequests = makeTable('dataSubjectRequests');
const PendingFamilyDeliveries = makeTable('pendingFamilyDeliveries');
const AdminUsers = makeTable('adminUsers');

const rawAuditFindAll = AuditLog.findAll.bind(AuditLog);
AuditLog.findAll = async () => (await rawAuditFindAll()).sort((a, b) => new Date(a.at || a._createdAt) - new Date(b.at || b._createdAt));

async function initializeDatabase() {
  if (isTest) return;
  await Promise.all(initPromises);
  // JSONB remains for backwards compatibility, but these expression indexes
  // avoid full scans for the most common production lookups while a relational
  // migration is rolled out.
  const indexes = [
    ['centers', 'center_id'], ['centerStaff', 'center_id'], ['centerStaff', 'line_user_id'],
    ['residents', 'center_id'], ['residents', 'care_profile_id'], ['careProfiles', 'owner_line_id'],
    ['appointments', 'care_profile_id'], ['transportPlans', 'center_id'],
    ['notificationOutbox', 'status'], ['accessRequests', 'care_profile_id'],
  ];
  for (const [table, field] of indexes) {
    const safeName = `idx_${table.toLowerCase()}_${field.toLowerCase()}`.replace(/[^a-z0-9_]/g, '');
    await pool.query(`CREATE INDEX IF NOT EXISTS "${safeName}" ON "${table}" ((data->>'${field}'))`);
  }
}

async function withTransaction(lockKey, fn) {
  if (isTest) {
    if (!lockKey) return fn();
    const previous = testLocks.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    testLocks.set(lockKey, previous.then(() => gate));
    await previous;
    try { return await fn(); } finally { release(); }
  }
  const existing = transactionStore.getStore();
  if (existing) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (lockKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(lockKey)]);
    const result = await transactionStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function pingDatabase() {
  if (isTest) return true;
  await pool.query('SELECT 1');
  return true;
}

function getDatabasePoolMetrics(poolInstance = pool, config = poolConfig) {
  return Object.freeze({
    totalCount:Math.max(0, Number(poolInstance?.totalCount) || 0),
    idleCount:Math.max(0, Number(poolInstance?.idleCount) || 0),
    waitingCount:Math.max(0, Number(poolInstance?.waitingCount) || 0),
    configuredMax:Math.max(0, Number(config?.max) || 0),
  });
}

async function withTransactionLocks(lockKeys, fn) {
  const keys = [...new Set((Array.isArray(lockKeys) ? lockKeys : [lockKeys])
    .filter(Boolean).map((key) => String(key)))].sort();
  if (isTest) {
    const acquire = async (index) => {
      if (index >= keys.length) return fn();
      const key = keys[index];
      const previous = testLocks.get(key) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      testLocks.set(key, previous.then(() => gate));
      await previous;
      try { return await acquire(index + 1); } finally { release(); }
    };
    return acquire(0);
  }
  const existing = transactionStore.getStore();
  if (existing) {
    for (const key of keys) await existing.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    return fn();
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of keys) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const result = await transactionStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// LISTEN/NOTIFY consumers need a dedicated checked-out connection. Keeping
// acquisition here preserves the repository's single PostgreSQL configuration
// and lets the caller release the client during shutdown.
async function acquireDatabaseClient() {
  if (isTest) throw new Error('DEDICATED_DATABASE_CLIENT_UNAVAILABLE_IN_TEST');
  return pool.connect();
}

async function audit(action, actorLineId, meta = {}) {
  return AuditLog.insert({
    log_id: id('LOG'),
    action,
    actor_line_id: actorLineId,
    meta,
    at: now(),
  });
}

function resetAll() {
  if (!isTest) return;
  for (const rows of memoryTables.values()) rows.splice(0, rows.length);
  testLocks.clear();
}

// นำส่งชื่อตารางทั้งหมดให้ระบบหลังบ้านรู้จัก
module.exports = {
  id, now,
  Centers, CenterStaff, StaffContexts, Residents, CareProfiles, PendingCards, Invites,
  Appointments, Medications, GroupBindings, GroupBindingTokens, MedicationSnapshots, TransportPlans, CenterRateCards,
  Bills, AccessRequests, AuditLog, Consents, RichMenus, Vitals, CareProfileMembers, CareProfileShareInvites,
  NotificationOutbox, WebhookInbox, DataSubjectRequests,
  PendingFamilyDeliveries,
  AdminUsers,
  audit, resetAll, initializeDatabase, withTransaction, withTransactionLocks, pingDatabase,
  acquireDatabaseClient,
  createDatabasePoolConfig, getDatabasePoolMetrics, safePoolErrorCode,
  findOneOrNull,
  normalizeExplicitCriteria, recordMatchesExplicitCriteria, buildExplicitFieldQuery,
  DEFAULT_DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_CONNECTION_TIMEOUT_MS,
  databaseQuery: query,
};
