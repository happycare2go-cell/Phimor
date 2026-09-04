# PHIMOR post-overnight root-cause hardening report — 2026-09-05

## Scope and repository state

- Starting SHA: `6db8b85a565f8ee75c09e9fd33a6bb4311ca73e3`
- Final implementation SHA before this report-only commit:
  `52c626b` (`docs: align payment and clinical privacy contracts`)
- Final local SHA including this report: the report-containing commit recorded
  in the review handoff (a Git commit cannot contain its own hash).
- Branch: `main`
- Overnight conclusion consumed: **A — READY FOR REVIEW + PUSH**
- Push, deploy, production access, provider calls, and real PHI: not performed.
- Declarative Clinical Research mode: `deidentified_pilot`, unchanged.
- Declarative `PLUS_PAYMENT_ENABLED`: `false`, unchanged.

## Commits

1. `94eec68` — `chore: codify core engineering invariants`
2. `8fcdd78` — `feat: add payment reversal go-live safeguards`
3. `52c626b` — `docs: align payment and clinical privacy contracts`
4. Report-only commit containing this file.

## Root-cause controls

| Required result | Status | Evidence |
| --- | --- | --- |
| Engineering invariants document | YES | `PHIMOR_ENGINEERING_INVARIANTS.md` is a change-review rulebook. |
| Canonical business-invariant lock rule | YES | CenterStaff, TransportPlan, Plus subject entitlement, and consultation row-lock contracts are identified; Plus construction now has a named helper. |
| Duplicate semantic source rule | YES | Paid Plus entries must belong to canonical `PLUS_FEATURES`; intentional exclusion of `pharmacist_escalation` is explicit and tested without granting it. |
| Regex semantic-boundary rule | YES | Regex is documented as defense-in-depth; typed/relational/grounded controls remain authoritative. |
| Fail-safe plus fail-visible | YES | The rule and reversal metadata-only visibility are documented and tested. |
| Human-review boundary | YES | AI remains pharmacist-review-only/no-auto-send; reversal records do not mutate entitlement. |
| Post-provider medication grounding | YES | A mock provider that ignores its supplied validator returns a structurally valid but wrong `Amlodipine 500 mg`; the service's second validation rejects it before UI projection. |

Existing behavioral race tests remain the guardrail for same-entity
serialization: CenterStaff duplicate-safe membership mutations, canonical
TransportPlan transitions/history, subject-scoped Plus paid-time stacking, and
consultation lifecycle row locking. No operation-specific consultation
advisory key is represented as a substitute for the authoritative case row
lock.

## PAY-REV-01

PAY-REV-01 confirmed: **YES — a future real-money go-live gap**.

| Lifecycle after successful payment | Current production adapter support | Automatic entitlement reversal |
| --- | --- | --- |
| Full refund | No; signed non-`charge.complete` event is ignored and not persisted | NO |
| Partial refund | No | NO |
| Void/refund-before-settlement | No | NO |
| Charge reversal | No | NO |
| Dispute | No | NO |
| Chargeback | No exact provider mapping confirmed | NO |

Official Omise documentation confirms general refund/full-or-partial amount,
possible void, `refund.create`, `charge.reverse`, and dispute lifecycle
capabilities. Exact production Plus PromptPay eligibility and payload mapping
are not yet confirmed. Provider reversal semantics verified for the deployed
Plus method: **NO**; status remains
`PROVIDER_REVERSAL_SEMANTICS_REQUIRES_CONFIRMATION`.

The new provider-neutral manual-review foundation is intentionally not wired
to Omise events. It can record a future independently verified normalized
event additively in the existing table, requires the original processed success
and matching order/payment/checkout/currency, rejects unknown/conflicting
events, is idempotent by provider event, and never calls an entitlement writer.
The original success and entitlement remain unchanged in tests. Cross-user
association test: **PASS**.

## Go-live and owner policy

- Payment reversal go-live readiness gate implemented: **YES**.
- Payment disabled plus missing reversal mode: readiness unaffected.
- Payment enabled plus missing/invalid mode: safe configuration failure.
- Implemented recognized mode: `manual_review` only. `automated` is rejected
  because no automatic policy exists.
- Owner refund/dispute/chargeback policy required: **YES**.
- Manual reversal SOP created: **YES**.
- Go-live checklist created: **YES**.
- Original financial history preserved: **YES**.
- Automatic entitlement cancellation/shortening/suspension: **NO**.
- Operator entitlement-action workflow: not implemented pending owner policy;
  the technical foundation records only `MANUAL_REVIEW_REQUIRED`.
- Migration required: **NO**. Existing additive transaction fields preserve
  normalized event identity/type, amount/currency, original references, safe
  manual-review state, and payload hash without rewriting success history.

Paid Plus remains disabled. Configuring `manual_review` later means only that
an operational mode was chosen; it does not prove provider mapping, approve a
refund, or change entitlement.

## Truthful privacy and AI contracts

- De-identified wording corrected/confirmed: **YES**.
- Automatic comprehensive de-identification claimed: **NO**.
- Pilot contract: pharmacist removes identifiers first; PHIMOR performs
  supplemental common-pattern checks and does not auto-load chat/Care Profile.
- Controlled-live web privacy preserved: **YES**. Authorized minimized context
  is private to planner/synthesis; web research receives only sanitized generic
  topics.
- `recordedFacts` is documented as a grounded structured AI category, not an
  unquestionable clinical database source.
- No stable enum/API was renamed and no new consent gate was added.
- Human review and no-auto-send remain unchanged.

## Overnight findings

- Remaining HIGH: 0.
- Remaining MEDIUM-HIGH: 0.
- Remaining MEDIUM: 0.
- Deferred LOW: 2 (`OVN-01`, `OVN-02`), unchanged as required.
- PAY-REV-01 is isolated by `PLUS_PAYMENT_ENABLED=false` and the new readiness
  gate; it remains an explicit owner-policy/provider-integration blocker for a
  future real-money go-live rather than a currently reachable payment defect.

## Validation

- Focused invariant/payment/privacy/AI suite: **152 passed, 0 failed**.
- Full canonical suite: **1,986 passed, 0 failed**.
- JavaScript syntax: **449 passed, 0 failed**.
- Browser simulation: **20 journeys passed**, including Family and Pharmacist
  at 390×844 and 1280×800. The repository-local command first reported its
  optional Playwright dev package absent; the same committed simulation was
  then run with the bundled Playwright runtime, without package changes.
- `git diff --check`: passed.
- Secret-signature scan: 0 matches.
- Added unsafe production-log candidate scan: 0 matches.
- Public secret/config/controlled-live allowlist leak scan: 0 matches.
- Migration changes: none.
- Dependency or lockfile changes: none.
- Real OpenAI calls: 0.
- Real Gemini calls: 0.
- Real Omise calls: 0.
- Real PHI used: 0.
- Production changed: NO.
- Push/deploy: NO/NO.

## Conclusion

**B. TECHNICAL HARDENING COMPLETE — PAYMENT POLICY DECISION REQUIRED BEFORE
FUTURE PLUS PAYMENT GO-LIVE**
