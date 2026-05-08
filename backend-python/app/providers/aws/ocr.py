from __future__ import annotations

import os
from typing import Optional

try:
    import boto3
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore

from ..base import OcrProvider


def _textract_client():
    if boto3 is None:
        raise RuntimeError("boto3 is required for AWS OCR (Textract).")
    return boto3.client(
        "textract",
        region_name=os.getenv("AWS_REGION", "ap-southeast-2"),
    )


class AwsOcrProvider(OcrProvider):
    def is_configured(self) -> bool:
        return boto3 is not None and bool(os.getenv("OCR_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"})

    def extract_text(self, content: bytes, content_type: Optional[str]) -> str:
        if not self.is_configured():
            return ""
        try:
            client = _textract_client()
            response = client.detect_document_text(Document={"Bytes": content})
            lines = [
                block["Text"]
                for block in response.get("Blocks", [])
                if block.get("BlockType") == "LINE" and block.get("Text")
            ]
            return "\n".join(lines).strip()
        except Exception:
            return ""
