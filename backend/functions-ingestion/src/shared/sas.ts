import {
  BlobSASPermissions,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} from "@azure/storage-blob";

export type UploadSasPayload = {
  accountName: string;
  accountKey: string;
  containerName: string;
  blobName: string;
  expiryMinutes: number;
  contentType?: string;
  blobEndpoint?: string;
};

export function createUploadSasUrl(payload: UploadSasPayload): string {
  const now = new Date();
  const startsOn = new Date(now.getTime() - 5 * 60 * 1000);
  const expiresOn = new Date(now.getTime() + payload.expiryMinutes * 60 * 1000);
  const isHttpEndpoint = payload.blobEndpoint?.startsWith("http://") ?? false;

  const sharedKey = new StorageSharedKeyCredential(
    payload.accountName,
    payload.accountKey
  );
  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: payload.containerName,
      blobName: payload.blobName,
      permissions: BlobSASPermissions.parse("cw"),
      startsOn,
      expiresOn,
      protocol: isHttpEndpoint ? SASProtocol.HttpsAndHttp : SASProtocol.Https,
      contentType: payload.contentType,
      version: "2020-12-06" // Azurite 호환 (프로덕션 Azure도 지원)
    },
    sharedKey
  ).toString();

  const baseEndpoint =
    payload.blobEndpoint?.replace(/\/$/, "") ??
    `https://${payload.accountName}.blob.core.windows.net`;
  return `${baseEndpoint}/${payload.containerName}/${payload.blobName}?${sasToken}`;
}

export function sanitizeFileName(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}
