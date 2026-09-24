resource "aws_ecr_repository" "api" {
  name                 = "${var.project_name}/api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the five most recent deployment images."
      selection = {
        tagStatus     = "tagged"
        tagPrefixList = ["i1-"]
        countType     = "imageCountMoreThan"
        countNumber   = 5
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "app" {
  name = "${local.resource_prefix}-cluster"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.resource_prefix}/api"
  retention_in_days = 7
}

resource "aws_iam_role" "task_execution" {
  name = "${local.resource_prefix}-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "database_secret" {
  name = "${local.resource_prefix}-database-secret"
  role = aws_iam_role.task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_db_instance.postgres.master_user_secret[0].secret_arn
    }]
  })
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.resource_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.task_execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    essential = true
    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]
    environment = local.api_environment
    secrets     = local.api_secrets
    healthCheck = {
      command = [
        "CMD",
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/api/v1/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
        "mode"                  = "non-blocking"
        "max-buffer-size"       = "25m"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.resource_prefix}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.task_execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name       = "migration"
    image      = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    essential  = true
    entryPoint = ["node"]
    command    = ["scripts/migrate.mjs", "up"]
    environment = [
      { name = "DATABASE_HOST", value = aws_db_instance.postgres.address },
      { name = "DATABASE_PORT", value = tostring(aws_db_instance.postgres.port) },
      { name = "DATABASE_NAME", value = local.database_name },
      { name = "DATABASE_USER", value = aws_db_instance.postgres.username },
      { name = "DATABASE_SSL", value = "true" },
      { name = "DATABASE_SSL_CA_FILE", value = "/etc/ssl/certs/aws-rds-global-bundle.pem" },
    ]
    secrets = local.api_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migration"
        "mode"                  = "non-blocking"
        "max-buffer-size"       = "25m"
      }
    }
  }])
}

resource "aws_lb" "api" {
  name               = "${substr(var.project_name, 0, 15)}-${random_id.suffix.hex}-api"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in values(aws_subnet.private) : subnet.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${substr(var.project_name, 0, 15)}-${random_id.suffix.hex}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.app.id

  health_check {
    enabled             = true
    path                = "/api/v1/health/live"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_cloudfront_vpc_origin" "api" {
  vpc_origin_endpoint_config {
    name                   = "${local.resource_prefix}-api"
    arn                    = aws_lb.api.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  depends_on = [aws_lb_listener.api]
}

resource "aws_ecs_service" "api" {
  name             = "${local.resource_prefix}-api"
  cluster          = aws_ecs_cluster.app.id
  task_definition  = aws_ecs_task_definition.api.arn
  desired_count    = var.service_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  network_configuration {
    subnets          = [for subnet in values(aws_subnet.public) : subnet.id]
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.task_execution,
    aws_iam_role_policy.database_secret,
    aws_lb_listener.api,
    aws_cloudfront_distribution.app,
  ]
}
