const { Appointments } = require('../db');
const { loadCurrentSnapshot } = require('./medicationRetrievalService');
const { createMedicationChangeHistoryService } = require('./medicationChangeHistoryService');
const { createDailyCareRepository } = require('./dailyCareRepository');
const { createVitalSignRepository } = require('./vitalSignRepository');

const MAX_EXPORT_DAYS = 366;
const MAX_SECTION_ENTRIES = 500;

class HealthHistoryExportError extends Error {
  constructor(code, message) { super(message); this.name='HealthHistoryExportError'; this.code=code; this.status=400; }
}

function exportRange({ fromDate, toDate, now = new Date() } = {}) {
  const end = toDate ? new Date(`${toDate}T23:59:59.999+07:00`) : new Date(now);
  const start = fromDate ? new Date(`${fromDate}T00:00:00.000+07:00`)
    : new Date(end.getTime() - (MAX_EXPORT_DAYS - 1) * 86400000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new HealthHistoryExportError('INVALID_EXPORT_DATE_RANGE', 'ช่วงวันที่ไม่ถูกต้อง');
  }
  if (end.getTime() - start.getTime() > MAX_EXPORT_DAYS * 86400000) {
    throw new HealthHistoryExportError('EXPORT_DATE_RANGE_TOO_LARGE', 'ช่วงวันที่ต้องไม่เกิน 366 วัน กรุณาลดช่วงวันที่');
  }
  return { start, end, from:start.toISOString(), to:end.toISOString() };
}

function assertBound(name, rows) {
  if (rows.length > MAX_SECTION_ENTRIES) {
    throw new HealthHistoryExportError('EXPORT_SECTION_TOO_LARGE', `ข้อมูลส่วน ${name} เกิน 500 รายการ กรุณาลดช่วงวันที่`);
  }
  return rows;
}

function createHealthHistoryExportService({
  appointments = Appointments,
  loadCurrentMedication = loadCurrentSnapshot,
  medicationHistory = createMedicationChangeHistoryService({ authorize:async () => ({}) }),
  dailyRepository = process.env.NODE_ENV === 'test' ? null : createDailyCareRepository(),
  vitalRepository = process.env.NODE_ENV === 'test' ? null : createVitalSignRepository(),
  now = () => new Date(),
} = {}) {
  async function build({ careProfileId, fromDate, toDate } = {}) {
    const range = exportRange({ fromDate, toDate, now:now() });
    const [allAppointments, currentMedication, medicationChanges, healthRows, vitalRows] = await Promise.all([
      appointments.findWhere((item) => item.care_profile_id === careProfileId),
      loadCurrentMedication(careProfileId),
      medicationHistory.getHistory({ careProfileId, requester:{ lineUserId:'internal_export' }, limit:MAX_SECTION_ENTRIES + 1 }),
      dailyRepository ? dailyRepository.listHistory({ careProfileId, from:range.from, to:range.to, cursor:null, limit:MAX_SECTION_ENTRIES }) : [],
      vitalRepository ? (vitalRepository.listStandaloneHistory
        ? vitalRepository.listStandaloneHistory({ careProfileId, from:range.from, to:range.to, limit:MAX_SECTION_ENTRIES })
        : vitalRepository.listHistory({ careProfileId, from:range.from, to:range.to, cursor:null, limit:MAX_SECTION_ENTRIES })) : [],
    ]);
    const appointmentRows = allAppointments.filter((item) => {
      const at = new Date(item.datetime).getTime(); return at >= range.start.getTime() && at <= range.end.getTime();
    }).sort((a,b) => new Date(b.datetime)-new Date(a.datetime));
    const changeRows = (medicationChanges.items || []).filter((entry) => {
      const at = new Date(entry.snapshot?.recordedAt || 0).getTime();
      return at >= range.start.getTime() && at <= range.end.getTime();
    });
    const healthReports = healthRows.slice(0, MAX_SECTION_ENTRIES + 1);
    const standaloneVitals = vitalRows.filter((item) => !item.linked_daily_report_id).slice(0, MAX_SECTION_ENTRIES + 1);
    assertBound('นัดหมาย', appointmentRows);
    assertBound('ประวัติการเปลี่ยนยา', changeRows);
    assertBound('รายงานสุขภาพ', healthReports);
    assertBound('สัญญาณชีพเดิม', standaloneVitals);
    return {
      range,
      appointments:appointmentRows,
      currentMedications:currentMedication.medications || [],
      currentMedicationSnapshot:currentMedication.currentSnapshot || null,
      medicationHistory:changeRows,
      healthReports,
      standaloneVitals,
    };
  }
  return { build };
}

module.exports = {
  MAX_EXPORT_DAYS, MAX_SECTION_ENTRIES, HealthHistoryExportError,
  exportRange, assertBound, createHealthHistoryExportService,
};
