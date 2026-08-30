const { buildCareProfileContext } = require('./careProfileContextBuilder');
const { getUpcomingAppointmentSummary } = require('./appointmentSummaryService');
const {
  getCurrentMedicationSnapshot, listEligibleSnapshots,
} = require('./medicationRetrievalService');
const { compareMedicationSnapshots } = require('./medicationDiffService');

class DoctorVisitPreparationError extends Error {
  constructor(code) {
    super('ไม่สามารถเตรียมข้อมูลก่อนพบแพทย์ได้');
    this.name = 'DoctorVisitPreparationError';
    this.code = code;
    this.status = code === 'APPOINTMENT_NOT_FOUND' ? 404 : 400;
  }
}

function clarificationItems(appointment, medicationStatus) {
  const items = [];
  if (!appointment.time) items.push({ code: 'APPOINTMENT_TIME_MISSING', field: 'time' });
  if (!appointment.reason) items.push({ code: 'APPOINTMENT_REASON_MISSING', field: 'reason' });
  if (medicationStatus !== 'CURRENT_SNAPSHOT') items.push({ code: 'CURRENT_MEDICATION_SNAPSHOT_MISSING', field: 'currentMedications' });
  return items;
}

async function buildDoctorVisitPreparation({ careProfileId, appointmentId, requester, now = new Date() } = {}) {
  if (!appointmentId) throw new DoctorVisitPreparationError('APPOINTMENT_REQUIRED');
  const context = await buildCareProfileContext({
    careProfileId,
    requester,
    purpose: 'doctor_visit_preparation',
    options: { now, appointmentId },
  });
  const appointments = await getUpcomingAppointmentSummary({ careProfileId, requester, limit: 25, now });
  const appointment = appointments.find((item) => item.appointmentId === appointmentId);
  if (!appointment) throw new DoctorVisitPreparationError('APPOINTMENT_NOT_FOUND');

  const current = await getCurrentMedicationSnapshot({ careProfileId, requester });
  let medicationChanges = { status: 'NOT_AVAILABLE' };
  if (current.status === 'CURRENT_SNAPSHOT') {
    const ordered = await listEligibleSnapshots(careProfileId, 3);
    const currentIndex = ordered.findIndex((item) => item.snapshot_id === current.currentSnapshot.snapshotId);
    const previous = currentIndex >= 0 ? ordered[currentIndex + 1] : null;
    if (previous) {
      medicationChanges = {
        status: 'AVAILABLE',
        diff: await compareMedicationSnapshots({
          previousSnapshotId: previous.snapshot_id,
          currentSnapshotId: current.currentSnapshot.snapshotId,
          requester,
          careProfileId,
        }),
      };
    }
  }

  const currentMedications = current.status === 'CURRENT_SNAPSHOT'
    ? { status: 'AVAILABLE', snapshot: current.currentSnapshot, medications: current.medications }
    : { status: 'NO_CURRENT_SNAPSHOT', snapshot: null, medications: [] };
  const allergies = [
    ...(context.context.allergies.drug ? [{ type: 'drug', value: context.context.allergies.drug }] : []),
    ...(context.context.allergies.food ? [{ type: 'food', value: context.context.allergies.food }] : []),
  ];
  const conditions = context.context.relevantConditions;
  return {
    appointment,
    currentMedications,
    allergies,
    relevantConditions: conditions,
    medicationChanges,
    questionInputs: {
      newMedicationChanges: medicationChanges.status === 'AVAILABLE' ? medicationChanges.diff.added : [],
      allergies,
      conditions,
      appointmentReason: appointment.reason,
      itemsToClarify: clarificationItems(appointment, current.status),
    },
    generatedAt: context.generatedAt,
  };
}

module.exports = {
  DoctorVisitPreparationError,
  clarificationItems,
  buildDoctorVisitPreparation,
};
