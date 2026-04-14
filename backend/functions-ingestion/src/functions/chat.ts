import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from "@azure/functions";
import OpenAI from "openai";
import {
  embeddingEnabled,
  generateEmbedding
} from "../shared/embeddingStore.js";
import {
  ChunkSearchHit,
  SearchMode,
  resolveSearchMode,
  searchChunkDocuments,
  searchEnabled
} from "../shared/searchIndexStore.js";
import {
  isTenantAllowed,
  tenantNotAllowedMessage
} from "../shared/tenantPolicy.js";

type ChatRequest = {
  tenantId?: string;
  question?: string;
};

type ChatCitation = {
  documentId: string;
  fileName: string;
  blobName: string;
  chunkIndex: number;
  snippet: string;
  score?: number;
};

type ChatResponse = {
  answer: string;
  citations: ChatCitation[];
  usage: {
    tenantId: string;
    retrievedChunks: number;
    searchMode: SearchMode;
    vectorUsed: boolean;
  };
};

function getConfiguredSearchMode(): SearchMode {
  return resolveSearchMode(process.env.CHAT_SEARCH_MODE);
}

function badRequest(message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: { message }
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function createSnippet(content: string, maxLength = 240): string {
  const normalized = compactWhitespace(content);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

let openaiClient: OpenAI | undefined;

function getOpenAiClient(): OpenAI | undefined {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function buildContextFromHits(hits: ChunkSearchHit[]): string {
  return hits
    .map(
      (hit, index) =>
        `[Source ${index + 1}: ${hit.fileName} — chunk ${hit.chunkIndex + 1}]\n${compactWhitespace(hit.content)}`
    )
    .join("\n\n");
}

async function generateAnswer(
  question: string,
  hits: ChunkSearchHit[]
): Promise<string> {
  const client = getOpenAiClient();

  if (!client) {
    if (hits.length === 0) {
      return "현재 tenant 범위에서 질문과 관련된 인덱싱 문서를 찾지 못했습니다. 질문 표현을 바꾸거나 문서 인덱싱 상태를 먼저 확인해 주세요.";
    }
    const lines = hits.map(
      (hit, i) =>
        `${i + 1}. ${hit.fileName} chunk ${hit.chunkIndex + 1}: ${createSnippet(hit.content, 180)}`
    );
    return ["OPENAI_API_KEY 미설정. 검색 결과 요약:", ...lines].join("\n");
  }

  const model = process.env.OPENAI_MODEL?.trim() ?? "gpt-4o-mini";

  if (hits.length === 0) {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful document assistant. Answer concisely in the same language as the user's question."
        },
        {
          role: "user",
          content: `No relevant documents were found. Please respond helpfully to:\n\n${question}`
        }
      ],
      temperature: 0.3,
      max_tokens: 300
    });
    return (
      completion.choices[0]?.message?.content?.trim() ??
      "답변을 생성하지 못했습니다."
    );
  }

  const context = buildContextFromHits(hits);
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful document assistant. Answer questions based solely on the provided document context. Be concise and precise. Answer in the same language as the user's question. If the answer cannot be found in the context, say so clearly."
      },
      {
        role: "user",
        content: `Document context:\n\n${context}\n\nQuestion: ${question}`
      }
    ],
    temperature: 0.1,
    max_tokens: 600
  });

  return (
    completion.choices[0]?.message?.content?.trim() ??
    "답변을 생성하지 못했습니다."
  );
}

async function chatHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  let payload: ChatRequest;

  try {
    payload = (await request.json()) as ChatRequest;
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const tenantId = payload.tenantId?.trim();
  const question = payload.question?.trim();

  if (!tenantId) {
    return badRequest("tenantId is required.");
  }

  if (!isTenantAllowed(tenantId)) {
    return {
      status: 403,
      jsonBody: { message: tenantNotAllowedMessage() }
    };
  }

  if (!question) {
    return badRequest("question is required.");
  }

  if (!searchEnabled()) {
    return {
      status: 503,
      jsonBody: {
        message: "Azure AI Search is disabled."
      }
    };
  }

  try {
    const top = Number(process.env.CHAT_SEARCH_TOP ?? "5");
    const searchTop = Number.isFinite(top) && top > 0 ? top : 5;
    const configuredSearchMode = getConfiguredSearchMode();
    const embeddingsAvailable = embeddingEnabled();

    let queryEmbedding: number[] | undefined;
    if (configuredSearchMode !== "keyword" && embeddingsAvailable) {
      queryEmbedding = (await generateEmbedding(question)) ?? undefined;
    }

    if (configuredSearchMode === "vector" && !queryEmbedding) {
      return {
        status: 503,
        jsonBody: {
          message:
            "CHAT_SEARCH_MODE=vector requires EMBEDDING_ENABLED=true and valid embedding credentials."
        }
      };
    }

    const effectiveSearchMode: SearchMode =
      configuredSearchMode === "hybrid" && !queryEmbedding
        ? "keyword"
        : configuredSearchMode;

    const hits = await searchChunkDocuments(
      question,
      tenantId,
      searchTop,
      queryEmbedding,
      effectiveSearchMode
    );

    context.log("Chat search executed.", {
      tenantId,
      configuredSearchMode,
      effectiveSearchMode,
      vectorUsed: !!queryEmbedding && effectiveSearchMode !== "keyword",
      retrievedChunks: hits.length
    });

    const answer = await generateAnswer(question, hits);

    const responseBody: ChatResponse = {
      answer,
      citations: hits.map(hit => ({
        documentId: hit.documentId,
        fileName: hit.fileName,
        blobName: hit.blobName,
        chunkIndex: hit.chunkIndex,
        snippet: createSnippet(hit.content),
        score: hit.score
      })),
      usage: {
        tenantId,
        retrievedChunks: hits.length,
        searchMode: effectiveSearchMode,
        vectorUsed: !!queryEmbedding && effectiveSearchMode !== "keyword"
      }
    };

    return {
      status: 200,
      jsonBody: responseBody,
      headers: {
        "content-type": "application/json"
      }
    };
  } catch (error) {
    context.error("Failed to answer chat request", error);
    return {
      status: 500,
      jsonBody: {
        message: "Failed to answer chat request."
      }
    };
  }
}

app.http("chat", {
  route: "chat",
  methods: ["POST"],
  authLevel: "function",
  handler: chatHandler
});
