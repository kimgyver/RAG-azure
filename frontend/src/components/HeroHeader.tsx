import type { RuntimeConfigSnapshot } from "../types/app";

type HeroHeaderProps = {
  runtimeConfigStatus: "loading" | "ok" | "error";
  runtimeConfig: RuntimeConfigSnapshot | null;
};

export function HeroHeader({
  runtimeConfigStatus,
  runtimeConfig
}: HeroHeaderProps) {
  return (
    <header className="hero">
      <div>
        <p className="eyebrow">RAG Chatbot</p>
        <h1>Upload & Chat</h1>
        <p className="hero-copy">
          Upload documents, search, and get AI-generated answers in one place.
          Your deployment configuration is shown on the right.
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
              Check that Functions is reachable at{" "}
              <code className="inline-code">VITE_UPLOAD_API_BASE_URL</code>.
              Upload and chat may also need{" "}
              <code className="inline-code">VITE_UPLOAD_API_KEY</code>.
            </p>
          </div>
        ) : (
          <>
            <div>
              <span>Search & Indexing</span>
              <strong>{runtimeConfig.searchEnabled ? "Ready" : "Off"}</strong>
              <p className="hero-stat-sub">
                {runtimeConfig.embeddingPipelineEnabled
                  ? "With embeddings"
                  : "Keyword search"}
              </p>
            </div>
            <div>
              <span>Chat Answers</span>
              <strong>
                {runtimeConfig.openAiChatConfigured
                  ? "AI-Generated"
                  : "Search Only"}
              </strong>
              <p className="hero-stat-sub">
                {runtimeConfig.openAiChatConfigured
                  ? "Powered by GPT"
                  : "From search results"}
              </p>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
