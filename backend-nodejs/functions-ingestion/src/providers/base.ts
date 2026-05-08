export interface StorageProvider {
  buildUploadBlobName(
    tenantId: string,
    documentId: string,
    fileName: string
  ): string;
  createUploadUrl(opts: {
    blobName: string;
    containerName: string;
    expiryMinutes: number;
    contentType?: string;
  }): string | Promise<string>;
  downloadBlob(containerName: string, blobName: string): Promise<Buffer>;
  getBlobContentType(
    containerName: string,
    blobName: string
  ): Promise<string | undefined>;
}

export interface DocumentStoreProvider {
  upsert(record: Record<string, unknown>): Promise<void>;
  get(
    documentId: string,
    tenantId: string
  ): Promise<Record<string, unknown> | null>;
  listByTenant(
    tenantId: string,
    maxItems?: number
  ): Promise<Record<string, unknown>[]>;
  delete(documentId: string, tenantId: string): Promise<void>;
  isEnabled(): boolean;
}

export interface SearchStoreProvider {
  indexChunks(chunks: Record<string, unknown>[]): Promise<boolean>;
  searchChunks(
    query: string,
    tenantId: string,
    top?: number,
    queryEmbedding?: number[],
    mode?: string
  ): Promise<Record<string, unknown>[]>;
  deleteChunksForDocument(
    documentId: string,
    tenantId: string
  ): Promise<number>;
  countChunksForDocument(documentId: string, tenantId: string): Promise<number>;
  listDocumentGroups(tenantId: string): Promise<Record<string, unknown>[]>;
  isEnabled(): boolean;
}
