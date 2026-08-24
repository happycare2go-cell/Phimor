// Compatibility facade for the existing document ingestion flow.
const { loadV2Config } = require('../config/v2Config');
const { createAIProvider } = require('./AIProviderFactory');
const { DOCUMENT_PROMPT, validateDocumentResult } = require('./documentAI');

const mockQueue = [];
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
    timeoutMs: config.ai.timeoutMs,
  });
}

// Lab interpretation remains intentionally outside Foundation 1C.
const interpretLabResult = async () => ({});
const queueMockResponse = (response) => { mockQueue.push(response); };
const clearMockQueue = () => {
  mockQueue.splice(0, mockQueue.length);
  providerOverride = null;
  defaultProvider = null;
};
const setProviderForTests = (provider) => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Provider override is test-only');
  providerOverride = provider;
};

module.exports = {
  interpretDocument, interpretLabResult, queueMockResponse, clearMockQueue, setProviderForTests,
};
