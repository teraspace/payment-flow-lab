# API application

NestJS + TypeScript API foundation. The API process exposes liveness and readiness routes and serves its generated OpenAPI document at `/api/v1/docs`.

## Local commands

Run from the repository root:

```sh
npm run db:up
npm run db:migrate
npm run dev:api
```

`GET /api/v1/health/live` reports process liveness. `GET /api/v1/health/ready` checks PostgreSQL and returns `503` when the database cannot be reached. `DATABASE_URL`, `API_PORT`, and `WEB_ORIGIN` are validated at startup. The local API reads the ignored root `.env` file; deployed environments supply configuration through their runtime environment.

The first migration creates the product table and enforces DBMS invariants for non-negative amounts/quantities and `reserved_quantity <= physical_quantity`. That local database protection is distinct from domain idempotency: stable replay behavior will be implemented with checkout/payment commands in later iterations. No product or payment endpoints are implemented in this foundation increment.
