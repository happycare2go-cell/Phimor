# PHIMOR Integration Control Center V1

## Purpose

Integration Control Center is a read-only System Admin surface for answering two operational questions:

1. What is the latest persisted state of each external integration?
2. At which evidenced stage did an integration event stop or require attention?

It is not a clinical record browser, raw webhook viewer, or recovery console. It does not add retry, replay, reprocess, resend, or mapping mutation actions.

## Role and authorization

All Control Center endpoints are mounted under the existing System Admin platform router and use the existing System Admin authorization boundary. The feature does not grant Center, Family, pharmacist, Integration Client, or other actors new access.

The System Admin UI entry remains under `ระบบเชื่อมต่อ`. It preserves the existing integration directory and adds these read-only views:

- latest flow status and `ตรวจสอบรายละเอียด`
- `ดูการจับคู่ข้อมูล`
- `ดูการเชื่อมตัวตน`
- `ประวัติเหตุการณ์`

## Architecture and authoritative data sources

| Concern | Authoritative source | What V1 may prove |
| --- | --- | --- |
| Integration identity and lifecycle | `integration_clients` | Display name, source system, current client status |
| Event receipt and processing | `integration_event_inbox` | Persisted receipt, event type, processing state, safe error code, retry count and persisted timestamps |
| Current field mapping | Active Adapter binding/version and adapter mapping rules | Current configured source locator to canonical PHIMOR field mapping |
| Center identity | External Center mapping and the Center recorded on the inbox event | Current mapped/authorized Center where persisted |
| Resident identity | External Subject mapping plus current Resident relationship | Current mapped Resident state; learned/configured origin only when the audit record proves it |
| Care Profile relationship | Current Resident-to-Care Profile relationship | Whether the current relationship is valid; no clinical content |
| Family destination readiness | Current active GroupBinding and persisted event reconciliation state | Whether a verified Family destination exists; never the raw LINE Group ID |
| Notification state | Matching `notificationOutbox` metadata | Queue/provider state, bounded attempts, safe error code and timestamps |
| Ambiguity | Safe Integration identity ambiguity audit rows | Unresolved/ambiguous state and bounded candidate count |

Queries are bounded and server-side. Overview fetches one page of Integration Clients and one batched latest-event query. Identity and history screens use joined SQL projections with server-side pagination; they do not issue per-row data lookups.

## Flow stage semantics

The UI uses only these states:

- `completed`: persisted evidence proves the stage completed
- `current`: processing or delivery work is currently queued/in progress
- `waiting`: an upstream stage must complete first
- `attention`: a safe, actionable condition needs inspection
- `failed`: persisted evidence proves the stage failed or stopped
- `not_applicable`: the event does not use the stage
- `unknown`: current persistence cannot prove the state

The displayed stages are:

1. `รับข้อมูล`
2. `ตรวจรูปแบบข้อมูล`
3. `แปลงข้อมูล`
4. `ระบุศูนย์`
5. `จับคู่ผู้พัก`
6. `เชื่อม Care Profile`
7. `บันทึกข้อมูล`
8. `ระบุปลายทางครอบครัว`
9. `ส่งการแจ้งเตือน`

An inbox row proves that the canonical envelope passed the pre-inbox boundary and that an authorized Center was resolved. It does not prove which Adapter version transformed the original external payload. Therefore the historical `แปลงข้อมูล` stage is `unknown` unless per-event evidence is added in a future version.

Safe processing error codes select the most specific evidenced problem stage. For example:

- Center mapping failure -> `ระบุศูนย์`
- subject/Resident mapping failure -> `จับคู่ผู้พัก`
- Care Profile relationship failure -> `เชื่อม Care Profile`
- canonical persistence failure -> `บันทึกข้อมูล`
- GroupBinding failure -> `ระบุปลายทางครอบครัว`
- notification retry/dead-letter -> `ส่งการแจ้งเตือน`

## Latest Flow overview

Endpoint:

`GET /api/admin/platform/integration-control/overview`

The response is a bounded privacy-safe page. Each item contains Integration display context, latest meaningful event time, masked event reference, canonical stage states, and one primary attention reason. The response excludes the canonical payload, raw event body, clinical content, internal subject identifiers, LINE destinations, credentials, and provider response bodies.

The overview deliberately stays compact. It is not an event log; operators open the secondary history screen for investigation.

## Field Mapping Inspector

Endpoint:

`GET /api/admin/platform/integration-clients/:integrationClientId/control/mapping`

When a current Adapter binding exists, the inspector projects its authoritative mapping rules as:

`source field/path -> canonical field -> PHIMOR meaning`

It also displays required/optional state and the configured transformation label. It does not display sample payload values.

When a client uses the canonical PHIMOR contract without an Adapter binding, the view explicitly reports canonical passthrough and an empty Adapter mapping list. It does not invent HHS-specific mappings.

## Identity Inspector

Endpoint:

`GET /api/admin/platform/integration-clients/:integrationClientId/control/identities`

The inspector projects the current chain:

`External Integration -> External Center -> External Resident/Subject -> PHIMOR Center -> Resident -> Care Profile -> Family destination`

Primary states are translated for operators. Match origin is shown as learned or configured only when persisted audit evidence supports it. Legacy rows with no reliable origin use `unknown`; ambiguity remains unresolved.

Resident names and rooms appear only as the minimum System Admin operational identity context. The projection contains no medication, laboratory, report, document, contact, or other clinical content. Family destination is a readiness state, never a raw LINE identifier.

Existing resolution work remains in the Work Queue. The inspector may direct an operator to the appropriate queue but cannot mutate a mapping.

## Event history and troubleshooting

Endpoints:

- `GET /api/admin/platform/integration-control/history`
- `GET /api/admin/platform/integration-control/history/:eventKey`

History defaults to 20 rows and has a hard maximum of 50. Server-side filters support Integration Client, persisted status, Bangkok-local date range, operational category, and an exact masked event-reference suffix. There is no free-text raw-payload search.

The list gives the Integration, masked reference, received time, human outcome, problem stage, safe summary, and `ดูรายละเอียด`. Detail explains the source, event type, stage evidence, identity state, Care Profile state, Family destination readiness, notification evidence, and the next operational check. Technical details are collapsed by default and contain only safe references, safe error codes, processing state, bounded attempt counts, and explicit evidence limitations.

## Notification evidence

Notification wording is intentionally conservative:

- `queued`, `pending`, or `sending` means queued/in progress, not delivered.
- `retrying` and `dead_letter` link the operator to the existing Work Queue for action context.
- `sent` means the provider accepted the send request. PHIMOR V1 has no recipient-level delivery receipt and must not say the message reached the recipient.

No notification destination, message body, provider response body, or credential is returned.

## Work Queue boundary

The two surfaces serve different questions:

- Work Queue: "Which human exception currently needs action?"
- Integration Control Center: "How did an Integration event flow, and where did persisted evidence stop?"

Retry/dead-letter items remain owned by Work Queue. Control Center shows their event context and links to Work Queue; it does not duplicate recovery controls or create a second exception lifecycle.

## Privacy and security

Control Center must never return or log:

- raw integration payload or webhook body
- medical free text, medication, laboratory, document, or other clinical payload
- raw LINE user/group/destination IDs
- credentials, tokens, signatures, headers, or secrets
- raw provider responses or arbitrary exception messages

References are masked for display. A raw internal event key is used only as a bounded API routing key and is not primary UI content. Queries project a boolean Family-destination result instead of the destination value.

The feature adds no polling. Refresh is explicit. It does not relax existing production authentication, request/download security, optimized authorization queries, AI content boundaries, or safe operational logging.

## Proof limitations and known gaps

V1 deliberately reports unavailable evidence instead of inferring success:

1. Envelope or Center-resolution failures that occur before inbox insertion have no event-history row. They remain visible only through existing safe request/error correlation, not Control Center history.
2. The Adapter version used by an individual historical event is not persisted. Current mapping can be inspected, but historical transformation completion/version is `unknown`.
3. Notification provider acceptance is not recipient delivery proof.
4. The unique external event ID enforces idempotency, but duplicate receipt count/timestamps are not persisted. V1 cannot say how many duplicate deliveries occurred.
5. Legacy inbox rows may lack Resident, Care Profile, GroupBinding, notification, or timestamp evidence. Missing fields remain `ไม่มีข้อมูล`, `ไม่ทราบ`, or `ยังตรวจสอบไม่ได้`.
6. Ignored commissioned-only identity outcomes that intentionally store no inbox or clinical payload cannot be reconstructed in Control Center history.
7. Identity resolution and GroupBinding remediation remain in their existing authorized workflows.

These limitations require neither raw-payload retention nor a schema migration for V1.

## Deferred improvements

Potential future work, subject to separate privacy and schema review:

- persist a safe per-event Adapter/version reference
- persist privacy-safe pre-inbox outcome metadata without retaining payloads
- persist bounded duplicate-receipt metrics
- consume recipient delivery evidence if a provider supplies an authoritative, privacy-safe receipt contract
- add cross-screen correlation links where an existing authorized Work Queue item has a stable safe reference

Manual retry, replay, reprocess, resend, raw payload browsing, clinical search, and mapping edits remain out of scope.
