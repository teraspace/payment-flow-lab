# Engineering baseline

This document records the current technical direction and the payment/inventory invariants that implementation must preserve. Product assumptions are marked provisional in `open-decisions.md` until validated.

## Challenge constraints and selected direction

- Single-page frontend: React + TypeScript + Redux Toolkit.
- Backend: NestJS + TypeScript. Keep business rules in application/domain modules, not controllers.
- Tests: Jest on both applications; target at least 81% lines, functions, and branches per application as an internal threshold for the stated requirement of more than 80% coverage.
- Persistence: PostgreSQL.
- Deployment: one modular API service on ECS Fargate, with Terraform-managed AWS resources.
- Keep a simple deployable architecture. Do not add Kubernetes, microservices, or a second database without a demonstrated need.

## Local database guarantees vs domain idempotency

These are related, but they are not the same guarantee.

**DBMS consistency** is enforced inside PostgreSQL: ACID transactions, `CHECK` and `UNIQUE` constraints, foreign keys, conditional updates, and row locks protect local state from partial writes and concurrent races. For example, a conditional stock update and a transaction ensure that two buyers cannot reserve the last unit.

**Domain idempotency** defines the externally visible result of repeating a command: the same scoped idempotency key and canonical payload return the same checkout or payment attempt; the same key with a different payload is a conflict; replaying an approval does not confirm stock or create fulfillment twice. Constraints help implement this contract, but a constraint alone does not define the stable API response or lifecycle policy.

**External payment effects** cannot be committed atomically with PostgreSQL. Keep provider calls outside SQL transactions. A transaction, unique reference, or outbox does not guarantee exactly-once delivery to a remote provider.

## Inventory and checkout invariants

1. `0 <= reserved_quantity <= physical_quantity`; available stock is physical minus reserved.
2. Checkout, price snapshot, idempotency record, reservation, and durable payment intent are written atomically where applicable.
3. Reserve stock with a conditional database operation or locking strategy that is tested with concurrent PostgreSQL connections.
4. A reservation transitions at most once from `HELD` to `COMMITTED` or `RELEASED`.
5. The API computes product, fee, delivery, and total amounts in integer minor units. Never trust a client-supplied final total or use floating-point arithmetic for money.
6. One checkout may have multiple terminal payment attempts, but at most one active or unresolved attempt.
7. A confirmed approval commits the reservation and creates one fulfillment record in a local transaction.
8. Fulfillment failure does not reverse an approved payment or initiate another charge.

## Payment-attempt lifecycle and recovery

A checkout and a payment attempt are separate resources. A repeated HTTP request, double click, or browser refresh with the same command key must return the existing result. A deliberate retry after a terminal non-approved result creates a new attempt with its own local idempotency key and provider correlation reference.

| Observation | Local action | Reservation/retry policy |
|---|---|---|
| Failure proven to be local and before any provider request could be sent | Keep the command recoverable; do not create a second attempt for the same command | Keep the hold until its configured expiry |
| Provider reports `PENDING` | Record the provider ID/state and await a signed event or backend reconciliation | Keep the hold; block another attempt |
| Timeout/crash after sending may have begun | Mark `UNKNOWN_OUTCOME`; persist evidence and reconcile by event, provider query, or explicit operational review | Keep the hold; do not automatically resend, cancel, or accept a new charge |
| Confirmed `APPROVED` | Apply an idempotent state transition; mark checkout paid and create fulfillment once | Commit the hold once |
| Confirmed terminal non-approved state (`DECLINED`, `ERROR`, or `VOIDED`) | Close that attempt; permit only an explicit, bounded retry if the checkout and hold remain eligible | Release exactly once when the retry window ends or the checkout is explicitly cancelled |
| Approval arrives after stock was released or reassigned | Record a fulfillment exception and preserve the payment evidence; resolve fulfillment or compensation explicitly | Never take stock from another checkout; use a separate refund/compensation flow when required |

An explicit cancellation/void is a business command, not a retry mechanism. Keep the reservation until a terminal provider result is observed. A successful payment that must be returned follows a separate refund flow. Do not represent a timeout as a decline.

Webhook processing must validate the provider signature and transaction identity, persist the valid receipt before acknowledging it, tolerate duplicate/out-of-order notifications, and apply idempotent domain transitions. The browser redirect is not proof of payment. Provide a backend status lookup and a reconciliation path for missing events.

## Provisional demo policy

The working proposal is a configurable 10-minute initial reservation, a 10-minute retry window after a terminal non-approved result, and at most one explicit retry. These are product assumptions, not provider guarantees or challenge requirements. An unresolved attempt does not expire into a blind retry; it must be reconciled or manually resolved. Confirm or revise these values at the decision gate before implementing expiration behavior.

## Test evidence expected

- Concurrent reservation of the final unit using real PostgreSQL and separate connections.
- Repeated and concurrent commands with same key/payload; conflicting payload with same key.
- Duplicate/out-of-order webhook and duplicate approval.
- Terminal decline, explicit retry, reservation expiry, explicit void, and late approval.
- Timeout before send vs unknown outcome after possible send; prove there is no blind duplicate POST.
- Browser refresh/status recovery without resubmitting sensitive payment data.
