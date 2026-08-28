const { randomUUID } = require('node:crypto');
const { createAIProvider } = require('../providers/AIProviderFactory');
const { AI_ERROR_CODES } = require('../providers/aiErrors');
const {
  DOCTOR_QUESTION_INSTRUCTIONS, DOCTOR_QUESTION_PROMPT_VERSION, validateDoctorQuestions,
} = require('../providers/doctorQuestionAI');
const { AI_VERSIONS } = require('../config/aiVersions');
const { loadV2Config } = require('../config/v2Config');
const { loadFeatureFlags } = require('../config/featureFlags');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { requirePlusFeature } = require('./plusEntitlementService');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { EMERGENCY_PATTERNS } = require('./consultationSafetyService');
const {
  DoctorQuestionError, createDoctorQuestionContextBuilder,
} = require('./doctorQuestionContextBuilder');

const SAFE_PROVIDER_ERRORS = new Set([
  AI_ERROR_CODES.AI_UNAVAILABLE, AI_ERROR_CODES.AI_TIMEOUT, AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE, AI_ERROR_CODES.AI_PROVIDER_ERROR,
]);
const ALLOWED_PRINCIPALS = new Set(['family_owner', 'family_caregiver', 'center_staff']);
const DOCTOR_QUESTION_DISCLAIMER = 'ข้อมูลจากพี่หมอใช้เพื่อช่วยเตรียมคำถาม ไม่ใช่การวินิจฉัยหรือคำแนะนำให้ปรับยา';

function safeUnavailable(errorCode) {
  return Object.freeze({
    status: 'unavailable', errorCode,
    message: 'ระบบช่วยเตรียมคำถามยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
  });
}

function validateFocus(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new DoctorQuestionError('INVALID_INPUT');
  const normalized = value.normalize('NFC').trim();
  if (normalized.length > 500) throw new DoctorQuestionError('FOCUS_TOO_LONG');
  return normalized;
}

function generatedText(result) {
  return [
    result.title, result.summary, result.safetyNotice,
    ...result.questions.flatMap((item) => [item.question, item.rationale]),
  ].join('\n');
}

function numericTokens(value) {
  return new Set(String(value || '').match(/\d+(?:[.,]\d+)?/g) || []);
}

function assertGroundedNumbers(result, sourceText) {
  const allowed = numericTokens(sourceText);
  for (const token of numericTokens(generatedText(result))) {
    if (!allowed.has(token)) {
      const error = new Error('Ungrounded numeric statement');
      error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
      throw error;
    }
  }
  return result;
}

function groundingSourceText(context, focus = '') {
  return JSON.stringify({
    focus,
    conditions: context.conditions,
    allergies: context.allergies,
    mobilityLimitations: context.mobilityLimitations,
    currentMedications: context.currentMedications,
    medicationChanges: context.medicationChanges,
    confirmedLabs: context.confirmedLabs,
    safeLabTrends: context.safeLabTrends,
    appointment: context.appointment ? {
      hospital: context.appointment.hospital,
      department: context.appointment.department,
      reason: context.appointment.reason,
      notes: context.appointment.notes,
    } : null,
  });
}

function assertContextGroundedClaims(result, context) {
  const rationales = result.questions.map((item) => item.rationale).join('\n');
  const nonQuestionText = `${result.title}\n${result.summary}\n${result.safetyNotice}\n${rationales}`;
  const questionText = result.questions.map((item) => item.question).join('\n');
  if ((context.safeLabTrends || []).length === 0) {
    const definiteTrend = /(?:เพิ่มขึ้น|ลดลง|สูงขึ้น|ต่ำลง|คงที่|\bincreased\b|\bdecreased\b|\bunchanged\b)/i;
    if (definiteTrend.test(nonQuestionText) || definiteTrend.test(questionText)) {
      const error = new Error('Ungrounded Lab trend claim');
      error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
      throw error;
    }
  }
  const sourceHasAbnormalFlag = (context.confirmedLabs || []).some((item) =>
    typeof item.abnormalFlagSource === 'string' && item.abnormalFlagSource.trim());
  if (!sourceHasAbnormalFlag
    && /(?:สูงกว่าปกติ|ต่ำกว่าปกติ|ผิดปกติ|\babnormal\b|\babove normal\b|\bbelow normal\b)/i.test(nonQuestionText)) {
    const error = new Error('Ungrounded Lab flag claim');
    error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
    throw error;
  }
  if ((context.medicationChanges || []).length === 0
    && /(?:มีการ|ข้อมูลแสดงว่า).{0,20}(?:ปรับ|เปลี่ยน|เพิ่ม|ลด).{0,20}(?:ยา|ขนาดยา|โดส)/i.test(nonQuestionText)) {
    const error = new Error('Ungrounded medication change claim');
    error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
    throw error;
  }
  return result;
}

function createDoctorQuestionService(overrides = {}) {
  let defaultProvider = null;
  const config = overrides.config || loadV2Config();
  const flags = overrides.flags || loadFeatureFlags();
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const entitlement = overrides.requirePlusFeature || requirePlusFeature;
  const buildContext = overrides.buildContext || createDoctorQuestionContextBuilder(overrides.contextDependencies);
  const recordAudit = overrides.recordAudit || recordAIInteractionMetadata;
  const getProvider = () => {
    if (overrides.provider) return overrides.provider;
    if (!defaultProvider) defaultProvider = createAIProvider({ config, modelPurpose: 'explanation' });
    return defaultProvider;
  };

  return async function generateDoctorQuestions({
    careProfileId, lineUserId, centerId = null, appointmentId = null, focus = '', now = new Date(),
  } = {}) {
    if (typeof careProfileId !== 'string' || !careProfileId.trim()
      || typeof lineUserId !== 'string' || !lineUserId.trim()) {
      throw new DoctorQuestionError('INVALID_INPUT');
    }
    const normalizedFocus = validateFocus(focus);
    const access = await authorize({
      lineUserId, careProfileId, permission: 'view', centerId: centerId || null,
      requireActiveCenter: true,
    });
    if (!ALLOWED_PRINCIPALS.has(access?.principalType)) throw new DoctorQuestionError('ACCESS_DENIED', 403);
    const auditRequesterType = access.principalType === 'center_staff' ? null : 'family';
    const auditIntent = access.principalType === 'center_staff'
      ? 'prepare_questions_center_staff' : 'prepare_questions_family';

    const interactionId = `AI-${randomUUID()}`;
    const requestedAt = new Date(now).toISOString();
    const audit = async (metadata) => {
      try {
        return await recordAudit({
          interactionId, requesterLineId: null, careProfileId, requesterType: auditRequesterType,
          purpose: 'doctor_question_preparation', intent: auditIntent,
          provider: config.ai.provider, model: config.ai.explanationModel || null,
          promptVersion: DOCTOR_QUESTION_PROMPT_VERSION,
          contextVersion: AI_VERSIONS.doctorQuestionContext,
          requestedAt, ...metadata,
        }, overrides.auditOptions);
      } catch (_) {
        if (typeof overrides.auditLogger === 'function') {
          overrides.auditLogger({
            event: 'doctor_question_audit_write_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId,
          });
        }
        return { recorded: false, errorCode: 'AI_AUDIT_WRITE_FAILED' };
      }
    };

    if (normalizedFocus && EMERGENCY_PATTERNS.some((pattern) => pattern.test(normalizedFocus))) {
      await audit({
        resultStatus: 'escalated', errorCode: 'POSSIBLE_EMERGENCY', escalation: true,
        completedAt: new Date(now).toISOString(), inputCharacterCount: normalizedFocus.length,
      });
      return Object.freeze({
        status: 'escalation', reasonCode: 'POSSIBLE_EMERGENCY',
        message: 'อาการที่แจ้งอาจต้องได้รับความช่วยเหลือเร่งด่วน กรุณาติดต่อบริการฉุกเฉินหรือสถานพยาบาลใกล้ที่สุดทันที',
      });
    }

    await entitlement({
      lineUserId, feature: 'ai_explanation', capability: 'doctor_question_prep', flags,
      queryFn: overrides.entitlementQueryFn,
    });
    const prepared = await buildContext({
      careProfileId, lineUserId, centerId, appointmentId, now,
    });
    const serializedContext = JSON.stringify(prepared.context);
    try {
      const response = await getProvider().generateStructured({
        task: 'doctor_question_preparation',
        systemInstructions: DOCTOR_QUESTION_INSTRUCTIONS,
        context: serializedContext,
        input: { text: normalizedFocus || 'ช่วยจัดลำดับคำถามสำคัญสำหรับพบแพทย์จากข้อมูลที่บันทึกไว้' },
        outputSchema: validateDoctorQuestions,
        timeoutMs: config.ai.timeoutMs,
        requestId: interactionId,
      });
      const validated = assertContextGroundedClaims(
        assertGroundedNumbers(
          validateDoctorQuestions(response), groundingSourceText(prepared.context, normalizedFocus)
        ),
        prepared.context,
      );
      const result = Object.freeze({
        status: 'questions', generatedAt: new Date(now).toISOString(),
        contextTimestamp: prepared.contextTimestamp,
        title: validated.title, summary: validated.summary,
        questions: validated.questions,
        missingInformation: prepared.context.missingInformation,
        safetyNotice: validated.safetyNotice,
        disclaimer: DOCTOR_QUESTION_DISCLAIMER,
      });
      await audit({
        resultStatus: 'success', completedAt: new Date(now).toISOString(),
        inputCharacterCount: serializedContext.length + normalizedFocus.length,
        outputCharacterCount: JSON.stringify(result).length,
      });
      return result;
    } catch (error) {
      const errorCode = SAFE_PROVIDER_ERRORS.has(error?.code)
        ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      await audit({ resultStatus: 'error', errorCode, completedAt: new Date(now).toISOString() });
      return safeUnavailable(errorCode);
    }
  };
}

module.exports = {
  SAFE_PROVIDER_ERRORS, DOCTOR_QUESTION_DISCLAIMER,
  safeUnavailable, validateFocus, numericTokens, assertGroundedNumbers,
  groundingSourceText, assertContextGroundedClaims,
  createDoctorQuestionService,
};
