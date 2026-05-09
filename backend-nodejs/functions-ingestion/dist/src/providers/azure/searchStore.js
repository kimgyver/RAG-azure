import { indexChunkDocuments, searchChunkDocuments, deleteSearchChunksForDocument, countSearchChunksForDocument, listSearchDocumentGroups, searchEnabled } from "../../shared/searchIndexStore.js";
export class AzureSearchStoreProvider {
    isEnabled() {
        return searchEnabled();
    }
    async indexChunks(chunks) {
        return indexChunkDocuments(chunks);
    }
    async searchChunks(query, tenantId, top = 3, queryEmbedding, mode) {
        const results = await searchChunkDocuments(query, tenantId, top, queryEmbedding, mode);
        return results;
    }
    async deleteChunksForDocument(documentId, tenantId) {
        return deleteSearchChunksForDocument(documentId, tenantId);
    }
    async countChunksForDocument(documentId, tenantId) {
        return countSearchChunksForDocument(documentId, tenantId);
    }
    async listDocumentGroups(tenantId) {
        const results = await listSearchDocumentGroups(tenantId);
        return results;
    }
}
