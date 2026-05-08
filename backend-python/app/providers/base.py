from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class StorageProvider(ABC):
    @abstractmethod
    def build_upload_blob_name(self, tenant_id: str, document_id: str, file_name: str) -> str: ...

    @abstractmethod
    def create_upload_url(
        self,
        blob_name: str,
        container_name: str,
        expiry_minutes: int,
        content_type: Optional[str],
    ) -> str:
        """Return a pre-signed/SAS URL for direct client upload."""
        ...

    @abstractmethod
    def download_blob(self, container_name: str, blob_name: str) -> bytes: ...

    @abstractmethod
    def get_blob_content_type(self, container_name: str, blob_name: str) -> Optional[str]: ...

    @abstractmethod
    def delete_blob(self, container_name: str, blob_name: str) -> None: ...


class DocumentStoreProvider(ABC):
    @abstractmethod
    def upsert(self, update: Dict[str, Any]) -> None: ...

    @abstractmethod
    def get(self, document_id: str, tenant_id: str) -> Optional[Dict[str, Any]]: ...

    @abstractmethod
    def list_by_tenant(self, tenant_id: str, max_items: int = 200) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def delete(self, document_id: str, tenant_id: str) -> bool: ...


class SearchStoreProvider(ABC):
    @abstractmethod
    def upsert_chunks(
        self,
        tenant_id: str,
        document_id: str,
        blob_name: str,
        file_name: str,
        chunks: List[str],
    ) -> None: ...

    @abstractmethod
    def delete_chunks_for_document(self, document_id: str, tenant_id: str) -> int: ...

    @abstractmethod
    def list_document_groups(self, tenant_id: str) -> List[Dict[str, Any]]: ...

    @abstractmethod
    def is_configured(self) -> bool: ...


class OcrProvider(ABC):
    @abstractmethod
    def extract_text(self, content: bytes, content_type: Optional[str]) -> str: ...

    @abstractmethod
    def is_configured(self) -> bool: ...
