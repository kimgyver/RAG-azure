from __future__ import annotations

import os
import re
from io import BytesIO
from typing import Any, Dict, List, Optional, Set

from azure.core.exceptions import ResourceNotFoundError

try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover
    PdfReader = None  # type: ignore

from .config import cosmos_enabled, search_enabled, utc_now_iso
from .models import ChunkRecord, DocumentRecord, CHUNKS_BY_TENANT, DOCS_BY_TENANT
from .cosmos import list_documents_by_tenant, upsert_document_metadata
from .storage import get_blob_service_client, is_image_blob, is_pdf_blob, is_text_blob
from .search import upsert_search_chunks
from .ocr import extract_ocr_text, ocr_service_configured


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

def tokenize(text: str) -> Set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def chunk_text(text: str, size: int = 900, overlap: int = 120) -> List[str]:
    clean = text.strip()
    if not clean:
        return []
    chunks: List[str] = []
    start = 0
    while start < len(clean):
        end = min(start + size, len(clean))
        chunks.append(clean[start:end])
        if end >= len(clean):
            break
        start = max(0, end - overlap)
    return chunks


def extract_pdf_text(content: bytes) -> str:
    if PdfReader is None:
        return ""
    try:
        reader = PdfReader(BytesIO(content))
        texts: List[str] = []
        for page in reader.pages:
            page_text = (page.extract_text() or "").strip()
            if page_text:
                texts.append(page_text)
        return "\n\n".join(texts).strip()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# In-memory index management
# ---------------------------------------------------------------------------

def upsert_local_index(
    tenant_id: str,
    document_id: str,
    blob_name: str,
    file_name: str,
    text: str,
    content_type: Optional[str],
    source_type: str,
    created_at: Optional[str] = None,
    write_to_search: bool = False,
) -> int:
    """Chunk text, optionally write to Azure AI Search, and update the in-memory cache."""
    chunks = chunk_text(text)

    # Write to Azure Search only for new indexing — not on hydration (read-only reload)
    if write_to_search and search_enabled():
        upsert_search_chunks(tenant_id, document_id, blob_name, file_name, chunks)

    # Refresh in-memory chunk list for this document
    CHUNKS_BY_TENANT[tenant_id] = [
        c for c in CHUNKS_BY_TENANT.get(tenant_id, []) if c.documentId != document_id
    ]
    for idx, chunk in enumerate(chunks):
        CHUNKS_BY_TENANT[tenant_id].append(
            ChunkRecord(
                id=f"{document_id}-{idx}",
                tenantId=tenant_id,
                documentId=document_id,
                blobName=blob_name,
                fileName=file_name,
                chunkIndex=idx,
                content=chunk,
            )
        )

    now = utc_now_iso()
    DOCS_BY_TENANT[tenant_id][document_id] = DocumentRecord(
        id=document_id,
        documentId=document_id,
        tenantId=tenant_id,
        blobName=blob_name,
        fileName=file_name,
        status="indexed",
        sourceText=text,
        sourceType=source_type,
        contentType=content_type,
        contentLength=len(text),
        chunkCount=len(chunks),
        createdAt=created_at or now,
        updatedAt=now,
    )
    return len(chunks)


# ---------------------------------------------------------------------------
# Document processing (blob → text → index)
# ---------------------------------------------------------------------------

def process_queued_document(record: Dict[str, Any]) -> bool:
    """Download a queued blob, extract text, chunk it, and write to index + Cosmos."""
    status = (record.get("status") or "").strip().lower()
    if status not in {"queued", "processing"}:
        return False

    tenant_id = (record.get("tenantId") or "").strip()
    document_id = (record.get("documentId") or record.get("id") or "").strip()
    blob_name = (record.get("blobName") or "").strip()

    if not tenant_id or not document_id or not blob_name:
        return False

    container_name = os.getenv("AZURE_STORAGE_CONTAINER_NAME", "uploads").strip() or "uploads"

    try:
        blob_service = get_blob_service_client()
        blob_client = blob_service.get_container_client(container_name).get_blob_client(blob_name)
        props = blob_client.get_blob_properties()
        content_type = props.content_settings.content_type if props and props.content_settings else None
    except ResourceNotFoundError:
        return False  # upload not yet complete
    except Exception:
        return False

    if not is_text_blob(blob_name, content_type) and not is_pdf_blob(blob_name, content_type) and not is_image_blob(blob_name, content_type):
        upsert_document_metadata({
            "documentId": document_id,
            "tenantId": tenant_id,
            "blobName": blob_name,
            "status": "skipped",
            "contentType": content_type,
            "errorMessage": "Unsupported document type for Python local worker.",
        })
        return True

    source_type = "text"
    try:
        content = blob_client.download_blob().readall()
        if is_pdf_blob(blob_name, content_type):
            source_type = "pdf"
            text = extract_pdf_text(content)
            if not text:
                source_type = "pdf-ocr"
                text = extract_ocr_text(content, content_type)
        elif is_image_blob(blob_name, content_type):
            source_type = "image-ocr"
            text = extract_ocr_text(content, content_type)
        else:
            text = content.decode("utf-8", errors="ignore").strip()
    except Exception:
        upsert_document_metadata({
            "documentId": document_id,
            "tenantId": tenant_id,
            "blobName": blob_name,
            "status": "failed",
            "contentType": content_type,
            "errorMessage": "Failed to download or decode blob content.",
        })
        return True

    if not text:
        error_message = "No extractable text found in document."
        if is_image_blob(blob_name, content_type) and not ocr_service_configured():
            error_message = "OCR service is not configured for image documents."
        upsert_document_metadata({
            "documentId": document_id,
            "tenantId": tenant_id,
            "blobName": blob_name,
            "status": "failed",
            "contentType": content_type,
            "errorMessage": error_message,
        })
        return True

    file_name = blob_name.split("/")[-1] or document_id
    chunk_count = upsert_local_index(
        tenant_id=tenant_id,
        document_id=document_id,
        blob_name=blob_name,
        file_name=file_name,
        text=text,
        content_type=content_type,
        source_type=source_type,
        created_at=record.get("createdAt"),
        write_to_search=True,
    )
    upsert_document_metadata({
        "documentId": document_id,
        "tenantId": tenant_id,
        "blobName": blob_name,
        "status": "indexed",
        "contentType": content_type,
        "contentLength": len(text),
        "chunkCount": chunk_count,
        "sourceType": source_type,
        "sourceText": text,
    })
    return True


def process_queued_documents_for_tenant(tenant_id: str) -> None:
    if not cosmos_enabled():
        return
    for doc in list_documents_by_tenant(tenant_id, 300):
        process_queued_document(doc)


def hydrate_indexed_documents_for_tenant(tenant_id: str) -> None:
    """Reload already-indexed documents from Cosmos into the in-memory cache (no Search writes)."""
    if not cosmos_enabled():
        return
    already_indexed: Set[str] = {c.documentId for c in CHUNKS_BY_TENANT.get(tenant_id, [])}
    for doc in list_documents_by_tenant(tenant_id, 300):
        document_id = (doc.get("documentId") or doc.get("id") or "").strip()
        status = (doc.get("status") or "").strip().lower()
        source_text = (doc.get("sourceText") or "").strip()
        if not document_id or document_id in already_indexed:
            continue
        if status not in {"indexed", "chunked"}:
            continue
        if not source_text:
            continue
        blob_name = (doc.get("blobName") or "").strip()
        upsert_local_index(
            tenant_id=tenant_id,
            document_id=document_id,
            blob_name=blob_name,
            file_name=blob_name.split("/")[-1] or document_id,
            text=source_text,
            content_type=doc.get("contentType"),
            source_type=(doc.get("sourceType") or "unknown"),
            created_at=doc.get("createdAt"),
            write_to_search=False,  # hydration must not overwrite Search
        )
        already_indexed.add(document_id)
