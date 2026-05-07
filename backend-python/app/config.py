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
