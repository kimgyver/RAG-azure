import { useCallback, useEffect, useMemo, useState } from "react";
import { CatalogPanel } from "./components/CatalogPanel";
import { ChatPanel } from "./components/ChatPanel";
import { HeroHeader } from "./components/HeroHeader";
import { TenantContextBar } from "./components/TenantContextBar";
import { UploadPanel } from "./components/UploadPanel";
import {
  initialChatMessages,
  type CatalogDocumentRow,
  type CatalogResponse,
  type ChatMessage,
  type ChatResponse,
  type CreateTextKnowledgeResponse,
  type CreateUploadResponse,
  type DocumentItem,
  type DocumentSourceResponse,
  type DocumentStatus,
  type DocumentStatusResponse,
  type PurgeResponse,
  type RuntimeConfigSnapshot,
  type TextIngestState,
  type UploadState
} from "./types/app";
import {
  buildTenantChatSessionId,
  extractApiMessage,
  relativeTimeLabel,
  waitMs
} from "./utils/app";

function App() {
  const defaultTenantId = useMemo(
    () => (import.meta.env.VITE_TENANT_ID?.trim() || "tenant-a").trim(),
    []
  );
  const [tenantId, setTenantId] = useState<string>(defaultTenantId);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [chatMessagesByTenant, setChatMessagesByTenant] = useState<
    Record<string, ChatMessage[]>
  >({
    [defaultTenantId]: initialChatMessages
  });
  const [chatInput, setChatInput] = useState<string>("");
  const [chatPending, setChatPending] = useState<boolean>(false);
  const [chatSummaryMemoryByTenant, setChatSummaryMemoryByTenant] = useState<
    Record<string, string>
  >({});
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState<string>(
    "Choose a file and start upload."
  );
  const [textTitle, setTextTitle] = useState<string>("");
  const [textContent, setTextContent] = useState<string>("");
  const [textIngestState, setTextIngestState] =
    useState<TextIngestState>("idle");
  const [textIngestMessage, setTextIngestMessage] = useState<string>(
    "Type or paste text, then register it for retrieval."
  );
  const [trackedDocument, setTrackedDocument] = useState<{
    documentId: string;
    tenantId: string;
  } | null>(null);
  const [runtimeConfig, setRuntimeConfig] =
    useState<RuntimeConfigSnapshot | null>(null);
  const [runtimeConfigStatus, setRuntimeConfigStatus] = useState<
    "loading" | "ok" | "error"
  >("loading");
  const [catalogRows, setCatalogRows] = useState<CatalogDocumentRow[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<
    "idle" | "loading" | "error" | "ok"
  >("loading");
  const [catalogMessage, setCatalogMessage] = useState<string>("");
  const [purgeBusyId, setPurgeBusyId] = useState<string | null>(null);
  const [tenantError, setTenantError] = useState<string>("");

  const uploadApiBaseUrl = useMemo(() => {
    const fromEnv =
      import.meta.env.VITE_UPLOAD_API_BASE_URL?.trim() ||
      import.meta.env.VITE_API_BASE_URL?.trim();
    if (fromEnv) {
      return fromEnv.replace(/\/$/, "");
    }
    // Default to relative /api in both local and deployed frontend to avoid hardcoded hosts.
    return "/api";
  }, []);

  const uploadApiKey = useMemo(
    () => import.meta.env.VITE_UPLOAD_API_KEY?.trim() ?? "",
    []
  );

  const effectiveTenantId = tenantId.trim() || defaultTenantId;
  const chatSessionId = useMemo(
    () => buildTenantChatSessionId(effectiveTenantId),
    [effectiveTenantId]
  );
  const chatMessages =
    chatMessagesByTenant[effectiveTenantId] ?? initialChatMessages;
  const chatSummaryMemory = chatSummaryMemoryByTenant[effectiveTenantId] ?? "";
  const searchOnlyMode =
    runtimeConfigStatus === "ok" && runtimeConfig
      ? !runtimeConfig.openAiChatConfigured
      : false;
  const cosmosStateSummary =
    runtimeConfigStatus === "ok" && runtimeConfig
      ? runtimeConfig.cosmosDbEnabled
        ? "Metadata writes are active for upload status and catalog rows."
        : "Metadata writes are off. Search can still work without Cosmos."
      : "";
  const chatModeSummary =
    runtimeConfigStatus === "ok" && runtimeConfig
      ? runtimeConfig.openAiChatConfigured
        ? "Generative mode is active. Retrieved search chunks are passed to the model for answer synthesis."
        : "Search-only mode is active. Answers are assembled from retrieved search chunks until OpenAI credentials are configured."
      : "";

  const loadCatalog = useCallback(async () => {
    setCatalogStatus("loading");
    setCatalogMessage("");
    try {
      const response = await fetch(
        `${uploadApiBaseUrl}/documents/catalog?tenantId=${encodeURIComponent(
          effectiveTenantId
        )}`,
        {
          headers: {
            ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
          }
        }
      );
      const text = await response.text();
      if (!response.ok) {
        const detail = extractApiMessage(text, `HTTP ${response.status}`);
        throw new Error(detail);
      }
      const payload = JSON.parse(text) as CatalogResponse;
      setCatalogRows(payload.documents);
      setCatalogStatus("ok");
      setTenantError("");
      setCatalogMessage(
        `Cosmos ${payload.sources.cosmos ? "ON" : "OFF"} · Search ${
          payload.sources.search ? "ON" : "OFF"
        } · ${payload.documents.length} doc(s)`
      );
    } catch (error) {
      setCatalogRows([]);
      setCatalogStatus("error");
      const message =
        error instanceof Error ? error.message : "Could not load catalog.";
      setCatalogMessage(message);
      if (message.includes("tenantId is not allowed")) {
        setTenantError(message);
      }
    }
  }, [effectiveTenantId, uploadApiBaseUrl, uploadApiKey]);

  const refreshCatalogWithRetries = useCallback(
    async (attempts = 4, intervalMs = 350) => {
      for (let i = 0; i < attempts; i += 1) {
        await loadCatalog();
        if (i < attempts - 1) {
          await waitMs(intervalMs);
        }
      }
    },
    [loadCatalog]
  );

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    let cancelled = false;
    const loadRuntime = async () => {
      setRuntimeConfigStatus("loading");
      try {
        const response = await fetch(`${uploadApiBaseUrl}/flags/deployment`, {
          headers: {
            ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
          }
        });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const payload = (await response.json()) as RuntimeConfigSnapshot;
        if (!cancelled) {
          setRuntimeConfig(payload);
          setRuntimeConfigStatus("ok");
        }
      } catch {
        if (!cancelled) {
          setRuntimeConfig(null);
          setRuntimeConfigStatus("error");
        }
      }
    };

    void loadRuntime();
    return () => {
      cancelled = true;
    };
  }, [uploadApiBaseUrl, uploadApiKey]);

  useEffect(() => {
    setChatMessagesByTenant(prev => {
      if (prev[effectiveTenantId]) {
        return prev;
      }
      return {
        ...prev,
        [effectiveTenantId]: initialChatMessages
      };
    });
  }, [effectiveTenantId]);

  useEffect(() => {
    if (!trackedDocument) {
      return;
    }

    let isCancelled = false;
    let consecutiveNotFoundCount = 0;
    const maxNotFoundRetries = 5;
    const terminalStatuses = new Set<DocumentStatus>([
      "chunked",
      "skipped",
      "failed",
      "indexed"
    ]);

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `${uploadApiBaseUrl}/documents/${trackedDocument.documentId}?tenantId=${trackedDocument.tenantId}`,
          {
            headers: {
              ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
            }
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            consecutiveNotFoundCount += 1;
            if (consecutiveNotFoundCount >= maxNotFoundRetries) {
              if (!isCancelled) {
                setTrackedDocument(null);
                setUploadMessage(
                  "Upload completed but status metadata is not ready. Refresh catalog or re-upload if this persists."
                );
                void refreshCatalogWithRetries(2, 400);
              }
            }
          }
          return;
        }

        consecutiveNotFoundCount = 0;

        const payload = (await response.json()) as DocumentStatusResponse;
        if (isCancelled) {
          return;
        }

        setDocuments(prev =>
          prev.map(item =>
            item.id === payload.documentId
              ? {
                  ...item,
                  tenantId: payload.tenantId,
                  status: payload.status,
                  updatedAt: relativeTimeLabel(payload.updatedAt),
                  contentLength: payload.contentLength,
                  chunkCount: payload.chunkCount,
                  errorMessage: payload.errorMessage
                }
              : item
          )
        );

        if (payload.status === "processing") {
          setUploadMessage("Processing document...");
        } else if (payload.status === "chunked") {
          setUploadMessage("Text extraction and chunking complete.");
        } else if (payload.status === "indexed") {
          setUploadMessage("Indexing complete.");
        } else if (payload.status === "skipped") {
          setUploadMessage("This format is handled in a later step.");
        } else if (payload.status === "failed") {
          setUploadMessage(
            payload.errorMessage
              ? `Processing failed: ${payload.errorMessage}`
              : "Document processing failed."
          );
        }

        if (terminalStatuses.has(payload.status)) {
          setTrackedDocument(null);
          await refreshCatalogWithRetries(3, 500);
        }
      } catch {
        // Polling errors retry on the next interval.
      }
    };

    void pollStatus();
    const intervalId = window.setInterval(() => {
      void pollStatus();
    }, 3000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    trackedDocument,
    uploadApiBaseUrl,
    uploadApiKey,
    refreshCatalogWithRetries
  ]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setUploadState("idle");
    setUploadMessage(file ? `${file.name} selected.` : "Please choose a file.");
  };

  const startUpload = async () => {
    if (!selectedFile) {
      setUploadState("error");
      setUploadMessage("Please choose a file to upload first.");
      return;
    }

    const tempId = `temp-${Date.now()}`;
    const tempItem: DocumentItem = {
      id: tempId,
      fileName: selectedFile.name,
      status: "uploading",
      updatedAt: "just now",
      tenantId: effectiveTenantId
    };

    setDocuments(prev => [tempItem, ...prev]);

    try {
      setUploadState("requesting-sas");
      setUploadMessage("Requesting SAS URL...");

      const sasResponse = await fetch(`${uploadApiBaseUrl}/uploads/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
        },
        body: JSON.stringify({
          tenantId: effectiveTenantId,
          fileName: selectedFile.name,
          contentType: selectedFile.type || "application/octet-stream"
        })
      });

      if (!sasResponse.ok) {
        const responseText = await sasResponse.text();
        const detail = extractApiMessage(
          responseText,
          `HTTP ${sasResponse.status}`
        );
        throw new Error(
          `Failed to get SAS URL (${sasResponse.status}) ${detail}`
        );
      }

      const sasPayload = (await sasResponse.json()) as CreateUploadResponse;

      setUploadState("uploading");
      setUploadMessage("Uploading directly to Blob Storage...");

      // Dev only: if SAS URL targets storage emulator, use Vite proxy path to avoid CORS
      const effectiveUploadUrl =
        import.meta.env.DEV && sasPayload.uploadUrl.includes("127.0.0.1:10000")
          ? (() => {
              const u = new URL(sasPayload.uploadUrl);
              return u.pathname + u.search;
            })()
          : sasPayload.uploadUrl;

      const uploadResponse = await fetch(effectiveUploadUrl, {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "Content-Type": selectedFile.type || "application/octet-stream"
        },
        body: selectedFile
      });

      if (!uploadResponse.ok) {
        const responseText = await uploadResponse.text();
        throw new Error(
          `Blob direct upload failed (${uploadResponse.status}) ${responseText}`
        );
      }

      setDocuments(prev =>
        prev.map(item =>
          item.id === tempId
            ? {
                ...item,
                id: sasPayload.documentId,
                tenantId: sasPayload.tenantId,
                status: "queued",
                updatedAt: "just now"
              }
            : item
        )
      );
      setTrackedDocument({
        documentId: sasPayload.documentId,
        tenantId: sasPayload.tenantId
      });
      setUploadState("done");
      setTenantError("");
      setUploadMessage("Upload complete. Status will show as queued.");
    } catch (error) {
      setDocuments(prev =>
        prev.map(item =>
          item.id === tempId ? { ...item, status: "failed" } : item
        )
      );
      setUploadState("error");
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (errorMessage.includes("tenantId is not allowed")) {
        setTenantError("tenantId is not allowed for this deployment.");
      }
      setUploadMessage(
        `Upload error: ${errorMessage} (API: ${uploadApiBaseUrl}/uploads/create)`
      );
    }
  };

  const sendChat = async () => {
    const question = chatInput.trim();
    if (!question || chatPending) {
      return;
    }

    const tenantScopedMessages =
      chatMessagesByTenant[effectiveTenantId] ?? initialChatMessages;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question
    };

    setChatMessagesByTenant(prev => ({
      ...prev,
      [effectiveTenantId]: [
        ...(prev[effectiveTenantId] ?? initialChatMessages),
        userMessage
      ]
    }));
    setChatInput("");
    setChatPending(true);

    try {
      const messagesForMemory = [...tenantScopedMessages, userMessage]
        .filter(
          message => message.role === "user" || message.role === "assistant"
        )
        .slice(-12)
        .map(message => ({
          role: message.role,
          content: message.content
        }));

      const response = await fetch(`${uploadApiBaseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
        },
        body: JSON.stringify({
          tenantId: effectiveTenantId,
          question,
          sessionId: chatSessionId,
          summaryMemory: chatSummaryMemory,
          messages: messagesForMemory
        })
      });

      if (!response.ok) {
        const responseText = await response.text();
        const detail = extractApiMessage(
          responseText,
          `HTTP ${response.status}`
        );
        throw new Error(`Chat request failed (${response.status}) ${detail}`);
      }

      const payload = (await response.json()) as ChatResponse;
      setTenantError("");
      if (payload.memory?.summary) {
        setChatSummaryMemoryByTenant(prev => ({
          ...prev,
          [effectiveTenantId]: payload.memory?.summary ?? ""
        }));
      }
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: payload.answer,
        citations: payload.citations.map(
          citation => `${citation.fileName} · chunk ${citation.chunkIndex + 1}`
        )
      };

      setChatMessagesByTenant(prev => ({
        ...prev,
        [effectiveTenantId]: [
          ...(prev[effectiveTenantId] ?? initialChatMessages),
          assistantMessage
        ]
      }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (errorMessage.includes("tenantId is not allowed")) {
        setTenantError("tenantId is not allowed for this deployment.");
      }

      setChatMessagesByTenant(prev => ({
        ...prev,
        [effectiveTenantId]: [
          ...(prev[effectiveTenantId] ?? initialChatMessages),
          {
            id: `assistant-error-${Date.now()}`,
            role: "assistant",
            content: `Could not process your question. ${errorMessage}`
          }
        ]
      }));
    } finally {
      setChatPending(false);
    }
  };

  const registerTextKnowledge = async () => {
    const content = textContent.trim();
    if (!content) {
      setTextIngestState("error");
      setTextIngestMessage("Please enter text content first.");
      return;
    }

    const tempId = `text-temp-${Date.now()}`;
    const displayTitle = textTitle.trim() || "manual-note.txt";

    setDocuments(prev => [
      {
        id: tempId,
        fileName: displayTitle,
        status: "processing",
        updatedAt: "just now",
        tenantId: effectiveTenantId
      },
      ...prev
    ]);

    try {
      setTextIngestState("submitting");
      setTextIngestMessage("Registering text and creating chunks...");

      const response = await fetch(`${uploadApiBaseUrl}/knowledge/text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
        },
        body: JSON.stringify({
          tenantId: effectiveTenantId,
          title: textTitle.trim() || undefined,
          text: content
        })
      });

      const responseText = await response.text();
      if (!response.ok) {
        const detail = extractApiMessage(
          responseText,
          `HTTP ${response.status}`
        );
        throw new Error(detail);
      }

      const payload = JSON.parse(responseText) as CreateTextKnowledgeResponse;

      setDocuments(prev =>
        prev.map(item =>
          item.id === tempId
            ? {
                ...item,
                id: payload.documentId,
                fileName: payload.fileName,
                tenantId: payload.tenantId,
                status: payload.status,
                updatedAt: "just now",
                contentLength: payload.contentLength,
                chunkCount: payload.chunkCount
              }
            : item
        )
      );

      setTextIngestState("done");
      setTextIngestMessage(
        payload.indexed
          ? `Registered ${payload.chunkCount} chunk(s) to knowledge base.`
          : `Text chunked (${payload.chunkCount}) but search indexing is disabled.`
      );
      setTextTitle("");
      setTextContent("");
      setTenantError("");
      await refreshCatalogWithRetries(2, 350);
    } catch (error) {
      setDocuments(prev =>
        prev.map(item =>
          item.id === tempId ? { ...item, status: "failed" } : item
        )
      );

      const message =
        error instanceof Error ? error.message : "Text registration failed.";
      if (message.includes("tenantId is not allowed")) {
        setTenantError("tenantId is not allowed for this deployment.");
      }
      setTextIngestState("error");
      setTextIngestMessage(message);
    }
  };

  const handlePurgeDocument = async (documentId: string) => {
    const confirmed = window.confirm(
      `Document ID "${documentId}"\n\nThis removes AI Search chunks and Cosmos metadata for this tenant. The blob in storage is left unchanged. Continue?`
    );
    if (!confirmed) {
      return;
    }
    setPurgeBusyId(documentId);
    try {
      const response = await fetch(
        `${uploadApiBaseUrl}/documents/${encodeURIComponent(
          documentId
        )}/purge?tenantId=${encodeURIComponent(effectiveTenantId)}`,
        {
          method: "DELETE",
          headers: {
            ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
          }
        }
      );
      const text = await response.text();
      if (!response.ok) {
        const detail = extractApiMessage(text, `HTTP ${response.status}`);
        throw new Error(detail);
      }
      let purgePayload: PurgeResponse | null = null;
      try {
        purgePayload = JSON.parse(text) as PurgeResponse;
      } catch {
        // The API currently responds with JSON; keep resilient parsing.
      }

      const attempts =
        purgePayload && (purgePayload.remainingSearchChunks ?? 0) > 0 ? 6 : 4;
      await refreshCatalogWithRetries(attempts, 350);
      setTenantError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delete failed.";
      if (message.includes("tenantId is not allowed")) {
        setTenantError("tenantId is not allowed for this deployment.");
      }
      window.alert(message);
    } finally {
      setPurgeBusyId(null);
    }
  };

  const handleViewDocumentSource = async (
    documentId: string
  ): Promise<DocumentSourceResponse> => {
    const response = await fetch(
      `${uploadApiBaseUrl}/documents/${encodeURIComponent(
        documentId
      )}/source?tenantId=${encodeURIComponent(effectiveTenantId)}`,
      {
        headers: {
          ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
        }
      }
    );

    const text = await response.text();
    if (!response.ok) {
      const detail = extractApiMessage(text, `HTTP ${response.status}`);
      throw new Error(detail);
    }

    return JSON.parse(text) as DocumentSourceResponse;
  };

  return (
    <div className="app-shell">
      <HeroHeader
        runtimeConfigStatus={runtimeConfigStatus}
        runtimeConfig={runtimeConfig}
        cosmosStateSummary={cosmosStateSummary}
        chatModeSummary={chatModeSummary}
      />

      <TenantContextBar
        tenantId={tenantId}
        effectiveTenantId={effectiveTenantId}
        defaultTenantId={defaultTenantId}
        tenantError={tenantError}
        onTenantIdChange={value => {
          setTenantId(value);
          if (tenantError) {
            setTenantError("");
          }
        }}
      />

      <main className="main-stack">
        <div className="workspace-grid">
          <UploadPanel
            onFileChange={onFileChange}
            onStartUpload={startUpload}
            uploadState={uploadState}
            uploadMessage={uploadMessage}
            effectiveTenantId={effectiveTenantId}
            uploadApiBaseUrl={uploadApiBaseUrl}
            documents={documents}
            textTitle={textTitle}
            textContent={textContent}
            textIngestState={textIngestState}
            textIngestMessage={textIngestMessage}
            onTextTitleChange={setTextTitle}
            onTextContentChange={setTextContent}
            onRegisterTextKnowledge={registerTextKnowledge}
          />

          <ChatPanel
            runtimeConfigStatus={runtimeConfigStatus}
            runtimeConfig={runtimeConfig}
            searchOnlyMode={searchOnlyMode}
            chatMessages={chatMessages}
            chatInput={chatInput}
            chatPending={chatPending}
            onSendChat={sendChat}
            onChatInputChange={setChatInput}
          />
        </div>

        <CatalogPanel
          loadCatalog={loadCatalog}
          catalogStatus={catalogStatus}
          catalogMessage={catalogMessage}
          runtimeConfigStatus={runtimeConfigStatus}
          runtimeConfig={runtimeConfig}
          catalogRows={catalogRows}
          purgeBusyId={purgeBusyId}
          onPurgeDocument={handlePurgeDocument}
          onViewDocumentSource={handleViewDocumentSource}
        />
      </main>
    </div>
  );
}

export default App;
