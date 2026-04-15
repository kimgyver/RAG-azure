variable "location" {
  type        = string
  description = "Azure region for all resources (e.g. eastus)."
  default     = "eastus"
}

variable "project_name" {
  type        = string
  description = "Short name used in resource names (letters/digits; keep short for storage account 24-char limit)."
  default     = "ragdemo"
}

variable "app_service_plan_sku" {
  type        = string
  description = "Linux App Service plan SKU when Terraform creates the plan. B1 or Y1. Ignored if existing_linux_service_plan_resource_id is set."
  default     = "B1"
}

variable "existing_linux_service_plan_resource_id" {
  type        = string
  description = "Optional full ARM ID of an existing Linux App Service plan (Microsoft.Web/serverFarms/...). Use when this subscription cannot create any new plan (Basic VMs / Dynamic VMs quota 0). Function App is created in the plan's region; other resources stay in var.location."
  default     = ""
}

variable "servicebus_queue_name" {
  type        = string
  description = "Service Bus queue name for document processing (must match AZURE_PROCESSING_QUEUE_NAME)."
  default     = "processing-jobs"
}

variable "blob_cors_origins" {
  type        = list(string)
  description = "Allowed origins for browser PUT uploads to Blob (add your Static Web App URL when deployed)."
  default = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174"
  ]
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to all resources."
  default     = {}
}

variable "extra_app_settings" {
  type        = map(string)
  description = "Extra Function App settings merged over defaults (e.g. OPENAI_API_KEY, SEARCH_* when you enable features)."
  default     = {}
}
