const { Appointments } = require('../db');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');

const EXCLUDED_APPOINTMENT_STATUSES = new Set(['cancelled', 'completed', 'deleted']);

class AppointmentSummaryError extends Error {
  constructor(code) {
    super('ไม่สามารถอ่านข้อมูลนัดหมายที่ร้องขอได้');
    this.name = 'AppointmentSummaryError';
    this.code = code;
    this.status = code === 'APPOINTMENT_NOT_FOUND' ? 404 : 400;
  }
}

function appointmentTime(appointment) {
  return new Date(appointment?.datetime || 0).getTime();
}

function isUpcomingAppointment(appointment, now = new Date()) {
  const status = String(appointment?.status || 'active').toLowerCase();
  const time = appointmentTime(appointment);
  return !EXCLUDED_APPOINTMENT_STATUSES.has(status)
    && Number.isFinite(time)
    && time > now.getTime();
}

function safeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(parsed, 1), 25);
}

function projectAppointmentSummary(appointment) {
  const dateTime = typeof appointment.datetime === 'string' ? appointment.datetime : null;
  return {
    appointmentId: appointment.appointment_id,
    hospital: appointment.hospital || '',
    department: appointment.clinic_or_department || appointment.department || '',
    datetime: dateTime,
    date: appointment.date || (dateTime ? dateTime.slice(0, 10) : null),
    time: appointment.time || (dateTime && dateTime.includes('T') ? dateTime.slice(11, 16) : null),
    reason: appointment.reason_for_visit || appointment.reason || '',
    notes: appointment.note || appointment.notes || '',
    status: appointment.status || 'active',
  };
}

async function getUpcomingAppointmentSummary({ careProfileId, requester, limit = 10, now = new Date() } = {}) {
  await authorizeCareProfileAccess({
    lineUserId: requester?.lineUserId,
    careProfileId,
    permission: 'view',
    centerId: requester?.centerId || null,
    requireActiveCenter: requester?.requireActiveCenter !== false,
  });
  const referenceTime = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(referenceTime.getTime())) throw new AppointmentSummaryError('INVALID_TIME');
  const appointments = await Appointments.findWhere((item) => item.care_profile_id === careProfileId);
  return appointments
    .filter((item) => isUpcomingAppointment(item, referenceTime))
    .sort((left, right) => appointmentTime(left) - appointmentTime(right))
    .slice(0, safeLimit(limit))
    .map(projectAppointmentSummary);
}

async function getUpcomingAppointmentById({ careProfileId, appointmentId, requester, now = new Date() } = {}) {
  await authorizeCareProfileAccess({
    lineUserId: requester?.lineUserId,
    careProfileId,
    permission: 'view',
    centerId: requester?.centerId || null,
    requireActiveCenter: requester?.requireActiveCenter !== false,
  });
  const referenceTime = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(referenceTime.getTime())) throw new AppointmentSummaryError('INVALID_TIME');
  const appointment = await Appointments.findOne((item) =>
    item.appointment_id === appointmentId
    && item.care_profile_id === careProfileId
    && isUpcomingAppointment(item, referenceTime)
  );
  return appointment ? projectAppointmentSummary(appointment) : null;
}

module.exports = {
  EXCLUDED_APPOINTMENT_STATUSES,
  AppointmentSummaryError,
  isUpcomingAppointment,
  safeLimit,
  projectAppointmentSummary,
  getUpcomingAppointmentSummary,
  getUpcomingAppointmentById,
};
