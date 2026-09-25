# I7 final acceptance evidence

- Assessment date: 2026-09-25
- Integrated baseline: `main` commit `11842e1` (PR #15)
- Status: technical acceptance prepared; pending user validation and final handoff.

## Scope and safety

This pass checked the public repository and deployed application without making a payment or changing AWS resources. It made only read-only HTTP requests to the deployed app/API. No card details, sandbox payment request, checkout mutation, or Terraform apply was performed. The earlier controlled sandbox flow remains documented in [the payment lifecycle](payment-lifecycle.md); that is prior evidence, not a new I7 payment.

The local API integration runner resets and drops only `payment_flow_lab_test` on loopback. It does not connect to the AWS database.

## Base rubric self-assessment

Evidence is present for all six base categories, supporting a **100/100-point technical self-assessment**. This is not an official score; only the evaluator can award points. No bonus points are included in the base assessment.

| Brief category | Points | I7 evidence | Assessment |
|---|---:|---|---|
| Complete README | 5 | This README documents the stack, clean setup, API/data model, lifecycle, deployment, decisions, scorecards, and public links. | Evidence present |
| Images render fast and avoid UI/UX boundaries | 5 | The three same-origin SVG assets each returned `200` from CloudFront and were 679-774 bytes. The I5 scorecard records a local production-build Lighthouse median of 95 performance and 100 accessibility, plus no horizontal overflow at 1280px in Chromium. | Evidence present; mobile Lighthouse is emulated, not a physical-device result |
| Complete card checkout onboarding flow | 20 | I4 sandbox evidence covers approval, decline, pending/unknown behavior, refresh recovery, and inventory/fulfillment outcomes. The deployed UI rendered the delivery step with `API conectado` and `Sandbox protegido`; the sandbox metadata route returned `200`. | Evidence present; the prior transaction smoke was not repeated during I7 |
| API working correctly | 20 | Deployed liveness, readiness, catalog, OpenAPI UI, and sandbox metadata returned `200`; readiness reported `checks.database=ok`. The local API suite passed against PostgreSQL. | Evidence present |
| More than 80% backend and frontend test coverage | 30 | The local Jest coverage run exceeded 80% in statements, branches, functions, and lines for both application aggregates; exact results are below. | Gate passed at application level |
| App and API deployed to a cloud provider | 20 | The public CloudFront app returned `200`; its HTTP URL redirected to HTTPS; API readiness and catalog worked through the same origin, and the rendered UI reported an API connection. | Evidence present |

### Measured coverage

| Application | Suites / tests | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|---:|
| API | 10 / 88 | 89.68% | 81.95% | 94.24% | 91.01% |
| Web | 8 / 76 | 94.81% | 91.20% | 91.22% | 96.61% |

The payment directory is a narrower exception: its branch coverage is 79.39%, and `payments.service.ts` is 74.89%. The brief asks for more than 80% backend and frontend coverage but does not require every directory or file to exceed 80%. The application-wide API and web gates pass; this exception remains disclosed in the [I5 scorecard](reliability-scorecard.md).

## Verification run

Local commands completed successfully on Node.js 26.7.0 and npm 11.19.0:

- `npm ci` — completed; installed 1,011 packages; npm reported zero vulnerabilities.
- `npm audit --audit-level=moderate` — zero vulnerabilities.
- `npm run lint`, `npm run typecheck`, and `npm run build` — passed.
- `npm run test:coverage --workspace @payment-flow-lab/web` — 8 suites, 76 tests passed; thresholds passed.
- `npm run test:api -- --coverage` — 10 suites, 88 tests passed against local PostgreSQL; migrations were applied and rolled back; thresholds passed.
- `terraform fmt -check -recursive .`, `terraform init -backend=false -input=false -lockfile=readonly`, and `terraform validate` — passed with Terraform 1.5.7.

The merged [`main` commit `11842e1`](https://github.com/teraspace/payment-flow-lab/commit/11842e1669d81103f0da1a7e0e29d1450a33bff5) also has successful `quality`, `database-migrations`, and `infrastructure` jobs in [GitHub Actions run 36153694291](https://github.com/teraspace/payment-flow-lab/actions/runs/36153694291). The `main` branch protection requires these checks and PR-based changes.

Read-only production checks on 2026-09-25:

| Request | Result |
|---|---|
| `GET /` | [`200`](https://d2ump7odi96dfi.cloudfront.net/) |
| `GET /api/v1/health/live` | [`200`](https://d2ump7odi96dfi.cloudfront.net/api/v1/health/live) |
| `GET /api/v1/health/ready` | [`200`](https://d2ump7odi96dfi.cloudfront.net/api/v1/health/ready), database `ok` |
| `GET /api/v1/products` | [`200`](https://d2ump7odi96dfi.cloudfront.net/api/v1/products) |
| `GET /api/v1/docs` | [`200`](https://d2ump7odi96dfi.cloudfront.net/api/v1/docs) |
| `GET /api/v1/payment-configuration/acceptance-documents` | [`200`](https://d2ump7odi96dfi.cloudfront.net/api/v1/payment-configuration/acceptance-documents) |
| HTTP viewer request | `301` redirect to HTTPS |

## Repository and delivery checks

- GitHub confirms [`teraspace/payment-flow-lab`](https://github.com/teraspace/payment-flow-lab) is public and uses `main` as its default branch.
- PRs #1-#15 are merged; no open PRs existed at the start of I7.
- The `main` protection requires a pull request and the three CI checks above.
- A targeted scan of 377 reachable Git blobs across fetched branches found no prohibited company-name string or high-confidence credential patterns (staging-key shapes, AWS access-key IDs, private-key headers, or GitHub token shapes). This pattern scan is useful evidence, not a guarantee equivalent to a dedicated secret-scanning product.

## Bonus evidence and limits

- HTTPS is active and HTTP redirects to HTTPS. The API responses include Helmet security headers, including CSP, HSTS, `X-Content-Type-Options`, and `X-Frame-Options`; the static CloudFront HTML response did not include those headers. Do not claim the full OWASP/HTTPS/security-headers bonus based on partial coverage.
- Responsive evidence includes the 412x823 emulated Lighthouse viewport and a 1280px Chromium overflow check. Firefox, Safari, physical devices, and manual screen-reader review were not measured; the cross-browser bonus is not established.
- The payment gateway is isolated behind the `PAYMENT_GATEWAY` contract and `HttpPaymentGateway` adapter. That supports a ports-and-adapters claim, but bonus scoring is evaluator judgment.
- No explicit Railway-Oriented Programming `Result`/`Either` flow was identified, so no ROP bonus is claimed.
- The I5 Lighthouse results describe the optimized local build, not CloudFront performance. Do not present them as deployed-site measurements.

## Remaining notes and gate

- A user-facing cancellation control and the precise business remedy for late approval after inventory release remain documented open decisions; the current path records a fulfillment exception and requires human resolution.
- AWS helper scripts still default to the older `payment-flow-lab` CLI profile when `AWS_PROFILE` is unset. Before any future AWS mutation, set `AWS_PROFILE=payment-flow-lab-deployer` in that terminal. No AWS mutation was needed for I7.
- MFA remains deferred at the user's request; it is not represented as complete.

The technical evidence is assembled. I7 is not closed until the user validates this report and the final handoff.
