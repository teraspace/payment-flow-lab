# AI-assisted SDLC experiment ledger

One row represents one integrated development cycle, not a prompt, agent message, or isolated subtask. The repository bootstrap below is a setup event before I0 and is excluded from the iteration count. Record tool/model/agent details only when actually observable. Distinguish AI work from human decisions and approvals.

| Iteration | Scope | Feature branch / PR / commits | Agents and tools | Human interventions | Elapsed / active time | Gates and evidence | Defects / rework | Outcome / next gate |
|---|---|---|---|---|---|---|---|
| Bootstrap (pre-I0) | Neutral scaffold and PDF-based feature/commit/PR workflow; no application code | `main` commit `4d790fb`; process commits `0c8011e` and `dc2f826` landed with I0 | Codex app; earlier PDF review; no new specialist agents in I0 | User requested analysis of incremental PRs, commit expectations, and completion of I0 | Not measured | Earlier PDF pages 1–7 reviewed with shared sandbox credential page excluded from notes; no tests or deployment run | I0 expands lifecycle details because failed/ambiguous payment semantics need an explicit gate | Process docs included in the public I0 feature PR |
| I0 (approved; PR preparation) | Trace requirements/rubric, define initial API contract and DBMS/domain idempotency boundary, specify payment failure/recovery, reservation and fulfillment lifecycle, and approve initial policies | Public branch `docs/iteration-0-baseline`; commits `8101dfc`, `60abf99`; PR creation pending | Codex app; official provider docs consulted for tokenization, acceptance, transaction, and event behavior; no specialist agents spawned | User approved the scope, lifecycle policies, public publication, and `main` protection on 2026-09-24 | Not measured | Added requirements traceability, initial API contract, payment lifecycle, and approval record. `git diff --check` clean; internal Markdown links resolve; working-tree and commit-history prohibited-name/credential scans had no findings. No application tests, CI, or deployment run | Provider dispatch remains synchronous after local commit to avoid persisting card tokens; a future async design needs explicit secure token-retention handling | Public repo exists, branches pushed, PR-only/no-force/no-delete protection is active; merge the I0 PR before I1 |

## Summary to complete at the end

- Iterations to the first complete acceptance pass:
- Additional correction iterations to stable pass:
- Human interventions and decisions:
- Time and coordination/rework evidence:
- Defects escaped to later iterations:
- Rubric points verified, with evidence:
- Deployment and publication gates actually completed:
