import { app, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { chunkText } from "../shared/chunkText.js";
import { upsertDocumentMetadata } from "../shared/documentMetadataStore.js";
import {
  embeddingEnabled,
  generateEmbeddings
} from "../shared/embeddingStore.js";
import { extractDocumentText } from "../shared/extractDocumentText.js";
import { indexChunkDocuments } from "../shared/searchIndexStore.js";
import { isTenantAllowed } from "../shared/tenantPolicy.js";

type ProcessingJobMessage = {
  documentId?: string;
  tenantId?: string;
  blobName?: string;
  queuedAt?: string;
  contentLength?: number;
  source?: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseQueueMessage(queueEntry: unknown): ProcessingJobMessage {
  if (typeof queueEntry === "string") {
    try {
      return JSON.parse(queueEntry) as ProcessingJobMessage;
    } catch {
      return { blobName: queueEntry };
    }
  }

  if (typeof queueEntry === "object" && queueEntry !== null) {
    return queueEntry as ProcessingJobMessage;
  }

  return {};
}

function getFileNameFromBlobName(blobName: string): string {
  return blobName.split("/").pop() ?? blobName;
}

async function processQueuedDocumentHandler(
  queueEntry: unknown,
  context: InvocationContext
): Promise<void> {
  const message = parseQueueMessage(queueEntry);
  const blobName = message.blobName?.trim();

  if (!blobName) {
    context.warn("Processing job message missing blobName.", { message });
    return;
  }

  context.log("Processing job received.", {
    queueName: process.env.AZURE_PROCESSING_QUEUE_NAME ?? "processing-jobs",
    documentId: message.documentId,
    tenantId: message.tenantId,
    blobName,
    queuedAt: message.queuedAt,
    source: message.source
  });

  if (message.tenantId && !isTenantAllowed(message.tenantId)) {
    context.warn("Skipping job for tenantId not in allowlist.", {
      tenantId: message.tenantId,
      blobName
    });
    return;
  }

  if (message.documentId && message.tenantId) {
    await upsertDocumentMetadata(
      {
        documentId: message.documentId,
        tenantId: message.tenantId,
        blobName,
        status: "processing"
      },
      context
    );
  }

  try {
    const connectionString = getRequiredEnv("AzureWebJobsStorage");
    const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME ?? "uploads";
    const chunkSize = Number(process.env.CHUNK_SIZE_CHARS ?? "1200");
    const chunkOverlap = Number(process.env.CHUNK_OVERLAP_CHARS ?? "200");

    const blobServiceClient =
      BlobServiceClient.fromConnectionString(connectionString);
    const blobClient = blobServiceClient
      .getContainerClient(containerName)
      .getBlobClient(blobName);

    const props = await blobClient.getProperties();
    const contentType = props.contentType;

    const download = await blobClient.downloadToBuffer();
    const extracted = await extractDocumentText(
      blobName,
      contentType,
      download
    );

    if (!extracted) {
      if (message.documentId && message.tenantId) {
        await upsertDocumentMetadata(
          {
            documentId: message.documentId,
            tenantId: message.tenantId,
            blobName,
            status: "skipped",
            contentType
          },
          context
        );
      }

      context.log("Skipping unsupported blob (no text/PDF layer or OCR text).", {
        blobName,
        contentType
      });
      return;
    }

    const text = extracted.text;
    if (!text) {
      if (message.documentId && message.tenantId) {
        await upsertDocumentMetadata(
          {
            documentId: message.documentId,
            tenantId: message.tenantId,
            blobName,
            status: "failed",
            contentType,
            errorMessage: "No extractable text found in document."
          },
          context
        );
      }

      context.warn("Document text extraction produced empty content.", {
        blobName,
        contentType,
        sourceType: extracted.sourceType
      });
      return;
    }

    const chunks = chunkText(text, {
      chunkSize: Number.isFinite(chunkSize) ? chunkSize : 1200,
      overlap: Number.isFinite(chunkOverlap) ? chunkOverlap : 200
    });

    let embeddings: (number[] | null)[] = chunks.map(() => null);
    if (embeddingEnabled()) {
      embeddings = await generateEmbeddings(chunks.map(c => c.content));
      context.log("Embeddings generated.", {
        total: chunks.length,
        succeeded: embeddings.filter(Boolean).length
      });
    }

    const indexed = await indexChunkDocuments(
      chunks.map((chunk, i) => ({
        id: `${message.documentId ?? blobName}-${chunk.chunkIndex}`,
        tenantId: message.tenantId ?? "unknown",
        documentId: message.documentId ?? "unknown",
        blobName,
        fileName: getFileNameFromBlobName(blobName),
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentLength: chunk.content.length,
        sourceType: extracted.sourceType,
        embedding: embeddings[i] ?? undefined
      }))
    );

    if (message.documentId && message.tenantId) {
      await upsertDocumentMetadata(
        {
          documentId: message.documentId,
          tenantId: message.tenantId,
          blobName,
          status: indexed ? "indexed" : "chunked",
          contentType,
          contentLength: text.length,
          chunkCount: chunks.length
        },
        context
      );
    }

    context.log("Step 6 chunking completed.", {
      documentId: message.documentId,
      blobName,
      contentType,
      sourceType: extracted.sourceType,
      textLength: text.length,
      chunkCount: chunks.length,
      indexed,
      firstChunkPreview: chunks[0]?.content.slice(0, 120) ?? ""
    });
  } catch (error) {
    if (message.documentId && message.tenantId) {
      await upsertDocumentMetadata(
        {
          documentId: message.documentId,
          tenantId: message.tenantId,
          blobName,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        context
      );
    }

    throw error;
  }
}

app.serviceBusQueue("processing-worker", {
  queueName: process.env.AZURE_PROCESSING_QUEUE_NAME ?? "processing-jobs",
  connection: "SERVICE_BUS_CONNECTION",
  handler: processQueuedDocumentHandler
});
