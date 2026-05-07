from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

try:
    from dotenv import load_dotenv
except Exception:
    load_dotenv = None  # type: ignore

if load_dotenv is not None:
    load_dotenv()

try:
    from openai import OpenAI
except Exception:
    OpenAI = None  # type: ignore

from .config import (
    allowed_tenants,
    bool_env,
    cosmos_enabled,
    get_required_env,
    search_enabled,
    utc_now_iso,
    validate_tenant_id,
)
from .models import (
    ChatRequest,
    ChunkRecord,
    CreateTextKnowledgeRequest,
    CreateUploadRequest,
    DocumentRecord,
    CHUNKS_BY_TENANT,
    DOCS_BY_TENANT,
)
from .cosmos import (
    delete_document_metadata,
    get_document_metadata,
    list_documents_by_tenant,
    upsert_document_metadata,
)
from .storage import build_upload_blob_name, create_upload_sas_url
from .search import (
    delete_search_chunks_for_document,
    list_search_document_groups,
    upsert_search_chunks,
)
from .document_processor import (
    chunk_text,
    hydrate_indexed_documents_for_tenant,
    process_queued_document,
    process_queued_documents_for_tenant,
    tokenize,
)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="RAG Azure Python Backend", version="0.1.0")

cors_origins = [
    item.strip()
    for item in os.getenv(
        "CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if item.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# LLM helper
# ---------------------------------------------------------------------------

def llm_answer(question: str, snippets: List[str]) -> Optional[str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key or OpenAI is None:
        return None
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
    client = OpenAI(api_key=api_key)
    context = "\n\n".join(snippets[:5])
    prompt = (
        "You are a RAG assistant. Answer using only the provided context. "
        "If context is insufficient, say so briefly.\n\n"
        f"Question: {question}\n\nContext:\n{context}"
    )
    response = client.responses.create(model=model, input=prompt, max_output_tokens=350)
    return response.output_text.strip() if getattr(response, "output_text", "") else None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/flags/deployment")
def flags_deployment() -> Dict[str, Any]:
    return {
        "cosmosDbEnabled": cosmos_enabled(),
        "searchEnabled": search_enabled(),
        "embeddingPipelineEnabled": bool_env("EMBEDDING_ENABLED", False),
        "chatSearchMode": os.getenv("CHAT_SEARCH_MODE", "keyword").strip().lower() or "keyword",
        "ocrEnabled": bool_env("OCR_ENABLED", False),
        "openAiChatConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "tenantAllowlistActive": bool(allowed_tenants()),
    }


@app.get("/api/documents/catalog")
def list_document_catalog(tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not cosmos_enabled() and not search_enabled():
        raise HTTPException(503, "Cosmos DB and Azure AI Search are both disabled.")

    process_queued_documents_for_tenant(tenantId)
    hydrate_indexed_documents_for_tenant(tenantId)

    by_id: Dict[str, Dict[str, Any]] = {}

    if cosmos_enabled():
        for c in list_documents_by_tenant(tenantId, 200):
            doc_id = c.get("documentId") or c.get("id")
            if not doc_id:
                continue
            by_id[doc_id] = {
                "documentId": doc_id,
                "tenantId": c.get("tenantId") or tenantId,
                "fileName": (c.get("blobName") or "").split("/")[-1] or doc_id,
                "blobName": c.get("blobName") or "",
                "cosmos": {
                    "status": c.get("status"),
                    "updatedAt": c.get("updatedAt"),
                    "chunkCount": c.get("chunkCount"),
                    "contentType": c.get("contentType"),
                    "sourceType": c.get("sourceType"),
                    "hasSourceText": bool((c.get("sourceText") or "").strip()),
                },
                "search": None,
            }

    if search_enabled():
        for doc_id, search_doc in list_search_document_groups(tenantId).items():
            row = by_id.get(doc_id)
            if row:
                row["search"] = search_doc
                if not row.get("fileName"):
                    row["fileName"] = search_doc["fileName"]
                if not row.get("blobName"):
                    row["blobName"] = search_doc["blobName"]
            else:
                by_id[doc_id] = {
                    "documentId": doc_id,
                    "tenantId": tenantId,
                    "fileName": search_doc["fileName"] or doc_id,
                    "blobName": search_doc["blobName"],
                    "cosmos": None,
                    "search": search_doc,
                }

    documents = sorted(
        by_id.values(),
        key=lambda r: ((r.get("cosmos") or {}).get("updatedAt") or "", r.get("documentId") or ""),
        reverse=True,
    )
    return {
        "tenantId": tenantId,
        "documents": documents,
        "sources": {"cosmos": cosmos_enabled(), "search": search_enabled()},
    }


@app.post("/api/knowledge/text")
def create_text_knowledge(payload: CreateTextKnowledgeRequest) -> Dict[str, Any]:
    validate_tenant_id(payload.tenantId)
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text must not be empty")
    chunks = chunk_text(text)
    if not chunks:
        raise HTTPException(400, "text is too short to index")

    now = utc_now_iso()
    doc_id = str(uuid4())
    title = (payload.title or "manual-note").strip() or "manual-note"
    file_name = title if title.endswith(".txt") else f"{title}.txt"
    blob_name = f"manual/{payload.tenantId}/{doc_id}.txt"

    DOCS_BY_TENANT[payload.tenantId][doc_id] = DocumentRecord(
        id=doc_id, documentId=doc_id, tenantId=payload.tenantId,
        blobName=blob_name, fileName=file_name, status="indexed",
        sourceText=text, contentLength=len(text), chunkCount=len(chunks),
        createdAt=now, updatedAt=now, contentType="text/plain",
    )

    if cosmos_enabled():
        upsert_document_metadata({
            "documentId": doc_id, "tenantId": payload.tenantId,
            "blobName": blob_name, "status": "indexed",
            "contentType": "text/plain", "contentLength": len(text),
            "chunkCount": len(chunks), "sourceType": "text", "sourceText": text,
        })

    CHUNKS_BY_TENANT[payload.tenantId] = [
        c for c in CHUNKS_BY_TENANT[payload.tenantId] if c.documentId != doc_id
    ]
    for idx, chunk in enumerate(chunks):
        CHUNKS_BY_TENANT[payload.tenantId].append(
            ChunkRecord(
                id=f"{doc_id}-{idx}", tenantId=payload.tenantId, documentId=doc_id,
                blobName=blob_name, fileName=file_name, chunkIndex=idx, content=chunk,
            )
        )

    if search_enabled():
        upsert_search_chunks(payload.tenantId, doc_id, blob_name, file_name, chunks)

    return {
        "documentId": doc_id, "tenantId": payload.tenantId,
        "blobName": blob_name, "fileName": file_name,
        "contentLength": len(text), "chunkCount": len(chunks),
        "indexed": True, "status": "indexed",
    }


@app.get("/api/documents/{document_id}")
def get_document_status(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not cosmos_enabled():
        raise HTTPException(503, "Cosmos DB status store is disabled.")
    record = get_document_metadata(document_id, tenantId)
    if not record:
        raise HTTPException(404, "Document status not found.")
    process_queued_document(record)
    return get_document_metadata(document_id, tenantId) or record


@app.get("/api/documents/{document_id}/source")
def get_document_source(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not cosmos_enabled():
        raise HTTPException(503, "Cosmos DB is disabled.")
    record = get_document_metadata(document_id, tenantId)
    if not record:
        raise HTTPException(404, "Document metadata not found.")
    source_text = (record.get("sourceText") or "").strip()
    if not source_text:
        raise HTTPException(404, "Source text is not stored for this document.")
    return {
        "documentId": record.get("documentId") or record.get("id"),
        "tenantId": record.get("tenantId") or tenantId,
        "fileName": (record.get("blobName") or "").split("/")[-1] or document_id,
        "sourceType": record.get("sourceType") or "unknown",
        "sourceText": source_text,
        "updatedAt": record.get("updatedAt"),
    }


@app.delete("/api/documents/{document_id}/purge")
def purge_document(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not cosmos_enabled() and not search_enabled():
        raise HTTPException(503, "Cosmos DB and Azure AI Search are both disabled.")

    DOCS_BY_TENANT.get(tenantId, {}).pop(document_id, None)
    before = len(CHUNKS_BY_TENANT.get(tenantId, []))
    CHUNKS_BY_TENANT[tenantId] = [
        c for c in CHUNKS_BY_TENANT.get(tenantId, []) if c.documentId != document_id
    ]
    deleted = before - len(CHUNKS_BY_TENANT.get(tenantId, []))

    if search_enabled():
        deleted += delete_search_chunks_for_document(document_id, tenantId)

    cosmos_deleted = delete_document_metadata(document_id, tenantId) if cosmos_enabled() else False

    if deleted == 0 and not cosmos_deleted:
        raise HTTPException(404, "Document not found.")

    return {
        "documentId": document_id, "tenantId": tenantId,
        "deletedSearchChunks": deleted, "remainingSearchChunks": 0,
        "cosmosDeleted": cosmos_deleted,
        "note": "Blob 원본은 삭제하지 않았습니다. 스토리지에서 직접 지우세요.",
    }


@app.post("/api/chat")
def chat(payload: ChatRequest) -> Dict[str, Any]:
    validate_tenant_id(payload.tenantId)
    hydrate_indexed_documents_for_tenant(payload.tenantId)

    question = payload.question.strip()
    if not question:
        raise HTTPException(400, "question must not be empty")

    tokens = tokenize(question)
    scored: List[Tuple[int, ChunkRecord]] = [
        (len(tokens.intersection(tokenize(c.content))), c)
        for c in CHUNKS_BY_TENANT.get(payload.tenantId, [])
        if tokens.intersection(tokenize(c.content))
    ]
    scored.sort(key=lambda x: x[0], reverse=True)

    citations, snippets = [], []
    for score, chunk in scored[:5]:
        snippet = chunk.content[:280]
        snippets.append(snippet)
        citations.append({
            "documentId": chunk.documentId, "fileName": chunk.fileName,
            "blobName": chunk.blobName, "chunkIndex": chunk.chunkIndex,
            "snippet": snippet, "score": score,
        })

    fallback = (
        "I could not find matching tenant-scoped knowledge yet. Register text first, then ask again."
        if not snippets
        else "\n\n".join(["Based on tenant knowledge:", *snippets[:3]])
    )

    return {
        "answer": (llm_answer(question, snippets) if snippets else None) or fallback,
        "citations": citations,
        "usage": {"tenantId": payload.tenantId, "retrievedChunks": len(citations)},
        "memory": {
            "sessionId": payload.sessionId or f"py-{payload.tenantId}",
            "summary": (payload.summaryMemory or "")[:1000],
            "recentTurnsUsed": min(len(payload.messages or []), 12),
        },
    }


@app.post("/api/uploads/create")
def create_upload(payload: CreateUploadRequest) -> Dict[str, Any]:
    validate_tenant_id(payload.tenantId)
    tenant_id = payload.tenantId.strip()
    file_name = payload.fileName.strip()
    if not tenant_id:
        raise HTTPException(400, "tenantId is required.")
    if not file_name:
        raise HTTPException(400, "fileName is required.")

    try:
        account_name = get_required_env("AZURE_STORAGE_ACCOUNT_NAME")
        account_key = get_required_env("AZURE_STORAGE_ACCOUNT_KEY")
        blob_endpoint = os.getenv("AZURE_STORAGE_BLOB_ENDPOINT", "").strip() or None
        container_name = os.getenv("AZURE_STORAGE_CONTAINER_NAME", "uploads").strip() or "uploads"
        expiry_minutes = int(os.getenv("SAS_EXPIRY_MINUTES", "15").strip() or "15")
    except ValueError:
        raise HTTPException(400, "SAS_EXPIRY_MINUTES must be a positive number.")
    except RuntimeError:
        raise HTTPException(500, "Failed to create upload URL.")

    if expiry_minutes <= 0:
        raise HTTPException(400, "SAS_EXPIRY_MINUTES must be a positive number.")

    doc_id = str(uuid4())
    blob_name = build_upload_blob_name(tenant_id, doc_id, file_name)

    try:
        upload_url = create_upload_sas_url(
            account_name=account_name, account_key=account_key,
            container_name=container_name, blob_name=blob_name,
            expiry_minutes=expiry_minutes,
            content_type=(payload.contentType or "").strip() or None,
            blob_endpoint=blob_endpoint,
        )
    except Exception:
        raise HTTPException(500, "Failed to create upload URL.")

    now = utc_now_iso()
    DOCS_BY_TENANT[tenant_id][doc_id] = DocumentRecord(
        id=doc_id, documentId=doc_id, tenantId=tenant_id,
        blobName=blob_name, fileName=file_name, status="queued",
        sourceText="", sourceType="blob",
        contentType=(payload.contentType or "").strip() or None,
        contentLength=0, chunkCount=0, createdAt=now, updatedAt=now,
    )

    if cosmos_enabled():
        upsert_document_metadata({
            "documentId": doc_id, "tenantId": tenant_id,
            "blobName": blob_name, "status": "queued",
            "contentType": (payload.contentType or "").strip() or None,
        })

    return {
        "documentId": doc_id, "tenantId": tenant_id,
        "blobName": blob_name, "uploadUrl": upload_url,
        "expiresInMinutes": expiry_minutes,
    }
