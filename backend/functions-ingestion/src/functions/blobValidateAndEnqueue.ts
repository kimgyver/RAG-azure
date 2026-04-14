import { app, InvocationContext, output } from "@azure/functions";
import { upsertDocumentMetadata } from "../shared/documentMetadataStore.js";

type ProcessingJobMessage = {
  documentId: string;
  tenantId: string;
  blobName: string;
  queuedAt: string;
  contentLength: number;
  source: "blob-trigger";
};

const processingQueueOutput = output.serviceBusQueue({
  queueName: process.env.AZURE_PROCESSING_QUEUE_NAME ?? "processing-jobs",
  connection: "SERVICE_BUS_CONNECTION"
});

const blobTriggerSource =
  (process.env.BLOB_TRIGGER_SOURCE as "EventGrid" | "LogsAndContainerScan") ??
  "LogsAndContainerScan";

function extractDocumentId(blobName: string): string {
  const fileName = blobName.split("/").pop() ?? blobName;
  const match = fileName.match(
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-/
  );
  return match?.[1] ?? "unknown";
}

function extractTenantId(blobName: string): string {
  return blobName.split("/")[0] ?? "unknown";
}

async function blobValidateAndEnqueueHandler(
  blob: Uint8Array,
  context: InvocationContext
): Promise<void> {
  const blobName = String(context.triggerMetadata?.name ?? "");
  const contentLength = blob?.byteLength ?? 0;
  const maxSizeMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? "20");
  const maxBytes = maxSizeMb * 1024 * 1024;

  if (!blobName) {
    context.warn("Blob trigger fired without blob name metadata.");
    return;
  }

  if (contentLength <= 0) {
    context.warn("Blob is empty. Skipping queue registration.", { blobName });
    return;
  }

  if (Number.isFinite(maxBytes) && contentLength > maxBytes) {
    context.warn("Blob exceeds max size. Skipping queue registration.", {
      blobName,
      contentLength,
      maxBytes
    });
    return;
  }

  const message: ProcessingJobMessage = {
    documentId: extractDocumentId(blobName),
    tenantId: extractTenantId(blobName),
    blobName,
    queuedAt: new Date().toISOString(),
    contentLength,
    source: "blob-trigger"
  };

  await upsertDocumentMetadata(
    {
      documentId: message.documentId,
      tenantId: message.tenantId,
      blobName: message.blobName,
      status: "queued",
      contentLength: message.contentLength
    },
    context
  );

  context.extraOutputs.set(processingQueueOutput, JSON.stringify(message));
  context.log("Processing job queued.", {
    queueName: process.env.AZURE_PROCESSING_QUEUE_NAME ?? "processing-jobs",
    blobName,
    documentId: message.documentId
  });
}

app.storageBlob("blob-validate-and-enqueue", {
  path: "uploads/{name}",
  connection: "AzureWebJobsStorage",
  source: blobTriggerSource,
  extraOutputs: [processingQueueOutput],
  handler: blobValidateAndEnqueueHandler
});
