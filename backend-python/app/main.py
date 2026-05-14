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
    active_search_enabled,
    allowed_tenants,
    aws_search_enabled,
    bool_env,
    cloud_provider,
    cosmos_enabled,
    get_required_env,
    persistent_store_enabled,
    search_enabled,
    storage_container_name,
    utc_now_iso,
    validate_tenant_id,
)
from .models import (
    ChatRequest,
    ChunkRecord,
    ConfirmUploadRequest,
    CreateTextKnowledgeRequest,
    CreateUploadRequest,
    DocumentRecord,
    CHUNKS_BY_TENANT,
    DOCS_BY_TENANT,
)
from .storage import build_upload_blob_name, create_upload_sas_url
from .document_processor import (
    chunk_text,
    hydrate_indexed_documents_for_tenant,
    process_queued_document,
    process_queued_documents_for_tenant,
    tokenize,
)
from .providers import get_document_store, get_search_store, get_storage_provider

document_store = get_document_store()
search_store = get_search_store()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="RAG Azure Python Backend", version="0.1.0")

cors_origins = [
    item.strip()
    for item in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
    ).split(",")
    if item.strip()
]
cors_origin_regex = os.getenv(
    "CORS_ALLOW_ORIGIN_REGEX",
    r"^https?://((localhost|127\.0\.0\.1)(:\\d+)?|.*\.azurestaticapps\.net)$",
).strip() or None

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
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
    
    try:
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
        client = OpenAI(api_key=api_key)
        context = "\n\n".join(snippets[:5])
        
        system_message = "You are a RAG assistant. Answer using only the provided context. If context is insufficient, say so briefly."
        
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": f"Question: {question}\n\nContext:\n{context}"}
            ],
            max_tokens=350,
            temperature=0.7
        )
        
        return response.choices[0].message.content.strip() if response.choices else None
    except Exception as e:
        import sys
        print(f"[llm_answer] OpenAI API error: {str(e)}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/flags/deployment")
def flags_deployment() -> Dict[str, Any]:
    return {
        "cosmosDbEnabled": persistent_store_enabled(),
        "searchEnabled": active_search_enabled(),
        "embeddingPipelineEnabled": bool_env("EMBEDDING_ENABLED", False),
        "chatSearchMode": os.getenv("CHAT_SEARCH_MODE", "keyword").strip().lower() or "keyword",
        "ocrEnabled": bool_env("OCR_ENABLED", False),
        "openAiChatConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "openAiModelConfigured": bool(os.getenv("OPENAI_MODEL", "").strip()),
        "tenantAllowlistActive": bool(allowed_tenants()),
    }


@app.get("/api/documents/catalog")
def list_document_catalog(tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not persistent_store_enabled() and not search_enabled() and not aws_search_enabled():
        raise HTTPException(503, "Document store and search are both disabled.")

    process_queued_documents_for_tenant(tenantId)
    hydrate_indexed_documents_for_tenant(tenantId)

    by_id: Dict[str, Dict[str, Any]] = {}

    if persistent_store_enabled():
        for c in document_store.list_by_tenant(tenantId, 200):
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
                    "createdAt": c.get("createdAt"),
                    "updatedAt": c.get("updatedAt"),
                    "chunkCount": c.get("chunkCount"),
                    "contentType": c.get("contentType"),
                    "sourceType": c.get("sourceType"),
                    "hasSourceText": bool((c.get("sourceText") or "").strip()),
                },
                "search": None,
            }

    if active_search_enabled():
        search_groups = search_store.list_document_groups(tenantId)
        if isinstance(search_groups, dict):
            group_items = search_groups.items()
        else:
            group_items = [
                (g.get("documentId"), g)
                for g in search_groups
                if isinstance(g, dict) and g.get("documentId")
            ]
        for doc_id, search_doc in group_items:
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

    def _sort_created_ts(row: Dict[str, Any]) -> str:
        cosmos = row.get("cosmos") or {}
        return (cosmos.get("createdAt") or cosmos.get("updatedAt") or "")

    documents = sorted(
        by_id.values(),
        key=lambda r: (_sort_created_ts(r), r.get("documentId") or ""),
        reverse=True,
    )
    return {
        "tenantId": tenantId,
        "documents": documents,
        "sources": {"cosmos": persistent_store_enabled(), "search": active_search_enabled()},
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

    if persistent_store_enabled():
        document_store.upsert({
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

    if active_search_enabled():
        search_store.upsert_chunks(payload.tenantId, doc_id, blob_name, file_name, chunks)

    return {
        "documentId": doc_id, "tenantId": payload.tenantId,
        "blobName": blob_name, "fileName": file_name,
        "contentLength": len(text), "chunkCount": len(chunks),
        "indexed": True, "status": "indexed",
    }


@app.get("/api/documents/{document_id}")
def get_document_status(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not persistent_store_enabled():
        raise HTTPException(503, "Document status store is disabled.")
    record = document_store.get(document_id, tenantId)
    if not record:
        raise HTTPException(404, "Document status not found.")
    process_queued_document(record)
    return document_store.get(document_id, tenantId) or record


@app.get("/api/documents/{document_id}/source")
def get_document_source(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)
    if not persistent_store_enabled():
        raise HTTPException(503, "Document store is disabled.")
    record = document_store.get(document_id, tenantId)
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
    if not persistent_store_enabled() and not search_enabled() and not aws_search_enabled():
        raise HTTPException(503, "Cosmos DB and Azure AI Search are both disabled.")

    DOCS_BY_TENANT.get(tenantId, {}).pop(document_id, None)
    before = len(CHUNKS_BY_TENANT.get(tenantId, []))
    CHUNKS_BY_TENANT[tenantId] = [
        c for c in CHUNKS_BY_TENANT.get(tenantId, []) if c.documentId != document_id
    ]
    deleted = before - len(CHUNKS_BY_TENANT.get(tenantId, []))

    if active_search_enabled():
        deleted += search_store.delete_chunks_for_document(document_id, tenantId)

    cosmos_deleted = document_store.delete(document_id, tenantId) if persistent_store_enabled() else False

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
        snippet = chunk.content[:280]  # display-only truncation
        snippets.append(chunk.content)  # full content for LLM context
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
        container_name = storage_container_name()
        expiry_minutes = int(os.getenv("SAS_EXPIRY_MINUTES", "15").strip() or "15")
    except ValueError:
        raise HTTPException(400, "SAS_EXPIRY_MINUTES must be a positive number.")

    if expiry_minutes <= 0:
        raise HTTPException(400, "SAS_EXPIRY_MINUTES must be a positive number.")

    doc_id = str(uuid4())
    storage = get_storage_provider()
    blob_name = storage.build_upload_blob_name(tenant_id, doc_id, file_name)

    try:
        upload_url = storage.create_upload_url(
            blob_name=blob_name,
            container_name=container_name,
            expiry_minutes=expiry_minutes,
            content_type=(payload.contentType or "").strip() or None,
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

    if persistent_store_enabled():
        document_store.upsert({
            "documentId": doc_id, "tenantId": tenant_id,
            "blobName": blob_name, "status": "queued",
            "contentType": (payload.contentType or "").strip() or None,
        })

    return {
        "documentId": doc_id, "tenantId": tenant_id,
        "blobName": blob_name, "uploadUrl": upload_url,
        "expiresInMinutes": expiry_minutes,
    }


@app.post("/api/uploads/confirm")
def confirm_upload(payload: ConfirmUploadRequest) -> Dict[str, Any]:
    validate_tenant_id(payload.tenantId)
    if persistent_store_enabled():
        existing = document_store.get(payload.documentId, payload.tenantId)
        content_type = (existing or {}).get("contentType")
        document_store.upsert({
            "documentId": payload.documentId,
            "tenantId": payload.tenantId,
            "blobName": payload.blobName,
            "status": "processing",
            "contentType": content_type,
        })

    # EC2 / ECS path: process immediately on confirm.
    current = document_store.get(payload.documentId, payload.tenantId)
    if current:
        process_queued_document(current)

    return {
        "documentId": payload.documentId,
        "tenantId": payload.tenantId,
        "blobName": payload.blobName,
        "queued": True,
    }
