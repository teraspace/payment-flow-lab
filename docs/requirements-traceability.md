# Challenge requirements and acceptance traceability

This is the neutral, implementation-facing interpretation of the supplied challenge brief. Requirements describe what the brief asks for; design choices and unresolved details are labeled separately. The challenge PDF remains the source of truth if this interpretation conflicts with it.

## Functional and technical requirements

| ID | Requirement from the brief | Acceptance evidence | Planned iteration |
|---|---|---|---|
| R-01 | Show seeded products with image, description, price, and available stock. | Product listing/detail loads from the API; seeded data is documented; available stock reflects active reservations. | I2, I4 |
| R-02 | Complete the product, card/delivery, order-summary, payment-result, and updated-product-stock journey. | Browser walkthrough covers each step, fees and total, approved/declined/pending outcomes, refresh recovery, and resulting stock. | I2–I5 |
| R-03 | Build the single-page frontend with React or Vue and Redux or Vuex. | React + TypeScript + Redux Toolkit; responsive screenshots and browser flow evidence. | I1, I4–I5 |
| R-04 | Use an allowed backend: JavaScript/TypeScript with NestJS, or Ruby with Grape/Sinatra; keep business logic out of controllers. | NestJS + TypeScript modular API; domain/application logic and adapter boundaries are visible in code and API documentation. | I1–I3 |
| R-05 | Persist checkout/payment progress and recover it after browser refresh without losing transaction state. | Refresh during `PENDING`/unknown status and recover the same checkout through a server status endpoint; no card data is restored. | I3–I4 |
| R-06 | Seed sample products; a product-creation endpoint is not required. | Seed/migration workflow creates demo catalog; public API has no product-write route unless a later need is approved. | I1–I2 |
| R-07 | Use Jest and achieve more than 80% coverage. | CI reports line, branch, and function coverage above 80% for both frontend and backend; uncovered critical paths are reviewed. | I1, I5 |
| R-08 | Provide API documentation and explain the data model in the README; a request collection may be included. | README links to the versioned API contract/OpenAPI output and explains checkout, reservation, attempt, webhook, and fulfillment records. | I1–I3, I7 |
| R-09 | Deploy the frontend and backend as a working connected application; AWS is recommended. | Public application URL completes the flow against the deployed API; health checks and smoke evidence are recorded. | I6–I7 |
| R-10 | Submit a public GitHub repository, avoid the company name in repository content, and do not distribute the solution to other candidates. | Neutral repository/name/history scan before first push; public URL and incremental feature history; no direct candidate distribution. | I0, I7 |
| R-11 | Feature branches and pull requests are recommended; visible genuine progress/commits matters. | Meaningful feature commits and reviewable PRs show actual progress. No arbitrary commit count is claimed as a requirement. | Every hosted feature iteration |
| R-12 | Use AI if possible; the brief includes an “AI CLI Assist” reference. | The ledger records actual assistant/tool use, human decisions, rework, and iteration evidence. The brief does not specify a required AI vendor or command-line product. | All iterations |

## Rubric ledger

The six base categories add to 100 points. Code presence alone does not earn verified points; the final report must link each score to visible evidence.

| Base category | Points | Evidence target | Planned iteration |
|---|---:|---|---|
| README | 5 | Complete setup, data model, API documentation, decisions, and deployment instructions. | I1–I7 |
| UI, images, and responsiveness without overflow | 5 | Product assets and measured mobile/desktop layouts. | I4–I5 |
| Complete checkout flow | 20 | End-to-end product, delivery/card, summary, payment status, refresh recovery, and updated stock. | I2–I5 |
| API | 20 | Documented NestJS API with persisted state, validation, inventory rules, and payment lifecycle. | I1–I3, I5 |
| Test coverage | 30 | CI-generated coverage above 80%, plus critical lifecycle/concurrency evidence. | I1–I5 |
| Working deployed application | 20 | Connected public frontend/API with deployment and smoke evidence. | I6–I7 |
| **Base total** | **100** |  |  |

The additional 50 points are bonus categories, not part of the 100-point base: clear code structure (10), design (10), security (10), UX (10), and extra features (10). Treat bonuses as stretch goals after the base flow is accepted and working.

## Architecture interpretation

AWS is the preferred target in the brief. The current proposal is a modular NestJS service on ECS Fargate, PostgreSQL for transactional state, and Terraform for infrastructure. This demonstrates service boundaries, transaction boundaries, asynchronous provider events, and failure recovery without splitting a small challenge into independently deployed microservices. The payment provider and database are already distributed-system boundaries; adding more services needs evidence and an explicit scope decision.

The PDF names allowed stacks and an AWS preference, but does not require a particular AWS service topology, Lambda, microservices, a queue product, or an event bus. Terraform/AWS design and cost review belong to I6, not the I0 approval.

## Provider integration facts checked for planning

The current official provider documentation was reviewed on 2026-09-24. It describes browser-side card tokenization and acceptance tokens, a server-side transaction API whose initial successful creation is `PENDING`, terminal states including `APPROVED`, `DECLINED`, `VOIDED`, and `ERROR`, and signed transaction events. It documents lookup by provider transaction ID; it does not establish that a unique reference gives replay-safe idempotency or a general status lookup by reference. Therefore a duplicate-reference response is not treated as proof that the first request succeeded.

These are integration facts to recheck immediately before I3 because provider contracts can change. No provider credentials, sandbox secrets, or company-specific URL are kept in this public project documentation.

## I0 approval checklist

- [ ] Approve the requirements traceability and the selected React/NestJS/PostgreSQL/Fargate/Terraform direction.
- [ ] Approve the proposed payment, inventory, timeout, retry, cancellation, and late-approval lifecycle in `payment-lifecycle.md`, or identify edits.
- [ ] Resolve or explicitly accept the provisional policies listed in `open-decisions.md`.
- [ ] Review the exact neutral tree and commit history before public publication.
- [ ] Only after these decisions, publish the public repository, protect `main`, and begin I1.
