# Open decisions and assumptions

Do not implement an unresolved business choice as if it were a confirmed requirement. Record each answer, evidence, approver, and iteration here.

| Topic | Current proposal | Status / evidence needed |
|---|---|---|
| Initial reservation TTL | 10 minutes when no payment attempt has been dispatched; `PENDING`/unknown attempts retain the hold | Provisional; user must approve; define escalation for old unresolved attempts |
| Retry policy | At most one explicit retry within 10 minutes after confirmed `DECLINED` or `ERROR`; a retry is a new attempt, reference, and card token. A transport failure proven before any provider request bytes were sent may be retried separately. Confirmed cancellation/`VOIDED` closes checkout | Provisional; user must approve allowed states/count/window and safe local-failure treatment before implementing retry UI |
| Unknown payment outcome | Hold inventory, block another attempt, reconcile by signed event or server query when provider ID is known; never blind-resend | Domain invariant; current docs only establish status lookup by transaction ID; no query-by-reference guarantee. No-ID ambiguity may require operational review |
| Late approval after reservation release | Fulfillment exception; never take another checkout's stock; decide fulfillment or compensation/refund separately | Provisional operational path; user must approve how the demo handles it |
| Cancellation / void | Explicit cancel command only; keep stock held in `CANCEL_PENDING` until a terminal result; a confirmed void closes checkout | Provisional; user must approve whether cancellation is in scope and verify sandbox behavior in I3 |
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
| Public repository and progress history | GitHub target must be public; use feature branches, meaningful commits, and PRs while work progresses; no private GitHub staging repo | User authorized public GitHub earlier; this repo has no remote yet. Complete neutral content scan and initial publication as the I0 gate; publish increments after that gate |
| GitHub branch/CI enforcement | Protect `main` with PR-only changes and no force-push/deletion; require relevant CI checks once configured; keep user approval as a separate iteration gate | Configure PR-only/no-force/no-delete in I0 after initial remote; configure required checks after CI exists in I1 |
| Public draft visibility | Treat branches, commits, PRs, and CI artifacts as public; draft status does not make them private | Consequence of public-repository requirement; scan content and outputs before pushing |

## Decision record format

For every resolved row, append: decision, date, evidence/source, whether it is a challenge requirement or a product assumption, and who approved it. Never label a provider behavior as guaranteed unless its exact current contract was verified.

## I0 decisions awaiting user validation

1. Accept the baseline flow, scorecard, and React/NestJS/PostgreSQL/AWS Fargate/Terraform direction.
2. Accept or revise the 10-minute no-attempt reservation and one explicit retry within 10 minutes of a confirmed `DECLINED`/`ERROR` result; cancellation/`VOIDED` closes the checkout.
3. Accept that `PENDING` and `UNKNOWN_OUTCOME` keep inventory held and block another attempt; unresolved cases are reconciled/escalated, never auto-resubmitted.
4. Accept that only confirmed approval commits stock and creates fulfillment; a late approval after stock release becomes a fulfillment exception, with compensation/refund handled separately.
5. Decide whether user-initiated cancellation/void is required in the challenge's first complete flow.
6. Confirm fee amounts, delivery fields, and the intended manual-vs-admin handling of unresolved/late-approval cases.
