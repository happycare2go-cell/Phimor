# PHIMOR Pharmacist Clinical Research Assistant V1

## Clinical boundary

Clinical Research is a private, on-demand support tool for the pharmacist assigned to an authorized consultation case. It does not diagnose, prescribe, change medication, write clinical records, or send a message to the user. The pharmacist must independently review the analysis and may explicitly copy an editable draft into the composer; sending remains a separate human action.

The feature is off by default through `PHARMACIST_AI_RESEARCH_ENABLED=false` and `PHARMACIST_AI_RESEARCH_MODE=disabled`. The emergency flag always wins. Non-disabled modes also require the authenticated pharmacist identity to appear in the server-only `PHARMACIST_AI_RESEARCH_PILOT_USERS` allowlist; an empty list denies everyone. Consultation and pharmacist authorization remain backend-authoritative. The endpoint is rate-limited per case and pharmacist; the default is three requests per ten minutes and is configurable within safe bounds through `CLINICAL_RESEARCH_REQUESTS_PER_10_MINUTES`.

## Operating modes

- `disabled`: no research provider request; safe unavailable state.
- `deidentified_pilot`: the assigned pharmacist supplies and reviews a de-identified summary. The research path performs only pharmacist/case authorization and does not automatically load Care Profile or clinical-domain context into the provider request.
- `controlled_live`: uses the existing bounded, authorized Care Profile and consultation context. This mode is prepared but remains subject to the separate real-PHI governance approval.

Both pilot modes require explicit pharmacist acknowledgment on each request. The LIFF does not persist the summary or acknowledgment in browser storage.

## Authorized context

The context builder runs only after the existing assigned-pharmacist and consultation-state checks. It builds one bounded snapshot containing:

- up to 200 consultation messages and 60,000 conversation characters;
- current, authorized Care Profile facts;
- the authoritative current medication snapshot and recent medication changes;
- recent authoritative Vital records;
- confirmed Lab results;
- upcoming appointments and current consultation/triage context.

The response records the analyzed message sequence, analyzed/total message counts, context timestamp, and truncation state. The console marks an analysis stale when newer messages exist and offers explicit re-analysis. A case switch clears the private panel and ignores stale in-flight results.

## Planner → de-identified research → synthesis

1. **Private planner.** The planner receives the authorized clinical context and returns at most four research topics under a strict local schema.
2. **Privacy gate.** Every proposed question/search term is normalized and checked for LINE-style IDs, internal case/profile/resident/center identifiers, email, phone numbers, patient/relative names, and copied free-form conversation text. A rejected topic is not searched.
3. **External evidence research.** Only the accepted, generic drug/class/condition/interaction/guideline topic plan is sent to web search. The full clinical context, conversation, patient facts, and identifiers are never included in this request. Search is bounded to at most four calls, country `TH`, and the configured domain allowlist.
4. **Private synthesis.** The final synthesis receives the authorized clinical context plus only validated findings and accepted sources. It produces structured analysis and a pharmacist-review draft; it does not send or persist that content as a clinical record.

If the planner decides external research is unnecessary, synthesis still runs with `researchPerformed=false`, `webSearchCalls=0`, and `sourceCount=0`. If research fails, the system retains an explicit limitation rather than inventing evidence.

## Evidence hierarchy and citations

The default web allowlist prioritizes authoritative sources: Thai Ministry of Public Health/FDA/DDC, WHO, CDC, US FDA/DailyMed, EMA, NICE, IDSA, and PubMed. Operators may replace the list with `OPENAI_CLINICAL_ALLOWED_DOMAINS`; at most 50 valid domain suffixes are accepted.

A finding is accepted only when it cites an actual HTTPS provider source on the allowlist. PHIMOR deduplicates sources, gives them safe local references, and returns only sources referenced by accepted findings. Findings without verified citations are removed and surfaced as limitations. The console renders external citations with `noopener`, `noreferrer`, and no referrer.

Source hierarchy does not imply that every web page is current, complete, applicable to Thailand, or suitable for an individual patient. Publication date may be absent. The pharmacist must review source currency, authority, population, dose/formulation, renal/hepatic context, allergies, and local guidance.

## Interaction and antibiotic-guideline limits

V1 does not claim that “no interaction exists” from an incomplete web result. Unsupported negative interaction claims are rejected and reported as insufficient evidence. Interaction output is a review cue, not a comprehensive interaction check. A future licensed drug-interaction provider can be added behind a separately reviewed evidence adapter without weakening the current citation and human-review boundary.

Antibiotic or infectious-disease guidance is likewise informational. The system must not infer diagnosis, indication, culture result, resistance pattern, allergy status, renal function, pregnancy status, treatment duration, or dose when absent. Guideline evidence may differ by organism, syndrome, region, age, comorbidity, and local antimicrobial policy. Escalation and missing-information sections are intentionally explicit.

## Console behavior

The assigned pharmacist explicitly opens **“พี่หมอ Clinical Research”**, reviews the operating-mode notice, and presses **“เริ่มค้นคว้า”**. The mobile-friendly private panel shows:

- context age, truncation, and stale-analysis notices;
- recorded facts and their PHIMOR source categories;
- current medication/recent-change context;
- missing information and questions to ask;
- clinical/safety/interaction/guideline review sections;
- verified external citations and evidence limitations;
- recommendations/escalation considerations;
- an editable draft with **“นำร่างไปใส่ช่องตอบ”**.

The copy action only populates the existing composer. It does not call the message endpoint. Provider failure, rate limiting, disabled configuration, or audit failure leaves manual consultation usable and returns safe Thai copy without raw provider details.

## Privacy, audit, and cost metadata

All OpenAI requests set `store:false`; production use still requires the separate ZDR/DPA and retention governance gate described in the provider document. No live PHI commissioning is part of this release.

One Clinical Research interaction may contain planner, web, and synthesis calls. PHIMOR aggregates provider-reported input, output, total, and reasoning tokens across all calls. It also records actual web-search calls and the final accepted unique source count. Missing provider counts remain `NULL`; authoritative zeros remain `0`.

The metadata-only audit records the interaction/case/provider/model/purpose/prompt/context/research-plan versions, result and safe error status, timestamps, character counts, usage counts, source count, and whether research actually ran. It does not store prompts, transcripts, patient facts, clinical output, draft text, search terms, page text, or source excerpts. If required audit persistence fails, the clinical analysis is not shown.

## Activation checklist

- complete PHIMOR privacy/security/legal review and OpenAI DPA/ZDR decision;
- configure `OPENAI_API_KEY` server-side without exposing it to LIFF;
- keep ordinary AI on `AI_PROVIDER=gemini` and select Clinical Research independently with `AI_PROVIDER_CLINICAL_RESEARCH=openai`;
- verify approved model access in a non-PHI commissioning test;
- review/lock `OPENAI_CLINICAL_ALLOWED_DOMAINS`;
- confirm migration `0018` is reviewed, preflighted, applied, and recorded through the normal migration process;
- deploy Backend and Pharmacist LIFF from the same reviewed commit;
- keep `PHARMACIST_AI_RESEARCH_ENABLED=false` until authorization, audit, rate-limit, error, stale-result, and no-auto-send smoke checks pass;
- enable only through a separately approved production change.

No production migration, provider activation, credential change, live OpenAI call, or real-patient test is authorized by this implementation work.
