# PHIMOR OpenAI Clinical Research commissioning gate

Commissioning review date: 2026-09-03

This record separates technical connectivity from permission to process real
health information. OpenAI connectivity and the synthetic preflight have
passed, but Pharmacist Clinical Research remains disabled. This document does
not constitute a legal conclusion or permission to process personal data.

## Current technical state

| Control | Recorded state |
| --- | --- |
| OpenAI model access | `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` passed the non-PHI preflight |
| Responses API | Passed with strict JSON Schema output and `store:false` |
| Web search | Passed with bounded calls, domain allowlisting, and safe source projection |
| Ordinary PHIMOR AI | `AI_PROVIDER=gemini` |
| Clinical Research provider | `AI_PROVIDER_CLINICAL_RESEARCH=openai` |
| Clinical Research feature | `PHARMACIST_AI_RESEARCH_ENABLED=false` |
| Clinical Research mode | `PHARMACIST_AI_RESEARCH_MODE=disabled` |
| Pilot access | Server-side allowlist; empty list denies all users |
| Real PHI commissioning | **Not approved** |

The feature flag must remain false until every mandatory governance item in
this record is approved and evidenced. Technical availability is not an
authorization to send real health information to OpenAI.

## OpenAI account and contract controls

| Decision | Status | Evidence needed before real-PHI use |
| --- | --- | --- |
| `DATA_SHARING_ENABLED` | `NO` | Confirmed manually by an authorized PHIMOR operator in OpenAI Platform on 2026-09-03. Retain account evidence outside Git under the approved governance process. |
| `OPENAI_RETENTION_POSTURE` | `STANDARD_RETENTION` | Conservative recorded posture because no approved MAM/ZDR evidence is available. This is not a claim of ZDR. |
| `OPENAI_DPA_STATUS` | `DOCUMENT_AVAILABLE_PENDING_INTERNAL_APPROVAL` | A document is available, but organizational/legal approval, parties, effective date, scope, and accountable owner remain to be recorded. |
| Controller/legal entity | `TO_BE_RECORDED` | Record the PHIMOR legal entity acting as controller and the accountable privacy owner. |
| OpenAI processor scope | `TO_BE_APPROVED` | Document that OpenAI is an external processor/subprocessor for the private planner, de-identified web research, and private synthesis stages, including any relevant subprocessors and locations. |

Required evidence slots (do not change without dated evidence):

- `DATA_SHARING_ENABLED: NO`
  - Evidence note: `Confirmed manually by PHIMOR operator in OpenAI Platform on 2026-09-03; account-sensitive evidence is not stored in Git.`
- `OPENAI_RETENTION_POSTURE: STANDARD_RETENTION`
  - Evidence note: `Conservative default; no approved MAM/ZDR evidence recorded.`
- `OPENAI_DPA_STATUS: DOCUMENT_AVAILABLE_PENDING_INTERNAL_APPROVAL`
  - Evidence note: `Document availability confirmed; approval evidence pending.`

`store:false` is an application-state control; it is not evidence of Zero Data
Retention. OpenAI documents that API data is not used to train models unless
the customer opts in, while default abuse-monitoring logs can retain prompts
and responses for up to 30 days. Modified Abuse Monitoring and Zero Data
Retention are separate, approval-based controls whose availability/status must
be verified for the actual organization/project. See the official OpenAI data
controls documentation: <https://developers.openai.com/api/docs/guides/your-data>.

If data sharing later becomes enabled, stop commissioning, keep the feature flag
false, disable data sharing through an authorized account administrator, and
repeat this gate. Do not treat a generic policy page, `store:false`, or a
successful API request as proof of the account's retention/DPA posture.

## Data flow and minimization boundary

The approved architecture is:

1. The assigned pharmacist manually requests analysis for an authorized case.
2. A private planner receives a bounded PHIMOR context.
3. At most four generic research topics pass the privacy validator.
4. Web search receives only accepted, de-identified concepts and never the
   clinical context or conversation.
5. At most eight allowlisted, provider-cited sources are projected into the
   private synthesis.
6. The pharmacist reviews the result. Copying a draft and sending a reply are
   separate explicit human actions.

The bounded private context may contain consultation messages, current Care
Profile facts, current medication and recent medication changes, recent
Vitals, confirmed Labs, and relevant upcoming appointments. It excludes
addresses, phone/email contact data, government identifiers, payment data,
unrelated profiles, source images/documents, and general audit history.

The web-search privacy gate rejects LINE-style identifiers, Care Profile,
Resident, Case and Center identifiers, email addresses, phone numbers,
patient/relative names, and copied consultation text. Searches are limited to
generic drug, class, condition, interaction, and guideline concepts. A failed
privacy check produces no search request.

All Clinical Research OpenAI request bodies use `store:false`. The flow does
not use `previous_response_id`, OpenAI conversation persistence, the Files API,
or a vector store. Clinical Research sends text through bounded Responses API
requests; it does not upload medication-label images or clinical documents.

## Metadata-only audit

The audit may retain only bounded operational metadata:

- internal interaction/case/requester references required for access review;
- provider, model, purpose, prompt/context/research-plan versions;
- requested/completed times, result status, safe error code, and escalation;
- bounded input/output/total/reasoning token counts;
- web-search call count, accepted source count, and `researchPerformed`;
- character counts and safe provider request reference when supplied.

It must not store prompts, transcripts, patient facts, patient or medication
names, clinical output, pharmacist draft text, search terms/queries, web-page
text, source excerpts, raw provider responses, or credentials. Audit-write
failure must not create an unaudited visible research result.

## Thailand PDPA and cross-border governance checklist

The accountable controller/privacy owner must complete and attach evidence for
each item before Stage 2. This checklist records controls; it is not legal
advice or a determination of legal compliance.

- [ ] Identify and document the lawful basis for every processing purpose,
  including health-data/sensitive-personal-data conditions and any consent or
  alternative basis relied upon.
- [ ] Update the user-facing privacy notice before first real-PHI use. State
  purpose, data categories, OpenAI as an external processor, cross-border
  processing, retention, data-subject rights, contact/escalation paths, and
  material automated-assistance limitations.
- [ ] Execute and approve the DPA/processor terms; record OpenAI and relevant
  subprocessors in the processor register.
- [ ] Assess and record cross-border transfer destinations, safeguards,
  transfer mechanism, data residency, and residual risk.
- [ ] Record the actual OpenAI retention posture and PHIMOR audit-retention
  schedule. Confirm that deletion/expiry behavior is operationally testable.
- [ ] Update the Record of Processing Activities and complete the applicable
  privacy/DPIA-style risk assessment for health data and external AI research.
- [ ] Map access, correction, deletion/restriction, objection/withdrawal, and
  other applicable data-subject requests across PHIMOR metadata and external
  processing; document limits and response ownership.
- [ ] Approve security controls: least privilege, server-only key management,
  rotation/revocation, environment separation, monitoring, access review, and
  vendor/subprocessor change review.
- [ ] Approve incident response for suspected identifier leakage, wrong-person
  access, provider exposure, unsafe evidence, and key compromise, including
  notification/escalation responsibilities.
- [ ] Verify project/organization data sharing is off and retain dated evidence.
- [ ] Record the final go/no-go decision, approvers, scope, pilot cohort,
  validity/review date, and rollback owner.

The existing general PHIMOR privacy notice was not established by this review
as explicitly covering OpenAI Clinical Research and its cross-border external
processing. Treat the notice update and recorded assessment as open mandatory
items, not as implicitly satisfied by existing generic consent copy.

Prepared companion records:

- `PHIMOR_OPENAI_CLINICAL_RESEARCH_PRIVACY_NOTICE.md` — minimum proposed
  user-facing addition, pending legal review/versioning/publication;
- `PHIMOR_OPENAI_DEIDENTIFIED_PILOT_SOP.md` — conservative Stage-1
  de-identification and human pre-submission gate;
- `PHIMOR_OPENAI_CLINICAL_RESEARCH_ROPA.md` — processing-record template,
  data-subject-rights procedure, and incident procedure.

## Clinical and operational safeguards

- Research is pharmacist decision support only; it does not diagnose,
  prescribe, create medication orders, update clinical records, or auto-send.
- A pharmacist must manually press the analysis action and review every output
  and cited source before deciding whether to use any draft.
- Copying a draft to the composer does not send it. Sending remains a separate
  existing action.
- Research is bounded to four topics, four web searches, and eight accepted
  sources. Only allowlisted HTTPS provider citations are accepted.
- Missing evidence cannot be converted into a claim that no interaction exists
  or that evidence is comprehensive.
- The default rate limit is three Clinical Research requests per ten minutes
  for the case/pharmacist boundary, within configured safe bounds.
- No background batch research, automated case sweep, or automated patient
  communication is permitted.

## Controlled pilot stages

### Stage 0 — synthetic validation

Status: **READY**. Use only hard-coded synthetic/general content with no person,
Care Profile, Center, LINE, case, consultation, or production clinical data.
Keep the production feature flag false. The completed connectivity preflight
belongs to this stage.

### Stage 1 — de-identified controlled validation

Status: **READY FOR HUMAN APPROVAL — NOT YET AUTHORIZED**. The product now has
an explicit `deidentified_pilot` mode, server-side pilot allowlist, pharmacist
acknowledgment, manual de-identified summary input, and a local privacy gate.
The mode does not automatically load Care Profile context into an OpenAI
request. Limit participation to one
verified pharmacist and content independently verified as non-identifying and
not reasonably linkable to a person. No production record lookup, verbatim
conversation, free-text patient narrative, rare identifying combination,
batch processing, or auto-send is allowed. A named privacy owner must approve
the de-identification procedure and the actual account data-sharing/retention
settings before any provider request in this stage.

### Stage 2 — real authorized health information

Status: **BLOCKED**. Requires completed DPA, PDPA/lawful-basis and cross-border
assessment, updated privacy notice, actual data-sharing/retention evidence,
approved incident/DSR procedures, a named single-pharmacist pilot, and an
explicit change approval to set `PHARMACIST_AI_RESEARCH_ENABLED=true`.

The pilot must remain on-demand, case-authorized, rate-limited, fully reviewed
by the pharmacist, and never auto-send. Approval must define the allowed data
categories and expiration/review date.

### Stage 3 — broader rollout

Status: **BLOCKED**. Requires review of Stage 2 safety, privacy incidents,
quality/evidence limitations, access/audit results, source behavior, API usage
and cost, and a separate written rollout decision. Global ordinary-AI provider
routing remains a separate decision.

## Emergency disable and incident procedure

The immediate kill switch is:

`PHARMACIST_AI_RESEARCH_ENABLED=false`

On suspected privacy, account-control, evidence, authorization, or provider
incident:

1. Set/confirm the flag is false through the authorized deployment process.
2. Verify the Clinical Research endpoint returns the safe disabled result and
   performs no provider call, web search, or research audit claiming work ran.
3. Do not delete or rewrite existing metadata audit records.
4. Preserve safe operational evidence without prompts, PHI, raw responses, or
   credentials; revoke/rotate the server key when credential compromise is
   suspected.
5. Notify the named security/privacy incident owner and follow the approved
   assessment and notification procedure.
6. Re-enable only through a new documented commissioning decision.

## Commissioning decision record

| Field | Required entry |
| --- | --- |
| Decision | `PENDING` |
| Approved stage | `STAGE_0_ONLY` until this record is completed |
| Controller/privacy owner | `TO_BE_RECORDED` |
| Security owner | `TO_BE_RECORDED` |
| Clinical/pharmacist owner | `TO_BE_RECORDED` |
| DPA evidence | `TO_BE_ATTACHED` |
| Data sharing evidence | `TO_BE_ATTACHED` |
| Retention posture evidence | `TO_BE_ATTACHED` |
| PDPA/cross-border assessment | `TO_BE_ATTACHED` |
| Privacy notice version/date | `TO_BE_RECORDED` |
| Pilot participant and duration | `TO_BE_RECORDED` |
| Approval/review/expiry dates | `TO_BE_RECORDED` |

Until these entries are approved, Clinical Research must remain disabled for
real PHI. A successful technical preflight does not change this decision.

## Pilot approval record

### Stage 0

| Field | Decision record |
| --- | --- |
| Status | `READY — SYNTHETIC/NON-PHI ONLY` |
| Approved by | `TO_BE_RECORDED` |
| Approval date | `TO_BE_RECORDED` |
| Scope | Hard-coded synthetic/general technical preflight; no production case or person |

### Stage 1

| Field | Decision record |
| --- | --- |
| Status | `READY FOR HUMAN APPROVAL — NOT YET AUTHORIZED` |
| Approved by | `TO_BE_RECORDED` |
| Approval date | `TO_BE_RECORDED` |
| Scope | `TO_BE_RECORDED` |
| De-identification SOP version | `stage1-deidentification-v1` |
| Privacy/account evidence | `TO_BE_ATTACHED` |

### Stage 2

| Field | Decision record |
| --- | --- |
| Status | **`NOT APPROVED`** |
| Approved by | `PENDING HUMAN/LEGAL REVIEW` |
| Approval date | `PENDING HUMAN/LEGAL REVIEW` |
| Scope | `PENDING HUMAN/LEGAL REVIEW` |
| Privacy notice version | `PENDING HUMAN/LEGAL REVIEW` |
| Data sharing status | `NO — operator-confirmed in OpenAI Platform` |
| Retention posture | `STANDARD_RETENTION — no MAM/ZDR evidence` |
| DPA status | `DOCUMENT_AVAILABLE_PENDING_INTERNAL_APPROVAL` |
| Cross-border assessment reference | `PENDING HUMAN/LEGAL REVIEW` |
| Responsible approver | `PENDING HUMAN/LEGAL REVIEW` |
