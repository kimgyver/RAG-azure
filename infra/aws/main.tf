locals {
  name_prefix = "${var.project_name}-${var.environment}"
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ── VPC (default) ───────────────────────────────────────────────────────────
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ── ECR (Python backend) ──────────────────────────────────────────────────────
resource "aws_ecr_repository" "backend" {
  name                 = "${local.name_prefix}-backend"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.common_tags
}

# ── S3 ───────────────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name_prefix}-uploads-${data.aws_caller_identity.current.account_id}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "GET"]
    allowed_origins = ["*"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_caller_identity" "current" {}

# ── DynamoDB ─────────────────────────────────────────────────────────────────
resource "aws_dynamodb_table" "documents" {
  name         = "${local.name_prefix}-documents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "documentId"

  attribute {
    name = "documentId"
    type = "S"
  }

  attribute {
    name = "tenantId"
    type = "S"
  }

  global_secondary_index {
    name            = "tenantId-index"
    hash_key        = "tenantId"
    projection_type = "ALL"
  }

  tags = local.common_tags
}

# ── SQS ──────────────────────────────────────────────────────────────────────
resource "aws_sqs_queue" "documents_dlq" {
  name                      = "${local.name_prefix}-documents-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "documents" {
  name                       = "${local.name_prefix}-documents"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 86400 # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.documents_dlq.arn
    maxReceiveCount     = 3
  })

  tags = local.common_tags
}

# ── OpenSearch ────────────────────────────────────────────────────────────────
resource "aws_opensearch_domain" "search" {
  domain_name    = "${local.name_prefix}-search-v2"
  engine_version = "OpenSearch_2.11"

  cluster_config {
    instance_type  = var.opensearch_instance_type
    instance_count = var.opensearch_instance_count
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 20
    volume_type = "gp3"
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.ec2_backend.arn }
        Action    = "es:*"
        Resource  = "arn:aws:es:${var.region}:${data.aws_caller_identity.current.account_id}:domain/${local.name_prefix}-search-v2/*"
      }
    ]
  })

  tags = local.common_tags
}

# ── CloudWatch Log Group ──────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ec2/${local.name_prefix}-backend"
  retention_in_days = 14
  tags              = local.common_tags
}

# ── SSM Parameters (secrets) ──────────────────────────────────────────────────
resource "aws_ssm_parameter" "openai_api_key" {
  name  = "/${local.name_prefix}/OPENAI_API_KEY"
  type  = "SecureString"
  value = var.openai_api_key
  tags  = local.common_tags
}

# ── IAM: EC2 Instance Role ────────────────────────────────────────────────────
resource "aws_iam_role" "ec2_backend" {
  name = "${local.name_prefix}-ec2-backend"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "ec2_backend_inline" {
  name = "inline"
  role = aws_iam_role.ec2_backend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:HeadObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.uploads.arn, "${aws_s3_bucket.uploads.arn}/*"]
      },
      {
        Sid      = "DynamoDB"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [aws_dynamodb_table.documents.arn, "${aws_dynamodb_table.documents.arn}/index/*"]
      },
      {
        Sid      = "SQS"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.documents.arn, aws_sqs_queue.documents_dlq.arn]
      },
      {
        Sid      = "OpenSearch"
        Effect   = "Allow"
        Action   = ["es:ESHttp*"]
        Resource = "${aws_opensearch_domain.search.arn}/*"
      },
      {
        Sid      = "Textract"
        Effect   = "Allow"
        Action   = ["textract:DetectDocumentText", "textract:AnalyzeDocument"]
        Resource = "*"
      },
      {
        Sid      = "SSMRead"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${local.name_prefix}/*"
      },
      {
        Sid      = "SSMSession"
        Effect   = "Allow"
        Action   = ["ssm:UpdateInstanceInformation", "ssmmessages:*", "ec2messages:*"]
        Resource = "*"
      },
      {
        Sid    = "ECRPull"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = "*"
      },
      {
        Sid      = "CloudWatchLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "backend" {
  name = "${local.name_prefix}-ec2-profile"
  role = aws_iam_role.ec2_backend.name
  tags = local.common_tags
}

# ── AMI: Amazon Linux 2023 ─────────────────────────────────────────────────────
data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── Security Group for EC2 ─────────────────────────────────────────────────────
resource "aws_security_group" "ec2_backend" {
  name        = "${local.name_prefix}-ec2-backend"
  description = "Allow HTTP and SSM for EC2 backend"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP via Nginx"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

# ── EC2 Instance (t2.micro — Free Tier) ───────────────────────────────────────
resource "aws_instance" "backend" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.ec2_instance_type
  iam_instance_profile   = aws_iam_instance_profile.backend.name
  vpc_security_group_ids = [aws_security_group.ec2_backend.id]

  # Root volume — 30GB free tier maximum
  root_block_device {
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tpl", {
    aws_region          = var.region
    ecr_image           = "${aws_ecr_repository.backend.repository_url}:latest"
    s3_bucket           = aws_s3_bucket.uploads.bucket
    dynamodb_table      = aws_dynamodb_table.documents.name
    sqs_queue_url       = aws_sqs_queue.documents.url
    opensearch_endpoint = "https://${aws_opensearch_domain.search.endpoint}"
    allowed_tenant_ids  = var.allowed_tenant_ids
    openai_ssm_name     = aws_ssm_parameter.openai_api_key.name
  }))

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-backend" })
}

# ── Elastic IP (stable address across reboots) ────────────────────────────────
resource "aws_eip" "backend" {
  instance = aws_instance.backend.id
  domain   = "vpc"
  tags     = merge(local.common_tags, { Name = "${local.name_prefix}-backend-eip" })
}

# ═══════════════════════════════════════════════════════════════════════════════
# GitHub Actions OIDC (no long-term credentials)  — only Python ECS uses ECR/ECS
# ═══════════════════════════════════════════════════════════════════════════════

resource "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # GitHub's OIDC thumbprint (stable)
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.common_tags
}

resource "aws_iam_role" "github_actions" {
  name = "${local.name_prefix}-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github_actions.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "deploy"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
          "ecr:DescribeRepositories",
        ]
        Resource = [
          aws_ecr_repository.backend.arn,
        ]
      },
      {
        Sid    = "EC2Deploy"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand",
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations",
          "ec2:DescribeInstances",
        ]
        Resource = "*"
      },
      {
        Sid    = "LambdaDeploy"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:PublishVersion",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
        ]
        Resource = [
          aws_lambda_function.node_http.arn,
          aws_lambda_function.node_worker.arn,
        ]
      },
    ]
  })
}
# ═══════════════════════════════════════════════════════════════════════════════
# Node.js backend (Lambda)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Lambda execution IAM role ─────────────────────────────────────────────────
resource "aws_iam_role" "lambda_exec" {
  name = "${local.name_prefix}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_app" {
  name = "app-permissions"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket", "s3:HeadObject"]
        Resource = [aws_s3_bucket.uploads.arn, "${aws_s3_bucket.uploads.arn}/*"]
      },
      {
        Sid      = "DynamoDB"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [aws_dynamodb_table.documents.arn, "${aws_dynamodb_table.documents.arn}/index/*"]
      },
      {
        Sid      = "SQS"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.documents.arn, aws_sqs_queue.documents_dlq.arn]
      },
      {
        Sid      = "OpenSearch"
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete", "es:ESHttpHead"]
        Resource = "${aws_opensearch_domain.search.arn}/*"
      },
      {
        Sid      = "Textract"
        Effect   = "Allow"
        Action   = ["textract:DetectDocumentText", "textract:AnalyzeDocument"]
        Resource = "*"
      },
      {
        Sid      = "SSM"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.openai_api_key.arn
      },
    ]
  })
}

# ── Placeholder ZIP (CI/CD will replace with real code) ───────────────────────
data "archive_file" "lambda_placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"
  source {
    content  = "exports.handler = async () => ({ statusCode: 200, body: JSON.stringify({ status: 'initializing' }) })"
    filename = "index.js"
  }
}

# ── CloudWatch log groups for Lambda ─────────────────────────────────────────
resource "aws_cloudwatch_log_group" "lambda_http" {
  name              = "/aws/lambda/${local.name_prefix}-node-http"
  retention_in_days = 14
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "lambda_worker" {
  name              = "/aws/lambda/${local.name_prefix}-node-worker"
  retention_in_days = 14
  tags              = local.common_tags
}

# ── Lambda Function — HTTP (wraps Express app via serverless-http) ────────────
resource "aws_lambda_function" "node_http" {
  function_name    = "${local.name_prefix}-node-http"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 512
  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256

  environment {
    variables = {
      CLOUD_PROVIDER        = "aws"
      S3_BUCKET_NAME        = aws_s3_bucket.uploads.id
      DYNAMODB_TABLE_NAME   = aws_dynamodb_table.documents.name
      SQS_QUEUE_URL         = aws_sqs_queue.documents.url
      OPENSEARCH_ENDPOINT   = "https://${aws_opensearch_domain.search.endpoint}"
      OPENSEARCH_INDEX_NAME = "rag-chunks"
      ALLOWED_TENANT_IDS    = var.allowed_tenant_ids
      SEARCH_ENABLED        = "true"
      OPENAI_API_KEY        = var.openai_api_key
    }
  }

  lifecycle { ignore_changes = [filename, source_code_hash] }
  depends_on = [aws_cloudwatch_log_group.lambda_http]
  tags       = local.common_tags
}

# ── Lambda Function — SQS worker (processes document queue) ──────────────────
resource "aws_lambda_function" "node_worker" {
  function_name    = "${local.name_prefix}-node-worker"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 300
  memory_size      = 1024
  filename         = data.archive_file.lambda_placeholder.output_path
  source_code_hash = data.archive_file.lambda_placeholder.output_base64sha256

  environment {
    variables = {
      CLOUD_PROVIDER        = "aws"
      S3_BUCKET_NAME        = aws_s3_bucket.uploads.id
      DYNAMODB_TABLE_NAME   = aws_dynamodb_table.documents.name
      SQS_QUEUE_URL         = aws_sqs_queue.documents.url
      OPENSEARCH_ENDPOINT   = "https://${aws_opensearch_domain.search.endpoint}"
      OPENSEARCH_INDEX_NAME = "rag-chunks"
      ALLOWED_TENANT_IDS    = var.allowed_tenant_ids
      SEARCH_ENABLED        = "true"
      OPENAI_API_KEY        = var.openai_api_key
    }
  }

  lifecycle { ignore_changes = [filename, source_code_hash] }
  depends_on = [aws_cloudwatch_log_group.lambda_worker]
  tags       = local.common_tags
}

# ── SQS → Lambda event source (Lambda polls SQS automatically) ───────────────
resource "aws_lambda_event_source_mapping" "sqs_worker" {
  event_source_arn = aws_sqs_queue.documents.arn
  function_name    = aws_lambda_function.node_worker.arn
  batch_size       = 1
  enabled          = true
}

# ── API Gateway v2 (HTTP API) — public endpoint for Node.js Lambda ────────────
resource "aws_apigatewayv2_api" "node_http" {
  name          = "${local.name_prefix}-node-api"
  protocol_type = "HTTP"
  tags          = local.common_tags
}

resource "aws_apigatewayv2_integration" "node_http" {
  api_id                 = aws_apigatewayv2_api.node_http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.node_http.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.node_http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.node_http.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.node_http.id
  name        = "$default"
  auto_deploy = true
  tags        = local.common_tags
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.node_http.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.node_http.execution_arn}/*/*"
}
