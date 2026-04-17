export type DocumentStatus =
  | "waiting"
  | "uploading"
  | "queued"
  | "processing"
  | "chunked"
  | "skipped"
  | "indexed"
  | "failed";

export type DocumentItem = {
  id: string;
  fileName: string;
  status: DocumentStatus;
  updatedAt: string;
  tenantId?: string;
  contentLength?: number;
  chunkCount?: number;
  errorMessage?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
};

export type ChatResponse = {
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
  memory?: {
    sessionId: string;
    summary: string;
    recentTurnsUsed: number;
  };
};

export type UploadState =
  | "idle"
  | "requesting-sas"
  | "uploading"
  | "done"
  | "error";

export type CreateUploadResponse = {
  documentId: string;
  tenantId: string;
  blobName: string;
  uploadUrl: string;
  expiresInMinutes: number;
};

export type DocumentStatusResponse = {
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

export type RuntimeConfigSnapshot = {
  cosmosDbEnabled: boolean;
  searchEnabled: boolean;
  embeddingPipelineEnabled: boolean;
  chatSearchMode: "keyword" | "hybrid" | "vector";
  ocrEnabled: boolean;
  openAiChatConfigured: boolean;
  tenantAllowlistActive: boolean;
};

export type CatalogCosmos = {
  status: string;
  updatedAt: string;
  chunkCount?: number;
  contentType?: string;
};

export type CatalogSearch = {
  chunkCount: number;
  fileName: string;
  blobName: string;
};

export type CatalogDocumentRow = {
  documentId: string;
  tenantId: string;
  fileName: string;
  blobName: string;
  cosmos: CatalogCosmos | null;
  search: CatalogSearch | null;
};

export type CatalogResponse = {
  tenantId: string;
  documents: CatalogDocumentRow[];
  sources: { cosmos: boolean; search: boolean };
};

export type PurgeResponse = {
  documentId: string;
  tenantId: string;
  deletedSearchChunks: number;
  remainingSearchChunks?: number;
  cosmosDeleted: boolean;
  note?: string;
};

export const initialChatMessages: ChatMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    content:
      "I only search documents uploaded for this tenant. Upload on the left, then ask a question."
  }
];

export const statusLabel: Record<DocumentStatus, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  queued: "Queued",
  processing: "Processing",
  chunked: "Chunked",
  skipped: "Skipped",
  indexed: "Indexed",
  failed: "Failed"
};
