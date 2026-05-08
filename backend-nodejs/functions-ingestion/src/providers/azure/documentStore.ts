import type { DocumentStoreProvider } from "../base.js";
import {
  upsertDocumentMetadata,
  getDocumentMetadata,
  listDocumentsByTenant,
  deleteDocumentMetadata,
  cosmosEnabled
} from "../../shared/documentMetadataStore.js";

export class AzureDocumentStoreProvider implements DocumentStoreProvider {
  isEnabled(): boolean {
    return cosmosEnabled();
  }

  async upsert(record: Record<string, unknown>): Promise<void> {
    await upsertDocumentMetadata(
      record as Parameters<typeof upsertDocumentMetadata>[0]
    );
  }

  async get(
    documentId: string,
    tenantId: string
  ): Promise<Record<string, unknown> | null> {
    const result = await getDocumentMetadata(documentId, tenantId);
    return result as Record<string, unknown> | null;
  }

  async listByTenant(
    tenantId: string,
    maxItems = 200
  ): Promise<Record<string, unknown>[]> {
    const results = await listDocumentsByTenant(tenantId, maxItems);
    return results as Record<string, unknown>[];
  }

  async delete(documentId: string, tenantId: string): Promise<void> {
    await deleteDocumentMetadata(documentId, tenantId);
  }
}
