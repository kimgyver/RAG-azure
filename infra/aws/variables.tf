variable "project_name" {
  description = "Name prefix for all resources"
  type        = string
  default     = "ragdemo"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-2"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "openai_api_key" {
  description = "OpenAI API key for the application"
  type        = string
  sensitive   = true
}

variable "github_repo" {
  description = "GitHub repository in org/repo format (e.g. jasonkim/rag-azure)"
  type        = string
}

variable "opensearch_instance_type" {
  description = "OpenSearch instance type"
  type        = string
  default     = "t3.small.search"
}

variable "opensearch_instance_count" {
  description = "Number of OpenSearch data nodes"
  type        = number
  default     = 1
}

variable "ec2_instance_type" {
  description = "EC2 instance type (t2.micro = Free Tier eligible)"
  type        = string
  default     = "t2.micro"
}

variable "allowed_tenant_ids" {
  description = "Comma-separated list of allowed tenant IDs"
  type        = string
  default     = "tenant-aws-1,tenant-aws-2"
}
