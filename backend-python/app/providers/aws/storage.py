from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Optional

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore
    ClientError = Exception  # type: ignore

from ..base import StorageProvider


def _s3_client():
    if boto3 is None:
        raise RuntimeError("boto3 is required for AWS storage. Install it with: pip install boto3")
    region = os.getenv("AWS_REGION", "ap-southeast-2")
    return boto3.client(
        "s3",
        region_name=region,
        endpoint_url="https://s3.{0}.amazonaws.com".format(region),
    )


def _sanitize_file_name(file_name: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9._-]", "-", file_name.strip())
    sanitized = re.sub(r"-+", "-", sanitized).strip("-")
    return sanitized[:120] or "upload.bin"


class AwsStorageProvider(StorageProvider):
    def build_upload_blob_name(self, tenant_id: str, document_id: str, file_name: str) -> str:
        date_folder = datetime.now(timezone.utc).strftime("%Y/%m/%d")
        return "{0}/{1}/{2}-{3}".format(
            tenant_id, date_folder, document_id, _sanitize_file_name(file_name)
        )

    def create_upload_url(
        self,
        blob_name: str,
        container_name: str,
        expiry_minutes: int,
        content_type: Optional[str],
    ) -> str:
        """Generate a pre-signed S3 PUT URL for direct client upload."""
        client = _s3_client()
        params: dict = {
            "Bucket": container_name,
            "Key": blob_name,
        }
        if content_type:
            params["ContentType"] = content_type
        return client.generate_presigned_url(
            "put_object",
            Params=params,
            ExpiresIn=expiry_minutes * 60,
        )

    def download_blob(self, container_name: str, blob_name: str) -> bytes:
        client = _s3_client()
        response = client.get_object(Bucket=container_name, Key=blob_name)
        return response["Body"].read()

    def get_blob_content_type(self, container_name: str, blob_name: str) -> Optional[str]:
        client = _s3_client()
        try:
            response = client.head_object(Bucket=container_name, Key=blob_name)
            return response.get("ContentType")
        except ClientError:
            return None

    def delete_blob(self, container_name: str, blob_name: str) -> None:
        client = _s3_client()
        client.delete_object(Bucket=container_name, Key=blob_name)
