import { useCallback, useEffect, useMemo, useState } from "react";

type DocumentStatus =
  | "waiting"
  | "uploading"
  | "queued"
  | "processing"
  | "chunked"
  | "skipped"
  | "indexed"
  | "failed";

type DocumentItem = {
  id: string;
  fileName: string;
  status: DocumentStatus;
  updatedAt: string;
  tenantId?: string;
  contentLength?: number;
  chunkCount?: number;
  errorMessage?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
};

type ChatResponse = {
  answer: string;
  citations: Array<{
    documentId: string;
    fileName: string;
    blobName: string;
    chunkIndex: number;
    snippet: string;
    score?: number;
  }>;
  usage: {
    tenantId: string;
    retrievedChunks: number;
  };
};

type UploadState = "idle" | "requesting-sas" | "uploading" | "done" | "error";

type CreateUploadResponse = {
  documentId: string;
  tenantId: string;
  blobName: string;
  uploadUrl: string;
  expiresInMinutes: number;
};

type DocumentStatusResponse = {
  id: string;
  documentId: string;
  tenantId: string;
  blobName: string;
  status: Exclude<DocumentStatus, "waiting" | "uploading">;
  contentType?: string;
  contentLength?: number;
  chunkCount?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

type RuntimeConfigSnapshot = {
  cosmosDbEnabled: boolean;
  searchEnabled: boolean;
  embeddingPipelineEnabled: boolean;
  chatSearchMode: "keyword" | "hybrid" | "vector";
  ocrEnabled: boolean;
  openAiChatConfigured: boolean;
  tenantAllowlistActive: boolean;
};

function searchModeLabel(mode: RuntimeConfigSnapshot["chatSearchMode"]): string {
  switch (mode) {
    case "keyword":
      return "keyword";
    case "vector":
      return "vector";
    default:
      return "hybrid";
  }
}

type CatalogCosmos = {
  status: string;
  updatedAt: string;
  chunkCount?: number;
  contentType?: string;
};

type CatalogSearch = {
  chunkCount: number;
  fileName: string;
  blobName: string;
};

type CatalogDocumentRow = {
  documentId: string;
  tenantId: string;
  fileName: string;
  blobName: string;
  cosmos: CatalogCosmos | null;
  search: CatalogSearch | null;
};

type CatalogResponse = {
  tenantId: string;
  documents: CatalogDocumentRow[];
  sources: { cosmos: boolean; search: boolean };
};

const initialChatMessages: ChatMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    content:
      "I only search documents uploaded for this tenant. Upload on the left, then ask a question."
  }
];

const statusLabel: Record<DocumentStatus, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  queued: "Queued",
  processing: "Processing",
  chunked: "Chunked",
  skipped: "Skipped",
  indexed: "Indexed",
  failed: "Failed"
};

function relativeTimeLabel(input: string): string {
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

function App() {
  const defaultTenantId = useMemo(
    () => (import.meta.env.VITE_TENANT_ID?.trim() || "tenant-a").trim(),
    []
  );
  const [tenantId, setTenantId] = useState<string>(defaultTenantId);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [chatMessages, setChatMessages] =
    useState<ChatMessage[]>(initialChatMessages);
  const [chatInput, setChatInput] = useState<string>("");
  const [chatPending, setChatPending] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState<string>(
    "Choose a file and start upload."
  );
  const [trackedDocument, setTrackedDocument] = useState<{
    documentId: string;
    tenantId: string;
  } | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigSnapshot | null>(
    null
  );
  const [runtimeConfigStatus, setRuntimeConfigStatus] = useState<
    "loading" | "ok" | "error"
  >("loading");
  const [catalogRows, setCatalogRows] = useState<CatalogDocumentRow[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<
    "idle" | "loading" | "error" | "ok"
  >("loading");
  const [catalogMessage, setCatalogMessage] = useState<string>("");
  const [purgeBusyId, setPurgeBusyId] = useState<string | null>(null);

  const uploadApiBaseUrl = useMemo(() => {
    const fromEnv = import.meta.env.VITE_UPLOAD_API_BASE_URL?.trim();
    if (fromEnv) {
      return fromEnv.replace(/\/$/, "");
    }
    // `npm run dev`: Vite proxies `/api` → 127.0.0.1:7071 (avoids CORS / host mismatch)
    if (import.meta.env.DEV) {
      return "/api";
    }
    return "http://localhost:7071/api";
  }, []);

  const uploadApiKey = useMemo(
    () => import.meta.env.VITE_UPLOAD_API_KEY?.trim() ?? "",
    []
  );

  const effectiveTenantId = tenantId.trim() || defaultTenantId;

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
        throw new Error(text || `HTTP ${response.status}`);
      }
      const payload = JSON.parse(text) as CatalogResponse;
      setCatalogRows(payload.documents);
      setCatalogStatus("ok");
      setCatalogMessage(
        `Cosmos ${payload.sources.cosmos ? "ON" : "OFF"} · Search ${
          payload.sources.search ? "ON" : "OFF"
        } · ${payload.documents.length} doc(s)`
      );
    } catch (error) {
      setCatalogRows([]);
      setCatalogStatus("error");
      setCatalogMessage(
        error instanceof Error ? error.message : "Could not load catalog."
      );
    }
  }, [effectiveTenantId, uploadApiBaseUrl, uploadApiKey]);

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
    if (!trackedDocument) {
      return;
    }

    let isCancelled = false;
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
          return;
        }

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
  }, [trackedDocument, uploadApiBaseUrl, uploadApiKey]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setUploadState("idle");
    setUploadMessage(
      file ? `${file.name} selected.` : "Please choose a file."
    );
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
        throw new Error(
          `Failed to get SAS URL (${sasResponse.status}) ${responseText}`
        );
      }

      const sasPayload = (await sasResponse.json()) as CreateUploadResponse;

      setUploadState("uploading");
      setUploadMessage("Uploading directly to Blob Storage...");

      // Dev: use Vite proxy for Azurite (relative path) to avoid CORS on blob PUT
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

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question
    };

    setChatMessages(prev => [...prev, userMessage]);
    setChatInput("");
    setChatPending(true);

    try {
      const response = await fetch(`${uploadApiBaseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(uploadApiKey ? { "x-functions-key": uploadApiKey } : {})
        },
        body: JSON.stringify({
          tenantId: effectiveTenantId,
          question
        })
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Chat request failed (${response.status}) ${responseText}`);
      }

      const payload = (await response.json()) as ChatResponse;
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: payload.answer,
        citations: payload.citations.map(
          citation =>
            `${citation.fileName} · chunk ${citation.chunkIndex + 1}`
        )
      };

      setChatMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      setChatMessages(prev => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: `Could not process your question. ${errorMessage}`
        }
      ]);
    } finally {
      setChatPending(false);
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
        throw new Error(text || `HTTP ${response.status}`);
      }
      await loadCatalog();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Delete failed."
      );
    } finally {
      setPurgeBusyId(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Azure-native RAG demo</p>
          <h1>Upload, index, and chat in one screen</h1>
          <p className="hero-copy">
            Upload to Blob with a SAS token, process asynchronously via a queue,
            retrieve with Azure AI Search, and—depending on configuration—try
            embeddings, hybrid search, and generative answers. The box on the
            right reflects your Functions deployment flags. If{" "}
            <code className="inline-code">ALLOWED_TENANT_IDS</code> is empty,
            any tenant ID is accepted; otherwise only listed IDs are allowed.
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
                <p className="hero-stat-sub">
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
                <p className="hero-stat-sub">
                  {runtimeConfig.openAiChatConfigured
                    ? "OPENAI_API_KEY set — GPT-style answers"
                    : "No OPENAI_API_KEY — index snippets only"}
                </p>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="tenant-context-bar">
        <div className="tenant-context-row">
          <label className="tenant-context-label" htmlFor="tenant-id">
            Tenant ID
          </label>
          <input
            id="tenant-id"
            className="tenant-context-input"
            type="text"
            value={tenantId}
            onChange={event => setTenantId(event.target.value)}
            placeholder={defaultTenantId}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="tenant-context-desc"
          />
          <span className="tenant-context-sep" aria-hidden="true">
            →
          </span>
          <code className="tenant-context-id" title="Value sent to the API">
            {effectiveTenantId}
          </code>
        </div>
        <p id="tenant-context-desc" className="tenant-context-desc">
          Upload, blob path, indexing, chat retrieval, catalog, and purge all use
          the <strong>same</strong> tenant. Leave blank for default{" "}
          <code className="inline-code">{defaultTenantId}</code> from{" "}
          <code className="inline-code">VITE_TENANT_ID</code>.
        </p>
      </div>

      <main className="main-stack">
        <div className="workspace-grid">
        <section className="panel panel-upload">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Upload</p>
              <h2>Document upload</h2>
            </div>
            <span className="panel-tag">SAS direct upload</span>
          </div>

          <label className="dropzone" htmlFor="file-upload">
            <input id="file-upload" type="file" onChange={onFileChange} />
            <span className="dropzone-icon">+</span>
            <strong>Choose PDF, PNG, or JPG</strong>
            <p>
              After you start upload, the app requests a SAS URL and the browser
              PUTs the file to Blob Storage. PNG and JPEG can be OCR’d on the
              server for text.
            </p>
          </label>

          <div className="upload-actions">
            <button type="button" onClick={startUpload}>
              Start upload
            </button>
            <p className={`upload-hint upload-${uploadState}`}>
              {uploadMessage}
            </p>
          </div>

          <div className="upload-meta-grid">
            <div className="meta-card">
              <span>Blob path prefix</span>
              <strong>{effectiveTenantId}/YYYY/MM/</strong>
            </div>
            <div className="meta-card">
              <span>API base URL</span>
              <strong>{uploadApiBaseUrl}</strong>
            </div>
          </div>

          <div className="timeline-card">
            <div className="timeline-header">
              <h3>Processing status</h3>
              <span>Recent uploads</span>
            </div>

            <ul className="document-list">
              {documents.map(item => (
                <li key={item.id} className="document-row">
                  <div>
                    <strong>{item.fileName}</strong>
                    <p>{item.updatedAt}</p>
                  </div>
                  <span className={`status-pill status-${item.status}`}>
                    {statusLabel[item.status]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="panel panel-chat">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Chat</p>
              <h2>RAG chatbot</h2>
            </div>
            <span className="panel-tag">Tenant-scoped search</span>
          </div>

          <div className="chat-stream">
            {chatMessages.map(message => (
              <article
                key={message.id}
                className={`message message-${message.role}`}
              >
                <span className="message-role">
                  {message.role === "user" ? "You" : "Assistant"}
                </span>
                <p>{message.content}</p>
                {message.citations?.length ? (
                  <small>Sources: {message.citations.join(" / ")}</small>
                ) : null}
              </article>
            ))}
          </div>

          <form
            className="chat-composer"
            onSubmit={event => {
              event.preventDefault();
              void sendChat();
            }}
          >
            <label className="composer-label" htmlFor="chat-input">
              Your question
            </label>
            <textarea
              id="chat-input"
              rows={4}
              placeholder="e.g. What does the contract say about termination?"
              value={chatInput}
              onChange={event => setChatInput(event.target.value)}
              disabled={chatPending}
            />
            <div className="composer-actions">
              <div className="composer-hint">
                Answers use retrieved chunks from Search first; generative mode
                matches the “Chat answers” flag above.
              </div>
              <button type="submit" disabled={chatPending || !chatInput.trim()}>
                {chatPending ? "Working…" : "Send question"}
              </button>
            </div>
          </form>
        </section>
        </div>

        <section className="panel catalog-panel" aria-labelledby="catalog-heading">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Admin</p>
              <h2 id="catalog-heading">Cosmos · Search document catalog</h2>
            </div>
            <div className="catalog-actions">
              <button type="button" onClick={() => void loadCatalog()}>
                Refresh list
              </button>
            </div>
          </div>
          <p
            className={`catalog-meta ${
              catalogStatus === "error" ? "catalog-error" : ""
            } ${catalogStatus === "ok" ? "catalog-ok" : ""}`}
          >
            {catalogStatus === "loading"
              ? "Loading catalog…"
              : catalogMessage || "Merged rows for the current tenant."}
          </p>
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th scope="col">documentId</th>
                  <th scope="col">File</th>
                  <th scope="col">Cosmos</th>
                  <th scope="col">Search chunks</th>
                  <th scope="col">Delete</th>
                </tr>
              </thead>
              <tbody>
                {catalogRows.length === 0 && catalogStatus === "ok" ? (
                  <tr>
                    <td colSpan={5} className="catalog-empty">
                      No documents for this tenant. Upload files or switch
                      tenant.
                    </td>
                  </tr>
                ) : null}
                {catalogRows.map(row => (
                  <tr key={row.documentId}>
                    <td className="mono">{row.documentId}</td>
                    <td>{row.fileName}</td>
                    <td>
                      {row.cosmos ? (
                        <>
                          {row.cosmos.status}
                          <br />
                          <small className="catalog-sub">
                            {row.cosmos.chunkCount != null
                              ? `${row.cosmos.chunkCount} chunks · `
                              : ""}
                            {row.cosmos.updatedAt?.slice(0, 19) ?? ""}
                          </small>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {row.search ? (
                        <>{row.search.chunkCount} chunks</>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={
                          purgeBusyId !== null || (!row.cosmos && !row.search)
                        }
                        onClick={() => void handlePurgeDocument(row.documentId)}
                      >
                        {purgeBusyId === row.documentId
                          ? "Deleting…"
                          : "Purge index data"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="catalog-footnote">
            Purge removes AI Search chunks and Cosmos metadata only. Blobs in
            storage are not deleted.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
