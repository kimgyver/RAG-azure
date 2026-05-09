import type { BackendTarget, RuntimeConfigSnapshot } from "../types/app";
import { BACKEND_RESOURCE_LABELS } from "../utils/app";

type HeroHeaderProps = {
  backendTarget: BackendTarget;
  runtimeConfigStatus: "loading" | "ok" | "error";
  runtimeConfig: RuntimeConfigSnapshot | null;
  runtimeErrorMessage?: string;
};

export function HeroHeader({
  backendTarget,
  runtimeConfigStatus,
  runtimeConfig,
  runtimeErrorMessage
}: HeroHeaderProps) {
  const resourceLabels = BACKEND_RESOURCE_LABELS[backendTarget];
  return (
    <header className="hero">
      <div>
        <p className="eyebrow">RAG Chatbot</p>
        <h1>Upload & Chat</h1>
        <p className="hero-copy">
          Upload documents, search, and get AI-generated answers in one place.
          Active backend profile: {resourceLabels.backendLabel} using{" "}
          {resourceLabels.storageLabel}, {resourceLabels.metadataLabel}, and{" "}
          {resourceLabels.searchLabel}.
        </p>
      </div>
      <div className="hero-stats">
        {runtimeConfigStatus === "loading" ? (
          <div>
            <span>Backend flags</span>
            <strong>Loading…</strong>
          </div>
        ) : runtimeConfigStatus === "error" || !runtimeConfig ? (
          <div>
            <span>Backend flags</span>
            <strong>Could not load</strong>
            <p className="hero-stat-sub">
              {runtimeErrorMessage?.trim()
                ? runtimeErrorMessage
                : "Check backend reachability and API key configuration."}
            </p>
          </div>
        ) : (
          <>
            <div>
              <span>{resourceLabels.searchLabel}</span>
              <strong>{runtimeConfig.searchEnabled ? "Ready" : "Off"}</strong>
              <p className="hero-stat-sub">
                {runtimeConfig.embeddingPipelineEnabled
                  ? "With embeddings"
                  : "Keyword search"}
              </p>
            </div>
            <div>
              <span>
                {resourceLabels.storageLabel} + {resourceLabels.metadataLabel}
              </span>
              <strong>
                {runtimeConfig.openAiChatConfigured
                  ? "AI-Generated"
                  : "Search Only"}
              </strong>
              <p className="hero-stat-sub">
                {runtimeConfig.openAiChatConfigured
                  ? `Stored in ${resourceLabels.metadataLabel} and answered with GPT`
                  : `Using ${resourceLabels.searchLabel} results only`}
              </p>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
