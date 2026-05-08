from __future__ import annotations

from typing import Optional

from ..base import StorageProvider
from ...storage import (
    build_upload_blob_name as _build_blob_name,
    create_upload_sas_url as _create_sas_url,
    get_blob_service_client,
    sanitize_file_name,
)
import os


class AzureStorageProvider(StorageProvider):
    def build_upload_blob_name(self, tenant_id: str, document_id: str, file_name: str) -> str:
        return _build_blob_name(tenant_id, document_id, file_name)

    def create_upload_url(
        self,
        blob_name: str,
        container_name: str,
        expiry_minutes: int,
        content_type: Optional[str],
    ) -> str:
        account_name = os.getenv("AZURE_STORAGE_ACCOUNT_NAME", "").strip()
        account_key = os.getenv("AZURE_STORAGE_ACCOUNT_KEY", "").strip()
        blob_endpoint = os.getenv("AZURE_STORAGE_BLOB_ENDPOINT", "").strip()
        return _create_sas_url(
            account_name=account_name,
            account_key=account_key,
            container_name=container_name,
            blob_name=blob_name,
            expiry_minutes=expiry_minutes,
            content_type=content_type,
            blob_endpoint=blob_endpoint,
        )

    def download_blob(self, container_name: str, blob_name: str) -> bytes:
        client = get_blob_service_client()
        return client.get_container_client(container_name).get_blob_client(blob_name).download_blob().readall()

    def get_blob_content_type(self, container_name: str, blob_name: str) -> Optional[str]:
        client = get_blob_service_client()
        blob_client = client.get_container_client(container_name).get_blob_client(blob_name)
        props = blob_client.get_blob_properties()
        return props.content_settings.content_type if props and props.content_settings else None

    def delete_blob(self, container_name: str, blob_name: str) -> None:
        client = get_blob_service_client()
        client.get_container_client(container_name).get_blob_client(blob_name).delete_blob()
