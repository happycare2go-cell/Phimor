const { randomUUID } = require('node:crypto');
const { loadV2Config } = require('../config/v2Config');
const { AI_VERSIONS } = require('../config/aiVersions');
const { createAIProvider } = require('../providers/AIProviderFactory');
const { AI_ERROR_CODES, logAIValidationFailure } = require('../providers/aiErrors');
const {
  PHARMACIST_ASSISTANT_INSTRUCTIONS, PHARMACIST_ASSISTANT_PROMPT_VERSION,
  validatePharmacistAssistantResponse, assertGroundedPharmacistAssistant,
} = require('../providers/pharmacistAssistant');
const { buildConsultationContext } = require('./consultationContextBuilder');
const { recordAIInteractionMetadata } = require('./aiAuditService');
const { PHARMACIST_ASSISTANT_RESPONSE_SCHEMA } = require('../providers/aiResponseSchemas');

const SAFE_PROVIDER_ERRORS=new Set([
  AI_ERROR_CODES.AI_UNAVAILABLE,AI_ERROR_CODES.AI_TIMEOUT,AI_ERROR_CODES.AI_RATE_LIMIT,
  AI_ERROR_CODES.AI_INVALID_RESPONSE,AI_ERROR_CODES.AI_PROVIDER_ERROR,
]);

function unavailable(errorCode) {
  return Object.freeze({
    status:'unavailable',errorCode,
    message:'ระบบผู้ช่วยเภสัชกรยังไม่พร้อม กรุณาดำเนินการสนทนาด้วยตนเอง',
  });
}

function createPharmacistAssistantService(overrides={}) {
  let defaultProvider=null;
  const config=overrides.config || loadV2Config();
  const provider=()=>{
    if (overrides.provider) return overrides.provider;
    if (!defaultProvider) defaultProvider=createAIProvider({
      config,modelPurpose:'pharmacist',logger:overrides.providerLogger || console.info,
    });
    return defaultProvider;
  };
  const contextBuilder=overrides.contextBuilder || buildConsultationContext;
  const auditRecorder=overrides.recordAudit || recordAIInteractionMetadata;
  const diagnosticLogger=overrides.diagnosticLogger || console.info;

  return async function generatePharmacistAssistance({caseId,pharmacistLineUserId}={}) {
    const interactionId=`AI-${randomUUID()}`;
    const requestedAt=new Date().toISOString();
    const context=await contextBuilder({caseId,pharmacistLineUserId});
    const serialized=JSON.stringify(context);
    const audit=async(metadata)=>{
      try {
        return await auditRecorder({
          interactionId,requesterLineId:pharmacistLineUserId,requesterType:'pharmacist',
          careProfileId:null,consultationCaseId:caseId,purpose:'pharmacist_assistance',
          intent:'consultation_support',provider:config.ai.pharmacistProvider||config.ai.provider,
          model:config.ai.pharmacistModel||null,promptVersion:PHARMACIST_ASSISTANT_PROMPT_VERSION,
          contextVersion:AI_VERSIONS.consultationContext,requestedAt,
          inputCharacterCount:serialized.length,...metadata,
        },overrides.auditOptions);
      } catch (_) {
        const logger=overrides.auditLogger || console.error;
        if (typeof logger==='function') logger({event:'ai_audit_write_failed',errorCode:'AI_AUDIT_WRITE_FAILED',interactionId});
        return {recorded:false};
      }
    };
    try {
      const validateForContext=(value)=>assertGroundedPharmacistAssistant(
        validatePharmacistAssistantResponse(value), context,
      );
      const raw=await provider().generateStructured({
        task:'pharmacist_assistance',systemInstructions:PHARMACIST_ASSISTANT_INSTRUCTIONS,
        context:serialized,input:{text:'Prepare private pharmacist decision-support from the supplied structured context.'},
        outputSchema:validateForContext,
        timeoutMs:config.ai.pharmacistTimeoutMs ?? config.ai.timeoutMs,requestId:interactionId,
        responseSchema:PHARMACIST_ASSISTANT_RESPONSE_SCHEMA,responseSchemaName:'phimor_pharmacist_assistant',
      });
      const assistant=validateForContext(raw);
      const generatedAt=new Date().toISOString();
      await audit({resultStatus:'success',completedAt:generatedAt,outputCharacterCount:JSON.stringify(assistant).length});
      return Object.freeze({
        status:'available',generatedAt,contextTimestamp:context.contextTimestamp,
        contextVersion:context.schemaVersion,assistant,
      });
    } catch (error) {
      const errorCode=SAFE_PROVIDER_ERRORS.has(error?.code)?error.code:AI_ERROR_CODES.AI_PROVIDER_ERROR;
      logAIValidationFailure(diagnosticLogger, {
        event:'pharmacist_assistant_contract_rejected', task:'pharmacist_assistance', error,
      });
      await audit({resultStatus:'error',errorCode,completedAt:new Date().toISOString()});
      return unavailable(errorCode);
    }
  };
}

const generatePharmacistAssistance=createPharmacistAssistantService();
module.exports={SAFE_PROVIDER_ERRORS,unavailable,createPharmacistAssistantService,generatePharmacistAssistance};
