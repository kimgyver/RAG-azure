from __future__ import annotations

import os
from typing import TYPE_CHECKING

from .base import DocumentStoreProvider, OcrProvider, SearchStoreProvider, StorageProvider

if TYPE_CHECKING:
    pass


def _cloud_provider() -> str:
    return os.getenv("CLOUD_PROVIDER", "azure").strip().lower()


def get_storage_provider() -> StorageProvider:
    if _cloud_provider() == "aws":
        from .aws.storage import AwsStorageProvider
        return AwsStorageProvider()
    from .azure.storage import AzureStorageProvider
    return AzureStorageProvider()


def get_document_store() -> DocumentStoreProvider:
    if _cloud_provider() == "aws":
        from .aws.document_store import AwsDocumentStoreProvider
        return AwsDocumentStoreProvider()
    from .azure.document_store import AzureDocumentStoreProvider
    return AzureDocumentStoreProvider()


def get_search_store() -> SearchStoreProvider:
    if _cloud_provider() == "aws":
        from .aws.search_store import AwsSearchStoreProvider
        return AwsSearchStoreProvider()
    from .azure.search_store import AzureSearchStoreProvider
    return AzureSearchStoreProvider()


def get_ocr_provider() -> OcrProvider:
    if _cloud_provider() == "aws":
        from .aws.ocr import AwsOcrProvider
        return AwsOcrProvider()
    from .azure.ocr import AzureOcrProvider
    return AzureOcrProvider()
