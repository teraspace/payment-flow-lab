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

## Git and external actions

- Use neutral feature branches and pull requests for implementation features. Keep commits focused and describe the change without naming the challenge company.
- Do not push publicly, create a public release, deploy, or run `terraform apply` as an automatic consequence of finishing an iteration. These are explicit release gates.
- Before any infrastructure change, show and review the Terraform plan, region, expected resources, and cost-bearing components.
- Never claim a deployment, test, coverage number, or review without observable evidence.
