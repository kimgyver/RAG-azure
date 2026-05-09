import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
function sanitizeFileName(input) {
    return input
        .trim()
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120);
}
export class AwsStorageProvider {
    region = process.env.AWS_REGION ?? "ap-southeast-2";
    s3 = new S3Client({ region: this.region });
    buildUploadBlobName(tenantId, documentId, fileName) {
        const safeFileName = sanitizeFileName(fileName);
        const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
        return `${tenantId}/${dateFolder}/${documentId}-${safeFileName}`;
    }
    async createUploadUrl(opts) {
        const bucket = process.env.S3_BUCKET_NAME ?? opts.containerName;
        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: opts.blobName,
            ContentType: opts.contentType ?? "application/octet-stream"
        });
        return getSignedUrl(this.s3, command, {
            expiresIn: opts.expiryMinutes * 60
        });
    }
    async downloadBlob(containerName, blobName) {
        const bucket = process.env.S3_BUCKET_NAME ?? containerName;
        const response = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: blobName }));
        const stream = response.Body;
        if (!stream)
            throw new Error(`Empty body for blob: ${blobName}`);
        // collect stream
        const chunks = [];
        // @ts-ignore – Node.js ReadableStream
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    async getBlobContentType(containerName, blobName) {
        const bucket = process.env.S3_BUCKET_NAME ?? containerName;
        const response = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: blobName }));
        return response.ContentType;
    }
}
