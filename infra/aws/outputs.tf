output "ecr_repository_url" {
  description = "ECR repository URL for the Python backend image"
  value       = aws_ecr_repository.backend.repository_url
}

output "s3_bucket_name" {
  description = "S3 bucket name for uploads"
  value       = aws_s3_bucket.uploads.bucket
}

output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = aws_dynamodb_table.documents.name
}

output "sqs_queue_url" {
  description = "SQS queue URL for document processing"
  value       = aws_sqs_queue.documents.url
}

output "opensearch_endpoint" {
  description = "OpenSearch domain endpoint (HTTPS)"
  value       = aws_opensearch_domain.search.endpoint != null ? "https://${aws_opensearch_domain.search.endpoint}" : null
}

output "ec2_public_ip" {
  description = "EC2 Elastic IP — Python backend base URL"
  value       = "http://${aws_eip.backend.public_ip}"
}

output "ec2_instance_id" {
  description = "EC2 instance ID (for SSM deploy)"
  value       = aws_instance.backend.id
}

output "github_actions_role_arn" {
  description = "IAM Role ARN for GitHub Actions OIDC — set as AWS_DEPLOY_ROLE_ARN in repo vars"
  value       = aws_iam_role.github_actions.arn
}

output "node_api_url" {
  description = "Node.js Lambda API Gateway endpoint"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "python_api_url_https" {
  description = "Python EC2 backend HTTPS API Gateway endpoint (use this from HTTPS frontends)"
  value       = "${aws_apigatewayv2_stage.python_default.invoke_url}api"
}

output "node_http_function_name" {
  description = "Lambda function name for Node.js HTTP handler"
  value       = aws_lambda_function.node_http.function_name
}

output "node_worker_function_name" {
  description = "Lambda function name for Node.js SQS worker"
  value       = aws_lambda_function.node_worker.function_name
}
