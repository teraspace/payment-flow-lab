# Open decisions and assumptions

Do not implement an unresolved business choice as if it were a confirmed requirement. Record each answer, evidence, approver, and iteration here.

| Topic | Current proposal | Status / evidence needed |
|---|---|---|
| Initial reservation TTL | 10 minutes when no payment attempt has been dispatched; `PENDING`/unknown attempts retain the hold | The 10-minute policy was approved on 2026-09-24. I2 materializes expiry before catalog/checkout reads and checkout creation, releasing the hold and stock counter in one PostgreSQL transaction. No payment attempts exist in I2. Define escalation for old unresolved attempts before I3. |
| Retry policy | At most one explicit retry within 10 minutes after confirmed `DECLINED` or `ERROR`; a retry is a new attempt, reference, and card token. A transport failure proven before any provider request bytes were sent may be retried separately. Confirmed cancellation/`VOIDED` closes checkout | Approved as the initial baseline on 2026-09-24; re-evaluate against sandbox evidence before I3 |
| Unknown payment outcome | Hold inventory, block another attempt, reconcile by signed event or server query when provider ID is known; never blind-resend | Accepted engineering invariant; current docs only establish status lookup by transaction ID; no query-by-reference guarantee. No-ID ambiguity may require operational review |
| Late approval after reservation release | Fulfillment exception; never take another checkout's stock; decide fulfillment or compensation/refund separately | Accepted provisional operational path; exact business remedy remains an implementation-time decision |
| Cancellation / void | Explicit cancel command only; keep stock held in `CANCEL_PENDING` until a terminal result; a confirmed void closes checkout | Lifecycle accepted on 2026-09-24; whether a user-facing cancellation control is in the first flow remains open; verify sandbox behavior in I3 |
| Fees, delivery, tax, and monetary rules | Calculate on the API in integer COP units | API supports configurable base and delivery fees; runtime defaults are zero pending a user-selected demo amount. Integration-test fee values are isolated fixtures, not product decisions. Tax is not calculated. |
| Checkout/customer/delivery fields | Store customer full name/email and delivery recipient/address only; no phone or card data in I2 | I2 validation bounds the fields and returns them only to the owning session. Data-retention/deletion timing remains open and must be resolved before handling real customer data or deploying this checkout slice. |
| Guest/customer identity for idempotency scope | Server-issued anonymous session; no account system in baseline | I2 proposal: 256-bit random opaque token in a 30-day `HttpOnly; SameSite=Lax` cookie (`Secure` in production); only the token hash is stored. Idempotency keys are SHA-256 hashed and scoped to session + operation. This is an implementation proposal for the I2 validation gate, not a previously approved product requirement. |
| Production guest-cookie site policy | SameSite policy must match the deployed frontend/API origins | I2 defaults to `SameSite=Lax` for local development. The planned CloudFront frontend and Fargate API use different sites if the browser calls the API hostname directly; before deploying checkout, either route API requests through the frontend site or configure `SameSite=None; Secure` and verify credentialed CORS/CSRF protections in a browser. Not tested in I2. |
| Checkout shape and seed fixtures | One product per checkout for the first slice; seed products installed by migration | Matches the brief's single-product story. I2 seeds three neutral demo products and includes local SVG paths. Multi-item carts remain out of scope unless later evidence requires them. |
| Provider idempotency contract | Assume no remote exactly-once guarantee; use unique correlation per attempt and reconcile ambiguity | Current docs describe unique reference and lookup by transaction ID, not replay-safe idempotency or lookup by reference; recheck in I3 |
| Card token handling | Browser-side tokenization; send short-lived provider token to API in memory; never persist PAN/CVC or token in a general outbox | Planning fact checked against official docs; verify sandbox limits and redact logs in I3 |
| Webhook signature and event fields | Validate dynamic documented signature inputs/order and transaction identity; persist minimal receipt before acknowledgement | Planning fact checked against official docs; recheck signature and delivery behavior in I3 |
| Consent/acceptance tokens | Show current applicable consent texts and capture explicit acceptance before payment | Planning fact checked against official docs; decide UI presentation and storage of acceptance evidence in I3/I4 |
| Dispatch model | Persist local attempt, commit SQL transaction, then call provider synchronously outside SQL transaction | Proposed to avoid durable storage of card token; if changing to async dispatch, design encrypted short-retention token handling first |
| Unresolved-attempt escalation | Keep hold and block charges while unresolved; old cases need explicit review | Decide demo escalation threshold and whether review is documented/manual or an admin feature; no admin UI is in baseline |
| Webhook receipt retention | Store minimal verified event data/fingerprint, avoid unnecessary full payload/PII | Decide retention period and redaction policy before I3 |
| AWS region/networking and cost | ECS Fargate + PostgreSQL; compare network options and show a cost-aware Terraform plan | Decide in infrastructure iteration before any apply |
| Public repository and progress history | Public repository; feature branches, meaningful commits, and PRs; no private staging repo | Created as `teraspace/payment-flow-lab`; initial `main` and I0 feature branch pushed after user review; no candidate distribution |
| GitHub branch/CI enforcement | Protect `main` with PR-only changes and no force-push/deletion; require relevant CI checks once configured; keep user approval as a separate iteration gate | `main` protection active; `quality` and `database-migrations` are required status checks from I1; user validation remains a separate merge gate |
| Public draft visibility | Treat branches, commits, PRs, and CI artifacts as public; draft status does not make them private | Consequence of public-repository requirement; scan content and outputs before pushing |

## Decision record format

For every resolved row, append: decision, date, evidence/source, whether it is a challenge requirement or a product assumption, and who approved it. Never label a provider behavior as guaranteed unless its exact current contract was verified.

## I0 approval record

The user approved the I0 scope and proposed lifecycle on 2026-09-24. This approval accepts the initial implementation baseline: React/TypeScript/Redux Toolkit, NestJS/TypeScript, PostgreSQL, ECS Fargate, and Terraform; a 10-minute hold before dispatch; at most one explicit retry after confirmed decline/error; no automatic retry or release for an unknown outcome; confirmed approval alone commits inventory and creates fulfillment; and late approval/cancellation follow the exception paths above. These provisional values may be revisited only if implementation or sandbox evidence justifies a change, which must be recorded.

Still open for later contract refinement: exact fee values, customer/delivery PII retention, the I2 guest-session implementation proposal, user-facing cancellation control, unresolved-attempt escalation threshold, and webhook receipt retention. Resolve each before the iteration that depends on it and record any approval or revision.

## I2 implementation choices for user validation

- The checkout command has one product, quantity, customer name/email, and recipient/address. It snapshots catalog name/SKU/price and server-configured fees.
- New checkout returns `201`; matching key and canonical payload returns `200` with the existing checkout's current state; a different payload under the same scoped key returns `409`.
- Stock update, reservation row, checkout snapshots, and idempotency record commit or roll back together. The integration suite uses real PostgreSQL connections.
- The guest-session cookie design and 30-day lifetime are implementation defaults proposed for review, not user-approved changes to I0. No payment-provider call or payment-attempt route is added in I2.
- Session initialization is `POST` because it can create a database row. Expired sessions without checkouts are deleted during initialization; sessions that own checkouts remain subject to the still-open PII-retention policy.
- Fee amounts are still awaiting the user's response. Runtime defaults are zero until set; test fixtures prove server-side arithmetic without claiming commercial fee values.
- Customer/address fields and idempotency rows currently have no deletion job. Retention is a known open choice and must be resolved before real PII or an I2 deployment.
