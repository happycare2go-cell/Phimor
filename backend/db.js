// db.js — ชั้นข้อมูล (In-memory ตอนนี้ / สลับเป็น Google Sheets หรือฐานข้อมูลจริงได้ทีหลัง
// โดยคง Interface เดิม — ทุกฟังก์ชันเป็น async เพื่อจำลองพฤติกรรม I/O จริง)
//
// อ้างอิงตาราง: Phimor_Technical_Design.docx หมวด 5 และหมวด 6.4

const { randomUUID } = require('crypto');

// ── ที่เก็บข้อมูลในหน่วยความจำ ──────────────────────────────────────────────
const store = {
  centers: [],          // Centers
  centerStaff: [],       // CenterStaff
  residents: [],         // Residents
  careProfiles: [],      // CareProfiles
  pendingCards: [],      // PendingCards
  invites: [],           // Invites
  appointments: [],      // Appointments
  medications: [],       // Medications
  groupBindings: [],     // GroupBindings (ผูกกลุ่มไลน์ ↔ care_profile_id หรือ center_id)
  transportPlans: [],    // TransportPlans
  centerRateCards: [],   // CenterRateCard (1 ต่อ 1 ศูนย์)
  bills: [],             // Bills
  accessRequests: [],    // AccessRequests
  auditLog: [],          // AuditLog
  consents: [],          // การยินยอม PDPA
  richMenus: [],          // เก็บ richMenuId ที่สร้างแล้ว กันสร้างซ้ำทุกครั้งที่ Server รีสตาร์ท
  vitals: [],              // สัญญาณชีพจากระบบภายนอก (ข้อ J4)
};

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const delay = () => new Promise((r) => setTimeout(r, 1)); // จำลอง I/O latency เล็กน้อย

function makeTable(tableName) {
  const rows = store[tableName];
  return {
    async insert(data) {
      await delay();
      const row = { ...data, _createdAt: now(), _updatedAt: now() };
      rows.push(row);
      return row;
    },
    async findAll() {
      await delay();
      return [...rows];
    },
    async findWhere(pred) {
      await delay();
      return rows.filter(pred);
    },
    async findOne(pred) {
      await delay();
      return rows.find(pred) || null;
    },
    async update(pred, patch) {
      await delay();
      const row = rows.find(pred);
      if (!row) return null;
      Object.assign(row, patch, { _updatedAt: now() });
      return row;
    },
    async updateAll(pred, patch) {
      await delay();
      const matched = rows.filter(pred);
      matched.forEach((r) => Object.assign(r, patch, { _updatedAt: now() }));
      return matched;
    },
    async remove(pred) {
      await delay();
      const idx = rows.findIndex(pred);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      return true;
    },
  };
}

const Centers = makeTable('centers');
const CenterStaff = makeTable('centerStaff');
const Residents = makeTable('residents');
const CareProfiles = makeTable('careProfiles');
const PendingCards = makeTable('pendingCards');
const Invites = makeTable('invites');
const Appointments = makeTable('appointments');
const Medications = makeTable('medications');
const GroupBindings = makeTable('groupBindings');
const TransportPlans = makeTable('transportPlans');
const CenterRateCards = makeTable('centerRateCards');
const Bills = makeTable('bills');
const AccessRequests = makeTable('accessRequests');
const AuditLog = makeTable('auditLog');
const Consents = makeTable('consents');
const RichMenus = makeTable('richMenus');
const Vitals = makeTable('vitals');

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
  // สำหรับ Test เท่านั้น — เคลียร์ข้อมูลทั้งหมดกลับเป็นค่าว่าง
  Object.keys(store).forEach((k) => { store[k].length = 0; });
}

module.exports = {
  id, now,
  Centers, CenterStaff, Residents, CareProfiles, PendingCards, Invites,
  Appointments, Medications, GroupBindings, TransportPlans, CenterRateCards,
  Bills, AccessRequests, AuditLog, Consents, RichMenus, Vitals,
  audit, resetAll,
};
