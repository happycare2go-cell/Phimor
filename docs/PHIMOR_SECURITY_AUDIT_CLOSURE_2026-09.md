# PHIMOR Security Audit Closure — September 2026

## Scope and evidence boundary

This document records the evidence-backed status of the reviewed security findings. It does not certify production acceptance, infrastructure configuration, legal compliance, or third-party processing terms. This closure run did not access production, change environment variables, invoke live providers, push commits, or deploy.

Repository lineage:

- Original audit-review baseline: `83c9ea3157780508042adde13d29f61c2bab902c`
- Authoritative Phase-1 implementation baseline: `96d01df5c7eeb9eb1dfdbe4236afbdb9fd6c3e96`
- Phase-1 release/deployment commit: `d342b950382ee52f8d9969b60a59c85f2c6ad0fb`
- Overnight remediation baseline: `d342b950382ee52f8d9969b60a59c85f2c6ad0fb`
- Phase 3: `a5bf1a4625d0d4f7a54065ff850d509feb178526` — `fix: harden request and download security`
- Phase 4: `7c65f9f03c6205e3998e8105a4c44e2a4b345bdf` — `perf: optimize legacy authorization lookups`
- Phase 5: `e918926f63eaa2749934af5a358208c681db10b7` — `fix: harden ai document instruction boundaries`

The Phase-1 commit is present on `origin/main`. Its production deployment was not independently queried during this offline run and must be confirmed through the normal release evidence before any later deployment.

## Finding status

| Finding | Status | Evidence / remaining boundary |
|---|---|---|
| PH-A1 | RESOLVED | Center staff mutations use canonical identity locks; duplicate-safe revocation, role convergence, context cleanup, and owner-transfer serialization are covered by regression tests. |
| PH-A2 | RESOLVED | Caregiver invite consumption and profile membership mutation share deterministic transaction locks and race coverage. |
| PH-A3 | WITHDRAWN | Consensus review classified the reported mechanism as a false positive. |
| PH-A4 | RESOLVED | `familyRequestCare2go` and `care2goAcknowledge` have no production callers and are no longer public service exports. |
| PH-B1 / PH-B1a | RESOLVED | All audited TransportPlan mutations use `transport-plan:<planId>`; state/history transitions are serialized and provider I/O remains outside transactions. |
| PH-B2 | RESOLVED | Resident selection for a card is serialized by `card-selection:<cardId>` and revalidated inside the transaction. |
| PH-01 | DEFERRED-REGISTRY | Registry/advisory services were unavailable. No dependency or lockfile was edited and no advisory result was fabricated. |
| PH-02 | DEFERRED-RUNTIME | Trust-proxy behavior requires proof against the actual production proxy chain before a code/config decision. |
| PH-03 | RESOLVED-HOT-PATH | Explicit parameterized JSONB equality helpers replaced predicate-wide scans in critical authorization and identity paths. Broader legacy administrative scans remain architecture debt. |
| PH-04 | RESOLVED-CONCRETE-LOCKING / ARCHITECTURE DEBT REMAINS | Confirmed race paths now share deterministic transaction/advisory locks. The legacy JSONB persistence layer still requires disciplined per-domain locking. |
| PH-05 | DEFERRED-RUNTIME | PostgreSQL TLS mode and certificate verification must be checked against the deployed database endpoint and provider contract. |
| PH-06 | RESOLVED | PDF download payloads use confidential authenticated tokens derived only from `PDF_DOWNLOAD_SECRET`; authorization is rechecked at download. |
| PH-07 | RESOLVED | JPEG, PNG, and WebP signatures are verified after decode and must agree with declared MIME type. |
| PH-08 | RESOLVED | Production ignores insecure LINE identity/unsigned-webhook bypass flags and readiness reports bounded issue codes. |
| PH-09 | RESOLVED-TIMEOUT | LINE ID-token verification uses a bounded AbortController timeout with safe failure semantics and timer cleanup. |
| PH-10 | INTENTIONAL-GATE | Omise live-mode enablement remains an explicit go-live/configuration gate. |
| PH-11 | RESOLVED | Ordinary JSON bodies are bounded separately from an exact allowlist of image/base64 routes; LINE and Omise webhook parsing contracts are preserved. |
| PH-12 | RESOLVED | Production operational errors use bounded structured metadata and exclude raw message, stack, body, identity, clinical, provider, and credential content. |
| PH-13 | DEFERRED-REGISTRY-MAINTENANCE | npm is authoritative for production (`npm ci --omit=dev`); no real pnpm consumer was found. `pnpm-lock.yaml` removal is deferred to the dependency-maintenance change. |
| PH-14 | NON-FINDING | Allowing requests without an Origin header is not treated as an authentication bypass. |
| PH-15 | NON-FINDING | A central schema library is an architecture option, not a demonstrated security defect. |
| PH-16 | NON-FINDING / CLEANUP | The X-Line-User-Id CORS allow-list is cleanup only; production identity bypass is already fail-closed. |
| PH-17 | RESOLVED | Production `findOne` returns `null` on no match, consistent with the memory/test implementation. |
| PH-18 | GOVERNANCE | LINE group membership, administrator ownership, departure, recovery, and periodic access-review procedures require an approved operational policy. |
| PH-19 | GOVERNANCE | Gemini processing requires approved DPA, region/data-transfer, retention, deletion, incident, and subprocessor review before production acceptance. |
| PH-20 | RESOLVED | Reachable AI tasks declare source content untrusted, Gemini separates trusted instructions from context/text/image data, and strict output/clinical safety validation remains in force. |
| PH-21 | WITHDRAWN | Consensus review classified the reported mechanism as a false positive. |

## Phase evidence

### Baseline and Phase 1

- Untouched baseline performance revalidation: 7/7 isolated passes; minimum 155.6456 ms, maximum 213.1743 ms, median 178.8665 ms; threshold unchanged at 500 ms.
- Untouched canonical baseline: 1798/1798.
- Phase-1 focused tests: 245/245.
- Phase-1 full canonical suite: 1798/1798.
- Phase-1 JavaScript syntax: 411/411.
- Phase-1 `git diff --check` and secret/privacy scans: pass.

### Phase 2 — dependency and lockfile authority

- Installed/resolved `ws`: 8.18.3.
- Installed/resolved `uuid`: 9.0.1.
- Production package manager: npm; deployed install command is `npm ci --omit=dev`.
- Real repository/CI/script pnpm consumers found: 0.
- Registry/advisory lookup was unavailable, so current advisory severity and fixed-version evidence remain unverified.
- No package manifest or lockfile was changed. Registry work must resume only through the authoritative npm registry and a reviewed dependency-maintenance commit.

### Phase 3 — request and download security

- Focused tests: 121/121.
- Full canonical suite: 1805/1805.
- JavaScript syntax: 412/412.
- `git diff --check` and secret/privacy scans: pass.
- PDF token: AES-256-GCM, random 12-byte IV, SHA-256-derived key from the dedicated secret, authenticated versioned format, no persistence, short expiry, and authorization recheck.
- LINE verification: configurable bounded timeout (safe default 5 seconds; bounded range 250–15000 ms), AbortController cancellation, and no provider payload leakage.
- JSON parsing: conservative ordinary limit and exact-route 10 MiB image allowance while decoded-image validation remains authoritative.

### Phase 4 — authorization query hot paths

- Focused tests: 129/129.
- Full canonical suite: 1809/1809.
- JavaScript syntax: 413/413.
- `git diff --check` and secret/privacy scans: pass.
- Converted paths include Center staff authentication, Family access, Resident-to-Center authorization, Family profile permissions, active Center context, routine Center membership/approver lookups, and Care Profile/Resident identity lookups used by those paths.
- Criteria accept only validated fields and scalar values; values remain SQL parameters; multiple matches use deterministic creation/id ordering; no match returns `null`.

### Phase 5 — untrusted AI source boundary

- AI-focused tests: 171/171.
- Full canonical suite: 1814/1814.
- JavaScript syntax: 415/415.
- `git diff --check` and secret/privacy scans: pass.
- Covered reachable paths: general/medication document extraction, Lab document extraction, Lab explanation, doctor-question preparation, doctor-visit free text, Plus intent/explanation, and pharmacist consultation assistance.
- Trusted task instructions explicitly reject commands, prompts, and URLs contained in source data. Gemini transports structured context, user/source text, and uploaded-image notice in separately marked untrusted parts.
- Output schemas, unknown-field rejection, grounded-fact checks, medical-safety checks, and human-review requirements were not weakened.
- Prompt/audit versions were advanced where the trusted prompt contract changed. No live AI request was made.

## Recommended future JSONB indexes

These are review candidates, not migrations or runtime-created indexes. Existing data cardinality and duplicates must be checked before production DDL.

- `careProfiles ((data->>'care_profile_id'))` for authoritative profile identity lookup.
- `residents ((data->>'resident_id'))` for authoritative Resident identity lookup.
- `CareProfileMembers ((data->>'care_profile_id'), (data->>'line_user_id'), (data->>'status'))` for routine Family permission checks.
- `StaffContexts ((data->>'line_user_id'))` for active Center-context lookup.
- `CenterStaff ((data->>'center_id'), (data->>'line_user_id'))`, with status/role selectivity assessed after duplicate preflight, for routine staff authorization.

Any uniqueness constraint for legacy staff/member identities requires a separate read-only production preflight and explicit migration review; this closure run did not create a migration.

## Production acceptance required before a future deployment

1. Confirm the intended source commit and clean build artifact through the normal release process.
2. Confirm required secrets exist without displaying their values, including `PDF_DOWNLOAD_SECRET`.
3. Verify `/health` and bounded `/ready` behavior and confirm safe readiness issue codes are empty.
4. Validate LINE ID-token timeout and signed-webhook behavior in the deployed non-user-data smoke path.
5. Confirm ordinary request limits and approved image ingestion limits without uploading identifiable clinical fixtures.
6. Verify PostgreSQL TLS mode/certificate handling and the real proxy chain before closing PH-02/PH-05.
7. Complete dependency audit when the authoritative registry is available; review and commit lockfile changes separately.
8. Approve LINE group governance and Gemini/DPA/data-transfer governance before treating PH-18/PH-19 as closed.
9. Run the canonical regression and safe log/secret scans on the exact deployment candidate.
10. Do not deploy any local-only overnight commit until human review explicitly approves it.

## Final code-state rule

Code-resolved findings are closed only for the reviewed repository commits and tests listed above. Deferred runtime, registry, and governance findings remain open until their own evidence is recorded. No production identifier, secret, credential, raw provider payload, or protected health information is included in this document.
