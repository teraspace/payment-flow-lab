# Terraform infrastructure

This directory is reserved for the AWS deployment iteration. The target is a small ECS Fargate service with PostgreSQL and the minimum supporting AWS resources. Compare networking and ongoing charges before implementation. Review `terraform plan`, region, resource exposure, and estimated costs before any apply. Do not commit state files, plans containing secrets, or credentials.
