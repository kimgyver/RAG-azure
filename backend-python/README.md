# backend-python

FastAPI-based Python backend added to this monorepo for job-market portfolio coverage.

This backend currently provides a local/demo backend with tenant-aware RAG behavior:
- `GET /api/flags/deployment`
- `GET /api/documents/catalog`
- `POST /api/knowledge/text`
- `POST /api/chat`
- `GET /api/documents/{documentId}`
- `GET /api/documents/{documentId}/source`
- `DELETE /api/documents/{documentId}/purge`
- `POST /api/uploads/create` (issues Azure Blob Storage SAS URL and registers queued metadata)

Additional behavior now included:
- queued uploads are opportunistically processed by the Python backend without a Service Bus worker
- `.txt/.md/.csv/.json` uploads are extracted directly from Blob Storage
- PDF uploads are parsed with `pypdf`, then OCR-fallback can be used when text extraction is empty
- PNG/JPG/WebP/GIF uploads can be OCRd through Azure Document Intelligence (`prebuilt-read`)

## 1) Run locally

```bash
cd backend-python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a && source .env && set +a
uvicorn app.main:app --host "${PYTHON_API_HOST:-127.0.0.1}" --port "${PYTHON_API_PORT:-8000}" --reload
```

If your existing `.venv` was created with an older interpreter, recreate it with `python3.11` or your installed `python3` before installing requirements.

Health check:

```bash
curl -s http://127.0.0.1:8000/api/health
```

## 2) Connect frontend to this backend

In `frontend/.env`, set:

```bash
VITE_UPLOAD_API_BASE_URL=http://127.0.0.1:8000/api
```

Then run frontend as usual.

## 3) OCR configuration

For deployment-friendly OCR, configure Azure Document Intelligence:

```bash
OCR_ENABLED=true
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://<resource>.cognitiveservices.azure.com/
AZURE_DOCUMENT_INTELLIGENCE_KEY=<key-or-empty-when-using-managed-identity>
AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID=prebuilt-read
```

When `AZURE_DOCUMENT_INTELLIGENCE_KEY` is empty, the backend tries `DefaultAzureCredential`, which is suitable for a managed identity on Azure-hosted runtimes.

## 4) Notes

- This is intentionally an additive Python backend, not a replacement for the existing Node Functions backend.
- `POST /api/uploads/create` requires `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_ACCOUNT_KEY`. If you use Azurite locally, also set `AZURE_STORAGE_BLOB_ENDPOINT` to the emulator blob endpoint.
- The current Terraform stack deploys the Node Functions backend, not this Python backend. Terraform can now carry OCR-related settings, but provisioning a dedicated Python host is still a separate deployment step.

## 5) Container deployment

This directory now includes `Dockerfile`, `startup.sh`, and `.dockerignore`.

That is enough to package and deploy the Python backend to Azure Container Apps or App Service for Containers once the runtime environment variables are supplied.
