const { randomUUID } = require('node:crypto');
const { loadFeatureFlags } = require('../config/featureFlags');
const { loadV2Config } = require('../config/v2Config');
const { createAIProvider } = require('../providers/AIProviderFactory');
const {
  AI_ERROR_CODES, logAIValidationFailure,
} = require('../providers/aiErrors');
const {
  RESEARCH_PLAN_VERSION, RESEARCH_PROMPT_VERSION, SYNTHESIS_PROMPT_VERSION,
  RESEARCH_CONTEXT_VERSION, RESEARCH_PLANNER_INSTRUCTIONS, WEB_EVIDENCE_INSTRUCTIONS,
  CLINICAL_SYNTHESIS_INSTRUCTIONS, RESEARCH_PLAN_SCHEMA, WEB_EVIDENCE_SCHEMA,
  CLINICAL_SYNTHESIS_SCHEMA, validateResearchPlan, validateWebEvidence, validateClinicalSynthesis,
  assertGroundedClinicalSynthesis,
} = require('../providers/pharmacistClinicalResearch');
const { buildConsultationResearchContext } = require('./consultationResearchContextBuilder');
const { sanitizeResearchPlan, validateDeidentifiedPilotSummary } = require('./clinicalResearchPrivacy');
const { buildEvidenceBundle, createUsageAccumulator } = require('./clinicalEvidenceService');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { ConsultationDomainError } = require('../domain/consultation');
const { classifyConsultationSafety } = require('./consultationSafetyService');
const { requireConsultationResearchAccess } = require('./consultationResearchAccessService');
const {
  CLINICAL_RESEARCH_MODES, loadClinicalResearchPilotConfig, clinicalResearchAccess,
} = require('../config/clinicalResearchPilot');

const SAFE_PROVIDER_ERRORS = new Set([
  AI_ERROR_CODES.AI_UNAVAILABLE, AI_ERROR_CODES.AI_TIMEOUT, AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE, AI_ERROR_CODES.AI_PROVIDER_ERROR,
]);

function unavailable(errorCode) {
  return Object.freeze({
    status:'unavailable', errorCode,
    message:'ระบบวิเคราะห์บทสนทนายังไม่พร้อม กรุณาดำเนินการสนทนาด้วยตนเอง',
  });
}

const assertGroundedSynthesis = assertGroundedClinicalSynthesis;

function prepareDeidentifiedContext(summary, access, now) {
  const at = new Date(access.databaseNow || now).toISOString();
  const triage = classifyConsultationSafety(summary);
  const context = Object.freeze({
    contextType:'pharmacist_clinical_research_deidentified',
    contextVersion:'consultation-clinical-research-deidentified-pilot-v1',
    contextTimestamp:at,
    state:access.state,
    triage:Object.freeze({ action:triage.action, category:triage.category, reasonCode:triage.reasonCode || null }),
    deidentifiedCaseSummary:summary,
    conversation:Object.freeze({
      initialQuestion:summary, messages:Object.freeze([]), conversationTruncated:false,
      analyzedMessageCount:1, totalMessageCount:1, analyzedThroughSequence:0,
    }),
    recordedFacts:Object.freeze([]), currentMedications:Object.freeze([]),
    medicationChanges:Object.freeze([]), vitalFacts:Object.freeze([]),
    confirmedLabs:Object.freeze([]), appointments:Object.freeze([]),
    missingInformation:Object.freeze(['DEIDENTIFIED_PILOT_NO_AUTOMATIC_CARE_PROFILE_CONTEXT']),
  });
  return Object.freeze({
    context,
    privacy:Object.freeze({ blockedTerms:Object.freeze([]), conversationTexts:Object.freeze([summary]) }),
    careProfileId:null,
    pharmacistId:access.pharmacistId,
  });
}

function withDeterministicSafety(result, context) {
  if (context.triage?.action !== 'emergency_block') return result;
  const item = Object.freeze({
    text:'ระบบคัดกรองพบสัญญาณที่อาจต้องส่งต่อเพื่อรับการประเมินเร่งด่วน',
    basis:'patient_record', evidenceRefs:Object.freeze([]),
  });
  return Object.freeze({
    ...result,
    keyClinicalIssues:Object.freeze([Object.freeze({ ...item, importance:'urgent' }), ...result.keyClinicalIssues]),
    safetyConsiderations:Object.freeze([item, ...result.safetyConsiderations]),
    escalationConsiderations:Object.freeze([item, ...result.escalationConsiderations]),
  });
}

function createPharmacistClinicalResearchService(overrides = {}) {
  const config = overrides.config || loadV2Config();
  const flags = overrides.flags || loadFeatureFlags(overrides.env || process.env);
  const pilotConfig = overrides.pilotConfig || loadClinicalResearchPilotConfig(overrides.env || process.env);
  const researchProviderName = config.ai.clinicalResearchProvider || config.ai.provider || 'gemini';
  const contextBuilder = overrides.contextBuilder || buildConsultationResearchContext;
  const accessChecker = overrides.accessChecker || requireConsultationResearchAccess;
  const auditRecorder = overrides.recordAudit || recordAIInteractionMetadata;
  const diagnosticLogger = overrides.diagnosticLogger || console.info;
  const writeAudit = async (record) => {
    try { return await auditRecorder(record, overrides.auditOptions); } catch (_) {
      if (typeof overrides.auditLogger === 'function') {
        overrides.auditLogger({ event:'clinical_research_audit_write_failed', errorCode:'AI_AUDIT_WRITE_FAILED' });
      }
      return { recorded:false, errorCode:'AI_AUDIT_WRITE_FAILED' };
    }
  };
  let defaultProvider = null;
  const provider = () => {
    if (overrides.provider) return overrides.provider;
    if (!defaultProvider) {
      defaultProvider = createAIProvider({
        config, providerName:researchProviderName, modelPurpose:'clinical_research',
        env:overrides.env || process.env, fetchImpl:overrides.fetchImpl || global.fetch,
        logger:overrides.providerLogger || console.info,
      });
    }
    return defaultProvider;
  };

  return async function generateClinicalResearch({
    caseId, pharmacistLineUserId, deidentifiedSummary,
    privacyReviewed = false, safetyAcknowledged = false, now = new Date(),
  } = {}) {
    if (!flags.consultation?.clinicalResearch || !pilotConfig.emergencyEnabled) {
      throw new ConsultationDomainError('CLINICAL_RESEARCH_DISABLED', 503);
    }
    const access = clinicalResearchAccess(pilotConfig, pharmacistLineUserId);
    if (!access.allowed) throw new ConsultationDomainError('CLINICAL_RESEARCH_NOT_ALLOWED', 403);
    if (safetyAcknowledged !== true) throw new ConsultationDomainError('CLINICAL_RESEARCH_ACK_REQUIRED', 400);
    let prepared;
    if (pilotConfig.mode === CLINICAL_RESEARCH_MODES.DEIDENTIFIED_PILOT) {
      if (privacyReviewed !== true) throw new ConsultationDomainError('DEIDENTIFIED_REVIEW_REQUIRED', 400);
      const validation = validateDeidentifiedPilotSummary(deidentifiedSummary);
      if (!validation.ok) throw new ConsultationDomainError(validation.errorCode, 400);
      const authorized = await accessChecker({ caseId, pharmacistLineUserId, now });
      prepared = prepareDeidentifiedContext(validation.summary, authorized, now);
    } else if (pilotConfig.mode === CLINICAL_RESEARCH_MODES.CONTROLLED_LIVE) {
      prepared = await contextBuilder({ caseId, pharmacistLineUserId, now });
    } else {
      throw new ConsultationDomainError('CLINICAL_RESEARCH_DISABLED', 503);
    }
    const interactionId = `AI-${randomUUID()}`;
    const requestedAt = new Date(now).toISOString();
    const usage = createUsageAccumulator();
    const serializedContext = JSON.stringify(prepared.context);
    let plan;
    let evidence = Object.freeze({ findings:Object.freeze([]), sources:Object.freeze([]), limitations:Object.freeze([]) });
    let inputCharacterCount = serializedContext.length;
    let outputCharacterCount = 0;
    let researchPerformed = false;
    let contractTask = 'pharmacist_clinical_research_plan';
    const limitations = [];
    try {
      plan = validateResearchPlan(await provider().generateStructured({
        task:'pharmacist_clinical_research_plan',
        systemInstructions:RESEARCH_PLANNER_INSTRUCTIONS,
        context:serializedContext,
        input:{ text:'Create a strictly de-identified clinical research plan when external evidence is needed.' },
        outputSchema:validateResearchPlan, responseSchema:RESEARCH_PLAN_SCHEMA,
        responseSchemaName:'phimor_clinical_research_plan',
        timeoutMs:config.ai.clinicalResearchTimeoutMs ?? config.ai.timeoutMs, requestId:interactionId,
        model:config.ai.clinicalResearchModel, reasoningEffort:config.ai.clinicalResearchReasoningEffort,
        onMetadata:usage.record,
      }));
      outputCharacterCount += JSON.stringify(plan).length;
      const safePlan = sanitizeResearchPlan(plan, prepared.privacy);
      if (safePlan.errorCode) limitations.push(safePlan.errorCode);
      if (plan.researchNeeded && safePlan.acceptedTopics.length) {
        const researchInput = JSON.stringify({ researchTopics:safePlan.acceptedTopics });
        inputCharacterCount += researchInput.length;
        let metadata = null;
        try {
          contractTask = 'pharmacist_clinical_web_evidence';
          const rawEvidence = validateWebEvidence(await provider().generateStructured({
            task:'pharmacist_clinical_web_evidence',
            systemInstructions:WEB_EVIDENCE_INSTRUCTIONS,
            context:null,
            input:{ text:researchInput },
            outputSchema:validateWebEvidence, responseSchema:WEB_EVIDENCE_SCHEMA,
            responseSchemaName:'phimor_clinical_web_evidence',
            timeoutMs:config.ai.clinicalResearchTimeoutMs ?? config.ai.timeoutMs, requestId:interactionId,
            model:config.ai.clinicalResearchModel, reasoningEffort:config.ai.clinicalResearchReasoningEffort,
            webSearch:{ allowedDomains:config.ai.clinicalAllowedDomains, maxCalls:4, country:'TH', required:true },
            onMetadata:(value) => { metadata = value; usage.record(value); },
          }));
          outputCharacterCount += JSON.stringify(rawEvidence).length;
          evidence = buildEvidenceBundle(rawEvidence, metadata, {
            allowedDomains:config.ai.clinicalAllowedDomains, accessedAt:now, maxSources:8,
          });
          researchPerformed = Number(metadata?.webSearchCalls || 0) > 0;
          limitations.push(...evidence.limitations);
        } catch (error) {
          logAIValidationFailure(diagnosticLogger, {
            event:'pharmacist_clinical_research_contract_rejected', task:contractTask, error,
          });
          limitations.push(SAFE_PROVIDER_ERRORS.has(error?.code) ? 'RESEARCH_TEMPORARILY_UNAVAILABLE' : 'RESEARCH_INVALID_RESPONSE');
        }
      }
      const synthesisContext = JSON.stringify({
        privateClinicalContext:prepared.context,
        researchPlan:{
          clinicalQuestions:plan.clinicalQuestions,
          missingInformation:plan.missingInformation,
          urgentSafetyFlags:plan.urgentSafetyFlags,
        },
        validatedEvidence:evidence.findings,
        evidenceSources:evidence.sources,
        researchLimitations:[...new Set(limitations)],
      });
      inputCharacterCount += synthesisContext.length;
      const allowedEvidenceRefs = evidence.sources.map((source) => source.referenceId);
      contractTask = 'pharmacist_clinical_research_synthesis';
      const result = assertGroundedSynthesis(validateClinicalSynthesis(await provider().generateStructured({
        task:'pharmacist_clinical_research_synthesis',
        systemInstructions:CLINICAL_SYNTHESIS_INSTRUCTIONS,
        context:synthesisContext,
        input:{ text:'Prepare private analysis and an editable draft for independent pharmacist review. Do not send anything.' },
        outputSchema:(value) => validateClinicalSynthesis(value, { allowedEvidenceRefs }),
        responseSchema:CLINICAL_SYNTHESIS_SCHEMA,
        responseSchemaName:'phimor_clinical_research_synthesis',
        timeoutMs:config.ai.clinicalResearchTimeoutMs ?? config.ai.timeoutMs, requestId:interactionId,
        model:config.ai.clinicalResearchModel, reasoningEffort:config.ai.clinicalResearchReasoningEffort,
        onMetadata:usage.record,
      }), { allowedEvidenceRefs }), prepared.context);
      const generatedAt = new Date(now).toISOString();
      const finalResult = withDeterministicSafety(Object.freeze({
        ...result,
        research:Object.freeze({
          performed:researchPerformed,
          topics:Object.freeze((plan.researchTopics || []).map((topic) => topic.type)),
          sources:evidence.sources,
          limitations:Object.freeze([...new Set([...result.research.limitations, ...limitations])]),
        }),
      }), prepared.context);
      outputCharacterCount += JSON.stringify(finalResult).length;
      const totals = usage.snapshot();
      const audit = await writeAudit({
        interactionId, requesterLineId:null, requesterType:'pharmacist',
        careProfileId:prepared.careProfileId, consultationCaseId:caseId,
        purpose:'pharmacist_clinical_research', intent:'clinical_research',
        provider:researchProviderName, model:config.ai.clinicalResearchModel,
        promptVersion:SYNTHESIS_PROMPT_VERSION, contextVersion:prepared.context.contextVersion || RESEARCH_CONTEXT_VERSION,
        researchPlanVersion:RESEARCH_PLAN_VERSION,
        resultStatus:'needs_review', requestedAt, completedAt:generatedAt,
        inputCharacterCount, outputCharacterCount,
        ...totals, sourceCount:evidence.sources.length, researchPerformed,
      });
      if (!audit?.recorded) return unavailable('AI_AUDIT_WRITE_FAILED');
      return Object.freeze({
        status:'available', mode:pilotConfig.mode, generatedAt,
        contextTimestamp:prepared.context.contextTimestamp,
        analyzedThroughSequence:prepared.context.conversation.analyzedThroughSequence,
        analyzedMessageCount:prepared.context.conversation.analyzedMessageCount,
        totalMessageCount:prepared.context.conversation.totalMessageCount,
        conversationTruncated:prepared.context.conversation.conversationTruncated,
        analysis:finalResult,
      });
    } catch (error) {
      const errorCode = SAFE_PROVIDER_ERRORS.has(error?.code) ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      logAIValidationFailure(diagnosticLogger, {
        event:'pharmacist_clinical_research_contract_rejected', task:contractTask, error,
      });
      const totals = usage.snapshot();
      const audit = await writeAudit({
        interactionId, requesterLineId:null, requesterType:'pharmacist',
        careProfileId:prepared.careProfileId, consultationCaseId:caseId,
        purpose:'pharmacist_clinical_research', intent:'clinical_research',
        provider:researchProviderName, model:config.ai.clinicalResearchModel,
        promptVersion:SYNTHESIS_PROMPT_VERSION, contextVersion:prepared.context.contextVersion || RESEARCH_CONTEXT_VERSION,
        researchPlanVersion:RESEARCH_PLAN_VERSION,
        resultStatus:'error', errorCode, requestedAt, completedAt:new Date(now).toISOString(),
        inputCharacterCount, outputCharacterCount, ...totals,
        sourceCount:evidence.sources.length, researchPerformed,
      });
      if (!audit?.recorded) return unavailable('AI_AUDIT_WRITE_FAILED');
      return unavailable(errorCode);
    }
  };
}

const generatePharmacistClinicalResearch = createPharmacistClinicalResearchService();

module.exports = {
  SAFE_PROVIDER_ERRORS, unavailable, assertGroundedSynthesis, withDeterministicSafety,
  prepareDeidentifiedContext,
  createPharmacistClinicalResearchService, generatePharmacistClinicalResearch,
  RESEARCH_PROMPT_VERSION,
};
