# I7 audit and I8 acceptance remediation

- Audit date: 2026-09-25
- Audited deployed baseline: `main` commit `a1a29d8` (PR #16)
- Remediation branch: `codex/i8-checkout-acceptance`
- Verdict: **FAIL — acceptance is not established yet.**

The audit treated the PDF's mandatory requirements as gates. It found seven failures and four items that could not be verified. I8 addresses the seven implementation/documentation gaps locally. The branch has not been deployed, so this does not change the application currently served by CloudFront. No sandbox payment was submitted and no AWS resource was changed during I8. The source challenge defines these criteria; this report records implementation evidence and remaining verification limits.

## Audit findings and remediation evidence

| Requirement | I7 audit | I8 evidence | Current status |
|---|---|---|---|
| “Pay with credit card” opens a modal collecting card and delivery details | Fail: card input appeared after the delivery form | Product CTA now opens one accessible card-and-delivery modal. `CheckoutDetailsForm.spec.tsx` verifies consent and tokenization boundaries; local browser showed the modal at the target CSS viewport. | Remediated locally; live deploy pending |
| Product/base/delivery amounts and payment action appear in a backdrop | Fail: summary and payment action were separate | `CheckoutSummary` contains both the price summary and payment panel in its backdrop; component tests cover the structure. | Remediated locally; live deploy pending |
| Required five-screen sequence | Fail: only three progress stages | Progress now represents Producto → Tarjeta y entrega → Resumen → Resultado → Producto. App coverage includes terminal status and return states. | Remediated locally; live deploy pending |
| Preserve unsubmitted progress across refresh | Fail: selected product and form values were in memory only | Product and contact/delivery draft are kept in `sessionStorage`; the added App test reloads the component and verifies those values return while card number is not persisted. | Remediated locally; live deploy pending |
| Persist payment transaction as `PENDING` before provider call | Fail: initial state was `DISPATCHING` | A PostgreSQL integration assertion reads the row from inside the provider mock: state is `PENDING`, checkout is `PAYMENT_PENDING`, and the provider-response timestamp is still null. Provider call remains after SQL commit. | Remediated locally; API integration suite passes |
| After a terminal result, return to the product catalog with refreshed inventory | Fail: result remained on checkout | Final status includes a return action; the App test verifies it clears the checkout URL and refetches products. An automatic return remains available. | Remediated locally; live deploy pending |
| Put exact measured coverage in README | Fail: figures were only in the report | The README now lists current API and web suite counts and coverage percentages, plus the narrower payment-module exception. | Remediated locally |

The state change also separates **database consistency** from **domain idempotency**: PostgreSQL commits one local attempt before network dispatch; `dispatching` reports transport progress while the attempt's domain state is `PENDING`. Neither a SQL commit nor a provider reference promises exactly-once remote execution. If dispatch has an ambiguous outcome, the attempt becomes `UNKNOWN_OUTCOME`, retains the inventory hold, and is reconciled before another charge is allowed. Details are in [payment lifecycle](payment-lifecycle.md) and [API contract](api-contract.md).

## Latest local verification

Coverage runs on the I8 branch on 2026-09-25:

| Application | Suites / tests | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|---:|
| Web | 8 / 76 | 89.19% | 83.56% | 86.76% | 90.34% |
| API | 10 / 88 | 89.70% | 81.85% | 94.28% | 91.03% |

Both application aggregates exceed the brief's 80% coverage requirement. The payment directory remains below 80% branch coverage at 79.31%; `payments.service.ts` is at 74.89%. The README now presents these exact measurements.

The local browser was checked at CSS viewports of **375 × 667** (portrait) and **667 × 375** (landscape), matching the logical viewport dimensions of a 750 × 1334 / 1334 × 750 physical screen at DPR 2. Neither layout had horizontal overflow; the card-and-delivery dialog stayed within the viewport and scrolls internally to its submit action. The browser runtime used DPR 1.1, so this is a responsive viewport simulation, not a physical iPhone or hardware/DPR validation. No browser console errors or Vite error overlay appeared.

`npm run test:coverage --workspace @payment-flow-lab/web` passed 8 suites / 76 tests. `npm run test:api -- --coverage` passed 10 suites / 88 tests against local PostgreSQL, applied all migrations including the I8 migration, and rolled them back. `npm run lint`, `npm run typecheck`, and `npm run build` also passed. The API test runner targets only `payment_flow_lab_test` on loopback; it did not connect to AWS.

## Items still not verified

| Item | Why it remains open |
|---|---|
| Sandbox provider transaction after I8 | No payment was submitted in this pass. The final payment action must remain a user handoff; local contract/integration tests are not proof of a live provider transaction. Earlier sandbox evidence is historical and documented in [payment lifecycle](payment-lifecycle.md). |
| Physical iPhone SE 2020 / DPR and landscape behavior | The local CSS viewport was simulated in portrait only; no physical device test was run. |
| Solution not shared with other candidates | Repository and runtime checks cannot establish private sharing behavior. |
| Official minimum score of 100 | Only the challenge evaluator can award points. The audit gaps and unverified live gate mean no 100-point claim is made. |

## Deployment and release gate

The deployed app and API checks recorded during I7 describe the pre-I8 `main` version; they do not verify this remediation. The PR and hosted CI checks for I8 must pass, the user must review the change, and a reviewed deployment plan must be approved before updating AWS. A fresh live smoke should then verify the deployed five-stage flow and API. Any sandbox payment submission remains a user-operated handoff. No Terraform apply or production mutation was part of this branch's verification.
