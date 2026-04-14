import { useEffect, useMemo, useState } from "react";

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

const documentQueue: DocumentItem[] = [
  {
    id: "doc-001",
    fileName: "tenant-a-contract.pdf",
    status: "indexed",
    updatedAt: "방금 전"
  },
  {
    id: "doc-002",
    fileName: "invoice-april.png",
    status: "processing",
    updatedAt: "2분 전"
  },
  {
    id: "doc-003",
    fileName: "handbook-2026.pdf",
    status: "queued",
    updatedAt: "5분 전"
  }
];

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

const initialChatMessages: ChatMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    content:
      "업로드된 문서를 tenant 범위로 검색해 답변합니다. 먼저 문서를 업로드한 뒤 질문을 입력하세요."
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
  const [documents, setDocuments] = useState<DocumentItem[]>(documentQueue);
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

  const uploadApiBaseUrl = useMemo(
    () =>
      import.meta.env.VITE_UPLOAD_API_BASE_URL ?? "http://localhost:7071/api",
    []
  );

  const uploadApiKey = useMemo(
    () => import.meta.env.VITE_UPLOAD_API_KEY?.trim() ?? "",
    []
  );

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
      tenantId: "tenant-a"
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
          tenantId: "tenant-a",
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
          tenantId: "tenant-a",
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
          citation => `${citation.fileName} · chunk ${citation.chunkIndex + 1}`
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

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Azure-native RAG Demo</p>
          <h1>문서 업로드부터 검색형 챗봇까지 한 화면에서 확인하는 첫 셸</h1>
          <p className="hero-copy">
            업로드, 큐 처리, 문서 인덱싱, tenant 범위 검색형 채팅까지 로컬에서
            이어지는 흐름을 확인한다. 다음 단계에서는 Azure OpenAI 생성 답변과
            하이브리드 검색으로 확장한다.
          </p>
        </div>
        <div className="hero-stats">
          <div>
            <span>현재 단계</span>
            <strong>Step 8</strong>
          </div>
          <div>
            <span>범위</span>
            <strong>Upload + Index + Search Chat</strong>
          </div>
          <div>
            <span>다음 연결</span>
            <strong>Azure OpenAI / Hybrid RAG</strong>
          </div>
        </div>
      </header>

      <main className="workspace-grid">
        <section className="panel panel-upload">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Upload</p>
              <h2>문서 업로드</h2>
            </div>
            <span className="panel-tag">SAS direct upload 연결됨</span>
          </div>

          <label className="dropzone" htmlFor="file-upload">
            <input id="file-upload" type="file" onChange={onFileChange} />
            <span className="dropzone-icon">+</span>
            <strong>PDF, PNG, JPG 문서를 선택</strong>
            <p>
              업로드 버튼을 누르면 SAS URL을 발급받은 뒤 브라우저에서 Blob
              Storage로 직접 업로드한다
            </p>
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
              <span>Tenant</span>
              <strong>tenant-a</strong>
            </div>
            <div className="meta-card">
              <span>Storage path</span>
              <strong>tenant-a/2026/04/</strong>
            </div>
            <div className="meta-card">
              <span>Next API</span>
              <strong>{uploadApiBaseUrl}/uploads/create</strong>
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
              <p className="panel-kicker">Chat</p>
              <h2>RAG 챗봇</h2>
            </div>
            <span className="panel-tag">Tenant-filtered retrieval</span>
          </div>

          <div className="chat-stream">
            {chatMessages.map(message => (
              <article
                key={message.id}
                className={`message message-${message.role}`}
              >
                <span className="message-role">
                  {message.role === "user" ? "User" : "Assistant"}
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
                현재 응답은 Azure AI Search 검색 결과를 요약해 보여준다. 다음
                단계에서 Azure OpenAI 생성 답변과 대화 이력을 연결한다.
              </div>
              <button type="submit" disabled={chatPending || !chatInput.trim()}>
                {chatPending ? "질문 처리 중..." : "질문 보내기"}
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

export default App;
