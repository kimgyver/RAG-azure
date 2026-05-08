#!/usr/bin/env bash
# scripts/ec2-deploy.sh
# Usage: ./scripts/ec2-deploy.sh
# Builds Python backend Docker image, pushes to ECR, then restarts container on EC2 via SSM.
set -euo pipefail

REGION="ap-southeast-2"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/ragdemo-dev-backend"
IMAGE="${ECR_REPO}:latest"

# ── Get EC2 instance ID from Terraform output ─────────────────────────────────
INSTANCE_ID=$(cd "$(dirname "$0")/../infra/aws" && terraform output -raw ec2_instance_id 2>/dev/null || true)

if [[ -z "$INSTANCE_ID" ]]; then
  # Fallback: look up by tag
  INSTANCE_ID=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=ragdemo-dev-backend" "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].InstanceId" \
    --output text)
fi

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "ERROR: Could not find running EC2 instance tagged 'ragdemo-dev-backend'" >&2
  exit 1
fi

echo "▶ Target EC2: $INSTANCE_ID"

# ── Build & push ──────────────────────────────────────────────────────────────
echo "▶ Building Docker image (linux/amd64)..."
cd "$(dirname "$0")/../backend-python"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

docker build --platform linux/amd64 -t ragdemo-dev-backend:latest .
docker tag ragdemo-dev-backend:latest "$IMAGE"

echo "▶ Pushing to ECR..."
docker push "$IMAGE"

# ── Deploy via SSM RunCommand ─────────────────────────────────────────────────
echo "▶ Triggering EC2 redeploy via SSM..."
SSM_PARAMS=$(printf '{"commands":["cd /opt/ragbackend","aws ecr get-login-password --region %s | docker login --username AWS --password-stdin %s.dkr.ecr.%s.amazonaws.com","docker compose pull","docker compose up -d --remove-orphans","docker image prune -f"]}' \
  "$REGION" "$ACCOUNT_ID" "$REGION")
COMMAND_ID=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "$SSM_PARAMS" \
  --query "Command.CommandId" \
  --output text)

echo "▶ SSM Command ID: $COMMAND_ID"
echo "▶ Waiting for completion..."

aws ssm wait command-executed \
  --region "$REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" 2>/dev/null || true

STATUS=$(aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "Status" \
  --output text)

echo "▶ Deploy status: $STATUS"

if [[ "$STATUS" != "Success" ]]; then
  echo "ERROR: Deploy failed. Fetching logs..."
  aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query "StandardErrorContent" \
    --output text
  exit 1
fi

EC2_IP=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PublicIpAddress" \
  --output text)

echo "✓ Deploy complete! Backend: http://${EC2_IP}/api/health"
