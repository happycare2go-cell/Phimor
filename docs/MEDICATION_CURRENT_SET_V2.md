# Medication Current Set V2

## Authority and identity

Each Care Profile has one authoritative current medication set. Every accepted
change creates an immutable complete snapshot; older snapshots remain history.
V2 authority is ordered by `version_no`, then `recorded_at`, then
`snapshot_id`. Legacy snapshots remain readable but uncertain legacy history is
shown as “รายการยาที่บันทึกครั้งนั้น” rather than a manufactured semantic
change.

Medication identity uses a compatible trusted stable medication identifier
when present. Otherwise it uses the Unicode-normalized, whitespace-collapsed,
case-insensitive exact medication name. Strength is a mutable fact, not an
identity field. There is no fuzzy or AI identity matching. A proposed set with
the same stable identifier or normalized name more than once is rejected with
`DUPLICATE_MEDICATION_IDENTITY`.

## Writes and concurrency

All supported Family, Center, image, and document-card writers use the central
current-set service and the server-controlled lock namespace
`medication-current:<Care Profile reference>`. Clients submit the complete
intended set and the `baseSnapshotId` they reviewed. If authority changed, the
write fails with HTTP 409 / `MEDICATION_SNAPSHOT_STALE`; the client reloads and
requires another review. An empty set requires an explicit remove-all
confirmation. New snapshots, all linked medication rows, and minimized audit
metadata commit atomically.

Image extraction is a proposal, never an automatic replacement. Current drugs
absent from a partial image remain current. Extracted items are classified as
new, changed strength, changed instruction, changed multiple fields,
unchanged, or ambiguous. A human chooses which factual proposal to apply.
Ambiguity blocks confirmation, and an unchanged complete result does not create
a new snapshot.

## Permissions and projections

- Family owner: manage.
- Family caregiver: manage only with an explicit `manage_medications`
  permission. New caregiver invitations do not grant it by default; existing
  explicit grants remain.
- Active entitled Center Owner/Manager: manage through the active Resident and
  exact Center–Care Profile relationship. Center Staff: read-only.
- Pharmacist and System Admin: no ordinary medication mutation authority.

Ordinary current/history responses omit raw LINE IDs, image bytes, internal
tokens, and raw snapshot storage records. Medication audits record only actor
type, safe references, version/source, changed field names/categories, and
timestamps—not medication names, values, instructions, or image content.
Existing source-image retention continues to purge retained image bytes while
preserving confirmed structured medication facts.

## Pharmacist and export context

Human Pharmacist UI and Pharmacist Assistant share one bounded clinical
context: the same current medication snapshot/version, five recent medication
history entries, and authoritative Vital data from the previous seven days
(maximum five sets and twenty observations). Latest blood pressure is selected
as a systolic/diastolic pair from one set.

The health-history PDF always includes the medication set current at generation
time, even when it predates the chosen history range. History sections include
medication changes, authoritative finalized Health Reports with their linked
Vital facts, and authoritative standalone Vital sets without duplicating linked
Vital. The requested range is limited to 366 days and each history section to
500 records. Exceeding a bound fails with a safe error; it is not silently
truncated. Lab and Doctor Visit are not newly added to this export in V2.

## Production preflight and rolling deployment

No migration is introduced. Before rollout, run the read-only aggregate check
from a controlled backend shell:

```text
npm run preflight:medication-v2
```

The check executes SELECT statements only and prints counts—never patient,
medication, dose, LINE, image, or credential values. Review duplicate identities,
authority ties, linked/embedded mismatch, orphan rows, and unsnapshotted legacy
rows before enabling V2 writes.

Old application instances do not understand `baseSnapshotId` and can still
write legacy snapshots during a mixed-version window. V2 selection prevents a
later versionless legacy row from displacing an existing numbered V2 snapshot,
but it cannot provide complete optimistic-concurrency guarantees before the
first V2 write. Use a stop-write release gate:

1. Hold automatic deployment and confirm the database backup.
2. Run the read-only medication V2 preflight and review all nonzero counts.
3. Temporarily stop medication writes or drain old backend instances.
4. Deploy the backend to every instance before deploying the Family/Center UI.
5. Verify `/health`, `/ready`, and that no old backend instance remains.
6. Deploy LIFF assets, then run controlled Family, Center, pharmacist, and PDF
   QA on fictional/test data.
7. Re-enable normal operations only after current-set reads/writes and stale
   conflict behavior pass.

Do not run automatic repair, choose between ambiguous clinical records, or
mutate production data as part of preflight.
