const { buildCareProfileContext } = require('./careProfileContextBuilder');
const { getCurrentMedicationSnapshot } = require('./medicationRetrievalService');
const { getUpcomingAppointmentSummary } = require('./appointmentSummaryService');

async function buildCareProfileSummary({ careProfileId, requester, now = new Date() } = {}) {
  const context = await buildCareProfileContext({
    careProfileId,
    requester,
    purpose: 'care_profile_summary',
    options: { now },
  });
  const [medication, appointments] = await Promise.all([
    getCurrentMedicationSnapshot({ careProfileId, requester }),
    getUpcomingAppointmentSummary({ careProfileId, requester, now }),
  ]);
  const profile = context.context.profile;
  return {
    profile: {
      patientName: profile.patientName,
      gender: profile.gender,
      bloodType: profile.bloodType,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      mobilityLimitations: profile.mobilityLimitations,
    },
    conditions: profile.chronicConditions,
    allergies: [
      ...(profile.drugAllergies ? [{ type: 'drug', value: profile.drugAllergies }] : []),
      ...(profile.foodAllergies ? [{ type: 'food', value: profile.foodAllergies }] : []),
    ],
    currentMedicationStatus: medication.status === 'CURRENT_SNAPSHOT' ? 'AVAILABLE' : medication.status,
    currentMedicationCount: medication.medications.length,
    upcomingAppointmentCount: appointments.length,
    generatedAt: context.generatedAt,
  };
}

module.exports = { buildCareProfileSummary };
