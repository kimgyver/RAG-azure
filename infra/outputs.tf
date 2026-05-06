output "resource_group_name" {
  description = "Resource group containing the RAG stack."
  value       = azurerm_resource_group.main.name
}

output "function_app_name" {
  description = "Azure Functions app name (use with func azure functionapp publish)."
  value       = azurerm_linux_function_app.ingestion.name
}

output "function_app_default_hostname" {
  description = "Default HTTPS hostname of the Function App (API base is https://<this>/api)."
  value       = azurerm_linux_function_app.ingestion.default_hostname
}

output "api_base_url" {
  description = "HTTPS URL prefix for HTTP functions (/api/...)."
  value       = "https://${azurerm_linux_function_app.ingestion.default_hostname}/api"
}

output "storage_account_name" {
  description = "Storage account used for blobs and Functions host state."
  value       = azurerm_storage_account.main.name
}

output "servicebus_namespace" {
  description = "Service Bus namespace name."
  value       = azurerm_servicebus_namespace.main.name
}

output "application_insights_connection_string" {
  description = "Application Insights connection string (sensitive)."
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}

output "storage_account_key" {
  description = "Primary access key for the storage account (sensitive)."
  value       = azurerm_storage_account.main.primary_access_key
  sensitive   = true
}

output "storage_blob_endpoint" {
  description = "Primary blob endpoint for the storage account."
  value       = azurerm_storage_account.main.primary_blob_endpoint
}

output "python_web_app_name" {
  description = "Python backend host name (Web App or Container App resource name)."
  value       = var.python_backend_hosting == "webapp" ? azurerm_linux_web_app.python_backend[0].name : azurerm_container_app.python_backend[0].name
}

output "python_web_app_default_hostname" {
  description = "Default HTTPS hostname of the Python backend (Web App or Container App ingress FQDN)."
  value       = var.python_backend_hosting == "webapp" ? azurerm_linux_web_app.python_backend[0].default_hostname : azurerm_container_app.python_backend[0].latest_revision_fqdn
}

output "python_api_base_url" {
  description = "HTTPS URL prefix for the Python backend (/api/...) for the selected hosting mode."
  value       = var.python_backend_hosting == "webapp" ? "https://${azurerm_linux_web_app.python_backend[0].default_hostname}/api" : "https://${azurerm_container_app.python_backend[0].latest_revision_fqdn}/api"
}

output "document_intelligence_endpoint" {
  description = "Azure Document Intelligence endpoint used for OCR."
  value       = azurerm_cognitive_account.document_intelligence.endpoint
}

output "document_intelligence_primary_key" {
  description = "Primary access key for Azure Document Intelligence (sensitive)."
  value       = azurerm_cognitive_account.document_intelligence.primary_access_key
  sensitive   = true
}
