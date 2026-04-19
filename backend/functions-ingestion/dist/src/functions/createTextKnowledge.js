import { app } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { chunkText } from "../shared/chunkText.js";
import { upsertDocumentMetadata } from "../shared/documentMetadataStore.js";
import { embeddingEnabled, generateEmbeddings } from "../shared/embeddingStore.js";
import { indexChunkDocuments } from "../shared/searchIndexStore.js";
import { sanitizeFileName } from "../shared/sas.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "../shared/tenantPolicy.js";
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { message }
    };
}
function normalizeTextFileName(inputTitle) {
    const raw = inputTitle?.trim() || "manual-note";
    const safe = sanitizeFileName(raw);
    return safe.toLowerCase().endsWith(".txt") ? safe : `${safe}.txt`;
}
async function createTextKnowledgeHandler(request, context) {
    let documentId;
    let tenantId;
    let blobName;
    try {
        const payload = (await request.json());
        tenantId = payload.tenantId?.trim();
        const rawText = payload.text?.trim();
        if (!tenantId) {
            return badRequest("tenantId is required.");
        }
        if (!isTenantAllowed(tenantId)) {
            return {
                status: 403,
                jsonBody: { message: tenantNotAllowedMessage() }
            };
        }
        if (!rawText) {
            return badRequest("text is required.");
        }
        const maxChars = Number(process.env.TEXT_KNOWLEDGE_MAX_CHARS ?? "120000");
        if (Number.isFinite(maxChars) &&
            maxChars > 0 &&
            rawText.length > maxChars) {
            return badRequest(`text exceeds max length (${maxChars} chars).`);
        }
        const safeTenantId = tenantId;
        documentId = randomUUID();
        const safeDocumentId = documentId;
        const fileName = normalizeTextFileName(payload.title);
        const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
        blobName = `${safeTenantId}/manual/${dateFolder}/${safeDocumentId}-${fileName}`;
        const safeBlobName = blobName;
        await upsertDocumentMetadata({
            documentId,
            tenantId: safeTenantId,
            blobName,
            status: "processing",
            contentType: "text/plain",
            sourceType: "manual-text"
        }, context);
        const chunkSize = Number(process.env.CHUNK_SIZE_CHARS ?? "1200");
        const chunkOverlap = Number(process.env.CHUNK_OVERLAP_CHARS ?? "200");
        const chunks = chunkText(rawText, {
            chunkSize: Number.isFinite(chunkSize) ? chunkSize : 1200,
            overlap: Number.isFinite(chunkOverlap) ? chunkOverlap : 200
        });
        let embeddings = chunks.map(() => null);
        if (embeddingEnabled()) {
            embeddings = await generateEmbeddings(chunks.map(chunk => chunk.content));
            context.log("Embeddings generated for manual text ingestion.", {
                documentId,
                total: chunks.length,
                succeeded: embeddings.filter(Boolean).length
            });
        }
        const indexed = await indexChunkDocuments(chunks.map((chunk, index) => ({
            id: `${documentId}-${chunk.chunkIndex}`,
            tenantId: safeTenantId,
            documentId: safeDocumentId,
            blobName: safeBlobName,
            fileName,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            contentLength: chunk.content.length,
            sourceType: "manual-text",
            embedding: embeddings[index] ?? undefined
        })));
        const status = indexed ? "indexed" : "chunked";
        await upsertDocumentMetadata({
            documentId,
            tenantId: safeTenantId,
            blobName: safeBlobName,
            status,
            contentType: "text/plain",
            contentLength: rawText.length,
            chunkCount: chunks.length,
            sourceType: "manual-text",
            sourceText: rawText
        }, context);
        const responseBody = {
            documentId,
            tenantId: safeTenantId,
            blobName: safeBlobName,
            fileName,
            contentLength: rawText.length,
            chunkCount: chunks.length,
            indexed,
            status
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
        if (documentId && tenantId && blobName) {
            await upsertDocumentMetadata({
                documentId,
                tenantId,
                blobName,
                status: "failed",
                contentType: "text/plain",
                errorMessage: error instanceof Error ? error.message : String(error)
            }, context);
        }
        context.error("Failed to register text knowledge.", error);
        return {
            status: 500,
            jsonBody: {
                message: "Failed to register text knowledge."
            }
        };
    }
}
app.http("knowledge-text-create", {
    route: "knowledge/text",
    methods: ["POST"],
    authLevel: "anonymous",
    handler: createTextKnowledgeHandler
});
