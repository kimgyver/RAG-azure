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

SKU="${2:-free}"
SEARCH_RG="${SEARCH_RG:-apim-lab-rg}"
INDEX_NAME="${SEARCH_INDEX_NAME:-rag-chunks}"

if [[ "$SKU" != "free" && "$SKU" != "basic" ]]; then
  echo "SKU must be 'free' or 'basic'. Received: $SKU" >&2
  exit 1
fi

FUNCTION_APP_NAME="$(terraform -chdir="$INFRA_DIR" output -raw function_app_name)"
FUNCTION_RG="$(terraform -chdir="$INFRA_DIR" output -raw resource_group_name)"
LOCATION="$(az functionapp show --name "$FUNCTION_APP_NAME" --resource-group "$FUNCTION_RG" --query location -o tsv)"

CURRENT_ENDPOINT="$(az functionapp config appsettings list --name "$FUNCTION_APP_NAME" --resource-group "$FUNCTION_RG" --query "[?name=='SEARCH_ENDPOINT'].value | [0]" -o tsv || true)"
CURRENT_HOST="${CURRENT_ENDPOINT#https://}"
CURRENT_HOST="${CURRENT_HOST%%.*}"
SERVICE_NAME="${1:-${CURRENT_HOST:-rag-search-free-ondemand}}"

echo "Creating or reusing search service"
echo "  name: $SERVICE_NAME"
echo "  sku: $SKU"
echo "  rg: $SEARCH_RG"
echo "  location: $LOCATION"

if ! az search service show --name "$SERVICE_NAME" --resource-group "$SEARCH_RG" >/dev/null 2>&1; then
  az search service create \
    --name "$SERVICE_NAME" \
    --resource-group "$SEARCH_RG" \
    --sku "$SKU" \
    --location "$LOCATION" \
    --output none
fi

SEARCH_ENDPOINT="$(az search service show --name "$SERVICE_NAME" --resource-group "$SEARCH_RG" --query endpoint -o tsv)"
SEARCH_KEY="$(az search admin-key show --service-name "$SERVICE_NAME" --resource-group "$SEARCH_RG" --query primaryKey -o tsv)"

az functionapp config appsettings set \
  --name "$FUNCTION_APP_NAME" \
  --resource-group "$FUNCTION_RG" \
  --settings \
    SEARCH_ENABLED=true \
    SEARCH_ENDPOINT="$SEARCH_ENDPOINT" \
    SEARCH_API_KEY="$SEARCH_KEY" \
    SEARCH_INDEX_NAME="$INDEX_NAME" \
  --output none

echo "Search enabled for Function App"
echo "  functionApp: $FUNCTION_APP_NAME"
echo "  endpoint: $SEARCH_ENDPOINT"
echo "  index: $INDEX_NAME"
echo
echo "Note: if you run terraform apply later, keep infra/terraform.tfvars SEARCH_* in sync."