import fs from "node:fs/promises";
import OpenAI from "openai";

async function main() {
  const settings = JSON.parse(
    await fs.readFile(
      new URL("../local.settings.json", import.meta.url),
      "utf8"
    )
  );
  const env = settings.Values ?? {};

  const searchEndpoint = env.SEARCH_ENDPOINT;
  const searchApiKey = env.SEARCH_API_KEY;
  const sourceIndex = env.SEARCH_INDEX_NAME ?? "rag-chunks";
  const debugIndex = `${sourceIndex}-debug`;
  const embeddingModel =
    env.OPENAI_EMBEDDING_MODEL?.trim() ?? "text-embedding-3-small";
  const dimensions = Number(env.EMBEDDING_DIMENSIONS ?? "1536");
  const openaiApiKey = env.OPENAI_API_KEY?.trim();

  if (!searchEndpoint || !searchApiKey) {
    throw new Error("SEARCH_ENDPOINT and SEARCH_API_KEY are required.");
  }

  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required to rebuild debug embeddings.");
  }

  const openai = new OpenAI({ apiKey: openaiApiKey });
  const headers = {
    "api-key": searchApiKey,
    "Content-Type": "application/json"
  };

  const createResponse = await fetch(
    `${searchEndpoint}/indexes/${debugIndex}?api-version=2024-07-01`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: debugIndex,
        fields: [
          {
            name: "id",
            type: "Edm.String",
            key: true,
            filterable: true,
            retrievable: true
          },
          {
            name: "tenantId",
            type: "Edm.String",
            searchable: true,
            filterable: true,
            retrievable: true
          },
          {
            name: "documentId",
            type: "Edm.String",
            searchable: true,
            filterable: true,
            retrievable: true
          },
          {
            name: "blobName",
            type: "Edm.String",
            searchable: true,
            filterable: true,
            retrievable: true
          },
          {
            name: "fileName",
            type: "Edm.String",
            searchable: true,
            filterable: true,
            retrievable: true
          },
          {
            name: "chunkIndex",
            type: "Edm.Int32",
            filterable: true,
            sortable: true,
            retrievable: true
          },
          {
            name: "content",
            type: "Edm.String",
            searchable: true,
            retrievable: true
          },
          {
            name: "contentLength",
            type: "Edm.Int32",
            filterable: true,
            sortable: true,
            retrievable: true
          },
          {
            name: "sourceType",
            type: "Edm.String",
            searchable: true,
            filterable: true,
            retrievable: true
          },
          {
            name: "embedding",
            type: "Collection(Edm.Single)",
            searchable: true,
            retrievable: true,
            dimensions,
            vectorSearchProfile: "rag-vector-profile"
          }
        ],
        vectorSearch: {
          algorithms: [{ name: "rag-hnsw", kind: "hnsw" }],
          profiles: [{ name: "rag-vector-profile", algorithm: "rag-hnsw" }]
        }
      })
    }
  );

  if (!createResponse.ok) {
    throw new Error(
      `Debug index creation failed: ${await createResponse.text()}`
    );
  }

  const sourceResponse = await fetch(
    `${searchEndpoint}/indexes/${sourceIndex}/docs/search?api-version=2024-07-01`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        search: "*",
        top: 100,
        select:
          "id,tenantId,documentId,blobName,fileName,chunkIndex,content,contentLength,sourceType"
      })
    }
  );

  if (!sourceResponse.ok) {
    throw new Error(`Source fetch failed: ${await sourceResponse.text()}`);
  }

  const sourcePayload = await sourceResponse.json();
  const docs = sourcePayload.value ?? [];

  if (docs.length === 0) {
    console.log(JSON.stringify({ debugIndex, count: 0 }));
    return;
  }

  const embeddingResponse = await openai.embeddings.create({
    model: embeddingModel,
    input: docs.map(doc => String(doc.content ?? "").slice(0, 8000))
  });

  const uploadResponse = await fetch(
    `${searchEndpoint}/indexes/${debugIndex}/docs/index?api-version=2024-07-01`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        value: docs.map((doc, index) => ({
          "@search.action": "mergeOrUpload",
          ...doc,
          embedding: embeddingResponse.data[index]?.embedding ?? null
        }))
      })
    }
  );

  if (!uploadResponse.ok) {
    throw new Error(
      `Debug index upload failed: ${await uploadResponse.text()}`
    );
  }

  const uploadPayload = await uploadResponse.json();
  console.log(
    JSON.stringify({
      debugIndex,
      count: docs.length,
      uploaded: uploadPayload.value?.length ?? 0
    })
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
