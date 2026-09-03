const nullableString = Object.freeze({ type: ['string', 'null'] });
const stringArray = Object.freeze({ type: 'array', items: { type: 'string' } });

const medication = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'strength', 'dose', 'unit', 'frequency', 'timing',
    'instruction', 'route', 'amount', 'condition', 'uncertainFields',
  ],
  properties: {
    name: { type: 'string' }, strength: { type: 'string' }, dose: { type: 'string' },
    unit: { type: 'string' }, frequency: { type: 'string' }, timing: { type: 'string' },
    instruction: { type: 'string' }, route: { type: 'string' }, amount: { type: 'string' },
    condition: { type: 'string' }, uncertainFields: stringArray,
  },
});

const DOCUMENT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'documentType', 'documentSubtype', 'unrelatedNote', 'nameGuess', 'nameConfidence',
    'appointment', 'medications', 'doctorNote',
  ],
  properties: {
    documentType: { type: 'string', enum: ['medical', 'unrelated'] },
    documentSubtype: {
      type: ['string', 'null'],
      enum: ['lab_report', 'medication', 'appointment', 'doctor_note', 'mixed', 'other_medical', null],
    },
    unrelatedNote: { type: 'string' },
    nameGuess: nullableString,
    nameConfidence: { type: 'number', minimum: 0, maximum: 1 },
    appointment: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          required: ['hospital', 'datetime', 'clinicOrDepartment', 'reasonForVisit', 'relatedCondition', 'doctorName', 'note'],
          properties: {
            hospital: nullableString, datetime: nullableString, clinicOrDepartment: nullableString,
            reasonForVisit: nullableString, relatedCondition: nullableString, doctorName: nullableString,
            note: nullableString,
          },
        },
      ],
    },
    medications: { type: 'array', items: medication },
    doctorNote: nullableString,
  },
});

const LAB_DOCUMENT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['report', 'observations', 'uncertainFields'],
  properties: {
    report: {
      type: 'object', additionalProperties: false,
      required: ['laboratoryName', 'hospitalName', 'specimenCollectedAt', 'reportedAt'],
      properties: {
        laboratoryName: nullableString, hospitalName: nullableString,
        specimenCollectedAt: nullableString, reportedAt: nullableString,
      },
    },
    observations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'analyteNameSource', 'sourceValueText', 'sourceUnit', 'referenceRangeText',
          'abnormalFlagSource', 'specimenSource', 'methodSource', 'sourcePage',
          'sourceRegion', 'extractionConfidence',
        ],
        properties: {
          analyteNameSource: { type: 'string' }, sourceValueText: { type: 'string' },
          sourceUnit: nullableString, referenceRangeText: nullableString,
          abnormalFlagSource: nullableString, specimenSource: nullableString,
          methodSource: nullableString, sourcePage: { type: ['integer', 'null'], minimum: 1 },
          sourceRegion: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object', additionalProperties: false,
                required: ['x', 'y', 'width', 'height', 'page'],
                properties: {
                  x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
                  width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
                  page: { type: 'integer', minimum: 1 },
                },
              },
            ],
          },
          extractionConfidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
        },
      },
    },
    uncertainFields: stringArray,
  },
});

const PLUS_INTENT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['intent', 'confidence', 'requiresEscalation', 'reasonCode'],
  properties: {
    intent: {
      type: 'string',
      enum: ['retrieve', 'summarize', 'compare', 'explain', 'prepare', 'medication_advice', 'diagnosis', 'treatment', 'dose_change', 'stop_start_medication'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    requiresEscalation: { type: 'boolean' }, reasonCode: nullableString,
  },
});

const PLUS_EXPLANATION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['summary', 'keyPoints', 'missingInformation', 'disclaimer'],
  properties: { summary: { type: 'string' }, keyPoints: stringArray, missingInformation: stringArray, disclaimer: { type: 'string' } },
});

const LAB_EXPLANATION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['summary', 'testExplanation', 'confirmedFacts', 'trendExplanation', 'rangeCaveat', 'questionsForClinician', 'safetyNotice', 'disclaimer', 'unavailableReason'],
  properties: {
    summary: { type: 'string' }, testExplanation: { type: 'string' },
    confirmedFacts: { type: 'array', maxItems: 0 }, trendExplanation: nullableString,
    rangeCaveat: nullableString, questionsForClinician: stringArray,
    safetyNotice: { type: 'string' }, disclaimer: { type: 'string' }, unavailableReason: nullableString,
  },
});

const DOCTOR_QUESTION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'questions', 'missingInformation', 'safetyNotice'],
  properties: {
    title: { type: 'string' }, summary: { type: 'string' },
    questions: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'category', 'question', 'rationale'],
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: ['medication', 'lab', 'condition', 'appointment', 'follow_up', 'clarification'] },
          question: { type: 'string' }, rationale: { type: 'string' },
        },
      },
    },
    missingInformation: { type: 'array', maxItems: 0 }, safetyNotice: { type: 'string' },
  },
});

const DOCTOR_VISIT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['summary', 'items', 'missingInformation', 'reviewNotice'],
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'kind', 'sourceSupport', 'summary', 'dueAt', 'uncertainty'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['doctor_guidance', 'medication_statement', 'lab_follow_up', 'next_appointment', 'test_or_monitoring', 'lifestyle_or_care_instruction', 'question_response', 'other'] },
          sourceSupport: { type: 'string' }, summary: { type: 'string' },
          dueAt: nullableString, uncertainty: nullableString,
        },
      },
    },
    missingInformation: stringArray, reviewNotice: { type: 'string' },
  },
});

const assistantString = (maxLength) => ({ type:'string', minLength:1, maxLength });
const assistantStringArray = (maxItems, maxLength) => ({
  type:'array', maxItems, items:assistantString(maxLength),
});
const assistantAttributedItem = (sourceCategories) => ({
  type:'object', additionalProperties:false, required:['text', 'sourceCategory'],
  properties:{
    text:assistantString(1000),
    sourceCategory:{ type:'string', enum:[...sourceCategories] },
  },
});
const recordedFactSources = Object.freeze([
  'care_profile', 'medication_snapshot', 'medication_diff',
  'vital_sign', 'appointment', 'consultation_message',
]);
const assistantAttributedArray = (sources) => ({
  type:'array', maxItems:30, items:assistantAttributedItem(sources),
});

const PHARMACIST_ASSISTANT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['caseSummary', 'recordedFacts', 'relevantMedicationContext', 'medicationChanges', 'questionsToAsk', 'safetyConsiderations', 'responseGuidance', 'escalationConsiderations', 'missingInformation', 'draftResponseForPharmacistReview', 'disclaimer'],
  properties: {
    caseSummary:assistantString(3000),
    recordedFacts:assistantAttributedArray(recordedFactSources),
    relevantMedicationContext:assistantAttributedArray(['medication_snapshot']),
    medicationChanges:assistantAttributedArray(['medication_diff']),
    questionsToAsk:assistantAttributedArray(['general_ai_knowledge']),
    safetyConsiderations:assistantAttributedArray(['general_ai_knowledge']),
    responseGuidance:assistantAttributedArray(['general_ai_knowledge']),
    escalationConsiderations:assistantAttributedArray(['general_ai_knowledge']),
    missingInformation:assistantStringArray(30, 500),
    draftResponseForPharmacistReview:assistantString(4000),
    disclaimer:assistantString(1000),
  },
});

module.exports = {
  DOCUMENT_RESPONSE_SCHEMA, LAB_DOCUMENT_RESPONSE_SCHEMA, PLUS_INTENT_RESPONSE_SCHEMA,
  PLUS_EXPLANATION_RESPONSE_SCHEMA, LAB_EXPLANATION_RESPONSE_SCHEMA,
  DOCTOR_QUESTION_RESPONSE_SCHEMA, DOCTOR_VISIT_RESPONSE_SCHEMA,
  PHARMACIST_ASSISTANT_RESPONSE_SCHEMA,
};
