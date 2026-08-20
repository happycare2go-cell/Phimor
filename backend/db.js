const { Pool } = require('pg');
const { randomUUID } = require('crypto');

// เชื่อมต่อ PostgreSQL ผ่านตัวแปร DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // จำเป็นสำหรับการเชื่อมต่อบน Cloud
    }
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
});

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const isTest = process.env.NODE_ENV === 'test';
const memoryTables = new Map();

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
        console.error(`Error initializing table ${tableName}:`, err);
    }
};

// ฟังก์ชันแปลงคำสั่งจัดการฐานข้อมูล ให้ทำงานเข้ากับระบบเก่าได้เป๊ะๆ
const makeTable = (tableName) => {
    initTable(tableName);
    if (isTest && !memoryTables.has(tableName)) memoryTables.set(tableName, []);

    const memory = () => memoryTables.get(tableName);

    return {
        insert: async (data) => {
            if (isTest) {
                const record = { ...data, _createdAt: now(), _updatedAt: now() };
                memory().push(record);
                return record;
            }
            const recordId = randomUUID();
            const record = { ...data, _createdAt: now(), _updatedAt: now() };
            await pool.query(`INSERT INTO "${tableName}" (id, data) VALUES ($1, $2)`, [recordId, record]);
            return record;
        },
        findAll: async () => {
            if (isTest) return [...memory()].reverse();
            const res = await pool.query(`SELECT data FROM "${tableName}" ORDER BY created_at DESC`);
            return res.rows.map(row => row.data);
        },
        findWhere: async (predicate) => {
            if (isTest) return memory().filter(predicate);
            const res = await pool.query(`SELECT data FROM "${tableName}"`);
            const allData = res.rows.map(row => row.data);
            return allData.filter(predicate);
        },
        findOne: async (predicate) => {
            if (isTest) return memory().find(predicate) || null;
            const res = await pool.query(`SELECT data FROM "${tableName}"`);
            const allData = res.rows.map(row => row.data);
            return allData.find(predicate);
        },
        update: async (predicate, patch) => {
            if (isTest) {
                const index = memory().findIndex(predicate);
                if (index < 0) return null;
                memory()[index] = { ...memory()[index], ...patch, _updatedAt: now() };
                return memory()[index];
            }
            const res = await pool.query(`SELECT id, data FROM "${tableName}"`);
            const target = res.rows.find(row => predicate(row.data));
            if (!target) return null;
            
            const updatedRecord = { ...target.data, ...patch, _updatedAt: now() };
            await pool.query(
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
            const res = await pool.query(`SELECT id, data FROM "${tableName}"`);
            const targets = res.rows.filter(row => predicate(row.data));
            const updatedRecords = [];
            for (const target of targets) {
                const updatedRecord = { ...target.data, ...patch, _updatedAt: now() };
                await pool.query(`UPDATE "${tableName}" SET data = $1 WHERE id = $2`, [updatedRecord, target.id]);
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
            const res = await pool.query(`SELECT id, data FROM "${tableName}"`);
            const target = res.rows.find(row => predicate(row.data));
            if (!target) return false;
            await pool.query(`DELETE FROM "${tableName}" WHERE id = $1`, [target.id]);
            return true;
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
}

// นำส่งชื่อตารางทั้งหมดให้ระบบหลังบ้านรู้จัก
module.exports = {
  id, now,
  Centers, CenterStaff, StaffContexts, Residents, CareProfiles, PendingCards, Invites,
  Appointments, Medications, GroupBindings, GroupBindingTokens, MedicationSnapshots, TransportPlans, CenterRateCards,
  Bills, AccessRequests, AuditLog, Consents, RichMenus, Vitals, CareProfileMembers, CareProfileShareInvites,
  audit, resetAll,
};
