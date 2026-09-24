#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
terraform_directory="$repository_root/infra/terraform"
aws_profile="${AWS_PROFILE:-payment-flow-lab}"
aws_region="$(terraform -chdir="$terraform_directory" output -raw aws_region)"

ecs_cluster="$(terraform -chdir="$terraform_directory" output -raw ecs_cluster_name)"
task_definition="$(terraform -chdir="$terraform_directory" output -raw migration_task_definition_arn)"
api_security_group="$(terraform -chdir="$terraform_directory" output -raw api_security_group_id)"
subnet_ids="$(terraform -chdir="$terraform_directory" output -json public_subnet_ids)"
network_configuration="$(jq -cn \
  --argjson subnets "$subnet_ids" \
  --arg security_group "$api_security_group" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$security_group],assignPublicIp:"ENABLED"}}')"

run_response="$(aws ecs run-task \
  --profile "$aws_profile" \
  --region "$aws_region" \
  --cluster "$ecs_cluster" \
  --task-definition "$task_definition" \
  --launch-type FARGATE \
  --network-configuration "$network_configuration" \
  --output json)"

failure_count="$(jq '.failures | length' <<<"$run_response")"
if [[ "$failure_count" -gt 0 ]]; then
  jq -r '.failures[] | "Migration task could not start: \(.reason // .detail // "unknown reason")"' <<<"$run_response" >&2
  exit 1
fi

migration_task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_response")"
if [[ -z "$migration_task_arn" ]]; then
  echo "AWS did not return a migration task ARN." >&2
  exit 1
fi

aws ecs wait tasks-stopped \
  --profile "$aws_profile" \
  --region "$aws_region" \
  --cluster "$ecs_cluster" \
  --tasks "$migration_task_arn"

task_details="$(aws ecs describe-tasks \
  --profile "$aws_profile" \
  --region "$aws_region" \
  --cluster "$ecs_cluster" \
  --tasks "$migration_task_arn" \
  --output json)"
migration_exit_code="$(jq -r '.tasks[0].containers[0].exitCode // "unknown"' <<<"$task_details")"

if [[ "$migration_exit_code" != "0" ]]; then
  jq -r '.tasks[0] | "Migration task stopped: \(.stoppedReason // "no stop reason"), container reason: \(.containers[0].reason // "no container reason")"' <<<"$task_details" >&2
  exit 1
fi

echo "Database migration completed successfully (exit code 0)."
