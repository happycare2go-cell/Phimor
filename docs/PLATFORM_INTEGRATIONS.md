# PHIMOR Platform integrations

Platform P0 introduces reusable external-integration identity. PHIMOR and
Care2Go remain first-party services; external care-center software is onboarded
through an Organization and Integration Client configured by System Admin.

## Trust boundary

- The bearer credential resolves the Integration Client, Organization and
  trusted `source_system`.
- Center and event-type access must be explicitly granted.
- External Center and Resident identities use exact mappings. Names are for
  human review only and never authorize or automatically merge a person.
- An unknown resident in an otherwise valid tenant is a future operational
  `pending_subject_mapping` state, not a cross-tenant security error.
- Credential tokens are shown once. Only a salted scrypt hash and public prefix
  are stored. Rotation and revocation are explicit and audited without secrets.

## Capability control

`vital_signs_v1` and `daily_care_v1` default to off when their database row is
missing. Only System Admin platform APIs can change a Center capability. Center
owners and managers have no feature-toggle endpoint.

## Deprecated legacy endpoint

`POST /api/external/vitals` and `X-Center-Api-Key` remain temporarily for
backward compatibility. They are not the canonical integration foundation and
must not be used for a new customer. The route marks responses as deprecated,
uses the server-derived source `legacy_center_api_key`, and stores any reported
source only as non-authoritative compatibility metadata.

The legacy `Centers.external_api_key` is retained until an explicitly approved
retirement plan is complete. It is redacted from Center, registration and
ordinary Admin projections. New integrations must use Integration Clients.

## Event ingestion contract (v1)

New integrations send events to:

```text
POST /api/integrations/v1/events
Authorization: Bearer <one-time-issued-integration-credential>
Content-Type: application/json
```

The server accepts at most 256 KiB and rejects unknown fields. The credential,
event scope, Center scope, active Center, exact external Center mapping and
Center capability are all checked by the backend. A successful HTTP response
does not bypass those checks.

The common envelope is:

```json
{
  "schemaVersion": "1.0",
  "eventId": "hhs-event-20260827-0001",
  "eventType": "care.vitals.recorded",
  "occurredAt": "2026-08-27T02:15:00.000Z",
  "subject": {
    "externalCenterId": "hhs-center-01",
    "externalResidentId": "hhs-resident-204",
    "displayName": "optional matching hint",
    "room": "optional matching hint"
  },
  "recorder": {
    "externalStaffId": "optional-stable-staff-id",
    "displayName": "optional recorder display name"
  },
  "data": {}
}
```

`firstName`, `lastName`, `displayName`, and `room` are optional operational
matching hints. They never grant access and never replace the exact external
subject mapping. Recorder fields are optional provenance only and never grant
staff or Care Profile authorization.

### Vital Signs event

Use `eventType: care.vitals.recorded`. The `data` object contains an optional
stable `externalRecordId` and `observations`. Supported measurements and input
units are deliberately bounded:

| measurementType | accepted sourceUnit |
| --- | --- |
| `temperature` | `Cel`, `°C`, `C` |
| `blood_pressure_systolic` | `mm[Hg]`, `mmHg` |
| `blood_pressure_diastolic` | `mm[Hg]`, `mmHg` |
| `pulse` | `/min`, `bpm` |
| `spo2` | `%` |
| `respiratory_rate` | `/min`, `breaths/min` |

```json
{
  "externalRecordId": "vital-204-001",
  "observations": [
    { "measurementType": "temperature", "numericValue": 36.8, "sourceUnit": "Cel" },
    { "measurementType": "pulse", "numericValue": 72, "sourceUnit": "/min" }
  ]
}
```

PHIMOR stores the factual source values and deterministic canonical unit only.
This ingestion path does not diagnose, score risk, or infer a clinical state.

### Daily Care event

Use `eventType: care.daily_report.recorded`. Supported `itemType` values are
`shift`, `nutrition`, `fluid_intake`, `sleep_rest`, `bowel_movement`,
`urination`, `activity`, `mood_behavior`, `general_condition`, and
`symptom_note`. A value is explicitly `text`,
`numeric`, or `boolean`. Only numeric values may have `sourceUnit`.

```json
{
  "externalRecordId": "daily-204-001",
  "items": [
    {
      "itemType": "nutrition",
      "valueType": "text",
      "textValue": "รับประทานอาหารได้ครึ่งจาน"
    },
    {
      "itemType": "fluid_intake",
      "valueType": "numeric",
      "numericValue": 850,
      "sourceUnit": "mL"
    }
  ]
}
```

`data.vitalSigns` may optionally carry `{ occurredAt, observations }`. Those
observations use the same Vital Signs validation and are committed in the same
database transaction as the Daily Care report.

## Acknowledgement, idempotency, and recovery

- New valid events return HTTP 202. The response status is normally
  `processed`, `pending_subject_mapping`, `retrying`, `rejected`, or `dead`.
- Repeating the same `eventId` for the same Integration Client and byte-equivalent
  normalized payload returns the existing result with `duplicate: true`.
- Reusing an `eventId` with changed content returns HTTP 409 and creates no
  second canonical record.
- An unknown external resident is durably retained internally and returned as
  `pending_subject_mapping` with
  `pendingReason: subject_mapping`. It is not matched by name.
- A System Admin can inspect the minimized pending-subject projection and make
  an exact Resident mapping. Pending events are then reprocessed in order.
- Transient failures use bounded exponential retry. After five processing
  attempts the inbox row becomes `dead`; it is retained for operational review.
- The production server invokes the due-event processor once per minute.

When processed, the safe response contains only the external event identity,
status, and canonical resource type/id. It does not expose Care Profile health
context, LINE identities, integration secrets, or raw database errors.

## Family notification boundary

Native Center writes and external events use the same canonical Vital Signs and
Daily Care services. After a canonical record and its append-only event exist,
a recipient-specific notification intent is inserted into the existing
notification outbox in the same transaction. Delivery is asynchronous and a
LINE delivery failure cannot undo the saved care record.

The notification is a privacy-minimized factual care report. When present in
the canonical record it may contain the Care Profile display name, room,
Center/branch name, care time, shift, recorded Vital values, Daily Care items,
and a safe recorder display name. Missing fields are omitted. PHIMOR does not
add normal/abnormal labels, thresholds, diagnosis, advice, or recommendations.
It never includes internal/external technical IDs or credentials. An active
Family Group Binding is preferred; the established active Care Profile owner
is the fallback. The integration payload cannot choose the LINE destination,
and no unsafe recipient is guessed.

A Daily Care report with linked Vital Signs creates one coherent notification;
the nested Vital write suppresses its separate notification. Standalone Vital
records retain their own recipient-specific canonical dedupe identity.

Each notification target stores one UUID provider retry key in the existing
outbox before delivery. The first LINE push and every worker retry use that
same `X-Line-Retry-Key`. A LINE HTTP 409 for an already accepted retry key is
treated as provider acceptance. This complements, but does not replace, the
PHIMOR dedupe key, delivery claim, and lease.

Delivery uses five total attempts with exponential waits of 2, 4, 8, and 16
minutes: the normal first-to-last retry horizon is 30 minutes. The scheduler
runs every two minutes, so a newly queued intent normally reaches its final
attempt within about 32 minutes. An ambiguous delivery is never retried after
24 hours from its first provider attempt because LINE retains retry-key state
for only 24 hours. A process outage lasting beyond that boundary can leave an
ambiguous notification dead-lettered for human review; retry keys do not
provide indefinite exactly-once delivery.

## HHS onboarding draft

This v1 contract is the proposed HHS integration boundary; HHS-specific code is
not required. Before sandbox testing, PHIMOR System Admin and HHS must agree on:

1. one Organization and source-system identifier;
2. one or more Integration Clients and credential owners;
3. the exact external Center IDs and PHIMOR Center mappings;
4. allowed Center and event-type scopes;
5. exact external Resident mapping operations and ownership of unmatched cases;
6. stable HHS `eventId` and `externalRecordId` generation;
7. UTC/RFC 3339 timestamp semantics and the supported source units above;
8. retry policy for network/5xx responses and reconciliation of `pending` or
   `dead` events without issuing changed payloads under an old `eventId`.

The operational save boundary stays in HHS: HHS commits its own care record and
outbox first, then its worker delivers to PHIMOR asynchronously. A PHIMOR outage
must not fail or roll back the HHS save. Network/5xx delivery is retried with the
same event ID and identical payload. A PHIMOR `pending` subject response is a
durable acceptance and does not require HHS to resend the event.

Credentials must be exchanged outside clinical payloads, stored as secrets,
and rotated through the System Admin integration API. Do not place credentials,
LINE IDs, phone numbers, or free-form resident health history in this document
or in matching metadata.

The legacy `/api/external/vitals` endpoint is not part of the HHS contract.
