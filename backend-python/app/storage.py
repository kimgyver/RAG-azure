from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas

_BLOB_SERVICE_CLIENT: Optional[BlobServiceClient] = None


def get_blob_service_client() -> BlobServiceClient:
    global _BLOB_SERVICE_CLIENT

    if _BLOB_SERVICE_CLIENT is not None:
        return _BLOB_SERVICE_CLIENT

    account_name = os.getenv("AZURE_STORAGE_ACCOUNT_NAME", "").strip()
    account_key = os.getenv("AZURE_STORAGE_ACCOUNT_KEY", "").strip()
    blob_endpoint = os.getenv("AZURE_STORAGE_BLOB_ENDPOINT", "").strip()

    if not account_name or not account_key:
        raise RuntimeError("AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY are required")

    account_url = blob_endpoint or "https://{0}.blob.core.windows.net".format(account_name)
    _BLOB_SERVICE_CLIENT = BlobServiceClient(account_url=account_url, credential=account_key)
    return _BLOB_SERVICE_CLIENT


def sanitize_file_name(file_name: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9._-]", "-", file_name.strip())
    sanitized = re.sub(r"-+", "-", sanitized).strip("-")
    return sanitized[:120] or "upload.bin"


def build_upload_blob_name(tenant_id: str, document_id: str, file_name: str) -> str:
    date_folder = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    return "{0}/{1}/{2}-{3}".format(tenant_id, date_folder, document_id, sanitize_file_name(file_name))


def create_upload_sas_url(
    account_name: str,
    account_key: str,
    container_name: str,
    blob_name: str,
    expiry_minutes: int,
    content_type: Optional[str],
    blob_endpoint: Optional[str],
) -> str:
    starts_on = datetime.now(timezone.utc) - timedelta(minutes=5)
    expires_on = datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes)
    protocol = "https,http" if (blob_endpoint or "").startswith("http://") else "https"
    sas_token = generate_blob_sas(
        account_name=account_name,
        account_key=account_key,
        container_name=container_name,
        blob_name=blob_name,
        permission=BlobSasPermissions(create=True, write=True),
        start=starts_on,
        expiry=expires_on,
        content_type=content_type,
        protocol=protocol,
        version="2020-12-06",
    )
    base_endpoint = (blob_endpoint or "https://{0}.blob.core.windows.net".format(account_name)).rstrip("/")
    return "{0}/{1}/{2}?{3}".format(base_endpoint, container_name, quote(blob_name, safe="/"), sas_token)


def is_text_blob(blob_name: str, content_type: Optional[str]) -> bool:
    lower_name = blob_name.lower()
    lower_type = (content_type or "").lower()
    if lower_type.startswith("text/"):
        return True
    return any(lower_name.endswith(ext) for ext in (".txt", ".md", ".csv", ".json"))


def is_pdf_blob(blob_name: str, content_type: Optional[str]) -> bool:
    return (content_type or "").lower() == "application/pdf" or blob_name.lower().endswith(".pdf")


def is_image_blob(blob_name: str, content_type: Optional[str]) -> bool:
    lower_name = blob_name.lower()
    lower_type = (content_type or "").lower()
    if lower_type.startswith("image/") and "svg" not in lower_type and lower_type != "image/heic":
        return True
    return any(lower_name.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"))
