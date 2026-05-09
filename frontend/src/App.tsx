import { CatalogPanel } from "./components/CatalogPanel";
import { ChatPanel } from "./components/ChatPanel";
import { HeroHeader } from "./components/HeroHeader";
import { TenantContextBar } from "./components/TenantContextBar";
import { UploadPanel } from "./components/UploadPanel";
import { useAppController } from "./hooks/useAppController";

function App() {
  const controller = useAppController();

  return (
    <div className="app-shell">
      <HeroHeader
        backendTarget={controller.backendTarget}
        runtimeConfigStatus={controller.runtimeConfigStatus}
        runtimeConfig={controller.runtimeConfig}
        runtimeErrorMessage={controller.runtimeErrorMessage}
      />

      <TenantContextBar
        tenantId={controller.tenantId}
        backendTarget={controller.backendTarget}
        backendApiBaseUrl={controller.apiBaseUrl}
        tenantError={controller.tenantError}
        onTenantIdChange={controller.onTenantIdChange}
        onBackendTargetChange={controller.setBackendTarget}
      />

      <main className="main-stack">
        <div className="workspace-grid">
          <UploadPanel
            backendTarget={controller.backendTarget}
            onFileChange={controller.onFileChange}
            onStartUpload={controller.startUpload}
            uploadState={controller.uploadState}
            uploadMessage={controller.uploadMessage}
            effectiveTenantId={controller.effectiveTenantId}
            uploadApiBaseUrl={controller.apiBaseUrl}
            documents={controller.documents}
            textTitle={controller.textTitle}
            textContent={controller.textContent}
            textIngestState={controller.textIngestState}
            textIngestMessage={controller.textIngestMessage}
            onTextTitleChange={controller.setTextTitle}
            onTextContentChange={controller.setTextContent}
            onRegisterTextKnowledge={controller.registerTextKnowledge}
          />

          <ChatPanel
            backendTarget={controller.backendTarget}
            runtimeConfigStatus={controller.runtimeConfigStatus}
            runtimeConfig={controller.runtimeConfig}
            searchOnlyMode={controller.searchOnlyMode}
            chatMessages={controller.chatMessages}
            chatInput={controller.chatInput}
            chatPending={controller.chatPending}
            onSendChat={controller.sendChat}
            onChatInputChange={controller.setChatInput}
          />
        </div>

        <CatalogPanel
          loadCatalog={controller.loadCatalog}
          catalogStatus={controller.catalogStatus}
          catalogMessage={controller.catalogMessage}
          runtimeConfigStatus={controller.runtimeConfigStatus}
          runtimeConfig={controller.runtimeConfig}
          catalogRows={controller.catalogRows}
          purgeBusyId={controller.purgeBusyId}
          onPurgeDocument={controller.handlePurgeDocument}
          onViewDocumentSource={controller.handleViewDocumentSource}
          backendTarget={controller.backendTarget}
        />
      </main>
    </div>
  );
}

export default App;
