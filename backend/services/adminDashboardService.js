const { databaseQuery } = require('../db');

// One bounded aggregate query keeps the System Admin landing page independent
// from every directory/detail endpoint. Only counts leave this service.
const DASHBOARD_SQL = `
  WITH center_classified AS (
    SELECT CASE
      WHEN COALESCE(data->>'status', 'active') <> 'active' THEN 'suspended'
      WHEN NULLIF(data->>'subscription_start_at', '') IS NULL
        OR NULLIF(data->>'subscription_end_at', '') IS NULL THEN 'not_configured'
      WHEN $1::timestamptz < (data->>'subscription_start_at')::timestamptz THEN 'not_started'
      WHEN $1::timestamptz > (data->>'subscription_end_at')::timestamptz THEN 'expired'
      WHEN data->>'subscription_package_type' = 'trial' THEN 'trial'
      ELSE 'active'
    END AS state,
    NULLIF(data->>'subscription_end_at', '')::timestamptz AS expires_at
    FROM centers
  ), client_readiness AS (
    SELECT c.integration_client_id, c.status,
      CASE WHEN c.status = 'active'
        AND o.status = 'active'
        AND EXISTS (SELECT 1 FROM integration_client_centers cc
          WHERE cc.integration_client_id = c.integration_client_id)
        AND EXISTS (SELECT 1 FROM integration_client_event_scopes es
          WHERE es.integration_client_id = c.integration_client_id)
        AND EXISTS (SELECT 1 FROM integration_credentials cr
          WHERE cr.integration_client_id = c.integration_client_id
            AND cr.status = 'active' AND (cr.expires_at IS NULL OR cr.expires_at > $1::timestamptz))
        AND (
          COALESCE((SELECT al.data->'policy'->>'identityResolutionMode'
            FROM "auditLog" al
            WHERE al.data->>'log_id' = 'integration-policy:' || c.integration_client_id
            ORDER BY al.created_at DESC LIMIT 1), 'manual_mapping_only') = 'exact_name_learning'
          OR EXISTS (SELECT 1 FROM external_center_mappings cm
            WHERE cm.integration_client_id = c.integration_client_id AND cm.status = 'active')
        ) THEN true ELSE false END AS ready
    FROM integration_clients c
    LEFT JOIN organizations o ON o.organization_id = c.organization_id
  ), exception_counts AS (
    SELECT
      (SELECT COUNT(*)::int FROM integration_event_inbox
        WHERE status = 'pending' AND pending_reason = 'subject_mapping') AS pending_subject_mapping,
      (SELECT COUNT(*)::int FROM integration_event_inbox
        WHERE group_reconciliation_status = 'group_binding_missing') AS group_binding_missing,
      (SELECT COUNT(*)::int FROM integration_event_inbox
        WHERE group_reconciliation_status = 'group_binding_mismatch') AS group_binding_mismatch,
      (SELECT COUNT(*)::int FROM integration_event_inbox
        WHERE status IN ('retrying', 'dead', 'rejected')) AS integration_failures,
      (SELECT COUNT(*)::int FROM "auditLog"
        WHERE data->>'action' = 'integration.identity_ambiguity_alert'
          AND COALESCE(data->>'status', 'open') = 'open') AS identity_ambiguity,
      (SELECT COUNT(*)::int FROM "dataSubjectRequests"
        WHERE data->>'status' IN ('pending', 'in_progress')) AS dsr_awaiting_action,
      (SELECT COUNT(*)::int FROM "accessRequests"
        WHERE data->>'status' = 'pending'
          AND (NULLIF(data->>'expires_at', '') IS NULL
            OR (data->>'expires_at')::timestamptz > $1::timestamptz)) AS access_requests
  )
  SELECT jsonb_build_object(
    'centers', (SELECT jsonb_build_object(
      'total', COUNT(*)::int,
      'active', COUNT(*) FILTER (WHERE state='active')::int,
      'trial', COUNT(*) FILTER (WHERE state='trial')::int,
      'nearExpiry', COUNT(*) FILTER (WHERE state IN ('active','trial')
        AND expires_at > $1::timestamptz AND expires_at <= $1::timestamptz + INTERVAL '3 days')::int,
      'expired', COUNT(*) FILTER (WHERE state='expired')::int,
      'suspended', COUNT(*) FILTER (WHERE state='suspended')::int,
      'notConfigured', COUNT(*) FILTER (WHERE state IN ('not_configured','not_started'))::int
    ) FROM center_classified),
    'integrations', (SELECT jsonb_build_object(
      'total', COUNT(*)::int,
      'active', COUNT(*) FILTER (WHERE status='active')::int,
      'suspended', COUNT(*) FILTER (WHERE status='suspended')::int,
      'revoked', COUNT(*) FILTER (WHERE status='revoked')::int,
      'ready', COUNT(*) FILTER (WHERE ready)::int,
      'notReady', COUNT(*) FILTER (WHERE status <> 'revoked' AND NOT ready)::int
    ) FROM client_readiness),
    'exceptions', (SELECT to_jsonb(exception_counts) FROM exception_counts)
  ) AS dashboard
`;

const zeroes = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const CENTER_KEYS = ['total', 'active', 'trial', 'nearExpiry', 'expired', 'suspended', 'notConfigured'];
const INTEGRATION_KEYS = ['total', 'active', 'suspended', 'revoked', 'ready', 'notReady'];
const EXCEPTION_KEYS = ['pendingSubjectMapping', 'groupBindingMissing', 'groupBindingMismatch',
  'identityAmbiguity', 'dsrAwaitingAction', 'accessRequests', 'integrationFailures',
  'notificationDeadLetters', 'schedulerFailures'];

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeDashboard(raw = {}, { notificationHealth = {}, scheduler = {} } = {}) {
  const sourceExceptions = raw.exceptions || {};
  const schedulerFailures = Object.values(scheduler.jobs || {})
    .filter((job) => job?.status === 'failed').length;
  const centers = { ...zeroes(CENTER_KEYS) };
  const integrations = { ...zeroes(INTEGRATION_KEYS) };
  CENTER_KEYS.forEach((key) => { centers[key] = integer(raw.centers?.[key]); });
  INTEGRATION_KEYS.forEach((key) => { integrations[key] = integer(raw.integrations?.[key]); });
  const exceptions = {
    ...zeroes(EXCEPTION_KEYS),
    pendingSubjectMapping:integer(sourceExceptions.pending_subject_mapping ?? sourceExceptions.pendingSubjectMapping),
    groupBindingMissing:integer(sourceExceptions.group_binding_missing ?? sourceExceptions.groupBindingMissing),
    groupBindingMismatch:integer(sourceExceptions.group_binding_mismatch ?? sourceExceptions.groupBindingMismatch),
    identityAmbiguity:integer(sourceExceptions.identity_ambiguity ?? sourceExceptions.identityAmbiguity),
    dsrAwaitingAction:integer(sourceExceptions.dsr_awaiting_action ?? sourceExceptions.dsrAwaitingAction),
    accessRequests:integer(sourceExceptions.access_requests ?? sourceExceptions.accessRequests),
    integrationFailures:integer(sourceExceptions.integration_failures ?? sourceExceptions.integrationFailures),
    notificationDeadLetters:integer(notificationHealth.deadLetters ?? notificationHealth.deadLetter),
    schedulerFailures:integer(schedulerFailures),
  };
  const warningCount = exceptions.integrationFailures + exceptions.notificationDeadLetters
    + exceptions.schedulerFailures;
  return {
    centers, integrations, exceptions,
    platform:{
      configuredSchedulerJobs:integer(scheduler.configuredJobs),
      schedulerFailures:exceptions.schedulerFailures,
      warningCount,
      state:warningCount ? 'attention' : 'operational',
    },
  };
}

function createAdminDashboardService({
  queryFn = databaseQuery,
  notificationService = require('./notificationService'),
  schedulerHealth = () => ({ configuredJobs:0, jobs:{} }),
  now = () => new Date(),
} = {}) {
  async function getDashboard() {
    const [result, notificationHealth] = await Promise.all([
      queryFn(DASHBOARD_SQL, [now().toISOString()]),
      notificationService.getHealth(),
    ]);
    const scheduler = schedulerHealth() || { configuredJobs:0, jobs:{} };
    return normalizeDashboard(result.rows?.[0]?.dashboard || {}, { notificationHealth, scheduler });
  }
  return { getDashboard };
}

module.exports = { DASHBOARD_SQL, normalizeDashboard, createAdminDashboardService };
