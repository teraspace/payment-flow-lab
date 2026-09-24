# Payment Flow Lab

A full-stack checkout system built as an engineering challenge and as a measured experiment in AI-assisted software delivery.

The goal is to deliver a responsive React application, a NestJS API, PostgreSQL-backed inventory and checkout workflows, automated tests, and a reproducible AWS deployment. The application will integrate with a payment provider through a backend adapter.

## Selected stack

- Frontend: React, TypeScript, Redux Toolkit.
- Backend: NestJS, TypeScript, Jest.
- Database: PostgreSQL.
- Runtime: AWS ECS on Fargate.
- Infrastructure as code: Terraform.

The API is planned as one modular service. This keeps the challenge small enough to operate while preserving clear domain boundaries. Kubernetes and a microservice split are out of scope unless evidence changes that decision.

## Project status

Repository scaffold and initial engineering decisions are in place. Application code, cloud resources, and external publication have not started.

## Engineering rules

- Keep database consistency and domain idempotency as separate guarantees.
- Reserve stock atomically; never allow available stock to become negative.
- Keep payment-provider network calls outside database transactions.
- Treat a timeout after a request may have been sent as an unknown outcome. Reconcile it before allowing another charge attempt.
- Never put secrets or challenge credentials in source control.
- Keep payment, reservation, and fulfillment lifecycles independently observable.

See [the engineering baseline](docs/engineering-baseline.md), [the iteration plan](docs/iteration-plan.md), [the feature branch/PR workflow](docs/git-workflow.md), and [the agent workflow](AGENTS.md).

## Local setup

The toolchain and application commands will be added in the first implementation iteration. Do not copy real credentials into `.env.example`; use a local `.env` file, which is ignored by Git.

## Feature progress and AI-assisted workflow

The challenge asks for branches and pull requests by feature and warns against a repository with no visible progress or commits. Work therefore lands as meaningful commits on neutral feature branches, with a reviewable PR for each independent feature. Commits are not counted as iterations, and agents do not get separate PRs just because their roles differ. The target GitHub repository must be public; hosted progress should be visible incrementally after the public-repository gate. Each iteration ends with recorded evidence and a human validation gate. The ledger records actual agents, changes, test results, interventions, and defects; it does not claim checks that did not happen.

## Delivery scorecard

The challenge baseline is tracked as 100 points: README (5), responsive UI without overflow (5), complete user flow (20), API (20), test coverage (30), and a working deployed application (20). Report measured evidence for each item; do not infer points from code presence alone.
