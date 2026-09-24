resource "aws_s3_bucket" "web" {
  bucket = "${var.project_name}-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}"

  lifecycle {
    precondition {
      condition     = length(local.web_assets) > 0
      error_message = "Build the React app first with npm run build --workspace @payment-flow-lab/web."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id

  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.resource_prefix}-web"
  description                       = "Private S3 origin for the React application."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.resource_prefix} full-stack application"
  price_class     = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "private-web-bucket"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    domain_name = aws_lb.api.dns_name
    origin_id   = "private-api-load-balancer"

    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.api.id
      origin_read_timeout      = 30
      origin_keepalive_timeout = 5
    }
  }

  default_root_object = "index.html"

  default_cache_behavior {
    target_origin_id       = "private-web-bucket"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "private-api-load-balancer"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD", "OPTIONS"]
    compress                 = true
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  depends_on = [
    aws_s3_bucket_public_access_block.web,
    aws_s3_bucket_ownership_controls.web,
    aws_s3_bucket_server_side_encryption_configuration.web,
  ]
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.app.arn
        }
      }
    }]
  })
}

locals {
  web_content_types = {
    ".css"  = "text/css; charset=utf-8"
    ".html" = "text/html; charset=utf-8"
    ".ico"  = "image/x-icon"
    ".js"   = "text/javascript; charset=utf-8"
    ".json" = "application/json"
    ".svg"  = "image/svg+xml"
  }
}

resource "aws_s3_object" "web_asset" {
  for_each = toset(local.web_assets)

  bucket        = aws_s3_bucket.web.id
  key           = each.key
  source        = "${local.web_dist_dir}/${each.key}"
  source_hash   = filemd5("${local.web_dist_dir}/${each.key}")
  content_type  = lookup(local.web_content_types, lower(regex("\\.[^.]+$", each.key)), "application/octet-stream")
  cache_control = each.key == "index.html" ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable"
}
