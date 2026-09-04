# PHIMOR Overnight Production Hardening Report — 2026-09-05

## Scope and execution boundary

- Starting SHA: `f54e36ae3fcf9ea08aac7f38d1772765e3cd61ac`
- Final implementation SHA before this report-only commit: `05c4aaead142e4df51247127bdd6cf62fea72b0e`
- Final repository SHA: reported with the review handoff after committing this document.
- Branch: `main`
- Production access, push, and deploy: not performed.
- Real patient data and real provider calls: not used.
- `controlled_live`: not activated or changed; the declarative research mode remains `deidentified_pilot`.
- Migration changes: none.
- Dependency or lockfile changes: none.

The initial `git fetch origin` could not reach GitHub because the environment's Git installation did not have the `remote-https` transport. The existing local `origin/main` ref, local `HEAD`, and working tree nevertheless matched the required baseline exactly before modification.

## Commits

1. `0aa66cd` — `fix: strengthen pharmacist medication grounding`
2. `2921cff` — `fix: harden clinical research privacy boundary`
3. `05c4aae` — `fix: improve entitlement and LINE reliability`
4. Report-only commit containing this document.

## Medication and pharmacist-assistant safety

| Finding | Status | Result |
| --- | --- | --- |
| PHARM-01 medication directive safety | Fixed | Layered Thai/English checks reject patient-specific stop/start/increase/decrease/adjust/switch directives while preserving grounded history and pharmacist-facing clarification questions. Unsafe output fails visibly through the existing invalid/unavailable contract. |
| PHARM-02 normalized medication grounding | Fixed | Comparison supports Thai digits, decimal comma/point, common Thai/English units, frequency, meal, PRN, and time expressions without rewriting the clinical source value. |
| PHARM-03 structural pair grounding | Fixed | Medication facts are grouped by normalized drug identity so a quantity belonging to one drug cannot ground a different drug. |
| Medication pair grounding | Yes | Cross-drug `Metformin 500 mg` / `Amlodipine 5 mg` swaps are rejected. |
| Patient-fact-bearing fields | Grounded | `caseSummary`, `recordedFacts`, `relevantMedicationContext`, `medicationChanges`, and `draftResponseForPharmacistReview` are checked; general reasoning remains possible but cannot masquerade as an unsupported patient medication fact. |
| Source attribution | Preserved and strengthened | Recorded facts, medication snapshots, medication differences, and general professional reasoning retain separate source categories; a category alone does not make inconsistent text valid. |

The adversarial set covers Thai and English directives, Thai numerals, cross-medication strength swaps, unsupported units and schedules, safe historical changes, and safe clarification questions. The assistant remains pharmacist-review-only and cannot auto-send.

## Clinical Research privacy

| Finding | Status | Result |
| --- | --- | --- |
| Research-focus identifier handling | Fixed | Common detectable LINE IDs, internal IDs, UUIDs, email, phone, national ID, and explicitly labelled name/address/DOB values are rejected in both research modes before provider execution. |
| Web-boundary handling | Fixed | `researchFocus` participates in privacy preparation while useful generic drug/condition terms remain allowed. Only sanitized research topics reach web search. |
| Raw case/PHI in web queries | No | Tests assert that raw focus, conversation, and private clinical context do not occur in web-bound request input. |
| PHARM-04 de-identification wording | Corrected | UI and documentation state that the pharmacist prepares de-identified text and PHIMOR's common-pattern validation is supplemental, not comprehensive. |
| PHARM-05 original claim | Reframed / not valid as originally stated | `controlled_live` does not bypass all privacy controls. The implemented path remains authorized minimized private context → private planner → sanitized topics → bounded authoritative web evidence → private synthesis. |

The existing four-topic, four-search, eight-source limits, domain allowlist, actual-citation validation, audit-before-return behavior, kill switch, assigned-case authorization, and no-auto-send boundary remain unchanged.

## Plus entitlement and LINE reliability

| Finding | Status | Result |
| --- | --- | --- |
| PLUS-01 concurrent paid-time loss | Confirmed and fixed on an alternate reachable path | Normal checkout already converges to one active order through the subject checkout lock and partial unique index. A late success for an expired old order can coexist with a newer order; their previous order-scoped fulfillment locks could calculate the same start time. Fulfillment now serializes by `plus-entitlement:<subject>` and re-reads the order, so two verified purchases stack 30 + 30 days. Same-order concurrent events still grant once. |
| PLUS-02 Plus vs pharmacist escalation | Owner product decision required | No entitlement/product semantics changed. |
| PLUS-03 entitlement lookup failure | Fixed | The user remains fail-closed with `ENTITLEMENT_UNAVAILABLE`, and a stable safe operational event is emitted without LINE identity, Care Profile, SQL, or PHI. |
| PH-09b LINE group member timeout | Fixed | Pagination shares one bounded overall `AbortController` deadline. Default is 5 seconds, clamped to 250–15000 ms, with a 100-page safety bound and safe timeout/provider errors. |
| PH-19b Gemini processor posture | Inventory complete | OpenAI remains the current primary declarative provider. Gemini remains callable only through explicit manual provider selection; no automatic fallback exists. If activated for PHI later, its processor/privacy review remains a commissioning prerequisite. |

## Extended business-logic audit

The review traced the Plus routes and orchestration, subscription ownership checks, pharmacist routes and assigned-case checks, consultation order/payment/webhook/reconciliation paths, message/state/realtime authorization, Clinical Research planner/evidence/synthesis contracts, and their repositories/providers.

No new reachable HIGH, MEDIUM-HIGH, or MEDIUM defect was confirmed. The following LOW defense-in-depth items were not changed because current idempotency, row locking, and uniqueness constraints prevent duplicate fulfillment or cross-user delivery:

| ID | Severity | Component | Evidence and impact | Recommended follow-up |
| --- | --- | --- | --- | --- |
| OVN-01 | LOW | Consultation payment duplicate-event consistency | `assertIncomingEventMatches()` does not compare the incoming provider checkout reference or payload hash after matching provider/event/order/payment/amount/currency/type. Order linkage rejects a first mismatched fulfillment, and a processed duplicate cannot grant a second consultation, so this is audit-consistency hardening rather than a current service-delivery bypass. | Consider comparing every immutable normalized event field in a separate payment hardening change, with provider replay fixtures. |
| OVN-02 | LOW | Plus and consultation reconciliation claims | The claim updates bound attempts but do not atomically repeat the due-time predicate. Two scheduler workers that selected the same due row may both make a provider status read. Event idempotency and fulfillment locks prevent duplicate service or paid-time loss, but the extra provider read is avoidable. | Add a due-time/claim-token predicate or `SKIP LOCKED` leasing in a separate scheduler efficiency change after multi-instance behavior is specified. |

Deferred LOW findings: 2.

## Dependency audit

`npm audit --omit=dev --json` was attempted exactly once. The npm advisory endpoint was unavailable, so the audit is deferred due to registry access. No package was changed. Installed direct versions observed locally:

- `ws@8.18.3`
- `uuid@9.0.1`

No `npm audit fix`, force update, package edit, or lockfile edit was performed.

## Verification

- Untouched baseline canonical suite: 1962 passed, 0 failed.
- Consolidated focused hardening suite: 217 passed, 0 failed.
- Final pre-report canonical suite: 1978 passed, 0 failed.
- JavaScript syntax: 446 passed, 0 failed.
- Real Chromium LIFF simulation: 20 journeys passed, covering Family and Pharmacist at 390×844 and 1280×800 where those flows change viewport; no provider or production connection was used.
- `git diff --check` over the overnight range: passed.
- Secret signature scan: 0 matches.
- Client-side secret/config/allowlist reference scan: 0 matches.
- Added unsafe logging/PHI logging candidate scan: 0 matches.
- No migration, dependency, lockfile, model-routing, provider-fallback, infrastructure, or production-setting change.

The final canonical suite and scans are run once more from the clean committed `HEAD` before handoff; the exact final SHA and status are included in that handoff.
