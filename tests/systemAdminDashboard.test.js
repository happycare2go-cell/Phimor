process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DASHBOARD_SQL, normalizeDashboard, createAdminDashboardService } = require('../backend/services/adminDashboardService');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'system-admin', 'index.html'), 'utf8');

test('dashboard normalizes authoritative Center, Integration, exception and scheduler aggregates', async () => {
  const service = createAdminDashboardService({
    queryFn:async () => ({ rows:[{ dashboard:{
      centers:{ total:'6', active:2, trial:1, nearExpiry:1, expired:1, suspended:1, notConfigured:1 },
      integrations:{ total:3, active:2, suspended:1, revoked:0, ready:1, notReady:2 },
      exceptions:{ pending_subject_mapping:2, group_binding_missing:1, group_binding_mismatch:1,
        identity_ambiguity:1, dsr_awaiting_action:2, access_requests:3, integration_failures:1 },
    } }] }),
    notificationService:{ getHealth:async () => ({ pending:4, deadLetters:2 }) },
    schedulerHealth:() => ({ configuredJobs:15, jobs:{ one:{ status:'completed' }, two:{ status:'failed', errorCode:'SAFE' } } }),
    now:() => new Date('2026-08-31T00:00:00.000Z'),
  });
  const result = await service.getDashboard();
  assert.equal(result.centers.total, 6);
  assert.equal(result.integrations.ready, 1);
  assert.equal(result.exceptions.notificationDeadLetters, 2);
  assert.equal(result.exceptions.schedulerFailures, 1);
  assert.equal(result.platform.warningCount, 4);
  assert.equal(result.platform.state, 'attention');
});

test('dashboard SQL is one bounded aggregate and never projects clinical or credential rows', () => {
  assert.match(DASHBOARD_SQL, /jsonb_build_object/);
  assert.match(DASHBOARD_SQL, /COUNT\(\*\)/);
  assert.match(DASHBOARD_SQL, /INTERVAL '3 days'/);
  assert.doesNotMatch(DASHBOARD_SQL, /patient_name|medication|vital_sign|lab_report|daily_care|canonical_payload|secret_hash|line_user_id|line_group_id/i);
});

test('normalizer never passes through unknown or sensitive source properties', () => {
  const result = normalizeDashboard({
    centers:{ total:1, patientName:'secret' },
    integrations:{ total:1, credential:'pim_int_secret' },
    exceptions:{ pendingSubjectMapping:1, payload:{ clinical:'secret' } },
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret|patientName|credential|payload|clinical/);
});

test('System Admin overview loads one dashboard projection without loading Center directory', () => {
  const destination = html.slice(html.indexOf('async function onAdminDestination'), html.indexOf('function initialAdminDestination'));
  const overview = destination.slice(destination.indexOf("destination==='overview'"), destination.indexOf("destination==='centers'"));
  assert.match(overview, /loadDashboard/);
  assert.doesNotMatch(overview, /loadCenters|careOperations|data-requests|pending-subjects/);
  assert.match(html, /\/api\/admin\/dashboard/);
  assert.match(html, /admin-dashboard__grid/);
  assert.match(html, /data-shell-destination="centers"/);
  assert.match(html, /data-shell-destination="integrations"/);
  assert.match(html, /data-shell-destination="review"/);
});
