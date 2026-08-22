// Cross-platform test entry point. Force safe test doubles before the app loads.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const suite = process.argv[2] || 'all';
const testsDir = path.resolve(__dirname, '..', '..', 'tests');
const targets = {
  all: [path.join(testsDir, '*.test.js')],
  journey: [path.join(testsDir, 'realUserJourneys.test.js')],
  ui: [path.join(testsDir, 'liffUiContracts.test.js'), path.join(testsDir, 'routeOrderSafety.test.js')],
};

if (!targets[suite]) {
  console.error(`Unknown test suite: ${suite}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--test', ...targets[suite]], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    ALLOW_INSECURE_LINE_HEADER: 'true',
    ADMIN_API_KEY: process.env.TEST_ADMIN_API_KEY || 'test-admin-key',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
    LINE_CHANNEL_SECRET: 'test-line-secret',
    LINE_LOGIN_CHANNEL_ID: 'test-line-login-channel',
  },
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
