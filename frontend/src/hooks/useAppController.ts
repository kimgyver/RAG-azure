import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent
} from "react";
import {
  initialChatMessages,
  type BackendTarget,
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
} from "../types/app";
import {
  BACKEND_RESOURCE_LABELS,
  TENANT_OPTIONS_BY_BACKEND,
  buildTenantChatSessionId,
  extractApiMessage,
  isAwsBackend,
  relativeTimeLabel,
  waitMs
} from "../utils/app";

type BackendProcessingState = {
  documents: DocumentItem[];
  uploadState: UploadState;
  uploadMessage: string;
  textIngestState: TextIngestState;
  textIngestMessage: string;
  trackedDocument: {
    documentId: string;
    tenantId: string;
  } | null;
};

type BackendCatalogState = {
  catalogRows: CatalogDocumentRow[];
  catalogStatus: "idle" | "loading" | "error" | "ok";
  catalogMessage: string;
};

type BackendRuntimeState = {
  runtimeConfig: RuntimeConfigSnapshot | null;
  runtimeConfigStatus: "loading" | "ok" | "error";
};

function buildBackendRecord<T>(
  factory: (backend: BackendTarget) => T
): Record<BackendTarget, T> {
  return {
    node: factory("node"),
    python: factory("python"),
    aws: factory("aws"),
    "aws-python": factory("aws-python")
  };
}

function getDefaultBackendTarget(): BackendTarget {
  const fromEnv = import.meta.env.VITE_DEFAULT_BACKEND?.trim().toLowerCase();
  if (fromEnv === "python") return "python";
  if (fromEnv === "aws") return "aws";
  if (fromEnv === "aws-python") return "aws-python";
  return "node";
}

function getApiBaseUrls() {
  const nodeBase = (
    import.meta.env.VITE_NODE_API_BASE_URL?.trim() ||
    import.meta.env.VITE_UPLOAD_API_BASE_URL?.trim() ||
    import.meta.env.VITE_API_BASE_URL?.trim() ||
    "/api"
  ).replace(/\/$/, "");

  const pythonBase = (
    import.meta.env.VITE_PYTHON_API_BASE_URL?.trim() || nodeBase
  ).replace(/\/$/, "");

  // Production safety defaults: AWS targets must never fall back to Azure Function URL.
  const defaultAwsNodeBase =
    "https://5xvuxdf5dl.execute-api.ap-southeast-2.amazonaws.com/api";
  const defaultAwsPythonBase =
    "https://wprvx1aiba.execute-api.ap-southeast-2.amazonaws.com/api";

  const configuredAwsBase = (
    import.meta.env.VITE_AWS_API_BASE_URL?.trim() || defaultAwsNodeBase
  ).replace(/\/$/, "");
  const configuredAwsPythonBase = (
    import.meta.env.VITE_AWS_PYTHON_API_BASE_URL?.trim() || defaultAwsPythonBase
  ).replace(/\/$/, "");

  const awsBase =
    configuredAwsBase.includes("azurewebsites.net") ||
    configuredAwsBase.includes("azurecontainerapps.io")
      ? defaultAwsNodeBase
      : configuredAwsBase;
  const awsPythonBase =
    configuredAwsPythonBase.includes("azurewebsites.net") ||
    configuredAwsPythonBase.includes("azurecontainerapps.io") ||
    (window.location.protocol === "https:" &&
      configuredAwsPythonBase.startsWith("http://"))
      ? defaultAwsPythonBase
      : configuredAwsPythonBase;

  return { nodeBase, pythonBase, awsBase, awsPythonBase };
}

function getApiKeys() {
  const nodeApiKey =
    import.meta.env.VITE_NODE_API_KEY?.trim() ||
    import.meta.env.VITE_UPLOAD_API_KEY?.trim() ||
    "";
  const pythonApiKey = import.meta.env.VITE_PYTHON_API_KEY?.trim() || "";
  const awsApiKey = import.meta.env.VITE_AWS_API_KEY?.trim() || "";
  return { nodeApiKey, pythonApiKey, awsApiKey };
}

function resolveFetchErrorMessage(
  error: unknown,
  backendTarget: BackendTarget,
  apiBaseUrl: string,
  fallback: string
): string {
  const message = error instanceof Error ? error.message : fallback;
  const pageIsHttps = window.location.protocol === "https:";
  const apiIsHttp = apiBaseUrl.startsWith("http://");

  if (backendTarget === "aws-python" && pageIsHttps && apiIsHttp) {
    return `Mixed Content blocked: HTTPS page cannot call HTTP API (${apiBaseUrl}). Expose AWS Python backend over HTTPS (domain + TLS) or use local HTTP dev page.`;
  }

  if (message === "Failed to fetch") {
    return `Network request failed for ${apiBaseUrl}. Check CORS, protocol (HTTP/HTTPS), and backend availability.`;
  }

  return message;
}

const CHAT_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function isRetryableChatFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed") ||
    message.includes("timeout") ||
    message.includes("network request failed")
  );
}

export function useAppController() {
  const defaultBackendTarget = useMemo(getDefaultBackendTarget, []);
  const initialTenantId = TENANT_OPTIONS_BY_BACKEND[defaultBackendTarget][0];
  const [backendTarget, setBackendTarget] =
    useState<BackendTarget>(defaultBackendTarget);
  const [tenantIdByBackend, setTenantIdByBackend] = useState<
    Record<BackendTarget, string>
  >(() => buildBackendRecord(target => TENANT_OPTIONS_BY_BACKEND[target][0]));
  const [chatMessagesByTenant, setChatMessagesByTenant] = useState<
    Record<string, ChatMessage[]>
  >({
    [initialTenantId]: initialChatMessages
  });
  const [chatInput, setChatInput] = useState("");
  const [chatPending, setChatPending] = useState(false);
  const [chatSummaryMemoryByTenant, setChatSummaryMemoryByTenant] = useState<
    Record<string, string>
  >({});
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [processingStateByBackend, setProcessingStateByBackend] = useState<
    Record<BackendTarget, BackendProcessingState>
  >(() =>
    buildBackendRecord(() => ({
      documents: [],
      uploadState: "idle",
      uploadMessage: "Choose a file and start upload.",
      textIngestState: "idle",
      textIngestMessage: "Type or paste text, then register it for retrieval.",
      trackedDocument: null
    }))
  );
  const [runtimeStateByBackend, setRuntimeStateByBackend] = useState<
    Record<BackendTarget, BackendRuntimeState>
  >(() =>
    buildBackendRecord(() => ({
      runtimeConfig: null,
      runtimeConfigStatus: "loading"
    }))
  );
  const [runtimeErrorMessageByBackend, setRuntimeErrorMessageByBackend] =
    useState<Record<BackendTarget, string>>(() => buildBackendRecord(() => ""));
  const [catalogStateByBackend, setCatalogStateByBackend] = useState<
    Record<BackendTarget, BackendCatalogState>
  >(() =>
    buildBackendRecord(() => ({
      catalogRows: [],
      catalogStatus: "loading",
      catalogMessage: ""
    }))
  );
  const [purgeBusyIdByBackend, setPurgeBusyIdByBackend] = useState<
    Record<BackendTarget, string | null>
  >(() => buildBackendRecord(() => null));
  const [tenantErrorByBackend, setTenantErrorByBackend] = useState<
    Record<BackendTarget, string>
  >(() => buildBackendRecord(() => ""));

  const { nodeBase, pythonBase, awsBase, awsPythonBase } = useMemo(
    getApiBaseUrls,
    []
  );
  const { nodeApiKey, pythonApiKey, awsApiKey } = useMemo(getApiKeys, []);

  const backendDefaultTenantId = TENANT_OPTIONS_BY_BACKEND[backendTarget][0];
  const tenantId = tenantIdByBackend[backendTarget] ?? backendDefaultTenantId;
  const processingState = processingStateByBackend[backendTarget];
  const runtimeState = runtimeStateByBackend[backendTarget];
  const catalogState = catalogStateByBackend[backendTarget];
  const purgeBusyId = purgeBusyIdByBackend[backendTarget];
  const tenantError = tenantErrorByBackend[backendTarget];

  const apiBaseUrl = useMemo(() => {
    if (backendTarget === "python") return pythonBase;
    if (backendTarget === "aws") return awsBase;
    if (backendTarget === "aws-python") return awsPythonBase;
    return nodeBase;
  }, [backendTarget, pythonBase, awsBase, awsPythonBase, nodeBase]);

  const apiKey =
    backendTarget === "python"
      ? pythonApiKey
      : backendTarget === "aws" || backendTarget === "aws-python"
        ? awsApiKey
        : nodeApiKey;

  const effectiveTenantId = tenantId.trim() || backendDefaultTenantId;
  const chatSessionId = useMemo(
    () => buildTenantChatSessionId(effectiveTenantId),
    [effectiveTenantId]
  );
  const chatMessages =
    chatMessagesByTenant[effectiveTenantId] ?? initialChatMessages;
  const chatSummaryMemory = chatSummaryMemoryByTenant[effectiveTenantId] ?? "";
  const searchOnlyMode =
    runtimeState.runtimeConfigStatus === "ok" && runtimeState.runtimeConfig
      ? !runtimeState.runtimeConfig.openAiChatConfigured
      : false;

  const updateProcessingState = useCallback(
    (
      target: BackendTarget,
      updater: (current: BackendProcessingState) => BackendProcessingState
    ) => {
      setProcessingStateByBackend(prev => ({
        ...prev,
        [target]: updater(prev[target])
      }));
    },
    []
  );

  const loadCatalog = useCallback(
    async (options?: { silent?: boolean }) => {
      const activeBackend = backendTarget;
      const labels = BACKEND_RESOURCE_LABELS[activeBackend];
      if (!options?.silent) {
        setCatalogStateByBackend(prev => ({
          ...prev,
          [activeBackend]: {
            ...prev[activeBackend],
            catalogStatus: "loading",
            catalogMessage: `Reading ${labels.metadataLabel} and ${labels.searchLabel}…`
          }
        }));
      }

      try {
        const response = await fetch(
          `${apiBaseUrl}/documents/catalog?tenantId=${encodeURIComponent(effectiveTenantId)}`,
          {
            headers: {
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            }
          }
        );
        const text = await response.text();
        if (!response.ok) {
          throw new Error(extractApiMessage(text, `HTTP ${response.status}`));
        }

        const payload = JSON.parse(text) as CatalogResponse;
        setCatalogStateByBackend(prev => ({
          ...prev,
          [activeBackend]: {
            catalogRows: payload.documents,
            catalogStatus: "ok",
            catalogMessage: `${labels.metadataLabel} ${payload.sources.cosmos ? "ON" : "OFF"} · ${labels.searchLabel} ${payload.sources.search ? "ON" : "OFF"} · ${payload.documents.length} doc(s)`
          }
        }));
        setTenantErrorByBackend(prev => ({ ...prev, [activeBackend]: "" }));
      } catch (error) {
        const message = resolveFetchErrorMessage(
          error,
          activeBackend,
          apiBaseUrl,
          "Could not load catalog."
        );
        setCatalogStateByBackend(prev => ({
          ...prev,
          [activeBackend]: {
            catalogRows: [],
            catalogStatus: "error",
            catalogMessage: message
          }
        }));
        if (message.includes("tenantId is not allowed")) {
          setTenantErrorByBackend(prev => ({
            ...prev,
            [activeBackend]: message
          }));
        }
      }
    },
    [backendTarget, apiBaseUrl, effectiveTenantId, apiKey]
  );

  const refreshCatalogWithRetries = useCallback(
    async (attempts = 4, intervalMs = 350, silent = true) => {
      for (let i = 0; i < attempts; i += 1) {
        await loadCatalog({ silent });
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
      const activeBackend = backendTarget;
      setRuntimeStateByBackend(prev => ({
        ...prev,
        [activeBackend]: {
          ...prev[activeBackend],
          runtimeConfigStatus: "loading"
        }
      }));
      setRuntimeErrorMessageByBackend(prev => ({
        ...prev,
        [activeBackend]: ""
      }));

      try {
        const response = await fetch(`${apiBaseUrl}/flags/deployment`, {
          headers: {
            ...(apiKey ? { "x-functions-key": apiKey } : {})
          }
        });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const payload = (await response.json()) as RuntimeConfigSnapshot;
        if (!cancelled) {
          setRuntimeStateByBackend(prev => ({
            ...prev,
            [activeBackend]: {
              runtimeConfig: payload,
              runtimeConfigStatus: "ok"
            }
          }));
          setRuntimeErrorMessageByBackend(prev => ({
            ...prev,
            [activeBackend]: ""
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeStateByBackend(prev => ({
            ...prev,
            [activeBackend]: {
              runtimeConfig: null,
              runtimeConfigStatus: "error"
            }
          }));
          setRuntimeErrorMessageByBackend(prev => ({
            ...prev,
            [activeBackend]: resolveFetchErrorMessage(
              error,
              activeBackend,
              apiBaseUrl,
              "Could not load backend flags."
            )
          }));
        }
      }
    };

    void loadRuntime();
    return () => {
      cancelled = true;
    };
  }, [backendTarget, apiBaseUrl, apiKey]);

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
    const trackedDocument = processingState.trackedDocument;
    if (!trackedDocument) {
      return;
    }

    const activeBackend = backendTarget;
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
          `${apiBaseUrl}/documents/${trackedDocument.documentId}?tenantId=${trackedDocument.tenantId}`,
          {
            headers: {
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            }
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            consecutiveNotFoundCount += 1;
            if (
              consecutiveNotFoundCount >= maxNotFoundRetries &&
              !isCancelled
            ) {
              updateProcessingState(activeBackend, current => ({
                ...current,
                trackedDocument: null,
                uploadMessage:
                  "Upload completed but status metadata is not ready. Refresh catalog or re-upload if this persists."
              }));
              void refreshCatalogWithRetries(2, 400, true);
            }
          }
          return;
        }

        consecutiveNotFoundCount = 0;
        const payload = (await response.json()) as DocumentStatusResponse;
        if (isCancelled) {
          return;
        }

        updateProcessingState(activeBackend, current => ({
          ...current,
          documents: current.documents.map(item =>
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
        }));

        if (payload.status === "processing") {
          updateProcessingState(activeBackend, current => ({
            ...current,
            uploadMessage: "Processing document..."
          }));
        } else if (payload.status === "chunked") {
          updateProcessingState(activeBackend, current => ({
            ...current,
            uploadMessage: "Text extraction and chunking complete."
          }));
        } else if (payload.status === "indexed") {
          updateProcessingState(activeBackend, current => ({
            ...current,
            uploadMessage: "Indexing complete."
          }));
        } else if (payload.status === "skipped") {
          updateProcessingState(activeBackend, current => ({
            ...current,
            uploadMessage: "This format is handled in a later step."
          }));
        } else if (payload.status === "failed") {
          updateProcessingState(activeBackend, current => ({
            ...current,
            uploadMessage: payload.errorMessage
              ? `Processing failed: ${payload.errorMessage}`
              : "Document processing failed."
          }));
        }

        if (terminalStatuses.has(payload.status)) {
          updateProcessingState(activeBackend, current => ({
            ...current,
            trackedDocument: null
          }));
          await refreshCatalogWithRetries(3, 500, true);
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
    processingState.trackedDocument,
    backendTarget,
    apiBaseUrl,
    apiKey,
    refreshCatalogWithRetries,
    updateProcessingState
  ]);

  const onTenantIdChange = useCallback(
    (value: string) => {
      setTenantIdByBackend(prev => ({ ...prev, [backendTarget]: value }));
      if (tenantError) {
        setTenantErrorByBackend(prev => ({ ...prev, [backendTarget]: "" }));
      }
    },
    [backendTarget, tenantError]
  );

  const onBackendTargetChange = useCallback(
    (nextBackend: BackendTarget) => {
      if (nextBackend === backendTarget) {
        return;
      }

      const currentIsAws = isAwsBackend(backendTarget);
      const nextIsAws = isAwsBackend(nextBackend);

      // Keep the current tenant when switching within one cloud family.
      if (currentIsAws === nextIsAws) {
        setTenantIdByBackend(prev => {
          const currentTenant =
            prev[backendTarget] ?? TENANT_OPTIONS_BY_BACKEND[backendTarget][0];
          const allowedForNext = TENANT_OPTIONS_BY_BACKEND[nextBackend];
          return {
            ...prev,
            [nextBackend]: allowedForNext.includes(currentTenant)
              ? currentTenant
              : allowedForNext[0]
          };
        });
      }

      setBackendTarget(nextBackend);
    },
    [backendTarget]
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      setSelectedFile(file);
      updateProcessingState(backendTarget, current => ({
        ...current,
        uploadState: "idle",
        uploadMessage: file ? `${file.name} selected.` : "Please choose a file."
      }));
    },
    [backendTarget, updateProcessingState]
  );

  const startUpload = useCallback(async () => {
    const activeBackend = backendTarget;
    const labels = BACKEND_RESOURCE_LABELS[activeBackend];
    if (!selectedFile) {
      updateProcessingState(activeBackend, current => ({
        ...current,
        uploadState: "error",
        uploadMessage: "Please choose a file to upload first."
      }));
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

    updateProcessingState(activeBackend, current => ({
      ...current,
      documents: [tempItem, ...current.documents]
    }));

    try {
      updateProcessingState(activeBackend, current => ({
        ...current,
        uploadState: "requesting-sas",
        uploadMessage: `Requesting ${labels.uploadUrlLabel}...`
      }));

      const sasResponse = await fetch(`${apiBaseUrl}/uploads/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-functions-key": apiKey } : {})
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
      updateProcessingState(activeBackend, current => ({
        ...current,
        uploadState: "uploading",
        uploadMessage: `Uploading directly to ${labels.storageLabel}...`
      }));

      const effectiveUploadUrl =
        import.meta.env.DEV && sasPayload.uploadUrl.includes("127.0.0.1:10000")
          ? (() => {
              const u = new URL(sasPayload.uploadUrl);
              return u.pathname + u.search;
            })()
          : sasPayload.uploadUrl;

      const uploadHeaders: Record<string, string> = isAwsBackend(activeBackend)
        ? {
            "Content-Type": selectedFile.type || "application/octet-stream"
          }
        : {
            "x-ms-blob-type": "BlockBlob",
            "Content-Type": selectedFile.type || "application/octet-stream"
          };

      const uploadResponse = await fetch(effectiveUploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
        body: selectedFile
      });

      if (!uploadResponse.ok) {
        const responseText = await uploadResponse.text();
        throw new Error(
          `Blob direct upload failed (${uploadResponse.status}) ${responseText}`
        );
      }

      if (backendTarget === "aws" || backendTarget === "aws-python") {
        await fetch(`${apiBaseUrl}/uploads/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: sasPayload.tenantId,
            documentId: sasPayload.documentId,
            blobName: sasPayload.blobName
          })
        });
      }

      updateProcessingState(activeBackend, current => ({
        ...current,
        documents: current.documents.map(item =>
          item.id === tempId
            ? {
                ...item,
                id: sasPayload.documentId,
                tenantId: sasPayload.tenantId,
                status: "queued",
                updatedAt: "just now"
              }
            : item
        ),
        trackedDocument: {
          documentId: sasPayload.documentId,
          tenantId: sasPayload.tenantId
        },
        uploadState: "done",
        uploadMessage: "Upload complete. Status will show as queued."
      }));
      setTenantErrorByBackend(prev => ({ ...prev, [activeBackend]: "" }));
    } catch (error) {
      updateProcessingState(activeBackend, current => ({
        ...current,
        documents: current.documents.map(item =>
          item.id === tempId ? { ...item, status: "failed" } : item
        ),
        uploadState: "error"
      }));

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (errorMessage.includes("tenantId is not allowed")) {
        setTenantErrorByBackend(prev => ({
          ...prev,
          [activeBackend]: "tenantId is not allowed for this deployment."
        }));
      }
      updateProcessingState(activeBackend, current => ({
        ...current,
        uploadMessage: `Upload error: ${errorMessage} (API: ${apiBaseUrl}/uploads/create)`
      }));
    }
  }, [
    backendTarget,
    selectedFile,
    updateProcessingState,
    effectiveTenantId,
    apiBaseUrl,
    apiKey
  ]);

  const sendChat = useCallback(async () => {
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

      const requestBody = JSON.stringify({
        tenantId: effectiveTenantId,
        question,
        sessionId: chatSessionId,
        summaryMemory: chatSummaryMemory,
        messages: messagesForMemory
      });

      const maxAttempts = 3;
      let response: Response | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          response = await fetch(`${apiBaseUrl}/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            },
            body: requestBody
          });

          if (response.ok) {
            break;
          }

          const responseText = await response.text();
          const detail = extractApiMessage(
            responseText,
            `HTTP ${response.status}`
          );
          const retryable = CHAT_RETRYABLE_STATUS.has(response.status);
          if (retryable && attempt < maxAttempts) {
            await waitMs(250 * attempt);
            continue;
          }

          throw new Error(`Chat request failed (${response.status}) ${detail}`);
        } catch (error) {
          if (isRetryableChatFetchError(error) && attempt < maxAttempts) {
            await waitMs(250 * attempt);
            continue;
          }
          throw error;
        }
      }

      if (!response?.ok) {
        throw new Error("Chat request failed (503) Service temporarily unavailable.");
      }

      const payload = (await response.json()) as ChatResponse;
      setTenantErrorByBackend(prev => ({ ...prev, [backendTarget]: "" }));

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
        setTenantErrorByBackend(prev => ({
          ...prev,
          [backendTarget]: "tenantId is not allowed for this deployment."
        }));
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
  }, [
    chatInput,
    chatPending,
    chatMessagesByTenant,
    effectiveTenantId,
    apiBaseUrl,
    apiKey,
    chatSessionId,
    chatSummaryMemory,
    backendTarget
  ]);

  const registerTextKnowledge = useCallback(async () => {
    const content = textContent.trim();
    if (!content) {
      updateProcessingState(backendTarget, current => ({
        ...current,
        textIngestState: "error",
        textIngestMessage: "Please enter text content first."
      }));
      return;
    }

    const tempId = `text-temp-${Date.now()}`;
    const displayTitle = textTitle.trim() || "manual-note.txt";
    updateProcessingState(backendTarget, current => ({
      ...current,
      documents: [
        {
          id: tempId,
          fileName: displayTitle,
          status: "processing",
          updatedAt: "just now",
          tenantId: effectiveTenantId
        },
        ...current.documents
      ]
    }));

    try {
      const searchLabel = BACKEND_RESOURCE_LABELS[backendTarget].searchLabel;
      updateProcessingState(backendTarget, current => ({
        ...current,
        textIngestState: "submitting",
        textIngestMessage: `Registering text in ${searchLabel}...`
      }));

      const response = await fetch(`${apiBaseUrl}/knowledge/text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-functions-key": apiKey } : {})
        },
        body: JSON.stringify({
          tenantId: effectiveTenantId,
          title: textTitle.trim() || undefined,
          text: content
        })
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          extractApiMessage(responseText, `HTTP ${response.status}`)
        );
      }

      const payload = JSON.parse(responseText) as CreateTextKnowledgeResponse;
      updateProcessingState(backendTarget, current => ({
        ...current,
        documents: current.documents.map(item =>
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
        ),
        textIngestState: "done",
        textIngestMessage: payload.indexed
          ? `Registered ${payload.chunkCount} chunk(s) to ${searchLabel}.`
          : `Text chunked (${payload.chunkCount}) but ${searchLabel} indexing is disabled.`
      }));

      setTextTitle("");
      setTextContent("");
      setTenantErrorByBackend(prev => ({ ...prev, [backendTarget]: "" }));
      await refreshCatalogWithRetries(2, 350, true);
    } catch (error) {
      updateProcessingState(backendTarget, current => ({
        ...current,
        documents: current.documents.map(item =>
          item.id === tempId ? { ...item, status: "failed" } : item
        )
      }));

      const message =
        error instanceof Error ? error.message : "Text registration failed.";
      if (message.includes("tenantId is not allowed")) {
        setTenantErrorByBackend(prev => ({
          ...prev,
          [backendTarget]: "tenantId is not allowed for this deployment."
        }));
      }
      updateProcessingState(backendTarget, current => ({
        ...current,
        textIngestState: "error",
        textIngestMessage: message
      }));
    }
  }, [
    textContent,
    backendTarget,
    updateProcessingState,
    textTitle,
    effectiveTenantId,
    apiBaseUrl,
    apiKey,
    refreshCatalogWithRetries
  ]);

  const handlePurgeDocument = useCallback(
    async (documentId: string) => {
      const labels = BACKEND_RESOURCE_LABELS[backendTarget];
      const confirmed = window.confirm(
        `Document ID "${documentId}"\n\nThis removes ${labels.searchLabel} chunks and ${labels.metadataLabel} metadata for this tenant. The object in ${labels.storageLabel} is left unchanged. Continue?`
      );
      if (!confirmed) {
        return;
      }

      setPurgeBusyIdByBackend(prev => ({
        ...prev,
        [backendTarget]: documentId
      }));
      try {
        const response = await fetch(
          `${apiBaseUrl}/documents/${encodeURIComponent(documentId)}/purge?tenantId=${encodeURIComponent(effectiveTenantId)}`,
          {
            method: "DELETE",
            headers: {
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            }
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(extractApiMessage(text, `HTTP ${response.status}`));
        }

        let purgePayload: PurgeResponse | null = null;
        try {
          purgePayload = JSON.parse(text) as PurgeResponse;
        } catch {
          // The API currently responds with JSON; keep resilient parsing.
        }

        const attempts =
          purgePayload && (purgePayload.remainingSearchChunks ?? 0) > 0 ? 6 : 4;
        await refreshCatalogWithRetries(attempts, 350, true);
        setTenantErrorByBackend(prev => ({ ...prev, [backendTarget]: "" }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Delete failed.";
        if (message.includes("tenantId is not allowed")) {
          setTenantErrorByBackend(prev => ({
            ...prev,
            [backendTarget]: "tenantId is not allowed for this deployment."
          }));
        }
        window.alert(message);
      } finally {
        setPurgeBusyIdByBackend(prev => ({ ...prev, [backendTarget]: null }));
      }
    },
    [
      backendTarget,
      apiBaseUrl,
      effectiveTenantId,
      apiKey,
      refreshCatalogWithRetries
    ]
  );

  const handleViewDocumentSource = useCallback(
    async (documentId: string): Promise<DocumentSourceResponse> => {
      const response = await fetch(
        `${apiBaseUrl}/documents/${encodeURIComponent(documentId)}/source?tenantId=${encodeURIComponent(effectiveTenantId)}`,
        {
          headers: {
            ...(apiKey ? { "x-functions-key": apiKey } : {})
          }
        }
      );

      const text = await response.text();
      if (!response.ok) {
        throw new Error(extractApiMessage(text, `HTTP ${response.status}`));
      }

      return JSON.parse(text) as DocumentSourceResponse;
    },
    [apiBaseUrl, effectiveTenantId, apiKey]
  );

  return {
    backendTarget,
    setBackendTarget: onBackendTargetChange,
    tenantId,
    tenantError,
    apiBaseUrl,
    runtimeConfig: runtimeState.runtimeConfig,
    runtimeConfigStatus: runtimeState.runtimeConfigStatus,
    runtimeErrorMessage: runtimeErrorMessageByBackend[backendTarget],
    searchOnlyMode,
    uploadState: processingState.uploadState,
    uploadMessage: processingState.uploadMessage,
    effectiveTenantId,
    documents: processingState.documents,
    textTitle,
    setTextTitle,
    textContent,
    setTextContent,
    textIngestState: processingState.textIngestState,
    textIngestMessage: processingState.textIngestMessage,
    chatMessages,
    chatInput,
    chatPending,
    setChatInput,
    catalogRows: catalogState.catalogRows,
    catalogStatus: catalogState.catalogStatus,
    catalogMessage: catalogState.catalogMessage,
    purgeBusyId,
    onTenantIdChange,
    onFileChange,
    startUpload,
    sendChat,
    registerTextKnowledge,
    loadCatalog,
    handlePurgeDocument,
    handleViewDocumentSource
  };
}
