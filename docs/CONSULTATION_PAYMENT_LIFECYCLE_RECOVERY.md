# Consultation payment and lifecycle recovery

This document describes the implemented recovery behavior for the 100 THB Pharmacist Consultation. It does not change pricing, Omise, the 24-hour consultation window, or the realtime chat architecture.

## Active checkout identity

One active checkout is allowed for one authenticated Family actor and one Care Profile while an order is:

- `draft`;
- `payment_pending`; or
- `paid` but not yet provisioned into a consultation case.

Migration `0013_add_consultation_payment_recovery.js` enforces that boundary with a partial unique index. Checkout creation also runs under the existing PostgreSQL transaction advisory lock. The unique index remains the final concurrency guard across tabs, devices, and backend instances.

The Family client discovers the current order through authenticated Care Profile-scoped REST. A recoverable PromptPay URL is stored only after it passes the server's credential-free HTTPS allowlist. Provider tokens, checkout internals, and raw payment responses are not projected.

## Scheduled recovery ownership

Every backend instance may reach the one-minute cron callback, but only one instance runs the logical consultation recovery cycle. The worker acquires the PostgreSQL session advisory lock `phimor:consultation-payment-lifecycle-v1` on a dedicated database connection. Other instances skip that cycle.

The owner runs, in order:

1. payment reconciliation for due pending or paid/unprovisioned orders;
2. consultation expiry materialization; and
3. lifecycle notification intent discovery.

The lock is released in `finally`. A lost process or database connection also releases a PostgreSQL session lock, allowing a later scheduler cycle to recover. Canonical order, case, event, and notification idempotency remains authoritative; the lock is not treated as exactly-once delivery.

## Reconciliation behavior

New PromptPay checkout rows become eligible for reconciliation after two minutes. Failures use a bounded 2–15 minute retry delay and store only a safe error code. Provider truth is processed through the existing verified payment ingestion and case provisioning services, which retain payment-event and order idempotency.

Provider/webhook and scheduler races converge through the existing order transaction locks and unique case/order constraints. A paid and already provisioned order only recovers the existing queued pharmacist notification identity; it does not create another case.

## Expiry behavior

The existing `sweepExpired()` service is now scheduled. It materializes the unchanged 24-hour boundary as an idempotent `closed` event and read-only case state. A LINE failure never rolls back the case state.

## Lifecycle notification policy

Approved lifecycle notifications use the existing outbox, recipient-specific stable dedupe keys, delivery leases, and stable LINE retry keys.

- accepted: one Family notification;
- new message: the first currently unread opposite-party message is eligible; advancing the existing read cursor suppresses the candidate, so an actively read room does not receive a LINE push for every message;
- near expiry: one Family notification at 120 minutes remaining;
- closed/expired: one Family notification.

The scheduler does not send message bodies, consultation questions, clinical context, or payment details. Notification enqueue and delivery failures do not roll back payment or consultation state.

## Deployment

Migration `0013` must be applied with the repository migration runner before deploying backend code that reads the new columns. No new environment variable is required. Existing `LIFF_ID_FAMILY`, `LIFF_ID_PHARMACIST`, Omise, LINE, and consultation realtime configuration remain required according to their existing runtime contracts.
