from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


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


class ConfirmUploadRequest(BaseModel):
    tenantId: str
    documentId: str
    blobName: str


# Process-level in-memory cache (cleared on container restart)
DOCS_BY_TENANT: Dict[str, Dict[str, DocumentRecord]] = defaultdict(dict)
CHUNKS_BY_TENANT: Dict[str, List[ChunkRecord]] = defaultdict(list)
