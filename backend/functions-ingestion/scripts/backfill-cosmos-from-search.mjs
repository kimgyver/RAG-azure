import fs from "node:fs/promises";
import { CosmosClient } from "@azure/cosmos";
import { AzureKeyCredential, SearchClient } from "@azure/search-documents";

async function loadSettingsFile() {
  try {
    const raw = await fs.readFile(
      new URL("../local.settings.json", import.meta.url),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    return parsed.Values ?? {};
  } catch {
    return {};
  }
}

function pickEnv(settings, key, fallback = "") {
  return (process.env[key] ?? settings[key] ?? fallback).trim();
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

async function main() {
  const settings = await loadSettingsFile();

  const searchEnabled = pickEnv(settings, "SEARCH_ENABLED", "false").toLowerCase() === "true";
  const cosmosEnabled = pickEnv(settings, "COSMOS_DB_ENABLED", "false").toLowerCase() === "true";
  const searchEndpoint = pickEnv(settings, "SEARCH_ENDPOINT");
  const searchApiKey = pickEnv(settings, "SEARCH_API_KEY");
  const searchIndexName = pickEnv(settings, "SEARCH_INDEX_NAME", "rag-chunks");
  const cosmosEndpoint = pickEnv(settings, "COSMOS_ENDPOINT");
  const cosmosKey = pickEnv(settings, "COSMOS_KEY");
  const cosmosDatabaseId = pickEnv(settings, "COSMOS_DATABASE_ID", "rag-db");
  const cosmosContainerId = pickEnv(settings, "COSMOS_DOCUMENTS_CONTAINER_ID", "documents");
  const tenantFilter = pickEnv(settings, "BACKFILL_TENANT_ID");
  const pageSize = Math.min(
    toPositiveInt(pickEnv(settings, "BACKFILL_PAGE_SIZE", "500"), 500),
    1000
  );
  const maxChunks = toPositiveInt(pickEnv(settings, "BACKFILL_MAX_CHUNKS", "5000"), 5000);
  const dryRun = toBoolean(pickEnv(settings, "BACKFILL_DRY_RUN", "false"));

  if (!searchEnabled) {
    throw new Error("SEARCH_ENABLED must be true for backfill.");
  }

  if (!cosmosEnabled) {
    throw new Error("COSMOS_DB_ENABLED must be true for backfill.");
  }

  if (!searchEndpoint || !searchApiKey) {
    throw new Error("SEARCH_ENDPOINT and SEARCH_API_KEY are required.");
  }

  if (!cosmosEndpoint || !cosmosKey) {
    throw new Error("COSMOS_ENDPOINT and COSMOS_KEY are required.");
  }

  const searchClient = new SearchClient(
    searchEndpoint,
    searchIndexName,
    new AzureKeyCredential(searchApiKey)
  );

  const cosmosClient = new CosmosClient({
    endpoint: cosmosEndpoint,
    key: cosmosKey
  });

  const { database } = await cosmosClient.databases.createIfNotExists({
    id: cosmosDatabaseId
  });
  const { container } = await database.containers.createIfNotExists({
    id: cosmosContainerId,
    partitionKey: { paths: ["/tenantId"] }
  });

  const groups = new Map();
  let scannedChunks = 0;
  let skip = 0;

  while (scannedChunks < maxChunks) {
    const top = Math.min(pageSize, maxChunks - scannedChunks);
    const response = await searchClient.search("*", {
      filter: tenantFilter ? `tenantId eq '${tenantFilter.replace(/'/g, "''")}'` : undefined,
      top,
      skip,
      select: ["tenantId", "documentId", "blobName", "fileName", "chunkIndex"]
    });

    let pageCount = 0;
    for await (const result of response.results) {
      pageCount += 1;
      scannedChunks += 1;
      const doc = result.document;
      if (!doc?.tenantId || !doc?.documentId || !doc?.blobName) {
        continue;
      }

      const key = `${doc.tenantId}::${doc.documentId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.chunkCount += 1;
        if (typeof doc.chunkIndex === "number" && doc.chunkIndex < existing.firstChunkIndex) {
          existing.firstChunkIndex = doc.chunkIndex;
          existing.fileName = doc.fileName ?? existing.fileName;
          existing.blobName = doc.blobName;
        }
      } else {
        groups.set(key, {
          id: doc.documentId,
          documentId: doc.documentId,
          tenantId: doc.tenantId,
          blobName: doc.blobName,
          fileName: doc.fileName ?? doc.documentId,
          chunkCount: 1,
          firstChunkIndex: typeof doc.chunkIndex === "number" ? doc.chunkIndex : Number.MAX_SAFE_INTEGER
        });
      }
    }

    if (pageCount < top) {
      break;
    }

    skip += pageCount;
  }

  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const group of groups.values()) {
    const itemRef = container.item(group.documentId, group.tenantId);
    const { resource: existing } = await itemRef.read().catch(error => {
      const statusCode = error?.statusCode ?? error?.code;
      if (statusCode === 404) {
        return { resource: null };
      }
      throw error;
    });

    const record = {
      id: group.documentId,
      documentId: group.documentId,
      tenantId: group.tenantId,
      blobName: existing?.blobName ?? group.blobName,
      status: existing?.status ?? "indexed",
      contentType: existing?.contentType,
      contentLength: existing?.contentLength,
      chunkCount: existing?.chunkCount ?? group.chunkCount,
      errorMessage: existing?.errorMessage,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    if (!dryRun) {
      await container.items.upsert(record);
    }

    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        tenantFilter: tenantFilter || null,
        searchIndexName,
        scannedChunks,
        groupedDocuments: groups.size,
        created,
        updated,
        dryRun
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});