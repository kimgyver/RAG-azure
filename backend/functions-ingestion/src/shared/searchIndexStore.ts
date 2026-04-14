import {
  AzureKeyCredential,
  SearchClient,
  SearchIndexClient,
  SearchIndex,
  VectorizedQuery
} from "@azure/search-documents";
import { getEmbeddingDimensions } from "./embeddingStore.js";

export type ChunkSearchDocument = {
  id: string;
  tenantId: string;
  documentId: string;
  blobName: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  contentLength: number;
  sourceType: string;
  embedding?: number[];
};

export type ChunkSearchHit = ChunkSearchDocument & {
  score?: number;
};

export type SearchMode = "keyword" | "hybrid" | "vector";

export function resolveSearchMode(value?: string): SearchMode {
  switch ((value ?? "hybrid").trim().toLowerCase()) {
    case "keyword":
      return "keyword";
    case "vector":
      return "vector";
    default:
      return "hybrid";
  }
}

let indexClient: SearchIndexClient | undefined;
let searchClient: SearchClient<ChunkSearchDocument> | undefined;
let ensureIndexPromise: Promise<void> | undefined;

function resetSearchClients(): void {
  indexClient = undefined;
  searchClient = undefined;
  ensureIndexPromise = undefined;
}

function isIndexNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("was not found") ||
    error.message.includes("index '") ||
    error.message.includes('index "')
  );
}

function isSearchEnabled(): boolean {
  return (process.env.SEARCH_ENABLED ?? "false").toLowerCase() === "true";
}

function getRequiredSearchConfig() {
  const endpoint = process.env.SEARCH_ENDPOINT;
  const apiKey = process.env.SEARCH_API_KEY;
  const indexName = process.env.SEARCH_INDEX_NAME ?? "rag-chunks";

  if (!endpoint || !apiKey) {
    throw new Error(
      "SEARCH_ENDPOINT and SEARCH_API_KEY are required when SEARCH_ENABLED=true"
    );
  }

  return { endpoint, apiKey, indexName };
}

function getIndexClient(): SearchIndexClient {
  if (indexClient) {
    return indexClient;
  }

  const { endpoint, apiKey } = getRequiredSearchConfig();
  indexClient = new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
  return indexClient;
}

function getSearchClient(): SearchClient<ChunkSearchDocument> {
  if (searchClient) {
    return searchClient;
  }

  const { endpoint, apiKey, indexName } = getRequiredSearchConfig();
  searchClient = new SearchClient<ChunkSearchDocument>(
    endpoint,
    indexName,
    new AzureKeyCredential(apiKey)
  );
  return searchClient;
}

async function ensureIndex(): Promise<void> {
  if (ensureIndexPromise) {
    return ensureIndexPromise;
  }

  ensureIndexPromise = (async () => {
    const { indexName } = getRequiredSearchConfig();
    const client = getIndexClient();
    const dimensions = getEmbeddingDimensions();

    const index: SearchIndex = {
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
      ] as SearchIndex["fields"],
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

export async function indexChunkDocuments(
  chunks: ChunkSearchDocument[]
): Promise<boolean> {
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
  } catch (error) {
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

function escapeODataStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export async function searchChunkDocuments(
  query: string,
  tenantId: string,
  top = 3,
  queryEmbedding?: number[],
  mode: SearchMode = "hybrid"
): Promise<ChunkSearchHit[]> {
  if (!isSearchEnabled()) {
    return [];
  }

  const normalizedQuery = query.trim();
  const vectorQueries: VectorizedQuery<ChunkSearchDocument>[] =
    mode !== "keyword" && queryEmbedding
      ? [
          {
            kind: "vector",
            vector: queryEmbedding,
            kNearestNeighborsCount: top,
            fields: ["embedding"]
          }
        ]
      : [];

  const searchText =
    mode === "vector" && vectorQueries.length > 0 ? "" : normalizedQuery;

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
      vectorSearchOptions:
        vectorQueries.length > 0 ? { queries: vectorQueries } : undefined,
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
  } catch (error) {
    if (!isIndexNotFoundError(error)) {
      throw error;
    }

    resetSearchClients();
    await ensureIndex();
    client = getSearchClient();
    response = await client.search(searchText, {
      filter: `tenantId eq '${escapeODataStringLiteral(tenantId)}'`,
      top,
      vectorSearchOptions:
        vectorQueries.length > 0 ? { queries: vectorQueries } : undefined,
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

  const hits: ChunkSearchHit[] = [];

  for await (const result of response.results) {
    hits.push({
      ...result.document,
      score: result.score
    });
  }

  return hits;
}

export function searchEnabled(): boolean {
  return isSearchEnabled();
}
