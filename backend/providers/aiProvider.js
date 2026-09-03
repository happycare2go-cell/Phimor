// Compatibility facade for the existing document ingestion flow.
const { loadV2Config } = require('../config/v2Config');
const { createAIProvider } = require('./AIProviderFactory');
const { DOCUMENT_PROMPT, validateDocumentResult } = require('./documentAI');
const { LAB_DOCUMENT_PROMPT, validateLabExtractionResult } = require('./labDocumentAI');
const { DOCUMENT_RESPONSE_SCHEMA, LAB_DOCUMENT_RESPONSE_SCHEMA } = require('./aiResponseSchemas');

const mockQueue = [];
const labMockQueue = [];
let providerOverride = null;
let defaultProvider = null;

function getProvider() {
  if (providerOverride) return providerOverride;
  if (!defaultProvider) defaultProvider = createAIProvider({ config: loadV2Config() });
  return defaultProvider;
}

async function interpretDocument(imageBuffer, imageMimeType = 'image/jpeg') {
  if (process.env.NODE_ENV === 'test' && mockQueue.length > 0) return mockQueue.shift();
  const config = loadV2Config();
  return getProvider().generateStructured({
    task: 'document_interpretation',
    systemInstructions: DOCUMENT_PROMPT,
    context: null,
    input: { imageBuffer, imageMimeType },
    outputSchema: validateDocumentResult,
    responseSchema: DOCUMENT_RESPONSE_SCHEMA,
    responseSchemaName: 'phimor_document_interpretation',
    timeoutMs: config.ai.timeoutMs,
  });
}

async function interpretLabDocument(imageBuffer, imageMimeType = 'image/jpeg') {
  if (process.env.NODE_ENV === 'test' && labMockQueue.length > 0) {
    return validateLabExtractionResult(labMockQueue.shift());
  }
  const config = loadV2Config();
  return getProvider().generateStructured({
    task: 'lab_document_extraction',
    systemInstructions: LAB_DOCUMENT_PROMPT,
    context: null,
    input: { imageBuffer, imageMimeType },
    outputSchema: validateLabExtractionResult,
    responseSchema: LAB_DOCUMENT_RESPONSE_SCHEMA,
    responseSchemaName: 'phimor_lab_document_extraction',
    timeoutMs: config.ai.timeoutMs,
  });
}

const interpretLabResult = interpretLabDocument;
const queueMockResponse = (response) => { mockQueue.push(response); };
const queueLabMockResponse = (response) => { labMockQueue.push(response); };
const clearMockQueue = () => {
  mockQueue.splice(0, mockQueue.length);
  labMockQueue.splice(0, labMockQueue.length);
  providerOverride = null;
  defaultProvider = null;
};
const setProviderForTests = (provider) => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Provider override is test-only');
  providerOverride = provider;
};

module.exports = {
  interpretDocument, interpretLabDocument, interpretLabResult,
  queueMockResponse, queueLabMockResponse, clearMockQueue, setProviderForTests,
};
