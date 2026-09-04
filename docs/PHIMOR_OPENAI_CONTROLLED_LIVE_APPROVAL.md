# PHIMOR OpenAI Clinical Research controlled-live approval record

Status: **SYSTEM-OWNER APPROVED — DEPLOYMENT, READINESS AND ONE-USER ALLOWLIST REQUIRED BEFORE ACTIVATION**

## Commissioning snapshot

| Control | Recorded state |
| --- | --- |
| Current reviewed release SHA | `794c80775a82d404a354f93d202a4e333a64b1d8` |
| Current active mode | `deidentified_pilot` |
| Candidate future mode | `controlled_live` |
| Provider/model | OpenAI / `gpt-5.6-sol` |
| Retention | `STANDARD_RETENTION` |
| Data Sharing | `OFF` |
| Responses application state | `store:false` required |
| Zero Data Retention | `NO — NOT ENABLED / NOT VERIFIED` |
| Human review | `YES — mandatory` |
| Automatic send | `NO` |
| Raw PHI in web-search query | `NO — prohibited by technical boundary` |
| Controlled-live rollout allowlist | `REQUIRED — PHARMACIST_AI_RESEARCH_CONTROLLED_LIVE_USERS`; empty means deny all |
| Privacy notice version | `2569-09-1` |
| Family consent version | `2569-08-1` (preserved; notice update does not force blanket re-consent) |
| Controller/service operator | บริษัท แฮปปี้ แคร์ทูโก จำกัด |
| Privacy contact | `happycare2go@gmail.com` / LINE OA พี่หมอ |
| Kill switch | `PHARMACIST_AI_RESEARCH_ENABLED=false` |

The controlled-live allowlist is an additional server-only rollout gate. It
does not replace authenticated LINE identity, active pharmacist status,
assigned-case authorization, Care Profile authorization, explicit pharmacist
action, or safety acknowledgment.

## Organizational decision record

| Decision | Owner record |
| --- | --- |
| Approver | `PHIMOR System Owner` |
| Decision date | `2026-09-04` |
| Privacy Notice `2569-09-1` | `APPROVED` |
| OpenAI external-processor posture | `APPROVED` |
| Cross-border possibility | `ACCEPTED` |
| Standard Retention | `ACCEPTED` |
| Data Sharing | `OFF — CONFIRMED OPERATING POSTURE` |
| Responses application-state control | `store:false — REQUIRED` |
| Zero Data Retention | `NOT REQUIRED FOR CURRENT DECISION / NOT CLAIMED` |
| Controlled-live allowlist | `APPROVED`; initial rollout is exactly one verified pharmacist identity, configured server-side only |
| Controlled-live activation | `APPROVED AFTER DEPLOYMENT AND READINESS VERIFICATION` |

This is a PHIMOR product/system-owner decision, not an independent
legal-counsel certification. AI is a bounded processing method inside an
authorized PHIMOR care/pharmacist workflow and is not automatically a separate
consent purpose. A materially different use, including unrelated marketing,
unrelated research or model training, requires a separate purpose and
lawful-basis/consent review.

## Final activation gate

`PHARMACIST_AI_RESEARCH_MODE` must remain `deidentified_pilot` until this patch
is committed and deployed, Backend and LIFF run the same release SHA, readiness
passes, Privacy Notice `2569-09-1` is available, and exactly one verified
pharmacist identity is configured in the dedicated server-only allowlist.
An empty allowlist is a fail-closed configuration issue and controlled-live
requests remain denied.

This record does not claim legal completeness, a bespoke DPA, ZDR,
Thailand-only residency, zero provider retention, or an unverified healthcare
certification.
