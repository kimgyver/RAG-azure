import { BlobSASPermissions, SASProtocol, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";
export function createUploadSasUrl(payload) {
    const now = new Date();
    const startsOn = new Date(now.getTime() - 5 * 60 * 1000);
    const expiresOn = new Date(now.getTime() + payload.expiryMinutes * 60 * 1000);
    const isHttpEndpoint = payload.blobEndpoint?.startsWith("http://") ?? false;
    const sharedKey = new StorageSharedKeyCredential(payload.accountName, payload.accountKey);
    const sasToken = generateBlobSASQueryParameters({
        containerName: payload.containerName,
        blobName: payload.blobName,
        permissions: BlobSASPermissions.parse("cw"),
        startsOn,
        expiresOn,
        protocol: isHttpEndpoint ? SASProtocol.HttpsAndHttp : SASProtocol.Https,
        contentType: payload.contentType,
        version: "2020-12-06" // stable SAS version for Azure Storage
    }, sharedKey).toString();
    const baseEndpoint = payload.blobEndpoint?.replace(/\/$/, "") ??
        `https://${payload.accountName}.blob.core.windows.net`;
    return `${baseEndpoint}/${payload.containerName}/${payload.blobName}?${sasToken}`;
}
export function sanitizeFileName(input) {
    return input
        .trim()
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120);
}
