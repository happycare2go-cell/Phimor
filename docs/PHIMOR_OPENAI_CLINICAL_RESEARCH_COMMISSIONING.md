# PHIMOR OpenAI Clinical Research commissioning record

Commissioning decision date: 2026-09-04

This record documents the approved current product and technical posture. It
does not claim legal compliance, Zero Data Retention, Thailand-only residency,
or completion of any organizational decision whose accountable evidence is not
stored in this repository.

## Production decision

| Control | Recorded state |
| --- | --- |
| Ordinary PHIMOR AI | `AI_PROVIDER=openai`; Gemini is manual rollback only |
| Pharmacist Assistant | `AI_PROVIDER_PHARMACIST=openai`, `gpt-5.6-terra` |
| Clinical Research | `AI_PROVIDER_CLINICAL_RESEARCH=openai`, `gpt-5.6-sol` |
| Clinical Research feature | `PHARMACIST_AI_RESEARCH_ENABLED=true` |
| Clinical Research mode | `PHARMACIST_AI_RESEARCH_MODE=deidentified_pilot` |
| Pilot allowlist | Required for `deidentified_pilot` |
| OpenAI retention posture | `STANDARD_RETENTION` accepted for the current production phase |
| Zero Data Retention | **Not enabled or verified** |
| Data Sharing | **Off**, based on the recorded operator confirmation dated 2026-09-03 |
| Responses application state | Every request sets `store:false` |
| Human review | Required; no automatic diagnosis, order, treatment change, or send |

`store:false` is an application-state control and is not evidence of ZDR.
OpenAI documents that API data is not used to train models by default unless
the customer opts in, while standard abuse-monitoring retention is a separate
control. See <https://developers.openai.com/api/docs/guides/your-data>.

## Authorization and execution

Clinical Research remains an explicit pharmacist action:

1. `requireAuth` verifies the signed-in LINE session.
2. `requirePharmacist` verifies an active pharmacist account.
3. The case service verifies the pharmacist is assigned to the active/resolved
   paid and provisioned consultation.
4. In `deidentified_pilot`, the pharmacist supplies manually reviewed
   de-identified context plus a separate research focus, reads the disclosure,
   acknowledges the safety boundary, and presses **ค้นหลักฐานเพิ่มเติม**.
5. The result is a pharmacist-review draft. Copying it fills the composer only;
   sending is a separate human action.

The active `deidentified_pilot` mode requires the allowlist and manually
reviewed de-identified context. The supported `controlled_live` mode remains
inactive and would ignore the pilot allowlist if separately approved. Setting
`PHARMACIST_AI_RESEARCH_ENABLED=false` disables Clinical Research immediately
without disabling ordinary consultation or the Pharmacist Assistant.

## Data minimization and web-search boundary

The approved architecture is:

authorized case context → private planner → privacy sanitizer → generic
research concepts → bounded web search → validated evidence → private synthesis

Provider context excludes LINE/group IDs, internal database/routing IDs,
names, phone numbers, email, addresses, and exact dates of birth. Clinically
useful recorded facts are bounded and preserved without inventing or changing
them.

Web search receives only generic drug names/classes, condition names,
interaction pairs, monitoring topics, and guideline topics. It never receives
the raw consultation, Care Profile, patient/relative name, contact data, or
PHIMOR identifiers. A rejected privacy topic produces no web-search call.

## Evidence, audit, and cost limits

- at most four research topics and four web-search calls per interaction;
- at most eight accepted, allowlisted, provider-cited sources;
- default three requests per ten minutes per case/pharmacist;
- planner, research, and synthesis token usage aggregated as nullable metadata;
- audit stores metadata only, never prompts, transcripts, search terms,
  clinical output, drafts, images, or web excerpts;
- absence of evidence never means “no interaction”; the system does not claim
  to be a comprehensive interaction checker.

## Standard Retention governance record

PHIMOR accepts OpenAI Standard Retention for this production phase. ZDR is not
required for this decision and must not be implied. Data Sharing remains off
and `store:false` remains mandatory. DPA, cross-border, data-residency, privacy
notice publication, lawful-basis, sensitive-data, data-subject-rights, and
retention-schedule evidence remain accountable organizational records. Their
status must not be invented or represented as legally complete by this file.

Any material change to Data Sharing, provider, model routing, retention
posture, web-search boundary, or access model requires renewed review.

## Incident and kill-switch procedure

On suspected unauthorized access, wrong-person context, identifying web query,
unexpected retention/account change, content in logs, or credential compromise:

1. set `PHARMACIST_AI_RESEARCH_ENABLED=false`;
2. verify the endpoint returns the safe disabled state and makes no provider or
   web-search call;
3. preserve metadata-only evidence without copying PHI into ordinary tickets;
4. rotate the server credential only through the authorized secret-management
   process if compromise is suspected;
5. assess the incident under PHIMOR's accountable privacy, security, clinical,
   and operational process before re-enabling.
