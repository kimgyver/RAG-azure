#!/bin/bash
# NOTE: no set -e so individual failures don't kill the whole script
exec > >(tee /var/log/user-data.log | logger -t user-data) 2>&1

echo "=== RAG backend EC2 bootstrap ==="

# ── 1. Install Docker & tools ─────────────────────────────────────────────────
dnf update -y || echo "WARNING: dnf update failed, continuing"
dnf install -y docker nginx aws-cli jq amazon-ssm-agent || echo "WARNING: some packages failed to install"

systemctl enable docker nginx amazon-ssm-agent || echo "WARNING: systemctl enable failed"
systemctl start docker || echo "WARNING: docker start failed"
systemctl start amazon-ssm-agent || echo "WARNING: ssm-agent start failed"

# Docker Compose plugin (v2) — try dnf first, fall back to curl
mkdir -p /usr/local/lib/docker/cli-plugins
if dnf install -y docker-compose-plugin 2>/dev/null; then
  echo "docker-compose-plugin installed via dnf"
else
  echo "dnf docker-compose-plugin not available, trying curl..."
  curl -sSL "https://github.com/docker/compose/releases/download/v2.24.6/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    || echo "WARNING: docker compose install failed - deploy script will handle"
fi

# ── 2. Fetch OPENAI_API_KEY from SSM ─────────────────────────────────────────
OPENAI_API_KEY=$(aws ssm get-parameter \
  --region "${aws_region}" \
  --name "${openai_ssm_name}" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text 2>/dev/null) || OPENAI_API_KEY=""
echo "SSM fetch result: $([ -n "$OPENAI_API_KEY" ] && echo 'OK' || echo 'EMPTY - set manually later')"

# ── 3. Create app directory and .env file ─────────────────────────────────────
mkdir -p /opt/ragbackend

cat > /opt/ragbackend/.env <<EOF
CLOUD_PROVIDER=aws
AWS_REGION=${aws_region}
S3_BUCKET_NAME=${s3_bucket}
DYNAMODB_TABLE_NAME=${dynamodb_table}
SQS_QUEUE_URL=${sqs_queue_url}
OPENSEARCH_ENDPOINT=${opensearch_endpoint}
OPENSEARCH_INDEX_NAME=rag-chunks
SEARCH_ENABLED=true
ALLOWED_TENANT_IDS=${allowed_tenant_ids}
OPENAI_API_KEY=$${OPENAI_API_KEY}
EOF

chmod 600 /opt/ragbackend/.env

# ── 4. Write docker-compose.yml ───────────────────────────────────────────────
cat > /opt/ragbackend/docker-compose.yml <<'COMPOSE'
services:
  backend:
    image: ECR_IMAGE_PLACEHOLDER
    env_file: .env
    ports:
      - "8000:8000"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
COMPOSE

# Substitute actual ECR image
sed -i "s|ECR_IMAGE_PLACEHOLDER|${ecr_image}|" /opt/ragbackend/docker-compose.yml

# ── 5. Nginx reverse proxy config ─────────────────────────────────────────────
cat > /etc/nginx/conf.d/ragbackend.conf <<'NGINX'
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        client_max_body_size 50M;
    }
}
NGINX

# Remove default nginx config
rm -f /etc/nginx/conf.d/default.conf
nginx -t && systemctl reload nginx || systemctl restart nginx || echo "WARNING: nginx reload/restart failed"

# ── 6. ECR login & pull ───────────────────────────────────────────────────────
ECR_REGISTRY=$(echo "${ecr_image}" | cut -d'/' -f1)
aws ecr get-login-password --region "${aws_region}" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY" \
  || echo "WARNING: ECR login failed - will retry on deploy"

cd /opt/ragbackend
docker compose pull || echo "WARNING: docker pull failed - will retry on next deploy"

# ── 7. Start backend ──────────────────────────────────────────────────────────
docker compose up -d || echo "WARNING: docker compose up failed - start manually after deploy"

# ── 8. Systemd unit so backend auto-restarts on reboot ───────────────────────
cat > /etc/systemd/system/ragbackend.service <<'UNIT'
[Unit]
Description=RAG Backend (Docker Compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/ragbackend
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable ragbackend

echo "=== Bootstrap complete ==="
