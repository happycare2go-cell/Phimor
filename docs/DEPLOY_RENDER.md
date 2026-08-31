# PHIMOR production release on Render

Medication Current Set V2 adds no migration. Before a mixed-version rollout,
follow the stop-write/preflight sequence in `docs/MEDICATION_CURRENT_SET_V2.md`;
do not leave an old medication writer running beside V2 instances.

For paid Plus V1, follow `docs/PLUS_PAYMENT_V1.md`: migrate through 0015 before
deploying/enabling `PLUS_PAYMENT_ENABLED`. Plus is 59 THB for 30 days with
manual renewal only; no automatic recurring charge is configured.

This checklist is the current release-safety procedure for `phimor-backend`
and `phimor-liff`. It does not authorize access to the production database or
changes to live Render/LINE configuration.

## Runtime facts

- PostgreSQL is the authoritative persistence layer. It is not an in-memory or
  Google Sheets deployment.
- LINE webhook signatures and LINE Login ID tokens are verified in production.
  `ALLOW_UNSIGNED_LINE_WEBHOOK` and `ALLOW_INSECURE_LINE_HEADER` are local/test
  escape hatches and must remain `false` in production.
- LIFF applications obtain their public backend URL from deploy-generated
  `liff-app/environment.js` and their LIFF IDs from `GET /config/liff`. Never
  edit a production LIFF ID into HTML/JavaScript source.
- The migration chain currently ends at
  `0015_add_plus_payment_v1.js`. Migration 0014 remains the shared rate-limit
  foundation and must precede 0015. `npm start` does not execute
  the numbered migration runner.

## Required configuration

Set every required value from `backend/.env.example` through Render secrets or
explicit non-secret values. In particular:

- `DATABASE_URL`, LINE Messaging/Login secrets and all enabled LIFF IDs;
- `ADMIN_API_KEY`, `GEMINI_API_KEY`, Omise settings when payment is enabled;
- `CONSULTATION_REALTIME_TICKET_SECRET` as a distinct random secret of at
  least 32 characters;
- `CONSULTATION_REALTIME_ALLOWED_ORIGINS` as an exact comma-separated origin
  allowlist (or the documented `ALLOWED_ORIGINS` fallback);
- `LIFF_ID_SYSTEM_ADMIN` for the full production operations surface; and
- `LIFF_ID_PHARMACIST` when `CONSULTATION_ENABLED=true`.

No secret value belongs in Git, LIFF/browser code, screenshots, normal LINE
chat, or application logs.

## Mandatory release order

Before a production merge or deployment:

1. Inspect both Render services and hold/disable Auto-Deploy if it can deploy
   after a commit or CI result. Confirm no deployment is already running.
2. Create a production PostgreSQL backup/snapshot and verify its completion
   time and documented restore path.
3. From `backend`, run `npm run migrate:status` against the intended database.
4. Stop on a checksum mismatch. Record the actual current version and every
   pending migration; never assume production starts at a particular version.
5. Run `npm run migrate`. The supported runner applies all pending migrations
   in canonical filename order under a PostgreSQL advisory lock.
6. Run `npm run migrate:status` again. Require no checksum mismatch, no pending
   migration, and the expected final version before deploying code.
7. Manually deploy the approved `phimor-backend` commit.
8. Verify `GET /health` and `GET /ready`, including database, environment,
   scheduler heartbeat, notification queue, integration inbox processing, and
   consultation realtime health where enabled.
9. Verify `GET /config/liff` contains only the intended public runtime values.
10. Deploy `phimor-liff`, then smoke-test Register, Center, Family, System
    Admin, and Pharmacist (when enabled) entry points.
11. Run the controlled production E2E for the release, then restore Auto-Deploy
    only if the release owner chooses to do so.

The backend must not be deployed before the compatible migration sequence is
complete. `render.yaml` has no migration pre-deploy command and does not
guarantee `autoDeploy:false`; an authorized human must enforce this hold in the
Render dashboard.

## Legacy startup DDL inventory and risk

Loading `backend/db.js` currently schedules `CREATE TABLE IF NOT EXISTS` for
the following legacy JSONB tables; `initializeDatabase()` waits for those
operations and then creates the legacy expression indexes. This remains part
of application startup because no numbered migration currently owns them:

`centers`, `centerStaff`, `staffContexts`, `residents`, `careProfiles`,
`pendingCards`, `invites`, `appointments`, `medications`, `groupBindings`,
`groupBindingTokens`, `medicationSnapshots`, `transportPlans`,
`centerRateCards`, `bills`, `accessRequests`, `auditLog`, `consents`,
`richMenus`, `vitals`, `careProfileMembers`, `careProfileShareInvites`,
`notificationOutbox`, `webhookInbox`, `dataSubjectRequests`,
`pendingFamilyDeliveries`, and `adminUsers`.

It also ensures expression indexes for common legacy lookups on Center,
staff, Resident, Care Profile, Appointment, Transport, notification, and
access-request fields. These names do not overlap the relational tables owned
by migrations 0001–0017 (`vitals` is the legacy store; canonical Vital data is
in `vital_sign_sets`/`vital_sign_observations`). Removing this startup DDL now
would break installations whose legacy tables were bootstrapped by it.

Remaining risk: the backend database role still needs schema DDL privileges
and startup can mutate those legacy objects. This is temporary compatibility
debt. A future reviewed migration must take ownership of every legacy table and
index before startup DDL can be removed. Numbered migrations remain the only
supported mechanism for migrations 0001–0017. Migration 0014 must precede the
multi-instance backend deployment because rate limiting intentionally fails
closed when its shared table is unavailable.

Migration 0017 creates the Field Picker Adapter profile and temporary-sample
tables. Before deploying a backend that imports the adapter service, hold
Auto-Deploy, verify a current backup and migration status, run the SELECT-only
`npm run preflight:integration-adapter-v1`, apply 0017, and verify final migration
status. Deploy the backend and System Admin LIFF only after the schema is current.

## Stop conditions

Stop the release on backup/restore uncertainty, migration checksum mismatch,
unexpected pending files, `/ready` failure, unhealthy queues/workers, wrong
public LIFF projection, tenant/Care Profile leakage, or duplicate notification
behavior. Preserve logs/audit evidence; do not use destructive rollback or
delete clinical records to hide a failed deployment.
