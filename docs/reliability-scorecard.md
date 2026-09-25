# I5 reliability and quality scorecard

This scorecard records measured quality for I5. It is evidence for review, not a claim that the challenge rubric has already awarded points. The frontend changes were deployed after PR #14 merged; Lighthouse numbers below still come from the optimized local build, not CloudFront.

## Automated tests and coverage

Both test suites use Jest's global 80% thresholds for statements, branches, functions, and lines. The API integration runner creates an isolated local PostgreSQL test database, applies every migration, runs the suites, rolls the migrations back, and drops that database.

| App / area | Suites | Tests | Statements | Branches | Functions | Lines | Gate |
|---|---:|---:|---:|---:|---:|---:|---|
| API aggregate | 10 | 88 | 89.68% | 81.95% | 94.24% | 91.01% | Pass; global 80% thresholds |
| Web aggregate | 8 | 76 | 94.81% | 91.20% | 91.22% | 96.61% | Pass; global 80% thresholds |
| `payments` directory | — | included above | 84.21% | 79.39% | 91.25% | 86.67% | Below 80% for branches |
| `payments.service.ts` | — | included above | 82.40% | 74.89% | 85.71% | 85.71% | Below 80% for branches |

The two application-wide Jest gates pass. The payment module is a narrower exception that the aggregate can hide: its branch coverage remains below 80%. Remaining branches include scheduler/reconciliation error and candidate paths plus defensive consistency failures. I5 makes that gap visible instead of treating aggregate coverage as proof that every payment transition has equal test depth. CI currently enforces the aggregate threshold per app, not a per-file payment threshold.

API integration cases added in I5 cover provider/configuration error translation, payment replay/history guards, mismatched provider responses, confirmed void and stock release, post-retention replay and prevention of a new payment after personal-data removal, aged known-transaction reconciliation/manual review, latest-attempt recovery, duplicate/unmatched/time-window webhook handling, and other checkout, guest-session, inventory, product, and health boundaries. The DB tests use real PostgreSQL; the provider is a deterministic test double. No real payment or card was used.

## Accessibility and browser checks

- Jest and `jest-axe` checks run against the catalog, checkout summary, payment panel, and full initial application view. All passed in the latest web suite.
- Lighthouse accessibility score was 100 in all three mobile runs; the color-contrast audit passed.
- A local Chromium browser check loaded the catalog through the API and found no horizontal overflow at a 1280 px desktop viewport (`scrollWidth` equaled viewport width).
- Browser evidence is limited to Chromium. No physical-device, Firefox, Safari, or manual screen-reader pass is claimed.

## Mobile performance

Three Lighthouse 13.5.0 runs measured the optimized local Vite production build at `http://localhost:4173/`, connected to the local API. The reproducible data is in [`scorecards/i5-lighthouse-mobile.json`](scorecards/i5-lighthouse-mobile.json); raw Lighthouse reports remained in `/tmp` and are not committed.

| Metric | Runs | Median |
|---|---|---:|
| Performance | 90, 95, 96 | 95 |
| Accessibility | 100, 100, 100 | 100 |
| Cumulative layout shift | 0.0000465, 0.0000465, 0.0000465 | 0.0000465 |
| Largest contentful paint | 2348, 1608, 1656 ms | 1656 ms |
| Total blocking time | 322, 223, 190 ms | 223 ms |
| Speed index | 2661, 1608, 1656 ms | 1656 ms |

The first run's layout shift came from replacing a small startup status region with the full catalog after guest-session initialization. I5 now renders the catalog's space-reserving skeleton during initialization, reducing the measured shift to approximately 0.00005 in all three production-build runs. Lighthouse used a 412 × 823 mobile viewport, 1.75 device scale factor, simulated 4× CPU slowdown, 150 ms RTT, and 1,638.4 Kbps throughput with an Android 11 Moto G Power user-agent profile. This is an emulation and is not a physical-device or deployed-site result.

## CI and local quality gates

The GitHub Actions `quality` job runs dependency audit, lint, typecheck, build, and web coverage. `database-migrations` applies migrations and runs API PostgreSQL integration tests with coverage thresholds. The infrastructure job continues to format, initialize without a backend, and validate Terraform. Local `npm audit --audit-level=moderate` reported zero vulnerabilities after the I5 test dependencies were added.

Commands to reproduce the standard checks:

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm run test:coverage --workspace @payment-flow-lab/web
npm run test:api -- --coverage
npm audit --audit-level=moderate
```

For the Lighthouse measurement, start the local API with a test environment and CORS origin for the preview, build, and serve the production assets:

```sh
API_PORT=3001 WEB_ORIGIN=http://localhost:4173 npm run dev:api
VITE_API_BASE_URL=http://localhost:3001/api/v1 VITE_PAYMENT_GATEWAY_ENVIRONMENT=test npm run build --workspace @payment-flow-lab/web
cd apps/web && npx vite preview --host 127.0.0.1 --port 4173
```

Then run Lighthouse from the repository root:

```sh
npm run audit:lighthouse -- http://localhost:4173/ --form-factor=mobile --only-categories=performance,accessibility --output=json --output-path=/tmp/pfl-i5-lighthouse.json --chrome-flags='--headless --no-sandbox' --quiet
```

## Review limits

I5 verifies automated quality gates and records their weak spots. It does not measure deployed CloudFront performance, multiple browser engines, production traffic, or physical mobile devices. The payment-service branch gap is disclosed above; the application-wide gates pass, but a final challenge score is not assigned here.
