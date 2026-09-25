# Payment operations runbook

I3 has no admin API or dashboard. The status API exposes `manualReviewRequired` only to the guest who owns the checkout. An operator can use the following read-only query against the application database to find review cases; it returns no customer name, email, address, card token, or consent token.

```sql
SELECT
  attempt.id AS attempt_id,
  attempt.checkout_id,
  attempt.provider_reference,
  attempt.provider_transaction_id,
  attempt.state,
  attempt.provider_status,
  attempt.amount_cop,
  attempt.currency,
  attempt.created_at,
  attempt.unknown_outcome_at,
  attempt.manual_review_required_at
FROM payment_attempts AS attempt
WHERE attempt.manual_review_required_at IS NOT NULL
  AND attempt.state IN ('DISPATCHING', 'PENDING', 'UNKNOWN_OUTCOME')
ORDER BY attempt.manual_review_required_at, attempt.id;
```

## Resolution rules

1. Check the provider dashboard using the unique `provider_reference`. If a provider transaction ID is known, also use the read-only server-side status lookup.
2. Compare transaction ID, reference, amount, currency, and current status with the local attempt. A mismatch stays in manual review.
3. Do not resend transaction creation or release inventory while the outcome is unknown. Keep the hold until the provider outcome is established and the local transition is deliberately reconciled.
4. A confirmed approval while the reservation is still held must go through the normal approval transition so inventory and one fulfillment commit atomically. If inventory has already been released, keep the `FULFILLMENT_EXCEPTION` and decide fulfillment or compensation separately; do not decrement stock that may belong to another checkout.
5. A refund is a separate provider operation. I3 does not implement one.

I3 supplies automatic provider lookup only by a known provider transaction ID. It does not include an authenticated operator endpoint to resolve by reference or to repair domain state. Manual correction is a controlled operational action and should not be done with an ad hoc SQL update that bypasses the payment lifecycle transaction.
