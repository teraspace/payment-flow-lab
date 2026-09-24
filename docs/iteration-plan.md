# Proposed iteration sequence

Estimate: one discovery/decision iteration (I0), six implementation iterations (I1–I6), and one final acceptance/release iteration (I7). This is a planning hypothesis; the real count is whatever the evidence ledger records. Each iteration is a coherent cycle with a frozen scope, acceptance criteria, checks, evidence, and a user validation gate before the next iteration starts.

| Iteration | Scope | Gate |
|---|---|---|
| I0 — Requirements and lifecycle | Trace PDF requirements to acceptance criteria; close or explicitly accept API, inventory, payment-state, retry, and fulfillment assumptions; define contract and threat boundaries; inspect the public-safe baseline | User approves the scope, lifecycle matrix, provisional policies, and public remote/first push before I1 |
| I1 — Foundation | Initialize app workspaces, local PostgreSQL workflow, migrations, typed config, CI, and API/UI shell | Clean install, lint/build, database migration, and contract skeleton evidence |
| I2 — Checkout and inventory | Catalog/checkout flow, server-side price calculation, atomic reservation, scoped idempotency, API persistence | PostgreSQL concurrency and duplicate-command gates pass |
| I3 — Payment lifecycle | Provider adapter, durable dispatch/outbox, attempts, webhooks, status lookup, reconciliation, timeout and retry policy | Sandbox or controlled contract evidence; no blind duplicate request under ambiguous outcome |
| I4 — React experience | Responsive checkout, accessible state/error handling, API integration, refresh recovery, approval/decline/pending/unknown states | Browser flow evidence on target mobile and desktop sizes |
| I5 — Reliability and scorecard | Boundary and concurrency tests, coverage threshold, security/error review, accessibility, performance and cross-browser fixes | Measured scorecard with defects resolved or clearly disclosed |
| I6 — Terraform and AWS | Cost-aware Terraform for a single Fargate service and PostgreSQL; configure secrets safely; deploy and smoke-test | Review plan/cost before apply; live endpoint and browser-to-API smoke evidence |
| I7 — Final acceptance and release | Re-run rubric, verify README/setup/evidence, inspect the public history/artifacts, and confirm deployed links | User validates final evidence and handoff; the repository is already public from I0 and has incremental feature history |

Within an iteration, independent analyses can run in parallel when file ownership and contracts are clear. The review artifact is feature-based: normally one integrated PR for a vertical slice, or separate PRs only for independently reviewable features. A PR, commit, agent task, or prompt is not itself an iteration. Publish meaningful branch progress after the public-remote gate, then present the completed PR evidence to the user. Integration, user validation, merge, and the next iteration remain sequential. See `git-workflow.md` for the branch, commit, and PR conventions.
