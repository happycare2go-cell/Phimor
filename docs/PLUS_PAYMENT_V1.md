# PHIMOR Plus Payment V1

## Product contract

- Plan: `plus_30d_v1`
- Price: 59 THB (`5900` satang)
- Entitlement: 30 days from verified payment, or from the current entitlement end when renewing early
- Renewal: manual only
- Automatic recurring charge: none
- Entitlement subject: authenticated LINE actor (`plus_entitlements.subject_type = line_user`)

Customer wording must remain truthful: “59 บาท / 30 วัน”, “ใช้งาน Plus ได้ 30 วันนับจากวันที่ชำระสำเร็จ”, “ครบกำหนดแล้วสามารถต่ออายุได้โดยชำระอีกครั้ง”, and “ไม่มีการตัดเงินอัตโนมัติ”.

## Free versus Plus

Core user-owned facts remain free: Care Profile, medication and appointment data/history, confirmed Lab results, Vital Signs, finalized Daily Care, and authorized Family access.

| Capability | Status | Plus rule |
| --- | --- | --- |
| AI Lab explanation | LIVE | Plus |
| Ask Doctor question preparation | LIVE | Plus |
| Doctor Visit AI organization | LIVE | Plus; manual factual record remains available |
| Care Profile AI assistant | LIVE | Plus |
| Medication change summary | LIVE | Plus |
| Monthly health summary | FUTURE | Not advertised |
| Smart reminders | FUTURE | Not advertised |

The backend capability registry in `plusEntitlementService` is authoritative. Frontend checks only improve UX.

## Purchase and recovery

Family routes are under `/api/plus`:

- `GET /offer`
- `GET /entitlement`
- `GET /orders/current`
- `POST /orders`
- `GET /orders/:orderId/status`
- `GET /orders/history`

The order request accepts only `returnTarget`, `idempotencyKey`, and `renew`. Return targets are symbolic and allowlisted: `lab_explanation`, `doctor_question_prep`, `doctor_visit_organization`, and `plus_home`. URLs, Care Profile IDs, Lab IDs, and clinical text are not accepted.

One active pending order is enforced per LINE actor by migration 0015. Reloads, other tabs, and other devices discover that order. A redirect or client-reported success never grants entitlement. Only verified Omise webhook/reconciliation data can grant it.

Omise is reused through the existing provider adapter. `metadata[purpose]` separates `phimor_plus` from `phimor_consultation`; both still use the same signature verification endpoint. Raw provider responses are not projected to Family.

Reconciliation runs through the shared scheduler coordinator behind the job-scoped PostgreSQL advisory lock `phimor:scheduler:plus-payment-reconciliation:v1`. It is skipped before reconciliation work while paid Plus is disabled and is bounded to 12 attempts per order. Provider webhook and reconciliation races converge on the order lock and unique entitlement `source_order_id`, so the same payment cannot extend entitlement twice. An order that exhausts the bound remains visible to support with its last safe error code; the scheduler does not retry it indefinitely. When paid Plus is enabled, `/ready` also verifies that the migration 0015 Plus payment tables are present; disabled Plus does not make those tables a runtime requirement.

## Entitlement dates

- Expired/free: `start = verified_paid_at`, `end = start + 30 days`.
- Early renewal: `start = max(current_entitlement_end, verified_paid_at)`, `end = start + 30 days`.
- Webhook replay: returns the already-linked entitlement and does not change dates.

## Failure and support

Family sees only safe Thai states: preparing, pending payment, payment confirming, active, failed, expired, or cancelled. A pending/confirming state never asks the user to pay again.

System Admin can use exact-reference lookup at `GET /api/admin/plus-payments/lookup?reference=...`. It returns a masked actor reference and operational state without provider identifiers or clinical data.

## Runtime configuration

Required for paid Plus:

```text
PLUS_ENABLED=true
PLUS_INTERNAL_ENTITLEMENT_ONLY=false
PLUS_PAYMENT_ENABLED=true
PLUS_AI_EXPLANATION_ENABLED=true
CONSULTATION_PAYMENT_PROVIDER=omise
OMISE_PUBLIC_KEY=<secret/manual>
OMISE_SECRET_KEY=<secret/manual>
OMISE_WEBHOOK_SECRET=<secret/manual>
```

The shared Omise values are server-side only. Never expose them to LIFF or commit them. Other Plus feature flags remain independently authoritative.

## Production release order

Do not enable Plus payment before schema and backend are compatible.

1. Hold Render Auto-Deploy for the backend and LIFF.
2. Verify and restore-test the production PostgreSQL backup.
3. Run `npm run migrate:status`; verify checksums and actual current version.
4. Apply all legitimate pending migrations in runner order: 0013 Consultation recovery, 0014 shared rate-limit windows, then 0015 Plus payment when pending, with `npm run migrate`.
5. Run `npm run migrate:status` again; require final version 0015 and no checksum mismatch.
6. Configure Omise and Plus environment values manually; keep `PLUS_PAYMENT_ENABLED=false` initially.
7. Deploy the compatible backend commit.
8. Verify `/health`, `/ready`, scheduler heartbeat, Omise webhook route, and reconciliation logs without payment bodies.
9. Deploy LIFF and verify Free/active/expired screens with test identities.
10. Enable Plus AI flags and `PLUS_PAYMENT_ENABLED=true` for the controlled cohort only after test-mode checkout/webhook/reconciliation succeeds.
11. Run one controlled 59 THB-equivalent provider test flow, duplicate webhook test, missed-webhook reconciliation, early renewal, and cross-user denial.
12. Confirm no automatic renewal mandate/charge exists before broader release.

Migration execution, provider calls, environment mutation, and production deployment are operational actions and are not performed by this implementation task.
