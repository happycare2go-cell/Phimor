const { OpenAIProvider } = require('../providers/OpenAIProvider');
const { OPENAI_MODEL_DEFAULTS, parseInteger } = require('../config/v2Config');

const PREFLIGHT_ALLOWED_DOMAINS = Object.freeze([
  'who.int', 'fda.gov', 'dailymed.nlm.nih.gov',
]);
const PREFLIGHT_SCHEMA = Object.freeze({
  type:'object', additionalProperties:false, required:['status'],
  properties:{ status:{ type:'string', enum:['ok'] } },
});

function validateArguments(args = []) {
  if (args.length !== 0) {
    const error = new Error('OpenAI preflight does not accept patient or free-text input');
    error.code = 'PREFLIGHT_ARGUMENTS_NOT_ALLOWED';
    throw error;
  }
}

function validateStatus(value) {
  if (!value || Object.keys(value).length !== 1 || value.status !== 'ok') {
    const error = new Error('Synthetic preflight response was invalid');
    error.code = 'PREFLIGHT_INVALID_RESPONSE';
    throw error;
  }
  return Object.freeze({ status:'ok' });
}

function allowedHost(hostname, allowedDomains = PREFLIGHT_ALLOWED_DOMAINS) {
  const host = String(hostname || '').toLowerCase();
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function safeUsage(metadata) {
  const usage = metadata?.usage || {};
  return Object.freeze(Object.fromEntries([
    'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens',
  ].map((key) => [key, Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null])));
}

function preflightChecks(env = process.env) {
  return Object.freeze([
    Object.freeze({
      capability:'responses_structured_luna',
      model:String(env.AI_MODEL_DOCUMENT || OPENAI_MODEL_DEFAULTS.document).trim(),
      input:'Return the synthetic status object for a general API capability check.',
      webSearch:false,
    }),
    Object.freeze({
      capability:'responses_structured_terra',
      model:String(env.AI_MODEL_EXPLANATION || OPENAI_MODEL_DEFAULTS.explanation).trim(),
      input:'Return the synthetic status object for a general API capability check.',
      webSearch:false,
    }),
    Object.freeze({
      capability:'responses_web_search_sol',
      model:String(env.AI_MODEL_CLINICAL_RESEARCH || OPENAI_MODEL_DEFAULTS.clinicalResearch).trim(),
      input:'Use one web search for official general information about amoxicillin from authoritative drug or public-health sources, then return only the synthetic status object.',
      webSearch:true,
    }),
  ]);
}

async function runOpenAIPreflight({
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
  const timeoutMs = parseInteger(env.AI_TIMEOUT_MS, 30000, { min:5000, max:120000 });
  const results = [];
  for (const check of preflightChecks(env)) {
    let metadata = null;
    const provider = createProvider({
      apiKey, model:check.model, reasoningEffort:'low', timeoutMs,
      maxRetries:0, fetchImpl:global.fetch,
    });
    await provider.generateStructured({
      task:check.capability,
      systemInstructions:'This is a non-patient, synthetic API commissioning check. Follow the bounded request and return only the required JSON object.',
      input:{ text:check.input }, context:null,
      outputSchema:validateStatus, responseSchema:PREFLIGHT_SCHEMA,
      responseSchemaName:'phimor_openai_v1_preflight',
      ...(check.webSearch ? {
        webSearch:{ allowedDomains:PREFLIGHT_ALLOWED_DOMAINS, maxCalls:1, country:'TH' },
      } : {}),
      onMetadata:(value) => { metadata = value; },
    });
    const sourceDomains = [];
    for (const source of metadata?.sources || []) {
      const url = new URL(source.url);
      if (!allowedHost(url.hostname)) {
        const error = new Error('Preflight source was outside the approved domain boundary');
        error.code = 'PREFLIGHT_SOURCE_DOMAIN_REJECTED';
        throw error;
      }
      sourceDomains.push(url.hostname.toLowerCase());
    }
    if (check.webSearch && (metadata?.webSearchCalls !== 1 || sourceDomains.length === 0)) {
      const error = new Error('Bounded web search capability was not confirmed');
      error.code = 'PREFLIGHT_WEB_SEARCH_NOT_CONFIRMED';
      throw error;
    }
    const result = Object.freeze({
      capability:check.capability, status:'PASS', model:check.model,
      request:Object.freeze({ responsesApi:true, store:false, strictJsonSchema:true,
        webSearchMaxCalls:check.webSearch ? 1 : 0 }),
      usage:safeUsage(metadata),
      sourceDomains:Object.freeze([...new Set(sourceDomains)].sort()),
    });
    results.push(result);
    write(JSON.stringify(result));
  }
  return Object.freeze(results);
}

async function main() {
  validateArguments(process.argv.slice(2));
  await runOpenAIPreflight();
}

if (require.main === module) {
  main().catch((error) => {
    const errorCode = /^[A-Z0-9_]{2,64}$/.test(String(error?.code || ''))
      ? error.code : 'OPENAI_PREFLIGHT_FAILED';
    process.stderr.write(`${JSON.stringify({ status:'FAIL', errorCode })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PREFLIGHT_ALLOWED_DOMAINS, PREFLIGHT_SCHEMA, validateArguments, validateStatus,
  allowedHost, safeUsage, preflightChecks, runOpenAIPreflight,
};
