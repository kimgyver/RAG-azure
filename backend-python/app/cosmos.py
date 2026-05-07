from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from azure.cosmos import CosmosClient

from .config import cosmos_enabled, utc_now_iso

_COSMOS_CLIENT: Optional[CosmosClient] = None
_COSMOS_CONTAINER: Any = None


def _get_cosmos_config() -> Dict[str, str]:
    return {
        "endpoint": os.getenv("COSMOS_ENDPOINT", "").strip(),
        "key": os.getenv("COSMOS_KEY", "").strip(),
        "database_id": os.getenv("COSMOS_DATABASE_ID", "rag-db").strip(),
        "container_id": os.getenv("COSMOS_DOCUMENTS_CONTAINER_ID", "documents").strip(),
    }


def get_cosmos_container() -> Any:
    global _COSMOS_CLIENT, _COSMOS_CONTAINER

    if _COSMOS_CONTAINER is not None:
        return _COSMOS_CONTAINER

    cfg = _get_cosmos_config()
    if not (cfg["endpoint"] and cfg["key"]):
        raise RuntimeError("COSMOS_ENDPOINT and COSMOS_KEY are required when COSMOS_DB_ENABLED=true")

    _COSMOS_CLIENT = CosmosClient(url=cfg["endpoint"], credential=cfg["key"])
    database = _COSMOS_CLIENT.create_database_if_not_exists(id=cfg["database_id"])
    _COSMOS_CONTAINER = database.create_container_if_not_exists(
        id=cfg["container_id"],
        partition_key={"paths": ["/tenantId"], "kind": "Hash"},
    )
    return _COSMOS_CONTAINER


def upsert_document_metadata(update: Dict[str, Any]) -> None:
    if not cosmos_enabled():
        return
    try:
        container = get_cosmos_container()
        document_id = update["documentId"]
        tenant_id = update["tenantId"]
        now = utc_now_iso()

        existing = None
        try:
            existing = container.read_item(item=document_id, partition_key=tenant_id)
        except Exception:
            existing = None

        record = {
            "id": document_id,
            "documentId": document_id,
            "tenantId": tenant_id,
            "blobName": update["blobName"],
            "status": update["status"],
            "contentType": update.get("contentType") or (existing or {}).get("contentType"),
            "contentLength": update.get("contentLength") if update.get("contentLength") is not None else (existing or {}).get("contentLength"),
            "chunkCount": update.get("chunkCount") if update.get("chunkCount") is not None else (existing or {}).get("chunkCount"),
            "errorMessage": update.get("errorMessage") or (existing or {}).get("errorMessage"),
            "sourceType": update.get("sourceType") or (existing or {}).get("sourceType"),
            "sourceText": update.get("sourceText") if update.get("sourceText") is not None else (existing or {}).get("sourceText"),
            "createdAt": (existing or {}).get("createdAt") or now,
            "updatedAt": now,
        }
        container.upsert_item(record)
    except Exception:
        return


def get_document_metadata(document_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
    if not cosmos_enabled():
        return None
    try:
        container = get_cosmos_container()
        return container.read_item(item=document_id, partition_key=tenant_id)
    except Exception:
        return None


def list_documents_by_tenant(tenant_id: str, max_items: int = 200) -> List[Dict[str, Any]]:
    if not cosmos_enabled():
        return []
    try:
        container = get_cosmos_container()
        items = list(
            container.query_items(
                query="SELECT * FROM c",
                partition_key=tenant_id,
                enable_cross_partition_query=False,
            )
        )
        items.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
        return items[:max_items]
    except Exception:
        return []


def delete_document_metadata(document_id: str, tenant_id: str) -> bool:
    if not cosmos_enabled():
        return False
    try:
        container = get_cosmos_container()
        container.delete_item(item=document_id, partition_key=tenant_id)
        return True
    except Exception:
        return False
