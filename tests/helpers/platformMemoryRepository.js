function createMemoryPlatformRepository() {
  const state = {
    organizations: [], organizationCenters: [], capabilities: [], clients: [],
    credentials: [], clientCenters: [], eventScopes: [], centerMappings: [],
    subjectMappings: [], auditEvents: [],
  };
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 7, 27, 0, 0, tick++)).toISOString();
  const clone = (row) => row ? { ...row } : null;

  return {
    state,
    async createOrganization(record) {
      if (state.organizations.some((row) => row.organization_code === record.organizationCode)) throw Object.assign(new Error('duplicate organization'), { code:'23505' });
      const row = { organization_id:record.organizationId, organization_code:record.organizationCode,
        display_name:record.displayName, organization_type:record.organizationType,
        status:record.status, created_at:stamp(), updated_at:stamp() };
      state.organizations.push(row); return clone(row);
    },
    async findOrganization(id) { return clone(state.organizations.find((row) => row.organization_id === id)); },
    async findOrganizationByCode(code) { return clone(state.organizations.find((row) => row.organization_code === code)); },
    async listOrganizations() { return state.organizations.map(clone); },
    async linkCenter(record) {
      if (state.organizationCenters.some((row) => row.center_id === record.centerId)) return null;
      const row={center_id:record.centerId,organization_id:record.organizationId,linked_by_admin_id:record.actorReference,linked_at:stamp(),updated_at:stamp()};
      state.organizationCenters.push(row); return clone(row);
    },
    async relinkCenter(record) { const row=state.organizationCenters.find((item)=>item.center_id===record.centerId);if(!row)return null;row.organization_id=record.organizationId;row.linked_by_admin_id=record.actorReference;row.updated_at=stamp();return clone(row); },
    async findOrganizationForCenter(centerId) { const link=state.organizationCenters.find((row)=>row.center_id===centerId);if(!link)return null;const org=state.organizations.find((row)=>row.organization_id===link.organization_id);return org?{...clone(org),center_id:centerId,linked_at:link.linked_at,relationship_updated_at:link.updated_at}:null; },
    async listOrganizationCenters(orgId) { return state.organizationCenters.filter((row)=>row.organization_id===orgId).map(clone); },
    async countCenterIntegrationDependencies(centerId) { return state.clientCenters.filter((row)=>row.center_id===centerId).length+state.centerMappings.filter((row)=>row.center_id===centerId&&row.status==='active').length; },
    async listCapabilities(centerId) { return state.capabilities.filter((row)=>row.center_id===centerId).map(clone); },
    async findCapability(centerId,key) { return clone(state.capabilities.find((row)=>row.center_id===centerId&&row.capability_key===key)); },
    async upsertCapability(record) { let row=state.capabilities.find((item)=>item.center_id===record.centerId&&item.capability_key===record.capabilityKey);if(!row){row={center_id:record.centerId,capability_key:record.capabilityKey};state.capabilities.push(row)}row.enabled=record.enabled;row.enabled_at=record.enabled?stamp():null;row.updated_at=stamp();return clone(row); },
    async createIntegrationClient(record) { if(state.clients.some((item)=>item.client_code===record.clientCode))throw Object.assign(new Error('duplicate client code'),{code:'23505'});const row={integration_client_id:record.integrationClientId,organization_id:record.organizationId,client_code:record.clientCode,display_name:record.displayName,source_system:record.sourceSystem,status:record.status||'active',created_at:stamp(),updated_at:stamp(),revoked_at:null};state.clients.push(row);return clone(row); },
    async findIntegrationClient(id) { return clone(state.clients.find((row)=>row.integration_client_id===id)); },
    async listIntegrationClients(orgId) { return state.clients.filter((row)=>row.organization_id===orgId).map(clone); },
    async updateIntegrationClientStatus(id,status) { const row=state.clients.find((item)=>item.integration_client_id===id);if(!row)return null;row.status=status;row.revoked_at=status==='revoked'?stamp():null;row.updated_at=stamp();return clone(row); },
    async addClientCenterScope(record) { if(state.clientCenters.some((row)=>row.integration_client_id===record.integrationClientId&&row.center_id===record.centerId))return null;const row={integration_client_id:record.integrationClientId,organization_id:record.organizationId,center_id:record.centerId,created_at:stamp()};state.clientCenters.push(row);return clone(row); },
    async removeClientCenterScope(clientId,centerId) { const index=state.clientCenters.findIndex((row)=>row.integration_client_id===clientId&&row.center_id===centerId);if(index<0)return null;return clone(state.clientCenters.splice(index,1)[0]); },
    async listClientCenterScopes(clientId) { return state.clientCenters.filter((row)=>row.integration_client_id===clientId).map(clone); },
    async hasClientCenterScope(clientId,centerId) { return state.clientCenters.some((row)=>row.integration_client_id===clientId&&row.center_id===centerId); },
    async addClientEventScope(record) { if(state.eventScopes.some((row)=>row.integration_client_id===record.integrationClientId&&row.event_type===record.eventType))return null;const row={integration_client_id:record.integrationClientId,event_type:record.eventType,created_at:stamp()};state.eventScopes.push(row);return clone(row); },
    async removeClientEventScope(clientId,eventType) { const index=state.eventScopes.findIndex((row)=>row.integration_client_id===clientId&&row.event_type===eventType);if(index<0)return null;return clone(state.eventScopes.splice(index,1)[0]); },
    async listClientEventScopes(clientId) { return state.eventScopes.filter((row)=>row.integration_client_id===clientId).map(clone); },
    async hasClientEventScope(clientId,eventType) { return state.eventScopes.some((row)=>row.integration_client_id===clientId&&row.event_type===eventType); },
    async createCredential(record) { const row={credential_id:record.credentialId,integration_client_id:record.integrationClientId,public_prefix:record.publicPrefix,secret_salt:Buffer.from(record.secretSalt),secret_hash:Buffer.from(record.secretHash),status:'active',created_at:stamp(),expires_at:record.expiresAt||null,revoked_at:null,rotated_from_credential_id:record.rotatedFromCredentialId||null,last_used_at:null};state.credentials.push(row);return clone(row); },
    async findCredential(id) { return clone(state.credentials.find((row)=>row.credential_id===id)); },
    async findCredentialByPrefix(prefix) { const cred=state.credentials.find((row)=>row.public_prefix===prefix);if(!cred)return null;const client=state.clients.find((row)=>row.integration_client_id===cred.integration_client_id);const org=client&&state.organizations.find((row)=>row.organization_id===client.organization_id);return {...clone(cred),organization_id:client?.organization_id,client_code:client?.client_code,client_display_name:client?.display_name,source_system:client?.source_system,client_status:client?.status,organization_status:org?.status}; },
    async listActiveCredentials(clientId) { const now=Date.parse('2026-08-27T00:00:00.000Z');return state.credentials.filter((row)=>row.integration_client_id===clientId&&row.status==='active'&&(!row.expires_at||new Date(row.expires_at).getTime()>now)).map(clone); },
    async listCredentials(clientId) { return state.credentials.filter((row)=>row.integration_client_id===clientId).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||String(b.credential_id).localeCompare(String(a.credential_id))).map(clone); },
    async revokeCredential(id) { const row=state.credentials.find((item)=>item.credential_id===id&&item.status==='active');if(!row)return null;row.status='revoked';row.revoked_at=stamp();return clone(row); },
    async expireCredentialAt(id,expiresAt) { const row=state.credentials.find((item)=>item.credential_id===id&&item.status==='active');if(!row)return null;row.expires_at=expiresAt;return clone(row); },
    async touchCredential(id) { const row=state.credentials.find((item)=>item.credential_id===id);if(row)row.last_used_at=stamp(); },
    async findExternalCenterMapping(clientId,externalId) { return clone(state.centerMappings.find((row)=>row.integration_client_id===clientId&&row.external_center_id===externalId)); },
    async findActiveExternalCenterMappingByCenter(clientId,centerId) { return clone(state.centerMappings.find((row)=>row.integration_client_id===clientId&&row.center_id===centerId&&row.status==='active')); },
    async listExternalCenterMappings({integrationClientId,status=null,search=null,limit=50,offset=0}) { const needle=String(search||'').toLowerCase();return state.centerMappings.filter((row)=>row.integration_client_id===integrationClientId&&(!status||row.status===status)&&(!needle||row.external_center_id.toLowerCase().includes(needle))).sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1)||String(b.updated_at).localeCompare(String(a.updated_at))||a.external_center_id.localeCompare(b.external_center_id)).slice(offset,offset+limit).map(clone); },
    async countExternalCenterMappings({integrationClientId,status=null,search=null}) { const needle=String(search||'').toLowerCase();return state.centerMappings.filter((row)=>row.integration_client_id===integrationClientId&&(!status||row.status===status)&&(!needle||row.external_center_id.toLowerCase().includes(needle))).length; },
    async upsertExternalCenterMapping(record) { let row=state.centerMappings.find((item)=>item.integration_client_id===record.integrationClientId&&item.external_center_id===record.externalCenterId);if(!row){row={external_center_mapping_id:record.mappingId,integration_client_id:record.integrationClientId,external_center_id:record.externalCenterId,created_at:stamp()};state.centerMappings.push(row)}Object.assign(row,{organization_id:record.organizationId,center_id:record.centerId,display_name:record.displayName,status:'active',updated_at:stamp(),deactivated_at:null});return clone(row); },
    async deactivateExternalCenterMapping(clientId,externalId) { const row=state.centerMappings.find((item)=>item.integration_client_id===clientId&&item.external_center_id===externalId&&item.status==='active');if(!row)return null;row.status='inactive';row.deactivated_at=stamp();return clone(row); },
    async findExternalSubjectMapping(clientId,externalCenterId,externalResidentId) { return clone(state.subjectMappings.find((row)=>row.integration_client_id===clientId&&row.external_center_id===externalCenterId&&row.external_resident_id===externalResidentId)); },
    async listExternalSubjectMappings({integrationClientId,status=null,search=null,limit=50,offset=0}) { const needle=String(search||'').toLowerCase();const rank={mapped:0,pending_subject_mapping:1,inactive:2};return state.subjectMappings.filter((row)=>row.integration_client_id===integrationClientId&&(!status||row.mapping_status===status)&&(!needle||row.external_resident_id.toLowerCase().includes(needle))).sort((a,b)=>(rank[a.mapping_status]??9)-(rank[b.mapping_status]??9)||String(b.updated_at).localeCompare(String(a.updated_at))||a.external_resident_id.localeCompare(b.external_resident_id)).slice(offset,offset+limit).map(clone); },
    async countExternalSubjectMappings({integrationClientId,status=null,search=null}) { const needle=String(search||'').toLowerCase();return state.subjectMappings.filter((row)=>row.integration_client_id===integrationClientId&&(!status||row.mapping_status===status)&&(!needle||row.external_resident_id.toLowerCase().includes(needle))).length; },
    async upsertExternalSubjectMapping(record) { let row=state.subjectMappings.find((item)=>item.integration_client_id===record.integrationClientId&&item.external_center_id===record.externalCenterId&&item.external_resident_id===record.externalResidentId);if(!row){row={external_subject_mapping_id:record.mappingId,integration_client_id:record.integrationClientId,external_center_id:record.externalCenterId,external_resident_id:record.externalResidentId,created_at:stamp()};state.subjectMappings.push(row)}Object.assign(row,{organization_id:record.organizationId,center_id:record.centerId,resident_id:record.residentId,care_profile_id:record.careProfileId,mapping_status:record.mappingStatus,first_name:record.firstName,last_name:record.lastName,display_name:record.displayName,room:record.room,last_seen_at:record.lastSeenAt,updated_at:stamp(),deactivated_at:null});return clone(row); },
    async deactivateExternalSubjectMapping(clientId,externalCenterId,externalResidentId) { const row=state.subjectMappings.find((item)=>item.integration_client_id===clientId&&item.external_center_id===externalCenterId&&item.external_resident_id===externalResidentId&&item.mapping_status!=='inactive');if(!row)return null;row.mapping_status='inactive';row.deactivated_at=stamp();return clone(row); },
    async insertAuditEvent(record) { const row={platform_audit_event_id:record.eventId,event_type:record.eventType,actor_type:record.actorType,actor_reference:record.actorReference,organization_id:record.organizationId,center_id:record.centerId,integration_client_id:record.integrationClientId,metadata:{...record.metadata},occurred_at:stamp()};state.auditEvents.push(row);return clone(row); },
  };
}

module.exports = { createMemoryPlatformRepository };
