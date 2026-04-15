import { app } from "@azure/functions";
import OpenAI from "openai";
import { embeddingEnabled, generateEmbedding } from "../shared/embeddingStore.js";
import { resolveSearchMode, searchChunkDocuments, searchEnabled } from "../shared/searchIndexStore.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "../shared/tenantPolicy.js";
function getConfiguredSearchMode() {
    return resolveSearchMode(process.env.CHAT_SEARCH_MODE);
}
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { message }
    };
}
function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function createSnippet(content, maxLength = 240) {
    const normalized = compactWhitespace(content);
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength).trimEnd()}...`;
}
let openaiClient;
function getOpenAiClient() {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        return undefined;
    }
    if (!openaiClient) {
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}
function buildContextFromHits(hits) {
    return hits
        .map((hit, index) => `[Source ${index + 1}: ${hit.fileName} — chunk ${hit.chunkIndex + 1}]\n${compactWhitespace(hit.content)}`)
        .join("\n\n");
}
function extractIdentitySubject(question) {
    const normalized = question.trim().replace(/\?+$/, "");
    const englishMatch = normalized.match(/^who is\s+(.+)$/i);
    if (englishMatch?.[1]) {
        return englishMatch[1].trim().toLowerCase();
    }
    const koreanMatch = normalized.match(/^(.+)\s*(?:이|가)?\s*누구(?:야|예요|인가요)?$/);
    if (koreanMatch?.[1]) {
        return koreanMatch[1].trim().toLowerCase();
    }
    return null;
}
function chooseSearchOnlyLeadHit(question, hits) {
    const subject = extractIdentitySubject(question);
    if (!subject) {
        return hits[0];
    }
    const exactContentMatches = hits
        .filter(hit => compactWhitespace(hit.content).toLowerCase().includes(subject))
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
function buildSearchOnlyAnswer(question, hits) {
    if (hits.length === 0) {
        return "No indexed documents matched this question for the current tenant. Try rephrasing the question or check document indexing status.";
    }
    const lead = chooseSearchOnlyLeadHit(question, hits);
    const leadSnippet = createSnippet(lead.content, 280);
    const supportingLines = hits
        .filter(hit => hit.id !== lead.id)
        .slice(0, 2)
        .map(hit => `- ${hit.fileName} chunk ${hit.chunkIndex + 1}: ${createSnippet(hit.content, 160)}`);
    const sections = [
        `Based on the indexed documents for this tenant, the strongest match is: ${leadSnippet}`
    ];
    if (supportingLines.length > 0) {
        sections.push("Supporting matches:");
        sections.push(...supportingLines);
    }
    return sections.join("\n");
}
async function generateAnswer(question, hits) {
    const client = getOpenAiClient();
    if (!client) {
        return buildSearchOnlyAnswer(question, hits);
    }
    const model = process.env.OPENAI_MODEL?.trim() ?? "gpt-4o-mini";
    if (hits.length === 0) {
        const completion = await client.chat.completions.create({
            model,
            messages: [
                {
                    role: "system",
                    content: "You are a helpful document assistant. Answer concisely in the same language as the user's question."
                },
                {
                    role: "user",
                    content: `No relevant documents were found. Please respond helpfully to:\n\n${question}`
                }
            ],
            temperature: 0.3,
            max_tokens: 300
        });
        return (completion.choices[0]?.message?.content?.trim() ??
            "Could not generate an answer.");
    }
    const context = buildContextFromHits(hits);
    const completion = await client.chat.completions.create({
        model,
        messages: [
            {
                role: "system",
                content: "You are a helpful document assistant. Answer questions based solely on the provided document context. Be concise and precise. Answer in the same language as the user's question. If the answer cannot be found in the context, say so clearly."
            },
            {
                role: "user",
                content: `Document context:\n\n${context}\n\nQuestion: ${question}`
            }
        ],
        temperature: 0.1,
        max_tokens: 600
    });
    return (completion.choices[0]?.message?.content?.trim() ??
        "Could not generate an answer.");
}
async function chatHandler(request, context) {
    let payload;
    try {
        payload = (await request.json());
    }
    catch {
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
        let queryEmbedding;
        if (configuredSearchMode !== "keyword" && embeddingsAvailable) {
            queryEmbedding = (await generateEmbedding(question)) ?? undefined;
        }
        if (configuredSearchMode === "vector" && !queryEmbedding) {
            return {
                status: 503,
                jsonBody: {
                    message: "CHAT_SEARCH_MODE=vector requires EMBEDDING_ENABLED=true and valid embedding credentials."
                }
            };
        }
        const effectiveSearchMode = configuredSearchMode === "hybrid" && !queryEmbedding
            ? "keyword"
            : configuredSearchMode;
        const hits = await searchChunkDocuments(question, tenantId, searchTop, queryEmbedding, effectiveSearchMode);
        context.log("Chat search executed.", {
            tenantId,
            configuredSearchMode,
            effectiveSearchMode,
            vectorUsed: !!queryEmbedding && effectiveSearchMode !== "keyword",
            retrievedChunks: hits.length
        });
        const answer = await generateAnswer(question, hits);
        const responseBody = {
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
    }
    catch (error) {
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
