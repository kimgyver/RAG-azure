import fs from "node:fs/promises";

const BATCH_SIZE = 1000;

async function loadSettings() {
  const raw = await fs.readFile(
    new URL("../local.settings.json", import.meta.url),
    "utf8"
  );

  return JSON.parse(raw).Values ?? {};
}

async function fetchIds(searchEndpoint, apiKey, indexName) {
  const response = await fetch(
    `${searchEndpoint}/indexes/${indexName}/docs/search?api-version=2024-07-01`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        search: "*",
        top: BATCH_SIZE,
        select: "id"
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to load ids: ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.value ?? [];
}

async function deleteBatch(searchEndpoint, apiKey, indexName, docs) {
  const response = await fetch(
    `${searchEndpoint}/indexes/${indexName}/docs/index?api-version=2024-07-01`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        value: docs.map(doc => ({
          "@search.action": "delete",
          id: doc.id
        }))
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Delete failed: ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.value?.length ?? 0;
}

async function main() {
  const env = await loadSettings();
  const searchEndpoint = env.SEARCH_ENDPOINT;
  const searchApiKey = env.SEARCH_API_KEY;
  const defaultIndexName = env.SEARCH_INDEX_NAME ?? "rag-chunks";
  const indexName = process.argv[2]?.trim() || defaultIndexName;

  if (!searchEndpoint || !searchApiKey) {
    throw new Error("SEARCH_ENDPOINT and SEARCH_API_KEY are required.");
  }

  let totalDeleted = 0;

  while (true) {
    const docs = await fetchIds(searchEndpoint, searchApiKey, indexName);
    if (docs.length === 0) {
      break;
    }

    totalDeleted += await deleteBatch(
      searchEndpoint,
      searchApiKey,
      indexName,
      docs
    );
  }

  console.log(
    JSON.stringify({
      indexName,
      deleted: totalDeleted
    })
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
