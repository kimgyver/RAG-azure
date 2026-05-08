from __future__ import annotations

from typing import Optional

from ..base import OcrProvider
from ...ocr import extract_ocr_text, ocr_service_configured


class AzureOcrProvider(OcrProvider):
    def extract_text(self, content: bytes, content_type: Optional[str]) -> str:
        return extract_ocr_text(content, content_type)

    def is_configured(self) -> bool:
        return ocr_service_configured()
