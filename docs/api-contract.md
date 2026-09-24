# Initial API contract (I0 proposal)

This is a resource and behavior contract for review, not generated OpenAPI and not an implemented API. JSON property names and precise customer/delivery fields may change after the user resolves the open decisions. Amounts use integer COP minor units.

## Domain records to persist

| Record | Purpose | Key consistency rule |
|---|---|---|
| `Product` | Seeded catalog, unit price, and physical/reserved quantity. | `0 <= reserved_quantity <= physical_quantity`; only the API changes price/stock. |
| `Checkout` / `CheckoutItem` | Customer/delivery snapshot, immutable price/fee snapshot, and checkout state. | The accepted total is computed and stored by the API; never recompute historical attempts using a later catalog price. |
| `Reservation` | Quantity held for a checkout. | One active hold per checkout/item; `HELD` transitions once to `COMMITTED` or `RELEASED`. |
| `IdempotencyRecord` | Scope, key, canonical request fingerprint, resource ID, and stable result reference. | Unique `(scope, operation, key)`; same fingerprint replays the resource; different fingerprint returns `409 Conflict`. |
| `PaymentAttempt` | Local attempt state, provider reference/ID, amount, timestamps, and redacted response evidence. | Unique local attempt key and provider reference; at most one open/pending/unknown attempt per checkout. Never store PAN/CVC. |
| `WebhookReceipt` | Minimal verified receipt/fingerprint for durable dedupe and troubleshooting. | Signature and transaction identity validated before transition; duplicate receipt/state has no duplicate side effect. |
| `Fulfillment` | Local delivery/order work created on confirmed approval. | Unique per checkout; created atomically with `PAID`/reservation commit. |

The initial database concurrency strategy is a conditional stock update or row lock inside PostgreSQL. Local checkout and hold changes are transactional. Provider calls, webhook delivery, and email/delivery effects are external boundaries and cannot participate in the SQL transaction.

## Proposed routes

| Method and route | Purpose | Expected behavior |
|---|---|---|
| `GET /api/v1/products` | List seeded products. | Return catalog price and derived available stock; no product write route is needed for the challenge. |
| `GET /api/v1/products/{productId}` | Product detail. | Return `404` for unknown product. |
| `POST /api/v1/checkouts` | Create checkout and reserve inventory. | Requires `Idempotency-Key`; atomically validates stock, snapshots server-calculated totals, persists the hold. Return `201` on first creation and the same checkout on replay. Return `409` for insufficient stock or same key with different request. |
| `GET /api/v1/checkouts/{checkoutId}` | Read canonical checkout, reservation, and payment state. | Return safe customer-facing status/amounts; never return private provider credentials or card details. This is the frontend's refresh-recovery source. |
| `POST /api/v1/checkouts/{checkoutId}/payment-attempts` | Start one explicit card attempt. | Requires a separate `Idempotency-Key`, one-time provider card token, current acceptance tokens/consent evidence, and an eligible active hold. Persist attempt before provider call; call outside SQL transaction. Return `202 Accepted` while pending/unknown or a confirmed local attempt representation. |
| `GET /api/v1/checkouts/{checkoutId}/payment-attempts/{attemptId}` | Read one attempt. | Return only local status and safe provider identifiers/details. A client retry with the same key reads the same attempt; it never starts another provider POST. |
| `POST /api/v1/webhooks/payment-events` | Receive provider events. | Verify signature using provider event configuration, validate transaction identity/state, persist the minimal receipt, apply the idempotent transition, then acknowledge. Redeliveries are safe. |

Possible lifecycle endpoints such as explicit cancellation/void and operational reconciliation are not yet frozen. Their semantics must preserve `CANCEL_PENDING` and `UNKNOWN_OUTCOME`; neither endpoint can label an unresolved transaction as failed merely because the caller timed out.

## Idempotency behavior

- Require a fresh high-entropy client command key for checkout creation and each deliberate payment attempt. Scope it to a server-controlled guest/session/customer identity and operation; the identity mechanism is still an open decision.
- In one PostgreSQL transaction, insert the scoped key/fingerprint and create its resource. A uniqueness race reads and returns the winning resource rather than making a second reservation or provider request.
- If the same key is repeated with the same canonical business payload, return the original resource/state. If the key is reused with different business input, return `409` without mutation.
- Never store a raw card number/CVC. The provider card token is transient and must not appear in logs, error bodies, idempotency response bodies, or analytics. Do not persist it in a general outbox. A new deliberate payment attempt needs a new provider reference and newly tokenized card.
- Use a unique provider reference for correlation, not as proof of provider-side replay safety. A provider duplicate-reference response is surfaced for reconciliation; it is not assumed to contain the original transaction result.

## Example shapes (illustrative only)

`POST /api/v1/checkouts` request:

```json
{
  "productId": "prod_demo_1",
  "quantity": 1,
  "delivery": {
    "recipient": "Example Buyer",
    "email": "buyer@example.test",
    "address": "Example address"
  }
}
```

Response contains `checkoutId`, `state`, line items, `baseFee`, `deliveryFee`, `totalAmountInMinorUnits`, `currency`, `reservationExpiresAt`, and a payment eligibility summary. The API rejects unsupported/missing delivery fields and ignores any client-submitted amount.

`POST /api/v1/checkouts/{checkoutId}/payment-attempts` includes `providerCardToken` and accepted consent token identifiers in the HTTPS request body. These values are redacted before request logging. The response contains `attemptId`, local state, and a status URL; it does not expose the provider's private key or return PAN/CVC.

## API error/status conventions

- `400 Bad Request`: malformed or invalid fields.
- `404 Not Found`: resource not found in the caller's scope.
- `409 Conflict`: insufficient stock, idempotency-key payload mismatch, or an existing open attempt prevents a new attempt.
- `202 Accepted`: payment dispatch is pending or its outcome is unknown and must be polled/reconciled.
- `200 OK`: read/replay of an existing checkout or attempt.
- Provider decline/error is represented as a persisted domain state, not mislabeled as an HTTP transport failure.

Finalize exact schemas, authentication/session scope, privacy retention, webhook request size limits, and generated OpenAPI in I1–I3 after the user approves the I0 assumptions.
