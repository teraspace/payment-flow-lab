#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aws_profile="${AWS_PROFILE:-payment-flow-lab}"
aws_region="${AWS_REGION:-sa-east-1}"
credential_exports="$(aws configure export-credentials --profile "$aws_profile" --region "$aws_region" --format env)"

# aws login credentials are CLI-cached; export them only into this Terraform process.
eval "$credential_exports"
unset credential_exports

exec terraform "-chdir=$repository_root/infra/terraform" "$@"
