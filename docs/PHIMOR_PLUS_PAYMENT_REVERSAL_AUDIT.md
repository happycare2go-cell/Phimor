# PAY-REV-01 — Plus payment reversal lifecycle audit

Status: **CONFIRMED GO-LIVE GAP**

Scope: current Plus order, Omise adapter, webhook dispatcher, ingestion,
reconciliation, entitlement, repository, migration 0015, support projection,
and Family payment UI.

## Provider capability evidence

Official Omise documentation establishes these general capabilities:

- the Refunds API creates a refund for an undisputed captured charge and
  accepts an amount, so full and partial refunds are represented; a full refund
  before settlement may be processed as a void;
- supported webhooks include `refund.create`, `charge.reverse`, and the
  `dispute.create`, `dispute.update`, `dispute.accept`, and `dispute.close`
  lifecycle;
- the Charge resource exposes refunded amount/list, reversal state/time,
  dispute, and void state; and
- disputes use `open`, `pending`, `won`, and `lost` states.

Sources:

- <https://docs.omise.co/refunds-api>
- <https://docs.omise.co/api-webhooks?version=2019-05-22>
- <https://docs.omise.co/charges-api?version=2019-05-22>
- <https://docs.omise.co/disputes-api/japan>

These documents do not by themselves prove that every operation is available
for the exact PHIMOR Plus PromptPay account, production country configuration,
or settlement state. No distinct official `chargeback` webhook name was
confirmed; chargeback handling may be represented through the dispute
lifecycle. Therefore the implementation status is:

`PROVIDER_REVERSAL_SEMANTICS_REQUIRES_CONFIRMATION`

Engineering must validate actual method eligibility, event payloads, resource
retrieval, livemode behavior, and test fixtures before wiring the adapter. No
external event name in this audit is treated as implemented PHIMOR behavior.

## Current PHIMOR behavior

`OmisePaymentProvider` maps retrieved Charge status only to
`payment_succeeded`, `payment_failed`, `payment_pending`, or
`payment_unknown`. `omiseWebhookDispatchService` authenticates the webhook and
then ignores every event key other than `charge.complete`. Plus reconciliation
also retrieves only the current Charge and feeds those four statuses to normal
payment ingestion.

| Successful payment later becomes | Webhook transport authenticated? | Reversal persisted? | Reversal idempotency? | Original success/history | Entitlement | Operator alert | Support lookup | Automatic action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Full refund | Signed incoming event is verified, then ignored by event-key dispatch | No | No production path | Preserved | Unchanged | No | Order/original charge only; not refund event | None |
| Partial refund | Signed incoming event is verified, then ignored | No | No production path | Preserved | Unchanged | No | Order/original charge only | None |
| Void/refund-before-settlement | Signed incoming event is verified, then ignored | No | No production path | Preserved | Unchanged | No | Order/original charge only | None |
| Charge reversal | Signed `charge.reverse` would be verified, then ignored | No | No production path | Preserved | Unchanged | No | Order/original charge only | None |
| Dispute opened/updated/closed | Signed dispute event would be verified, then ignored | No | No production path | Preserved | Unchanged | No | Order/original charge only | None |
| Chargeback | Exact external representation not confirmed | No | No production path | Preserved | Unchanged | No | Order/original charge only | None |

An ignored signed webhook is not reversal support: there is no durable domain
record, operator task, reconciliation policy, or entitlement decision.

## Manual-review foundation added

The existing `plus_payment_transactions` table can preserve a normalized
reversal-like event without a migration because `event_type` is an extensible
bounded string, amount/currency and provider references already exist, and
`processing_status='verified'` accurately means authenticated but not resolved.

`plusPaymentReversalService` is deliberately provider-neutral and not exposed
as a route. When a future adapter supplies an independently verified normalized
event, it:

- accepts only known internal reversal categories;
- requires `PLUS_PAYMENT_REVERSAL_MODE=manual_review`;
- locks and reloads the referenced order;
- requires the original processed successful transaction and matching
  provider payment/checkout/currency;
- refuses an amount greater than the original payment;
- stores a new event with `MANUAL_REVIEW_REQUIRED`;
- deduplicates by provider/event identity and rejects conflicting replays;
- emits metadata-only operational visibility; and
- never changes, deletes, shortens, or suspends an entitlement.

The successful financial row remains immutable and the normalized reversal is
additive. Cross-user entitlement mutation is structurally absent because the
service derives association from the locked order and original successful
payment and has no entitlement writer.

This foundation does not complete provider wiring or owner policy. Operator
entitlement action and its audit trail cannot be implemented truthfully until
the owner decision table is approved. Paid Plus must remain disabled until the
go-live checklist is complete.
