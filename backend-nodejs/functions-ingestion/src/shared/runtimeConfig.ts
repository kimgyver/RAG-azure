import { cosmosEnabled } from "./documentMetadataStore.js";
import { embeddingEnabled } from "./embeddingStore.js";
import {
  resolveSearchMode,
  searchEnabled
} from "./searchIndexStore.js";

function ocrFeatureEnabled(): boolean {
  return (process.env.OCR_ENABLED ?? "true").toLowerCase() !== "false";
}

function chatOpenAiKeyPresent(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function tenantAllowlistActive(): boolean {
  return Boolean(process.env.ALLOWED_TENANT_IDS?.trim());
}

export type RuntimeConfigSnapshot = {
  cosmosDbEnabled: boolean;
  searchEnabled: boolean;
  embeddingPipelineEnabled: boolean;
  chatSearchMode: "keyword" | "hybrid" | "vector";
  ocrEnabled: boolean;
  openAiChatConfigured: boolean;
  tenantAllowlistActive: boolean;
};

export function getRuntimeConfigSnapshot(): RuntimeConfigSnapshot {
  return {
    cosmosDbEnabled: cosmosEnabled(),
    searchEnabled: searchEnabled(),
    embeddingPipelineEnabled: embeddingEnabled(),
    chatSearchMode: resolveSearchMode(process.env.CHAT_SEARCH_MODE),
    ocrEnabled: ocrFeatureEnabled(),
    openAiChatConfigured: chatOpenAiKeyPresent(),
    tenantAllowlistActive: tenantAllowlistActive()
  };
}
