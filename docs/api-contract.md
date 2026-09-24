# API contract: I0 baseline and I2 implementation

Amounts use integer COP units. I2 implements the product catalog and anonymous checkout reservation slice; the provider, card, webhook, payment-attempt, and fulfillment routes remain planned for I3. This document distinguishes live routes from the approved later design.

## I2 implemented records

| Record | Purpose | Consistency rule |
|---|---|---|
| `products` | Seeded catalog, price, physical and reserved quantity. | `0 <= reserved_quantity <= physical_quantity`; public routes cannot change price or stock. |
| `guest_sessions` | Server-issued anonymous session whose opaque token is kept in an HttpOnly cookie. | Only a SHA-256 token hash is stored; session scope owns checkout writes, replays, and reads. |
| `customers` / `deliveries` | Minimal buyer and delivery snapshots for one checkout. | No payment-card data is accepted or persisted; exact retention remains open. |
| `checkouts` / `checkout_items` | Checkout state, customer/delivery links, integer totals, and immutable item price/name/SKU snapshot. | The API computes totals; later catalog price changes do not alter an existing checkout. I2 supports one product per checkout. |
| `reservations` | Held product quantity and expiry. | `HELD` transitions once to `RELEASED`; both reservation state and product counter change in the same PostgreSQL transaction. |
| `idempotency_records` | Session scope, operation, key hash, canonical payload fingerprint, and checkout reference. | Unique `(guest_session_id, operation, idempotency_key_hash)`; same payload replays the checkout, different payload returns `409`. |

PostgreSQL transactions and a conditional `UPDATE products ... WHERE physical_quantity - reserved_quantity >= quantity` protect inventory. The database check also rejects a negative available count. Domain idempotency is a separate API promise: a uniqueness constraint alone is not the replay contract.

## I2 live routes

| Method and route | Behavior |
|---|---|
| `POST /api/v1/guest-session` | Creates an anonymous session if needed, sets an opaque `HttpOnly; SameSite=Lax` cookie, and returns its expiry (`201` when created, `200` when reused). The cookie is `Secure` in production. The raw token is never returned in JSON or stored in PostgreSQL. Expired sessions without a checkout are cleaned up during initialization. |
| `GET /api/v1/products` | Lists active seeded products with description, image path, price, currency, and derived available quantity. Before returning, it releases expired I2 reservations in a transaction. |
| `GET /api/v1/products/{productId}` | Reads one active product; returns `404` if missing or inactive. Also materializes any expired reservations first. |
| `POST /api/v1/checkouts` | Requires a valid guest cookie and `Idempotency-Key`. Validates one product and quantity, computes server totals, stores the customer/delivery snapshots, and creates the stock hold atomically. First result is `201`; same-key replay is `200`. |
| `GET /api/v1/checkouts/{checkoutId}` | Reads only a checkout belonging to the current guest session. Returns `404` for an unknown checkout or one owned by another session. Expiration is applied before the response. |

The initial reservation lasts 600 seconds (10 minutes) by default. I2 has no payment attempts, so an expired reservation is released. Expiration is materialized transactionally before catalog reads, checkout creation, and checkout reads; there is no background scheduler in I2. A replay after expiration returns the same checkout in its current `EXPIRED` state. To create a fresh hold, the client sends a new idempotency key.

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

The response includes `checkoutId`, `state` (`RESERVED` or `EXPIRED`), customer and delivery snapshots, one item with snapshotted price/name/SKU, `subtotalMinor`, `baseFeeMinor`, `deliveryFeeMinor`, `totalAmountInMinorUnits`, `currency`, and reservation state/expiry. Amounts are non-negative safe integers in COP units.

The fee variables are `CHECKOUT_BASE_FEE_MINOR` and `CHECKOUT_DELIVERY_FEE_MINOR`; the user approved demo defaults of COP 5,000 base charge and COP 8,000 delivery. These are configurable whole-COP amounts, not taxes or withholding. The integration suite sets the same values explicitly to prove that the API ignores a client-supplied total. `CHECKOUT_RESERVATION_TTL_SECONDS` defaults to `600`, and `GUEST_SESSION_TTL_DAYS` defaults to `30`.

## Idempotency and transaction boundary

1. The API hashes the idempotency key and hashes a normalized canonical payload containing product, quantity, customer, and delivery fields.
2. In one PostgreSQL transaction, it claims the unique session/operation/key hash before touching inventory. The winning request reserves stock with a conditional update, inserts customer/delivery/checkout/item/reservation snapshots, then commits.
3. A uniqueness race waits for the winning transaction. Matching fingerprint returns the existing checkout without another stock update. A different fingerprint returns `409` without mutation.
4. If the stock is insufficient or any later write fails, rollback removes the key claim, stock increment, checkout, customer, delivery, and reservation. A rejected request that created no checkout may be retried with corrected input.
5. GET checkout and idempotency replay require the original guest cookie. Checkout identifiers alone do not grant access.

Database consistency protects each local transition; idempotency makes repeated commands resolve to one stable domain resource. Neither property provides exactly-once execution across a future payment-provider boundary.

## Planned routes for I3

| Method and route | Planned behavior |
|---|---|
| `POST /api/v1/checkouts/{checkoutId}/payment-attempts` | Requires a separate idempotency key, a one-time provider card token, current consent evidence, and an eligible live hold. Persist attempt before the provider call, then call outside the SQL transaction. |
| `GET /api/v1/checkouts/{checkoutId}/payment-attempts/{attemptId}` | Returns safe local status only; replay never starts a second provider POST. |
| `POST /api/v1/webhooks/payment-events` | Verify signature and transaction identity, persist a minimal receipt, apply an idempotent transition, then acknowledge. |

Explicit cancellation/void, operational reconciliation, and fulfillment endpoints are not frozen. A timeout after a request may have been sent is an unknown outcome: retain the hold and reconcile; do not blind-resend, mark it declined, or release stock. Confirmed approval alone may commit inventory and create fulfillment once.

## I2 HTTP status conventions

- `200 OK`: read or same-command checkout replay.
- `201 Created`: first successful checkout creation.
- `400 Bad Request`: malformed body, invalid key syntax, or unsupported fields.
- `401 Unauthorized`: missing, invalid, or expired guest session.
- `404 Not Found`: product is absent/inactive, or checkout is not owned by this guest session.
- `409 Conflict`: insufficient stock or the same idempotency key with a different canonical request.
- `422 Unprocessable Entity`: a server-calculated amount exceeds the safe integer range.
- `503 Service Unavailable`: the health readiness check cannot reach PostgreSQL.

I3 payment-provider statuses remain domain states and are not HTTP transport failures. Provider facts and payment recovery behavior remain in [`payment-lifecycle.md`](payment-lifecycle.md) and must be rechecked against sandbox behavior before I3.
