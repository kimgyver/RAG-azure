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
      return "키워드";
    case "vector":
      return "벡터";
    default:
      return "하이브리드";
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
      "같은 테넌트로 올린 문서만 검색해 답합니다. 먼저 왼쪽에서 업로드한 뒤 질문을 입력하세요."
  }
];

const statusLabel: Record<DocumentStatus, string> = {
  waiting: "대기",
  uploading: "업로드 중",
  queued: "큐 등록됨",
  processing: "처리 중",
  chunked: "청킹 완료",
  skipped: "건너뜀",
  indexed: "인덱싱 완료",
  failed: "실패"
};

function relativeTimeLabel(input: string): string {
  const deltaMs = Date.now() - new Date(input).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return "방금 전";
  }

  const minutes = Math.floor(deltaMs / 60000);
  if (minutes <= 0) {
    return "방금 전";
  }
  if (minutes < 60) {
    return `${minutes}분 전`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}시간 전`;
  }

  const days = Math.floor(hours / 24);
  return `${days}일 전`;
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
    "파일을 선택하고 업로드를 시작하세요."
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

  const uploadApiBaseUrl = useMemo(
    () =>
      import.meta.env.VITE_UPLOAD_API_BASE_URL ?? "http://localhost:7071/api",
    []
  );

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
        } · ${payload.documents.length}건`
      );
    } catch (error) {
      setCatalogRows([]);
      setCatalogStatus("error");
      setCatalogMessage(
        error instanceof Error ? error.message : "목록을 불러오지 못했습니다."
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
          setUploadMessage("문서를 처리 중입니다...");
        } else if (payload.status === "chunked") {
          setUploadMessage("문서 텍스트 추출과 청킹이 완료되었습니다.");
        } else if (payload.status === "indexed") {
          setUploadMessage("문서 인덱싱이 완료되었습니다.");
        } else if (payload.status === "skipped") {
          setUploadMessage("현재 문서 형식은 다음 단계에서 처리됩니다.");
        } else if (payload.status === "failed") {
          setUploadMessage(
            payload.errorMessage
              ? `문서 처리 실패: ${payload.errorMessage}`
              : "문서 처리에 실패했습니다."
          );
        }

        if (terminalStatuses.has(payload.status)) {
          setTrackedDocument(null);
        }
      } catch {
        // 폴링 실패는 다음 주기에 재시도한다.
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
      file ? `${file.name} 파일이 선택되었습니다.` : "파일을 선택해 주세요."
    );
  };

  const startUpload = async () => {
    if (!selectedFile) {
      setUploadState("error");
      setUploadMessage("먼저 업로드할 파일을 선택해 주세요.");
      return;
    }

    const tempId = `temp-${Date.now()}`;
    const tempItem: DocumentItem = {
      id: tempId,
      fileName: selectedFile.name,
      status: "uploading",
      updatedAt: "방금 전",
      tenantId: effectiveTenantId
    };

    setDocuments(prev => [tempItem, ...prev]);

    try {
      setUploadState("requesting-sas");
      setUploadMessage("SAS URL을 발급받는 중입니다...");

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
          `SAS URL 발급 실패 (${sasResponse.status}) ${responseText}`
        );
      }

      const sasPayload = (await sasResponse.json()) as CreateUploadResponse;

      setUploadState("uploading");
      setUploadMessage("Blob Storage로 직접 업로드 중입니다...");

      // 개발 모드: Azurite CORS 우회를 위해 Vite proxy 경유 (상대 경로 사용)
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
          `Blob direct upload 실패 (${uploadResponse.status}) ${responseText}`
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
                updatedAt: "방금 전"
              }
            : item
        )
      );
      setTrackedDocument({
        documentId: sasPayload.documentId,
        tenantId: sasPayload.tenantId
      });
      setUploadState("done");
      setUploadMessage("업로드 완료. 큐 등록 대기 상태로 표시됩니다.");
    } catch (error) {
      setDocuments(prev =>
        prev.map(item =>
          item.id === tempId ? { ...item, status: "failed" } : item
        )
      );
      setUploadState("error");
      const errorMessage =
        error instanceof Error ? error.message : "알 수 없는 오류";
      setUploadMessage(
        `업로드 오류: ${errorMessage} (API: ${uploadApiBaseUrl}/uploads/create)`
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
        throw new Error(`채팅 요청 실패 (${response.status}) ${responseText}`);
      }

      const payload = (await response.json()) as ChatResponse;
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: payload.answer,
        citations: payload.citations.map(
          citation =>
            `${citation.fileName} · 청크 ${citation.chunkIndex + 1}`
        )
      };

      setChatMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "알 수 없는 오류";

      setChatMessages(prev => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: `질문을 처리하지 못했습니다. ${errorMessage}`
        }
      ]);
    } finally {
      setChatPending(false);
    }
  };

  const handlePurgeDocument = async (documentId: string) => {
    const confirmed = window.confirm(
      `문서 ID "${documentId}"\n\n이 테넌트의 AI Search 청크와 Cosmos 메타데이터를 삭제합니다. Blob 원본은 남습니다. 계속할까요?`
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
        error instanceof Error ? error.message : "삭제에 실패했습니다."
      );
    } finally {
      setPurgeBusyId(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Azure 네이티브 RAG 데모</p>
          <h1>문서 업로드부터 검색형 챗봇까지 한 화면에서 확인하는 첫 셸</h1>
          <p className="hero-copy">
            SAS로 Blob에 직접 올리고, 큐로 비동기 처리한 뒤 Azure AI Search로
            찾고, 설정에 따라 임베딩·하이브리드 검색과 생성형 답변까지
            이어볼 수 있다. 오른쪽 박스는 실제 Functions 환경 변수와 맞춰
            갱신된다.{" "}
            <code className="inline-code">ALLOWED_TENANT_IDS</code>가 비어
            있으면 아래 테넌트는 자유 입력이고, 값이 있으면 목록에 있는 ID만
            통과한다.
          </p>
        </div>
        <div className="hero-stats">
          {runtimeConfigStatus === "loading" ? (
            <div>
              <span>백엔드 설정</span>
              <strong>불러오는 중…</strong>
            </div>
          ) : runtimeConfigStatus === "error" || !runtimeConfig ? (
            <div>
              <span>백엔드 설정</span>
              <strong>읽기 실패</strong>
              <p className="hero-stat-sub">
                Functions가{" "}
                <code className="inline-code">VITE_UPLOAD_API_BASE_URL</code>에
                떠 있는지, 주소가 맞는지 확인하세요. 업로드·챗은 별도로{" "}
                <code className="inline-code">VITE_UPLOAD_API_KEY</code>가
                필요할 수 있습니다.
              </p>
            </div>
          ) : (
            <>
              <div>
                <span>Cosmos · 문서 상태</span>
                <strong>{runtimeConfig.cosmosDbEnabled ? "켜짐" : "꺼짐"}</strong>
                <p className="hero-stat-sub">
                  {runtimeConfig.tenantAllowlistActive
                    ? "허용 테넌트만 처리 (ALLOWED_TENANT_IDS)"
                    : "테넌트 제한 없음 · 로컬 기본"}
                </p>
              </div>
              <div>
                <span>AI Search · 인덱싱</span>
                <strong>{runtimeConfig.searchEnabled ? "켜짐" : "꺼짐"}</strong>
                <p className="hero-stat-sub">
                  임베딩{" "}
                  {runtimeConfig.embeddingPipelineEnabled ? "사용" : "미사용"} ·
                  챗 {searchModeLabel(runtimeConfig.chatSearchMode)} · 이미지 OCR{" "}
                  {runtimeConfig.ocrEnabled ? "사용" : "꺼짐"}
                </p>
              </div>
              <div>
                <span>챗 답변</span>
                <strong>
                  {runtimeConfig.openAiChatConfigured
                    ? "생성형"
                    : "검색 요약만"}
                </strong>
                <p className="hero-stat-sub">
                  {runtimeConfig.openAiChatConfigured
                    ? "OPENAI_API_KEY 가 있어 GPT로 생성"
                    : "OPENAI_API_KEY 없음 — 인덱스 스니펫 위주"}
                </p>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="main-stack">
        <div className="workspace-grid">
        <section className="panel panel-upload">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">업로드</p>
              <h2>문서 업로드</h2>
            </div>
            <span className="panel-tag">SAS 직접 업로드</span>
          </div>

          <label className="dropzone" htmlFor="file-upload">
            <input id="file-upload" type="file" onChange={onFileChange} />
            <span className="dropzone-icon">+</span>
            <strong>PDF, PNG, JPG 문서를 선택</strong>
            <p>
              업로드 버튼을 누르면 SAS URL을 발급받은 뒤 브라우저에서 Blob
              Storage로 직접 업로드한다. PNG·JPEG 등은 서버에서 OCR로 텍스트를
              뽑을 수 있다.
            </p>
          </label>

          <label className="tenant-field" htmlFor="tenant-id">
            <span>테넌트 ID</span>
            <input
              id="tenant-id"
              type="text"
              value={tenantId}
              onChange={event => setTenantId(event.target.value)}
              placeholder={defaultTenantId}
              spellCheck={false}
              autoComplete="off"
            />
            <small>
              비우면 <strong>{defaultTenantId}</strong>가 쓰이며, 그 값은{" "}
              <code className="inline-code">VITE_TENANT_ID</code>(없으면 위
              기본)에서 온다.
            </small>
          </label>

          <div className="upload-actions">
            <button type="button" onClick={startUpload}>
              업로드 시작
            </button>
            <p className={`upload-hint upload-${uploadState}`}>
              {uploadMessage}
            </p>
          </div>

          <div className="upload-meta-grid">
            <div className="meta-card">
              <span>적용 테넌트</span>
              <strong>{effectiveTenantId}</strong>
            </div>
            <div className="meta-card">
              <span>Blob 경로 접두</span>
              <strong>{effectiveTenantId}/YYYY/MM/</strong>
            </div>
            <div className="meta-card">
              <span>API 베이스 URL</span>
              <strong>{uploadApiBaseUrl}</strong>
            </div>
          </div>

          <div className="timeline-card">
            <div className="timeline-header">
              <h3>처리 상태</h3>
              <span>최근 업로드 문서</span>
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
              <p className="panel-kicker">채팅</p>
              <h2>RAG 챗봇</h2>
            </div>
            <span className="panel-tag">테넌트 단위 검색</span>
          </div>

          <div className="chat-stream">
            {chatMessages.map(message => (
              <article
                key={message.id}
                className={`message message-${message.role}`}
              >
                <span className="message-role">
                  {message.role === "user" ? "사용자" : "어시스턴트"}
                </span>
                <p>{message.content}</p>
                {message.citations?.length ? (
                  <small>근거: {message.citations.join(" / ")}</small>
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
              질문 입력
            </label>
            <textarea
              id="chat-input"
              rows={4}
              placeholder="예: 계약서에서 해지 조항이 어떻게 되어 있어?"
              value={chatInput}
              onChange={event => setChatInput(event.target.value)}
              disabled={chatPending}
            />
            <div className="composer-actions">
              <div className="composer-hint">
                답은 먼저 Search로 근거 청크를 고른 뒤 만들어진다. 생성형 여부는
                위쪽「챗 답변」칸과 같다.
              </div>
              <button type="submit" disabled={chatPending || !chatInput.trim()}>
                {chatPending ? "질문 처리 중..." : "질문 보내기"}
              </button>
            </div>
          </form>
        </section>
        </div>

        <section className="panel catalog-panel" aria-labelledby="catalog-heading">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">관리</p>
              <h2 id="catalog-heading">Cosmos · Search 문서 목록</h2>
            </div>
            <div className="catalog-actions">
              <button type="button" onClick={() => void loadCatalog()}>
                목록 새로고침
              </button>
            </div>
          </div>
          <p
            className={`catalog-meta ${
              catalogStatus === "error" ? "catalog-error" : ""
            } ${catalogStatus === "ok" ? "catalog-ok" : ""}`}
          >
            {catalogStatus === "loading"
              ? "목록을 불러오는 중…"
              : catalogMessage || "현재 테넌트 기준으로 병합된 문서 행입니다."}
          </p>
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th scope="col">documentId</th>
                  <th scope="col">파일</th>
                  <th scope="col">Cosmos</th>
                  <th scope="col">Search 청크</th>
                  <th scope="col">삭제</th>
                </tr>
              </thead>
              <tbody>
                {catalogRows.length === 0 && catalogStatus === "ok" ? (
                  <tr>
                    <td colSpan={5} className="catalog-empty">
                      표시할 문서가 없습니다. 업로드하거나 다른 테넌트를
                      선택해 보세요.
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
                              ? `청크 ${row.cosmos.chunkCount} · `
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
                        <>{row.search.chunkCount}개</>
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
                          ? "삭제 중…"
                          : "데이터 삭제"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="catalog-footnote">
            삭제 시 AI Search 청크와 Cosmos 메타데이터만 제거합니다. Blob
            원본은 그대로입니다.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
