import { useMemo } from "react";
import { CatalogPanel } from "./components/CatalogPanel";
import { ChatPanel } from "./components/ChatPanel";
import { HeroHeader } from "./components/HeroHeader";
import { TenantContextBar } from "./components/TenantContextBar";
import { UploadPanel } from "./components/UploadPanel";
import {
  useBackendConfig,
  useRuntimeConfig,
  useChat,
  useCatalog,
  useUpload,
  useTextIngest
} from "./hooks";

function App() {
  // Backend configuration: backend selection, tenant management
  const backendConfig = useBackendConfig();

  // Runtime configuration: backend flags and deployment info
  const runtimeConfig = useRuntimeConfig(
    backendConfig.apiBaseUrl,
    backendConfig.apiKey,
    backendConfig.backendTarget
  );

  // Effective tenant ID (validated tenant)
  const effectiveTenantId =
    backendConfig.tenantId.trim() ||
    (backendConfig.backendTarget === "python"
      ? "tenant-azure-1"
      : backendConfig.backendTarget === "aws"
        ? "tenant-aws-1"
        : "tenant-azure-1");

  // Chat functionality: messages and chat operations
  const chat = useChat(
    effectiveTenantId,
    backendConfig.apiBaseUrl,
    backendConfig.apiKey
  );

  // Document catalog: list documents, purge, track uploads
  const catalog = useCatalog(
    effectiveTenantId,
    backendConfig.apiBaseUrl,
    backendConfig.apiKey,
    backendConfig.backendTarget
  );

  // File upload: upload state and operations
  const upload = useUpload(
    effectiveTenantId,
    backendConfig.apiBaseUrl,
    backendConfig.apiKey,
    backendConfig.backendTarget,
    (docId, tenantId) => {
      catalog.trackDocument({ documentId: docId, tenantId });
    },
    () => catalog.refreshWithRetries(3, 500, true)
  );

  // Text knowledge registration: ingest text for search
  const textIngest = useTextIngest(
    effectiveTenantId,
    backendConfig.apiBaseUrl,
    backendConfig.apiKey,
    backendConfig.backendTarget,
    () => catalog.refreshWithRetries(2, 350, true)
  );

  // Search-only mode: when OpenAI is not configured
  const searchOnlyMode = useMemo(
    () =>
      runtimeConfig.status === "ok" && runtimeConfig.runtimeConfig
        ? !runtimeConfig.runtimeConfig.openAiChatConfigured
        : false,
    [runtimeConfig.status, runtimeConfig.runtimeConfig]
  );

  // Handle chat submission
  const handleSendChat = async () => {
    const question = chat.chatInput.trim();
    if (question) {
      backendConfig.clearTenantError();
      try {
        await chat.sendChat(question);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("tenantId is not allowed")
        ) {
          backendConfig.setTenantError(
            "tenantId is not allowed for this deployment."
          );
        }
      }
    }
  };

  // Handle text registration
  const handleRegisterText = async () => {
    backendConfig.clearTenantError();
    try {
      await textIngest.register();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("tenantId is not allowed")
      ) {
        backendConfig.setTenantError(
          "tenantId is not allowed for this deployment."
        );
      }
    }
  };

  // Handle purge document (wrapper to ignore boolean return)
  const handlePurgeDocument = async (documentId: string) => {
    await catalog.purge(documentId);
  };

  return (
    <div className="app-shell">
      <HeroHeader
        backendTarget={backendConfig.backendTarget}
        runtimeConfigStatus={runtimeConfig.status}
        runtimeConfig={runtimeConfig.runtimeConfig}
        runtimeErrorMessage={runtimeConfig.errorMessage}
      />

      <TenantContextBar
        tenantId={backendConfig.tenantId}
        backendTarget={backendConfig.backendTarget}
        backendApiBaseUrl={backendConfig.apiBaseUrl}
        tenantError={backendConfig.tenantError}
        onTenantIdChange={backendConfig.onTenantIdChange}
        onBackendTargetChange={backendConfig.onBackendTargetChange}
      />

      <main className="main-stack">
        <div className="workspace-grid">
          <UploadPanel
            backendTarget={backendConfig.backendTarget}
            onFileChange={upload.onFileChange}
            onStartUpload={upload.startUpload}
            uploadState={upload.uploadState}
            uploadMessage={upload.uploadMessage}
            effectiveTenantId={effectiveTenantId}
            uploadApiBaseUrl={backendConfig.apiBaseUrl}
            documents={upload.documents}
            textTitle={textIngest.textTitle}
            textContent={textIngest.textContent}
            textIngestState={textIngest.textIngestState}
            textIngestMessage={textIngest.textIngestMessage}
            onTextTitleChange={textIngest.setTextTitle}
            onTextContentChange={textIngest.setTextContent}
            onRegisterTextKnowledge={handleRegisterText}
          />

          <ChatPanel
            backendTarget={backendConfig.backendTarget}
            runtimeConfigStatus={runtimeConfig.status}
            runtimeConfig={runtimeConfig.runtimeConfig}
            searchOnlyMode={searchOnlyMode}
            chatMessages={chat.chatMessages}
            chatInput={chat.chatInput}
            chatPending={chat.chatPending}
            onSendChat={handleSendChat}
            onChatInputChange={chat.setChatInput}
          />
        </div>

        <CatalogPanel
          loadCatalog={catalog.load}
          catalogStatus={catalog.catalogStatus}
          catalogMessage={catalog.catalogMessage}
          runtimeConfigStatus={runtimeConfig.status}
          runtimeConfig={runtimeConfig.runtimeConfig}
          catalogRows={catalog.catalogRows}
          purgeBusyId={catalog.purgeBusyId}
          onPurgeDocument={handlePurgeDocument}
          onViewDocumentSource={catalog.getSource}
          backendTarget={backendConfig.backendTarget}
        />
      </main>
    </div>
  );
}

export default App;
