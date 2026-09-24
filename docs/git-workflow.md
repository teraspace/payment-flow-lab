# Feature branches, commits, and pull requests

## What the challenge PDF says

On page 5, the PDF recommends creating branches and pull requests by feature. On page 6, it warns that a repository with no progress or commits may be treated as fraudulent and voided. It also requires the submitted GitHub repository to be public and forbids the company name in the repository, and direct sharing with other candidates.

The PDF does **not** set a minimum number of commits, commit-message format, push cadence, merge method, one-PR-per-iteration rule, or one-PR-per-agent rule. The conventions below make progress reviewable without inventing those requirements.

## Working interpretation

The warning is best treated as a requirement to show genuine, progressive engineering work in the Git history and feature PRs, not as a request to manufacture commit volume. Local commits alone are not visible proof of progress to an evaluator. Once the public remote is approved and created, push meaningful feature progress during development instead of uploading one final code dump.

## Branch and PR shape

- Keep `main` as the integrated, reviewable baseline.
- Use one neutral branch and PR per independently reviewable feature. A cross-stack vertical slice can be one feature PR even if it changes React, NestJS, and PostgreSQL together.
- Do not create externally visible `backend-agent`, `frontend-agent`, or `qa-agent` PRs just to reflect who did the work. Agents are contributors/reviewers; the PR represents a feature.
- Open a draft PR after the scope and acceptance criteria are clear and the branch has meaningful work. Keep updating that PR as tests, code, and evidence arrive. Mark it ready only when its acceptance checks are addressed.
- By default, an implementation iteration should end in one coherent feature PR. If it truly contains independent features, split those into separately testable PRs and wait for the user gate until the iteration's whole scope is integrated.
- PR acceptance and iteration count are different: several prompts, agent tasks, commits, or even PRs may belong to one iteration. Count an iteration only when the integrated scope reaches its agreed gate.

## Commit granularity

Create commits at natural, reviewable checkpoints: domain behavior, persistence/schema, tests, UI/API integration, or documentation. There is no target commit count. A one-commit feature can be valid; a larger feature will normally have multiple meaningful commits. Do not create commits per prompt, agent response, whitespace change, or arbitrary time interval.

Use concise subjects that describe the change, not the company or candidate. Examples:

- `feat: reserve stock atomically`
- `test: cover duplicate checkout commands`
- `fix: reconcile an unknown payment outcome`
- `docs: record the retry policy`

Do not squash away the complete feature history when the review environment permits preserving the meaningful commits. Never rewrite or force-push a branch after it has been published and shared.

## Agent coordination inside a feature

The integration owner creates and owns the feature branch, API/domain contract, and final PR. Assign each specialist bounded file ownership and acceptance evidence. Parallel specialists can analyze independently; parallel edits must not target the same files. The integration owner reconciles contributions, makes the feature commits, and runs the agreed gates. QA/security agents review the integrated PR read-only and file reproducible findings. Do not use separate role-based public PRs for pieces that only make sense when integrated.

If work is isolated in temporary worktrees, treat those branches as internal implementation scaffolding. The review artifact submitted to the evaluator remains the neutral feature branch and PR.

## PR evidence and user gate

Every PR should make review straightforward:

1. Feature goal, requirement/rubric links, scope, and explicit non-goals.
2. Acceptance criteria and how each was checked.
3. Exact commands actually run and their results; coverage numbers only when measured.
4. API/schema/migration changes and rollback or compatibility notes.
5. Browser screenshots or recordings for UI changes; Terraform plan and resource/cost summary for infrastructure changes.
6. Security/privacy notes, unresolved assumptions, and related updates to the AI workflow ledger.

A draft PR may show in-progress work, but do not ask for final acceptance while required gates are missing. At the end of the iteration, present the integrated PR(s), commit history, checks, and open issues to the user. Wait for the user's validation before merging and before starting the next iteration.

## Public repository gate

The GitHub remote must be public; do not create a private GitHub staging repository. Before its first push, scan all files and commits for prohibited naming, secrets (including supplied sandbox keys), private data, and generated artifacts. Review the exact tree and baseline history with the user, then create the remote and make the initial push before I1 starts. The current checkout is still local, so its commits are not yet visible progress to the evaluator. After the initial-publication gate, push meaningful feature progress incrementally through public branches and PRs; do not defer all hosted history until final delivery.
