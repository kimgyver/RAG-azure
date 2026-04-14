import OpenAI, { AzureOpenAI } from "openai";

let embeddingClient: OpenAI | undefined;

function getEmbeddingClient(): OpenAI | undefined {
  if (embeddingClient) return embeddingClient;

  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const azureApiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

  if (azureEndpoint && azureApiKey) {
    embeddingClient = new AzureOpenAI({
      endpoint: azureEndpoint,
      apiKey: azureApiKey,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION?.trim() ?? "2024-02-01"
    });
    return embeddingClient;
  }

  if (openaiApiKey) {
    embeddingClient = new OpenAI({ apiKey: openaiApiKey });
    return embeddingClient;
  }

  return undefined;
}

function getEmbeddingModel(): string {
  return (
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT?.trim() ??
    process.env.OPENAI_EMBEDDING_MODEL?.trim() ??
    "text-embedding-3-small"
  );
}

export function embeddingEnabled(): boolean {
  if ((process.env.EMBEDDING_ENABLED ?? "false").toLowerCase() !== "true") {
    return false;
  }
  return !!(
    (process.env.AZURE_OPENAI_ENDPOINT?.trim() &&
      process.env.AZURE_OPENAI_API_KEY?.trim()) ||
    process.env.OPENAI_API_KEY?.trim()
  );
}

export function getEmbeddingDimensions(): number {
  return Number(process.env.EMBEDDING_DIMENSIONS ?? "1536");
}

export async function generateEmbedding(
  text: string
): Promise<number[] | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  const response = await client.embeddings.create({
    model: getEmbeddingModel(),
    input: text.slice(0, 8000)
  });

  return response.data[0]?.embedding ?? null;
}

const BATCH_SIZE = 16;

export async function generateEmbeddings(
  texts: string[]
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];

  const client = getEmbeddingClient();
  if (!client) return texts.map(() => null);

  const model = getEmbeddingModel();
  const results: (number[] | null)[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(t => t.slice(0, 8000));
    const response = await client.embeddings.create({ model, input: batch });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      results.push(item.embedding);
    }
  }

  return results;
}
