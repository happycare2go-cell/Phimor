process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../backend/db');
const { createPlatformRepository } = require('../backend/services/platformRepository');
const { createPlusPaymentRepository } = require('../backend/services/plusPaymentRepository');
const { createPlatformService } = require('../backend/services/platformService');
const { createMemoryPlatformRepository } = require('./helpers/platformMemoryRepository');

const repositoryRoot = path.resolve(__dirname, '..');

function transactionalMemory(repository) {
  return async (_key, action) => {
    const snapshot = structuredClone(repository.state);
    try {
      return await action();
    } catch (error) {
      for (const [key, rows] of Object.entries(snapshot)) {
        repository.state[key].splice(0, repository.state[key].length, ...rows);
      }
      throw error;
    }
  };
}

async function exactNameFixture() {
  db.resetAll();
  const repository = createMemoryPlatformRepository();
  let sequence = 0;
  const service = createPlatformService({
    repository,
    withTransaction: transactionalMemory(repository),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    randomBytes: (size) => Buffer.alloc(size, 7),
    now: () => new Date('2026-08-31T00:00:00.000Z'),
  });
  await db.Centers.insert({ center_id:'CTR-PILOT', name:'Pilot Center', status:'active' });
  const organization = await service.createOrganization({
    organizationCode:'pilot-org', displayName:'Pilot Organization', actorReference:'ADM-1',
  });
  await repository.linkCenter({
    organizationId:organization.organizationId, centerId:'CTR-PILOT', actorReference:'ADM-1',
  });
  const client = await service.createIntegrationClient({
    organizationId:organization.organizationId,
    clientCode:'hhs-pilot', displayName:'HHS Pilot', sourceSystem:'HHS',
    initialStatus:'suspended', actorReference:'ADM-1',
  });
  await service.addClientCenterScope({
    integrationClientId:client.integrationClientId, centerId:'CTR-PILOT', actorReference:'ADM-1',
  });
  await service.addClientEventScope({
    integrationClientId:client.integrationClientId,
    eventType:'care.daily_report.finalized', actorReference:'ADM-1',
  });
  await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  await service.setIdentityResolutionPolicy({
    integrationClientId:client.integrationClientId,
    policy:{
      identityResolutionMode:'exact_name_learning',
      unresolvedEventPolicy:'ignore',
      familyGroupRequirement:'required_before_ingest',
    },
    actorReference:'ADM-1',
  });
  return { repository, service, client };
}

test('Integration Client status SQL explicitly types every use of the shared status parameter', async () => {
  const calls = [];
  const repository = createPlatformRepository({
    queryFn: async (sql, params) => {
      calls.push({ sql, params });
      return { rows:[{
        integration_client_id:params[0], organization_id:'ORG-1', client_code:'hhs-pilot',
        display_name:'HHS Pilot', source_system:'HHS', status:params[1], revoked_at:null,
      }] };
    },
  });
  const result = await repository.updateIntegrationClientStatus('INT-1', 'active');
  assert.equal(result.status, 'active');
  assert.deepEqual(calls[0].params, ['INT-1', 'active']);
  assert.match(calls[0].sql, /status\s*=\s*\$2::varchar/);
  assert.match(calls[0].sql, /CASE\s+WHEN\s+\$2::varchar\s*=\s*'revoked'/);
  assert.doesNotMatch(calls[0].sql, /status\s*=\s*\$2\s*,/);
});

test('Plus payment transaction SQL uses the same explicit status type in assignment and CASE', async () => {
  const calls = [];
  const repository = createPlusPaymentRepository({
    queryFn: async (sql, params) => {
      calls.push({ sql, params });
      return { rows:[{ payment_transaction_id:params[0], processing_status:params[1] }] };
    },
  });
  const result = await repository.updatePaymentTransaction('PPT-1', { status:'processed' });
  assert.equal(result.processing_status, 'processed');
  assert.match(calls[0].sql, /processing_status\s*=\s*\$2::varchar/);
  assert.match(calls[0].sql, /CASE\s+WHEN\s+\$2::varchar\s+IN\s*\(/);
});

test('exact-name learning is activation-ready with zero external mappings', async () => {
  const { repository, service, client } = await exactNameFixture();
  const before = await service.inspectIntegrationClient(client.integrationClientId);
  assert.equal(before.status, 'suspended');
  assert.equal(before.readiness.configurationComplete, true);
  assert.equal(before.readiness.checks.externalCenterMapping, false);
  assert.equal(before.readiness.checks.externalResidentMapping, false);
  assert.equal(before.readiness.residentMappingRecommended, false);

  assert.equal((await service.setIntegrationClientStatus({
    integrationClientId:client.integrationClientId, status:'active', actorReference:'ADM-1',
  })).status, 'active');
  assert.equal((await service.setIntegrationClientStatus({
    integrationClientId:client.integrationClientId, status:'suspended', actorReference:'ADM-1',
  })).status, 'suspended');
  assert.equal(repository.state.auditEvents.filter((row) => row.event_type === 'integration.client_status_changed').length, 2);

  await service.revokeIntegrationClient({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  await assert.rejects(service.setIntegrationClientStatus({
    integrationClientId:client.integrationClientId, status:'active', actorReference:'ADM-1',
  }), { code:'REVOKED_CLIENT_TERMINAL' });
});

test('status and audit changes roll back together when the audit insert fails', async () => {
  const { repository, service, client } = await exactNameFixture();
  const originalInsertAuditEvent = repository.insertAuditEvent;
  const auditCount = repository.state.auditEvents.length;
  repository.insertAuditEvent = async (record) => {
    await originalInsertAuditEvent(record);
    throw Object.assign(new Error('simulated audit failure'), { code:'AUDIT_WRITE_FAILED' });
  };

  await assert.rejects(service.setIntegrationClientStatus({
    integrationClientId:client.integrationClientId, status:'active', actorReference:'ADM-1',
  }), { code:'AUDIT_WRITE_FAILED' });
  assert.equal((await repository.findIntegrationClient(client.integrationClientId)).status, 'suspended');
  assert.equal(repository.state.auditEvents.length, auditCount);
});

function runtimeSqlFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
    if (entry.name === 'migrations' || entry.name === 'scripts' || entry.name === 'node_modules') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeSqlFiles(fullPath));
    else if (entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

function untypedStatusAssignmentCandidates() {
  const candidates = [];
  for (const file of runtimeSqlFiles(path.join(repositoryRoot, 'backend'))) {
    const source = fs.readFileSync(file, 'utf8');
    const strings = source.matchAll(/(`(?:\\.|[^`])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/gs);
    for (const match of strings) {
      const sql = match[0].slice(1, -1);
      const set = sql.match(/\bUPDATE\b[\s\S]*?\bSET\b([\s\S]*?)\bWHERE\b/i)?.[1];
      if (!set) continue;
      for (const assignment of set.matchAll(/\b([a-z_][a-z0-9_]*)\s*=\s*\$(\d+)(?!\s*::)/gi)) {
        const [, column, parameter] = assignment;
        const reusedAgainstLiteral = new RegExp(`\\$${parameter}\\s*(?:=|IN\\s*\\()\\s*['\"]`, 'i').test(set);
        if (!reusedAgainstLiteral) continue;
        candidates.push({
          file:path.relative(repositoryRoot, file).replaceAll('\\', '/'), column, parameter:`$${parameter}`,
        });
      }
    }
  }
  return candidates;
}

test('runtime SQL guard rejects new untyped assignment/literal placeholder reuse', () => {
  // consultationLifecycle is the one explicitly deferred same-class finding in this workstream.
  // Pinning it here keeps the exception visible while making any new occurrence fail this guard.
  assert.deepEqual(untypedStatusAssignmentCandidates(), [
    { file:'backend/services/consultationRepository.js', column:'state', parameter:'$2' },
  ]);
});

test('PostgreSQL preflight prepares fixed statements in a read-only transaction without executing them', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'backend', 'scripts', 'preflight-postgres-parameter-types.js'), 'utf8');
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /PREPARE phimor_integration_client_status_type_check/);
  assert.match(source, /PREPARE phimor_plus_payment_status_type_check/);
  assert.match(source, /DEALLOCATE/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /\bEXECUTE\b|\bINSERT\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b/);
  assert.doesNotMatch(source, /console\.log\s*\(\s*process\.env\.DATABASE_URL/);
});
