from __future__ import annotations

import json
import os
import re
import urllib.request
from io import BytesIO
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import quote
from uuid import uuid4

from azure.cosmos import CosmosClient
from azure.core.exceptions import ResourceNotFoundError
from azure.core.credentials import AzureKeyCredential
from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - optional dependency path
    load_dotenv = None

if load_dotenv is not None:
    # Load backend-python/.env for local runs so runtime flags match expected deployment behavior.
    load_dotenv()

try:
    from openai import OpenAI
except Exception:  # pragma: no cover - optional dependency path
    OpenAI = None

try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover - optional dependency path
    PdfReader = None

try:
    from azure.ai.documentintelligence import DocumentIntelligenceClient
except Exception:  # pragma: no cover - optional dependency path
    DocumentIntelligenceClient = None

try:
    from azure.identity import DefaultAzureCredential
except Exception:  # pragma: no cover - optional dependency path
    DefaultAzureCredential = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def allowed_tenants() -> Set[str]:
    raw = os.getenv("ALLOWED_TENANT_IDS", "").strip()
    if not raw:
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def validate_tenant_id(tenant_id: str) -> None:
    allowlist = allowed_tenants()
    if allowlist and tenant_id not in allowlist:
        raise HTTPException(status_code=403, detail="tenantId is not allowed")


def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError("Missing required environment variable: {0}".format(name))
    return value


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


class CreateTextKnowledgeRequest(BaseModel):
    tenantId: str
    text: str
    title: Optional[str] = None


class ChatRequest(BaseModel):
    tenantId: str
    question: str
    sessionId: Optional[str] = None
    summaryMemory: Optional[str] = None
    messages: Optional[List[Dict[str, str]]] = None


class CreateUploadRequest(BaseModel):
    tenantId: str
    fileName: str
    contentType: Optional[str] = None


class DocumentRecord(BaseModel):
    id: str
    documentId: str
    tenantId: str
    blobName: str
    fileName: str
    status: str
    sourceText: str
    sourceType: str = "text"
    contentType: Optional[str] = None
    contentLength: int
    chunkCount: int
    createdAt: str
    updatedAt: str


class ChunkRecord(BaseModel):
    id: str
    tenantId: str
    documentId: str
    blobName: str
    fileName: str
    chunkIndex: int
    content: str


app = FastAPI(title="RAG Azure Python Backend", version="0.1.0")

cors_origins = [
    item.strip()
    for item in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if item.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOCS_BY_TENANT: Dict[str, Dict[str, DocumentRecord]] = defaultdict(dict)
CHUNKS_BY_TENANT: Dict[str, List[ChunkRecord]] = defaultdict(list)

_COSMOS_CLIENT: Optional[CosmosClient] = None
_COSMOS_CONTAINER: Any = None
_BLOB_SERVICE_CLIENT: Optional[BlobServiceClient] = None
_DOCUMENT_INTELLIGENCE_CLIENT: Any = None
_DOCUMENT_INTELLIGENCE_CREDENTIAL: Any = None


def cosmos_enabled() -> bool:
    return bool_env("COSMOS_DB_ENABLED", False)


def search_enabled() -> bool:
    return bool_env("SEARCH_ENABLED", False)


def ocr_enabled() -> bool:
    return bool_env("OCR_ENABLED", False)


def get_cosmos_config() -> Dict[str, str]:
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

    cfg = get_cosmos_config()
    if not (cfg["endpoint"] and cfg["key"]):
        raise RuntimeError("COSMOS_ENDPOINT and COSMOS_KEY are required when COSMOS_DB_ENABLED=true")

    _COSMOS_CLIENT = CosmosClient(url=cfg["endpoint"], credential=cfg["key"])
    database = _COSMOS_CLIENT.create_database_if_not_exists(id=cfg["database_id"])
    _COSMOS_CONTAINER = database.create_container_if_not_exists(
        id=cfg["container_id"],
        partition_key={"paths": ["/tenantId"], "kind": "Hash"},
    )
    return _COSMOS_CONTAINER


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


def is_text_blob(blob_name: str, content_type: Optional[str]) -> bool:
    lower_name = blob_name.lower()
    lower_type = (content_type or "").lower()
    if lower_type.startswith("text/"):
        return True
    return lower_name.endswith(".txt") or lower_name.endswith(".md") or lower_name.endswith(".csv") or lower_name.endswith(".json")


def is_pdf_blob(blob_name: str, content_type: Optional[str]) -> bool:
    lower_name = blob_name.lower()
    lower_type = (content_type or "").lower()
    return lower_type == "application/pdf" or lower_name.endswith(".pdf")


def is_image_blob(blob_name: str, content_type: Optional[str]) -> bool:
    lower_name = blob_name.lower()
    lower_type = (content_type or "").lower()
    if lower_type.startswith("image/") and "svg" not in lower_type and lower_type != "image/heic":
        return True
    return (
        lower_name.endswith(".png")
        or lower_name.endswith(".jpg")
        or lower_name.endswith(".jpeg")
        or lower_name.endswith(".webp")
        or lower_name.endswith(".gif")
    )


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


def ocr_service_configured() -> bool:
    return bool(
        ocr_enabled()
        and os.getenv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "").strip()
    )


def get_document_intelligence_client() -> Any:
    global _DOCUMENT_INTELLIGENCE_CLIENT, _DOCUMENT_INTELLIGENCE_CREDENTIAL

    if _DOCUMENT_INTELLIGENCE_CLIENT is not None:
        return _DOCUMENT_INTELLIGENCE_CLIENT

    endpoint = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "").strip()
    key = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_KEY", "").strip()

    if not endpoint:
        raise RuntimeError("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT is required when OCR is enabled")
    if DocumentIntelligenceClient is None:
        raise RuntimeError("azure-ai-documentintelligence is not installed")

    if key:
        _DOCUMENT_INTELLIGENCE_CREDENTIAL = AzureKeyCredential(key)
    else:
        if DefaultAzureCredential is None:
            raise RuntimeError("azure-identity is required for managed identity OCR auth")
        _DOCUMENT_INTELLIGENCE_CREDENTIAL = DefaultAzureCredential(
            exclude_interactive_browser_credential=True
        )

    _DOCUMENT_INTELLIGENCE_CLIENT = DocumentIntelligenceClient(
        endpoint=endpoint,
        credential=_DOCUMENT_INTELLIGENCE_CREDENTIAL,
    )
    return _DOCUMENT_INTELLIGENCE_CLIENT


def extract_ocr_text(content: bytes, content_type: Optional[str]) -> str:
    if not ocr_service_configured():
        return ""

    client = get_document_intelligence_client()
    model_id = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID", "prebuilt-read").strip() or "prebuilt-read"
    poller = client.begin_analyze_document(
        model_id=model_id,
        body=BytesIO(content),
        content_type=content_type or "application/octet-stream",
    )
    result = poller.result()

    if getattr(result, "content", None):
        return str(result.content).strip()

    lines: List[str] = []
    for page in getattr(result, "pages", []) or []:
        for line in getattr(page, "lines", []) or []:
            line_text = (getattr(line, "content", "") or "").strip()
            if line_text:
                lines.append(line_text)
    return "\n".join(lines).strip()


def upsert_local_index(
    tenant_id: str,
    document_id: str,
    blob_name: str,
    file_name: str,
    text: str,
    content_type: Optional[str],
    source_type: str,
    created_at: Optional[str] = None,
) -> int:
    chunks = chunk_text(text)
    CHUNKS_BY_TENANT[tenant_id] = [
        chunk for chunk in CHUNKS_BY_TENANT.get(tenant_id, []) if chunk.documentId != document_id
    ]
    for idx, chunk in enumerate(chunks):
        CHUNKS_BY_TENANT[tenant_id].append(
            ChunkRecord(
                id="{0}-{1}".format(document_id, idx),
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


def process_queued_document(record: Dict[str, Any]) -> bool:
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
        # Upload not completed yet.
        return False
    except Exception:
        return False

    source_type = "text"
    if not is_text_blob(blob_name, content_type) and not is_pdf_blob(blob_name, content_type) and not is_image_blob(blob_name, content_type):
        upsert_document_metadata(
            {
                "documentId": document_id,
                "tenantId": tenant_id,
                "blobName": blob_name,
                "status": "skipped",
                "contentType": content_type,
                "errorMessage": "Unsupported document type for Python local worker.",
            }
        )
        return True

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
        upsert_document_metadata(
            {
                "documentId": document_id,
                "tenantId": tenant_id,
                "blobName": blob_name,
                "status": "failed",
                "contentType": content_type,
                "errorMessage": "Failed to download or decode blob content.",
            }
        )
        return True

    if not text:
        error_message = "No extractable text found in document."
        if is_image_blob(blob_name, content_type) and not ocr_service_configured():
            error_message = "OCR service is not configured for image documents."
        upsert_document_metadata(
            {
                "documentId": document_id,
                "tenantId": tenant_id,
                "blobName": blob_name,
                "status": "failed",
                "contentType": content_type,
                "errorMessage": error_message,
            }
        )
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
    )

    upsert_document_metadata(
        {
            "documentId": document_id,
            "tenantId": tenant_id,
            "blobName": blob_name,
            "status": "indexed",
            "contentType": content_type,
            "contentLength": len(text),
            "chunkCount": chunk_count,
            "sourceType": source_type,
            "sourceText": text,
        }
    )
    return True


def process_queued_documents_for_tenant(tenant_id: str) -> None:
    if not cosmos_enabled():
        return
    docs = list_documents_by_tenant(tenant_id, 300)
    for doc in docs:
        process_queued_document(doc)


def hydrate_indexed_documents_for_tenant(tenant_id: str) -> None:
    if not cosmos_enabled():
        return
    docs = list_documents_by_tenant(tenant_id, 300)
    already_indexed = {chunk.documentId for chunk in CHUNKS_BY_TENANT.get(tenant_id, [])}
    for doc in docs:
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
        file_name = blob_name.split("/")[-1] or document_id
        upsert_local_index(
            tenant_id=tenant_id,
            document_id=document_id,
            blob_name=blob_name,
            file_name=file_name,
            text=source_text,
            content_type=doc.get("contentType"),
            source_type=(doc.get("sourceType") or "unknown"),
            created_at=doc.get("createdAt"),
        )
        already_indexed.add(document_id)


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


def list_search_document_groups(tenant_id: str, max_chunks_to_scan: int = 4000) -> Dict[str, Dict[str, Any]]:
    """Query Azure AI Search API to count chunks per documentId, matching Node.js behavior."""
    endpoint = os.getenv("SEARCH_ENDPOINT", "").strip().rstrip("/")
    api_key = os.getenv("SEARCH_API_KEY", "").strip()
    index_name = os.getenv("SEARCH_INDEX_NAME", "rag-chunks").strip()

    if not endpoint or not api_key:
        # Fallback to in-memory cache if Search API not configured
        groups: Dict[str, Dict[str, Any]] = {}
        for chunk in CHUNKS_BY_TENANT.get(tenant_id, []):
            current = groups.get(chunk.documentId)
            if not current:
                groups[chunk.documentId] = {
                    "chunkCount": 1,
                    "fileName": chunk.fileName,
                    "blobName": chunk.blobName,
                }
            else:
                current["chunkCount"] += 1
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
        url = f"{endpoint}/indexes/{index_name}/docs?{params}"
        req = urllib.request.Request(
            url, headers={"api-key": api_key, "Accept": "application/json"}
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
            existing = groups.get(did)
            if existing:
                existing["chunkCount"] += 1
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
        raise HTTPException(status_code=503, detail="Cosmos DB and Azure AI Search are both disabled; nothing to list.")

    by_id: Dict[str, Dict[str, Any]] = {}

    # Local Python backend has no Service Bus worker. Opportunistically process queued blobs.
    process_queued_documents_for_tenant(tenantId)
    # Also hydrate in-memory chunk index from Cosmos so chat/search reflect existing docs.
    hydrate_indexed_documents_for_tenant(tenantId)

    if cosmos_enabled():
        for c in list_documents_by_tenant(tenantId, 200):
            document_id = c.get("documentId") or c.get("id")
            if not document_id:
                continue
            by_id[document_id] = {
                "documentId": document_id,
                "tenantId": c.get("tenantId") or tenantId,
                "fileName": (c.get("blobName") or "").split("/")[-1] or document_id,
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
        search_groups = list_search_document_groups(tenantId)
        for document_id, search_doc in search_groups.items():
            existing = by_id.get(document_id)
            if existing:
                existing["search"] = search_doc
                if not existing.get("fileName"):
                    existing["fileName"] = search_doc["fileName"]
                if not existing.get("blobName"):
                    existing["blobName"] = search_doc["blobName"]
            else:
                by_id[document_id] = {
                    "documentId": document_id,
                    "tenantId": tenantId,
                    "fileName": search_doc["fileName"] or document_id,
                    "blobName": search_doc["blobName"],
                    "cosmos": None,
                    "search": search_doc,
                }

    documents = list(by_id.values())
    documents.sort(
        key=lambda row: (
            (row.get("cosmos") or {}).get("updatedAt") or "",
            row.get("documentId") or "",
        ),
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
        raise HTTPException(status_code=400, detail="text must not be empty")

    now = utc_now_iso()
    document_id = str(uuid4())
    title = (payload.title or "manual-note").strip() or "manual-note"
    file_name = f"{title}.txt" if not title.endswith(".txt") else title
    blob_name = f"manual/{payload.tenantId}/{document_id}.txt"

    chunks = chunk_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="text is too short to index")

    record = DocumentRecord(
        id=document_id,
        documentId=document_id,
        tenantId=payload.tenantId,
        blobName=blob_name,
        fileName=file_name,
        status="indexed",
        sourceText=text,
        contentLength=len(text),
        chunkCount=len(chunks),
        createdAt=now,
        updatedAt=now,
        contentType="text/plain",
    )
    DOCS_BY_TENANT[payload.tenantId][document_id] = record

    if cosmos_enabled():
        upsert_document_metadata(
            {
                "documentId": document_id,
                "tenantId": payload.tenantId,
                "blobName": blob_name,
                "status": "indexed",
                "contentType": "text/plain",
                "contentLength": len(text),
                "chunkCount": len(chunks),
                "sourceType": "text",
                "sourceText": text,
            }
        )

    tenant_chunks = [
        chunk
        for chunk in CHUNKS_BY_TENANT[payload.tenantId]
        if chunk.documentId != document_id
    ]
    for idx, chunk in enumerate(chunks):
        tenant_chunks.append(
            ChunkRecord(
                id=f"{document_id}-{idx}",
                tenantId=payload.tenantId,
                documentId=document_id,
                blobName=blob_name,
                fileName=file_name,
                chunkIndex=idx,
                content=chunk,
            )
        )
    CHUNKS_BY_TENANT[payload.tenantId] = tenant_chunks

    return {
        "documentId": document_id,
        "tenantId": payload.tenantId,
        "blobName": blob_name,
        "fileName": file_name,
        "contentLength": len(text),
        "chunkCount": len(chunks),
        "indexed": True,
        "status": "indexed",
    }


@app.get("/api/documents/{document_id}")
def get_document_status(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)

    if not cosmos_enabled():
        raise HTTPException(status_code=503, detail="Cosmos DB status store is disabled.")

    record = get_document_metadata(document_id, tenantId)
    if not record:
        raise HTTPException(status_code=404, detail="Document status not found.")

    # Trigger local processing path during status polling to move queued -> indexed.
    process_queued_document(record)
    refreshed = get_document_metadata(document_id, tenantId)
    if refreshed:
        return refreshed
    return record


@app.get("/api/documents/{document_id}/source")
def get_document_source(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)

    if not cosmos_enabled():
        raise HTTPException(status_code=503, detail="Cosmos DB is disabled.")

    record = get_document_metadata(document_id, tenantId)
    if not record:
        raise HTTPException(status_code=404, detail="Document metadata not found.")

    source_text = (record.get("sourceText") or "").strip()
    if not source_text:
        raise HTTPException(
            status_code=404,
            detail="Source text is not stored for this document. (이 문서는 원문 저장 이전에 처리되었거나 추출 가능한 텍스트가 없을 수 있습니다.)",
        )

    return {
        "documentId": record.get("documentId") or record.get("id"),
        "tenantId": record.get("tenantId") or tenantId,
        "fileName": (record.get("blobName") or "").split("/")[-1] or document_id,
        "sourceType": record.get("sourceType") or "unknown",
        "sourceText": source_text,
        "updatedAt": record.get("updatedAt"),
    }


def _delete_search_chunks_for_document(document_id: str, tenant_id: str) -> int:
    """Delete all Azure Search index chunks for a document via REST API. Returns count deleted."""
    endpoint = os.getenv("SEARCH_ENDPOINT", "").strip().rstrip("/")
    api_key = os.getenv("SEARCH_API_KEY", "").strip()
    index_name = os.getenv("SEARCH_INDEX_NAME", "rag-chunks").strip()

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
        list_url = f"{endpoint}/indexes/{index_name}/docs?{params}"
        list_req = urllib.request.Request(
            list_url, headers={"api-key": api_key, "Accept": "application/json"}
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
        batch_url = f"{endpoint}/indexes/{index_name}/docs/index?api-version={api_version}"
        del_req = urllib.request.Request(
            batch_url,
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


@app.delete("/api/documents/{document_id}/purge")
def purge_document(document_id: str, tenantId: str = Query(...)) -> Dict[str, Any]:
    validate_tenant_id(tenantId)

    if not cosmos_enabled() and not search_enabled():
        raise HTTPException(status_code=503, detail="Cosmos DB and Azure AI Search are both disabled; nothing to delete.")

    # Clear in-memory cache
    DOCS_BY_TENANT.get(tenantId, {}).pop(document_id, None)
    before = len(CHUNKS_BY_TENANT.get(tenantId, []))
    CHUNKS_BY_TENANT[tenantId] = [
        chunk for chunk in CHUNKS_BY_TENANT.get(tenantId, []) if chunk.documentId != document_id
    ]
    after = len(CHUNKS_BY_TENANT.get(tenantId, []))

    # Delete from Azure Search index (the authoritative store)
    deleted_search = _delete_search_chunks_for_document(document_id, tenantId) if search_enabled() else 0
    deleted_search += (before - after)  # include any in-memory-only chunks

    # Delete from Cosmos DB
    cosmos_deleted = delete_document_metadata(document_id, tenantId) if cosmos_enabled() else False

    if deleted_search == 0 and not cosmos_deleted:
        raise HTTPException(status_code=404, detail="Document not found.")

    return {
        "documentId": document_id,
        "tenantId": tenantId,
        "deletedSearchChunks": deleted_search,
        "remainingSearchChunks": 0,
        "cosmosDeleted": cosmos_deleted,
        "note": "Blob 원본은 삭제하지 않았습니다. 스토리지에서 직접 지우려면 포털 또는 별도 작업을 사용하세요.",
    }


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
        f"Question: {question}\n\n"
        f"Context:\n{context}"
    )

    response = client.responses.create(
        model=model,
        input=prompt,
        max_output_tokens=350,
    )
    return response.output_text.strip() if getattr(response, "output_text", "") else None


@app.post("/api/chat")
def chat(payload: ChatRequest) -> Dict[str, Any]:
    validate_tenant_id(payload.tenantId)
    hydrate_indexed_documents_for_tenant(payload.tenantId)
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question must not be empty")

    tokens = tokenize(question)
    scored: List[Tuple[int, ChunkRecord]] = []
    for chunk in CHUNKS_BY_TENANT.get(payload.tenantId, []):
        overlap = len(tokens.intersection(tokenize(chunk.content)))
        if overlap > 0:
            scored.append((overlap, chunk))

    scored.sort(key=lambda item: item[0], reverse=True)
    top_hits = scored[:5]

    citations = []
    snippets = []
    for score, chunk in top_hits:
        snippet = chunk.content[:280]
        snippets.append(snippet)
        citations.append(
            {
                "documentId": chunk.documentId,
                "fileName": chunk.fileName,
                "blobName": chunk.blobName,
                "chunkIndex": chunk.chunkIndex,
                "snippet": snippet,
                "score": score,
            }
        )

    fallback_answer = (
        "I could not find matching tenant-scoped knowledge yet. "
        "Register text first, then ask again."
        if not snippets
        else "\n\n".join(["Based on tenant knowledge:", *snippets[:3]])
    )

    answer = llm_answer(question, snippets) if snippets else None

    return {
        "answer": answer or fallback_answer,
        "citations": citations,
        "usage": {
            "tenantId": payload.tenantId,
            "retrievedChunks": len(citations),
        },
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
        raise HTTPException(status_code=400, detail="tenantId is required.")
    if not file_name:
        raise HTTPException(status_code=400, detail="fileName is required.")

    try:
        account_name = get_required_env("AZURE_STORAGE_ACCOUNT_NAME")
        account_key = get_required_env("AZURE_STORAGE_ACCOUNT_KEY")
        blob_endpoint = os.getenv("AZURE_STORAGE_BLOB_ENDPOINT", "").strip() or None
        container_name = os.getenv("AZURE_STORAGE_CONTAINER_NAME", "uploads").strip() or "uploads"
        expiry_minutes = int(os.getenv("SAS_EXPIRY_MINUTES", "15").strip() or "15")
    except ValueError:
        raise HTTPException(status_code=400, detail="SAS_EXPIRY_MINUTES must be a positive number.")
    except RuntimeError:
        raise HTTPException(status_code=500, detail="Failed to create upload URL.")

    if expiry_minutes <= 0:
        raise HTTPException(status_code=400, detail="SAS_EXPIRY_MINUTES must be a positive number.")

    document_id = str(uuid4())
    blob_name = build_upload_blob_name(tenant_id, document_id, file_name)

    try:
        upload_url = create_upload_sas_url(
            account_name=account_name,
            account_key=account_key,
            container_name=container_name,
            blob_name=blob_name,
            expiry_minutes=expiry_minutes,
            content_type=(payload.contentType or "").strip() or None,
            blob_endpoint=blob_endpoint,
        )
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to create upload URL.")

    now = utc_now_iso()
    DOCS_BY_TENANT[tenant_id][document_id] = DocumentRecord(
        id=document_id,
        documentId=document_id,
        tenantId=tenant_id,
        blobName=blob_name,
        fileName=file_name,
        status="queued",
        sourceText="",
        sourceType="blob",
        contentType=(payload.contentType or "").strip() or None,
        contentLength=0,
        chunkCount=0,
        createdAt=now,
        updatedAt=now,
    )

    if cosmos_enabled():
        upsert_document_metadata(
            {
                "documentId": document_id,
                "tenantId": tenant_id,
                "blobName": blob_name,
                "status": "queued",
                "contentType": (payload.contentType or "").strip() or None,
            }
        )

    return {
        "documentId": document_id,
        "tenantId": tenant_id,
        "blobName": blob_name,
        "uploadUrl": upload_url,
        "expiresInMinutes": expiry_minutes,
    }
