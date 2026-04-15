import { AzureKeyCredential, SearchClient, SearchIndexClient } from "@azure/search-documents";
import { getEmbeddingDimensions } from "./embeddingStore.js";
export function resolveSearchMode(value) {
    switch ((value ?? "hybrid").trim().toLowerCase()) {
        case "keyword":
            return "keyword";
        case "vector":
            return "vector";
        default:
            return "hybrid";
    }
}
let indexClient;
let searchClient;
let ensureIndexPromise;
function resetSearchClients() {
    indexClient = undefined;
    searchClient = undefined;
    ensureIndexPromise = undefined;
}
function isIndexNotFoundError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    return (error.message.includes("was not found") ||
        error.message.includes("index '") ||
        error.message.includes('index "'));
}
function isSearchEnabled() {
    return (process.env.SEARCH_ENABLED ?? "false").toLowerCase() === "true";
}
function getRequiredSearchConfig() {
    const endpoint = process.env.SEARCH_ENDPOINT;
    const apiKey = process.env.SEARCH_API_KEY;
    const indexName = process.env.SEARCH_INDEX_NAME ?? "rag-chunks";
    if (!endpoint || !apiKey) {
        throw new Error("SEARCH_ENDPOINT and SEARCH_API_KEY are required when SEARCH_ENABLED=true");
    }
    return { endpoint, apiKey, indexName };
}
function getIndexClient() {
    if (indexClient) {
        return indexClient;
    }
    const { endpoint, apiKey } = getRequiredSearchConfig();
    indexClient = new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
    return indexClient;
}
function getSearchClient() {
    if (searchClient) {
        return searchClient;
    }
    const { endpoint, apiKey, indexName } = getRequiredSearchConfig();
    searchClient = new SearchClient(endpoint, indexName, new AzureKeyCredential(apiKey));
    return searchClient;
}
async function ensureIndex() {
    if (ensureIndexPromise) {
        return ensureIndexPromise;
    }
    ensureIndexPromise = (async () => {
        const { indexName } = getRequiredSearchConfig();
        const client = getIndexClient();
        const dimensions = getEmbeddingDimensions();
        const index = {
            name: indexName,
            fields: [
                { name: "id", type: "Edm.String", key: true, filterable: true },
                {
                    name: "tenantId",
                    type: "Edm.String",
                    searchable: true,
                    filterable: true
                },
                {
                    name: "documentId",
                    type: "Edm.String",
                    searchable: true,
                    filterable: true
                },
                {
                    name: "blobName",
                    type: "Edm.String",
                    searchable: true,
                    filterable: true
                },
                {
                    name: "fileName",
                    type: "Edm.String",
                    searchable: true,
                    filterable: true
                },
                {
                    name: "chunkIndex",
                    type: "Edm.Int32",
                    filterable: true,
                    sortable: true
                },
                { name: "content", type: "Edm.String", searchable: true },
                {
                    name: "contentLength",
                    type: "Edm.Int32",
                    filterable: true,
                    sortable: true
                },
                {
                    name: "sourceType",
                    type: "Edm.String",
                    searchable: true,
                    filterable: true
                },
                {
                    name: "embedding",
                    type: "Collection(Edm.Single)",
                    searchable: true,
                    hidden: true,
                    vectorSearchDimensions: dimensions,
                    vectorSearchProfileName: "rag-vector-profile"
                }
            ],
            vectorSearch: {
                algorithms: [{ name: "rag-hnsw", kind: "hnsw" }],
                profiles: [
                    {
                        name: "rag-vector-profile",
                        algorithmConfigurationName: "rag-hnsw"
                    }
                ]
            }
        };
        await client.createOrUpdateIndex(index);
    })();
    return ensureIndexPromise;
}
export async function indexChunkDocuments(chunks) {
    if (!isSearchEnabled()) {
        return false;
    }
    if (chunks.length === 0) {
        return false;
    }
    await ensureIndex();
    try {
        const client = getSearchClient();
        await client.mergeOrUploadDocuments(chunks);
    }
    catch (error) {
        if (!isIndexNotFoundError(error)) {
            throw error;
        }
        resetSearchClients();
        await ensureIndex();
        const client = getSearchClient();
        await client.mergeOrUploadDocuments(chunks);
    }
    return true;
}
function escapeODataStringLiteral(value) {
    return value.replace(/'/g, "''");
}
export async function searchChunkDocuments(query, tenantId, top = 3, queryEmbedding, mode = "hybrid") {
    if (!isSearchEnabled()) {
        return [];
    }
    const normalizedQuery = query.trim();
    const vectorQueries = mode !== "keyword" && queryEmbedding
        ? [
            {
                kind: "vector",
                vector: queryEmbedding,
                kNearestNeighborsCount: top,
                fields: ["embedding"]
            }
        ]
        : [];
    const searchText = mode === "vector" && vectorQueries.length > 0 ? "" : normalizedQuery;
    if (!searchText && vectorQueries.length === 0) {
        return [];
    }
    await ensureIndex();
    let client = getSearchClient();
    let response;
    try {
        response = await client.search(searchText, {
            filter: `tenantId eq '${escapeODataStringLiteral(tenantId)}'`,
            top,
            vectorSearchOptions: vectorQueries.length > 0 ? { queries: vectorQueries } : undefined,
            select: [
                "id",
                "tenantId",
                "documentId",
                "blobName",
                "fileName",
                "chunkIndex",
                "content",
                "contentLength",
                "sourceType"
            ]
        });
    }
    catch (error) {
        if (!isIndexNotFoundError(error)) {
            throw error;
        }
        resetSearchClients();
        await ensureIndex();
        client = getSearchClient();
        response = await client.search(searchText, {
            filter: `tenantId eq '${escapeODataStringLiteral(tenantId)}'`,
            top,
            vectorSearchOptions: vectorQueries.length > 0 ? { queries: vectorQueries } : undefined,
            select: [
                "id",
                "tenantId",
                "documentId",
                "blobName",
                "fileName",
                "chunkIndex",
                "content",
                "contentLength",
                "sourceType"
            ]
        });
    }
    const hits = [];
    for await (const result of response.results) {
        hits.push({
            ...result.document,
            score: result.score
        });
    }
    return hits;
}
export function searchEnabled() {
    return isSearchEnabled();
}
/**
 * Tenant 파티션 내 청크를 스캔해 documentId 기준으로 묶는다(데모·관리용, 상한 있음).
 */
export async function listSearchDocumentGroups(tenantId, maxChunksToScan = 4000) {
    if (!isSearchEnabled()) {
        return [];
    }
    await ensureIndex();
    const client = getSearchClient();
    const filter = `tenantId eq '${escapeODataStringLiteral(tenantId)}'`;
    const byDoc = new Map();
    let scanned = 0;
    let skip = 0;
    const pageSize = 1000;
    while (scanned < maxChunksToScan) {
        const take = Math.min(pageSize, maxChunksToScan - scanned);
        const response = await client.search("*", {
            filter,
            top: take,
            skip,
            select: ["documentId", "fileName", "blobName"]
        });
        let pageHits = 0;
        for await (const result of response.results) {
            pageHits += 1;
            scanned += 1;
            const doc = result.document;
            const did = doc.documentId?.trim();
            if (!did) {
                continue;
            }
            const existing = byDoc.get(did);
            if (existing) {
                existing.count += 1;
            }
            else {
                byDoc.set(did, {
                    fileName: doc.fileName ?? "",
                    blobName: doc.blobName ?? "",
                    count: 1
                });
            }
        }
        if (pageHits === 0) {
            break;
        }
        skip += pageHits;
        if (pageHits < take) {
            break;
        }
    }
    return [...byDoc.entries()].map(([documentId, v]) => ({
        documentId,
        fileName: v.fileName,
        blobName: v.blobName,
        chunkCount: v.count
    }));
}
/**
 * 해당 문서의 모든 청크를 인덱스에서 제거한다. 삭제된 청크 개수를 반환한다.
 */
export async function deleteSearchChunksForDocument(documentId, tenantId) {
    if (!isSearchEnabled()) {
        return 0;
    }
    await ensureIndex();
    const client = getSearchClient();
    const filter = `tenantId eq '${escapeODataStringLiteral(tenantId)}' and documentId eq '${escapeODataStringLiteral(documentId)}'`;
    let totalDeleted = 0;
    const batchSize = 500;
    for (;;) {
        const response = await client.search("*", {
            filter,
            top: batchSize,
            select: ["id"]
        });
        const ids = [];
        for await (const result of response.results) {
            if (result.document.id) {
                ids.push({ id: result.document.id });
            }
        }
        if (ids.length === 0) {
            break;
        }
        await client.deleteDocuments(ids);
        totalDeleted += ids.length;
        if (ids.length < batchSize) {
            break;
        }
    }
    return totalDeleted;
}
