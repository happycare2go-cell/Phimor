const { randomUUID } = require('node:crypto');
const { loadFeatureFlags } = require('../config/featureFlags');
const { loadV2Config } = require('../config/v2Config');
const { AI_VERSIONS } = require('../config/aiVersions');
const { createAIProvider } = require('../providers/AIProviderFactory');
const { AI_ERROR_CODES } = require('../providers/aiErrors');
const {
  PLUS_EXPLANATION_INSTRUCTIONS, PLUS_EXPLANATION_PROMPT_VERSION, validatePlusExplanation,
} = require('../providers/plusExplanation');
const { getPlusEntitlement } = require('./plusEntitlementService');
const {
  classifyPlusIntent, evaluatePlusSafety, createStructuredIntentClassifier,
} = require('./plusIntentService');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { buildCareProfileSummary } = require('./careProfileSummaryService');
const {
  getCurrentMedicationSnapshot, getMedicationInstructions,
} = require('./medicationRetrievalService');
const { compareLatestMedicationSnapshots } = require('./medicationDiffService');
const { getUpcomingAppointmentSummary } = require('./appointmentSummaryService');
const { buildDoctorVisitPreparation } = require('./doctorVisitPreparationService');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { PLUS_EXPLANATION_RESPONSE_SCHEMA } = require('../providers/aiResponseSchemas');

const PURPOSES = Object.freeze([
  'care_profile_summary', 'medication_summary', 'medication_instructions',
  'medication_diff', 'appointment_summary', 'doctor_visit_preparation',
]);
const PURPOSE_FEATURE = Object.freeze({
  care_profile_summary: 'care_profile_summary',
  medication_summary: 'medication_summary',
  medication_instructions: 'medication_summary',
  medication_diff: 'medication_diff',
  appointment_summary: 'appointment_summary',
  doctor_visit_preparation: 'doctor_visit_preparation',
});
const SAFE_PROVIDER_ERRORS = new Set([
  AI_ERROR_CODES.AI_UNAVAILABLE, AI_ERROR_CODES.AI_TIMEOUT, AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE, AI_ERROR_CODES.AI_PROVIDER_ERROR,
]);

class PlusOrchestrationError extends Error {
  constructor(code, status = 400) {
    super('ไม่สามารถดำเนินการคำขอ Phimor Plus ได้');
    this.name = 'PlusOrchestrationError';
    this.code = code;
    this.status = status;
  }
}

function validateRequest({ lineUserId, careProfileId, question } = {}) {
  if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new PlusOrchestrationError('UNAUTHENTICATED', 401);
  if (typeof careProfileId !== 'string' || !careProfileId.trim()) throw new PlusOrchestrationError('CARE_PROFILE_REQUIRED');
  if (typeof question !== 'string' || !question.trim()) throw new PlusOrchestrationError('QUESTION_REQUIRED');
  if (question.trim().length > 4000) throw new PlusOrchestrationError('QUESTION_TOO_LONG');
  return { lineUserId: lineUserId.trim(), careProfileId: careProfileId.trim(), question: question.trim() };
}

function resolvePurpose({ intent, question, purposeHint }) {
  if (purposeHint && PURPOSES.includes(purposeHint)) return purposeHint;
  const text = question.toLowerCase();
  if (intent === 'prepare') return 'doctor_visit_preparation';
  if (intent === 'compare') return 'medication_diff';
  if (/(นัด|นัดหมาย)/i.test(text)) return 'appointment_summary';
  if (/(วิธีใช้|วิธีกิน|กิน.*(อย่างไร|ยังไง|ตอนไหน)|ใช้.*ตอนไหน)/i.test(text)) return 'medication_instructions';
  if (/(ยา|medication)/i.test(text)) return 'medication_summary';
  return 'care_profile_summary';
}

function hasEntitlementFeature(entitlement, feature) {
  return entitlement.features.includes('*') || entitlement.features.includes(feature);
}

function featureDecision({ entitlement, purpose, flags }) {
  if (!flags.plus.aiExplanation) return 'PLUS_FEATURE_DISABLED';
  if (!hasEntitlementFeature(entitlement, 'ai_explanation')) return 'PLUS_FEATURE_NOT_INCLUDED';
  const feature = PURPOSE_FEATURE[purpose];
  if (!hasEntitlementFeature(entitlement, feature)) return 'PLUS_FEATURE_NOT_INCLUDED';
  if (purpose === 'medication_diff' && !flags.plus.medicationDiff) return 'PLUS_FEATURE_DISABLED';
  return null;
}

function unavailable(errorCode) {
  return {
    action: 'unavailable',
    errorCode,
    message: 'ระบบช่วยอธิบายยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
  };
}

function minimizedContext(purpose, value) {
  return Object.freeze({ purpose, data: value });
}

async function callPurposeService(purpose, args, services) {
  const common = { careProfileId: args.careProfileId, requester: { lineUserId: args.lineUserId } };
  if (purpose === 'care_profile_summary') return services.buildCareProfileSummary(common);
  if (purpose === 'medication_summary') return services.getCurrentMedicationSnapshot(common);
  if (purpose === 'medication_instructions') return services.getMedicationInstructions(common);
  if (purpose === 'medication_diff') return services.compareLatestMedicationSnapshots(common);
  if (purpose === 'appointment_summary') return services.getUpcomingAppointmentSummary(common);
  if (purpose === 'doctor_visit_preparation') {
    if (!args.appointmentId) throw new PlusOrchestrationError('APPOINTMENT_REQUIRED');
    return services.buildDoctorVisitPreparation({ ...common, appointmentId: args.appointmentId });
  }
  throw new PlusOrchestrationError('UNSUPPORTED_PURPOSE');
}

function createPlusOrchestrator(overrides = {}) {
  let defaultProvider = null;
  const getProvider = (config) => {
    if (overrides.provider) return overrides.provider;
    if (!defaultProvider) defaultProvider = createAIProvider({ config, modelPurpose: 'explanation' });
    return defaultProvider;
  };
  const services = {
    buildCareProfileSummary, getCurrentMedicationSnapshot, getMedicationInstructions,
    compareLatestMedicationSnapshots, getUpcomingAppointmentSummary, buildDoctorVisitPreparation,
    ...overrides.services,
  };
  return async function handlePlusRequest(input = {}) {
    const args = { ...validateRequest(input), purposeHint: input.purposeHint || null, appointmentId: input.appointmentId || null };
    const flags = overrides.flags || loadFeatureFlags();
    if (!flags.plus.enabled) return unavailable('PLUS_DISABLED');
    const entitlement = await (overrides.getPlusEntitlement || getPlusEntitlement)({
      lineUserId: args.lineUserId, flags, queryFn: overrides.entitlementQueryFn,
    });
    if (!entitlement.allowed) return unavailable(entitlement.reasonCode);

    const config = overrides.config || loadV2Config();
    const classifier = overrides.classifier || {
      classify(classifierInput) {
        return createStructuredIntentClassifier({ provider: getProvider(config) }).classify(classifierInput);
      },
    };
    const interactionId = `AI-${randomUUID()}`;
    const requestedAt = new Date().toISOString();
    const classification = await (overrides.classifyPlusIntent || classifyPlusIntent)({
      text: args.question, contextHint: args.purposeHint, classifier,
    });
    const safety = (overrides.evaluatePlusSafety || evaluatePlusSafety)(classification, {
      pharmacistEscalationEnabled: flags.plus.pharmacistEscalation,
    });
    const audit = async (metadata) => {
      try {
        return await (overrides.recordAudit || recordAIInteractionMetadata)({
          interactionId, requesterLineId: args.lineUserId, careProfileId: args.careProfileId,
          provider: config.ai.provider, model: config.ai.explanationModel || null,
          promptVersion: PLUS_EXPLANATION_PROMPT_VERSION, contextVersion: AI_VERSIONS.careProfileContext,
          requestedAt, inputCharacterCount: args.question.length,
          ...metadata,
        }, overrides.auditOptions);
      } catch (_) {
        const logger = overrides.auditLogger || console.error;
        if (typeof logger === 'function') logger({ event: 'ai_audit_write_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId });
        return { recorded: false, errorCode: 'AI_AUDIT_WRITE_FAILED' };
      }
    };

    if (safety.action !== 'allow') {
      const action = safety.action === 'pharmacist_escalation' || safety.action === 'medical_escalation'
        ? 'escalation' : 'needs_review';
      await audit({ intent: classification.intent, purpose: args.purposeHint || 'unresolved', resultStatus: action === 'escalation' ? 'escalated' : 'needs_review', escalation: action === 'escalation', completedAt: new Date().toISOString() });
      return { action, escalationType: safety.action, intent: classification.intent, reasonCode: safety.reasonCode, message: safety.message };
    }

    try {
      await (overrides.authorize || authorizeCareProfileAccess)({
        lineUserId: args.lineUserId, careProfileId: args.careProfileId, permission: 'view', requireActiveCenter: true,
      });
    } catch (error) {
      await audit({ intent: classification.intent, purpose: args.purposeHint || 'unresolved', resultStatus: 'denied', errorCode: error?.code || 'ACCESS_DENIED', completedAt: new Date().toISOString() });
      throw error;
    }
    const purpose = resolvePurpose({ intent: classification.intent, question: args.question, purposeHint: args.purposeHint });
    const featureError = featureDecision({ entitlement, purpose, flags });
    if (featureError) {
      await audit({ intent: classification.intent, purpose, resultStatus: 'denied', errorCode: featureError, completedAt: new Date().toISOString() });
      return unavailable(featureError);
    }
    let structured;
    try {
      structured = await callPurposeService(purpose, args, services);
    } catch (error) {
      if (error instanceof PlusOrchestrationError && error.code === 'APPOINTMENT_REQUIRED') {
        await audit({ intent: classification.intent, purpose, resultStatus: 'needs_review', errorCode: error.code, completedAt: new Date().toISOString() });
        return { action: 'needs_review', intent: classification.intent, purpose, reasonCode: error.code, message: 'กรุณาเลือกนัดหมายก่อนดำเนินการ' };
      }
      await audit({ intent: classification.intent, purpose, resultStatus: 'error', errorCode: error?.code || 'DOMAIN_SERVICE_ERROR', completedAt: new Date().toISOString() });
      throw error;
    }
    const context = minimizedContext(purpose, structured);
    try {
      const provider = getProvider(config);
      const content = await provider.generateStructured({
        task: 'plus_explanation',
        systemInstructions: PLUS_EXPLANATION_INSTRUCTIONS,
        context: JSON.stringify(context),
        input: { text: args.question },
        outputSchema: validatePlusExplanation,
        responseSchema: PLUS_EXPLANATION_RESPONSE_SCHEMA,
        responseSchemaName: 'phimor_plus_explanation',
        timeoutMs: config.ai.timeoutMs,
        requestId: interactionId,
      });
      const validated = validatePlusExplanation(content);
      await audit({
        intent: classification.intent, purpose, resultStatus: 'success', completedAt: new Date().toISOString(),
        outputCharacterCount: JSON.stringify(validated).length,
      });
      return { action: 'answer', intent: classification.intent, purpose, content: validated };
    } catch (error) {
      const errorCode = SAFE_PROVIDER_ERRORS.has(error?.code) ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      await audit({ intent: classification.intent, purpose, resultStatus: 'error', errorCode, completedAt: new Date().toISOString() });
      return { action: 'unavailable', intent: classification.intent, purpose, ...unavailable(errorCode) };
    }
  };
}

const handlePlusRequest = createPlusOrchestrator();

module.exports = {
  PURPOSES, PURPOSE_FEATURE, PlusOrchestrationError,
  validateRequest, resolvePurpose, featureDecision, minimizedContext,
  createPlusOrchestrator, handlePlusRequest,
};
