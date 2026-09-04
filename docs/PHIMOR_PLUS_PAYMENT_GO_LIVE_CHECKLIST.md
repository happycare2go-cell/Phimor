# PHIMOR Plus payment go-live checklist

Status: **NOT AUTHORIZED FOR REAL-MONEY GO-LIVE**

Every gate below must be evidenced before `PLUS_PAYMENT_ENABLED=true`.

- [ ] Production payment provider configuration and supported payment methods
      approved; livemode behavior explicitly reviewed.
- [ ] Price and currency remain server-fixed at 59 THB (`5900`, `THB`).
- [ ] Provider webhook signature, freshness, independent retrieval, and purpose
      validation pass production-safe tests.
- [ ] Event and checkout idempotency pass duplicate/reordered delivery tests.
- [ ] Missed-webhook reconciliation and bounded failure observability pass.
- [ ] Entitlement grants exactly 30 days, early renewals stack, and concurrent
      orders for the same subject cannot lose paid time.
- [ ] Active-order uniqueness/concurrency protection is deployed.
- [ ] System Admin safe-reference support lookup is available and tested.
- [ ] `PLUS_PAYMENT_REVERSAL_MODE=manual_review` is explicitly configured and
      `/ready` has no reversal-configuration issue.
- [ ] Full/partial refund, void/reversal, dispute, and chargeback provider event
      semantics for the actual Omise/Opn production method are confirmed using
      official provider documentation and test fixtures.
- [ ] Refund and entitlement policy decisions are owner-approved in
      `PHIMOR_PLUS_PAYMENT_REVERSAL_POLICY_DECISIONS.md`.
- [ ] Chargeback/dispute pending, won, and lost policies are approved.
- [ ] Manual reversal SOP is staffed, access-controlled, and exercised with
      synthetic/test transactions; any future automation requires separate
      review.
- [ ] Original success and additive reversal audit history are queryable.
- [ ] Operator action audit captures actor/action/reason/time without PHI or
      payment credentials.
- [ ] Production secrets exist server-side only and public-config/LIFF scans
      are clean.
- [ ] Test-mode then explicitly approved livemode synthetic transaction covers
      success, replay, missed webhook, full refund, partial refund where
      supported, and cross-user denial.
- [ ] Kill switch/rollback procedure keeps ordinary PHIMOR usable and does not
      delete financial or entitlement history.

Passing the configuration gate is not evidence that reversal events are
automatically handled. The current accepted mode is manual review only; the
system does not implement automatic entitlement cancellation.
