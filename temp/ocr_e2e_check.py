import json
import ssl
import time
import urllib.request
from pathlib import Path

BASE_URL = "http://127.0.0.1:8001/api"
TENANT_ID = "tenant-a"
IMAGE_PATH = Path("/Users/jinyoungkim/terraform-repo/RAG-azure/docs/RAG-chatbot.png")
SSL_CONTEXT = ssl._create_unverified_context()


def fetch_json(request: urllib.request.Request):
    with urllib.request.urlopen(request, context=SSL_CONTEXT) as response:
        return json.load(response)


def main() -> None:
    image_bytes = IMAGE_PATH.read_bytes()

    create_request = urllib.request.Request(
        f"{BASE_URL}/uploads/create",
        data=json.dumps(
            {
                "tenantId": TENANT_ID,
                "fileName": IMAGE_PATH.name,
                "contentType": "image/png",
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    create_payload = fetch_json(create_request)

    document_id = create_payload["documentId"]
    upload_url = create_payload["uploadUrl"]

    upload_request = urllib.request.Request(
        upload_url,
        data=image_bytes,
        headers={
            "x-ms-blob-type": "BlockBlob",
            "Content-Type": "image/png",
        },
        method="PUT",
    )
    with urllib.request.urlopen(upload_request, context=SSL_CONTEXT) as response:
        upload_status = response.status

    final_payload = None
    for _ in range(15):
        status_request = urllib.request.Request(
            f"{BASE_URL}/documents/{document_id}?tenantId={TENANT_ID}"
        )
        final_payload = fetch_json(status_request)
        if (final_payload.get("status") or "").lower() in {"indexed", "failed", "skipped"}:
            break
        time.sleep(2)

    source_payload = None
    source_error = None
    try:
        source_request = urllib.request.Request(
            f"{BASE_URL}/documents/{document_id}/source?tenantId={TENANT_ID}"
        )
        source_payload = fetch_json(source_request)
    except Exception as exc:  # pragma: no cover - diagnostic helper
        source_error = str(exc)

    print(
        json.dumps(
            {
                "documentId": document_id,
                "uploadStatus": upload_status,
                "finalStatus": final_payload.get("status") if final_payload else None,
                "sourceType": final_payload.get("sourceType") if final_payload else None,
                "contentType": final_payload.get("contentType") if final_payload else None,
                "chunkCount": final_payload.get("chunkCount") if final_payload else None,
                "errorMessage": final_payload.get("errorMessage") if final_payload else None,
                "sourcePreview": (source_payload or {}).get("sourceText", "")[:300],
                "sourceError": source_error,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
