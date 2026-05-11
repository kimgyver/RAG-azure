import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { SearchStoreProvider } from "../base.js";

function isIndexNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("index_not_found_exception");
}

function getClient(): OpenSearchClient {
  const endpoint = process.env.OPENSEARCH_ENDPOINT;
  if (!endpoint) throw new Error("OPENSEARCH_ENDPOINT is required");

  const normalizedEndpoint = endpoint.toLowerCase();
  const isManagedOpenSearch =
    normalizedEndpoint.includes(".es.amazonaws.com") ||
    normalizedEndpoint.includes(".aoss.amazonaws.com");

  if (!isManagedOpenSearch) {
    return new OpenSearchClient({
      node: endpoint
    });
  }

  const region = process.env.AWS_REGION ?? "ap-southeast-2";
  return new OpenSearchClient({
    ...AwsSigv4Signer({
      region,
      service: "es",
      getCredentials: defaultProvider()
    }),
    node: endpoint
  });
}

let _client: OpenSearchClient | undefined;
function client(): OpenSearchClient {
  if (!_client) _client = getClient();
  return _client;
}

const INDEX = () => process.env.OPENSEARCH_INDEX_NAME ?? "rag-chunks";

export class AwsSearchStoreProvider implements SearchStoreProvider {
  isEnabled(): boolean {
    // If OPENSEARCH_ENDPOINT is present, default SEARCH_ENABLED to true for AWS.
    // Otherwise, respect explicit SEARCH_ENABLED or default to false.
    const endpoint = process.env.OPENSEARCH_ENDPOINT?.trim();
    if (!endpoint) {
      return false;
    }

    const hasEndpoint = Boolean(endpoint);
    const searchEnabledEnv = process.env.SEARCH_ENABLED?.trim().toLowerCase();

    // If endpoint exists and SEARCH_ENABLED is not explicitly false, enable search.
    if (searchEnabledEnv === "false") {
      return false;
    }

    return hasEndpoint;
  }

  async indexChunks(chunks: Record<string, unknown>[]): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (!chunks.length) return false;
    const body = chunks.flatMap(doc => [
      { index: { _index: INDEX(), _id: String(doc.id) } },
      doc
    ]);
    await client().bulk({ body });
    return true;
  }

  async searchChunks(
    query: string,
    tenantId: string,
    top = 3,
    queryEmbedding?: number[],
    mode = "hybrid"
  ): Promise<Record<string, unknown>[]> {
    if (!this.isEnabled()) return [];
    const mustFilter = { term: { "tenantId.keyword": tenantId } };

    let body: Record<string, unknown>;
    if (mode === "vector" && queryEmbedding) {
      body = {
        query: { bool: { filter: [mustFilter] } },
        knn: { embedding: { vector: queryEmbedding, k: top } },
        size: top
      };
    } else if (mode === "hybrid" && queryEmbedding) {
      body = {
        query: {
          bool: {
            must: [{ match: { content: query } }],
            filter: [mustFilter]
          }
        },
        knn: { embedding: { vector: queryEmbedding, k: top } },
        size: top
      };
    } else {
      body = {
        query: {
          bool: {
            must: [{ match: { content: query } }],
            filter: [mustFilter]
          }
        },
        size: top
      };
    }

    try {
      const response = await client().search({ index: INDEX(), body });
      return (response.body.hits?.hits ?? []).map(
        (h: Record<string, unknown>) => ({
          ...(h._source as Record<string, unknown>),
          score: h._score
        })
      );
    } catch (error) {
      if (isIndexNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  async deleteChunksForDocument(
    documentId: string,
    tenantId: string
  ): Promise<number> {
    if (!this.isEnabled()) return 0;
    try {
      const response = await client().deleteByQuery({
        index: INDEX(),
        body: {
          query: {
            bool: {
              filter: [
                { term: { "documentId.keyword": documentId } },
                { term: { "tenantId.keyword": tenantId } }
              ]
            }
          }
        }
      });
      return (response.body.deleted as number) ?? 0;
    } catch (error) {
      if (isIndexNotFound(error)) {
        return 0;
      }

      throw error;
    }
  }

  async countChunksForDocument(
    documentId: string,
    tenantId: string
  ): Promise<number> {
    if (!this.isEnabled()) return 0;
    try {
      const response = await client().count({
        index: INDEX(),
        body: {
          query: {
            bool: {
              filter: [
                { term: { "documentId.keyword": documentId } },
                { term: { "tenantId.keyword": tenantId } }
              ]
            }
          }
        }
      });
      return response.body.count ?? 0;
    } catch (error) {
      if (isIndexNotFound(error)) {
        return 0;
      }

      throw error;
    }
  }

  async listDocumentGroups(
    tenantId: string
  ): Promise<Record<string, unknown>[]> {
    if (!this.isEnabled()) return [];
    try {
      const response = await client().search({
        index: INDEX(),
        body: {
          query: { term: { "tenantId.keyword": tenantId } },
          size: 0,
          aggs: {
            docs: {
              terms: { field: "documentId.keyword", size: 500 },
              aggs: {
                fileName: { terms: { field: "fileName.keyword", size: 1 } },
                blobName: { terms: { field: "blobName.keyword", size: 1 } }
              }
            }
          }
        }
      });
      return (response.body.aggregations?.docs?.buckets ?? []).map(
        (b: Record<string, unknown>) => ({
          documentId: b.key,
          chunkCount: b.doc_count,
          fileName:
            (
              (b.fileName as Record<string, unknown[]>)?.buckets?.[0] as Record<
                string,
                unknown
              >
            )?.key ?? "",
          blobName:
            (
              (b.blobName as Record<string, unknown[]>)?.buckets?.[0] as Record<
                string,
                unknown
              >
            )?.key ?? ""
        })
      );
    } catch (error) {
      if (isIndexNotFound(error)) {
        return [];
      }

      throw error;
    }
  }
}
