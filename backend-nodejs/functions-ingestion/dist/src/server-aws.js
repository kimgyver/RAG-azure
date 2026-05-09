/**
 * server-aws.ts — Express HTTP server for AWS (ECS/Fargate) deployment.
 * Replaces Azure Functions HTTP triggers. Import ordering mirrors app.ts.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { chunkText } from "./shared/chunkText.js";
import { embeddingEnabled, generateEmbeddings, generateEmbedding } from "./shared/embeddingStore.js";
import { resolveSearchMode } from "./shared/searchIndexStore.js";
import { getRuntimeConfigSnapshot } from "./shared/runtimeConfig.js";
import { sanitizeFileName } from "./shared/sas.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "./shared/tenantPolicy.js";
import { getStorageProvider, getDocumentStore, getSearchStore } from "./providers/index.js";
import OpenAI from "openai";
const documentStore = getDocumentStore();
const searchStore = getSearchStore();
const app = express();
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin)
        res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-functions-key");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
});
app.use(express.json({ limit: "10mb" }));
// ── Health ──────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
});
// ── Runtime config / flags ───────────────────────────────────────────────────
app.get("/api/flags/deployment", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(getRuntimeConfigSnapshot());
});
// ── Document catalog ─────────────────────────────────────────────────────────
app.get("/api/documents/catalog", async (req, res) => {
    const tenantId = String(req.query.tenantId ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    const [cosmosDocs, searchGroups] = await Promise.all([
        documentStore.isEnabled()
            ? documentStore.listByTenant(tenantId, 200)
            : Promise.resolve([]),
        searchStore.isEnabled()
            ? searchStore.listDocumentGroups(tenantId)
            : Promise.resolve([])
    ]);
    const searchMap = new Map(searchGroups.map(g => [String(g.documentId), g]));
    const cosmosMap = new Map(cosmosDocs.map(d => [String(d.documentId), d]));
    const allIds = new Set([...cosmosMap.keys(), ...searchMap.keys()]);
    const rows = Array.from(allIds).map(id => {
        const c = cosmosMap.get(id);
        const s = searchMap.get(id);
        return {
            documentId: id,
            tenantId,
            fileName: c?.blobName?.split("/").pop() ?? s?.fileName ?? id,
            blobName: c?.blobName ?? s?.blobName ?? "",
            cosmos: c
                ? {
                    status: c.status,
                    updatedAt: c.updatedAt,
                    chunkCount: c.chunkCount,
                    contentType: c.contentType,
                    sourceType: c.sourceType,
                    hasSourceText: Boolean(c.sourceText)
                }
                : null,
            search: s
                ? {
                    chunkCount: s.chunkCount,
                    fileName: s.fileName,
                    blobName: s.blobName
                }
                : null
        };
    });
    res.json({
        tenantId,
        documents: rows,
        sources: {
            cosmos: documentStore.isEnabled(),
            search: searchStore.isEnabled()
        }
    });
});
// ── Document status ───────────────────────────────────────────────────────────
app.get("/api/documents/:documentId", async (req, res) => {
    const { documentId } = req.params;
    const tenantId = String(req.query.tenantId ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    if (!documentStore.isEnabled())
        return res.status(503).json({ message: "Document store is disabled." });
    const record = (await documentStore.get(documentId, tenantId));
    if (!record)
        return res.status(404).json({ message: "Document not found." });
    res.json({
        id: String(record.id ?? documentId),
        documentId,
        tenantId,
        blobName: String(record.blobName ?? ""),
        status: String(record.status ?? "queued"),
        contentType: record.contentType,
        contentLength: record.contentLength,
        chunkCount: record.chunkCount,
        errorMessage: record.errorMessage,
        createdAt: String(record.createdAt ?? record.updatedAt ?? new Date().toISOString()),
        updatedAt: String(record.updatedAt ?? new Date().toISOString())
    });
});
// ── Document source text ──────────────────────────────────────────────────────
app.get("/api/documents/:documentId/source", async (req, res) => {
    const { documentId } = req.params;
    const tenantId = String(req.query.tenantId ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    if (!documentStore.isEnabled())
        return res.status(503).json({ message: "Document store is disabled." });
    const record = (await documentStore.get(documentId, tenantId));
    if (!record)
        return res.status(404).json({ message: "Document not found." });
    if (!record.sourceText)
        return res.status(404).json({ message: "Source text not available." });
    res.json({
        documentId,
        tenantId,
        fileName: String(record.blobName ?? documentId)
            .split("/")
            .pop() ?? documentId,
        sourceType: String(record.sourceType ?? "unknown"),
        sourceText: String(record.sourceText),
        updatedAt: String(record.updatedAt ?? new Date().toISOString())
    });
});
// ── Purge document ────────────────────────────────────────────────────────────
app.delete("/api/documents/:documentId/purge", async (req, res) => {
    const { documentId } = req.params;
    const tenantId = String(req.query.tenantId ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    let cosmosDeleted = false;
    let chunksDeleted = 0;
    if (documentStore.isEnabled()) {
        await documentStore.delete(documentId, tenantId);
        cosmosDeleted = true;
    }
    if (searchStore.isEnabled()) {
        chunksDeleted = await searchStore.deleteChunksForDocument(documentId, tenantId);
    }
    const remainingSearchChunks = searchStore.isEnabled()
        ? await searchStore.countChunksForDocument(documentId, tenantId)
        : 0;
    res.json({
        documentId,
        tenantId,
        cosmosDeleted,
        deletedSearchChunks: chunksDeleted,
        remainingSearchChunks
    });
});
// ── Create text knowledge ─────────────────────────────────────────────────────
app.post("/api/knowledge/text", async (req, res) => {
    const { tenantId: rawTenant, title, text: rawText } = req.body ?? {};
    const tenantId = String(rawTenant ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    if (!rawText?.trim())
        return res.status(400).json({ message: "text is required." });
    const maxChars = Number(process.env.TEXT_KNOWLEDGE_MAX_CHARS ?? "120000");
    if (rawText.length > maxChars)
        return res
            .status(400)
            .json({ message: `text exceeds max length (${maxChars} chars).` });
    const documentId = randomUUID();
    const fileName = (() => {
        const safe = sanitizeFileName(String(title ?? "manual-note").trim() || "manual-note");
        return safe.toLowerCase().endsWith(".txt") ? safe : `${safe}.txt`;
    })();
    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const blobName = `${tenantId}/manual/${dateFolder}/${documentId}-${fileName}`;
    await documentStore.upsert({
        documentId,
        tenantId,
        blobName,
        status: "processing",
        contentType: "text/plain",
        sourceType: "manual-text"
    });
    const chunkSize = Number(process.env.CHUNK_SIZE_CHARS ?? "1200");
    const chunkOverlap = Number(process.env.CHUNK_OVERLAP_CHARS ?? "200");
    const chunks = chunkText(rawText.trim(), {
        chunkSize,
        overlap: chunkOverlap
    });
    let embeddings = chunks.map(() => null);
    if (embeddingEnabled()) {
        embeddings = await generateEmbeddings(chunks.map(c => c.content));
    }
    const indexed = await searchStore.indexChunks(chunks.map((chunk, i) => ({
        id: `${documentId}-${chunk.chunkIndex}`,
        tenantId,
        documentId,
        blobName,
        fileName,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentLength: chunk.content.length,
        sourceType: "manual-text",
        embedding: embeddings[i] ?? undefined
    })));
    const status = indexed ? "indexed" : "chunked";
    await documentStore.upsert({
        documentId,
        tenantId,
        blobName,
        status,
        contentType: "text/plain",
        contentLength: rawText.length,
        chunkCount: chunks.length,
        sourceType: "manual-text",
        sourceText: rawText.trim()
    });
    res.json({
        documentId,
        tenantId,
        blobName,
        fileName,
        contentLength: rawText.length,
        chunkCount: chunks.length,
        indexed,
        status
    });
});
// ── Create upload (presigned URL) ─────────────────────────────────────────────
app.post("/api/uploads/create", async (req, res) => {
    const { tenantId: rawTenant, fileName: rawFile, contentType } = req.body ?? {};
    const tenantId = String(rawTenant ?? "").trim();
    const fileName = String(rawFile ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    if (!fileName)
        return res.status(400).json({ message: "fileName is required." });
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME ??
        process.env.S3_BUCKET_NAME ??
        "uploads";
    const expiryMinutes = Number(process.env.SAS_EXPIRY_MINUTES ?? "15");
    if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
        return res
            .status(400)
            .json({ message: "SAS_EXPIRY_MINUTES must be a positive number." });
    }
    const documentId = randomUUID();
    const storage = getStorageProvider();
    const blobName = storage.buildUploadBlobName(tenantId, documentId, fileName);
    let uploadUrl;
    try {
        uploadUrl = await storage.createUploadUrl({
            blobName,
            containerName,
            expiryMinutes,
            contentType
        });
    }
    catch {
        return res.status(500).json({ message: "Failed to create upload URL." });
    }
    await documentStore.upsert({
        documentId,
        tenantId,
        blobName,
        status: "queued",
        contentType
    });
    res.json({
        documentId,
        tenantId,
        blobName,
        uploadUrl,
        expiresInMinutes: expiryMinutes
    });
});
// ── Confirm upload (enqueue to SQS after S3 PUT completes) ───────────────────
app.post("/api/uploads/confirm", async (req, res) => {
    const { tenantId: rawTenant, documentId: rawDocId, blobName: rawBlob } = req.body ?? {};
    const tenantId = String(rawTenant ?? "").trim();
    const documentId = String(rawDocId ?? "").trim();
    const blobName = String(rawBlob ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    if (!documentId)
        return res.status(400).json({ message: "documentId is required." });
    if (!blobName)
        return res.status(400).json({ message: "blobName is required." });
    const sqsQueueUrl = process.env.SQS_QUEUE_URL;
    if (!sqsQueueUrl)
        return res.status(503).json({ message: "SQS is not configured." });
    const sqsClient = new SQSClient({
        region: process.env.AWS_REGION ?? "ap-southeast-2"
    });
    const messageBody = JSON.stringify({
        documentId,
        tenantId,
        blobName,
        queuedAt: new Date().toISOString(),
        source: "http-upload"
    });
    try {
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: sqsQueueUrl,
            MessageBody: messageBody
        }));
    }
    catch (err) {
        console.error("[uploads/confirm] SQS send failed:", err);
        return res
            .status(500)
            .json({ message: "Failed to enqueue document for processing." });
    }
    res.json({ documentId, tenantId, blobName, queued: true });
});
// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
    const { tenantId: rawTenant, question, messages = [], sessionId, summaryMemory } = req.body ?? {};
    const tenantId = String(rawTenant ?? "").trim();
    if (!tenantId)
        return res.status(400).json({ message: "tenantId is required." });
    if (!isTenantAllowed(tenantId))
        return res.status(403).json({ message: tenantNotAllowedMessage() });
    if (!question?.trim())
        return res.status(400).json({ message: "question is required." });
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    if (!openaiKey)
        return res.status(503).json({ message: "OpenAI is not configured." });
    const chatModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
    const maxCompletionTokens = Number(process.env.MAX_COMPLETION_TOKENS ?? "1000");
    const top = Number(process.env.SEARCH_TOP_K ?? "3");
    const mode = resolveSearchMode(process.env.CHAT_SEARCH_MODE);
    let queryEmbedding;
    if (embeddingEnabled() && mode !== "keyword") {
        queryEmbedding = (await generateEmbedding(question)) ?? undefined;
    }
    const hits = searchStore.isEnabled()
        ? (await searchStore.searchChunks(question, tenantId, top, queryEmbedding, mode))
        : [];
    const citations = hits.map(h => ({
        documentId: h.documentId,
        fileName: h.fileName,
        blobName: h.blobName,
        chunkIndex: h.chunkIndex,
        snippet: String(h.content ?? "").slice(0, 300),
        score: h.score
    }));
    const contextText = hits
        .map(h => String(h.content ?? ""))
        .join("\n\n---\n\n");
    const systemPrompt = contextText
        ? `Answer based on the following context:\n\n${contextText}`
        : "You are a helpful assistant.";
    const openai = new OpenAI({ apiKey: openaiKey });
    const chatMessages = [
        { role: "system", content: systemPrompt },
        ...messages,
        { role: "user", content: question }
    ];
    const completion = await openai.chat.completions.create({
        model: chatModel,
        messages: chatMessages,
        max_tokens: maxCompletionTokens
    });
    const answer = completion.choices[0]?.message?.content ?? "";
    res.json({
        answer,
        citations,
        memory: {
            sessionId: sessionId ?? randomUUID(),
            summary: summaryMemory ?? "",
            recentTurnsUsed: messages.length
        },
        usage: {
            tenantId,
            retrievedChunks: hits.length,
            searchMode: mode,
            vectorUsed: Boolean(queryEmbedding),
            fallbackUsed: false,
            responseChars: answer.length,
            promptChars: systemPrompt.length,
            promptCapped: false,
            latencyMs: 0,
            maxCompletionTokens,
            promptTokenCount: completion.usage?.prompt_tokens,
            completionTokenCount: completion.usage?.completion_tokens,
            totalTokenCount: completion.usage?.total_tokens
        }
    });
});
// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
});
export { app };
// Only start HTTP server when running standalone (not in Lambda)
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const port = Number(process.env.PORT ?? 8000);
    app.listen(port, () => {
        console.log(`[aws-server] listening on port ${port}`);
    });
}
