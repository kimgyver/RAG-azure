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
