import type { RuntimeConfigSnapshot } from "../types/app";
import { searchModeLabel } from "../utils/app";

type HeroHeaderProps = {
  runtimeConfigStatus: "loading" | "ok" | "error";
  runtimeConfig: RuntimeConfigSnapshot | null;
  cosmosStateSummary: string;
  chatModeSummary: string;
};

export function HeroHeader({
  runtimeConfigStatus,
  runtimeConfig,
  cosmosStateSummary,
  chatModeSummary
}: HeroHeaderProps) {
  return (
    <header className="hero">
      <div>
        <p className="eyebrow">Azure-native RAG demo</p>
        <h1>Upload, index, and chat in one screen</h1>
        <p className="hero-copy">
          Upload to Blob with a SAS token, process asynchronously via a queue,
          retrieve with Azure AI Search, and-depending on configuration-try
          embeddings, hybrid search, and generative answers. The box on the
          right reflects your Functions deployment flags. If{" "}
          <code className="inline-code">ALLOWED_TENANT_IDS</code> is empty, any
          tenant ID is accepted; otherwise only listed IDs are allowed.
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
              <span>Cosmos · document state</span>
              <strong>{runtimeConfig.cosmosDbEnabled ? "On" : "Off"}</strong>
              <p className="hero-stat-sub">{cosmosStateSummary}</p>
              <p className="hero-stat-sub hero-stat-sub-secondary">
                {runtimeConfig.tenantAllowlistActive
                  ? "Allowlisted tenants only (ALLOWED_TENANT_IDS)"
                  : "No tenant restriction · local default"}
              </p>
            </div>
            <div>
              <span>AI Search · indexing</span>
              <strong>{runtimeConfig.searchEnabled ? "On" : "Off"}</strong>
              <p className="hero-stat-sub">
                Embeddings{" "}
                {runtimeConfig.embeddingPipelineEnabled ? "on" : "off"} · chat{" "}
                {searchModeLabel(runtimeConfig.chatSearchMode)} · image OCR{" "}
                {runtimeConfig.ocrEnabled ? "on" : "off"}
              </p>
            </div>
            <div>
              <span>Chat answers</span>
              <strong>
                {runtimeConfig.openAiChatConfigured
                  ? "Generative"
                  : "Search snippets only"}
              </strong>
              <p className="hero-stat-sub">{chatModeSummary}</p>
              <p className="hero-stat-sub hero-stat-sub-secondary">
                {runtimeConfig.openAiChatConfigured
                  ? "OPENAI_API_KEY set - GPT-style answers"
                  : "OPENAI_API_KEY not set yet - fallback mode is expected"}
              </p>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
