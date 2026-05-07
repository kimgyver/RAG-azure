from __future__ import annotations

import os
from io import BytesIO
from typing import Any, List, Optional

from azure.core.credentials import AzureKeyCredential

try:
    from azure.ai.documentintelligence import DocumentIntelligenceClient
except Exception:  # pragma: no cover
    DocumentIntelligenceClient = None  # type: ignore

try:
    from azure.identity import DefaultAzureCredential
except Exception:  # pragma: no cover
    DefaultAzureCredential = None  # type: ignore

from .config import ocr_enabled

_DOCUMENT_INTELLIGENCE_CLIENT: Any = None
_DOCUMENT_INTELLIGENCE_CREDENTIAL: Any = None


def ocr_service_configured() -> bool:
    return bool(ocr_enabled() and os.getenv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "").strip())


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
