const { randomUUID } = require('node:crypto');
const { loadFeatureFlags } = require('../config/featureFlags');
const { loadV2Config } = require('../config/v2Config');
const { createAIProvider } = require('../providers/AIProviderFactory');
const { AI_ERROR_CODES } = require('../providers/aiErrors');
const {
  RESEARCH_PLAN_VERSION, RESEARCH_PROMPT_VERSION, SYNTHESIS_PROMPT_VERSION,
  RESEARCH_CONTEXT_VERSION, RESEARCH_PLANNER_INSTRUCTIONS, WEB_EVIDENCE_INSTRUCTIONS,
  CLINICAL_SYNTHESIS_INSTRUCTIONS, RESEARCH_PLAN_SCHEMA, WEB_EVIDENCE_SCHEMA,
  CLINICAL_SYNTHESIS_SCHEMA, validateResearchPlan, validateWebEvidence, validateClinicalSynthesis,
} = require('../providers/pharmacistClinicalResearch');
const { buildConsultationResearchContext } = require('./consultationResearchContextBuilder');
const { sanitizeResearchPlan } = require('./clinicalResearchPrivacy');
const { buildEvidenceBundle, createUsageAccumulator } = require('./clinicalEvidenceService');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { ConsultationDomainError } = require('../domain/consultation');

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

function assertGroundedSynthesis(result, context) {
  const medicationNames = (context.currentMedications || [])
    .map((item) => String(item.name || '').normalize('NFC').trim().toLowerCase()).filter(Boolean);
  for (const item of result.relevantMedicationContext || []) {
    const normalized = item.text.normalize('NFC').toLowerCase();
    if (!medicationNames.some((name) => normalized.includes(name))) {
      const error = new Error('Ungrounded medication fact');
      error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
      throw error;
    }
  }
  const hasAllergyFact = (context.recordedFacts || []).some((item) => item.field === 'drug_allergies');
  if (!hasAllergyFact && /(?:ไม่แพ้ยา|ไม่มีประวัติแพ้ยา|no known (?:drug )?allerg)/i.test(JSON.stringify(result.recordedFacts))) {
    const error = new Error('Ungrounded allergy fact');
    error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
    throw error;
  }
  const hasRenalFact = (context.confirmedLabs || []).some((item) =>
    /(?:creatinine|eGFR|ไต)/i.test(`${item.analyteNameSource} ${item.sourceValueText}`));
  if (!hasRenalFact && /(?:eGFR|creatinine|การทำงานของไต).{0,40}\d/i.test(JSON.stringify(result.recordedFacts))) {
    const error = new Error('Ungrounded renal fact');
    error.code = AI_ERROR_CODES.AI_INVALID_RESPONSE;
    throw error;
  }
  return result;
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
  const flags = overrides.flags || loadFeatureFlags();
  const researchProviderName = config.ai.clinicalResearchProvider || config.ai.provider || 'gemini';
  const contextBuilder = overrides.contextBuilder || buildConsultationResearchContext;
  const auditRecorder = overrides.recordAudit || recordAIInteractionMetadata;
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
        logger:overrides.providerLogger || null,
      });
    }
    return defaultProvider;
  };

  return async function generateClinicalResearch({ caseId, pharmacistLineUserId, now = new Date() } = {}) {
    if (!flags.consultation?.clinicalResearch) {
      throw new ConsultationDomainError('CLINICAL_RESEARCH_DISABLED', 503);
    }
    const interactionId = `AI-${randomUUID()}`;
    const requestedAt = new Date(now).toISOString();
    const usage = createUsageAccumulator();
    const prepared = await contextBuilder({ caseId, pharmacistLineUserId, now });
    const serializedContext = JSON.stringify(prepared.context);
    let plan;
    let evidence = Object.freeze({ findings:Object.freeze([]), sources:Object.freeze([]), limitations:Object.freeze([]) });
    let inputCharacterCount = serializedContext.length;
    let outputCharacterCount = 0;
    let researchPerformed = false;
    const limitations = [];
    try {
      plan = validateResearchPlan(await provider().generateStructured({
        task:'pharmacist_clinical_research_plan',
        systemInstructions:RESEARCH_PLANNER_INSTRUCTIONS,
        context:serializedContext,
        input:{ text:'Create a strictly de-identified clinical research plan when external evidence is needed.' },
        outputSchema:validateResearchPlan, responseSchema:RESEARCH_PLAN_SCHEMA,
        responseSchemaName:'phimor_clinical_research_plan',
        timeoutMs:config.ai.timeoutMs, requestId:interactionId,
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
          const rawEvidence = validateWebEvidence(await provider().generateStructured({
            task:'pharmacist_clinical_web_evidence',
            systemInstructions:WEB_EVIDENCE_INSTRUCTIONS,
            context:null,
            input:{ text:researchInput },
            outputSchema:validateWebEvidence, responseSchema:WEB_EVIDENCE_SCHEMA,
            responseSchemaName:'phimor_clinical_web_evidence',
            timeoutMs:config.ai.timeoutMs, requestId:interactionId,
            model:config.ai.clinicalResearchModel, reasoningEffort:config.ai.clinicalResearchReasoningEffort,
            webSearch:{ allowedDomains:config.ai.clinicalAllowedDomains, maxCalls:4, country:'TH' },
            onMetadata:(value) => { metadata = value; usage.record(value); },
          }));
          outputCharacterCount += JSON.stringify(rawEvidence).length;
          evidence = buildEvidenceBundle(rawEvidence, metadata, {
            allowedDomains:config.ai.clinicalAllowedDomains, accessedAt:now, maxSources:8,
          });
          researchPerformed = Number(metadata?.webSearchCalls || 0) > 0;
          limitations.push(...evidence.limitations);
        } catch (error) {
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
      const result = assertGroundedSynthesis(validateClinicalSynthesis(await provider().generateStructured({
        task:'pharmacist_clinical_research_synthesis',
        systemInstructions:CLINICAL_SYNTHESIS_INSTRUCTIONS,
        context:synthesisContext,
        input:{ text:'Prepare private analysis and an editable draft for independent pharmacist review. Do not send anything.' },
        outputSchema:(value) => validateClinicalSynthesis(value, { allowedEvidenceRefs }),
        responseSchema:CLINICAL_SYNTHESIS_SCHEMA,
        responseSchemaName:'phimor_clinical_research_synthesis',
        timeoutMs:config.ai.timeoutMs, requestId:interactionId,
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
        promptVersion:SYNTHESIS_PROMPT_VERSION, contextVersion:RESEARCH_CONTEXT_VERSION,
        researchPlanVersion:RESEARCH_PLAN_VERSION,
        resultStatus:'needs_review', requestedAt, completedAt:generatedAt,
        inputCharacterCount, outputCharacterCount,
        ...totals, sourceCount:evidence.sources.length, researchPerformed,
      });
      if (!audit?.recorded) return unavailable('AI_AUDIT_WRITE_FAILED');
      return Object.freeze({
        status:'available', generatedAt,
        contextTimestamp:prepared.context.contextTimestamp,
        analyzedThroughSequence:prepared.context.conversation.analyzedThroughSequence,
        analyzedMessageCount:prepared.context.conversation.analyzedMessageCount,
        totalMessageCount:prepared.context.conversation.totalMessageCount,
        conversationTruncated:prepared.context.conversation.conversationTruncated,
        analysis:finalResult,
      });
    } catch (error) {
      const errorCode = SAFE_PROVIDER_ERRORS.has(error?.code) ? error.code : AI_ERROR_CODES.AI_PROVIDER_ERROR;
      const totals = usage.snapshot();
      const audit = await writeAudit({
        interactionId, requesterLineId:null, requesterType:'pharmacist',
        careProfileId:prepared.careProfileId, consultationCaseId:caseId,
        purpose:'pharmacist_clinical_research', intent:'clinical_research',
        provider:researchProviderName, model:config.ai.clinicalResearchModel,
        promptVersion:SYNTHESIS_PROMPT_VERSION, contextVersion:RESEARCH_CONTEXT_VERSION,
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
  createPharmacistClinicalResearchService, generatePharmacistClinicalResearch,
  RESEARCH_PROMPT_VERSION,
};
