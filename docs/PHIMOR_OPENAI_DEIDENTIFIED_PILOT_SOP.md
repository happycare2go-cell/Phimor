# PHIMOR OpenAI de-identified pilot SOP

Version: `stage1-deidentification-v1`

Status: **READY FOR HUMAN APPROVAL — STAGE 1 NOT YET AUTHORIZED**

Prepared: 2026-09-03

This procedure reduces identification risk for a controlled Stage-1 Clinical
Research pilot. It does not establish or guarantee irreversible anonymization
and does not authorize use of real PHI. `PHARMACIST_AI_RESEARCH_ENABLED` must
remain `false` until the separately recorded approval gate is complete.

## Scope and operating boundary

Stage 1 is limited to one verified pharmacist, one case at a time, manual
preparation, manual review, and an explicitly approved non-production or
isolated pilot path. There is no automatic production-record export, batch
conversion, background processing, or automatic patient communication.

The `deidentified_pilot` service path checks that the pharmacist is active and
assigned to the case, but it does not load the production Care Profile,
medication, Lab, Vital, appointment, or consultation transcript into the AI
context. The pharmacist enters a manually reviewed summary, confirms the
privacy checklist, and the server runs the local privacy validator before any
provider call. This SOP must not be used to copy a production case verbatim and
then call the result “de-identified.” Use still needs separate human approval
and must not put patient data in Git, fixtures, logs, screenshots, tickets, or
chat.

## Data inventory

### Private synthesis context

The private planner and synthesis receive only the approved, minimized pilot
case. These fields are not permitted in web-search input.

| Classification | Data | Rule |
| --- | --- | --- |
| `NECESSARY` | consultation messages | Include only the minimum clinically relevant de-identified passages; never copy headers or incidental identifying narrative. |
| `NECESSARY` | current medications | Include verified medication name/strength/directions needed for the research question. |
| `NECESSARY` | drug allergies | Include recorded drug allergies or explicitly record that the information is unavailable; do not infer. |
| `NECESSARY` | chronic conditions | Include only conditions relevant to the question; do not include unrelated history. |
| `CONDITIONALLY_NECESSARY` | recent medication changes | Include only when timing/change affects the research question. |
| `CONDITIONALLY_NECESSARY` | recent Vitals | Include only measurements and relative timing relevant to the question. |
| `CONDITIONALLY_NECESSARY` | confirmed Lab values | Include only confirmed values relevant to the question, with necessary unit/reference context. |
| `CONDITIONALLY_NECESSARY` | appointments | Include only if timing or specialty is necessary; generalize facility and dates where possible. |
| `CONDITIONALLY_NECESSARY` | age range, sex, weight | Include only when clinically relevant; prefer age range to DOB and omit any field that does not affect the question. |
| `PROHIBITED_NOT_SENT` | name, identifying initials, relative/staff names | Remove from all prompts and queries. |
| `PROHIBITED_NOT_SENT` | LINE ID, phone, email, address, government ID | Remove from all prompts and queries. |
| `PROHIBITED_NOT_SENT` | Center name/internal ID, Resident ID, Care Profile ID, Case ID, external patient ID, room number | Remove or replace with a generic non-reversible descriptor. |
| `PROHIBITED_NOT_SENT` | payment data, unrelated Family/Profile data, raw images/documents, copied document headers, arbitrary audit history | Never include. |

### Web-search context

Web search is more restricted than private synthesis. It may receive only a
generic drug/class/condition/interaction/guideline concept that independently
passes the local privacy validator. It must not receive consultation text,
private clinical context, person/facility identifiers, exact dates, values not
needed to formulate a generic research concept, or a rare narrative.

Examples:

- Acceptable: `authoritative guidance on renal dose considerations for a named medicine`
- Not acceptable: `what should Ms. Somjai at Happy Home room 3 take after her 3 September result`

## Manual de-identification procedure

1. **Confirm authorization and environment.** Verify the named Stage-1
   pharmacist and approved pilot workspace. Confirm the server-side allowlist,
   `PHARMACIST_AI_RESEARCH_MODE=deidentified_pilot`, and the emergency flag.
2. **Copy the minimum facts into a temporary review worksheet.** Do not include
   screenshots, scanned labels, documents, or hidden metadata.
3. **Remove direct identifiers:** names, identifying initials, LINE IDs,
   phone/email, full DOB, exact address, Center/facility name, room number,
   internal/external identifiers, document headers, and relative/staff names.
4. **Reduce indirect identifiers:** replace DOB with a clinically necessary age
   range, Center with a generic care setting, and exact dates with relative
   timing when exactness is not necessary.
5. **Remove rare narrative details.** Delete occupation, travel, family events,
   location combinations, unusual chronology, or quoted phrases that could
   reasonably identify a person.
6. **Apply necessity review.** Remove every medication change, Vital, Lab,
   appointment, demographic field, or message that does not affect the stated
   research question.
7. **Human reviewer check.** A second authorized reviewer, or the designated
   privacy reviewer when required by the pilot approval, completes the checklist
   below before submission.
8. **Run the approved local privacy validator.** The validator result must pass
   with no blocked direct identifier. Do not weaken or bypass the validator.
   The backend submission path is the authoritative validation boundary.
9. **Submit manually once.** No batch, background, retry loop, or automatic
   export is allowed. Review the provider result and source links; do not send a
   draft to a patient.
10. **Dispose of temporary material.** Follow the approved pilot retention
    decision. Do not save the worksheet in Git, ordinary chat, tickets, browser
    storage, or unmanaged drives. Preserve only permitted metadata evidence.

## Human pre-submission checklist

- [ ] The pilot and reviewer identities are authorized and recorded.
- [ ] No production record was automatically exported.
- [ ] Names and identifying initials are absent.
- [ ] LINE IDs, phone, email, full DOB, address, government ID are absent.
- [ ] Center/facility name, room, internal/external identifiers are absent.
- [ ] Relative/staff names, copied headers, and identifying free text are absent.
- [ ] Exact dates and rare narratives were removed or justified as necessary.
- [ ] Age/sex/weight and each clinical fact are necessary for the question.
- [ ] The web topic contains only generic clinical concepts.
- [ ] The approved local privacy validator passed without bypass.
- [ ] A human reviewer approved submission before the provider call.
- [ ] No batch, auto-send, image/document upload, or persistent case copy exists.

## Examples

Do not use:

> นางสมใจ ใจดี อายุ 83 อยู่ Happy Home สระบุรี ห้อง 3 และมาตรวจวันที่ 3 กันยายน

Use only when each remaining fact is necessary:

> ผู้สูงอายุหญิงช่วงอายุ 80–85 ปี ในสถานดูแล มีข้อมูลทางคลินิกที่ระบุไว้ด้านล่าง

Even the reduced example may remain personal data when combined with other
facts. The reviewer must consider singling-out, linkage, and inference risk;
passing this SOP is risk reduction, not a legal anonymization conclusion.

## Stop and incident triggers

Stop before submission if identity risk is uncertain, a blocked term remains,
the account data-sharing/retention posture is unverified, the approved local
validator is unavailable, or the feature flag is not false outside the
authorized isolated pilot. If information is submitted in error, invoke the
incident procedure in the commissioning record immediately.
