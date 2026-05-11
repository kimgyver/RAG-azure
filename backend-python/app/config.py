from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Set

from fastapi import HTTPException


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def allowed_tenants() -> Set[str]:
    raw = os.getenv("ALLOWED_TENANT_IDS", "").strip()
    if not raw:
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def validate_tenant_id(tenant_id: str) -> None:
    allowlist = allowed_tenants()
    if allowlist and tenant_id not in allowlist:
        raise HTTPException(status_code=403, detail="tenantId is not allowed")


def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError("Missing required environment variable: {0}".format(name))
    return value


def cosmos_enabled() -> bool:
    return bool_env("COSMOS_DB_ENABLED", False)


def search_enabled() -> bool:
    return bool_env("SEARCH_ENABLED", False)


def ocr_enabled() -> bool:
    return bool_env("OCR_ENABLED", False)


def cloud_provider() -> str:
    """Return the active cloud provider: 'azure' (default) or 'aws'."""
    return os.getenv("CLOUD_PROVIDER", "azure").strip().lower()


def storage_container_name() -> str:
    """Return the active blob container or S3 bucket name for the current cloud."""
    if cloud_provider() == "aws":
        return os.getenv("S3_BUCKET_NAME", "uploads").strip() or "uploads"
    return os.getenv("AZURE_STORAGE_CONTAINER_NAME", "uploads").strip() or "uploads"


def active_search_enabled() -> bool:
    """Return the active search flag for the current cloud."""
    if cloud_provider() == "aws":
        return aws_search_enabled()
    return search_enabled()


def persistent_store_enabled() -> bool:
    """True when a persistent document-metadata store is available.
    Azure: Cosmos DB (COSMOS_DB_ENABLED=true)
    AWS:   DynamoDB (always available when CLOUD_PROVIDER=aws)
    """
    return cosmos_enabled() or cloud_provider() == "aws"


def aws_search_enabled() -> bool:
    """True when OpenSearch/search is available in AWS.
    Defaults to True if OPENSEARCH_ENDPOINT is present, unless explicitly disabled.
    """
    endpoint = os.getenv("OPENSEARCH_ENDPOINT", "").strip()
    if not endpoint:
        return False
    
    search_enabled_env = os.getenv("SEARCH_ENABLED", "").strip().lower()
    if search_enabled_env == "false":
        return False
    
    return bool(endpoint)
