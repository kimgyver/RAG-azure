import type { BackendTarget, RuntimeConfigSnapshot } from "../types/app";

export const TENANT_OPTIONS_BY_BACKEND: Record<
  BackendTarget,
  [string, string]
> = {
  node: ["tenant-azure-1", "tenant-azure-2"],
  python: ["tenant-azure-1", "tenant-azure-2"],
  aws: ["tenant-aws-1", "tenant-aws-2"],
  "aws-python": ["tenant-aws-1", "tenant-aws-2"]
};

export const BACKEND_RESOURCE_LABELS: Record<
  BackendTarget,
  {
    backendLabel: string;
    cloudLabel: string;
    uploadUrlLabel: string;
    uploadFlowLabel: string;
    storageLabel: string;
    storagePathLabel: string;
    metadataLabel: string;
    searchLabel: string;
  }
> = {
  node: {
    backendLabel: "Azure · Node (Functions)",
    cloudLabel: "Azure",
    uploadUrlLabel: "SAS URL",
    uploadFlowLabel: "SAS direct upload",
    storageLabel: "Blob Storage",
    storagePathLabel: "Blob path prefix",
    metadataLabel: "Cosmos DB",
    searchLabel: "Azure AI Search"
  },
  python: {
    backendLabel: "Azure · Python (Container App)",
    cloudLabel: "Azure",
    uploadUrlLabel: "SAS URL",
    uploadFlowLabel: "SAS direct upload",
    storageLabel: "Blob Storage",
    storagePathLabel: "Blob path prefix",
    metadataLabel: "Cosmos DB",
    searchLabel: "Azure AI Search"
  },
  aws: {
    backendLabel: "AWS · Node (Lambda)",
    cloudLabel: "AWS",
    uploadUrlLabel: "Signed URL",
    uploadFlowLabel: "Signed URL upload",
    storageLabel: "S3",
    storagePathLabel: "S3 key prefix",
    metadataLabel: "DynamoDB",
    searchLabel: "OpenSearch"
  },
  "aws-python": {
    backendLabel: "AWS · Python (EC2 + Docker)",
    cloudLabel: "AWS",
    uploadUrlLabel: "Signed URL",
    uploadFlowLabel: "Signed URL upload",
    storageLabel: "S3",
    storagePathLabel: "S3 key prefix",
    metadataLabel: "DynamoDB",
    searchLabel: "OpenSearch"
  }
};

export function isAwsBackend(target: BackendTarget): boolean {
  return target === "aws" || target === "aws-python";
}

export function searchModeLabel(
  mode: RuntimeConfigSnapshot["chatSearchMode"]
): string {
  switch (mode) {
    case "keyword":
      return "keyword";
    case "vector":
      return "vector";
    default:
      return "hybrid";
  }
}

export function relativeTimeLabel(input: string): string {
  const deltaMs = Date.now() - new Date(input).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return "just now";
  }

  const minutes = Math.floor(deltaMs / 60000);
  if (minutes <= 0) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function extractApiMessage(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(trimmed) as { message?: string };
    if (typeof parsed?.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Keep raw text fallback.
  }

  return trimmed;
}

export function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

export function buildTenantChatSessionId(inputTenantId: string): string {
  const normalized = inputTenantId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `web-${normalized || "tenant"}`;
}
