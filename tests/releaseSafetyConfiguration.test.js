const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('production configuration declares realtime secrets/origins without embedding a secret value', () => {
  const example = read('backend/.env.example');
  const render = read('render.yaml');
  assert.match(example, /^CONSULTATION_REALTIME_TICKET_SECRET=$/m);
  assert.match(example, /^CONSULTATION_REALTIME_ALLOWED_ORIGINS=https:\/\/phimor-liff\.onrender\.com$/m);
  assert.match(render, /key:\s*CONSULTATION_REALTIME_TICKET_SECRET\s*\r?\n\s*sync:\s*false/);
  assert.doesNotMatch(render, /key:\s*CONSULTATION_REALTIME_TICKET_SECRET\s*\r?\n\s*value:/);
});

test('legacy startup DDL inventory is complete and not claimed by numbered migrations', () => {
  const dbSource = read('backend/db.js');
  const deployment = read('docs/DEPLOY_RENDER.md');
  const tableNames = [...dbSource.matchAll(/makeTable\('([^']+)'\)/g)].map((match) => match[1]);
  assert.equal(tableNames.length, 27);
  for (const tableName of tableNames) assert.match(deployment, new RegExp(`\\b${tableName}\\b`));
  const migrationDir = path.join(root, 'backend', 'migrations');
  const migrationSource = fs.readdirSync(migrationDir)
    .filter((file) => /^\d{4}_.+\.js$/.test(file))
    .map((file) => fs.readFileSync(path.join(migrationDir, file), 'utf8'))
    .join('\n');
  for (const tableName of tableNames) {
    assert.doesNotMatch(migrationSource, new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+["']?${tableName}["']?\\s*\\(`, 'i'));
  }
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS/);
  assert.match(dbSource, /CREATE INDEX IF NOT EXISTS/);
  assert.match(deployment, /Remaining risk:[\s\S]*startup can mutate those legacy objects/);
});

test('deployment documentation requires migrations before backend and runtime LIFF configuration', () => {
  const deployment = read('docs/DEPLOY_RENDER.md');
  const migrationStep = deployment.indexOf('`render.yaml` runs `npm run migrate` as `preDeployCommand`');
  const backendActivation = deployment.indexOf('new backend starts');
  assert.ok(migrationStep >= 0 && backendActivation > migrationStep);
  assert.match(deployment, /Never\s+edit a production LIFF ID into HTML\/JavaScript source/);
  assert.doesNotMatch(deployment, /ย้ายจาก In-memory Database ไป Google Sheets|Verify LINE Signature ที่ตอนนี้ยังไม่ได้ทำ/);
});

test('production backend applies reviewed migrations before activating a new release', () => {
  const render = read('render.yaml');
  const backend = render.split(/\n\s*- type: web\s*\n\s*name: phimor-liff/)[0];
  assert.match(backend, /rootDir:\s*backend/);
  assert.match(backend, /buildCommand:\s*npm ci --omit=dev/);
  assert.match(backend, /preDeployCommand:\s*npm run migrate/);
  assert.match(backend, /startCommand:\s*npm start/);
  assert.match(backend, /healthCheckPath:\s*\/ready/);
  const packageJson = JSON.parse(read('backend/package.json'));
  assert.equal(packageJson.scripts.migrate, 'node scripts/migrate.js');
  assert.equal(packageJson.scripts['preflight:openai-v1'], 'node scripts/preflight-openai-v1.js');
});

test('pilot governance covers every required domain without inventing a retention period', () => {
  const governance = read('docs/PILOT_DATA_GOVERNANCE.md');
  for (const domain of [
    'Integration inbox', 'Notification outbox', 'Vital Signs / Daily Care', 'Lab',
    'Doctor Visit', 'Consultation transcript', 'Care Profile audit/history',
  ]) assert.match(governance, new RegExp(domain.replace('/', '\\/')));
  assert.match(governance, /POLICY DECISION REQUIRED/g);
  assert.match(governance, /DSR intake owner/);
  assert.match(governance, /Identity verifier/);
  assert.match(governance, /Technical executor/);
  assert.match(governance, /Completion recorder/);
  assert.doesNotMatch(governance, /retain(?:ed)? for \d+ (?:days|months|years)/i);
});
