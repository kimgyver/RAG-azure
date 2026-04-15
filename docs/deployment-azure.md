# Azure deployment (Terraform + Functions publish)

[← README](../README.md) · [Development](./development.md)

## Contents

1. [Prerequisites](#prerequisites)  
2. [1. Provision infrastructure](#1-provision-infrastructure)  
3. [2. Publish Function App code](#2-publish-function-app-code)  
4. [3. Point the frontend at Azure](#3-point-the-frontend-at-azure)  
5. [4. Optional backends: Search, Cosmos, OpenAI](#4-optional-backends-azure-ai-search-cosmos-db-openai)  
6. [5. Post-deploy checklist](#5-post-deploy-checklist)  
7. [Troubleshooting](#troubleshooting) — [404 / publish](#function-routes-return-404-after-publish), [503 catalog](#document-catalog-returns-503), [CORS](#browser-shows-failed-to-fetch-cors), [App Service quota](#app-service-plan-quota-is-zero)  
8. [Destroy](#destroy)

### What Terraform creates (and does not)

| Created by this stack | Notes |
|------------------------|--------|
| Resource group | From `project_name` + suffix |
| Storage account | Blob uploads container + Functions host storage (`AzureWebJobsStorage`) |
| Service Bus | Namespace + processing queue (name matches `AZURE_PROCESSING_QUEUE_NAME`) |
| Linux Function App | Node 20, extension ~4; **Application Insights** wired via app settings |
| App Service plan | New plan **or** attach `existing_linux_service_plan_resource_id` |
| Application Insights | Logs / metrics for the Function App |

**Not** provisioned by default: **Azure AI Search**, **Cosmos DB**, **Azure OpenAI**. Connect existing services via Portal **Configuration** or `extra_app_settings` in `terraform.tfvars` (same variable names as [`local.settings.json.example`](../backend/functions-ingestion/local.settings.json.example)).

Useful outputs after `terraform apply`:

| Output | Purpose |
|--------|---------|
| `api_base_url` | Set `VITE_UPLOAD_API_BASE_URL` to this value (includes `/api`) |
| `function_app_name` | Argument to `func azure functionapp publish` |
| `storage_account_name` | Blob / CORS in Portal |
| `servicebus_namespace` | Queue diagnostics |
| `application_insights_connection_string` | Sensitive; optional local / CI use |

> **If `terraform apply` fails with `Basic VMs: 0` or `Dynamic VMs: 0`:** your subscription cannot create **any** new App Service plan in that region. Terraform will keep failing until you either **(A)** set `existing_linux_service_plan_resource_id` in `terraform.tfvars` to an existing Linux plan in the **same subscription**, **(B)** switch to a subscription that has App Service quota (e.g. Pay-As-You-Go), or **(C)** request a quota increase in Azure Portal. Skipping this step is not optional—see [Troubleshooting](#troubleshooting) below.

This stack provisions **Resource Group**, **Storage** (blob + Functions host), **Service Bus** (processing queue), **Linux Function App** (Node 20, extension ~4), and **Application Insights**. By default it also creates a **new** Linux App Service plan (`B1`, or `Y1` Consumption if you set `app_service_plan_sku`). That only works when Azure grants quota; otherwise use **`existing_linux_service_plan_resource_id`**. Cosmos DB, AI Search, and OpenAI keys are off by default—use `extra_app_settings` or the portal.

To use **Consumption** when quota allows: in `terraform.tfvars` set `app_service_plan_sku = "Y1"`.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) logged in (`az login`)
- Subscription selected: `az account set --subscription <id>`
- **Node.js** (LTS, e.g. 20) for `npm run build` in `frontend` and `backend/functions-ingestion`
- [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) v4.x (`func`) for `func azure functionapp publish`

## 1. Provision infrastructure

If your subscription often hits **quota 0** on plan creation, **before** `terraform apply` create or locate a **Linux** App Service plan that already exists (Portal → your plan → **JSON View** / properties → copy **Resource ID**), then put it in `infra/terraform.tfvars`:

```hcl
existing_linux_service_plan_resource_id = "/subscriptions/.../resourceGroups/.../providers/Microsoft.Web/serverFarms/..."
```

```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Note the outputs:

```bash
terraform output api_base_url
terraform output function_app_name
```

## 2. Publish Function App code

From the Functions project (after `npm run build`):

```bash
cd ../backend/functions-ingestion
npm install
npm run build
func azure functionapp publish "$(terraform -chdir=../../infra output -raw function_app_name)"
```

If `func` is not installed, use [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

## 3. Point the frontend at Azure

Set the API base URL to the deployed app (see `terraform output api_base_url`):

```bash
# frontend/.env
VITE_UPLOAD_API_BASE_URL=https://<function-app>.azurewebsites.net/api
VITE_UPLOAD_API_KEY=<optional: host key for authLevel=function routes>
```

Rebuild the SPA and host it (Static Web Apps, Storage static website, etc.). Add your site origin to:

- **Function App** CORS (portal or `host.json` for allowed origins), and  
- **Storage account** blob CORS (`blob_cors_origins` in Terraform, or portal) for browser PUT uploads.

## 4. Optional backends: Azure AI Search, Cosmos DB, OpenAI

Terraform leaves **Cosmos DB** and **Azure AI Search** off by default (`COSMOS_DB_ENABLED` / `SEARCH_ENABLED` are `false` and endpoints are empty). Turn on at least **Search** or **Cosmos** if you want the [document catalog](../backend/functions-ingestion/src/functions/listDocumentCatalog.ts) API to return **200** instead of **503** (see [Troubleshooting: document catalog 503](#document-catalog-returns-503)).

Setting names match [`backend/functions-ingestion/local.settings.json.example`](../backend/functions-ingestion/local.settings.json.example).

### 4.1 Azure AI Search (use an existing service)

You **do not** need to create a second Search service if you already have one (for example **Search service** `rag-search-core` in any resource group or region). Point the Function App at that service with application settings.

**Cross-region:** The Function App and Search can live in different regions (e.g. Function in `eastus`, Search in `Australia East`). The worker calls Search over HTTPS; only latency may differ.

**Index name:** Default in code and Terraform is **`rag-chunks`**. If your Search service uses another index name, set `SEARCH_INDEX_NAME` on the Function App to match. When Search is enabled, the Functions code can **create or update** the index schema as needed on first use— you usually do **not** need to pre-create the index in the portal unless you intentionally manage it yourself.

#### Option A — Azure Portal

1. Open your **Azure AI Search** resource (e.g. `rag-search-core`).
2. **Overview** → copy **Url** (e.g. `https://<service-name>.search.windows.net`). This is `SEARCH_ENDPOINT` (no trailing slash required).
3. **Settings** → **Keys** → copy a **Admin key** (primary or secondary). This is `SEARCH_API_KEY`.
4. Open your **Function App** (the one Terraform created / you publish to).
5. **Settings** → **Configuration** → **Application settings** → **+ New application setting** (or edit existing):
   - `SEARCH_ENABLED` = `true`
   - `SEARCH_ENDPOINT` = the URL from step 2
   - `SEARCH_API_KEY` = the admin key from step 3
   - `SEARCH_INDEX_NAME` = only if not using `rag-chunks`
6. **Save**. Wait for the app to restart.

**Verify:** `GET https://<function-app>.azurewebsites.net/api/documents/catalog?tenantId=<tenant>` should return **200** (possibly an empty `documents` array until you upload and index content).

#### Option B — Terraform `extra_app_settings`

Do **not** commit secrets. Keep `terraform.tfvars` gitignored and merge Search keys via `extra_app_settings` (see [`infra/terraform.tfvars.example`](../infra/terraform.tfvars.example)):

```hcl
extra_app_settings = {
  SEARCH_ENABLED   = "true"
  SEARCH_ENDPOINT  = "https://<your-search-service>.search.windows.net"
  SEARCH_API_KEY   = "<admin-key-from-portal>"
  # SEARCH_INDEX_NAME = "custom-index"  # omit if default rag-chunks
}
```

Then:

```bash
cd infra
terraform apply
```

### 4.2 Cosmos DB (optional)

To use Cosmos for document metadata: set `COSMOS_DB_ENABLED` = `true`, plus `COSMOS_ENDPOINT`, `COSMOS_KEY`, and optionally `COSMOS_DATABASE_ID` / `COSMOS_DOCUMENTS_CONTAINER_ID` (defaults exist in `local.settings.json.example`). Portal or `extra_app_settings` same pattern as Search.

### 4.3 OpenAI / embeddings (optional)

Chat, embeddings, and some ingestion paths need additional keys (`AZURE_OPENAI_*`, `OPENAI_API_KEY`, `EMBEDDING_ENABLED`, etc.). See `local.settings.json.example` and enable only what you use.

## 5. Post-deploy checklist

Use this after `terraform apply` and `func azure functionapp publish`.

- [ ] **Functions build included in zip:** run `npm run build` in `backend/functions-ingestion` before every publish. This repo un-ignores `backend/functions-ingestion/dist/` in `.gitignore` so Core Tools includes compiled JS (see [404 troubleshooting](#function-routes-return-404-after-publish)).
- [ ] **API URL:** `terraform output api_base_url` matches `frontend/.env` → `VITE_UPLOAD_API_BASE_URL` (must end with `/api`).
- [ ] **Catalog not 503:** at least one of Search or Cosmos is on with valid endpoints/keys ([§4.1](#41-azure-ai-search-use-an-existing-service) / [§4.2](#42-cosmos-db-optional)).
- [ ] **Blob uploads from browser:** Storage account **CORS** allows your SPA origin and `PUT` (Terraform `blob_cors_origins`; re-apply if you add a Static Web Apps URL).
- [ ] **Function CORS:** same origins as above (Function App `site_config.cors` in Terraform mirrors `blob_cors_origins`).
- [ ] **Optional keys:** for routes with `authLevel: function`, set `VITE_UPLOAD_API_KEY` to the Function App **App keys → `_default`** host key (`frontend/.env.example` comments).
- [ ] **Production hardening:** set `ALLOWED_TENANT_IDS` to a comma-separated allowlist; do not rely on UI-supplied tenant alone ([security-and-pitch.md](./security-and-pitch.md)).
- [ ] **Observability:** Application Insights is configured on the Function App by default. Portal → Function App → **Application Insights** or **Log stream** to debug queue/Blob/HTTP failures.

### HTTP routes (quick reference)

Paths are relative to `https://<function-app>.azurewebsites.net/api`.

| Route | Typical use |
|--------|-------------|
| `GET flags/deployment` | Runtime feature flags (no secrets) |
| `GET documents/catalog?tenantId=` | Merged Cosmos + Search document list |
| `DELETE documents/{documentId}/purge?tenantId=` | Remove Search chunks + Cosmos row (not Blob) |
| `POST uploads/create` | SAS + metadata for browser PUT upload |
| `POST chat` | RAG chat |

Several handlers use `authLevel: anonymous` for local/demo convenience; lock down with APIM, VNet, or auth in real deployments.

## Troubleshooting

### Function routes return 404 after publish

Symptoms: `GET /api/documents/catalog`, `GET /api/flags/deployment`, or other HTTP routes return **404** on Azure though they work locally.

`func azure functionapp publish` **honours `.gitignore`**. If `backend/functions-ingestion/dist/` was ignored, the zip had **no compiled `dist/`**, so no HTTP routes were registered on Azure → 404. This repo adds `!backend/functions-ingestion/dist/` so the Functions build output is included. After pulling that change: `npm run build` in `backend/functions-ingestion`, then **`func azure functionapp publish …` again**.

### Document catalog returns 503

Symptoms: `GET /api/documents/catalog?tenantId=…` returns **503** with a JSON body such as both Cosmos and Search disabled.

The Functions app returns **503** when **both** Cosmos DB and Azure AI Search are turned off (`COSMOS_DB_ENABLED` and `SEARCH_ENABLED` are not `true`). The default Terraform `app_settings` keep them off so you can deploy storage + queue + Functions first.

**Fix:** enable at least one backend the catalog can read from:

- **Search only (common for RAG):** in `terraform.tfvars` merge into `extra_app_settings` (see `terraform.tfvars.example`): `SEARCH_ENABLED = "true"`, `SEARCH_ENDPOINT`, `SEARCH_API_KEY`, and optionally `SEARCH_INDEX_NAME` if not `rag-chunks`. Then `terraform apply` and wait for the app to restart; or set the same keys in Portal → Function App → **Configuration**.
- **Cosmos:** set `COSMOS_DB_ENABLED = "true"` plus `COSMOS_ENDPOINT`, `COSMOS_KEY`, and container/database IDs if you use metadata there.

Until one of those is enabled, the catalog endpoint responds by design with 503 and a JSON body explaining that both stores are disabled.

### Browser shows Failed to fetch (CORS)

Usually **CORS**: the page runs on `http://localhost:5173` but requests go to `https://<functionapp>.azurewebsites.net`. After `terraform apply`, the Function App `site_config.cors` uses the same origins as `blob_cors_origins` (defaults include localhost). Re-run `terraform apply` if you changed origins.

Also check **DevTools → Network**: red request + CORS error in console confirms it. As a fallback, Portal → your Function App → **CORS** → add `http://localhost:5173` (and your real SPA URL when hosted).

Verify `frontend/.env` has **`VITE_UPLOAD_API_BASE_URL=https://<app>.azurewebsites.net/api`** (including `/api`).

### Service Bus namespace name is invalid

Azure reserves namespace names that end with `-sb` or `-mgmt`. This repo uses `"{project}-sb-{random}"` so the name does not end with `-sb`.

### App Service plan quota is zero

Applies when Terraform or Azure reports **Dynamic VMs: 0** and/or **Basic VMs: 0** (cannot create a new Linux App Service plan).

Some subscriptions (e.g. certain **Azure for Students** or tightly capped tenants) report **0** for both **Dynamic VMs** (Consumption) and **Basic VMs** (B1). Terraform **cannot create a new App Service plan** in that case.

Pick one path:

1. **Portal** → Subscriptions → **Usage + quotas** → request an increase for **App Service** / **Basic small vCPU** (or use a **Pay-As-You-Go** subscription), or  
2. Try another `location` in `terraform.tfvars` (e.g. `westus2`), or  
3. **Reuse an existing Linux App Service plan** in the **same subscription** that already has capacity: set in `terraform.tfvars`:
   ```hcl
   existing_linux_service_plan_resource_id = "/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Web/serverFarms/<PLAN_NAME>"
   ```
   Then `terraform apply` skips creating `azurerm_service_plan` and attaches the Function App to that plan (the Function App is created in the **plan’s region**; Storage/Service Bus stay in `location`).

**Terraform prompt:** type the letters `yes` only (a Korean IME can produce `ㅛyes`, which is **not** accepted).

## Destroy

```bash
cd infra
terraform destroy
```
