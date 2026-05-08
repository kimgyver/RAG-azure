import type { SearchStoreProvider } from "../base.js";
import {
  indexChunkDocuments,
  searchChunkDocuments,
  deleteSearchChunksForDocument,
  countSearchChunksForDocument,
  listSearchDocumentGroups,
  searchEnabled
} from "../../shared/searchIndexStore.js";

export class AzureSearchStoreProvider implements SearchStoreProvider {
  isEnabled(): boolean {
    return searchEnabled();
  }

  async indexChunks(chunks: Record<string, unknown>[]): Promise<boolean> {
    return indexChunkDocuments(
      chunks as Parameters<typeof indexChunkDocuments>[0]
    );
  }

  async searchChunks(
    query: string,
    tenantId: string,
    top = 3,
    queryEmbedding?: number[],
    mode?: string
  ): Promise<Record<string, unknown>[]> {
    const results = await searchChunkDocuments(
      query,
      tenantId,
      top,
      queryEmbedding,
      mode as Parameters<typeof searchChunkDocuments>[4]
    );
    return results as Record<string, unknown>[];
  }

  async deleteChunksForDocument(
    documentId: string,
    tenantId: string
  ): Promise<number> {
    return deleteSearchChunksForDocument(documentId, tenantId);
  }

  async countChunksForDocument(
    documentId: string,
    tenantId: string
  ): Promise<number> {
    return countSearchChunksForDocument(documentId, tenantId);
  }

  async listDocumentGroups(
    tenantId: string
  ): Promise<Record<string, unknown>[]> {
    const results = await listSearchDocumentGroups(tenantId);
    return results as Record<string, unknown>[];
  }
}
