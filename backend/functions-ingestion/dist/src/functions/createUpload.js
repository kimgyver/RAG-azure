import { app } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { createUploadSasUrl, sanitizeFileName } from "../shared/sas.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "../shared/tenantPolicy.js";
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { message }
    };
}
function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
async function createUploadHandler(request, context) {
    try {
        const payload = (await request.json());
        const tenantId = payload.tenantId?.trim();
        const fileName = payload.fileName?.trim();
        if (!tenantId) {
            return badRequest("tenantId is required.");
        }
        if (!isTenantAllowed(tenantId)) {
            return {
                status: 403,
                jsonBody: { message: tenantNotAllowedMessage() }
            };
        }
        if (!fileName) {
            return badRequest("fileName is required.");
        }
        const accountName = getRequiredEnv("AZURE_STORAGE_ACCOUNT_NAME");
        const accountKey = getRequiredEnv("AZURE_STORAGE_ACCOUNT_KEY");
        const blobEndpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME ?? "uploads";
        const expiryMinutes = Number(process.env.SAS_EXPIRY_MINUTES ?? "15");
        if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
            return badRequest("SAS_EXPIRY_MINUTES must be a positive number.");
        }
        const documentId = randomUUID();
        const safeFileName = sanitizeFileName(fileName);
        const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
        const blobName = `${tenantId}/${dateFolder}/${documentId}-${safeFileName}`;
        const uploadUrl = createUploadSasUrl({
            accountName,
            accountKey,
            containerName,
            blobName,
            expiryMinutes,
            contentType: payload.contentType,
            blobEndpoint
        });
        const body = {
            documentId,
            tenantId,
            blobName,
            uploadUrl,
            expiresInMinutes: expiryMinutes
        };
        return {
            status: 200,
            jsonBody: body,
            headers: {
                "content-type": "application/json"
            }
        };
    }
    catch (error) {
        context.error("Failed to create upload SAS", error);
        return {
            status: 500,
            jsonBody: {
                message: "Failed to create upload URL."
            }
        };
    }
}
app.http("uploads-create", {
    route: "uploads/create",
    methods: ["POST"],
    authLevel: "anonymous",
    handler: createUploadHandler
});
