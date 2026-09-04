# PHIMOR Pharmacist Clinical Research Assistant processing record

Status: **PRODUCTION PROCESSING RECORD — SYSTEM-OWNER APPROVED FOR CONTROLLED ROLLOUT**

Prepared: 2026-09-04

This bounded processing record distinguishes verified product/technical facts
from legal or organizational conclusions that still require accountable
approval. It is not legal advice and does not claim legal completeness.

## Processing record

| Field | Current record |
| --- | --- |
| Processing activity | PHIMOR Pharmacist Clinical Research Assistant |
| Controller/service operator | บริษัท แฮปปี้ แคร์ทูโก จำกัด |
| Controller/privacy contact | `happycare2go@gmail.com` / LINE OA พี่หมอ |
| Processor/service provider | OpenAI under the applicable OpenAI business/API terms and DPA; no bespoke or separately negotiated agreement is claimed |
| OpenAI DPA record | The generally available DPA effective 2026-01-01 states that OpenAI may process Customer Data on the Customer's behalf and acts as Data Processor; <https://openai.com/policies/data-processing-addendum/> |
| Purpose | Bounded clinical decision support and authoritative evidence research for an authorized pharmacist; not diagnosis, prescribing, treatment order, medication change, or automated communication |
| Data subjects | Patients/care recipients and, where necessary in authorized context, their representatives; exact deployed scope remains subject to accountable review |
| Personal-data categories | Minimized authorized consultation and care-context information; operational access/audit references are not sent merely because they exist |
| Sensitive-data categories | Health information, medication/allergy/condition information, and relevant confirmed measurements/results; PHIMOR treats health data as sensitive data |
| Source of data | Manually reviewed de-identified input in current `deidentified_pilot`; bounded authorized consultation/Care Profile context is available only in inactive future `controlled_live` |
| Processing operations | Access control, bounded context assembly, private planning, privacy validation, generic-topic web research, evidence validation, private synthesis, human review, metadata-only audit |
| Recipients/processors | OpenAI and applicable subprocessors under applicable terms; no automatic patient/recipient message |
| Cross-border posture | External AI processing may occur outside Thailand and may use subprocessors/infrastructure in multiple jurisdictions; PHIMOR does not claim Thailand-only residency or make an unapproved adequacy determination |
| Cross-border organizational approval | `ACCEPTED` by PHIMOR System Owner on 2026-09-04 for the bounded posture recorded here; not independent legal-counsel certification |
| OpenAI Data Sharing | `OFF — recorded operator confirmation dated 2026-09-03`; account-sensitive evidence remains outside Git |
| OpenAI application-state control | Every Responses API request uses `store:false`; this is not ZDR |
| OpenAI retention posture | `STANDARD_RETENTION`; ZDR is not enabled or verified |
| PHIMOR retention principle | Retain personal/health data only as long as necessary for service purpose, applicable requirements and the establishment, exercise or defense of legal claims; then delete or anonymize under the approved process; no unapproved fixed period |
| Current Family product control | Privacy Notice `2569-09-1`; existing applicable consent version `2569-08-1`, withdrawal available, and historical consent records preserved |
| Lawful-basis record | Each processing activity requires an authorized purpose and applicable basis/control. Versioned consent remains where applicable. AI used within an authorized care/pharmacist workflow is a bounded processing method, not automatically a new purpose; materially different marketing, unrelated research or model-training use requires separate review |
| Sensitive-health-data condition | Health data is treated as sensitive. The applicable legal condition for each deployed scope remains an accountable decision and is not invented by this record |
| Data-subject rights procedure | Existing authenticated PHIMOR workflow supports access/export, correction, restriction and deletion requests, subject to applicable requirements and preservation obligations |
| Human review | Mandatory; no automatic diagnosis, order, treatment change, or send |
| Security measures | Assigned-pharmacist/case authorization, feature flag, server-only credentials, `store:false`, dedicated controlled-live rollout allowlist, strict schemas, privacy validator, bounded/allowlisted web research, metadata-only audit and rate limits |
| Production product decision | `DEIDENTIFIED_PILOT ACTIVE`; `CONTROLLED_LIVE NOT YET ENABLED` |
| Responsible approver | `PHIMOR System Owner`; no personal identity inferred |
| Approval date/evidence | `2026-09-04`; repository approval record plus deployment/readiness evidence required before activation |
| Review/expiry date | Review on material purpose, provider, retention, Data Sharing, authorization or web-search-boundary change |

## Data-subject rights procedure

PHIMOR remains the authoritative holder of PHIMOR patient and clinical records.
`ai_interaction_audit` is metadata-only and is not a copy of prompts, research
queries, provider output, drafts, transcripts, or clinical records.

1. Receive the request through the approved authenticated/private channel and
   verify the data subject or authorized representative.
2. Clarify whether the request concerns AI-processing information, access,
   correction, deletion/restriction, objection, or consent withdrawal.
3. Locate relevant PHIMOR records and metadata-only audit entries using
   restricted internal references; do not copy PHI into ordinary tickets.
4. Explain the processing purpose, data categories, recipient/processor and
   human-review/no-auto-send boundary under the approved notice.
5. Apply an approved action only through existing controlled domain procedures;
   do not rewrite clinical provenance or delete required evidence ad hoc.
6. Assess provider implications against applicable terms and configured
   retention controls; do not promise unverified provider deletion or ZDR.
7. Record the decision, executor, approved action, preservation constraints and
   completion evidence using minimized metadata.

Applicable response periods, exemptions, legal holds and external-provider
request outcomes remain subject to accountable legal/privacy review.

## Incident and kill-switch procedure

Triggers include PHI in a web-search query, wrong-person context, unauthorized
pharmacist access, unexpected retention/configuration change, enabled Data
Sharing, content in logs, or credential compromise.

1. Set/confirm `PHARMACIST_AI_RESEARCH_ENABLED=false`.
2. Verify the endpoint makes no provider/web-search call and does not claim a
   research interaction occurred.
3. Preserve metadata-only evidence without copying PHI into ordinary tickets.
4. Rotate the server credential only through the authorized secret process if
   compromise is suspected.
5. Assess affected interactions, timeframe and recipients with minimum
   necessary access.
6. Complete the accountable incident and notification assessment before any
   re-enable decision.

## Evidence status

- `RECORDED`: controller and privacy contact supplied by the PHIMOR owner
- `RECORDED`: current OpenAI DPA wording/role, effective 2026-01-01
- `RECORDED`: Data Sharing off, Standard Retention, `store:false`, no ZDR claim
- `RECORDED`: `deidentified_pilot` current; `controlled_live` inactive
- `OWNER APPROVED 2026-09-04`: Privacy Notice `2569-09-1`, bounded OpenAI
  processor/cross-border posture, controlled-live allowlist and activation after
  deployment/readiness verification
- `PRESERVED`: consent version `2569-08-1`; the notice update does not itself
  invalidate prior valid consent
- `BOUNDED`: no claim that one lawful basis resolves every workflow and no
  independent legal-counsel certification
