from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Dict, List, Tuple
from urllib.parse import quote

from .models import CHUNKS_BY_TENANT


def _search_config() -> Tuple[str, str, str]:
    endpoint = os.getenv("SEARCH_ENDPOINT", "").strip().rstrip("/")
    api_key = os.getenv("SEARCH_API_KEY", "").strip()
    index_name = os.getenv("SEARCH_INDEX_NAME", "rag-chunks").strip()
    return endpoint, api_key, index_name


def upsert_search_chunks(
    tenant_id: str,
    document_id: str,
    blob_name: str,
    file_name: str,
    chunks: List[str],
) -> None:
    """Batch-upload chunks to Azure AI Search (mergeOrUpload). Best-effort."""
    endpoint, api_key, index_name = _search_config()
    if not endpoint or not api_key or not chunks:
        return

    api_version = "2023-11-01"
    batch_size = 500

    for start in range(0, len(chunks), batch_size):
        batch = chunks[start : start + batch_size]
        docs = [
            {
                "@search.action": "mergeOrUpload",
                "id": f"{document_id}-{start + idx}",
                "tenantId": tenant_id,
                "documentId": document_id,
                "blobName": blob_name,
                "fileName": file_name,
                "chunkIndex": start + idx,
                "content": content,
                "contentLength": len(content),
                "sourceType": "python-backend",
            }
            for idx, content in enumerate(batch)
        ]
        url = f"{endpoint}/indexes/{index_name}/docs/index?api-version={api_version}"
        req = urllib.request.Request(
            url,
            data=json.dumps({"value": docs}).encode("utf-8"),
            headers={"api-key": api_key, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
        except Exception:
            pass  # best-effort


def delete_search_chunks_for_document(document_id: str, tenant_id: str) -> int:
    """Delete all chunks for a document from Azure AI Search. Returns count deleted."""
    endpoint, api_key, index_name = _search_config()
    if not endpoint or not api_key:
        return 0

    safe_tenant = tenant_id.replace("'", "''")
    safe_doc = document_id.replace("'", "''")
    odata_filter = f"tenantId eq '{safe_tenant}' and documentId eq '{safe_doc}'"
    api_version = "2023-11-01"
    total_deleted = 0

    while True:
        params = (
            f"search=*"
            f"&$filter={quote(odata_filter)}"
            f"&$top=500&$select=id"
            f"&api-version={api_version}"
        )
        list_req = urllib.request.Request(
            f"{endpoint}/indexes/{index_name}/docs?{params}",
            headers={"api-key": api_key, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(list_req, timeout=15) as resp:
                data = json.loads(resp.read())
        except Exception:
            break

        hits = data.get("value", [])
        if not hits:
            break

        batch = {"value": [{"@search.action": "delete", "id": doc["id"]} for doc in hits]}
        del_req = urllib.request.Request(
            f"{endpoint}/indexes/{index_name}/docs/index?api-version={api_version}",
            data=json.dumps(batch).encode("utf-8"),
            headers={"api-key": api_key, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(del_req, timeout=15) as resp:
                resp.read()
        except Exception:
            break

        total_deleted += len(hits)
        if len(hits) < 500:
            break

    return total_deleted


def list_search_document_groups(tenant_id: str, max_chunks_to_scan: int = 4000) -> Dict[str, Dict[str, Any]]:
    """Return a dict of documentId → {chunkCount, fileName, blobName} from Azure AI Search."""
    endpoint, api_key, index_name = _search_config()

    if not endpoint or not api_key:
        # Fallback: count from in-memory cache
        groups: Dict[str, Dict[str, Any]] = {}
        for chunk in CHUNKS_BY_TENANT.get(tenant_id, []):
            entry = groups.get(chunk.documentId)
            if entry:
                entry["chunkCount"] += 1
            else:
                groups[chunk.documentId] = {
                    "chunkCount": 1,
                    "fileName": chunk.fileName,
                    "blobName": chunk.blobName,
                }
        return groups

    safe_tenant = tenant_id.replace("'", "''")
    odata_filter = f"tenantId eq '{safe_tenant}'"
    groups = {}
    scanned = 0
    skip = 0
    page_size = 1000
    api_version = "2023-11-01"

    while scanned < max_chunks_to_scan:
        take = min(page_size, max_chunks_to_scan - scanned)
        params = (
            f"search=*"
            f"&$filter={quote(odata_filter)}"
            f"&$top={take}&$skip={skip}"
            f"&$select=documentId,fileName,blobName"
            f"&api-version={api_version}"
        )
        req = urllib.request.Request(
            f"{endpoint}/indexes/{index_name}/docs?{params}",
            headers={"api-key": api_key, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except Exception:
            break

        hits = data.get("value", [])
        if not hits:
            break

        for doc in hits:
            did = (doc.get("documentId") or "").strip()
            if not did:
                continue
            entry = groups.get(did)
            if entry:
                entry["chunkCount"] += 1
            else:
                groups[did] = {
                    "chunkCount": 1,
                    "fileName": doc.get("fileName") or "",
                    "blobName": doc.get("blobName") or "",
                }

        scanned += len(hits)
        skip += len(hits)
        if len(hits) < take:
            break

    return groups
