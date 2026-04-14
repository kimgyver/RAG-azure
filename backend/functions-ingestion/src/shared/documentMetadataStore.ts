import type { InvocationContext } from "@azure/functions";
import { CosmosClient, type Container } from "@azure/cosmos";

export type DocumentStatus =
  | "queued"
  | "processing"
  | "chunked"
  | "indexed"
  | "skipped"
  | "failed";

export type DocumentMetadataUpdate = {
  documentId: string;
  tenantId: string;
  blobName: string;
  status: DocumentStatus;
  contentType?: string;
  contentLength?: number;
  chunkCount?: number;
  errorMessage?: string;
};

export type DocumentMetadataRecord = DocumentMetadataUpdate & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

let cosmosClient: CosmosClient | undefined;
let containerPromise: Promise<Container> | undefined;

function isCosmosEnabled(): boolean {
  return (process.env.COSMOS_DB_ENABLED ?? "false").toLowerCase() === "true";
}

function getCosmosClient(): CosmosClient {
  if (cosmosClient) {
    return cosmosClient;
  }

  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;

  if (!endpoint || !key) {
    throw new Error(
      "COSMOS_ENDPOINT and COSMOS_KEY are required when COSMOS_DB_ENABLED=true"
    );
  }

  cosmosClient = new CosmosClient({ endpoint, key });
  return cosmosClient;
}

async function getContainer(): Promise<Container> {
  if (containerPromise) {
    return containerPromise;
  }

  containerPromise = (async () => {
    const client = getCosmosClient();
    const databaseId = process.env.COSMOS_DATABASE_ID ?? "rag-db";
    const containerId =
      process.env.COSMOS_DOCUMENTS_CONTAINER_ID ?? "documents";

    const { database } = await client.databases.createIfNotExists({
      id: databaseId
    });

    const { container } = await database.containers.createIfNotExists({
      id: containerId,
      partitionKey: {
        paths: ["/tenantId"]
      }
    });

    return container;
  })();

  return containerPromise;
}

export async function upsertDocumentMetadata(
  update: DocumentMetadataUpdate,
  context?: InvocationContext
): Promise<void> {
  if (!isCosmosEnabled()) {
    return;
  }

  try {
    const container = await getContainer();
    const now = new Date().toISOString();

    const { resource: existing } = await container
      .item(update.documentId, update.tenantId)
      .read<DocumentMetadataRecord>();

    const record: DocumentMetadataRecord = {
      id: update.documentId,
      documentId: update.documentId,
      tenantId: update.tenantId,
      blobName: update.blobName,
      status: update.status,
      contentType: update.contentType,
      contentLength: update.contentLength,
      chunkCount: update.chunkCount,
      errorMessage: update.errorMessage,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    await container.items.upsert(record);
  } catch (error) {
    context?.warn("Cosmos upsert skipped due to error.", {
      message: error instanceof Error ? error.message : String(error),
      documentId: update.documentId,
      tenantId: update.tenantId,
      status: update.status
    });
  }
}

export function cosmosEnabled(): boolean {
  return isCosmosEnabled();
}

export async function getDocumentMetadata(
  documentId: string,
  tenantId: string
): Promise<DocumentMetadataRecord | null> {
  if (!isCosmosEnabled()) {
    return null;
  }

  const container = await getContainer();
  const { resource } = await container
    .item(documentId, tenantId)
    .read<DocumentMetadataRecord>();

  return resource ?? null;
}
