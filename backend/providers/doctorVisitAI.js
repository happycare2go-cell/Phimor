const { AIProviderError, AI_ERROR_CODES } = require('./aiErrors');
const { AI_VERSIONS } = require('../config/aiVersions');
const { DOCTOR_VISIT_ITEM_KINDS } = require('../domain/doctorVisit');
const { trustedTaskInstructions } = require('./promptSafety');

const DOCTOR_VISIT_INSTRUCTIONS = trustedTaskInstructions(`You organize a note entered by a family member or caregiver after a doctor visit.
The note is user-recorded information, not an electronically verified doctor order. Never imply otherwise.
Use only statements directly supported by the supplied sourceText. Do not diagnose, add treatment advice, invent what the doctor said, or add medication names, doses, appointments, laboratory tests, dates, intervals or instructions that are absent from sourceText.
Every item.sourceSupport must be an exact, contiguous quotation copied from sourceText. Keep it short but sufficient.
Every item.summary must begin with the Thai phrase "ผู้บันทึกระบุว่า" so the result remains clearly attributed to the person recording the visit.
Classify medication changes only as medication_statement. Never apply or recommend the change.
Classify future appointments only as next_appointment and Lab/test follow-up as lab_follow_up or test_or_monitoring. These are review candidates, not automatic actions.
If wording is ambiguous, preserve that uncertainty in item.uncertainty. Do not resolve it yourself.
Set dueAt only when sourceSupport contains an explicit ISO date in YYYY-MM-DD form; otherwise return null.
Return JSON only with exactly: summary, items, missingInformation, reviewNotice.
summary is a concise attributed overview beginning with "ผู้บันทึกระบุว่า".
items is an array of objects with exactly: id, kind, sourceSupport, summary, dueAt, uncertainty.
kind must be doctor_guidance|medication_statement|lab_follow_up|next_appointment|test_or_monitoring|lifestyle_or_care_instruction|question_response|other.
missingInformation is an array of short strings describing uncertainty without inventing values.
reviewNotice must remind the human to compare the draft with the original note and source documents before confirmation.`);

const OUTPUT_FIELDS = new Set(['summary', 'items', 'missingInformation', 'reviewNotice']);
const ITEM_FIELDS = new Set(['id', 'kind', 'sourceSupport', 'summary', 'dueAt', 'uncertainty']);

function text(value, field, max, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field}`);
  }
  const normalized = value.normalize('NFC').trim();
  if (normalized.length > max) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, `Invalid ${field}`);
  }
  return normalized;
}

function validateDoctorVisitOrganization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !OUTPUT_FIELDS.has(field))) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid doctor visit response');
  }
  if (!Array.isArray(value.items) || value.items.length > 50
    || !Array.isArray(value.missingInformation) || value.missingInformation.length > 20) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid doctor visit collections');
  }
  const summary = text(value.summary, 'summary', 4000);
  if (!summary.startsWith('ผู้บันทึกระบุว่า')) {
    throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Summary must preserve attribution');
  }
  const items = value.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((field) => !ITEM_FIELDS.has(field))
      || !DOCTOR_VISIT_ITEM_KINDS.includes(item.kind)) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid guidance item');
    }
    const itemSummary = text(item.summary, 'item.summary', 2000);
    if (!itemSummary.startsWith('ผู้บันทึกระบุว่า')) {
      throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Item must preserve attribution');
    }
    let dueAt = null;
    if (item.dueAt !== null && item.dueAt !== undefined && item.dueAt !== '') {
      dueAt = text(item.dueAt, 'item.dueAt', 40);
      if (Number.isNaN(new Date(dueAt).getTime())) {
        throw new AIProviderError(AI_ERROR_CODES.AI_INVALID_RESPONSE, 'Invalid dueAt');
      }
    }
    return Object.freeze({
      id: `DVI${index + 1}`,
      kind: item.kind,
      sourceSupport: text(item.sourceSupport, 'item.sourceSupport', 4000),
      summary: itemSummary,
      dueAt,
      uncertainty: text(item.uncertainty, 'item.uncertainty', 1000, { nullable: true }),
    });
  });
  const missingInformation = value.missingInformation.map((item) => text(item, 'missingInformation', 500));
  return Object.freeze({
    summary,
    items: Object.freeze(items),
    missingInformation: Object.freeze(missingInformation),
    reviewNotice: text(value.reviewNotice, 'reviewNotice', 1000),
  });
}

module.exports = {
  DOCTOR_VISIT_INSTRUCTIONS,
  DOCTOR_VISIT_PROMPT_VERSION: AI_VERSIONS.doctorVisitPrompt,
  validateDoctorVisitOrganization,
};
