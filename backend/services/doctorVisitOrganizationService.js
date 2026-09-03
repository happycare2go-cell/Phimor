const { randomUUID } = require('node:crypto');
const { createAIProvider } = require('../providers/AIProviderFactory');
const { AI_ERROR_CODES } = require('../providers/aiErrors');
const {
  DOCTOR_VISIT_INSTRUCTIONS, DOCTOR_VISIT_PROMPT_VERSION, validateDoctorVisitOrganization,
} = require('../providers/doctorVisitAI');
const { AI_VERSIONS } = require('../config/aiVersions');
const { loadV2Config } = require('../config/v2Config');
const { loadFeatureFlags } = require('../config/featureFlags');
const { authorizeCareProfileAccess } = require('./careProfileAuthorizationService');
const { requirePlusFeature } = require('./plusEntitlementService');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { createDoctorVisitService } = require('./doctorVisitService');
const { DoctorVisitDomainError } = require('../domain/doctorVisit');
const { DOCTOR_VISIT_RESPONSE_SCHEMA } = require('../providers/aiResponseSchemas');

const SAFE_PROVIDER_ERRORS = new Set([
  AI_ERROR_CODES.AI_UNAVAILABLE, AI_ERROR_CODES.AI_TIMEOUT, AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE, AI_ERROR_CODES.AI_PROVIDER_ERROR,
]);

function numericTokens(value) {
  return new Set(String(value || '').match(/\d+(?:[.,]\d+)?/g) || []);
}

function validateGrounding(result, sourceText) {
  const source = String(sourceText || '').normalize('NFC');
  for (const item of result.items) {
    if (!source.includes(item.sourceSupport)) {
      const error = new Error('Unsupported source statement');
      error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
      throw error;
    }
    const allowedNumbers = numericTokens(item.sourceSupport);
    for (const token of numericTokens(`${item.summary}\n${item.dueAt || ''}`)) {
      if (!allowedNumbers.has(token)) {
        const error = new Error('Ungrounded numeric statement');
        error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
        throw error;
      }
    }
    if (item.dueAt && !item.sourceSupport.includes(item.dueAt.slice(0, 10))) {
      const error = new Error('Inferred appointment date');
      error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
      throw error;
    }
  }
  return result;
}

function safeUnavailable(errorCode) {
  return Object.freeze({
    status: 'unavailable', errorCode,
    message: 'ระบบช่วยจัดระเบียบบันทึกยังไม่พร้อม คุณยังบันทึกและตรวจสอบข้อมูลด้วยตนเองได้',
  });
}

function createDoctorVisitOrganizationService(overrides = {}) {
  let defaultProvider = null;
  const config = overrides.config || loadV2Config();
  const flags = overrides.flags || loadFeatureFlags();
  const authorize = overrides.authorizeCareProfileAccess || authorizeCareProfileAccess;
  const entitlement = overrides.requirePlusFeature || requirePlusFeature;
  const recordService = overrides.doctorVisitService || createDoctorVisitService(overrides.serviceDependencies);
  const recordAudit = overrides.recordAudit || recordAIInteractionMetadata;
  const getProvider = () => {
    if (overrides.provider) return overrides.provider;
    if (!defaultProvider) defaultProvider = createAIProvider({ config, modelPurpose: 'explanation' });
    return defaultProvider;
  };

  return async function organizeDoctorVisit({
    careProfileId, visitRecordId, lineUserId, centerId = null, now = new Date(),
  } = {}) {
    const access = await authorize({
      lineUserId, careProfileId, permission: 'view', centerId: centerId || null,
      requireActiveCenter: true,
    });
    if (!['family_owner', 'family_caregiver', 'center_staff'].includes(access?.principalType)) {
      throw new DoctorVisitDomainError('ACCESS_DENIED');
    }
    await entitlement({
      lineUserId, feature: 'ai_explanation', capability: 'doctor_visit_organization', flags,
      queryFn: overrides.entitlementQueryFn,
    });
    const record = await recordService.getRecord({ careProfileId, visitRecordId, lineUserId, centerId });
    if (record.status !== 'draft') throw new DoctorVisitDomainError('RECORD_NOT_DRAFT');
    if (!String(record.sourceText || '').trim()) throw new DoctorVisitDomainError('SOURCE_TEXT_REQUIRED');

    const interactionId = `AI-${randomUUID()}`;
    const requestedAt = new Date(now).toISOString();
    const audit = async (metadata) => {
      try {
        await recordAudit({
          interactionId, requesterLineId: null, careProfileId,
          requesterType: access.principalType === 'center_staff' ? null : 'family',
          purpose: 'doctor_visit_organization',
          intent: access.principalType === 'center_staff' ? 'organize_center_visit_note' : 'organize_family_visit_note',
          provider: config.ai.provider, model: config.ai.explanationModel || null,
          promptVersion: DOCTOR_VISIT_PROMPT_VERSION,
          contextVersion: AI_VERSIONS.doctorVisitContext,
          requestedAt, ...metadata,
        }, overrides.auditOptions);
      } catch (_) {
        if (typeof overrides.auditLogger === 'function') {
          overrides.auditLogger({
            event: 'doctor_visit_audit_write_failed', errorCode: 'AI_AUDIT_WRITE_FAILED', interactionId,
          });
        }
      }
    };

    const context = JSON.stringify({
      recordType: 'user_recorded_post_visit_note', sourceText: record.sourceText,
      appointmentLinked: Boolean(record.appointmentId),
    });
    let validated;
    try {
      const response = await getProvider().generateStructured({
        task: 'doctor_visit_organization',
        systemInstructions: DOCTOR_VISIT_INSTRUCTIONS,
        context,
        input: { text: 'จัดระเบียบข้อความต้นทางเป็นฉบับรอตรวจสอบ โดยห้ามเพิ่มข้อมูล' },
        outputSchema: validateDoctorVisitOrganization,
        responseSchema: DOCTOR_VISIT_RESPONSE_SCHEMA,
        responseSchemaName: 'phimor_doctor_visit',
        timeoutMs: config.ai.timeoutMs,
        requestId: interactionId,
      });
      validated = validateGrounding(validateDoctorVisitOrganization(response), record.sourceText);
    } catch (error) {
      const errorCode = SAFE_PROVIDER_ERRORS.has(error?.code)
        ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      await audit({ resultStatus: 'error', errorCode, completedAt: new Date(now).toISOString() });
      return safeUnavailable(errorCode);
    }
    // Persist outside the provider-error boundary. Fresh authorization and draft
    // status checks from the record service must propagate instead of being
    // disguised as an AI outage.
    const updated = await recordService.applyAIOrganization({
      careProfileId, visitRecordId, lineUserId, centerId,
      patch: {
        structuredSummary: validated.summary,
        items: validated.items.map((item) => ({
          kind: item.kind, sourceSupport: item.sourceSupport, summary: item.summary,
          dueAt: item.dueAt, uncertainty: item.uncertainty,
        })),
      },
    });
    await audit({
      resultStatus: 'needs_review', completedAt: new Date(now).toISOString(),
      inputCharacterCount: context.length,
      outputCharacterCount: JSON.stringify({
        itemCount: validated.items.length,
        missingInformationCount: validated.missingInformation.length,
      }).length,
    });
    return Object.freeze({
      status: 'draft', generatedAt: new Date(now).toISOString(), record: updated,
      missingInformation: validated.missingInformation,
      reviewNotice: validated.reviewNotice,
    });
  };
}

module.exports = {
  SAFE_PROVIDER_ERRORS, numericTokens, validateGrounding, safeUnavailable,
  createDoctorVisitOrganizationService,
};
