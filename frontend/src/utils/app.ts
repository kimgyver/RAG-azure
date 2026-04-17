import type { RuntimeConfigSnapshot } from "../types/app";

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
