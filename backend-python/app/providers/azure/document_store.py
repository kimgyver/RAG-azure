from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..base import DocumentStoreProvider
from ...cosmos import (
    delete_document_metadata,
    get_document_metadata,
    list_documents_by_tenant,
    upsert_document_metadata,
)


class AzureDocumentStoreProvider(DocumentStoreProvider):
    def upsert(self, update: Dict[str, Any]) -> None:
        upsert_document_metadata(update)

    def get(self, document_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return get_document_metadata(document_id, tenant_id)

    def list_by_tenant(self, tenant_id: str, max_items: int = 200) -> List[Dict[str, Any]]:
        return list_documents_by_tenant(tenant_id, max_items)

    def delete(self, document_id: str, tenant_id: str) -> bool:
        return delete_document_metadata(document_id, tenant_id)
