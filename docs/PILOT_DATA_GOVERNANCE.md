# PHIMOR controlled-pilot data governance

This is an operational pilot policy, not legal advice. It records current
technical behavior so pilot operators do not promise deletion or retention
that the software does not provide. Any unapproved legal/business duration is
marked **POLICY DECISION REQUIRED**.

## Minimum operational ownership

- **DSR intake owner — [Privacy/Customer Support role]:** receives the request
  through the approved private channel and opens a restricted tracking record.
- **Identity verifier — [Privacy/Compliance role]:** verifies the data subject
  or authorized representative without copying identity evidence into normal
  chat or engineering tickets.
- **Decision owner — [Privacy/Legal role]:** approves the scope, exemptions,
  preservation duties, and action. Retention periods are **POLICY DECISION
  REQUIRED** until approved here.
- **Technical executor — [Authorized Production/Data Operator role]:** performs
  only the approved, scoped action with backup and peer review.
- **Completion recorder — [Privacy/Compliance role]:** records what was done,
  when, by which role, and any data that was preserved and why.

No pilot participant should run an ad-hoc delete. Preserve the original
request, approvals, safe identifiers, execution evidence, and result without
copying clinical bodies into the tracking system.

## Current data-domain behavior

| Domain | Purpose and permitted access | Current technical retention / automated deletion | Manual pilot handling and evidence constraints |
|---|---|---|---|
| Consent / data-rights requests | Actor-scoped consent history and a controlled queue for authenticated Family requests. Family sees only its own minimized status projection; System Admin sees the minimum request details needed to operate the queue. | Consent events and request status history persist in the current legacy data store. No request type triggers automated export, correction, restriction, or deletion. **POLICY DECISION REQUIRED** for retention. | Verify the requesting actor and affected data domains, follow the approved manual procedure, and record completion without copying clinical bodies into audit metadata. A completed request status is an operator attestation, not proof that every record was deleted. |
| Integration inbox | Durable, idempotent intake and operational processing for scoped Integration Clients; System Admin sees minimized operational projections, not a clinical payload inspector. | Event payload and processing state persist; no general automated deletion is implemented. **POLICY DECISION REQUIRED** for retention. | Pause/revoke the affected client if needed, locate by safe event/client references, and obtain Privacy/Legal approval before any data action. Preserve idempotency hash, status, safe error/audit evidence needed to prove processing and prevent replay. |
| Notification outbox | Reliable recipient-specific LINE delivery, dedupe, retry key, delivery/dead-letter state. Access is limited to backend workers and authorized operations. | Outbox rows/message projections persist; retry/dead-letter lifecycle is not a retention deletion policy. No general automated deletion. **POLICY DECISION REQUIRED**. | Stop further eligible delivery first where supported. Scope by Care Profile/notification intent without exposing LINE IDs in ordinary tickets. Preserve dedupe, provider acceptance, retry, and incident evidence required to prevent duplicate sends. |
| Vital Signs / Daily Care | Canonical factual care history for authorized Center actors and Family read-only finalized projections. | Relational history is persistent; void/finalization events preserve provenance. No automated record deletion. **POLICY DECISION REQUIRED**. | Do not overwrite/erase finalized history without an approved correction/erasure decision. Export an inventory of affected records, preserve lifecycle/audit events as approved, and verify Family/Center projections after the action. |
| Lab | Draft/review/confirmed structured results and source-document provenance for authorized Care Profile/Center workflows. | Source images are purged by the configured image-retention job (for example `MEDICAL_IMAGE_RETENTION_DAYS`); confirmed structured results and lifecycle events remain. The legal/business duration for both is **POLICY DECISION REQUIRED**. | Distinguish source-image purge from structured-result deletion. Use correction/void semantics where applicable; do not silently rewrite confirmed values. Preserve confirmation, correction, void, and purge evidence approved by Privacy/Legal. |
| Doctor Visit | User-recorded post-visit source note, organized guidance, confirmed/corrected/voided history. | Persistent relational history; no automated deletion. **POLICY DECISION REQUIRED**. | Treat it as user-recorded information, not a verified electronic order. Scope all versions/items/events; preserve correction/void provenance and any approved legal hold evidence. |
| Consultation transcript | Paid consultation case, immutable messages, read cursors, payment/case lifecycle, and pharmacist access. | The 24-hour consultation window closes messaging but does not delete the transcript. No automated transcript deletion. **POLICY DECISION REQUIRED**. | Coordinate Privacy/Legal, consultation operations, and payment/audit needs. Never place transcript bodies in DSR tickets or logs. Preserve minimal payment, authorization, case-state, and dispute evidence approved for retention. |
| Care Profile audit/history | Care Profile facts, membership/access history, field-change history, and security/audit events. | Persistent history; no general automated deletion. **POLICY DECISION REQUIRED**. | Verify owner/member/Center relationships before action. Remove or restrict only approved data while preserving the minimum security, consent, authorization, and completion evidence required by the decision owner. Re-test revoked and cross-profile access. |

## Pilot DSR procedure

PHIMOR now provides authenticated Family consent withdrawal and data-rights
request/status screens plus a minimized System Admin request queue. These
screens create and track a controlled request; they do **not** execute a
domain-wide export, correction, restriction, or erasure automatically. A
request may be marked completed only after an operator explicitly attests that
the approved manual procedure was performed. The legal scope, permitted
technical action, response period, and retention period remain **POLICY
DECISION REQUIRED**.

1. Intake owner records the request using safe references and alerts the
   identity verifier.
2. Identity verifier confirms the requester and affected Care Profile(s).
3. Technical executor produces a domain inventory without changing data.
4. Privacy/Legal records the approved action and any preservation constraints.
5. Release owner pauses affected integrations/notifications when continuing
   processing would conflict with the approved request.
6. Technical executor backs up the scoped evidence, applies the approved action
   with peer review, and verifies authorization/projections afterward.
7. Completion recorder retains a minimal audit of the request, approval,
   execution, verification, exceptions, and response date.

Before a real pilot, the company must approve named role owners, response
channel, escalation path, retention schedule for every domain above, backup
retention, legal-hold handling, and the exact technical actions permitted for
access, correction, restriction, export, and erasure.
