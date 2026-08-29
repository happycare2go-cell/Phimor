# HHS Pilot V1 controlled operations runbook

This runbook prepares one Organization, one Center, one Resident, one Care
Profile, and one verified Family group. It does not authorize production
access by itself.

## Credential handling

PHIMOR System Admin must:

Use **System Admin LIFF → ศูนย์และระบบเชื่อมต่อ → ระบบเชื่อมต่อ** for the
commissioning steps below. The generic UI workflow and correction rules are in
`docs/GENERIC_INTEGRATION_COMMISSIONING.md`; HHS is a pilot client of that
vendor-neutral workflow.

1. create the Integration Client under the correct Organization;
2. add only the pilot Center scope;
3. add only `care.daily_report.finalized` and, if agreed,
   `care.vitals.recorded` event scopes;
4. create the exact external Center mapping;
5. choose **ออก Credential** in the client detail (backed by
   `POST /api/admin/platform/integration-clients/:integrationClientId/credentials`);
6. copy the returned token once into an approved secret channel/manager; and
7. remove it from screen/clipboard according to the operator's secure process.

The token is never sent in an ordinary LINE group/chat, committed, logged, put
in browser code, or exposed to LIFF. HHS stores it only in a server-side secret
manager/environment. Rotation uses the existing rotate/revoke operations and
an agreed overlap window. No real credential is created by this repository
task.

## Production migration readiness

The repository migration chain currently ends at
`0016_add_center_family_linking_integrity.js`. Application startup (`npm
start`) does not run migrations.

The supported commands are only the following, run from `backend` with the
intended database environment selected:

```sh
npm run migrate:status
npm run migrate
npm run migrate:status
```

`migrate:status` verifies recorded checksums and reports applied/pending rows.
`migrate` obtains a PostgreSQL advisory lock and applies **all** pending files
in filename/version order. The repository does not provide a supported command
to apply only one chosen migration.

Production sequence:

1. stop/pause backend and LIFF auto-deploy for the release in Render;
2. create a production PostgreSQL backup/snapshot using the configured managed
   database process;
3. verify backup completion time and the documented restore procedure;
4. from `backend`, run `npm run migrate:status` and retain the output;
5. if current version is `0007`, confirm pending order is exactly:
   `0008_create_platform_organizations_and_integrations`,
   `0009_create_canonical_vital_signs`,
   `0010_create_daily_care_reports`,
   `0011_create_integration_event_inbox`,
   `0012_align_care_finalization_and_routing`, then
   `0013_add_consultation_payment_recovery`, then
   `0014_create_shared_rate_limit_windows`, then
   `0015_add_plus_payment_v1`, then
   `0016_add_center_family_linking_integrity`;
6. if older than `0007`, review every reported pending migration rather than
   assuming the starting state;
7. run `npm run migrate` once; do not interrupt the runner;
8. run `npm run migrate:status` again and require current version `0016`, no
   pending migration, and no checksum mismatch;
9. deploy/redeploy `phimor-backend` from the approved commit;
10. verify `/health`, `/ready`, scheduler heartbeat, notification health, and
    integration inbox processing health;
11. verify `/config/liff` returns only the intended public runtime config;
12. deploy/redeploy the `phimor-liff` static service;
13. verify System Admin, Center, Family, Pharmacist, and Consultation LIFF
    smoke paths; and
14. enable `vital_signs_v1` and `daily_care_v1` only for the one pilot Center.

Never infer production's current schema version; status output is the source of
truth. A checksum mismatch is a stop condition.

## Render deployment race precaution

`render.yaml` defines `phimor-backend` and `phimor-liff` but does not set
`autoDeploy:false`; its header also describes automatic Blueprint deployment.
It has no migration `preDeployCommand`. Therefore a merge can deploy backend
code requiring migrations 0008–0016 before schema preparation. Migrations 0015
and 0016 add separately scoped Plus payment and Center–Family linking integrity;
neither changes the HHS event contract.

Before merging/deploying the pilot release, an authorized operator must disable
or pause auto-deploy for both production services in Render (or otherwise hold
the deployment using the existing Render control), confirm the currently
running version remains unchanged, perform and verify the migration sequence,
then manually deploy backend before LIFF. This runbook does not modify Render.

No new HHS-specific environment variable is required by the merged backend.
The issued Integration credential is stored only on the HHS server side.
Existing production secrets and the consultation realtime secret remain under
their existing controls.

## Pilot setup checklist

- [ ] One active Organization exists.
- [ ] One active Center belongs to that Organization.
- [ ] `vital_signs_v1` is ON only if pilot Vital writes are intended.
- [ ] `daily_care_v1` is ON for the pilot Center.
- [ ] One active Integration Client belongs to the Organization.
- [ ] Client Center scope contains only the pilot Center.
- [ ] Event scope contains `care.daily_report.finalized` and only agreed extras.
- [ ] External branch ID maps exactly to the pilot Center.
- [ ] External Resident ID maps exactly to the Resident in that Center.
- [ ] Resident has the intended Care Profile relationship.
- [ ] PHIMOR OA has an active, verified Family GroupBinding for that profile.
- [ ] HHS expected group equals the masked/full value verified through the
  controlled operational process.
- [ ] Credential was transferred through an approved secret channel and does
  not appear in chat, code, tickets, screenshots, or logs.

## Local contract simulator

From `backend`, print all nine fictional scenarios without making a request:

```sh
npm run simulate:hhs-pilot
```

To call only a local/test backend, set a local Integration credential in the
process environment and opt in explicitly:

```sh
HHS_PILOT_SIMULATOR_TOKEN=<local-test-token> npm run simulate:hhs-pilot -- --send --base-url http://127.0.0.1:3000
```

Use `--scenario day,duplicate-day` to select cases. The harness refuses a
non-loopback target, does not print the token or response payload, and includes
Day, duplicate Day, Night, pending subject, group mismatch, invalid credential,
invalid Center, invalid payload, and standalone Vital scenarios. Mapped/group
states still depend on the local fixture/setup; the harness never creates real
PHIMOR or HHS records on its own.

## Controlled E2E

1. Confirm both Center capabilities are in their intended state.
2. Confirm Integration Client, Center, and event scopes.
3. Confirm external Center mapping.
4. Confirm exact Resident mapping.
5. Confirm the PHIMOR OA verified Family GroupBinding.
6. Confirm expected group matches.
7. Send one fictional/test Day finalized event from the approved pilot sender.
8. Require HTTP 202 and record the safe request/result metadata.
9. Verify one canonical finalized Daily Care report.
10. Verify linked Vital observations exactly match supplied facts.
11. Verify exactly one notification intent and one LINE push.
12. Verify the report in Family P7.
13. Resend the exact Day event and require duplicate response with no extra
    canonical record or LINE push.
14. Send one Night finalized event and verify one second report and one
    additional push.
15. Send one standalone Vital and verify canonical storage with no LINE push.
16. Send a finalized event with mismatched expected group and verify the care
    report is stored, state is `group_binding_mismatch`, and no LINE is sent.
17. Correct the PHIMOR verified binding through the approved Family flow.
18. Use System Admin “ตรวจสอบอีกครั้ง”; verify routing becomes eligible and
    idempotency prevents duplicate delivery.
19. Test a never-mapped Resident; require 202 `pending_subject_mapping`, no
    clinical attachment to another person, and no notification.
20. Map the Resident exactly in System Admin; verify pending events reprocess
    without vendor resend.

## Message-cost expectation

For the normal HHS two-shift pilot policy:

| Source action | Stored | Expected Family push |
| --- | --- | --- |
| Day finalized | yes | one |
| Night finalized | yes | one |
| Standalone Vital | yes | none |
| Draft/submitted/intermediate AI text | not sent to PHIMOR | none |

Expected normal maximum is two Daily Care pushes per Resident per day for this
HHS policy. It is not a global platform cap. Pilot monitoring should compare
finalized records, notification intents, and provider acceptance counts daily.

## Stop conditions before a real pilot

Stop if backup cannot be verified, migration checksums differ, production
auto-deploy cannot be held, exact Center/Resident mapping is uncertain,
GroupBinding is missing/mismatched for the positive-path test, capabilities are
not scoped to the pilot Center, or credential transfer cannot use an approved
secret channel.
