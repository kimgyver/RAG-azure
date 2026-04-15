#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

if [[ ! -d "$INFRA_DIR" ]]; then
  echo "infra directory not found: $INFRA_DIR" >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI (az) is required." >&2
  exit 1
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "Terraform CLI is required." >&2
  exit 1
fi

SEARCH_RG="${SEARCH_RG:-apim-lab-rg}"

FUNCTION_APP_NAME="$(terraform -chdir="$INFRA_DIR" output -raw function_app_name)"
FUNCTION_RG="$(terraform -chdir="$INFRA_DIR" output -raw resource_group_name)"

CURRENT_ENDPOINT="$(az functionapp config appsettings list --name "$FUNCTION_APP_NAME" --resource-group "$FUNCTION_RG" --query "[?name=='SEARCH_ENDPOINT'].value | [0]" -o tsv || true)"
CURRENT_HOST="${CURRENT_ENDPOINT#https://}"
CURRENT_HOST="${CURRENT_HOST%%.*}"
SERVICE_NAME="${1:-${CURRENT_HOST:-rag-search-free-ondemand}}"

echo "Disabling search in Function App"
az functionapp config appsettings set \
  --name "$FUNCTION_APP_NAME" \
  --resource-group "$FUNCTION_RG" \
  --settings \
    SEARCH_ENABLED=false \
    SEARCH_ENDPOINT= \
    SEARCH_API_KEY= \
  --output none

if az search service show --name "$SERVICE_NAME" --resource-group "$SEARCH_RG" >/dev/null 2>&1; then
  echo "Deleting search service: $SERVICE_NAME"
  az search service delete \
    --name "$SERVICE_NAME" \
    --resource-group "$SEARCH_RG" \
    --yes
else
  echo "Search service not found, skipping delete: $SERVICE_NAME"
fi

echo "Search disabled for Function App"
echo "  functionApp: $FUNCTION_APP_NAME"
echo
echo "Note: if you run terraform apply later, keep infra/terraform.tfvars SEARCH_* in sync."