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

type ChatTurnRole = "user" | "assistant";

type ChatTurnMessage = {
  role: ChatTurnRole;
  content: string;
};

type ChatRequest = {
  tenantId?: string;
  question?: string;
  sessionId?: string;
  summaryMemory?: string;
  messages?: ChatTurnMessage[];
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
  memory: {
    sessionId: string;
    summary: string;
    recentTurnsUsed: number;
  };
  usage: {
    tenantId: string;
    retrievedChunks: number;
    searchMode: SearchMode;
    vectorUsed: boolean;
    fallbackUsed: boolean;
    responseChars: number;
    promptChars: number;
    promptCapped: boolean;
    latencyMs: number;
    maxCompletionTokens: number;
    promptTokenCount?: number;
    completionTokenCount?: number;
    totalTokenCount?: number;
  };
};

type ChatCostCaps = {
  promptCharBudget: number;
  questionCharLimit: number;
  contextCharBudget: number;
  maxCompletionTokens: number;
  memoryRecentTurns: number;
  memoryRecentCharBudget: number;
  memorySummaryCharBudget: number;
  slowThresholdMs: number;
};

type MemoryContext = {
  summary: string;
  recentTurnsUsed: number;
  promptText: string;
};

type PromptPayload = {
  text: string;
  promptChars: number;
  promptCapped: boolean;
};

type AnswerGenerationResult = {
  answer: string;
  fallbackUsed: boolean;
  promptChars: number;
  promptCapped: boolean;
  promptTokenCount?: number;
  completionTokenCount?: number;
  totalTokenCount?: number;
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

function parsePositiveIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return Math.max(min, Math.min(max, rounded));
}

function getChatCostCaps(): ChatCostCaps {
  return {
    promptCharBudget: parsePositiveIntEnv(
      "CHAT_PROMPT_CHAR_BUDGET",
      12000,
      2000,
      60000
    ),
    questionCharLimit: parsePositiveIntEnv(
      "CHAT_QUESTION_CHAR_LIMIT",
      1200,
      200,
      6000
    ),
    contextCharBudget: parsePositiveIntEnv(
      "CHAT_CONTEXT_CHAR_BUDGET",
      7000,
      1000,
      30000
    ),
    maxCompletionTokens: parsePositiveIntEnv(
      "CHAT_MAX_COMPLETION_TOKENS",
      600,
      100,
      4000
    ),
    memoryRecentTurns: parsePositiveIntEnv(
      "CHAT_MEMORY_RECENT_TURNS",
      3,
      1,
      10
    ),
    memoryRecentCharBudget: parsePositiveIntEnv(
      "CHAT_MEMORY_RECENT_CHAR_BUDGET",
      2200,
      300,
      12000
    ),
    memorySummaryCharBudget: parsePositiveIntEnv(
      "CHAT_MEMORY_SUMMARY_CHAR_BUDGET",
      1200,
      200,
      8000
    ),
    slowThresholdMs: parsePositiveIntEnv(
      "CHAT_SLOW_THRESHOLD_MS",
      4000,
      500,
      120000
    )
  };
}

function trimToLength(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function sanitizeMessages(
  messages: ChatTurnMessage[] | undefined,
  maxMessages = 24,
  maxCharsPerMessage = 800
): ChatTurnMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const sliced = messages.slice(-maxMessages);
  return sliced
    .filter(message => message.role === "user" || message.role === "assistant")
    .map(message => ({
      role: message.role,
      content: trimToLength(message.content, maxCharsPerMessage)
    }))
    .filter(message => Boolean(message.content));
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

function buildContextFromHits(
  hits: ChunkSearchHit[],
  maxChars: number
): string {
  const combined = hits
    .map(
      (hit, index) =>
        `[Source ${index + 1}: ${hit.fileName} — chunk ${hit.chunkIndex + 1}]\n${compactWhitespace(hit.content)}`
    )
    .join("\n\n");

  return trimToLength(combined, maxChars);
}

function formatTurns(messages: ChatTurnMessage[], maxChars: number): string {
  const formatted = messages
    .map(message => {
      const roleLabel = message.role === "user" ? "User" : "Assistant";
      return `${roleLabel}: ${message.content}`;
    })
    .join("\n");

  return trimToLength(formatted, maxChars);
}

function summarizeOlderTurns(
  olderMessages: ChatTurnMessage[],
  summaryMemory: string,
  maxChars: number
): string {
  const parts: string[] = [];
  const normalizedSummaryMemory = trimToLength(summaryMemory, maxChars);
  if (normalizedSummaryMemory) {
    parts.push(`Previous summary: ${normalizedSummaryMemory}`);
  }

  if (olderMessages.length > 0) {
    const concise = olderMessages
      .slice(-8)
      .map(message => {
        const roleLabel = message.role === "user" ? "U" : "A";
        return `${roleLabel}: ${trimToLength(message.content, 120)}`;
      })
      .join(" | ");
    if (concise) {
      parts.push(`Older turns summary: ${concise}`);
    }
  }

  return trimToLength(parts.join("\n"), maxChars);
}

function buildMemoryContext(
  messages: ChatTurnMessage[],
  summaryMemory: string | undefined,
  caps: ChatCostCaps
): MemoryContext {
  if (messages.length === 0 && !summaryMemory?.trim()) {
    return {
      summary: "",
      recentTurnsUsed: 0,
      promptText: ""
    };
  }

  const recentMessageCount = Math.min(
    messages.length,
    caps.memoryRecentTurns * 2
  );
  const recentMessages = messages.slice(-recentMessageCount);
  const olderMessages = messages.slice(
    0,
    Math.max(0, messages.length - recentMessageCount)
  );

  const summary = summarizeOlderTurns(
    olderMessages,
    summaryMemory ?? "",
    caps.memorySummaryCharBudget
  );
  const recentTurns = formatTurns(recentMessages, caps.memoryRecentCharBudget);

  const sections: string[] = [];
  if (summary) {
    sections.push(`Conversation summary memory:\n${summary}`);
  }
  if (recentTurns) {
    sections.push(`Recent turns:\n${recentTurns}`);
  }

  return {
    summary,
    recentTurnsUsed: recentMessages.length,
    promptText: sections.join("\n\n")
  };
}

function applyPromptBudget(
  question: string,
  contextText: string,
  memoryText: string,
  caps: ChatCostCaps
): PromptPayload {
  const normalizedQuestion = trimToLength(question, caps.questionCharLimit);
  let contextSection = contextText;
  let memorySection = memoryText;
  const initialContextLength = contextSection.length;
  const initialMemoryLength = memorySection.length;

  const renderPrompt = () => {
    const chunks: string[] = [];
    if (memorySection) {
      chunks.push(`Conversation memory:\n\n${memorySection}`);
    }
    if (contextSection) {
      chunks.push(`Document context:\n\n${contextSection}`);
    }
    chunks.push(`Question:\n\n${normalizedQuestion}`);
    return chunks.join("\n\n");
  };

  let text = renderPrompt();
  let guard = 0;
  while (text.length > caps.promptCharBudget && guard < 8) {
    const overflow = text.length - caps.promptCharBudget;
    if (
      contextSection.length >= memorySection.length &&
      contextSection.length > 300
    ) {
      contextSection = trimToLength(
        contextSection,
        Math.max(300, contextSection.length - overflow)
      );
    } else if (memorySection.length > 180) {
      memorySection = trimToLength(
        memorySection,
        Math.max(180, memorySection.length - overflow)
      );
    } else {
      break;
    }
    text = renderPrompt();
    guard += 1;
  }

  return {
    text,
    promptChars: text.length,
    promptCapped:
      text.length > caps.promptCharBudget ||
      contextSection.length < initialContextLength ||
      memorySection.length < initialMemoryLength
  };
}

function extractIdentitySubject(question: string): string | null {
  const normalized = question.trim().replace(/\?+$/, "");
  const englishMatch = normalized.match(/^who is\s+(.+)$/i);
  if (englishMatch?.[1]) {
    return englishMatch[1].trim().toLowerCase();
  }

  const koreanMatch = normalized.match(
    /^(.+)\s*(?:이|가)?\s*누구(?:야|예요|인가요)?$/
  );
  if (koreanMatch?.[1]) {
    return koreanMatch[1].trim().toLowerCase();
  }

  return null;
}

function chooseSearchOnlyLeadHit(
  question: string,
  hits: ChunkSearchHit[]
): ChunkSearchHit {
  const subject = extractIdentitySubject(question);
  if (!subject) {
    return hits[0];
  }

  const exactContentMatches = hits
    .filter(hit =>
      compactWhitespace(hit.content).toLowerCase().includes(subject)
    )
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (exactContentMatches.length > 0) {
    return exactContentMatches[0];
  }

  const fileNameMatches = hits
    .filter(hit => hit.fileName.toLowerCase().includes(subject))
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (fileNameMatches.length > 0) {
    return fileNameMatches[0];
  }

  return hits[0];
}

function buildSearchOnlyAnswer(
  question: string,
  hits: ChunkSearchHit[]
): string {
  if (hits.length === 0) {
    return "No indexed documents matched this question for the current tenant. Try rephrasing the question or check document indexing status.";
  }

  const lead = chooseSearchOnlyLeadHit(question, hits);
  const leadSnippet = createSnippet(lead.content, 280);
  const supportingLines = hits
    .filter(hit => hit.id !== lead.id)
    .slice(0, 2)
    .map(
      hit =>
        `- ${hit.fileName} chunk ${hit.chunkIndex + 1}: ${createSnippet(hit.content, 160)}`
    );

  const sections = [
    `Based on the indexed documents for this tenant, the strongest match is: ${leadSnippet}`
  ];

  if (supportingLines.length > 0) {
    sections.push("Supporting matches:");
    sections.push(...supportingLines);
  }

  return sections.join("\n");
}

async function generateAnswer(
  question: string,
  hits: ChunkSearchHit[],
  memoryContext: MemoryContext,
  caps: ChatCostCaps
): Promise<AnswerGenerationResult> {
  const client = getOpenAiClient();
  const documentContext = buildContextFromHits(hits, caps.contextCharBudget);
  const promptPayload = applyPromptBudget(
    question,
    documentContext,
    memoryContext.promptText,
    caps
  );

  if (!client) {
    return {
      answer: buildSearchOnlyAnswer(question, hits),
      fallbackUsed: true,
      promptChars: promptPayload.promptChars,
      promptCapped: promptPayload.promptCapped
    };
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
          content: `No relevant documents were found. Use conversation memory if available, and be explicit if confidence is low.\n\n${promptPayload.text}`
        }
      ],
      temperature: 0.3,
      max_tokens: caps.maxCompletionTokens
    });

    return {
      answer:
        completion.choices[0]?.message?.content?.trim() ??
        "Could not generate an answer.",
      fallbackUsed: false,
      promptChars: promptPayload.promptChars,
      promptCapped: promptPayload.promptCapped,
      promptTokenCount: completion.usage?.prompt_tokens,
      completionTokenCount: completion.usage?.completion_tokens,
      totalTokenCount: completion.usage?.total_tokens
    };
  }

  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful document assistant. Answer questions based on conversation memory plus provided document context. Be concise and precise. Answer in the same language as the user's question. If the answer cannot be found in context, say so clearly."
      },
      {
        role: "user",
        content: promptPayload.text
      }
    ],
    temperature: 0.1,
    max_tokens: caps.maxCompletionTokens
  });

  return {
    answer:
      completion.choices[0]?.message?.content?.trim() ??
      "Could not generate an answer.",
    fallbackUsed: false,
    promptChars: promptPayload.promptChars,
    promptCapped: promptPayload.promptCapped,
    promptTokenCount: completion.usage?.prompt_tokens,
    completionTokenCount: completion.usage?.completion_tokens,
    totalTokenCount: completion.usage?.total_tokens
  };
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
    const caps = getChatCostCaps();
    const configuredSearchMode = getConfiguredSearchMode();
    const embeddingsAvailable = embeddingEnabled();
    const startMs = Date.now();
    const sessionId = payload.sessionId?.trim() || `${tenantId}-default`;
    const normalizedQuestion = trimToLength(question, caps.questionCharLimit);
    const sanitizedMessages = sanitizeMessages(payload.messages);
    const memoryContext = buildMemoryContext(
      sanitizedMessages,
      payload.summaryMemory,
      caps
    );

    let queryEmbedding: number[] | undefined;
    if (configuredSearchMode !== "keyword" && embeddingsAvailable) {
      queryEmbedding =
        (await generateEmbedding(normalizedQuestion)) ?? undefined;
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
      normalizedQuestion,
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

    const generationResult = await generateAnswer(
      normalizedQuestion,
      hits,
      memoryContext,
      caps
    );
    const latencyMs = Date.now() - startMs;
    const responseChars = generationResult.answer.length;

    const telemetryPayload = {
      tenantId,
      sessionId,
      configuredSearchMode,
      effectiveSearchMode,
      vectorUsed: !!queryEmbedding && effectiveSearchMode !== "keyword",
      retrievedChunks: hits.length,
      fallbackUsed: generationResult.fallbackUsed,
      responseChars,
      promptChars: generationResult.promptChars,
      promptCapped: generationResult.promptCapped,
      latencyMs,
      slow: latencyMs >= caps.slowThresholdMs,
      maxCompletionTokens: caps.maxCompletionTokens,
      recentTurnsUsed: memoryContext.recentTurnsUsed,
      summaryChars: memoryContext.summary.length
    };

    context.log("Chat telemetry", telemetryPayload);
    if (generationResult.fallbackUsed) {
      context.warn("Chat fallback mode used", telemetryPayload);
    }
    if (latencyMs >= caps.slowThresholdMs) {
      context.warn("Chat latency threshold exceeded", telemetryPayload);
    }

    const responseBody: ChatResponse = {
      answer: generationResult.answer,
      citations: hits.map(hit => ({
        documentId: hit.documentId,
        fileName: hit.fileName,
        blobName: hit.blobName,
        chunkIndex: hit.chunkIndex,
        snippet: createSnippet(hit.content),
        score: hit.score
      })),
      memory: {
        sessionId,
        summary: memoryContext.summary,
        recentTurnsUsed: memoryContext.recentTurnsUsed
      },
      usage: {
        tenantId,
        retrievedChunks: hits.length,
        searchMode: effectiveSearchMode,
        vectorUsed: !!queryEmbedding && effectiveSearchMode !== "keyword",
        fallbackUsed: generationResult.fallbackUsed,
        responseChars,
        promptChars: generationResult.promptChars,
        promptCapped: generationResult.promptCapped,
        latencyMs,
        maxCompletionTokens: caps.maxCompletionTokens,
        promptTokenCount: generationResult.promptTokenCount,
        completionTokenCount: generationResult.completionTokenCount,
        totalTokenCount: generationResult.totalTokenCount
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
    context.error("Failed to answer chat request", {
      tenantId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
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
  authLevel: "anonymous",
  handler: chatHandler
});
