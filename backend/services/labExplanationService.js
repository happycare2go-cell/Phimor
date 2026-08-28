const { randomUUID } = require('node:crypto');
const { createAIProvider } = require('../providers/AIProviderFactory');
const { AI_ERROR_CODES } = require('../providers/aiErrors');
const {
  LAB_EXPLANATION_INSTRUCTIONS, LAB_EXPLANATION_PROMPT_VERSION, validateLabExplanation,
} = require('../providers/labExplanationAI');
const { loadV2Config } = require('../config/v2Config');
const { loadFeatureFlags } = require('../config/featureFlags');
const { AI_VERSIONS } = require('../config/aiVersions');
const { requirePlusFeature } = require('./plusEntitlementService');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { createLabTrendService } = require('./labTrendService');
const { EMERGENCY_PATTERNS } = require('./consultationSafetyService');
const { LabDomainError } = require('../domain/lab');

const SAFE_PROVIDER_ERRORS = new Set([
  AI_ERROR_CODES.AI_UNAVAILABLE, AI_ERROR_CODES.AI_TIMEOUT, AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE, AI_ERROR_CODES.AI_PROVIDER_ERROR,
]);
const EXPLICIT_CRITICAL_FLAGS = new Set(['critical', 'panic', 'crit', 'วิกฤต']);

function safeUnavailable(errorCode) {
  return Object.freeze({
    status: 'unavailable', errorCode,
    message: 'ระบบช่วยอธิบายผล Lab ยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
  });
}

function validateQuestion(question) {
  if (question === null || question === undefined || question === '') return '';
  if (typeof question !== 'string') throw new LabDomainError('INVALID_INPUT');
  const normalized = question.normalize('NFC').trim();
  if (normalized.length > 2000) throw new LabDomainError('INVALID_INPUT');
  return normalized;
}

function minimizedLabContext(trend) {
  const observations = trend.observations.map((point) => Object.freeze({
    specimenCollectedAt: point.specimenCollectedAt,
    analyteNameSource: point.analyteNameSource,
    sourceValueText: point.sourceValueText,
    numericValue: point.numericValue,
    sourceUnit: point.sourceUnit,
    referenceRangeText: point.referenceRangeText,
    referenceLow: point.referenceLow,
    referenceHigh: point.referenceHigh,
    abnormalFlagSource: point.abnormalFlagSource,
    specimenSource: point.specimenSource,
    methodSource: point.methodSource,
  }));
  return Object.freeze({
    contextType: 'confirmed_lab_only', observations: Object.freeze(observations),
    deterministicTrend: Object.freeze({
      status: trend.status, reasonCode: trend.reasonCode,
      direction: trend.status === 'available' ? trend.direction : null,
      absoluteChange: trend.status === 'available' ? trend.absoluteChange : null,
      comparisonUnit: trend.status === 'available' ? trend.comparisonUnit : null,
      sourceRangesDiffer: trend.status === 'available' ? trend.rangesDiffer : false,
    }),
  });
}

function deterministicFacts(trend) {
  return Object.freeze(trend.observations.map((point) => Object.freeze({
    observedAt: point.specimenCollectedAt,
    analyteNameSource: point.analyteNameSource,
    sourceValueText: point.sourceValueText,
    sourceUnit: point.sourceUnit,
    referenceRangeText: point.referenceRangeText,
    abnormalFlagSource: point.abnormalFlagSource,
  })));
}

function hasExplicitCriticalFlag(trend) {
  return trend.observations.some((point) =>
    EXPLICIT_CRITICAL_FLAGS.has(String(point.abnormalFlagSource || '').normalize('NFKC').trim().toLowerCase()));
}

function createLabExplanationService(overrides = {}) {
  let defaultProvider = null;
  const config = overrides.config || loadV2Config();
  const flags = overrides.flags || loadFeatureFlags();
  const getProvider = () => {
    if (overrides.provider) return overrides.provider;
    if (!defaultProvider) defaultProvider = createAIProvider({ config, modelPurpose: 'explanation' });
    return defaultProvider;
  };
  const getTrend = overrides.getLabTrend || createLabTrendService(overrides.trendDependencies);
  const entitlement = overrides.requirePlusFeature || requirePlusFeature;
  const recordAudit = overrides.recordAudit || recordAIInteractionMetadata;

  return async function explainConfirmedLab({
    careProfileId, lineUserId, identity, question = '', centerId = null,
  } = {}) {
    const normalizedQuestion = validateQuestion(question);
    await entitlement({
      lineUserId, feature: 'ai_explanation', capability: 'ai_lab_explanation', flags,
      queryFn: overrides.entitlementQueryFn,
    });
    const trend = await getTrend({ careProfileId, lineUserId, centerId, identity, limit: 20 });
    if (trend.observations.length === 0) {
      return Object.freeze({
        status: 'unavailable', errorCode: 'CONFIRMED_LAB_NOT_FOUND',
        message: 'ยังไม่มีผล Lab ที่ยืนยันแล้วสำหรับคำขอนี้',
      });
    }

    const interactionId = `AI-${randomUUID()}`;
    const requestedAt = new Date().toISOString();
    const audit = async (metadata) => {
      try {
        return await recordAudit({
          interactionId, requesterLineId: null, careProfileId, requesterType: 'family',
          purpose: 'lab_explanation', intent: 'explain', provider: config.ai.provider,
          model: config.ai.explanationModel || null,
          promptVersion: LAB_EXPLANATION_PROMPT_VERSION,
          contextVersion: AI_VERSIONS.labExplanationContext,
          requestedAt, ...metadata,
        }, overrides.auditOptions);
      } catch (_) {
        const logger = overrides.auditLogger;
        if (typeof logger === 'function') {
          logger({ event: 'lab_ai_audit_write_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId });
        }
        return { recorded: false, errorCode: 'AI_AUDIT_WRITE_FAILED' };
      }
    };

    if (normalizedQuestion && EMERGENCY_PATTERNS.some((pattern) => pattern.test(normalizedQuestion))) {
      await audit({ resultStatus: 'escalated', errorCode: 'POSSIBLE_EMERGENCY', escalation: true, completedAt: new Date().toISOString() });
      return Object.freeze({
        status: 'escalation', reasonCode: 'POSSIBLE_EMERGENCY',
        message: 'อาการที่แจ้งอาจต้องได้รับความช่วยเหลือเร่งด่วน กรุณาติดต่อบริการฉุกเฉินหรือสถานพยาบาลใกล้ที่สุดทันที',
      });
    }

    const context = minimizedLabContext(trend);
    const serializedContext = JSON.stringify(context);
    try {
      const response = await getProvider().generateStructured({
        task: 'lab_explanation', systemInstructions: LAB_EXPLANATION_INSTRUCTIONS,
        context: serializedContext,
        input: { text: normalizedQuestion || 'อธิบายผล Lab ที่ยืนยันแล้วด้วยภาษาที่เข้าใจง่าย' },
        outputSchema: validateLabExplanation,
        timeoutMs: config.ai.timeoutMs, requestId: interactionId,
      });
      const validated = validateLabExplanation(response);
      const result = Object.freeze({
        status: 'answer', generatedAt: new Date().toISOString(),
        sourceTimestamp: trend.observations.at(-1)?.specimenCollectedAt || null,
        summary: validated.summary, testExplanation: validated.testExplanation,
        confirmedFacts: deterministicFacts(trend),
        trendExplanation: trend.status === 'available' ? validated.trendExplanation : null,
        rangeCaveat: trend.status === 'available' && trend.rangesDiffer
          ? 'ช่วงอ้างอิงจากแต่ละรายงานแตกต่างกัน จึงต้องพิจารณาแต่ละช่วงตามแหล่งที่มาและไม่รวมเป็นช่วงเดียว'
          : validated.rangeCaveat,
        questionsForClinician: validated.questionsForClinician,
        safetyNotice: hasExplicitCriticalFlag(trend)
          ? 'รายงานต้นฉบับระบุธง critical/วิกฤต กรุณาติดต่อทีมดูแลหรือสถานพยาบาลที่รับผิดชอบโดยเร็ว'
          : validated.safetyNotice,
        disclaimer: validated.disclaimer,
        unavailableReason: trend.status === 'available' ? null : trend.reasonCode,
        deterministicTrend: Object.freeze({
          status: trend.status, reasonCode: trend.reasonCode,
          direction: trend.status === 'available' ? trend.direction : null,
          rangesDiffer: trend.status === 'available' ? trend.rangesDiffer : false,
        }),
      });
      await audit({
        resultStatus: 'success', completedAt: new Date().toISOString(),
        inputCharacterCount: serializedContext.length + normalizedQuestion.length,
        outputCharacterCount: JSON.stringify(result).length,
      });
      return result;
    } catch (error) {
      const errorCode = SAFE_PROVIDER_ERRORS.has(error?.code) ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      await audit({ resultStatus: 'error', errorCode, completedAt: new Date().toISOString() });
      return safeUnavailable(errorCode);
    }
  };
}

module.exports = {
  createLabExplanationService, minimizedLabContext, deterministicFacts,
  hasExplicitCriticalFlag, safeUnavailable, validateQuestion,
};
