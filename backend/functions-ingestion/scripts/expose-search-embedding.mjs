import fs from "node:fs/promises";

async function main() {
  const raw = await fs.readFile(
    new URL("../local.settings.json", import.meta.url),
    "utf8"
  );
  const env = JSON.parse(raw).Values ?? {};

  const endpoint = env.SEARCH_ENDPOINT;
  const apiKey = env.SEARCH_API_KEY;
  const indexName =
    process.argv[2]?.trim() || env.SEARCH_INDEX_NAME || "rag-chunks";
  const mode = (process.argv[3]?.trim() || "expose").toLowerCase();

  if (!endpoint || !apiKey) {
    throw new Error("SEARCH_ENDPOINT and SEARCH_API_KEY are required.");
  }

  if (mode !== "expose" && mode !== "hide") {
    throw new Error("Mode must be either 'expose' or 'hide'.");
  }

  const headers = {
    "api-key": apiKey,
    "Content-Type": "application/json"
  };

  const currentResponse = await fetch(
    `${endpoint}/indexes/${indexName}?api-version=2024-07-01`,
    { headers }
  );

  if (!currentResponse.ok) {
    throw new Error(
      `Failed to load index schema: ${await currentResponse.text()}`
    );
  }

  const index = await currentResponse.json();
  let embeddingFound = false;

  index.fields = index.fields.map(field => {
    if (field.name !== "embedding") {
      return field;
    }

    embeddingFound = true;
    return {
      ...field,
      retrievable: mode === "expose"
    };
  });

  if (!embeddingFound) {
    throw new Error(
      `Index '${indexName}' does not contain an embedding field.`
    );
  }

  const updateResponse = await fetch(
    `${endpoint}/indexes/${indexName}?api-version=2024-07-01`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(index)
    }
  );

  if (!updateResponse.ok) {
    throw new Error(
      `Failed to update index schema: ${await updateResponse.text()}`
    );
  }

  const refreshedResponse = await fetch(
    `${endpoint}/indexes/${indexName}?api-version=2024-07-01`,
    { headers }
  );

  if (!refreshedResponse.ok) {
    throw new Error(
      `Failed to reload index schema: ${await refreshedResponse.text()}`
    );
  }

  const updated = await refreshedResponse.json();
  const embeddingField = updated.fields.find(
    field => field.name === "embedding"
  );

  console.log(
    JSON.stringify({
      indexName: updated.name,
      mode,
      retrievable: embeddingField?.retrievable,
      stored: embeddingField?.stored
    })
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
