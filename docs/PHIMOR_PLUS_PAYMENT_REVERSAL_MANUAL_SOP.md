# PHIMOR Plus payment reversal manual SOP

This is an operational safety procedure, not authorization to issue a refund
or choose entitlement policy. Use it only after the responsible owner has
approved the applicable decision in
`PHIMOR_PLUS_PAYMENT_REVERSAL_POLICY_DECISIONS.md`.

1. Receive the provider event or customer refund/dispute request through an
   approved support channel. Do not copy PHI or payment credentials into logs.
2. Locate the Plus order using its safe PHIMOR reference through the bounded
   support lookup.
3. Verify the provider-side transaction in the official provider dashboard or
   authenticated API. Treat a notification body alone as insufficient.
4. Confirm the original provider payment, provider checkout, amount, currency,
   and order association. Stop on any mismatch.
5. Confirm the customer/order association from authoritative server records;
   never select entitlement by a user-supplied identity.
6. Check provider event identity and existing reversal history. A duplicate
   event must return the existing record and must not repeat an action.
7. Record the verified refund/reversal/dispute as an additive financial event
   in `manual_review_required`. Preserve the original successful payment.
8. Review current and historical entitlement separately from financial event
   state. Do not delete or overwrite an entitlement to represent a refund.
9. Apply only the owner-approved scenario policy. If the scenario is absent or
   ambiguous, take no entitlement action and escalate.
10. Record operator identity, approved action, reason category, approval
    reference, and timestamp through the approved audit mechanism. Do not store
    narrative PHI, raw provider payload, card data, keys, or credentials.
11. Reconfirm that the original transaction and later reversal event remain
    queryable and that another user's entitlement was not affected.
12. Communicate the customer-facing result using approved wording and the
    approved support channel.
13. Escalate amount/currency mismatch, unknown events, multiple customers,
    chargeback/dispute ambiguity, provider inconsistency, or missing policy.

The current foundation records normalized, independently verified reversal-like
events for manual review and performs no automatic entitlement adjustment. The
Omise webhook adapter is not yet wired to refund/dispute/reversal events; its
production event mapping must be confirmed and tested before paid Plus is
enabled.
