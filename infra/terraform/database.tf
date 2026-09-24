resource "aws_db_subnet_group" "postgres" {
  name       = "${local.resource_prefix}-db"
  subnet_ids = [for subnet in values(aws_subnet.private) : subnet.id]

  tags = { Name = "${local.resource_prefix}-db" }
}

resource "aws_db_instance" "postgres" {
  identifier                  = "${local.resource_prefix}-postgres"
  engine                      = "postgres"
  engine_version              = "17.11"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = local.database_name
  username                    = "app_admin"
  manage_master_user_password = true
  port                        = 5432

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 1
  auto_minor_version_upgrade = true
  deletion_protection        = false
  skip_final_snapshot        = true
  apply_immediately          = true

  tags = { Name = "${local.resource_prefix}-postgres" }
}
