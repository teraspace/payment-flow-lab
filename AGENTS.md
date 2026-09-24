# Instructions for coding agents

## Mission and source of truth

Build the checkout challenge in this repository using the selected stack in `README.md`. Treat `docs/engineering-baseline.md` as the current technical baseline and `docs/open-decisions.md` as the record of unresolved or provisional business choices. Do not silently turn a proposal into an approved requirement.

## Naming, privacy, and credentials

- Keep the repository, branches, commits, code, comments, documentation, configuration, and cloud resource names neutral. Never use the payment company's name.
- Do not copy credentials, tokens, shared test secrets, or private customer data from challenge materials into source control, prompts, logs, screenshots, or artifacts.
- Use environment variables for local secrets. Commit only empty-value examples in `.env.example`.
- Do not send project materials to other candidates or publish them outside the agreed repository.

## Iteration and validation protocol

1. Work on one explicitly scoped iteration at a time. Before implementation, state the goal, acceptance criteria, file ownership, and validation commands.
2. Agents may analyze independent areas concurrently. Assign disjoint file ownership for edits. If work depends on an unsettled API, schema, or lifecycle decision, resolve that dependency first.
3. Keep one integration owner responsible for cross-cutting contracts, merges, and evidence. Specialist reviews must report concrete findings and locations.
4. At the end of an iteration, report the diff, commands actually run, evidence, unresolved issues, and ledger entry. Stop and wait for the user's validation before beginning the next iteration.
5. A failed gate is a defect to fix within the iteration or a clearly documented blocker; it is never silently waived.

## Engineering invariants

- PostgreSQL constraints, transactions, conditional updates, and locks protect local invariants under concurrency.
- Domain idempotency gives repeated commands stable outcomes. A database constraint supports this behavior but does not define the whole business contract.
- Do not keep a SQL transaction open across a payment-provider network call.
- A local outbox improves durable dispatch; it does not make a remote request exactly-once.
- Do not resend an attempt whose external outcome is unknown. Reconcile it first.
- Only a confirmed approval may commit inventory and create fulfillment, each once.
- Never trust a client-supplied total; calculate monetary values on the API in integer minor units.

## Feature branches, commits, and pull requests

- Organize hosted work by feature, not by agent role. Use neutral names such as `feat/checkout-reservation`, `feat/payment-reconciliation`, or `fix/checkout-refresh`.
- A feature may cross the API, web app, and database when that is one coherent user-visible slice. Split changes only when each resulting PR is independently reviewable and can pass its own gates.
- Keep `main` as the integrated baseline. Do not commit directly to it during feature work.
- Open a draft PR once the feature scope, acceptance criteria, and first meaningful progress exist. Update the same PR as the feature becomes reviewable; do not open a PR for every agent or prompt.
- Make commits for real, coherent progress on the feature branch. Each feature PR should contain at least one meaningful commit; add commits at natural implementation, test, or documentation milestones. The PDF warns about a repository with no progress or commits, but it does not prescribe an arbitrary count or cadence. Never pad history with empty, cosmetic, or fabricated commits.
- Use clear, neutral commit subjects, for example `feat: reserve stock atomically`, `test: cover checkout replay`, or `docs: record payment recovery policy`. Preserve the real AI and human work in the ledger; a commit is not a substitute for that record.
- Push feature progress to the required public GitHub repository as it becomes coherent, rather than keeping all progress local until one final upload. The challenge repository must not be mirrored to a private GitHub repository. Before the first public push, inspect the complete tree and commit history for prohibited naming, credentials, and private data. Do not share the repository link directly with candidates.
- Keep the PR draft until its acceptance criteria and required checks have evidence. QA/security reviewers report findings against the integrated feature; the integration owner fixes and records them.
- The user validates the completed iteration through its PR evidence before merge and before the next iteration begins. Prefer a merge strategy that preserves meaningful feature commits; do not rewrite published history or force-push shared branches.
- After the initial public push, protect `main` with PR-only merges and no force-push/deletion. Once CI is available, require relevant lint, typecheck, build, test, and coverage checks. A green CI run never replaces the user's iteration gate.
- Treat every public branch and draft PR as externally visible. Do not assume draft status hides code, and do not expose credentials in source, artifacts, screenshots, or CI logs.

## External release actions

- The public GitHub repository is a challenge deliverable. Review the exact tree and baseline history with the user, then create the public remote and make the initial push before I1 starts. Do not use a private GitHub staging repo. After that initial gate, publish feature progress incrementally as described above; do not defer all hosted progress until final delivery.
- AWS deployment and `terraform apply` are separate release gates. Before either, show the Terraform plan, region, resources, exposure, and cost-bearing components.
- Never claim a deployment, test, coverage number, or review without observable evidence.
