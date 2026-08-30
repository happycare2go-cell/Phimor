const { AuditLog, id, now, withTransaction } = require('../db');
const {
  DEFAULT_INTEGRATION_IDENTITY_POLICY, IGNORED_INTEGRATION_STATUSES, assertPolicy, safeIdentityKey,
} = require('../domain/integrationIdentity');
const { PlatformError } = require('../domain/platform');

const POLICY_ACTION = 'integration.identity_policy_config';
const METRICS_ACTION = 'integration.identity_metrics';
const ALERT_ACTION = 'integration.identity_ambiguity_alert';
const MAPPING_ORIGIN_ACTION = 'integration.mapping_origin';
const ALERT_STATUSES = Object.freeze(['open', 'resolved', 'dismissed']);
const METRIC_KEYS = Object.freeze(['processed', ...IGNORED_INTEGRATION_STATUSES]);

function createIntegrationIdentityPolicyService(overrides = {}) {
  const store = overrides.AuditLog || AuditLog;
  const transact = overrides.withTransaction || withTransaction;
  const idFactory = overrides.idFactory || id;
  const clock = overrides.now || now;
  const policyId = (clientId) => `integration-policy:${clientId}`;
  const metricsId = (clientId) => `integration-metrics:${clientId}`;

  async function getPolicy(integrationClientId) {
    const row = await store.findOneByField('log_id', policyId(integrationClientId));
    return row ? assertPolicy(row.policy) : { ...DEFAULT_INTEGRATION_IDENTITY_POLICY };
  }

  async function setPolicy({ integrationClientId, policy, actorReference }) {
    const normalized = assertPolicy(policy);
    return transact(`integration-identity-policy:${integrationClientId}`, async () => {
      const record = await store.findOneByField('log_id', policyId(integrationClientId));
      const patch = { policy:normalized, updated_at:clock(), updated_by:String(actorReference || 'system_admin').slice(0, 128) };
      if (record) await store.update((item) => item.log_id === record.log_id, patch);
      else await store.insert({ log_id:policyId(integrationClientId), action:POLICY_ACTION,
        integration_client_id:integrationClientId, ...patch, created_at:clock() });
      return { ...normalized };
    });
  }

  async function incrementMetric(integrationClientId, metric) {
    if (!METRIC_KEYS.includes(metric)) return null;
    return transact(`integration-identity-metrics:${integrationClientId}`, async () => {
      const record = await store.findOneByField('log_id', metricsId(integrationClientId));
      const counts = { ...(record?.counts || {}) };
      counts[metric] = Math.max(0, Number(counts[metric]) || 0) + 1;
      const patch = { counts, updated_at:clock() };
      if (record) return store.update((item) => item.log_id === record.log_id, patch);
      return store.insert({ log_id:metricsId(integrationClientId), action:METRICS_ACTION,
        integration_client_id:integrationClientId, counts, created_at:clock(), updated_at:clock() });
    });
  }

  async function getMetrics(integrationClientId) {
    const record = await store.findOneByField('log_id', metricsId(integrationClientId));
    return METRIC_KEYS.reduce((result, key) => ({ ...result, [key]:Math.max(0, Number(record?.counts?.[key]) || 0) }), {});
  }

  async function recordAmbiguity({ integrationClientId, sourceSystemDisplayName, externalCenterId,
    externalResidentId, normalizedDisplayName, candidateCenterNames, candidateCount = null }) {
    const alertKey = safeIdentityKey([integrationClientId, externalCenterId, externalResidentId, normalizedDisplayName]);
    return transact(`integration-identity-alert:${alertKey}`, async () => {
      const record = await store.findOneByField('alert_key', alertKey);
      const at = clock();
      const safeCenters = [...new Set((candidateCenterNames || []).map((value) => String(value || '').trim())
        .filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')).slice(0, 20);
      if (record) return store.update((item) => item.alert_key === alertKey, {
        last_seen_at:at, occurrence_count:Math.max(1, Number(record.occurrence_count) || 1) + 1,
        candidate_count:Math.max(safeCenters.length, Number(candidateCount) || 0), candidate_center_names:safeCenters,
        status:record.status === 'dismissed' ? 'dismissed' : 'open',
      });
      return store.insert({ log_id:idFactory('IALOG'), action:ALERT_ACTION, alert_key:alertKey,
        integration_client_id:integrationClientId,
        source_system_display_name:String(sourceSystemDisplayName || '').trim().slice(0, 160) || null,
        external_center_id:String(externalCenterId || '').trim().slice(0, 160),
        external_resident_id:String(externalResidentId || '').trim().slice(0, 160),
        normalized_display_name:String(normalizedDisplayName || '').trim().slice(0, 240),
        candidate_count:Math.max(safeCenters.length, Number(candidateCount) || 0), candidate_center_names:safeCenters,
        first_seen_at:at, last_seen_at:at, occurrence_count:1, status:'open' });
    });
  }

  function alertProjection(row) {
    return {
      alertId:row.log_id, integrationClientId:row.integration_client_id,
      sourceSystemDisplayName:row.source_system_display_name || null,
      externalCenterId:row.external_center_id, externalResidentId:row.external_resident_id,
      normalizedDisplayName:row.normalized_display_name,
      candidateCount:Number(row.candidate_count) || 0,
      candidateCenterNames:(Array.isArray(row.candidate_center_names) ? row.candidate_center_names : []).slice(0, 20),
      firstSeenAt:row.first_seen_at, lastSeenAt:row.last_seen_at,
      occurrenceCount:Number(row.occurrence_count) || 1, status:row.status || 'open',
    };
  }

  async function listAlerts({ integrationClientId = null, status = null, limit = 100 } = {}) {
    if (status && !ALERT_STATUSES.includes(status)) throw new PlatformError('INVALID_ALERT_STATUS', 'สถานะรายการตรวจสอบไม่ถูกต้อง', 400);
    const rows = await store.findWhereByField('action', ALERT_ACTION);
    return { items:rows.filter((row) => (!integrationClientId || row.integration_client_id === integrationClientId)
      && (!status || row.status === status))
      .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)))
      .slice(0, Math.min(200, Math.max(1, Number(limit) || 100))).map(alertProjection) };
  }

  async function updateAlertStatus({ alertId, status, actorReference }) {
    if (!ALERT_STATUSES.includes(status)) throw new PlatformError('INVALID_ALERT_STATUS', 'สถานะรายการตรวจสอบไม่ถูกต้อง', 400);
    const row = await store.findOneByField('log_id', String(alertId || ''));
    if (!row || row.action !== ALERT_ACTION) throw new PlatformError('INTEGRATION_ALERT_NOT_FOUND', 'ไม่พบรายการที่ต้องตรวจสอบ', 404);
    const updated = await store.update((item) => item.log_id === row.log_id, {
      status, resolved_at:status === 'resolved' ? clock() : row.resolved_at || null,
      updated_at:clock(), updated_by:String(actorReference || 'system_admin').slice(0, 128),
    });
    return alertProjection(updated);
  }

  async function resolveAlertsForIdentity({ integrationClientId, externalCenterId, externalResidentId }) {
    const rows = await store.findWhereByField('action', ALERT_ACTION);
    const targets = rows.filter((row) => row.integration_client_id === integrationClientId
      && row.external_center_id === externalCenterId && row.external_resident_id === externalResidentId
      && row.status === 'open');
    for (const row of targets) await store.update((item) => item.log_id === row.log_id,
      { status:'resolved', resolved_at:clock(), updated_at:clock(), updated_by:'system:mapping' });
    return targets.length;
  }

  async function recordMappingOrigin({ integrationClientId, externalCenterId, externalResidentId = null, source }) {
    const mappingKey = safeIdentityKey([integrationClientId, externalCenterId, externalResidentId || 'center']);
    return transact(`integration-mapping-origin:${mappingKey}`, async () => {
      const existing = await store.findOneByField('mapping_key', mappingKey);
      if (existing) return existing;
      return store.insert({ log_id:idFactory('IMAP'), action:MAPPING_ORIGIN_ACTION, mapping_key:mappingKey,
        integration_client_id:integrationClientId, external_center_id:externalCenterId,
        external_resident_id:externalResidentId || null,
        source:source === 'learned_automatically' ? 'learned_automatically' : 'configured_manually',
        created_at:clock(), last_used_at:clock() });
    });
  }

  async function getMappingOrigin({ integrationClientId, externalCenterId, externalResidentId = null }) {
    const mappingKey = safeIdentityKey([integrationClientId, externalCenterId, externalResidentId || 'center']);
    const row = await store.findOneByField('mapping_key', mappingKey);
    return row?.source || 'configured_manually';
  }

  async function touchMappingOrigin({ integrationClientId, externalCenterId, externalResidentId = null }) {
    const mappingKey = safeIdentityKey([integrationClientId, externalCenterId, externalResidentId || 'center']);
    return store.update((item) => item.mapping_key === mappingKey, { last_used_at:clock() });
  }

  return { getPolicy, setPolicy, incrementMetric, getMetrics, recordAmbiguity, listAlerts,
    updateAlertStatus, resolveAlertsForIdentity, recordMappingOrigin, getMappingOrigin, touchMappingOrigin };
}

const integrationIdentityPolicyService = createIntegrationIdentityPolicyService();
module.exports = { createIntegrationIdentityPolicyService, integrationIdentityPolicyService,
  POLICY_ACTION, METRICS_ACTION, ALERT_ACTION, MAPPING_ORIGIN_ACTION, ALERT_STATUSES, METRIC_KEYS };
