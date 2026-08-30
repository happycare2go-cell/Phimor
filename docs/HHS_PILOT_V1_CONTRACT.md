# HHS Pilot V1 integration contract

This document is the sender contract for the controlled HHS pilot. The PHIMOR
endpoint remains vendor-neutral; there is no HHS-specific API or canonical
domain branch.

## Endpoint and authentication

```text
POST /api/integrations/v1/events
Authorization: Bearer pim_int_<16-hex-prefix>.<secret>
Content-Type: application/json
```

The credential is a server-to-server bearer secret issued once by PHIMOR for
one Integration Client. The resolved client determines Organization, allowed
Centers, and allowed event types. No value inside the event can widen that
scope. The request limit is 256 KiB after canonical normalization.

The authoritative event for HHS Daily Care is
`care.daily_report.finalized`. The optional platform event
`care.vitals.recorded` is store-only by default and does not send Family LINE.

The machine-readable JSON Schema is
[`contracts/hhs-pilot-v1-finalized-daily.schema.json`](contracts/hhs-pilot-v1-finalized-daily.schema.json).
It uses the snake-case form HHS should send. PHIMOR also accepts documented
camel-case aliases, but a sender must not mix conflicting aliases.

## Field contract

`REQUIRED` means the PHIMOR endpoint needs the field for this event.
`OPTIONAL` means absence remains absent. `CONDITIONAL` describes an HHS pilot
or data-dependent requirement without making it a global platform rule.

| Field | Status | Contract |
| --- | --- | --- |
| `schema_version` | REQUIRED | Exactly `1.0`. |
| `event_id` | REQUIRED | Stable per finalized publish intent; 1–160 characters matching `[A-Za-z0-9._:-]`. Never regenerate only because of retry. |
| `event_type` | REQUIRED | Exactly `care.daily_report.finalized`. |
| `occurred_at` | REQUIRED | RFC 3339 timestamp for the finalized event. |
| `subject.center_external_id` | REQUIRED | Exact external branch ID already mapped to the allowed PHIMOR Center. |
| `subject.resident_external_id` | REQUIRED | Stable external Resident ID. For the commissioned HHS policy, the first unique exact-name event learns this ID; later events use that mapping as authority. |
| `subject.expected_line_group_id` | OPTIONAL / SHOULD | HHS should send its expected Family group for reconciliation. It is not authorization or a destination. |
| `subject.display.first_name` | CONDITIONAL | Required with `last_name` only for the first exact-name learning attempt; display metadata after mapping. |
| `subject.display.last_name` | CONDITIONAL | Required with `first_name` only for the first exact-name learning attempt; display metadata after mapping. |
| `subject.display.room` | OPTIONAL | Matching hint and factual display when appropriate; never identity. |
| `data.external_record_id` | REQUIRED | Stable final Daily Care record identity; separate canonical dedupe boundary. |
| `data.care_date` | REQUIRED | Calendar date `YYYY-MM-DD`. |
| `data.shift` | CONDITIONAL | Required by HHS Pilot operations; optional to the generic platform. |
| `data.shift.code` | CONDITIONAL | HHS maps Day to `day`, Night to `night`. Other vendors may use other bounded normalized codes. |
| `data.shift.source_label` | OPTIONAL | Preserve the HHS source label `Day` or `Night`. |
| `data.observations` | OPTIONAL | Send only measurements actually recorded. Absence means no linked Vital set. |
| `data.care_items` | REQUIRED | A typed array of 1–30 final factual care items. It is never a keyed object. HHS final text uses `{ "item_type":"symptom_note", "value_type":"text", "value":"..." }`. |
| `data.recorded_by` | OPTIONAL | HHS may send a scalar external reference such as `STAFF_123`. The existing strict object form with `external_staff_id` and/or `display_name` remains accepted. |
| `data.finalized_by` | REQUIRED | HHS may send a scalar external reference such as `MANAGER_456`. The existing strict object form remains accepted. Scalar values are provenance only and never grant authorization. |
| `data.recorded_at` | REQUIRED | RFC 3339 timestamp of source recording. |
| `data.finalized_at` | REQUIRED | RFC 3339 timestamp, not earlier than `recorded_at`. |

Unknown fields are rejected. Missing measurements remain absent; PHIMOR does
not create null/default clinical observations.

## Finalized Daily example

All identifiers and people in this example are fictional.

```json
{
  "schema_version": "1.0",
  "event_id": "hhs-health-record-123",
  "event_type": "care.daily_report.finalized",
  "occurred_at": "2026-08-27T20:05:00+07:00",
  "subject": {
    "center_external_id": "pilot-branch-01",
    "resident_external_id": "pilot-resident-10025",
    "expected_line_group_id": "Cfictionalpilotfamilygroup",
    "display": {
      "first_name": "สมใจ",
      "last_name": "ใจดี",
      "room": "A-201"
    }
  },
  "data": {
    "external_record_id": "HHS_HEALTH_RECORD_123",
    "care_date": "2026-08-27",
    "shift": { "code": "day", "source_label": "Day" },
    "observations": [
      { "type": "temperature", "value": 36.6, "unit": "Cel" },
      { "type": "blood_pressure_systolic", "value": 128, "unit": "mm[Hg]" },
      { "type": "blood_pressure_diastolic", "value": 76, "unit": "mm[Hg]" },
      { "type": "pulse", "value": 72, "unit": "/min" },
      { "type": "spo2", "value": 97, "unit": "%" }
    ],
    "care_items": [
      {
        "item_type": "symptom_note",
        "value_type": "text",
        "value": "ข้อความสรุปที่ผู้จัดการตรวจสอบและยืนยันแล้ว"
      }
    ],
    "recorded_by": "STAFF_123",
    "finalized_by": "MANAGER_456",
    "recorded_at": "2026-08-27T19:55:00+07:00",
    "finalized_at": "2026-08-27T20:05:00+07:00"
  }
}
```

## HHS field-mapping worksheet

HHS field names are deliberately left blank until HHS Dev confirms them.
Do not infer the left column from the concept label.

| HHS field (HHS Dev fills) | Concept | PHIMOR field | Required? | Notes |
| --- | --- | --- | --- | --- |
| `TBD` | Branch ID | `subject.center_external_id` | REQUIRED | Exact preconfigured branch mapping. |
| `TBD` | Resident ID | `subject.resident_external_id` | REQUIRED | Exact mapping; never name matching. |
| `TBD` | First name | `subject.display.first_name` | OPTIONAL | Operational hint only. |
| `TBD` | Last name | `subject.display.last_name` | OPTIONAL | Operational hint only. |
| `TBD` | Room | `subject.display.room` | OPTIONAL | Operational hint/factual display. |
| `TBD` | LINE Group ID | `subject.expected_line_group_id` | SHOULD | Cross-check only; never direct routing. |
| `TBD` | Daily report record ID | `data.external_record_id` | REQUIRED | Stable after finalization. |
| `TBD` | Day/Night | `data.shift.code` + `data.shift.source_label` | HHS REQUIRED | Code is `day`/`night`; source label is `Day`/`Night`. |
| `TBD` | Temperature | observation `temperature` | CONDITIONAL | Send if recorded, unit `Cel`, `°C`, or `C`. |
| `TBD` | BP systolic | observation `blood_pressure_systolic` | CONDITIONAL | Send if recorded, unit `mm[Hg]` or `mmHg`. |
| `TBD` | BP diastolic | observation `blood_pressure_diastolic` | CONDITIONAL | Send if recorded, unit `mm[Hg]` or `mmHg`. |
| `TBD` | Pulse | observation `pulse` | CONDITIONAL | Send if recorded, unit `/min` or `bpm`. |
| `TBD` | SpO2 | observation `spo2` | CONDITIONAL | Send if recorded, unit `%`. |
| `TBD` | Final human-reviewed text | care item `symptom_note` | REQUIRED for HHS note flow | No audio, URL, Base64, AI draft, or raw transcription. |
| `TBD` | Recorder ID | `data.recorded_by` | OPTIONAL | HHS sends scalar `STAFF_{id}`. Object `external_staff_id` remains accepted for other senders. |
| `TBD` | Recorder name | `data.recorded_by.display_name` | OPTIONAL | Available only when the object form is used; PHIMOR does not infer a name from the scalar. |
| `TBD` | Manager ID | `data.finalized_by` | REQUIRED | HHS sends scalar `MANAGER_{id}`; PHIMOR preserves it as external finalizer provenance. |
| `TBD` | Manager name | `data.finalized_by.display_name` | OPTIONAL | Available only when the object form is used. |
| `TBD` | Recorded time | `data.recorded_at` | REQUIRED | RFC 3339 with offset. |
| `TBD` | Finalized time | `data.finalized_at` | REQUIRED | After successful final DB commit. |

The HHS Pilot expects temperature, systolic/diastolic BP, pulse, and SpO2 when
recorded. It does not require respiratory rate, blood glucose, or weight.
Those remain supported platform observation types for other Centers.

## HHS generation point and note boundary

```text
HHS Staff records
→ HHS internal review (and HHS-owned transcription if used)
→ HHS Manager confirms final
→ HHS final database commit succeeds
→ HHS durable/transactional outbox
→ PHIMOR event API
```

PHIMOR V1 receives only final human-reviewed text. It does not receive audio,
audio URLs, Base64, AI drafts, or raw transcription. PHIMOR availability must
not block the HHS final database commit.

## Group reconciliation

`expected_line_group_id` is optional at platform level and SHOULD be supplied
for the HHS pilot. It is an assertion to compare with PHIMOR's own verified
Family `GroupBinding`:

- match: the finalized record is stored and notification is eligible;
- mismatch: the record is stored, LINE is held, state is
  `group_binding_mismatch`;
- PHIMOR binding missing under the commissioned HHS strict policy: the event is
  ignored before inbox/canonical storage as `ignored_family_group_not_bound`;
- expected omitted with an existing verified binding: that PHIMOR binding
  remains the only eligible destination.

There is no “send anyway”. PHIMOR does not fall back to the owner for this HHS
policy and never routes directly to the vendor-supplied group ID.

## Responses, retryability, and safe rejection details

Terminal or retryable failures use:

```json
{
  "status": "rejected",
  "error": {
    "code": "CENTER_MAPPING_NOT_FOUND",
    "message": "ไม่พบการเชื่อมสาขาสำหรับระบบภายนอกนี้",
    "retryable": false,
    "request_id": "iref_opaque_reference"
  }
}
```

The response and operational inbox expose safe codes only. They never include
SQL errors, stack traces, credentials, LINE IDs, or the clinical payload.

| HTTP/status | Sender action |
| --- | --- |
| `202 processed` | Accepted and canonicalized. Do not resend. |
| `202 pending_subject_mapping` | Accepted durably; PHIMOR will reprocess after exact mapping. Do not resend. |
| `202 retrying` | Accepted durably; PHIMOR owns bounded internal retry. Do not resend. |
| `200 ignored_*` | Intentionally dropped by the commissioned-only identity policy. `accepted:false`, `stored:false`; do not retry automatically. Resend after operational correction only when the historical item is required. |
| `200` with `duplicate:true` and accepted/durable state | The same normalized payload is already processed or durably owned by PHIMOR. Stop retrying. |
| `400`, `401`, `403`, `409`, `413`, `422` with `retryable:false` | Terminal. Alert operations and correct contract/configuration. |
| `429` with `retryable:true` | Retry using the same event and payload after `Retry-After`. |
| `5xx` with `retryable:true` | Acceptance was not confirmed; retry same event/payload with backoff. |

`pending_subject_mapping` remains an accepted state for generic clients using
the legacy manual/pending policy. The commissioned HHS policy uses exact-name
learning + ignore + required Family GroupBinding, so unresolved, ambiguous, or
not-ready first events return HTTP 200 `ignored_*` without an inbox/clinical
payload. Under that strict policy, a missing verified Family GroupBinding is
ignored before canonical ingestion. When a verified binding exists but
`expected_line_group_id` mismatches it, canonical care may still be stored and
only the notification path is held; the external group value is never routing
authority. Optional-group legacy clients preserve their existing
store-without-notify behavior.

A duplicate of an inbox event already in terminal `rejected` or `dead` state
returns a terminal non-2xx response, never an accepted HTTP 200. This remains
true when the original terminal response was lost and HHS retries the same
event and payload.

Representative terminal public codes include `CENTER_MAPPING_NOT_FOUND`,
`RESIDENT_MAPPING_INVALID`, `CARE_PROFILE_RELATIONSHIP_INVALID`,
`INVALID_FINALIZED_RECORD`, `INVALID_EXTERNAL_RECORD_ID`,
`CAPABILITY_NOT_ENABLED`, `INTEGRATION_SCOPE_FORBIDDEN`, and
`EVENT_ID_REUSED`. Temporary errors use `RATE_LIMITED` or
`TEMPORARY_PROCESSING_UNAVAILABLE`.

## Idempotency and HHS outbox rules

- Identity is Integration Client + `event_id` + normalized SHA-256 payload.
- Same client, `event_id`, and normalized payload returns a safe duplicate.
- A same-payload retry never changes terminal `rejected`/`dead` state into an
  accepted response.
- Same `event_id` with different normalized content returns HTTP 409
  `EVENT_ID_REUSED`.
- `data.external_record_id` is an additional canonical dedupe boundary.
- A network retry must keep exactly the same event ID and payload.

HHS should use a transactional/durable outbox but PHIMOR does not require a
specific queue technology. Retry timeouts, 429, and 5xx with exponential
backoff; honor `Retry-After`. Terminal 4xx must create an HHS operational
alert. A 202 `pending_subject_mapping` is accepted and must not be resent for a
legacy-policy client. An HHS `ignored_*` response is terminal for that attempt;
after correcting commissioning, HHS may resend the same finalized snapshot if
the historical record is required because PHIMOR retained no payload.
