/**
 * Creates the uploads blob container on your Azure Storage account.
 * Reads backend/functions-ingestion/local.settings.json (same layout as Functions).
 *
 * Usage (from backend/functions-ingestion):
 *   npm run storage:setup
 *
 * Requires a real Azure Storage account (not Azurite). Use the same account as
 * AzureWebJobsStorage so the blob trigger path `uploads/{name}` matches SAS uploads.
 *
 * Service Bus queue `AZURE_PROCESSING_QUEUE_NAME` must exist in Azure — create it
 * in the portal; this script only touches Blob Storage.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(__dirname, "..", "local.settings.json");

function loadValues() {
  if (!existsSync(settingsPath)) {
    console.error(
      `Missing ${settingsPath}. Copy local.settings.json.example and fill in your Azure storage values.`
    );
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
  return raw.Values ?? {};
}

function isAzuriteStyle(values) {
  const name = (values.AZURE_STORAGE_ACCOUNT_NAME ?? "").trim();
  const endpoint = (values.AZURE_STORAGE_BLOB_ENDPOINT ?? "").trim();
  const jobs = (values.AzureWebJobsStorage ?? "").trim();
  if (jobs === "UseDevelopmentStorage=true") {
    return true;
  }
  if (name === "devstoreaccount1") {
    return true;
  }
  if (/127\.0\.0\.1|localhost/.test(endpoint)) {
    return true;
  }
  return false;
}

/** Connection string for the account that hosts the uploads container. */
function resolveBlobConnectionString(values) {
  if (isAzuriteStyle(values)) {
    console.error(
      "local.settings.json still points at storage emulator / Azurite. Replace with a real Azure Storage connection string (see local.settings.json.example)."
    );
    process.exit(1);
  }

  const jobs = (values.AzureWebJobsStorage ?? "").trim();
  if (
    jobs &&
    jobs !== "UseDevelopmentStorage=true" &&
    jobs.includes("AccountName=")
  ) {
    return jobs;
  }

  const name = (values.AZURE_STORAGE_ACCOUNT_NAME ?? "").trim();
  const key = (values.AZURE_STORAGE_ACCOUNT_KEY ?? "").trim();
  if (!name || !key) {
    console.error(
      "Set AzureWebJobsStorage to your storage account connection string, or set AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY."
    );
    process.exit(1);
  }

  return `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${key};EndpointSuffix=core.windows.net`;
}

const values = loadValues();
const connectionString = resolveBlobConnectionString(values);
const containerName =
  (values.AZURE_STORAGE_CONTAINER_NAME ?? "uploads").trim() || "uploads";

const blobServiceClient =
  BlobServiceClient.fromConnectionString(connectionString);
const containerClient = blobServiceClient.getContainerClient(containerName);
const { succeeded } = await containerClient.createIfNotExists();
console.log(
  succeeded
    ? `Created blob container "${containerName}".`
    : `Blob container "${containerName}" already exists.`
);

const queueName = (values.AZURE_PROCESSING_QUEUE_NAME ?? "processing-jobs").trim();
console.log(
  `\nProcessing jobs use Service Bus queue "${queueName}". Create that queue in your Service Bus namespace if needed (this script does not create it).`
);

console.log(
  "\nFor browser PUT uploads from Vite (http://localhost:5173), add CORS rules on the storage account: allowed origins include http://localhost:5173, methods PUT GET HEAD OPTIONS, allowed headers *."
);
