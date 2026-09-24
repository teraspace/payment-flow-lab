# Open decisions and assumptions

Do not implement an unresolved business choice as if it were a confirmed requirement. Record each answer, evidence, approver, and iteration here.

| Topic | Current proposal | Status / evidence needed |
|---|---|---|
| Initial reservation TTL | 10 minutes when no payment attempt has been dispatched; `PENDING`/unknown attempts retain the hold | Approved as the initial baseline on 2026-09-24; define escalation for old unresolved attempts |
| Retry policy | At most one explicit retry within 10 minutes after confirmed `DECLINED` or `ERROR`; a retry is a new attempt, reference, and card token. A transport failure proven before any provider request bytes were sent may be retried separately. Confirmed cancellation/`VOIDED` closes checkout | Approved as the initial baseline on 2026-09-24; re-evaluate against sandbox evidence before I3 |
| Unknown payment outcome | Hold inventory, block another attempt, reconcile by signed event or server query when provider ID is known; never blind-resend | Accepted engineering invariant; current docs only establish status lookup by transaction ID; no query-by-reference guarantee. No-ID ambiguity may require operational review |
| Late approval after reservation release | Fulfillment exception; never take another checkout's stock; decide fulfillment or compensation/refund separately | Accepted provisional operational path; exact business remedy remains an implementation-time decision |
| Cancellation / void | Explicit cancel command only; keep stock held in `CANCEL_PENDING` until a terminal result; a confirmed void closes checkout | Lifecycle accepted on 2026-09-24; whether a user-facing cancellation control is in the first flow remains open; verify sandbox behavior in I3 |
| Fees, delivery, tax, and monetary rules | Calculate on the API in integer minor units | Exact values and input fields are unspecified; use reviewed configuration/fixtures |
| Checkout/customer/delivery fields | Minimize stored personal data; current illustrative contract includes recipient, email, address | Confirm exact fields/validation and retention before API contract freeze |
| Guest/customer identity for idempotency scope | Server-controlled guest checkout/session scope; no account system in baseline | Decide session/cookie design and key retention before I2 |
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

Still open for later contract refinement: exact fee values and delivery fields, guest-session identity/retention, user-facing cancellation control, unresolved-attempt escalation threshold, and webhook receipt retention. None blocks I1's foundation shell; resolve each before the iteration that depends on it.
