# AWS deployment preview

This stack deploys only the I1 foundation shell: a static React app, API health/docs, and PostgreSQL. It does not implement or expose checkout or payment processing.

## Architecture and exposure

- React assets live in a private S3 bucket and are served over HTTPS through CloudFront Origin Access Control.
- `/api/*` routes through CloudFront VPC Origins to a private Application Load Balancer and then to NestJS on ECS Fargate.
- PostgreSQL runs in private subnets, is encrypted at rest, is not publicly accessible, and accepts connections only from the API task security group.
- The Fargate task runs in public subnets with a public IPv4 address so it can pull from ECR and send logs without a NAT Gateway. Its security group accepts inbound port 3000 only from the load balancer. The load balancer is private and its security group accepts HTTP only from CloudFront's AWS managed origin-facing prefix list.
- AWS manages the RDS master password in Secrets Manager. Terraform state contains the secret ARN, not the database password. The container receives the password at task startup and verifies PostgreSQL TLS with the AWS RDS CA bundle.
- CloudFront uses its default `cloudfront.net` HTTPS hostname; this stack does not create a domain name, Route 53 zone, or ACM certificate. AWS fixes the viewer security policy at `TLSv1` for the default certificate regardless of `minimum_protocol_version`; enforcing TLS 1.2 or newer requires an alternate domain name and a custom certificate. See [AWS CloudFront certificate settings](https://docs.aws.amazon.com/cli/latest/reference/cloudfront/update-distribution.html).

The API image is ARM64, matching the Fargate task platform and reducing compute cost. The application is still a single NestJS service. There is no NAT Gateway, public database, Kubernetes cluster, or payment-provider configuration.

## Prerequisites

- AWS CLI v2 authenticated with a profile that can create the listed VPC, CloudFront, ECS, ECR, IAM, RDS, Secrets Manager, S3, and CloudWatch resources.
- AWS region `sa-east-1`.
- Node.js 24.15 or newer, npm, Colima running on an ARM64 Mac, Terraform 1.5.7+, and `jq`. The local Docker engine builds the native ARM64 image; this stack does not require the Buildx plugin.
- Do not commit `terraform.tfstate`, `.tfvars`, credentials, or the generated plan file. This configuration uses local Terraform state; keep a secure backup and move state to a locked, encrypted S3 backend before ongoing team operation.

## Build and inspect the plan

From the repository root:

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm run build:web:deploy
docker build -f Dockerfile.api -t payment-flow-lab/api:i1-bootstrap .
```

Then from this directory:

```sh
../../scripts/terraform-aws.sh init
../../scripts/terraform-aws.sh plan -var='service_desired_count=0' -out=tfplan
../../scripts/terraform-aws.sh show tfplan
```

The initial bootstrap plan must explicitly set `service_desired_count = 0`. This creates the infrastructure and registers ECS task definitions before the image is pushed, without starting the API task. The default is `1` so future plans preserve the deployed steady state. After the bootstrap apply, publish the API image, run the database migration as a one-off Fargate task, and create the final plan:

**Do not apply until the plan, region, public exposure, AWS account plan, and expected monthly cost have been reviewed.** A plan is not a cost estimate; use the estimate below as a preflight and refresh it if resource sizes, region, or traffic assumptions change.

## Cost preflight

Indicative on-demand baseline for a 730-hour month in `sa-east-1`, with one ARM64 task continuously running after the final deployment, one `db.t4g.micro` single-AZ PostgreSQL instance, 20 GB gp3, one ALB, and one public task IPv4 address:

| Component | Approx. monthly baseline |
|---|---:|
| Fargate 0.25 vCPU / 0.5 GiB ARM64 | $12.40 |
| RDS PostgreSQL `db.t4g.micro` | $24.82 |
| RDS 20 GB gp3 | $4.38 |
| Internal ALB hourly charge and light LCU use | $25.60 |
| Fargate task public IPv4 | $3.65 |
| Secrets Manager | $0.40 |
| **Baseline before variable usage** | **about $71.25/month** |

S3 storage, ECR image storage, CloudWatch log ingestion, CloudFront requests/data transfer, taxes, and any additional usage are variable and not included. Budget approximately **$75–$90/month** at low traffic, then confirm actual usage in Billing. The zero-task bootstrap stage still incurs RDS, ALB, CloudFront, and storage charges. The database and load balancer continue billing until destroyed.

Rates change. Recheck [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/), [Elastic Load Balancing pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), and [VPC public IPv4 pricing](https://aws.amazon.com/vpc/pricing/) before applying. AWS's Free account plan ends after six months or when credits are depleted, whichever happens first; check the account's current credit balance and service eligibility rather than treating “Free Tier” as a blanket waiver.

The gross estimate does not subtract account-specific Free Tier offers. AWS currently lists ECS, ECR, RDS, CloudFront, VPC, and Elastic Load Balancing among services available to Free plan accounts; the RDS offer lists `db.t4g.micro` for PostgreSQL, and the networking offer advertises an ELB usage allowance and CloudFront monthly allowances. Eligibility, limits, and remaining credits must be checked in the account's Billing console before applying. If only the standard USD 100 sign-up credit is available, the full on-demand estimate could consume it quickly; a Free account plan can close before six months when credits run out.

## Deployment sequence after the plan gate

1. Apply the reviewed infrastructure plan with `service_desired_count = 0`. This creates the ECR repository and billable AWS resources, but does not start the API task:

   ```sh
   ../../scripts/terraform-aws.sh apply tfplan
   ```
2. Authenticate Docker to ECR and publish the immutable ARM64 image tag:

   ```sh
   repository_url="$(terraform output -raw ecr_repository_url)"
   registry="${repository_url%%/*}"
   aws ecr get-login-password --profile payment-flow-lab --region sa-east-1 \
     | docker login --username AWS --password-stdin "$registry"
   docker build -f ../../Dockerfile.api -t "${repository_url}:i1-bootstrap" ../..
   docker push "${repository_url}:i1-bootstrap"
   ```

3. Run the migration task and verify its exit code is zero. It uses the same private database access rules and migration files as local/CI:

   ```sh
   ../../scripts/run-aws-migration.sh
   ```

   Only after it succeeds, review the small final plan that changes `service_desired_count` from zero to one and apply it:

   ```sh
   ../../scripts/terraform-aws.sh plan \
     -var='api_image_tag=i1-bootstrap' -out=tfplan
   ../../scripts/terraform-aws.sh show tfplan
   ../../scripts/terraform-aws.sh apply tfplan
   ```
5. Wait for the ECS service to become stable, then check `application_url`, `/api/v1/health/live`, `/api/v1/health/ready`, and `/api/v1/docs` over HTTPS.

After the final apply, wait for the service to stabilize and smoke-check the output URL:

```sh
application_url="$(terraform output -raw application_url)"
curl --fail --silent --show-error "$application_url/api/v1/health/live"
curl --fail --silent --show-error "$application_url/api/v1/health/ready"
curl --fail --silent --show-error "$application_url/api/v1/docs" -o /dev/null
```

## Updating the deployed API with a database migration

For a backward-compatible schema migration, register the new migration task definition independently while leaving the running API on its current image. Use the immutable tag built from the reviewed feature commit for `migration_image_tag`; keep `api_image_tag` at the currently deployed API image (`i3-23f9aa2` as of the I3 deployment):

```sh
../../scripts/terraform-aws.sh plan \
  -var='api_image_tag=i3-23f9aa2' \
  -var='migration_image_tag=iN-<commit>' \
  -out=tfplan-migration
../../scripts/terraform-aws.sh show tfplan-migration
```

Review the plan before applying it. It should register a migration task-definition revision without changing the ECS API service. After that reviewed plan is applied, build and push the immutable image to ECR, then run `../../scripts/run-aws-migration.sh` and confirm exit code `0`.

Only after the migration succeeds, review the service rollout plan with both image tags set to the new commit:

```sh
../../scripts/terraform-aws.sh plan \
  -var='api_image_tag=iN-<commit>' \
  -var='migration_image_tag=iN-<commit>' \
  -out=tfplan-api
../../scripts/terraform-aws.sh show tfplan-api
```

That plan updates the API task definition and ECS service; apply it only after review. The migration variable defaults to `api_image_tag`, preserving the single-tag behavior for existing deployments that do not set it explicitly.

The I3 rollout plan also showed generated S3 web-asset differences because the ignored local `apps/web/dist` did not match the deployed bundle. Those web objects were outside I3 and were not applied. If a future API-only rollout plan contains unrelated web or infrastructure actions, stop and review the drift separately; do not include it in the API release. I3 used narrowly targeted migration/API ECS plans for that exceptional case. This is not the default Terraform workflow.

## Cleanup

`terraform destroy` removes this challenge environment, including the RDS instance without a final snapshot. Do not use it if the database contains data that must be retained. Keep the plan/state local and never publish them. Confirm the resources are gone in the AWS console/Billing after cleanup; CloudFront distributions can take time to disable and delete.
