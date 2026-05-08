import type { StorageProvider } from "../base.js";
import { createUploadSasUrl, sanitizeFileName } from "../../shared/sas.js";
import { BlobServiceClient } from "@azure/storage-blob";

export class AzureStorageProvider implements StorageProvider {
  buildUploadBlobName(
    tenantId: string,
    documentId: string,
    fileName: string
  ): string {
    const safeFileName = sanitizeFileName(fileName);
    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    return `${tenantId}/${dateFolder}/${documentId}-${safeFileName}`;
  }

  createUploadUrl(opts: {
    blobName: string;
    containerName: string;
    expiryMinutes: number;
    contentType?: string;
  }): string {
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

  async downloadBlob(containerName: string, blobName: string): Promise<Buffer> {
    const connectionString = this.getRequiredEnv("AzureWebJobsStorage");
    const client = BlobServiceClient.fromConnectionString(connectionString);
    return client
      .getContainerClient(containerName)
      .getBlobClient(blobName)
      .downloadToBuffer();
  }

  async getBlobContentType(
    containerName: string,
    blobName: string
  ): Promise<string | undefined> {
    const connectionString = this.getRequiredEnv("AzureWebJobsStorage");
    const client = BlobServiceClient.fromConnectionString(connectionString);
    const props = await client
      .getContainerClient(containerName)
      .getBlobClient(blobName)
      .getProperties();
    return props.contentType;
  }

  private getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value)
      throw new Error(`Missing required environment variable: ${name}`);
    return value;
  }
}
