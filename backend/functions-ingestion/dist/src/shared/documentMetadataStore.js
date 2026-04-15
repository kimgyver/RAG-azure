import { CosmosClient } from "@azure/cosmos";
let cosmosClient;
let containerPromise;
function isCosmosEnabled() {
    return (process.env.COSMOS_DB_ENABLED ?? "false").toLowerCase() === "true";
}
function getCosmosClient() {
    if (cosmosClient) {
        return cosmosClient;
    }
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    if (!endpoint || !key) {
        throw new Error("COSMOS_ENDPOINT and COSMOS_KEY are required when COSMOS_DB_ENABLED=true");
    }
    cosmosClient = new CosmosClient({ endpoint, key });
    return cosmosClient;
}
async function getContainer() {
    if (containerPromise) {
        return containerPromise;
    }
    containerPromise = (async () => {
        const client = getCosmosClient();
        const databaseId = process.env.COSMOS_DATABASE_ID ?? "rag-db";
        const containerId = process.env.COSMOS_DOCUMENTS_CONTAINER_ID ?? "documents";
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
export async function upsertDocumentMetadata(update, context) {
    if (!isCosmosEnabled()) {
        return;
    }
    try {
        const container = await getContainer();
        const now = new Date().toISOString();
        const { resource: existing } = await container
            .item(update.documentId, update.tenantId)
            .read();
        const record = {
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
    }
    catch (error) {
        context?.warn("Cosmos upsert skipped due to error.", {
            message: error instanceof Error ? error.message : String(error),
            documentId: update.documentId,
            tenantId: update.tenantId,
            status: update.status
        });
    }
}
export function cosmosEnabled() {
    return isCosmosEnabled();
}
export async function getDocumentMetadata(documentId, tenantId) {
    if (!isCosmosEnabled()) {
        return null;
    }
    const container = await getContainer();
    const { resource } = await container
        .item(documentId, tenantId)
        .read();
    return resource ?? null;
}
export async function listDocumentsByTenant(tenantId, maxItems = 200) {
    if (!isCosmosEnabled()) {
        return [];
    }
    const container = await getContainer();
    const { resources } = await container.items
        .query({ query: "SELECT * FROM c" }, { partitionKey: tenantId })
        .fetchAll();
    const sorted = [...resources].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sorted.slice(0, maxItems);
}
export async function deleteDocumentMetadata(documentId, tenantId) {
    if (!isCosmosEnabled()) {
        return false;
    }
    const container = await getContainer();
    try {
        await container.item(documentId, tenantId).delete();
        return true;
    }
    catch (error) {
        const code = error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "number"
            ? error.code
            : undefined;
        const statusCode = error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
            ? error.statusCode
            : undefined;
        if (code === 404 || statusCode === 404) {
            return false;
        }
        throw error;
    }
}
