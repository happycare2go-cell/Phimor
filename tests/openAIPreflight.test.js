const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PREFLIGHT_ALLOWED_DOMAINS, validateArguments, runOpenAIPreflight,
} = require('../backend/scripts/preflight-openai-v1');

function response(body) {
  return {
    ok:true, status:200, headers:{ get:() => 'req-preflight-safe' },
    async json() { return body; },
  };
}

test('OpenAI V1 preflight refuses all operator-supplied text', () => {
  assert.doesNotThrow(() => validateArguments([]));
  assert.throws(() => validateArguments(['patient details']), (error) => (
    error.code === 'PREFLIGHT_ARGUMENTS_NOT_ALLOWED'
  ));
});

test('OpenAI V1 preflight uses three synthetic model checks and one bounded allowlisted search', async () => {
  const requests = [];
  const output = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const web = Array.isArray(body.tools);
    return response({
      id:'resp-preflight-safe', status:'completed', model:body.model,
      output:[
        ...(web ? [{ type:'web_search_call', action:{ type:'search', sources:[{
          url:'https://www.fda.gov/drugs/example', title:'FDA general information',
        }] } }] : []),
        { type:'message', content:[{ type:'output_text', text:'{"status":"ok"}', annotations:[] }] },
      ],
      usage:{ input_tokens:5, output_tokens:2, total_tokens:7,
        output_tokens_details:{ reasoning_tokens:1 } },
    });
  };
  const results = await runOpenAIPreflight({
    env:{ OPENAI_API_KEY:'test-only-key' },
    createProvider:(options) => {
      const { OpenAIProvider } = require('../backend/providers/OpenAIProvider');
      return new OpenAIProvider({ ...options, fetchImpl });
    },
    write:(line) => output.push(line),
  });
  assert.deepEqual(requests.map((body) => body.model), [
    'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol',
  ]);
  assert.equal(requests.every((body) => body.store === false), true);
  assert.equal(requests.every((body) => body.text?.format?.strict === true), true);
  assert.equal(requests.filter((body) => body.tools).length, 1);
  const web = requests.find((body) => body.tools);
  assert.equal(web.max_tool_calls, 1);
  assert.deepEqual(web.tools[0].filters.allowed_domains, PREFLIGHT_ALLOWED_DOMAINS);
  assert.equal(results.length, 3);
  assert.deepEqual(results[2].sourceDomains, ['www.fda.gov']);
  assert.deepEqual(results[0].usage, {
    inputTokens:5, outputTokens:2, totalTokens:7, reasoningTokens:1,
  });
  const serialized = JSON.stringify({ requests, output });
  assert.doesNotMatch(serialized, /Care Profile|Resident ID|LINE identity|consultation transcript|test-only-key/);
});

test('OpenAI V1 preflight fails safely without a key and never prints a secret', async () => {
  await assert.rejects(runOpenAIPreflight({ env:{}, write:() => {} }), (error) => (
    error.code === 'OPENAI_API_KEY_MISSING'
  ));
});

test('OpenAI V1 preflight rejects a provider source outside its fixed domain boundary', async () => {
  let call = 0;
  await assert.rejects(runOpenAIPreflight({
    env:{ OPENAI_API_KEY:'test-only-key' }, write:() => {},
    createProvider:() => ({
      async generateStructured(options) {
        call += 1;
        options.onMetadata({
          usage:{ inputTokens:1, outputTokens:1, totalTokens:2, reasoningTokens:0 },
          webSearchCalls:call === 3 ? 1 : 0,
          sources:call === 3 ? [{ url:'https://untrusted.example/article' }] : [],
        });
        return { status:'ok' };
      },
    }),
  }), (error) => error.code === 'PREFLIGHT_SOURCE_DOMAIN_REJECTED');
});

test('OpenAI V1 preflight is isolated from PHI inputs, database and LINE modules', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'backend', 'scripts', 'preflight-openai-v1.js'), 'utf8');
  const backendPackage = JSON.parse(fs.readFileSync(path.join(root, 'backend', 'package.json'), 'utf8'));
  assert.equal(backendPackage.scripts['preflight:openai-v1'], 'node scripts/preflight-openai-v1.js');
  assert.doesNotMatch(source, /require\(['"]\.\.\/db|databaseQuery|CareProfiles|Residents|lineClient|sendMessage/);
  assert.match(source, /validateArguments\(process\.argv\.slice\(2\)\)/);
  assert.match(source, /store:false/);
  assert.match(source, /maxCalls:1/);
});
