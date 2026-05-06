data "azurerm_client_config" "current" {}

locals {
  base_slug_chars = [
    for ch in split("", lower(var.project_name)) : ch
    if length(regexall("[a-z0-9]", ch)) > 0
  ]
  base_slug = substr(join("", local.base_slug_chars), 0, 14)
  slug      = length(local.base_slug) > 0 ? local.base_slug : "app"
  suffix_chars = [
    for ch in split("", lower(trimspace(var.name_suffix))) : ch
    if length(regexall("[a-z0-9]", ch)) > 0
  ]
  auto_name_suffix = substr(md5("${data.azurerm_client_config.current.subscription_id}:${local.slug}"), 0, 8)
  name_suffix      = length(local.suffix_chars) > 0 ? substr(join("", local.suffix_chars), 0, 8) : local.auto_name_suffix
  # Storage account: 3–24 chars, lower-case letters and numbers only
  storage_account_name = substr("${local.slug}${local.name_suffix}", 0, 24)
  # Function app name: alphanumeric and hyphens, max 60, globally unique
  function_app_name               = "${local.slug}-${local.name_suffix}-fn"
  python_web_app_name             = "${local.slug}-${local.name_suffix}-py"
  python_container_app_name       = "${local.slug}-${local.name_suffix}-pyca"
  python_container_env_name       = "${local.slug}-${local.name_suffix}-cae"
  python_acr_name                 = substr("${local.slug}${local.name_suffix}acr", 0, 50)
  document_intelligence_name      = "${local.slug}-${local.name_suffix}-di"
  document_intelligence_subdomain = substr("${local.slug}${local.name_suffix}di", 0, 24)
  common_tags = merge(
    { workload = "rag-ingestion" },
    var.tags
  )

  plan_id_trimmed   = trimspace(var.existing_linux_service_plan_resource_id)
  use_existing_plan = length(local.plan_id_trimmed) > 0
  # ARM: .../resourceGroups/<rg>/providers/Microsoft.Web/serverFarms/<name>
  plan_id_parts = local.use_existing_plan ? regex(
    "resourceGroups/([^/]+)/providers/Microsoft.Web/[sS]erver[fF]arms/([^/]+)$",
    local.plan_id_trimmed
  ) : []
  existing_plan_rg_name = local.use_existing_plan ? local.plan_id_parts[0] : ""
  existing_plan_name    = local.use_existing_plan ? local.plan_id_parts[1] : ""
  service_plan_id       = local.use_existing_plan ? data.azurerm_service_plan.external[0].id : azurerm_service_plan.functions[0].id
  function_app_location = local.use_existing_plan ? data.azurerm_service_plan.external[0].location : var.location
  # Python Web App always uses its own dedicated plan (Consumption plans cannot host regular Web Apps)
  python_web_app_location = azurerm_resource_group.main.location
  # Keep CORS inputs deterministic during initial apply to avoid provider plan drift bugs.
  browser_cors_origins = distinct(compact(concat(var.blob_cors_origins, [trimspace(var.static_web_app_origin)])))
}

resource "azurerm_service_plan" "python_web" {
  count               = var.python_backend_hosting == "webapp" ? 1 : 0
  name                = "${local.slug}-${local.name_suffix}-py-asp"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = "F1"
  tags                = local.common_tags
}

resource "azurerm_cognitive_account" "document_intelligence" {
  name                          = local.document_intelligence_name
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  kind                          = "FormRecognizer"
  sku_name                      = "S0"
  custom_subdomain_name         = local.document_intelligence_subdomain
  local_auth_enabled            = true
  public_network_access_enabled = true
  tags                          = local.common_tags
}

data "archive_file" "python_backend_zip" {
  count       = var.python_backend_hosting == "webapp" ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../backend-python"
  output_path = "${path.module}/.terraform/python-backend.zip"
  excludes = [
    ".venv",
    ".env",
    "__pycache__",
    ".pytest_cache",
    "Dockerfile",
    ".dockerignore"
  ]
}

data "azurerm_service_plan" "external" {
  count               = local.use_existing_plan ? 1 : 0
  name                = local.existing_plan_name
  resource_group_name = local.existing_plan_rg_name
}

resource "azurerm_resource_group" "main" {
  name     = "${local.slug}-${local.name_suffix}-rg"
  location = var.location
  tags     = local.common_tags
}

resource "azurerm_storage_account" "main" {
  name                            = local.storage_account_name
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  allow_nested_items_to_be_public = false
  min_tls_version                 = "TLS1_2"
  tags                            = local.common_tags

  blob_properties {
    dynamic "cors_rule" {
      for_each = length(var.blob_cors_origins) > 0 ? [1] : []
      content {
        allowed_headers    = ["*"]
        allowed_methods    = ["DELETE", "GET", "HEAD", "MERGE", "OPTIONS", "PUT"]
        allowed_origins    = local.browser_cors_origins
        exposed_headers    = ["ETag", "x-ms-request-id", "x-ms-version"]
        max_age_in_seconds = 3600
      }
    }
  }
}

resource "azurerm_storage_container" "uploads" {
  name                  = "uploads"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_servicebus_namespace" "main" {
  # Azure disallows names ending in "-sb" or "-mgmt" (reserved suffixes).
  name                = "${local.slug}-sb-${local.name_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Basic"
  tags                = local.common_tags
}

resource "azurerm_servicebus_queue" "processing" {
  name         = var.servicebus_queue_name
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_servicebus_namespace_authorization_rule" "functions" {
  name         = "ingestion-functions"
  namespace_id = azurerm_servicebus_namespace.main.id
  listen       = true
  send         = true
  manage       = false
}

resource "azurerm_service_plan" "functions" {
  count               = local.use_existing_plan ? 0 : 1
  name                = "${local.slug}-${local.name_suffix}-asp"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = var.app_service_plan_sku
  tags                = local.common_tags
}

resource "azurerm_application_insights" "main" {
  name                = "${local.slug}-${local.name_suffix}-ai"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  application_type    = "web"
  tags                = local.common_tags
}

resource "azurerm_linux_function_app" "ingestion" {
  name                 = local.function_app_name
  location             = local.function_app_location
  resource_group_name  = azurerm_resource_group.main.name
  service_plan_id      = local.service_plan_id
  storage_account_name = azurerm_storage_account.main.name
  # Host runtime uses the same storage account as document blobs (blob trigger path uploads/{name})
  storage_account_access_key = azurerm_storage_account.main.primary_access_key
  https_only                 = true
  tags                       = local.common_tags

  site_config {
    application_stack {
      node_version = "20"
    }
    always_on = false

    # Browser calls from local Vite (or your SPA URL) hit Functions cross-origin; without this, catalog/chat show "Failed to fetch".
    cors {
      allowed_origins     = local.browser_cors_origins
      support_credentials = false
    }
  }

  identity {
    type = "SystemAssigned"
  }

  functions_extension_version = "~4"

  app_settings = merge(
    {
      FUNCTIONS_WORKER_RUNTIME                                                                      = "node"
      AzureWebJobsStorage                                                                           = azurerm_storage_account.main.primary_connection_string
      APPLICATIONINSIGHTS_CONNECTION_STRING                                                         = azurerm_application_insights.main.connection_string
      APPINSIGHTS_INSTRUMENTATIONKEY                                                                = azurerm_application_insights.main.instrumentation_key
      AZURE_STORAGE_ACCOUNT_NAME                                                                    = azurerm_storage_account.main.name
      AZURE_STORAGE_ACCOUNT_KEY                                                                     = azurerm_storage_account.main.primary_access_key
      AZURE_STORAGE_BLOB_ENDPOINT                                                                   = azurerm_storage_account.main.primary_blob_endpoint
      AZURE_STORAGE_CONTAINER_NAME                                                                  = azurerm_storage_container.uploads.name
      SERVICE_BUS_CONNECTION                                                                        = azurerm_servicebus_namespace_authorization_rule.functions.primary_connection_string
      AZURE_PROCESSING_QUEUE_NAME                                                                   = azurerm_servicebus_queue.processing.name
      SAS_EXPIRY_MINUTES                                                                            = "15"
      MAX_UPLOAD_SIZE_MB                                                                            = "20"
      BLOB_TRIGGER_SOURCE                                                                           = "LogsAndContainerScan"
      CHUNK_SIZE_CHARS                                                                              = "1200"
      CHUNK_OVERLAP_CHARS                                                                           = "200"
      COSMOS_DB_ENABLED                                                                             = "false"
      COSMOS_ENDPOINT                                                                               = ""
      COSMOS_KEY                                                                                    = ""
      COSMOS_DATABASE_ID                                                                            = "rag-db"
      COSMOS_DOCUMENTS_CONTAINER_ID                                                                 = "documents"
      SEARCH_ENABLED                                                                                = "false"
      SEARCH_ENDPOINT                                                                               = ""
      SEARCH_API_KEY                                                                                = ""
      SEARCH_INDEX_NAME                                                                             = "rag-chunks"
      CHAT_SEARCH_MODE                                                                              = "hybrid"
      CHAT_PROMPT_CHAR_BUDGET                                                                       = "12000"
      CHAT_QUESTION_CHAR_LIMIT                                                                      = "1200"
      CHAT_CONTEXT_CHAR_BUDGET                                                                      = "7000"
      CHAT_MAX_COMPLETION_TOKENS                                                                    = "600"
      CHAT_MEMORY_RECENT_TURNS                                                                      = "3"
      CHAT_MEMORY_RECENT_CHAR_BUDGET                                                                = "2200"
      CHAT_MEMORY_SUMMARY_CHAR_BUDGET                                                               = "1200"
      CHAT_SLOW_THRESHOLD_MS                                                                        = "4000"
      "AzureFunctionsJobHost__logging__logLevel__default"                                           = "None"
      "AzureFunctionsJobHost__logging__logLevel__Host__Singleton"                                   = "None"
      "AzureFunctionsJobHost__logging__logLevel__Host__Results"                                     = "None"
      "AzureFunctionsJobHost__logging__logLevel__Host__Triggers__Blobs"                             = "None"
      "AzureFunctionsJobHost__logging__logLevel__Host__Triggers__Queues"                            = "None"
      "AzureFunctionsJobHost__logging__logLevel__Host__Triggers__ServiceBus"                        = "None"
      "AzureFunctionsJobHost__logging__logLevel__Azure__Core"                                       = "None"
      "AzureFunctionsJobHost__logging__logLevel__Azure__Storage"                                    = "None"
      "AzureFunctionsJobHost__logging__logLevel__Azure__Storage__Blobs"                             = "None"
      "AzureFunctionsJobHost__logging__logLevel__Azure__Messaging__ServiceBus"                      = "None"
      "AzureFunctionsJobHost__logging__logLevel__Microsoft__Azure__WebJobs__Extensions__ServiceBus" = "None"
      "AzureFunctionsJobHost__logging__logLevel__Microsoft__Azure__WebJobs__Host__Singleton"        = "None"
      "AzureFunctionsJobHost__logging__logLevel__Function__chat"                                    = "Warning"
      EMBEDDING_ENABLED                                                                             = "false"
      AZURE_OPENAI_ENDPOINT                                                                         = ""
      AZURE_OPENAI_API_KEY                                                                          = ""
      AZURE_OPENAI_API_VERSION                                                                      = "2024-02-01"
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT                                                             = "text-embedding-3-small"
      OPENAI_EMBEDDING_MODEL                                                                        = "text-embedding-3-small"
      EMBEDDING_DIMENSIONS                                                                          = "1536"
      ALLOWED_TENANT_IDS                                                                            = join(",", var.allowed_tenant_ids)
      OCR_ENABLED                                                                                   = "true"
      OCR_PROVIDER                                                                                  = "azure-document-intelligence"
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT                                                          = azurerm_cognitive_account.document_intelligence.endpoint
      AZURE_DOCUMENT_INTELLIGENCE_KEY                                                               = azurerm_cognitive_account.document_intelligence.primary_access_key
      AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID                                                          = "prebuilt-read"
      OCR_LANGS                                                                                     = "eng"
      OCR_MAX_IMAGE_BYTES                                                                           = "12582912"
      OCR_MAX_EDGE_PX                                                                               = "2000"
    },
    var.extra_app_settings
  )
}

resource "azurerm_linux_web_app" "python_backend" {
  count               = var.python_backend_hosting == "webapp" ? 1 : 0
  name                = local.python_web_app_name
  location            = local.python_web_app_location
  resource_group_name = azurerm_resource_group.main.name
  service_plan_id     = azurerm_service_plan.python_web[0].id
  https_only          = true
  zip_deploy_file     = data.archive_file.python_backend_zip[0].output_path
  tags                = local.common_tags

  site_config {
    always_on        = false
    app_command_line = "python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

    application_stack {
      python_version = var.python_web_app_python_version
    }

    cors {
      allowed_origins     = local.browser_cors_origins
      support_credentials = false
    }
  }

  identity {
    type = "SystemAssigned"
  }

  app_settings = merge(
    {
      SCM_DO_BUILD_DURING_DEPLOYMENT        = "true"
      ENABLE_ORYX_BUILD                     = "true"
      PYTHONPATH                            = "/home/site/wwwroot"
      PYTHON_API_HOST                       = "0.0.0.0"
      PYTHON_API_PORT                       = "8000"
      APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
      APPINSIGHTS_INSTRUMENTATIONKEY        = azurerm_application_insights.main.instrumentation_key
      AZURE_STORAGE_ACCOUNT_NAME            = azurerm_storage_account.main.name
      AZURE_STORAGE_ACCOUNT_KEY             = azurerm_storage_account.main.primary_access_key
      AZURE_STORAGE_BLOB_ENDPOINT           = azurerm_storage_account.main.primary_blob_endpoint
      AZURE_STORAGE_CONTAINER_NAME          = azurerm_storage_container.uploads.name
      SAS_EXPIRY_MINUTES                    = "15"
      COSMOS_DB_ENABLED                     = "false"
      COSMOS_ENDPOINT                       = ""
      COSMOS_KEY                            = ""
      COSMOS_DATABASE_ID                    = "rag-db"
      COSMOS_DOCUMENTS_CONTAINER_ID         = "documents"
      SEARCH_ENABLED                        = "false"
      SEARCH_ENDPOINT                       = ""
      SEARCH_API_KEY                        = ""
      SEARCH_INDEX_NAME                     = "rag-chunks"
      CHAT_SEARCH_MODE                      = "keyword"
      EMBEDDING_ENABLED                     = "false"
      OPENAI_MODEL                          = "gpt-4o-mini"
      OPENAI_EMBEDDING_MODEL                = "text-embedding-3-small"
      EMBEDDING_DIMENSIONS                  = "1536"
      ALLOWED_TENANT_IDS                    = join(",", var.allowed_tenant_ids)
      OCR_ENABLED                           = "true"
      OCR_PROVIDER                          = "azure-document-intelligence"
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT  = azurerm_cognitive_account.document_intelligence.endpoint
      AZURE_DOCUMENT_INTELLIGENCE_KEY       = azurerm_cognitive_account.document_intelligence.primary_access_key
      AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID  = "prebuilt-read"
      CORS_ALLOW_ORIGINS                    = join(",", local.browser_cors_origins)
      WEBSITES_PORT                         = "8000"
    },
    var.extra_app_settings
  )
}

resource "azurerm_container_registry" "python" {
  count               = var.python_backend_hosting == "containerapp" ? 1 : 0
  name                = local.python_acr_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = local.common_tags
}

resource "azurerm_log_analytics_workspace" "python" {
  count               = var.python_backend_hosting == "containerapp" ? 1 : 0
  name                = "${local.slug}-${local.name_suffix}-law"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.common_tags
}

resource "azurerm_container_app_environment" "python" {
  count                      = var.python_backend_hosting == "containerapp" ? 1 : 0
  name                       = local.python_container_env_name
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.python[0].id
  tags                       = local.common_tags
}

resource "terraform_data" "python_image_build" {
  count = var.python_backend_hosting == "containerapp" ? 1 : 0
  input = {
    image = "${azurerm_container_registry.python[0].login_server}/${var.python_container_image_name}:${var.python_container_image_tag}"
  }

  provisioner "local-exec" {
    command = "az acr build --registry ${azurerm_container_registry.python[0].name} --image ${var.python_container_image_name}:${var.python_container_image_tag} ${path.module}/../backend-python"
  }
}

resource "azurerm_container_app" "python_backend" {
  count                        = var.python_backend_hosting == "containerapp" ? 1 : 0
  name                         = local.python_container_app_name
  container_app_environment_id = azurerm_container_app_environment.python[0].id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = local.common_tags

  registry {
    server               = azurerm_container_registry.python[0].login_server
    username             = azurerm_container_registry.python[0].admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.python[0].admin_password
  }

  template {
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "python-backend"
      image  = "${azurerm_container_registry.python[0].login_server}/${var.python_container_image_name}:${var.python_container_image_tag}"
      cpu    = 0.5
      memory = "1.0Gi"

      env {
        name  = "PYTHONPATH"
        value = "/app"
      }
      env {
        name  = "PYTHON_API_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "PYTHON_API_PORT"
        value = "8000"
      }
      env {
        name  = "WEBSITES_PORT"
        value = "8000"
      }
      env {
        name  = "CORS_ALLOW_ORIGINS"
        value = join(",", local.browser_cors_origins)
      }
      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
      }
      env {
        name  = "APPINSIGHTS_INSTRUMENTATIONKEY"
        value = azurerm_application_insights.main.instrumentation_key
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT_NAME"
        value = azurerm_storage_account.main.name
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT_KEY"
        value = azurerm_storage_account.main.primary_access_key
      }
      env {
        name  = "AZURE_STORAGE_BLOB_ENDPOINT"
        value = azurerm_storage_account.main.primary_blob_endpoint
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER_NAME"
        value = azurerm_storage_container.uploads.name
      }
      env {
        name  = "SAS_EXPIRY_MINUTES"
        value = "15"
      }
      env {
        name  = "COSMOS_DB_ENABLED"
        value = lookup(var.extra_app_settings, "COSMOS_DB_ENABLED", "false")
      }
      env {
        name  = "COSMOS_ENDPOINT"
        value = lookup(var.extra_app_settings, "COSMOS_ENDPOINT", "")
      }
      env {
        name  = "COSMOS_KEY"
        value = lookup(var.extra_app_settings, "COSMOS_KEY", "")
      }
      env {
        name  = "COSMOS_DATABASE_ID"
        value = "rag-db"
      }
      env {
        name  = "COSMOS_DOCUMENTS_CONTAINER_ID"
        value = "documents"
      }
      env {
        name  = "SEARCH_ENABLED"
        value = lookup(var.extra_app_settings, "SEARCH_ENABLED", "false")
      }
      env {
        name  = "SEARCH_ENDPOINT"
        value = lookup(var.extra_app_settings, "SEARCH_ENDPOINT", "")
      }
      env {
        name  = "SEARCH_API_KEY"
        value = lookup(var.extra_app_settings, "SEARCH_API_KEY", "")
      }
      env {
        name  = "SEARCH_INDEX_NAME"
        value = "rag-chunks"
      }
      env {
        name  = "CHAT_SEARCH_MODE"
        value = lookup(var.extra_app_settings, "CHAT_SEARCH_MODE", "keyword")
      }
      env {
        name  = "EMBEDDING_ENABLED"
        value = lookup(var.extra_app_settings, "EMBEDDING_ENABLED", "false")
      }
      env {
        name  = "OPENAI_MODEL"
        value = lookup(var.extra_app_settings, "OPENAI_MODEL", "gpt-4o-mini")
      }
      env {
        name  = "OPENAI_EMBEDDING_MODEL"
        value = lookup(var.extra_app_settings, "OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
      }
      env {
        name  = "EMBEDDING_DIMENSIONS"
        value = lookup(var.extra_app_settings, "EMBEDDING_DIMENSIONS", "1536")
      }
      env {
        name  = "ALLOWED_TENANT_IDS"
        value = join(",", var.allowed_tenant_ids)
      }
      env {
        name  = "OCR_ENABLED"
        value = "true"
      }
      env {
        name  = "OCR_PROVIDER"
        value = "azure-document-intelligence"
      }
      env {
        name  = "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"
        value = azurerm_cognitive_account.document_intelligence.endpoint
      }
      env {
        name  = "AZURE_DOCUMENT_INTELLIGENCE_KEY"
        value = azurerm_cognitive_account.document_intelligence.primary_access_key
      }
      env {
        name  = "AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID"
        value = "prebuilt-read"
      }
      env {
        name  = "OPENAI_API_KEY"
        value = lookup(var.extra_app_settings, "OPENAI_API_KEY", "")
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8000
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  depends_on = [terraform_data.python_image_build]
}

resource "azurerm_static_web_app" "frontend" {
  name                = "${local.slug}-${local.name_suffix}-swa"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.static_web_app_location
  sku_size            = var.static_web_app_sku_size
  sku_tier            = var.static_web_app_sku_tier
  tags                = local.common_tags

  # 배포는 GitHub Actions에서 진행
}