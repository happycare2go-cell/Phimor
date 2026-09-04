# PHIMOR engineering invariants

This is a change-review rulebook. A patch that cannot state which invariant it
protects, where its authority lives, and how it is tested is not ready for
review merely because its endpoints pass independently.

## 1. Lock the business invariant

Before selecting a transaction or advisory lock, write down:

1. the business invariant;
2. the entity that owns it;
3. every writer that can mutate it; and
4. the one lock or row-lock contract shared by those writers.

The lock derives from the invariant owner, not from an endpoint, UI action, or
provider event. All competing writers must re-read authoritative state inside
the lock and commit the state transition and its inseparable history together.

| Invariant owner | Protected invariant | Canonical serialization contract |
| --- | --- | --- |
| Center staff identity | One effective role/state per Center and LINE identity | `centerStaffLockKey(centerId, lineUserId)` |
| Transport plan | One authoritative plan transition and non-lost history update at a time | `transportPlanLockKey(planId)` / `withTransportPlanMutation` |
| Plus subject entitlement | Verified purchases for one subject extend paid time without overlap or loss | `plusSubjectEntitlementLockKey(subjectLineUserId)` |
| Consultation case | Case state, assignment, messages, receipts, and expiry observe one current case row | `consultationRepository.findCaseForUpdate(caseId)` inside the transaction; operation-specific advisory keys are coordination, not the sole authority |

For multi-entity transitions, acquire deterministic sorted lock identities.
Never perform provider/network I/O while holding a database transaction. A new
writer must reuse the existing contract or explicitly change and retest every
writer. Historical PLUS-01 proof demonstrated a reachable concurrent paid-time
loss path for two different paid orders belonging to one subject; it did not
establish that the race had occurred in production.

## 2. One semantic source of truth

The same semantic definition must have one canonical registry. Workflow and
package differences are explicit mappings from that registry, not independent
lists that can silently drift.

- `PLUS_FEATURES` defines known Plus feature identities.
- `PAID_PLUS_FEATURES` defines the paid 30-day package subset.
- `PAID_PLUS_EXCLUDED_FEATURES` records deliberate omissions. It currently
  keeps `pharmacist_escalation` outside the paid package; changing that is a
  product decision, not a cleanup.
- Capability, payment-event, AI-source, status, and Clinical Research mode
  mappings must reject unknown values and have an owner test.

Adding a canonical value does not automatically add it to every package.
Reviewers must require an explicit mapping decision and a regression assertion.

## 3. Regex is defense-in-depth

Regex is suitable for normalization, cheap rejection, and detection of obvious
identifier or unsafe-directive patterns. It does not prove authorization,
clinical meaning, complete de-identification, medication equivalence, or
grounding.

Use typed structures, local schema validation, canonical records, relational
authorization, source references, and human review for semantic safety. Provider
responses that can contain patient medication facts must pass the same
context-aware structural grounding after the provider returns, even if the
provider adapter was also given that validator. De-identified pilot text must be
prepared and reviewed by the pharmacist; pattern checks are supplemental.

## 4. Fail safe and fail visible

Unknown authorization, financial, or clinical-automation state fails closed.
The same failure must remain operationally visible through bounded error codes,
state, counts, and timestamps that do not contain PHI, credentials, payloads,
raw provider errors, or unrestricted identifiers.

- A payment event cannot grant service until independently verified.
- Unknown reversal events cannot adjust entitlement.
- AI contract or grounding failure cannot reach the UI as a valid answer.
- A failed queue operation remains safely observable; it is not silently
  discarded.

Fail-safe is not fail-silent. Logs and audit metadata describe what control
failed, never the patient content that triggered it.

## 5. Human review is a safety boundary

Pharmacist Assistant and Clinical Research are decision support. Their output
is not a diagnosis, prescription, medication order/change, or authoritative
clinical record. The system does not auto-send. Copying a draft only populates
an editable composer, and a licensed pharmacist remains the final reviewer.

Payment manual review follows the same separation principle: a verified
refund/reversal/dispute signal is financial history, not permission to change
entitlement. Any entitlement adjustment requires an approved policy, explicit
operator action, idempotency, and audit evidence.

## Review checklist

- State the invariant owner and enumerate all writers.
- Test two competing mutations of the same invariant, not just lock-key text.
- Identify the canonical semantic registry and every deliberate omission.
- Validate provider output again at the service boundary before UI projection.
- Keep financial history additive; never erase success to represent reversal.
- Separate provider facts, entitlement state, business policy, and operator
  action.
- Preserve safe observability without content, identity, or secret leakage.
- Keep all AI and financial automation behind explicit enablement and human
  review controls.
