const { OpenAIProvider } = require('../providers/OpenAIProvider');
const { loadV2Config } = require('../config/v2Config');
const {
  AI_ERROR_CODES, AI_VALIDATION_STAGES, AI_PROVIDER_FAILURE_KINDS,
  safeValidationStage, safeProviderFailureKind,
} = require('../providers/aiErrors');
const { PHARMACIST_ASSISTANT_RESPONSE_SCHEMA } = require('../providers/aiResponseSchemas');
const {
  PHARMACIST_ASSISTANT_INSTRUCTIONS, validatePharmacistAssistantResponse,
  assertGroundedPharmacistAssistant,
} = require('../providers/pharmacistAssistant');
const {
  RESEARCH_PLANNER_INSTRUCTIONS, WEB_EVIDENCE_INSTRUCTIONS, CLINICAL_SYNTHESIS_INSTRUCTIONS,
  RESEARCH_PLAN_SCHEMA, WEB_EVIDENCE_SCHEMA, CLINICAL_SYNTHESIS_SCHEMA,
  validateResearchPlan, validateWebEvidence, validateClinicalSynthesis,
  assertGroundedClinicalSynthesis,
} = require('../providers/pharmacistClinicalResearch');
const { buildEvidenceBundle } = require('../services/clinicalEvidenceService');

const PREFLIGHT_ALLOWED_DOMAINS = Object.freeze([
  'who.int', 'fda.gov', 'dailymed.nlm.nih.gov',
]);
const PREFLIGHT_MAX_WEB_SEARCH_CALLS = 4;
const SYNTHETIC_ASSISTANT_CONTEXT = Object.freeze({
  schemaVersion:'synthetic-pharmacist-contract-v1',
  contextTimestamp:'2026-01-01T00:00:00.000Z',
  recordedFacts:Object.freeze([]),
  currentMedications:Object.freeze([
    Object.freeze({
      name:'amlodipine', strength:'5 mg', dose:'1', unit:'tablet',
      frequency:'once daily', instruction:'take one tablet once daily',
      source:Object.freeze({ category:'medication_snapshot' }),
    }),
    Object.freeze({
      name:'simvastatin', strength:'20 mg', dose:'1', unit:'tablet',
      frequency:'once daily', instruction:'take one tablet once daily',
      source:Object.freeze({ category:'medication_snapshot' }),
    }),
  ]),
  medicationChanges:null,
  appointments:Object.freeze([]),
  conversation:Object.freeze({
    initialQuestion:Object.freeze({ value:'Please help the pharmacist review the recorded medication context.' }),
    messages:Object.freeze([]),
  }),
  missingInformation:Object.freeze(['No symptoms or laboratory results are supplied in this synthetic check.']),
});
const SYNTHETIC_RESEARCH_CONTEXT = Object.freeze({
  contextType:'synthetic_deidentified_contract_preflight',
  contextVersion:'synthetic-pharmacist-research-contract-v1',
  contextTimestamp:'2026-01-01T00:00:00.000Z',
  triage:Object.freeze({ action:'pharmacist_consultation_eligible', category:'drug_interaction', reasonCode:null }),
  deidentifiedCaseSummary:'An older adult in a broad age band uses amlodipine and simvastatin. Review general co-administration considerations using authoritative sources.',
  conversation:Object.freeze({
    initialQuestion:'Review general co-administration considerations.', messages:Object.freeze([]),
    conversationTruncated:false, analyzedMessageCount:1, totalMessageCount:1, analyzedThroughSequence:0,
  }),
  recordedFacts:Object.freeze([]),
  currentMedications:Object.freeze([
    Object.freeze({ name:'amlodipine', source:'medication_snapshot' }),
    Object.freeze({ name:'simvastatin', source:'medication_snapshot' }),
  ]),
  medicationChanges:Object.freeze([]), vitalFacts:Object.freeze([]),
  confirmedLabs:Object.freeze([]), appointments:Object.freeze([]),
  missingInformation:Object.freeze(['No patient-specific symptoms, laboratory results, or dose changes are supplied.']),
});

function validateArguments(args = []) {
  if (args.length !== 0) {
    const error = new Error('Pharmacist AI contract preflight accepts no operator input');
    error.code = 'PREFLIGHT_ARGUMENTS_NOT_ALLOWED';
    throw error;
  }
}

function safeUsage(metadata) {
  const usage = metadata?.usage || {};
  return Object.freeze(Object.fromEntries([
    'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens',
  ].map((field) => [field, Number.isSafeInteger(usage[field]) && usage[field] >= 0 ? usage[field] : null])));
}

function sourceDomains(metadata) {
  const domains = [];
  for (const source of metadata?.sources || []) {
    try {
      const hostname = new URL(source.url).hostname.toLowerCase();
      if (PREFLIGHT_ALLOWED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
        domains.push(hostname);
      }
    } catch (_) { /* ignore malformed provider metadata */ }
  }
  return Object.freeze([...new Set(domains)].sort());
}

function evidenceMismatchCode(rawEvidence, metadata) {
  const citations = (rawEvidence?.findings || []).flatMap((finding) => finding.citationUrls || []);
  if (!citations.length) return 'PREFLIGHT_WEB_EVIDENCE_CITATIONS_EMPTY';
  const providerHosts = new Set(sourceDomains(metadata).map((host) => host.replace(/^www\./, '')));
  const hasProviderHost = citations.some((value) => {
    try { return providerHosts.has(new URL(value).hostname.toLowerCase().replace(/^www\./, '')); }
    catch (_) { return false; }
  });
  return hasProviderHost
    ? 'PREFLIGHT_WEB_EVIDENCE_PATH_NOT_VERIFIED'
    : 'PREFLIGHT_WEB_EVIDENCE_DOMAIN_NOT_VERIFIED';
}

function safeResult(capability, model, metadata, extra = {}) {
  return Object.freeze({
    capability, status:'PASS', model,
    usage:safeUsage(metadata), webSearchCalls:Number.isSafeInteger(metadata?.webSearchCalls) ? metadata.webSearchCalls : 0,
    sourceDomains:sourceDomains(metadata), ...extra,
  });
}

function safeFailure(capability, model, error) {
  const metadata = error?.safeMetadata;
  const validationStage = safeValidationStage(error?.validationStage);
  const providerFailureKind = safeProviderFailureKind(error?.providerFailureKind);
  const providerDiagnosticCodes = Object.freeze({
    [AI_PROVIDER_FAILURE_KINDS.SCHEMA_REJECTED]:'PREFLIGHT_PROVIDER_SCHEMA_REJECTED',
    [AI_PROVIDER_FAILURE_KINDS.HTTP_JSON_INVALID]:'PREFLIGHT_PROVIDER_HTTP_JSON_INVALID',
    [AI_PROVIDER_FAILURE_KINDS.RESPONSE_INCOMPLETE]:'PREFLIGHT_PROVIDER_RESPONSE_INCOMPLETE',
    [AI_PROVIDER_FAILURE_KINDS.REFUSAL]:'PREFLIGHT_PROVIDER_REFUSAL',
    [AI_PROVIDER_FAILURE_KINDS.STRUCTURED_OUTPUT_MISSING]:'PREFLIGHT_STRUCTURED_OUTPUT_MISSING',
    [AI_PROVIDER_FAILURE_KINDS.STRUCTURED_OUTPUT_INVALID_JSON]:'PREFLIGHT_STRUCTURED_OUTPUT_INVALID_JSON',
  });
  const diagnosticCode = providerDiagnosticCodes[providerFailureKind]
    || (error?.code === AI_ERROR_CODES.AI_INVALID_RESPONSE
      && validationStage === AI_VALIDATION_STAGES.PROVIDER_SCHEMA_OR_PARSE
      && error?.status === 400
      ? 'PREFLIGHT_PROVIDER_SCHEMA_REJECTED'
      : error?.code);
  return Object.freeze({
    capability, status:'FAIL', model,
    errorCode:/^[A-Z0-9_]{2,64}$/.test(String(diagnosticCode || ''))
      ? diagnosticCode : 'PHARMACIST_AI_CONTRACT_PREFLIGHT_FAILED',
    validationStage,
    webSearchCalls:Number.isSafeInteger(metadata?.webSearchCalls) ? metadata.webSearchCalls : 0,
    sourceDomains:sourceDomains(metadata),
  });
}

async function runPharmacistAIContractPreflight({
  env = process.env,
  createProvider = (options) => new OpenAIProvider(options),
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('OpenAI API key is not configured');
    error.code = 'OPENAI_API_KEY_MISSING';
    throw error;
  }
  const config = loadV2Config(env);
  const assistantModel = config.ai.pharmacistModel;
  const researchModel = config.ai.clinicalResearchModel;
  const assistantProvider = createProvider({
    apiKey, model:assistantModel, reasoningEffort:config.ai.pharmacistReasoningEffort,
    timeoutMs:config.ai.pharmacistTimeoutMs, maxRetries:config.ai.maxRetries,
    fetchImpl:global.fetch, logger:() => {},
  });
  const researchProvider = createProvider({
    apiKey, model:researchModel, reasoningEffort:config.ai.clinicalResearchReasoningEffort,
    timeoutMs:config.ai.clinicalResearchTimeoutMs, maxRetries:config.ai.maxRetries,
    fetchImpl:global.fetch, logger:() => {},
  });
  const results = [];
  const run = async (capability, model, operation) => {
    try {
      const value = await operation();
      const result = safeResult(capability, model, value.metadata, value.extra);
      results.push(result); write(JSON.stringify(result));
      return value.result;
    } catch (error) {
      const failure = safeFailure(capability, model, error);
      results.push(failure); write(JSON.stringify(failure));
      throw error;
    }
  };

  const assistantContext = JSON.stringify(SYNTHETIC_ASSISTANT_CONTEXT);
  await run('terra_pharmacist_assistant_contract', assistantModel, async () => {
    let metadata = null;
    const result = await assistantProvider.generateStructured({
      task:'pharmacist_assistance', systemInstructions:PHARMACIST_ASSISTANT_INSTRUCTIONS,
      context:assistantContext,
      input:{ text:'Prepare a concise Thai-language private draft for pharmacist review using only this synthetic context.' },
      responseSchema:PHARMACIST_ASSISTANT_RESPONSE_SCHEMA,
      responseSchemaName:'phimor_pharmacist_assistant',
      outputSchema:(value) => assertGroundedPharmacistAssistant(
        validatePharmacistAssistantResponse(value), SYNTHETIC_ASSISTANT_CONTEXT,
      ),
      onMetadata:(value) => { metadata = value; },
    });
    return { result, metadata };
  });

  const researchContext = JSON.stringify(SYNTHETIC_RESEARCH_CONTEXT);
  const plan = await run('sol_research_plan_contract', researchModel, async () => {
    let metadata = null;
    const result = await researchProvider.generateStructured({
      task:'pharmacist_clinical_research_plan', systemInstructions:RESEARCH_PLANNER_INSTRUCTIONS,
      context:researchContext,
      input:{ text:'Create a de-identified plan for this synthetic general medication question.' },
      responseSchema:RESEARCH_PLAN_SCHEMA, responseSchemaName:'phimor_clinical_research_plan',
      outputSchema:validateResearchPlan, onMetadata:(value) => { metadata = value; },
    });
    return { result, metadata };
  });

  let evidenceMetadata = null;
  const evidence = await run('sol_web_evidence_contract', researchModel, async () => {
    const rawEvidence = await researchProvider.generateStructured({
      task:'pharmacist_clinical_web_evidence', systemInstructions:WEB_EVIDENCE_INSTRUCTIONS,
      context:null, input:{ text:JSON.stringify({ researchTopics:plan.researchTopics.slice(0, 1) }) },
      responseSchema:WEB_EVIDENCE_SCHEMA, responseSchemaName:'phimor_clinical_web_evidence',
      outputSchema:validateWebEvidence,
      webSearch:{
        allowedDomains:PREFLIGHT_ALLOWED_DOMAINS,
        maxCalls:PREFLIGHT_MAX_WEB_SEARCH_CALLS,
        country:'TH', required:true,
      },
      onMetadata:(value) => { evidenceMetadata = value; },
    });
    const normalized = buildEvidenceBundle(rawEvidence, evidenceMetadata, {
      allowedDomains:PREFLIGHT_ALLOWED_DOMAINS, accessedAt:new Date('2026-01-01T00:00:00.000Z'), maxSources:8,
    });
    if (!Number.isSafeInteger(evidenceMetadata?.webSearchCalls)
        || evidenceMetadata.webSearchCalls < 1
        || evidenceMetadata.webSearchCalls > PREFLIGHT_MAX_WEB_SEARCH_CALLS) {
      const error = new Error('Expected bounded web search call was not observed');
      error.code = 'PREFLIGHT_WEB_SEARCH_CALL_COUNT_INVALID';
      error.safeMetadata = evidenceMetadata;
      throw error;
    }
    if (normalized.sources.length === 0) {
      const error = new Error('Verified evidence source was not returned');
      error.code = evidenceMismatchCode(rawEvidence, evidenceMetadata);
      error.safeMetadata = evidenceMetadata;
      throw error;
    }
    return { result:normalized, metadata:evidenceMetadata, extra:{ acceptedSourceCount:normalized.sources.length } };
  });

  const allowedEvidenceRefs = evidence.sources.map((source) => source.referenceId);
  await run('sol_clinical_synthesis_contract', researchModel, async () => {
    let metadata = null;
    const result = await researchProvider.generateStructured({
      task:'pharmacist_clinical_research_synthesis', systemInstructions:CLINICAL_SYNTHESIS_INSTRUCTIONS,
      context:JSON.stringify({
        privateClinicalContext:SYNTHETIC_RESEARCH_CONTEXT,
        researchPlan:{
          clinicalQuestions:plan.clinicalQuestions,
          missingInformation:plan.missingInformation,
          urgentSafetyFlags:plan.urgentSafetyFlags,
        },
        validatedEvidence:evidence.findings, evidenceSources:evidence.sources,
        researchLimitations:evidence.limitations,
      }),
      input:{ text:'Prepare a concise Thai-language private analysis and editable draft for pharmacist review. Do not send anything.' },
      responseSchema:CLINICAL_SYNTHESIS_SCHEMA,
      responseSchemaName:'phimor_clinical_research_synthesis',
      outputSchema:(value) => assertGroundedClinicalSynthesis(
        validateClinicalSynthesis(value, { allowedEvidenceRefs }), SYNTHETIC_RESEARCH_CONTEXT,
      ),
      onMetadata:(value) => { metadata = value; },
    });
    return { result, metadata, extra:{ acceptedEvidenceReferenceCount:allowedEvidenceRefs.length } };
  });

  return Object.freeze(results);
}

async function main() {
  validateArguments(process.argv.slice(2));
  await runPharmacistAIContractPreflight();
}

if (require.main === module) {
  main().catch((error) => {
    const errorCode = /^[A-Z0-9_]{2,64}$/.test(String(error?.code || ''))
      ? error.code : 'PHARMACIST_AI_CONTRACT_PREFLIGHT_FAILED';
    process.stderr.write(`${JSON.stringify({ status:'FAIL', errorCode, validationStage:safeValidationStage(error?.validationStage) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PREFLIGHT_ALLOWED_DOMAINS, PREFLIGHT_MAX_WEB_SEARCH_CALLS,
  SYNTHETIC_ASSISTANT_CONTEXT, SYNTHETIC_RESEARCH_CONTEXT,
  validateArguments, safeUsage, sourceDomains, evidenceMismatchCode, safeResult, safeFailure,
  runPharmacistAIContractPreflight,
};
