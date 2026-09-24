resource "aws_vpc" "app" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = local.resource_prefix }
}

resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id

  tags = { Name = "${local.resource_prefix}-igw" }
}

resource "aws_subnet" "public" {
  for_each = local.availability_zone_indexes

  vpc_id                  = aws_vpc.app.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = true

  tags = { Name = "${local.resource_prefix}-public-${each.value + 1}" }
}

resource "aws_subnet" "private" {
  for_each = local.availability_zone_indexes

  vpc_id                  = aws_vpc.app.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value + 10)
  map_public_ip_on_launch = false

  tags = { Name = "${local.resource_prefix}-private-${each.value + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.app.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.app.id
  }

  tags = { Name = "${local.resource_prefix}-public" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "api" {
  name        = "${local.resource_prefix}-api"
  description = "Allow API traffic only from the internal load balancer."
  vpc_id      = aws_vpc.app.id

  tags = { Name = "${local.resource_prefix}-api" }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "API traffic from the internal load balancer."
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "api_outbound" {
  security_group_id = aws_security_group.api.id
  description       = "Outbound requests for image pulls, logs, and service operations."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "alb" {
  name        = "${local.resource_prefix}-alb"
  description = "Private API origin for CloudFront VPC Origins."
  vpc_id      = aws_vpc.app.id

  tags = { Name = "${local.resource_prefix}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
  description       = "CloudFront origin-facing network to the private API origin."
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "Forward API requests to the service tasks."
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_security_group" "database" {
  name        = "${local.resource_prefix}-db"
  description = "PostgreSQL is reachable only from the API tasks."
  vpc_id      = aws_vpc.app.id

  tags = { Name = "${local.resource_prefix}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_api" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.api.id
  description                  = "PostgreSQL from the API task security group."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
