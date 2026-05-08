from __future__ import annotations

from typing import Any, Dict, List

from ..base import SearchStoreProvider
from ...search import (
    delete_search_chunks_for_document,
    list_search_document_groups,
    upsert_search_chunks,
)
from ...config import search_enabled


class AzureSearchStoreProvider(SearchStoreProvider):
    def upsert_chunks(
        self,
        tenant_id: str,
        document_id: str,
        blob_name: str,
        file_name: str,
        chunks: List[str],
    ) -> None:
        upsert_search_chunks(tenant_id, document_id, blob_name, file_name, chunks)

    def delete_chunks_for_document(self, document_id: str, tenant_id: str) -> int:
        return delete_search_chunks_for_document(document_id, tenant_id)

    def list_document_groups(self, tenant_id: str) -> List[Dict[str, Any]]:
        return list_search_document_groups(tenant_id)

    def is_configured(self) -> bool:
        return search_enabled()
