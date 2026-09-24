output "application_url" {
  description = "HTTPS URL for the deployed React app and same-origin API."
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "aws_region" {
  description = "Region used by the deployment and one-off migration task."
  value       = var.aws_region
}

output "api_image_uri" {
  description = "ECR URI for the configured API image tag."
  value       = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
}

output "ecr_repository_url" {
  description = "Private ECR repository to receive the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster containing the API service and migration task."
  value       = aws_ecs_cluster.app.name
}

output "ecs_service_name" {
  description = "ECS Fargate API service."
  value       = aws_ecs_service.api.name
}

output "migration_task_definition_arn" {
  description = "Run this task definition once after publishing the image and before enabling the API service."
  value       = aws_ecs_task_definition.migration.arn
}

output "api_security_group_id" {
  description = "Security group for one-off migration tasks and the API service."
  value       = aws_security_group.api.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs used by Fargate tasks for outbound AWS image and log access without a NAT gateway."
  value       = [for subnet in values(aws_subnet.public) : subnet.id]
}

output "private_database_endpoint" {
  description = "Private PostgreSQL endpoint; no password is included."
  value       = aws_db_instance.postgres.address
}
