#!/usr/bin/env bash
set -euo pipefail

API_BASE="${1:-http://localhost:7071/api}"

echo "[1/2] Request SAS: ${API_BASE}/uploads/create"
CREATE_HTTP=$(curl -s -o /tmp/e2e_create.json -w "%{http_code}" \
  -X POST "${API_BASE}/uploads/create" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"e2e","fileName":"ok.txt","contentType":"text/plain"}')

if [[ "$CREATE_HTTP" != "200" ]]; then
  echo "FAIL: create API returned $CREATE_HTTP"
  cat /tmp/e2e_create.json || true
  exit 1
fi

UPLOAD_URL=$(python3 - <<'PY'
import json
print(json.load(open('/tmp/e2e_create.json'))['uploadUrl'])
PY
)

echo "[2/2] PUT blob via SAS"
PUT_HTTP=$(curl -s -o /tmp/e2e_put_body.txt -w "%{http_code}" \
  -X PUT "$UPLOAD_URL" \
  -H "x-ms-blob-type: BlockBlob" \
  -H "Content-Type: text/plain" \
  -d "e2e-ok")

if [[ "$PUT_HTTP" != "201" ]]; then
  echo "FAIL: blob PUT returned $PUT_HTTP"
  cat /tmp/e2e_put_body.txt || true
  exit 1
fi

echo "OK: create=$CREATE_HTTP, put=$PUT_HTTP"
