# PHIMOR Pharmacist Clinical Research Assistant processing record

Status: **TEMPLATE — PENDING HUMAN/LEGAL REVIEW**

Prepared: 2026-09-03

This is a bounded Record of Processing Activities/processing-register
template. It records verified technical facts and leaves legal or contractual
decisions unresolved. It is not legal advice.

## Processing record

| Field | Current record |
| --- | --- |
| Processing activity | PHIMOR Pharmacist Clinical Research Assistant |
| Controller entity | `PENDING HUMAN/LEGAL REVIEW` |
| Controller/privacy contact | `PENDING HUMAN/LEGAL REVIEW` |
| Processor/service provider | OpenAI; exact contracting entity and processor role `PENDING HUMAN/LEGAL REVIEW` |
| Purpose | Assist an authorized pharmacist by organizing bounded clinical context, researching authoritative references, and preparing decision-support material for human review. Not diagnosis, prescribing, treatment decision, or automated communication. |
| Data subjects | Patients/care recipients and, where present in necessary consultation context, their authorized representatives; exact scope `PENDING HUMAN/LEGAL REVIEW` |
| Personal-data categories | Minimized consultation and care-context information; operational access/audit references |
| Sensitive-data categories | Health information, medication/allergy/condition information, and relevant confirmed measurements/results |
| Source of data | Authorized PHIMOR consultation and Care Profile domains; Stage 1 uses manually prepared de-identified pilot material only |
| Processing operations | Access control, bounded context assembly, private planning, privacy validation, bounded external web research, private synthesis, human review, metadata-only audit |
| Recipients/processors | OpenAI and applicable subprocessors `PENDING HUMAN/LEGAL REVIEW`; no automatic recipient/patient message |
| Cross-border transfer assessment | `PENDING HUMAN/LEGAL REVIEW` |
| OpenAI data sharing | `NO — confirmed manually by PHIMOR operator in OpenAI Platform on 2026-09-03`; account-sensitive evidence retained outside Git |
| OpenAI retention posture | `STANDARD_RETENTION — conservative posture; no approved MAM/ZDR evidence` |
| DPA status | `DOCUMENT_AVAILABLE_PENDING_INTERNAL_APPROVAL` |
| PHIMOR retention schedule | `PENDING HUMAN/LEGAL REVIEW`; do not invent a period |
| Lawful basis | `PENDING HUMAN/LEGAL REVIEW` |
| Sensitive-data condition | `PENDING HUMAN/LEGAL REVIEW` |
| Data-subject rights procedure | Follow the bounded procedure below and the existing PHIMOR controlled DSR workflow |
| Incident procedure | Feature kill switch and bounded response procedure below |
| Security measures | Assigned-pharmacist authorization, feature flag, server-only credentials, `store:false`, strict schemas, privacy validator, bounded/allowlisted web search, metadata-only audit, rate limits, human review, no auto-send |
| Responsible approver | `PENDING HUMAN/LEGAL REVIEW` |
| Approval date | `PENDING HUMAN/LEGAL REVIEW` |
| Review/expiry date | `PENDING HUMAN/LEGAL REVIEW` |

## Data-subject rights procedure

PHIMOR remains the authoritative holder of PHIMOR patient and clinical
records. `ai_interaction_audit` is metadata-only and is not a copy of the model
prompt, research query, provider output, or clinical record.

1. Receive the request through the approved authenticated/private channel and
   verify the data subject or authorized representative.
2. Clarify whether the request concerns information about AI processing,
   access, correction, deletion/restriction, objection, or withdrawal.
3. Locate relevant PHIMOR records and metadata audit entries using restricted
   internal references. Do not copy PHI into the tracking ticket.
4. Explain, subject to the approved notice and law, whether Clinical Research
   processing occurred, its purpose, categories, recipient/processor, and the
   human-review/no-auto-send boundary. Do not reveal another person's data,
   provider secrets, or security-sensitive internals.
5. Apply access/correction/restriction/deletion/objection/withdrawal decisions
   only through the existing approved domain procedures and after the
   accountable privacy/legal decision. Do not rewrite clinical provenance or
   delete incident/audit evidence ad hoc.
6. Assess external-provider implications against the confirmed contract and
   retention controls. Do not promise provider deletion, access, or retention
   behavior that has not been contractually and technically verified.
7. Record the decision, approved action, executor, completion evidence, legal
   preservation constraints, and response date using minimized metadata.

The applicable response period, exemptions, legal holds, external-provider
request path, and retention outcome remain `PENDING HUMAN/LEGAL REVIEW`.

## Incident procedure

Triggers include PHI in a web-search query, wrong-patient context, unauthorized
pharmacist access, unexpected retention/configuration change, enabled data
sharing, PHI in a provider response/log, or API-credential compromise.

1. Immediately set/confirm `PHARMACIST_AI_RESEARCH_ENABLED=false` using the
   authorized operational process.
2. Verify the endpoint returns its safe disabled behavior and makes no provider
   call, web search, or audit claim that research occurred.
3. Preserve safe audit and deployment/account-control evidence. Do not delete
   evidence required for investigation and do not copy prompts/PHI into normal
   incident tickets.
4. Revoke/rotate the server credential when compromise is suspected. Never
   paste the credential into chat, logs, Git, or an incident report.
5. Determine the affected interaction references, timeframe, actor/access
   path, external calls, account settings, and potential recipients using the
   minimum necessary access.
6. Notify the named privacy, security, clinical, and operational owners.
7. Perform the required regulator/data-subject notification assessment and
   document the decision; do not assume notification is or is not required.
8. Remediate and independently verify controls before any re-enable decision.
   Re-enabling requires a new written approval.

## Evidence attachments

- `PENDING`: controller and responsible-owner approval
- `PENDING`: internal approval/execution evidence for available DPA/processor terms
- `RECORDED`: data sharing is off; manual operator confirmation dated 2026-09-03 (sensitive evidence outside Git)
- `RECORDED`: conservative `STANDARD_RETENTION`; MAM/ZDR evidence remains pending if sought
- `PENDING`: cross-border transfer assessment
- `PENDING`: privacy notice version/publication evidence
- `PENDING`: lawful-basis/sensitive-data assessment
- `PENDING`: security and incident-response approval
- `PENDING`: Stage-1/Stage-2 pilot decision record
