# PHIMOR Plus payment reversal policy decisions

Status: **OWNER DECISION REQUIRED BEFORE REAL-MONEY GO-LIVE**

This document records decisions that engineering must not infer. The current
technical gate accepts only `PLUS_PAYMENT_REVERSAL_MODE=manual_review` when paid
Plus is enabled. That setting means the operational path is configured; it does
not decide a refund or change an entitlement.

| Scenario | Owner decision required | Decision | Required evidence/approver |
| --- | --- | --- | --- |
| Full refund before Plus is used | Cancel immediately, preserve through period end, or another treatment? | **UNANSWERED** | Product owner, Finance, Legal/Privacy as applicable |
| Full refund after any Plus use | Eligibility and entitlement treatment? | **UNANSWERED** | Product owner and Finance |
| Partial refund | Preserve, shorten, suspend, or manually calculate entitlement? | **UNANSWERED** | Product owner and Finance |
| Duplicate payment | Which payment is refunded and how is stacked entitlement corrected? | **UNANSWERED** | Product owner, Finance, support evidence |
| Goodwill refund | Eligibility, approval level, and entitlement treatment? | **UNANSWERED** | Product owner and Finance |
| Dispute opened/pending | Keep, suspend, or restrict entitlement while unresolved? | **UNANSWERED** | Finance/Legal and product owner |
| Dispute won | Restore or preserve entitlement and how is prior action reconciled? | **UNANSWERED** | Finance/Legal and product owner |
| Dispute lost/chargeback | Cancel, shorten, suspend, debt treatment, and customer communication? | **UNANSWERED** | Finance/Legal and product owner |
| Provider authorization reversal/void | Entitlement treatment when service was or was not granted? | **UNANSWERED** | Finance and product owner |
| Refund window and supported payment method | Which Omise/Opn production methods and time windows are approved? | **UNANSWERED** | Finance with provider confirmation |
| Operator permissions | Which roles may record, approve, and apply an entitlement adjustment? | **UNANSWERED** | System owner and security owner |
| Customer communication | Required wording, timing, and escalation channel? | **UNANSWERED** | Product owner and support owner |

No application route or operator may convert these unanswered cells into an
automatic rule. The original successful transaction and every later financial
event remain immutable/additive regardless of the eventual policy.
