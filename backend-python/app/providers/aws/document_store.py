from __future__ import annotations

import os
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone

try:
    import boto3
    from boto3.dynamodb.conditions import Key
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore
    Key = None  # type: ignore
    ClientError = Exception  # type: ignore

from ..base import DocumentStoreProvider


def _dynamodb_table():
    if boto3 is None:
        raise RuntimeError("boto3 is required for AWS document store.")
    dynamodb = boto3.resource(
        "dynamodb",
        region_name=os.getenv("AWS_REGION", "ap-southeast-2"),
    )
    table_name = os.getenv("DYNAMODB_TABLE_NAME", "rag-documents")
    return dynamodb.Table(table_name)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AwsDocumentStoreProvider(DocumentStoreProvider):
    def upsert(self, update: Dict[str, Any]) -> None:
        try:
            table = _dynamodb_table()
            document_id = update["documentId"]
            tenant_id = update["tenantId"]
            now = _utc_now_iso()

            existing = self.get(document_id, tenant_id) or {}

            item = {
                # Deployed table PK is documentId (hash-only).
                "documentId": document_id,
                "tenantId": tenant_id,
                # Keep legacy id field for compatibility with older code paths.
                "id": document_id,
                "blobName": update["blobName"],
                "status": update["status"],
                "contentType": update.get("contentType") or existing.get("contentType"),
                "contentLength": update.get("contentLength") if update.get("contentLength") is not None else existing.get("contentLength"),
                "chunkCount": update.get("chunkCount") if update.get("chunkCount") is not None else existing.get("chunkCount"),
                "errorMessage": update.get("errorMessage") or existing.get("errorMessage"),
                "sourceType": update.get("sourceType") or existing.get("sourceType"),
                "sourceText": update.get("sourceText") if update.get("sourceText") is not None else existing.get("sourceText"),
                "createdAt": existing.get("createdAt") or now,
                "updatedAt": now,
            }
            # DynamoDB does not accept None values.
            item = {k: v for k, v in item.items() if v is not None}
            table.put_item(Item=item)
        except Exception:
            return

    def get(self, document_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        try:
            table = _dynamodb_table()
            response = table.get_item(Key={"documentId": document_id})
            item = response.get("Item")
            if not item:
                return None
            # Enforce tenant boundary in application layer because PK is hash-only.
            if item.get("tenantId") != tenant_id:
                return None
            return item
        except Exception:
            return None

    def list_by_tenant(self, tenant_id: str, max_items: int = 200) -> List[Dict[str, Any]]:
        try:
            table = _dynamodb_table()
            response = table.query(
                IndexName="tenantId-index",
                KeyConditionExpression=Key("tenantId").eq(tenant_id),
                Limit=max_items,
            )
            items = response.get("Items", [])
            items.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
            return items[:max_items]
        except Exception:
            return []

    def delete(self, document_id: str, tenant_id: str) -> bool:
        try:
            table = _dynamodb_table()
            current = self.get(document_id, tenant_id)
            if not current:
                return False
            table.delete_item(Key={"documentId": document_id})
            return True
        except Exception:
            return False
