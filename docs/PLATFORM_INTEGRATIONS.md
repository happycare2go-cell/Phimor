# PHIMOR Platform integrations

PHIMOR and Care2Go are first-party services. External care-center software is
onboarded through the vendor-neutral Organization, Integration Client,
credential, Center scope, event scope, and exact external mapping foundation.
The canonical domains do not branch on a vendor name.

## Trust and tenant boundary

- A bearer credential resolves the trusted Integration Client, Organization,
  and `source_system`; values in a clinical event cannot replace that identity.
- Center and event scopes must be explicitly granted by System Admin.
- Existing External Center and Resident mappings are authoritative. A client
  may optionally bootstrap a missing mapping from exactly one normalized full
  name match inside its Organization and explicit Center scopes. Room, phone,
  aliases, fuzzy/AI matching, and LINE groups are never identity authority.
- The mapped Resident must belong to the mapped Center and Care Profile.
- Unknown Residents follow the Integration Client policy: legacy/manual clients
  may use `pending_subject_mapping`; commissioned-only clients return a safe
  HTTP 200 `ignored_*` result without retaining clinical payload.
- Credential secrets are displayed once and only salted hashes are stored.

The Center capabilities `vital_signs_v1` and `daily_care_v1` are OFF when the
corresponding row is missing. Only System Admin can change them. Center owners,
managers, staff, and Integration Clients cannot enable capabilities.

## Finalization responsibility

An external system owns its staff drafting, transcription, review, and approval
workflow. It sends PHIMOR only the final approved snapshot. PHIMOR does not need
the external draft or source audio and does not call the vendor back to fetch
the final clinical values.

The safe sequence is:

```text
external staff records
→ external review/approval
→ external database commit and outbox
→ care.daily_report.finalized
→ PHIMOR canonical finalized Daily Care
→ PHIMOR GroupBinding reconciliation
→ asynchronous Family notification intent
```

Native PHIMOR Centers use the same finalized canonical record downstream, but
PHIMOR supplies the review loop:

```text
staff submits
→ owner/manager reviews
→ return for correction and resubmit, or finalize
→ asynchronous Family notification intent
```

Submitted and returned reports are stored but are not Family-visible and do not
create a Family notification. A finalized report is not rolled back when LINE
is temporarily unavailable.

## Endpoint and common envelope

New integrations send events to:

```text
POST /api/integrations/v1/events
Authorization: Bearer <one-time-issued-integration-credential>
Content-Type: application/json
```

### Optional Field Picker Adapter V1

Canonical clients continue to send the strict envelope below without any new
configuration. For a commissioned client whose native payload cannot be changed,
System Admin may open a 30-minute capture window under **ระบบเชื่อมต่อ → Integration
Client detail → การจับคู่ข้อมูล**. Authentication, scope, request size, and rate
limits run before the next payload is captured. Capture never runs identity
learning, creates clinical data, enqueues a notification, or contacts LINE.

The operator maps PHIMOR fields to temporary sample values and confirms a preview.
Only source locators are stored in the immutable active adapter; unmapped fields
are ignored. Runtime transformation occurs before this document's strict
`normalizeEnvelope()` contract, with no AI or heuristic remapping. Missing mapped
fields, type drift, or unfamiliar units fail closed as `ADAPTER_SOURCE_CHANGED`.
Samples expire within 24 hours and their payload is cleared immediately after
activation. V1 supports only `care.daily_report.finalized`; `care.vitals.recorded`
and all identity, GroupBinding, idempotency, and finalized-record rules are unchanged.

The controlled HHS sender profile, exact snake-case schema, field-mapping
worksheet, credential plan, and production checklist are documented in
[`HHS_PILOT_V1_CONTRACT.md`](HHS_PILOT_V1_CONTRACT.md) and
[`HHS_PILOT_V1_RUNBOOK.md`](HHS_PILOT_V1_RUNBOOK.md).

The request is limited to 256 KiB and unknown fields are rejected. Both camel
case and the documented snake case aliases are normalized deterministically.

```json
{
  "schema_version": "1.0",
  "event_id": "vendor-stable-event-1001",
  "event_type": "care.vitals.recorded",
  "occurred_at": "2026-08-27T07:30:00+07:00",
  "subject": {
    "center_external_id": "branch-01",
    "resident_external_id": "resident-10025",
    "display": {
      "first_name": "สมใจ",
      "last_name": "ใจดี",
      "room": "A-201"
    }
  },
  "recorder": {
    "external_staff_id": "staff-417",
    "display_name": "ผู้ดูแลกะเช้า"
  },
  "data": {}
}
```

Display and recorder fields are optional provenance and review hints. They do
not grant access or replace exact subject mapping.

## `care.vitals.recorded`

Standalone Vital events are stored in canonical Vital history. By default they
do **not** create a Family LINE notification. Immediate clinical alerts require
a separately approved rule product and are not inferred here.

`data.observations` is a partial array: send only facts actually measured.
Unknown types and units fail with stable validation errors.

| type | accepted unit | optional context |
| --- | --- | --- |
| `temperature` | `Cel`, `°C`, `C` | none |
| `blood_pressure_systolic` | `mm[Hg]`, `mmHg` | none |
| `blood_pressure_diastolic` | `mm[Hg]`, `mmHg` | none |
| `pulse` | `/min`, `bpm` | none |
| `spo2` | `%` | none |
| `respiratory_rate` | `/min`, `breaths/min` | none |
| `blood_glucose` | `mg/dL`, `mmol/L` | `fasting`, `before_meal`, `after_meal`, `random`, `unspecified` |
| `weight` | `kg` | none |

```json
{
  "external_record_id": "vital-10025-20260827-01",
  "observations": [
    { "type": "temperature", "value": 36.6, "unit": "Cel" },
    { "type": "blood_pressure_systolic", "value": 128, "unit": "mm[Hg]" },
    { "type": "blood_pressure_diastolic", "value": 76, "unit": "mm[Hg]" },
    { "type": "blood_glucose", "value": 108, "unit": "mg/dL", "context": "fasting" },
    { "type": "weight", "value": 54.2, "unit": "kg" }
  ]
}
```

PHIMOR preserves glucose in its supported source unit; it does not guess a
conversion between `mg/dL` and `mmol/L`. The ingestion path adds no normal,
abnormal, high, low, critical, diagnosis, or recommendation label.

## `care.daily_report.finalized`

This event means the external system has committed and approved the complete
Family-facing snapshot. The prior experimental event name
`care.daily_report.recorded` is not accepted by the V1 registry. Migration 0012
also stops if it finds legacy inbox rows under that ambiguous event name so an
operator must review them instead of silently changing their meaning.

```json
{
  "schema_version": "1.0",
  "event_id": "vendor-final-10025-20260827-day",
  "event_type": "care.daily_report.finalized",
  "occurred_at": "2026-08-27T20:05:00+07:00",
  "subject": {
    "center_external_id": "branch-01",
    "resident_external_id": "resident-10025",
    "expected_line_group_id": "Cxxxxxxxxxxxxxxxx",
    "display": {
      "first_name": "สมใจ",
      "last_name": "ใจดี",
      "room": "A-201"
    }
  },
  "data": {
    "external_record_id": "daily-10025-20260827-day",
    "care_date": "2026-08-27",
    "shift": { "code": "day", "source_label": "D" },
    "observations": [
      { "type": "pulse", "value": 72, "unit": "/min" },
      { "type": "spo2", "value": 97, "unit": "%" }
    ],
    "care_items": [
      { "item_type": "nutrition", "value_type": "text", "value": "รับประทานอาหารได้" },
      { "item_type": "general_condition", "value_type": "text", "value": "พูดคุยได้" }
    ],
    "recorded_by": {
      "external_staff_id": "staff-417",
      "display_name": "ผู้ดูแลกะเช้า"
    },
    "finalized_by": {
      "external_staff_id": "manager-02",
      "display_name": "ผู้จัดการ"
    },
    "recorded_at": "2026-08-27T19:55:00+07:00",
    "finalized_at": "2026-08-27T20:05:00+07:00"
  }
}
```

`care_items` supports `shift`, `nutrition`, `fluid_intake`, `sleep_rest`,
`bowel_movement`, `urination`, `activity`, `mood_behavior`,
`general_condition`, and `symptom_note`. Values are explicitly text, numeric,
or boolean; only numeric values may have a unit. Missing observations and items
remain absent.

`shift.code` is a normalized, bounded code and `shift.source_label` preserves
the source label. `day` and `night` are useful for a two-shift pilot but the
platform is not limited to two shifts or two reports per day.

For the HHS pilot, source labels for its Day and Night shifts may map to `day`
and `night`; one finalized shift report normally means one Family notification,
so its expected operational maximum is two Daily Care pushes per Resident per
day. This is an HHS policy example, not a global platform constraint. HHS
Integration V1 sends final approved text/data only; source audio remains in the
HHS system and is not sent to PHIMOR.

Observations embedded in the finalized snapshot become a linked canonical
Vital set inside the same care transaction. They are rendered in the one Daily
Care notification and do not create a second Vital notification.

## Expected LINE group reconciliation

`subject.expected_line_group_id` is optional. It is a routing assertion for
cross-system reconciliation, not authentication, patient identity, or a LINE
destination. Only an active PHIMOR `GroupBinding` for the resolved Care Profile
is authoritative. The outcomes below apply after identity admission, including
clients using `optional_for_ingest`. A client configured
`required_before_ingest` is intentionally ignored before inbox/canonical
storage when no active Family GroupBinding exists.

- Expected group omitted: use the existing verified Family GroupBinding and,
  if none exists, the established Care Profile owner fallback policy.
- Expected group matches the PHIMOR binding: store the finalized record and
  queue the notification to that verified PHIMOR binding.
- Expected group differs: store the finalized record, do not queue LINE, and
  persist `group_binding_mismatch`.
- Expected group is present but no verified binding exists: store the finalized
  record, do not queue LINE, and persist `group_binding_missing`.

When an expected group is supplied, PHIMOR never falls back to the profile
owner. This prevents bypassing the reconciliation assertion. A group bound to
another Care Profile or Center cannot be used. Correcting the PHIMOR binding
does not rewrite clinical data; System Admin may explicitly retry routing for
the already processed finalized event.

System Admin endpoints provide minimized pending-subject and routing status:

```text
GET  /api/admin/platform/pending-subjects
POST /api/admin/platform/pending-subjects/map
GET  /api/admin/platform/integration-events/status
POST /api/admin/platform/integration-events/:integrationEventId/reconcile-group
```

Operational status includes Integration Client, Organization, Center, external
subject, mapping status, group match/mismatch/missing, and notification intent
state. LINE routing identifiers are masked in the API projection. Full Daily
Care and Vital payloads are not returned by this operational endpoint.

## Pending subjects

A valid event for an unknown external Resident is durably retained as
`pending_subject_mapping`; no canonical record is attached to another person
and no LINE notification is created. System Admin performs an exact mapping,
after which pending events are reprocessed in arrival order. Name, room, and
expected group are never fuzzy identity keys.

Automatic-policy clients search only active Residents with the current linked
Care Profile in explicitly allowed active Centers. Exact first + last name is
normalized with Unicode normalization and collapsed whitespace; Latin text is
case-insensitive while Thai remains exact. Exactly one eligible candidate
learns the external Center and Resident IDs atomically with inbox acceptance.
An active verified PHIMOR Family GroupBinding may be required by client policy.
An existing mapping is never replaced because a later display name changes.

Commissioned-only ignored statuses include center not commissioned, missing or
unresolved/ambiguous subject name, inactive Resident, unready Care Profile,
missing verified Family group, mapping conflict, and client-scope mismatch.
They return HTTP 200 with `accepted:false` and `stored:false`; malformed schema,
unsupported fields/types/units, authentication, scope, payload size, and reused
event ID conflicts retain their normal 4xx contract. Ignored events have no
inbox row, so their event ID/payload hash is intentionally not retained. A
later replay after an operational correction is a fresh attempt.

Ambiguity produces one deduped operational alert containing only safe external
references, normalized display name, candidate Center names, timestamps, and
count. It contains no clinical payload, Family/LINE identity, group ID, or
credential. Per-client ignored/processed telemetry uses a fixed bounded set of
counter keys.

## Acknowledgement, idempotency, and recovery

- The inbox identity is `(Integration Client, event_id)` plus a SHA-256 of the
  normalized payload.
- Repeating the same identity and payload returns the existing result.
- Reusing the event ID with changed content returns HTTP 409 and creates no
  second canonical record.
- External record IDs provide an additional canonical idempotency boundary.
- Deterministic validation errors are rejected. Transient processing failures
  retry with bounded backoff and become dead after five attempts.
- The server invokes due-event processing once per minute.

Rejected events and pre-inbox request failures use one minimized response
contract with `status`, a safe `error.code`, Thai `message`, explicit
`retryable`, and an opaque `request_id`. Accepted unknown subjects remain HTTP
202 `pending_subject_mapping`, not an error. Inbox `last_error_code` stores the
same safe public code shown to System Admin; raw SQL/provider errors and
clinical payloads are not exposed through operational projections.

Family notification intent identity remains canonical report + projection
version + recipient. The outbox claim/lease is retained. Each LINE target has
one persistent UUID `X-Line-Retry-Key`, used on the first push and every retry,
including worker recovery. A documented LINE 409 indicating that the retry key
was already accepted is treated as provider acceptance.

The standard five-attempt schedule retries after 2, 4, 8, and 16 minutes, a
30-minute first-to-last horizon (normally about 32 minutes with the scheduler).
Ambiguous delivery is not retried beyond LINE's 24-hour retry-key window. A
long outage can therefore dead-letter an ambiguous intent for human review;
the provider key is not indefinite exactly-once delivery.

## Family notification policy

PHIMOR follows “store many, notify few”:

| Canonical record state | Store | Family push |
| --- | --- | --- |
| finalized Daily Care | yes | yes, after routing reconciliation |
| submitted Daily Care | yes | no |
| returned Daily Care | yes | no |
| standalone Vital | yes | no |

The finalized Daily notification factually renders available Care Profile
name, room, Center, care date/time, shift, linked Vital observations, Daily
Care items, recorder, and optional finalizer display. It omits missing fields
and technical IDs. It does not add thresholds, interpretation, diagnosis, or
medical advice. LINE delivery failure never rolls back finalized care.

## Legacy endpoint

`POST /api/external/vitals` with `X-Center-Api-Key` remains a deprecated
compatibility route. It is not the canonical foundation for a new vendor.
`Centers.external_api_key` is redacted from ordinary projections and remains
pending an explicitly approved retirement plan.

## Vendor onboarding checklist

Before a sandbox integration, agree on:

1. Organization, Integration Client, and credential owners;
2. exact external Center IDs and PHIMOR Center mappings;
3. Center and event scopes and required Center capabilities;
4. exact external Resident mapping operations;
5. stable event and external record ID generation;
6. RFC 3339 timestamps, shift codes/source labels, and supported units;
7. the external final-approval and outbox boundary;
8. optional expected Family group cross-check and mismatch ownership;
9. network retry behavior using the same event ID and identical payload;
10. operational handling of pending, mismatch, retry, and dead states.

Do not put integration credentials, LINE IDs, phone numbers, source audio, or
unnecessary free-form health history in operational matching metadata.

## Reusable Field Picker adapters

Field transformations belong to a trusted `sourceSystem` and event/payload
shape, not to a Center or branch. Commission the first compatible client once;
later clients with the same authenticated source identity can bind the same
active template version after a representative sample passes structural and
canonical validation. Runtime values never influence the structural fingerprint.

New unmapped fields are ignored while a deduplicated operational notice is made
available. Missing mapped fields, incompatible types, or changed array
discriminators fail closed without guessing. Admin edits always create a draft
version, and activation or rollback affects future events only. Client-specific
credentials, scopes, external IDs, mappings, inbox rows, and clinical access
remain isolated behind each Integration Client binding.
