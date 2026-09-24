# Payment Flow Lab

A full-stack checkout system built as an engineering challenge and as a measured experiment in AI-assisted software delivery.

The goal is to deliver a responsive React application, a NestJS API, PostgreSQL-backed inventory and checkout workflows, automated tests, and a reproducible AWS deployment. The application will integrate with a payment provider through a backend adapter.

## Selected stack

- Frontend: React, TypeScript, Redux Toolkit.
- Backend: NestJS, TypeScript, Jest.
- Database: PostgreSQL.
- Runtime: AWS ECS on Fargate.
- Infrastructure as code: Terraform.

The API is planned as one modular service. This keeps the challenge small enough to operate while preserving clear domain boundaries. Kubernetes and a microservice split are out of scope unless evidence changes that decision.

## Project status

Iteration 0 and I1 are complete. The I1 foundation is deployed at the demo URL; it exposes the React shell, API health/docs, and the initial schema. I2 is implemented on `feat/checkout-reservation` and awaits its PR and AWS release gates: the API slice adds the seeded catalog, anonymous guest-session scope, checkout snapshots, atomic stock holds, expiry, PostgreSQL-backed idempotency, and 30-day PII redaction. It does not yet process payments or provide the customer-facing checkout UI. Review the [requirements and scorecard](docs/requirements-traceability.md), [API contract](docs/api-contract.md), [payment and inventory lifecycle](docs/payment-lifecycle.md), and [open decisions](docs/open-decisions.md).

## Engineering rules

- Keep database consistency and domain idempotency as separate guarantees.
- Reserve stock atomically; never allow available stock to become negative.
- Keep payment-provider network calls outside database transactions.
- Treat a timeout after a request may have been sent as an unknown outcome. Reconcile it before allowing another charge attempt.
- Never put secrets or challenge credentials in source control.
- Keep payment, reservation, and fulfillment lifecycles independently observable.

See [the engineering baseline](docs/engineering-baseline.md), [the iteration plan](docs/iteration-plan.md), [the feature branch/PR workflow](docs/git-workflow.md), and [the agent workflow](AGENTS.md).

## Local setup

Requirements: Node.js 24.15 or newer and Docker Compose.

```sh
cp .env.example .env
npm ci
npm run db:up
npm run db:migrate
npm run dev
```

The web app runs at `http://localhost:5173`; the API runs at `http://localhost:3000`. API health is available at `/api/v1/health/live` and `/api/v1/health/ready`; the generated OpenAPI UI is at `/api/v1/docs`. Stop the database with `npm run db:down`. The local PostgreSQL port is bound to loopback only. Do not copy real credentials into `.env.example`; use a local `.env` file, which is ignored by Git.

The initial migration creates a product catalog table and database checks for non-negative prices/quantities and reserved inventory not exceeding physical inventory. The I2 migrations seed three neutral demo products; add guest sessions, customer/delivery snapshots, checkout and item price snapshots, reservations, and scoped idempotency records; and permit redacting personal fields and PII-derived request fingerprints after 30 days. The API exposes catalog reads and guest-owned checkout creation/recovery; there is no public product-write endpoint.

## Data model and API

PostgreSQL is the authority for product price and inventory. `products.reserved_quantity` is changed only by a conditional update inside the same transaction that creates a `checkouts` row, its `checkout_items` price snapshot, a `reservations` row, and an `idempotency_records` row. `customers` and `deliveries` store only the name/email and recipient/address fields needed by the demo; an API background job clears them, and the PII-derived idempotency fingerprint, 30 days after checkout creation. A guest session is represented by an opaque HttpOnly cookie; PostgreSQL stores only its token hash. Full endpoint shapes and the separation between live I2 routes and planned payment routes are documented in [`docs/api-contract.md`](docs/api-contract.md).

Run the API integration suite with `npm run test:api`. It recreates and drops only a local database whose name ends in `_test` (default `payment_flow_lab_test`), applies and rolls back migrations, and uses independent PostgreSQL connections for concurrency checks. It does not reset the developer database named in `.env`.

For the AWS deployment and update sequence, see [`infra/terraform/README.md`](infra/terraform/README.md). The API image is built for ARM64 Fargate and the web app uses a same-origin `/api/v1` route through CloudFront. I2's user-approved customer-data retention policy is 30 days from checkout creation. Demo defaults are COP 5,000 base and COP 8,000 delivery.

## Feature progress and AI-assisted workflow

The challenge asks for branches and pull requests by feature and warns against a repository with no visible progress or commits. Work therefore lands as meaningful commits on neutral feature branches, with a reviewable PR for each independent feature. Commits are not counted as iterations, and agents do not get separate PRs just because their roles differ. The target GitHub repository must be public; hosted progress should be visible incrementally after the public-repository gate. Each iteration ends with recorded evidence and a human validation gate. The ledger records actual agents, changes, test results, interventions, and defects; it does not claim checks that did not happen.

## Delivery scorecard

The challenge baseline is tracked as 100 points: README (5), responsive UI without overflow (5), complete user flow (20), API (20), test coverage (30), and a working deployed application (20). Report measured evidence for each item; do not infer points from code presence alone.
