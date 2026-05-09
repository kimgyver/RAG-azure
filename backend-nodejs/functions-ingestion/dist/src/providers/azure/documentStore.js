import { upsertDocumentMetadata, getDocumentMetadata, listDocumentsByTenant, deleteDocumentMetadata, cosmosEnabled } from "../../shared/documentMetadataStore.js";
export class AzureDocumentStoreProvider {
    isEnabled() {
        return cosmosEnabled();
    }
    async upsert(record) {
        await upsertDocumentMetadata(record);
    }
    async get(documentId, tenantId) {
        const result = await getDocumentMetadata(documentId, tenantId);
        return result;
    }
    async listByTenant(tenantId, maxItems = 200) {
        const results = await listDocumentsByTenant(tenantId, maxItems);
        return results;
    }
    async delete(documentId, tenantId) {
        await deleteDocumentMetadata(documentId, tenantId);
    }
}
