terraform {
  required_version = ">= 1.5.7, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.7.2"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "random_id" "suffix" {
  byte_length = 3
}

locals {
  resource_prefix    = "${var.project_name}-${var.environment}-${random_id.suffix.hex}"
  availability_zones = slice(sort(data.aws_availability_zones.available.names), 0, 2)
  availability_zone_indexes = {
    for index, zone in local.availability_zones : zone => index
  }
  database_name = "payment_flow_lab"
  web_dist_dir  = abspath("${path.module}/../../apps/web/dist")
  web_assets    = fileset(local.web_dist_dir, "**")

  api_environment = [
    { name = "API_PORT", value = "3000" },
    { name = "WEB_ORIGIN", value = "https://${aws_cloudfront_distribution.app.domain_name}" },
    { name = "DATABASE_HOST", value = aws_db_instance.postgres.address },
    { name = "DATABASE_PORT", value = tostring(aws_db_instance.postgres.port) },
    { name = "DATABASE_NAME", value = local.database_name },
    { name = "DATABASE_USER", value = aws_db_instance.postgres.username },
    { name = "DATABASE_SSL", value = "true" },
    { name = "DATABASE_SSL_CA_FILE", value = "/etc/ssl/certs/aws-rds-global-bundle.pem" },
  ]

  database_password_secret = format(
    "%s:password::",
    aws_db_instance.postgres.master_user_secret[0].secret_arn,
  )

  api_secrets = [
    { name = "DATABASE_PASSWORD", valueFrom = local.database_password_secret },
  ]
}

variable "aws_region" {
  description = "AWS Region for the deployment."
  type        = string
  default     = "sa-east-1"
}

variable "project_name" {
  description = "Neutral project identifier used in names and tags."
  type        = string
  default     = "payment-flow-lab"
}

variable "environment" {
  description = "Deployment environment label."
  type        = string
  default     = "challenge"
}

variable "api_image_tag" {
  description = "Immutable ECR tag to deploy. Use the short Git commit SHA after publishing the image."
  type        = string
  default     = "i1-bootstrap"
}

variable "service_desired_count" {
  description = "Desired API tasks; use 0 only for the initial bootstrap, then keep the steady-state default at 1."
  type        = number
  default     = 1

  validation {
    condition     = var.service_desired_count >= 0 && var.service_desired_count <= 2
    error_message = "service_desired_count must be between 0 and 2."
  }
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for the isolated challenge VPC."
  type        = string
  default     = "10.42.0.0/16"
}
