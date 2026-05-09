import { createUploadSasUrl, sanitizeFileName } from "../../shared/sas.js";
import { BlobServiceClient } from "@azure/storage-blob";
export class AzureStorageProvider {
    buildUploadBlobName(tenantId, documentId, fileName) {
        const safeFileName = sanitizeFileName(fileName);
        const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
        return `${tenantId}/${dateFolder}/${documentId}-${safeFileName}`;
    }
    createUploadUrl(opts) {
        const accountName = this.getRequiredEnv("AZURE_STORAGE_ACCOUNT_NAME");
        const accountKey = this.getRequiredEnv("AZURE_STORAGE_ACCOUNT_KEY");
        const blobEndpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT;
        return createUploadSasUrl({
            accountName,
            accountKey,
            containerName: opts.containerName,
            blobName: opts.blobName,
            expiryMinutes: opts.expiryMinutes,
            contentType: opts.contentType,
            blobEndpoint
        });
    }
    async downloadBlob(containerName, blobName) {
        const connectionString = this.getRequiredEnv("AzureWebJobsStorage");
        const client = BlobServiceClient.fromConnectionString(connectionString);
        return client
            .getContainerClient(containerName)
            .getBlobClient(blobName)
            .downloadToBuffer();
    }
    async getBlobContentType(containerName, blobName) {
        const connectionString = this.getRequiredEnv("AzureWebJobsStorage");
        const client = BlobServiceClient.fromConnectionString(connectionString);
        const props = await client
            .getContainerClient(containerName)
            .getBlobClient(blobName)
            .getProperties();
        return props.contentType;
    }
    getRequiredEnv(name) {
        const value = process.env[name];
        if (!value)
            throw new Error(`Missing required environment variable: ${name}`);
        return value;
    }
}
