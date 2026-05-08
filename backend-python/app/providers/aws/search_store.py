from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Dict, List
from urllib.parse import quote

try:
    from opensearchpy import OpenSearch, RequestsHttpConnection
    from requests_aws4auth import AWS4Auth
    import boto3
except ImportError:  # pragma: no cover
    OpenSearch = None  # type: ignore
    AWS4Auth = None  # type: ignore
    boto3 = None  # type: ignore

from ..base import SearchStoreProvider


def _opensearch_config() -> tuple[str, str]:
    endpoint = os.getenv("OPENSEARCH_ENDPOINT", "").strip().rstrip("/")
    index_name = os.getenv("OPENSEARCH_INDEX_NAME", "rag-chunks").strip()
    return endpoint, index_name


def _opensearch_client():
    if OpenSearch is None:
        raise RuntimeError("opensearch-py and requests-aws4auth are required for AWS search.")
    endpoint, _ = _opensearch_config()
    region = os.getenv("AWS_REGION", "ap-southeast-2")

    if boto3 is not None:
        credentials = boto3.Session().get_credentials()
        awsauth = AWS4Auth(
            credentials.access_key,
            credentials.secret_key,
            region,
            "es",
            session_token=credentials.token,
        )
        return OpenSearch(
            hosts=[{"host": endpoint.replace("https://", "").replace("http://", ""), "port": 443}],
            http_auth=awsauth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
        )
    raise RuntimeError("boto3 is required for AWS OpenSearch auth.")


class AwsSearchStoreProvider(SearchStoreProvider):
    def is_configured(self) -> bool:
        endpoint, _ = _opensearch_config()
        return bool(endpoint)

    def upsert_chunks(
        self,
        tenant_id: str,
        document_id: str,
        blob_name: str,
        file_name: str,
        chunks: List[str],
    ) -> None:
        if not self.is_configured() or not chunks:
            return
        try:
            client = _opensearch_client()
            _, index_name = _opensearch_config()
            bulk_body = []
            for idx, content in enumerate(chunks):
                doc_id = f"{document_id}-{idx}"
                bulk_body.append({"index": {"_index": index_name, "_id": doc_id}})
                bulk_body.append({
                    "id": doc_id,
                    "tenantId": tenant_id,
                    "documentId": document_id,
                    "blobName": blob_name,
                    "fileName": file_name,
                    "chunkIndex": idx,
                    "content": content,
                    "contentLength": len(content),
                    "sourceType": "python-backend",
                })
            client.bulk(body=bulk_body)
        except Exception:
            pass  # best-effort

    def delete_chunks_for_document(self, document_id: str, tenant_id: str) -> int:
        if not self.is_configured():
            return 0
        try:
            client = _opensearch_client()
            _, index_name = _opensearch_config()
            response = client.delete_by_query(
                index=index_name,
                body={
                    "query": {
                        "bool": {
                            "must": [
                                {"term": {"documentId.keyword": document_id}},
                                {"term": {"tenantId.keyword": tenant_id}},
                            ]
                        }
                    }
                },
            )
            return response.get("deleted", 0)
        except Exception:
            return 0

    def list_document_groups(self, tenant_id: str) -> List[Dict[str, Any]]:
        if not self.is_configured():
            return []
        try:
            client = _opensearch_client()
            _, index_name = _opensearch_config()
            response = client.search(
                index=index_name,
                body={
                    "size": 0,
                    "query": {"term": {"tenantId.keyword": tenant_id}},
                    "aggs": {
                        "docs": {
                            "terms": {"field": "documentId.keyword", "size": 300},
                            "aggs": {
                                "fileName": {"terms": {"field": "fileName.keyword", "size": 1}},
                                "blobName": {"terms": {"field": "blobName.keyword", "size": 1}},
                                "chunkCount": {"value_count": {"field": "chunkIndex"}},
                            },
                        }
                    },
                },
            )
            results = []
            for bucket in response.get("aggregations", {}).get("docs", {}).get("buckets", []):
                file_names = bucket.get("fileName", {}).get("buckets", [])
                blob_names = bucket.get("blobName", {}).get("buckets", [])
                results.append({
                    "documentId": bucket["key"],
                    "fileName": file_names[0]["key"] if file_names else "",
                    "blobName": blob_names[0]["key"] if blob_names else "",
                    "chunkCount": bucket.get("chunkCount", {}).get("value", 0),
                })
            return results
        except Exception:
            return []
