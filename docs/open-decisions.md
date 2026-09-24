# Open decisions and assumptions

Do not implement an unresolved business choice as if it were a confirmed requirement. Record each answer, evidence, approver, and iteration here.

| Topic | Current proposal | Status / evidence needed |
|---|---|---|
| Initial reservation TTL | 10 minutes, configurable | Provisional; validate product flow and acceptance requirements |
| Retry policy | One explicit retry within 10 minutes after terminal non-approved result | Provisional; confirm allowed terminal states and expiry behavior |
| Unknown payment outcome | Hold inventory, block another attempt, reconcile; never blind-resend | Engineering invariant; verify sandbox query/event capabilities |
| Late approval after reservation release | Fulfillment exception; no stock theft; separate compensation/refund decision | Provisional operational path; document manual handling |
| Cancellation / void | Explicit user/business action only; keep stock held until provider confirms terminal result | Provisional; verify allowed provider states and endpoint behavior |
| Fees, delivery, tax, and monetary rules | Calculate on the API in integer minor units | Exact values and input fields are unspecified; use reviewed configuration/fixtures |
| Checkout/customer/delivery fields | Minimize stored personal data | Confirm required challenge fields before API contract freeze |
| Provider idempotency contract | Assume no remote exactly-once guarantee; use unique correlation per attempt and reconcile ambiguity | Verify exact sandbox endpoint and current provider documentation before integration |
| Webhook signature and event fields | Validate documented checksum/signature and transaction data; persist receipt before acknowledgement | Verify exact signature inputs, ordering, retries, and sandbox support |
| AWS region/networking and cost | ECS Fargate + PostgreSQL; compare network options and show a cost-aware Terraform plan | Decide in infrastructure iteration before any apply |
| Public repository and progress history | GitHub target must be public; use feature branches, meaningful commits, and PRs while work progresses; no private GitHub staging repo | PDF requirement; this local repo has no remote yet. Review the complete tree/history, then create the public remote and make the initial push before I1; publish increments after that gate |
| GitHub branch/CI enforcement | Protect `main` with PR-only changes and no force-push/deletion; require relevant CI checks once configured; keep user approval as a separate iteration gate | Workflow recommendation; set rules in I0/I1, after the public remote exists |
| Public draft visibility | Treat branches, commits, PRs, and CI artifacts as public; draft status does not make them private | Consequence of public-repository requirement; scan content and outputs before pushing |

## Decision record format

For every resolved row, append: decision, date, evidence/source, whether it is a challenge requirement or a product assumption, and who approved it. Never label a provider behavior as guaranteed unless its exact current contract was verified.
