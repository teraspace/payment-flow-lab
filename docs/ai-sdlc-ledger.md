# AI-assisted SDLC experiment ledger

One row represents one integrated development cycle, not a prompt, agent message, or isolated subtask. The repository bootstrap below is a setup event before I0 and is excluded from the iteration count. Record tool/model/agent details only when actually observable. Distinguish AI work from human decisions and approvals.

| Iteration | Scope | Feature branch / PR / commits | Agents and tools | Human interventions | Elapsed / active time | Gates and evidence | Defects / rework | Outcome / next gate |
|---|---|---|---|---|---|---|---|
| Bootstrap (pre-I0) | Neutral scaffold and PDF-based feature/commit/PR workflow; no application code | `main` commit `4d790fb`; `docs/feature-pr-history` local at start of I0; no remote/PR yet | Codex app; earlier PDF review; no new specialist agents in I0 | User requested analysis of incremental PRs, commit expectations, and completion of I0 | Not measured | Earlier PDF pages 1–7 reviewed with shared sandbox credential page excluded from notes; no tests or deployment run | I0 expands lifecycle details because failed/ambiguous payment semantics need an explicit gate | I0 documentation now prepared for review; public remote/ruleset and user validation remain gates |
| I0 (prepared; awaiting gate) | Trace requirements/rubric, define initial API contract and DBMS/domain idempotency boundary, specify payment failure/recovery, reservation and fulfillment lifecycle, and propose policies | Local feature branch `docs/iteration-0-baseline`; PR not published | Codex app; official provider docs consulted for tokenization, acceptance, transaction, and event behavior; no specialist agents spawned | User asked to complete I0; earlier project direction authorizes a public GitHub repository. Product-policy values remain unapproved | Not measured | Added requirements traceability, initial API contract, payment lifecycle, and updated assumptions. `git diff --check` clean; internal Markdown links resolve; working-tree and commit-history prohibited-name/credential scans had no findings. No application tests or deployment run | Resolved an over-broad outbox assumption: provider dispatch is proposed synchronously after local commit to avoid persisting card tokens; async dispatch would require explicit secure token-retention design | Ready for user review; do not start I1 until lifecycle/policy and public publication gate are accepted |

## Summary to complete at the end

- Iterations to the first complete acceptance pass:
- Additional correction iterations to stable pass:
- Human interventions and decisions:
- Time and coordination/rework evidence:
- Defects escaped to later iterations:
- Rubric points verified, with evidence:
- Deployment and publication gates actually completed:
