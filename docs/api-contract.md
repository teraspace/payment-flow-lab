# API contract: I0 baseline, I2 checkout, I3 payments, and I4 browser recovery

Checkout amounts use integer COP units. I2 implements catalog and anonymous checkout reservations. I3 adds the payment-attempt, provider, webhook, reconciliation, and fulfillment lifecycle. I4 integrates these routes with a React checkout and adds guest-command recovery plus latest-attempt lookup for browser refreshes.

## I2 implemented records

| Record | Purpose | Consistency rule |
|---|---|---|
| `products` | Seeded catalog, price, physical and reserved quantity. | `0 <= reserved_quantity <= physical_quantity`; public routes cannot change price or stock. |
| `guest_sessions` | Server-issued anonymous session whose opaque token is kept in an HttpOnly cookie. | Only a SHA-256 token hash is stored; session scope owns checkout writes, replays, and reads. |
| `customers` / `deliveries` | Minimal buyer and delivery snapshots for one checkout. | No payment-card data is accepted or persisted. After 30 days from checkout creation, a scheduled job clears name/email and recipient/address together. |
| `checkouts` / `checkout_items` | Checkout state, customer/delivery links, integer totals, and immutable item price/name/SKU snapshot. | The API computes totals; later catalog price changes do not alter an existing checkout. I2 supports one product per checkout. |
| `reservations` | Held product quantity and expiry. | `HELD` transitions once to `COMMITTED` or `RELEASED`; both reservation state and product counters change in the same PostgreSQL transaction. |
| `idempotency_records` | Session scope, operation, key hash, canonical payload fingerprint, and checkout reference. | Unique `(guest_session_id, operation, idempotency_key_hash)`; same payload replays the checkout, different payload returns `409`. At 30 days the PII-derived fingerprint is cleared while the key and checkout history remain; replay then returns `410`. |
| `payment_attempts` | One durable row and unique local/provider reference per deliberate card attempt. | Same checkout/key/payload replays the same row; changed input conflicts. The row commits before network dispatch. Card and consent tokens are never stored raw; their request fingerprint is erased with checkout PII at 30 days. |
| `payment_event_receipts` | Minimal verified event identity, status, amount, timestamp, fingerprint, and disposition. | Unique fingerprint prevents duplicate event effects. The full provider payload and card data are not retained. The configurable retention defaults to 365 days. |
| `fulfillments` | One post-approval fulfillment record per checkout. | Unique checkout constraint; approval, inventory commitment, and fulfillment creation commit in one PostgreSQL transaction. A late approval after release becomes `FULFILLMENT_EXCEPTION`. |

PostgreSQL transactions and a conditional `UPDATE products ... WHERE physical_quantity - reserved_quantity >= quantity` protect inventory. The database check also rejects a negative available count. Domain idempotency is a separate API promise: a uniqueness constraint alone is not the replay contract.

## I2 live routes

| Method and route | Behavior |
|---|---|
| `POST /api/v1/guest-session` | Creates an anonymous session if needed, sets an opaque `HttpOnly; SameSite=Lax` cookie, and returns its expiry (`201` when created, `200` when reused). The cookie is `Secure` in production. The raw token is never returned in JSON or stored in PostgreSQL. Expired sessions without a checkout are cleaned up during initialization. |
| `GET /api/v1/products` | Lists active seeded products with description, image path, price, currency, and derived available quantity. Before returning, it releases expired I2 reservations in a transaction. |
| `GET /api/v1/products/{productId}` | Reads one active product; returns `404` if missing or inactive. Also materializes any expired reservations first. |
| `POST /api/v1/checkouts` | Requires a valid guest cookie and `Idempotency-Key`. Validates one product and quantity, computes server totals, stores the customer/delivery snapshots, and creates the stock hold atomically. First result is `201`; same-key replay is `200`. |
| `POST /api/v1/checkouts/recover` | Requires the owning guest cookie and the original `Idempotency-Key`; returns the checkout without resending or storing customer data in the browser. Returns `404` if no command record exists and `410` after its PII-derived fingerprint has been erased. |
| `GET /api/v1/checkouts/{checkoutId}` | Reads only a checkout belonging to the current guest session. Returns `404` for an unknown checkout or one owned by another session. Expiration is applied before the response. |

The initial reservation lasts 600 seconds (10 minutes) by default. An undispatched checkout expires and releases stock transactionally before catalog reads, checkout creation, and checkout reads. `PAYMENT_PENDING` and `UNKNOWN_OUTCOME` holds do not auto-expire. A first confirmed `DECLINED` or `ERROR` starts one 10-minute retry window; if the single retry also ends in confirmed failure, the hold is released immediately. Otherwise, the hold is released when that retry window expires. A replay returns the existing checkout in its current state. To create a fresh hold, the client sends a new checkout idempotency key.

I2 has no product-write route. Product seed fixtures are installed by migration. Their amounts and inventory are demonstration data, not a business price list.

## I2 checkout request and response

The guest session must be initialized before the first checkout request. The browser sends the cookie with credentials. `Idempotency-Key` accepts 16–128 ASCII letters, digits, periods, underscores, colons, or hyphens; clients should use a cryptographically random value such as `crypto.randomUUID()`.

The cookie uses `SameSite=Lax`. Terraform routes `/api/*` through the same CloudFront hostname as the frontend, so browser calls stay same-site. The full browser checkout path remains to be verified in I4/I6.

```json
{
  "productId": "00000000-0000-4000-8000-000000000001",
  "quantity": 1,
  "customer": {
    "fullName": "Example Buyer",
    "email": "buyer@example.test"
  },
  "delivery": {
    "recipient": "Example Buyer",
    "address": "123 Example Street, Apartment 4"
  },
  "totalAmountInMinorUnits": 1
}
```

The last property is optional and ignored; all accepted amounts come from the server's product snapshot and configured fees. Names/email/address are trimmed; email is lowercased. Validation and PostgreSQL constraints both enforce the size and quantity limits.

The response includes `checkoutId`, the current checkout lifecycle state, customer and delivery snapshots, one item with snapshotted price/name/SKU, `subtotalMinor`, `baseFeeMinor`, `deliveryFeeMinor`, `totalAmountInMinorUnits`, `currency`, and reservation state/expiry. Checkout states include `RESERVED`, payment pending/unknown/failed, `PAID`, `CANCELLED`, `EXPIRED`, and `FULFILLMENT_EXCEPTION`. Reservation state is `HELD`, `COMMITTED`, or `RELEASED`. Amounts are non-negative safe integers in COP units. After the retention job redacts personal data, the four customer/delivery values are returned as `null`; the checkout and inventory history remain readable by its guest session.

The fee variables are `CHECKOUT_BASE_FEE_MINOR` and `CHECKOUT_DELIVERY_FEE_MINOR`; the user approved demo defaults of COP 5,000 base charge and COP 8,000 delivery. These are configurable whole-COP amounts, not taxes or withholding. The integration suite sets the same values explicitly to prove that the API ignores a client-supplied total. `CHECKOUT_RESERVATION_TTL_SECONDS` defaults to `600`, and `GUEST_SESSION_TTL_DAYS` defaults to `30` (the user approved this session lifetime on 2026-09-24).

## Idempotency and transaction boundary

1. The API hashes the idempotency key and hashes a normalized canonical payload containing product, quantity, customer, and delivery fields. The fingerprint is temporary because it is derived from personal data.
2. In one PostgreSQL transaction, it claims the unique session/operation/key hash before touching inventory. The winning request reserves stock with a conditional update, inserts customer/delivery/checkout/item/reservation snapshots, then commits.
3. A uniqueness race waits for the winning transaction. Matching fingerprint returns the existing checkout without another stock update. A different fingerprint returns `409` without mutation.
4. If the stock is insufficient or any later write fails, rollback removes the key claim, stock increment, checkout, customer, delivery, and reservation. A rejected request that created no checkout may be retried with corrected input.
5. GET checkout and idempotency replay require the original guest cookie. Checkout identifiers alone do not grant access.

Every five minutes, the API checks for checkouts at least 30 days old and redacts up to 500 per PostgreSQL transaction. It clears customer name/email, recipient/address, and the request fingerprint together, but retains totals, item snapshots, reservations, checkout rows, session ownership, and the idempotency-key hash. The scheduler is safe to run in more than one task: it locks candidate checkouts and skips rows another task is processing. After fingerprint removal, replaying the old idempotency key returns `410 Gone`; it cannot reconstruct the original response from a PII digest.

Redaction is intentionally irreversible. The retention migration refuses to restore `NOT NULL` if any row has already been scrubbed; recovering that data requires a separately protected backup, not a synthetic replacement value.

Database consistency protects each local transition; idempotency makes repeated commands resolve to one stable domain resource. Neither property provides exactly-once execution across a future payment-provider boundary.

## I3 payment routes

| Method and route | Planned behavior |
|---|---|
| `POST /api/v1/checkouts/{checkoutId}/payment-attempts` | Requires a separate `Idempotency-Key`, a one-time card token from browser-side tokenization, and both current consent tokens. First result is `201`; matching replay is `200`; changed payload under the same key is `409`. The API computes the provider amount and integrity signature, persists the attempt in a short SQL transaction, then calls the provider after commit. |
| `GET /api/v1/checkouts/{checkoutId}/payment-attempts/{attemptId}` | Requires the owning guest session. Returns attempt ID/number, domain state, amount in whole COP, currency, timestamps, and manual-review flag. When a provider transaction ID is known, it may reconcile through the server-side status API. It never sends a second create request. |
| `GET /api/v1/checkouts/{checkoutId}/payment-attempts/latest` | Requires the owning guest session; returns and reconciles the latest attempt after refresh. Returns `404` when no attempt exists. It never creates or resends a provider transaction. |
| `POST /api/v1/webhooks/payment-events` | Verifies event environment, timestamp, dynamic signed properties, checksum, reference, transaction ID, amount, currency, and status. The dynamic property list must sign every field used to authorize a payment. Persists only a minimal receipt and applies the state transition atomically before returning `200`. Duplicate valid events return `200` without repeating effects. Invalid shape/signature returns `400`; an unconfigured verifier returns `503`; storage failures return `500` so delivery can retry. |

The public API and local catalog use whole COP values (`42,000` means COP 42,000). The adapter converts that value to the provider's integer centavos (`4,200,000`) only at the provider boundary. The provider's returned reference, amount, currency, and transaction ID are checked before a state transition.

Provider transport failure, timeout, 5xx, malformed create response, or an ambiguous non-2xx response becomes `UNKNOWN_OUTCOME`. The configured adapter treats explicit `400`/`401` rejection as `REJECTED_NO_TRANSACTION`: it stores the HTTP status, returns the checkout to `RESERVED`, and does not count the response as a provider charge attempt. It keeps other responses conservative because a duplicate-reference response cannot prove whether a prior attempt succeeded. Unknown attempts retain stock and block another attempt. The API never retries the provider POST automatically.

The background reconciler claims due attempts under a short PostgreSQL lease, closes that transaction, and then performs provider status lookups by known provider transaction ID. A crashed `DISPATCHING` attempt is eligible to become unknown after 20 seconds and is marked on the next 30-second reconciliation pass. If an unresolved attempt reaches the configured manual-review threshold (default 1,800 seconds), the API sets `manualReviewRequired`; neither the flag nor a failed lookup releases stock or permits a new charge. Set the threshold to `0` to disable automatic escalation. The default remains provisional pending user validation.

The minimal event-receipt cleanup defaults to 365 days and can be changed through `PAYMENT_EVENT_RECEIPT_RETENTION_DAYS`; this is a provisional demo default pending user validation. The full signed event body is not stored. `PAYMENT_GATEWAY_EVENTS_SECRET` and `PAYMENT_GATEWAY_INTEGRITY_SECRET` are distinct from the private API key and must remain server-side.

I3 does not expose a user-facing cancellation/void command or refund route. A confirmed provider `VOIDED` status closes the checkout and releases a held reservation. Refund is a separate operation outside this iteration.

## I4 browser payment boundary

The browser submits a payment token only after receiving the sandbox acceptance documents, collecting both explicit consent checkboxes, and tokenizing a permitted sandbox test-card number directly with the configured sandbox. The UI accepts only the two published sandbox card numbers documented by the provider (approved and declined scenarios); it does not prefill either number. The PAN, expiry, CVC, and cardholder name are not sent to the application API, Redux, local storage, or session storage. The payment token is submitted directly to the API from an in-memory request and is not retained in Redux or browser storage.

The payment UI requires `VITE_PAYMENT_GATEWAY_ENVIRONMENT=test`, an HTTPS host whose name identifies a sandbox/test environment, and a public key with the test prefix. The API independently requires `PAYMENT_GATEWAY_ENVIRONMENT=test` and an HTTPS sandbox/test host before sending a provider request. Missing sandbox settings keep the payment form disabled. No live private key belongs in browser configuration. Installments are included in the request fingerprint and passed through to the payment method; the browser asks the user to choose the installment count.

After refresh, the browser restores only the checkout ID from the URL and recovers the guest-owned checkout from the API. A payment recovery marker stores only checkout ID scope and timestamp; while the outcome is unresolved, the UI blocks a second submission and polls the API while visible. An API lookup error also keeps payment submission blocked until the existing attempt can be checked. The checkout command key is stored in session storage so an interrupted checkout can be recovered without persisting its customer/address payload.

I4 does not enable live processing and has not been deployed. The default public configuration has no sandbox URL or public key, so the card flow stays disabled until sandbox values are supplied through local/deployment configuration.

Explicit cancellation/void, operational reconciliation, and fulfillment endpoints are not frozen. A timeout after a request may have been sent is an unknown outcome: retain the hold and reconcile; do not blind-resend, mark it declined, or release stock. Confirmed approval alone may commit inventory and create fulfillment once.

## I2 HTTP status conventions

- `200 OK`: read or same-command checkout replay.
- `201 Created`: first successful checkout creation.
- `400 Bad Request`: malformed body, invalid key syntax, or unsupported fields.
- `401 Unauthorized`: missing, invalid, or expired guest session.
- `404 Not Found`: product is absent/inactive, or checkout is not owned by this guest session.
- `409 Conflict`: insufficient stock or the same idempotency key with a different canonical request.
- `410 Gone`: the checkout's 30-day idempotency replay window elapsed and its request fingerprint was redacted.
- `422 Unprocessable Entity`: a server-calculated amount exceeds the safe integer range.
- `503 Service Unavailable`: the health readiness check cannot reach PostgreSQL.

Payment-provider statuses remain domain states and are not HTTP transport failures. The I3 controlled provider contract tests validate amount conversion, state transitions, idempotency, signed events, replay handling, and reconciliation. No real sandbox credentials are stored in this public project; a live sandbox pass remains an external evidence item before enabling provider credentials.
