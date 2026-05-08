/**
 * worker-aws.ts — SQS polling worker for AWS (ECS/Fargate) deployment.
 * Replaces Azure Service Bus queue trigger (processQueuedDocument).
 */
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from "@aws-sdk/client-sqs";
import { chunkText } from "./shared/chunkText.js";
import {
  embeddingEnabled,
  generateEmbeddings
} from "./shared/embeddingStore.js";
import { isTenantAllowed } from "./shared/tenantPolicy.js";
import { extractDocumentText } from "./shared/extractDocumentText.js";
import {
  getDocumentStore,
  getSearchStore,
  getStorageProvider
} from "./providers/index.js";

type ProcessingJobMessage = {
  documentId?: string;
  tenantId?: string;
  blobName?: string;
  queuedAt?: string;
  contentLength?: number;
  source?: string;
};

const region = process.env.AWS_REGION ?? "ap-southeast-2";
const queueUrl = process.env.SQS_QUEUE_URL;
const containerName =
  process.env.AZURE_STORAGE_CONTAINER_NAME ??
  process.env.S3_BUCKET_NAME ??
  "uploads";

if (!queueUrl) {
  console.error("[worker-aws] SQS_QUEUE_URL is required");
  process.exit(1);
}

const sqs = new SQSClient({ region });
const searchStore = getSearchStore();
const documentStore = getDocumentStore();

function getFileNameFromBlobName(blobName: string): string {
  return blobName.split("/").pop() ?? blobName;
}

export async function processMessage(body: string): Promise<void> {
  let message: ProcessingJobMessage = {};
  try {
    message = JSON.parse(body) as ProcessingJobMessage;
  } catch {
    // S3 event notification wrapper
    const s3Event = JSON.parse(body) as {
      Records?: { s3?: { object?: { key?: string } } }[];
    };
    const key = s3Event.Records?.[0]?.s3?.object?.key;
    if (key) {
      const decoded = decodeURIComponent(key.replace(/\+/g, " "));
      const parts = decoded.split("/");
      message = {
        blobName: decoded,
        tenantId: parts[0],
        source: "s3-event"
      };
    }
  }

  const blobName = message.blobName?.trim();
  if (!blobName) {
    console.warn("[worker-aws] Message missing blobName, skipping.", message);
    return;
  }

  if (message.tenantId && !isTenantAllowed(message.tenantId)) {
    console.warn("[worker-aws] Tenant not allowed, skipping.", {
      tenantId: message.tenantId,
      blobName
    });
    return;
  }

  if (message.documentId && message.tenantId) {
    await documentStore.upsert({
      documentId: message.documentId,
      tenantId: message.tenantId,
      blobName,
      status: "processing"
    });
  }

  const chunkSize = Number(process.env.CHUNK_SIZE_CHARS ?? "1200");
  const chunkOverlap = Number(process.env.CHUNK_OVERLAP_CHARS ?? "200");
  const storage = getStorageProvider();

  try {
    const [content, contentType] = await Promise.all([
      storage.downloadBlob(containerName, blobName),
      storage.getBlobContentType(containerName, blobName)
    ]);

    const extracted = await extractDocumentText(blobName, contentType, content);

    if (!extracted?.text) {
      const status = extracted ? "failed" : "skipped";
      if (message.documentId && message.tenantId) {
        await documentStore.upsert({
          documentId: message.documentId,
          tenantId: message.tenantId,
          blobName,
          status,
          contentType,
          errorMessage:
            status === "failed" ? "No extractable text found." : undefined
        });
      }
      console.log(`[worker-aws] Skipping blob: ${blobName} (${status})`);
      return;
    }

    const { text, sourceType } = extracted;
    const chunks = chunkText(text, {
      chunkSize: Number.isFinite(chunkSize) ? chunkSize : 1200,
      overlap: Number.isFinite(chunkOverlap) ? chunkOverlap : 200
    });

    const sourceTextMaxChars = Number(
      process.env.SOURCE_TEXT_MAX_CHARS ?? "120000"
    );
    const sourceText =
      sourceTextMaxChars > 0 ? text.slice(0, sourceTextMaxChars) : text;

    let embeddings: (number[] | null)[] = chunks.map(() => null);
    if (embeddingEnabled()) {
      embeddings = await generateEmbeddings(chunks.map(c => c.content));
    }

    const docId = message.documentId ?? blobName;
    const tenantId = message.tenantId ?? "unknown";

    const indexed = await searchStore.indexChunks(
      chunks.map((chunk, i) => ({
        id: `${docId}-${chunk.chunkIndex}`,
        tenantId,
        documentId: docId,
        blobName,
        fileName: getFileNameFromBlobName(blobName),
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentLength: chunk.content.length,
        sourceType,
        embedding: embeddings[i] ?? undefined
      }))
    );

    if (message.documentId && message.tenantId) {
      await documentStore.upsert({
        documentId: message.documentId,
        tenantId: message.tenantId,
        blobName,
        status: indexed ? "indexed" : "chunked",
        contentType,
        contentLength: text.length,
        chunkCount: chunks.length,
        sourceType,
        sourceText
      });
    }

    console.log(
      `[worker-aws] Processed: ${blobName} (${chunks.length} chunks, indexed=${indexed})`
    );
  } catch (error) {
    console.error(`[worker-aws] Processing failed: ${blobName}`, error);
    if (message.documentId && message.tenantId) {
      await documentStore.upsert({
        documentId: message.documentId,
        tenantId: message.tenantId,
        blobName,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
    throw error; // re-throw so message is not deleted → goes to DLQ
  }
}

async function poll(): Promise<void> {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl!,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 300
    })
  );

  const messages = response.Messages ?? [];
  for (const msg of messages) {
    try {
      await processMessage(msg.Body ?? "{}");
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl!,
          ReceiptHandle: msg.ReceiptHandle!
        })
      );
    } catch {
      // Message will become visible again and eventually go to DLQ
    }
  }
}

async function run(): Promise<void> {
  console.log(`[worker-aws] Starting SQS worker. Queue: ${queueUrl}`);
  while (true) {
    try {
      await poll();
    } catch (error) {
      console.error("[worker-aws] Poll error", error);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Only run polling loop when standalone (Lambda uses SQS event source mapping instead)
if (!process.env.AWS_LAMBDA_FUNCTION_NAME && queueUrl) {
  run().catch(err => {
    console.error("[worker-aws] Fatal error", err);
    process.exit(1);
  });
}
