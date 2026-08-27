process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../backend/db');
const { createPlatformService } = require('../backend/services/platformService');
const { createTenantResolver } = require('../backend/services/tenantResolver');
const { createMemoryPlatformRepository } = require('./helpers/platformMemoryRepository');

function fixture() {
  db.resetAll();
  const repository = createMemoryPlatformRepository();
  let sequence = 0;
  let randomSequence = 1;
  const service = createPlatformService({
    repository,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    randomBytes: (size) => Buffer.alloc(size, (randomSequence++ % 250) + 1),
    withTransaction: async (_key, fn) => fn(),
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  });
  return { service, repository };
}

async function addCenter(centerId, name = centerId) {
  return db.Centers.insert({ center_id:centerId, name, status:'active' });
}

async function setupTwoTenants() {
  const f = fixture();
  await addCenter('CTR-A'); await addCenter('CTR-B');
  const orgA = await f.service.createOrganization({ organizationCode:'org-a', displayName:'Org A', actorReference:'ADM-1' });
  const orgB = await f.service.createOrganization({ organizationCode:'org-b', displayName:'Org B', actorReference:'ADM-1' });
  await f.repository.linkCenter({ organizationId:orgA.organizationId, centerId:'CTR-A', actorReference:'ADM-1' });
  await f.repository.linkCenter({ organizationId:orgB.organizationId, centerId:'CTR-B', actorReference:'ADM-1' });
  return { ...f, orgA, orgB };
}

test('Center resolves one Organization and duplicate active relationship is refused', async () => {
  const { service, repository, orgA, orgB } = await setupTwoTenants();
  assert.equal((await service.getOrganizationForCenter('CTR-A')).organizationId, orgA.organizationId);
  assert.equal(await repository.linkCenter({ organizationId:orgB.organizationId, centerId:'CTR-A', actorReference:'ADM-1' }), null);
  assert.equal((await service.getOrganizationForCenter('CTR-A')).organizationId, orgA.organizationId);
});

test('new Center receives an isolated Organization without name-based merging', async () => {
  const { service, repository } = fixture();
  await addCenter('CTR-1', 'Same Name'); await addCenter('CTR-2', 'Same Name');
  const one = await service.ensureOrganizationForCenter({ centerId:'CTR-1', displayName:'Same Name' });
  const two = await service.ensureOrganizationForCenter({ centerId:'CTR-2', displayName:'Same Name' });
  assert.notEqual(one.organizationId, two.organizationId);
  assert.equal(repository.state.organizationCenters.length, 2);
});

test('missing capability is false and System Admin state is scoped per Center', async () => {
  const { service, repository } = await setupTwoTenants();
  assert.equal(await service.isCenterCapabilityEnabled('CTR-A', 'vital_signs_v1'), false);
  await service.setCenterCapability({ centerId:'CTR-A', capabilityKey:'vital_signs_v1', enabled:true, actorReference:'ADM-1' });
  assert.equal(await service.isCenterCapabilityEnabled('CTR-A', 'vital_signs_v1'), true);
  assert.equal(await service.isCenterCapabilityEnabled('CTR-B', 'vital_signs_v1'), false);
  await service.setCenterCapability({ centerId:'CTR-A', capabilityKey:'vital_signs_v1', enabled:false, actorReference:'ADM-1' });
  assert.equal(await service.isCenterCapabilityEnabled('CTR-A', 'vital_signs_v1'), false);
  assert.equal(repository.state.auditEvents.filter((row)=>row.event_type==='center.capability_changed').length, 2);
});

test('unknown capability and non-boolean state fail closed', async () => {
  const { service } = await setupTwoTenants();
  await assert.rejects(service.setCenterCapability({ centerId:'CTR-A', capabilityKey:'hhs_special', enabled:true, actorReference:'ADM-1' }), { code:'UNKNOWN_CAPABILITY' });
  await assert.rejects(service.setCenterCapability({ centerId:'CTR-A', capabilityKey:'daily_care_v1', enabled:'true', actorReference:'ADM-1' }), { code:'INVALID_CAPABILITY_STATE' });
});

test('Integration Client is bound to one external Organization and source identity is server-owned', async () => {
  const { service, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a_trusted', actorReference:'ADM-1' });
  assert.equal(client.organizationId, orgA.organizationId);
  assert.equal(client.sourceSystem, 'vendor_a_trusted');
  assert.equal(client.status, 'active');
});

test('platform_internal Organization cannot become an external integration tenant', async () => {
  const { service } = fixture();
  const internal = await service.createOrganization({ organizationCode:'phimor-internal', displayName:'PHIMOR', organizationType:'platform_internal', actorReference:'ADM-1' });
  await assert.rejects(service.createIntegrationClient({ organizationId:internal.organizationId, clientCode:'bad', displayName:'Bad', sourceSystem:'spoof', actorReference:'ADM-1' }), { code:'INTERNAL_ORGANIZATION_NOT_EXTERNAL_CLIENT' });
});

test('credential is hashed, shown once, authenticates timing-safely, and inspect never returns secret', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  const issued = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  assert.match(issued.token, /^pim_int_[a-f0-9]{16}\./);
  assert.equal(repository.state.credentials[0].secret_hash instanceof Buffer, true);
  assert.equal(repository.state.credentials[0].secret_salt instanceof Buffer, true);
  assert.doesNotMatch(JSON.stringify(repository.state.credentials), new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const identity = await service.authenticateCredential(issued.token);
  assert.equal(identity.organizationId, orgA.organizationId);
  assert.equal(identity.sourceSystem, 'vendor_a');
  assert.doesNotMatch(JSON.stringify(await service.inspectIntegrationClient(client.integrationClientId)), /pim_int_|secret_hash|secret_salt/i);
  await assert.rejects(service.authenticateCredential(issued.token.slice(0, -2) + 'xx'), { code:'INVALID_INTEGRATION_TOKEN' });
  await assert.rejects(service.authenticateCredential('malformed-token'), { code:'INVALID_INTEGRATION_TOKEN' });
});

test('credential rotation revokes old credential and replacement remains valid', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  const first = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  const replacement = await service.rotateCredential({ integrationClientId:client.integrationClientId, credentialId:first.credential.credentialId, actorReference:'ADM-1' });
  await assert.rejects(service.authenticateCredential(first.token), { code:'INTEGRATION_CREDENTIAL_REVOKED' });
  assert.equal((await service.authenticateCredential(replacement.token)).integrationClientId, client.integrationClientId);
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.credential_rotated'));
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.credential_rotation_completed'));
});

test('credential rotation supports bounded overlap and prevents unlimited active keys', async () => {
  const { service, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  const first = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  const replacement = await service.rotateCredential({ integrationClientId:client.integrationClientId, credentialId:first.credential.credentialId, overlapSeconds:300, actorReference:'ADM-1' });
  assert.equal((await service.authenticateCredential(first.token)).integrationClientId, client.integrationClientId);
  assert.equal((await service.authenticateCredential(replacement.token)).integrationClientId, client.integrationClientId);
  await assert.rejects(service.rotateCredential({ integrationClientId:client.integrationClientId, credentialId:replacement.credential.credentialId, actorReference:'ADM-1' }), { code:'CREDENTIAL_ROTATION_IN_PROGRESS' });
});

test('revoked client and credential are rejected immediately', async () => {
  const { service, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  const issued = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  await service.revokeCredential({ integrationClientId:client.integrationClientId, credentialId:issued.credential.credentialId, actorReference:'ADM-1' });
  await assert.rejects(service.authenticateCredential(issued.token), { code:'INTEGRATION_CREDENTIAL_REVOKED' });
  await assert.rejects(service.rotateCredential({ integrationClientId:client.integrationClientId, credentialId:issued.credential.credentialId, actorReference:'ADM-1' }), { code:'ACTIVE_CREDENTIAL_NOT_FOUND' });
  const inspected = await service.inspectIntegrationClient(client.integrationClientId);
  assert.equal(inspected.credentials[0].status, 'revoked');
  assert.equal(inspected.credentials[0].credentialId, issued.credential.credentialId);
});

test('revoking Integration Client revokes its active credential immediately', async () => {
  const { service, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  const issued = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  await service.revokeIntegrationClient({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  await assert.rejects(service.authenticateCredential(issued.token), { code:'INTEGRATION_CREDENTIAL_REVOKED' });
});

test('Center and event scopes deny ungranted and cross-Organization targets', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  assert.equal(await repository.hasClientCenterScope(client.integrationClientId, 'CTR-A'), true);
  await assert.rejects(service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-B', actorReference:'ADM-1' }), { code:'CROSS_TENANT_CENTER' });
  await service.addClientEventScope({ integrationClientId:client.integrationClientId, eventType:'care.vitals.recorded', actorReference:'ADM-1' });
  assert.equal(await repository.hasClientEventScope(client.integrationClientId, 'care.vitals.recorded'), true);
  assert.equal(await repository.hasClientEventScope(client.integrationClientId, 'care.daily_report.recorded'), false);
  await assert.rejects(service.addClientEventScope({ integrationClientId:client.integrationClientId, eventType:'care.unknown', actorReference:'ADM-1' }), { code:'UNKNOWN_EVENT_TYPE' });
});

test('tenant resolver requires both allowed Center and allowed event scopes', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'trusted_vendor', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  await service.addClientEventScope({ integrationClientId:client.integrationClientId, eventType:'care.vitals.recorded', actorReference:'ADM-1' });
  await service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', centerId:'CTR-A', actorReference:'ADM-1' });
  const credential = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  const resolver = createTenantResolver({ platformService:service, repository });
  const allowed = await resolver.authorizeIntegrationTarget({ token:credential.token, eventType:'care.vitals.recorded', externalCenterId:'EXT-C-A', sourceSystem:'spoofed' });
  assert.equal(allowed.sourceSystem, 'trusted_vendor');
  await repository.removeClientCenterScope(client.integrationClientId, 'CTR-A');
  await assert.rejects(resolver.authorizeIntegrationTarget({ token:credential.token, eventType:'care.vitals.recorded', externalCenterId:'EXT-C-A' }), { code:'CENTER_SCOPE_DENIED' });
  await repository.addClientCenterScope({ integrationClientId:client.integrationClientId, organizationId:orgA.organizationId, centerId:'CTR-A', actorReference:'ADM-1' });
  await repository.removeClientEventScope(client.integrationClientId, 'care.vitals.recorded');
  await assert.rejects(resolver.authorizeIntegrationTarget({ token:credential.token, eventType:'care.vitals.recorded', externalCenterId:'EXT-C-A' }), { code:'EVENT_SCOPE_DENIED' });
  await repository.addClientEventScope({ integrationClientId:client.integrationClientId, eventType:'care.vitals.recorded', actorReference:'ADM-1' });
  await db.Centers.update((row)=>row.center_id==='CTR-A', { status:'suspended' });
  await assert.rejects(resolver.authorizeIntegrationTarget({ token:credential.token, eventType:'care.vitals.recorded', externalCenterId:'EXT-C-A' }), { code:'CENTER_INACTIVE' });
});

test('exact external Center and Resident mapping cannot cross Organization or Center', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  await service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', centerId:'CTR-A', actorReference:'ADM-1' });
  await assert.rejects(service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', centerId:'CTR-B', actorReference:'ADM-1' }), { code:/CROSS_TENANT_CENTER_MAPPING|EXTERNAL_CENTER_MAPPING_CONFLICT/ });
  await db.Residents.insert({ resident_id:'R-A', center_id:'CTR-A', care_profile_id:'CP-A', status:'active' });
  await db.Residents.insert({ resident_id:'R-B', center_id:'CTR-B', care_profile_id:'CP-B', status:'active' });
  const mapped = await service.mapExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', externalResidentId:'EXT-R-A', residentId:'R-A', displayName:'Same Name', actorReference:'ADM-1' });
  assert.equal(mapped.resident_id, 'R-A');
  await db.Residents.insert({ resident_id:'R-A2', center_id:'CTR-A', care_profile_id:'CP-A2', status:'active' });
  await assert.rejects(service.mapExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', externalResidentId:'EXT-R-A', residentId:'R-A2', actorReference:'ADM-1' }), { code:'EXTERNAL_SUBJECT_MAPPING_CONFLICT' });
  await assert.rejects(service.mapExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', externalResidentId:'EXT-R-B', residentId:'R-B', actorReference:'ADM-1' }), { code:'RESIDENT_NOT_IN_MAPPED_CENTER' });
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.external_center_mapping_created'));
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.external_subject_mapping_created'));
});

test('duplicate external Center identity cannot be remapped to another Center in the same Organization', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  await addCenter('CTR-A2');
  await repository.linkCenter({ organizationId:orgA.organizationId, centerId:'CTR-A2', actorReference:'ADM-1' });
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A2', actorReference:'ADM-1' });
  await service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXACT-CENTER', centerId:'CTR-A', actorReference:'ADM-1' });
  await assert.rejects(service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXACT-CENTER', centerId:'CTR-A2', actorReference:'ADM-1' }), { code:'EXTERNAL_CENTER_MAPPING_CONFLICT' });
});

test('names are display metadata only and unknown subject remains pending_subject_mapping', async () => {
  const { service, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'vendor_a', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  await service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', centerId:'CTR-A', actorReference:'ADM-1' });
  await db.Residents.insert({ resident_id:'R-A', center_id:'CTR-A', full_name:'ชื่อเหมือนกัน', status:'active' });
  const pending = await service.mapExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', externalResidentId:'EXT-UNKNOWN', displayName:'ชื่อเหมือนกัน', actorReference:'ADM-1' });
  assert.equal(pending.mapping_status, 'pending_subject_mapping');
  assert.equal(pending.resident_id, null);
});

test('integration observation creates pending identity but never downgrades an exact mapped subject', async () => {
  const { service, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-observe', displayName:'Vendor', sourceSystem:'vendor', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  await service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C', centerId:'CTR-A', actorReference:'ADM-1' });
  const pending = await service.observeExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C', externalResidentId:'EXT-R', displayName:'ชื่อสำหรับช่วย map' });
  assert.equal(pending.mapping_status, 'pending_subject_mapping');
  await db.Residents.insert({ resident_id:'RES-A', center_id:'CTR-A', care_profile_id:'CP-A', status:'active' });
  await service.mapExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C', externalResidentId:'EXT-R', residentId:'RES-A', actorReference:'ADM-1' });
  const observedAgain = await service.observeExternalSubject({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C', externalResidentId:'EXT-R', room:'ใหม่' });
  assert.equal(observedAgain.mapping_status, 'mapped');
  assert.equal(observedAgain.resident_id, 'RES-A');
  assert.equal(observedAgain.care_profile_id, 'CP-A');
});

test('tenant resolver derives source and tenant from credential and permits pending subject mapping', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'trusted_vendor', actorReference:'ADM-1' });
  await service.addClientCenterScope({ integrationClientId:client.integrationClientId, centerId:'CTR-A', actorReference:'ADM-1' });
  await service.addClientEventScope({ integrationClientId:client.integrationClientId, eventType:'care.vitals.recorded', actorReference:'ADM-1' });
  await service.mapExternalCenter({ integrationClientId:client.integrationClientId, externalCenterId:'EXT-C-A', centerId:'CTR-A', actorReference:'ADM-1' });
  const credential = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  const resolver = createTenantResolver({ platformService:service, repository });
  const tenant = await resolver.authorizeIntegrationTarget({ token:credential.token, eventType:'care.vitals.recorded', externalCenterId:'EXT-C-A' });
  assert.deepEqual({ organizationId:tenant.organizationId, centerId:tenant.centerId, sourceSystem:tenant.sourceSystem }, { organizationId:orgA.organizationId, centerId:'CTR-A', sourceSystem:'trusted_vendor' });
  assert.equal((await resolver.resolveExternalSubject({ tenant, externalResidentId:'NEW-RESIDENT', display:{ displayName:'ช่วยมนุษย์ดูเท่านั้น' } })).status, 'pending_subject_mapping');
});

test('platform audit is metadata-only and excludes credentials and personal display data', async () => {
  const { service, repository, orgA } = await setupTwoTenants();
  const client = await service.createIntegrationClient({ organizationId:orgA.organizationId, clientCode:'vendor-a', displayName:'Vendor A', sourceSystem:'trusted_vendor', actorReference:'ADM-1' });
  const issued = await service.issueCredential({ integrationClientId:client.integrationClientId, actorReference:'ADM-1' });
  await service.revokeCredential({ integrationClientId:client.integrationClientId, credentialId:issued.credential.credentialId, actorReference:'ADM-1' });
  const serialized = JSON.stringify(repository.state.auditEvents);
  assert.doesNotMatch(serialized, new RegExp(issued.token.slice(-20)));
  assert.doesNotMatch(serialized, /secret|firstName|lastName|displayName|line_user_id/i);
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.credential_issued'));
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.credential_revoked'));
  assert.ok(repository.state.auditEvents.some((row)=>row.event_type==='integration.client_created'));
});
