import { app } from "@azure/functions";
import { cosmosEnabled, getDocumentMetadata } from "../shared/documentMetadataStore.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "../shared/tenantPolicy.js";
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { message }
    };
}
async function getDocumentSourceHandler(request, context) {
    const documentId = request.params.documentId?.trim();
    const tenantId = request.query.get("tenantId")?.trim();
    if (!documentId) {
        return badRequest("documentId is required.");
    }
    if (!tenantId) {
        return badRequest("tenantId is required.");
    }
    if (!isTenantAllowed(tenantId)) {
        return {
            status: 403,
            jsonBody: { message: tenantNotAllowedMessage() }
        };
    }
    if (!cosmosEnabled()) {
        return {
            status: 503,
            jsonBody: {
                message: "Cosmos DB is disabled."
            }
        };
    }
    try {
        const record = await getDocumentMetadata(documentId, tenantId);
        if (!record) {
            return {
                status: 404,
                jsonBody: {
                    message: "Document metadata not found."
                }
            };
        }
        const sourceText = record.sourceText?.trim();
        if (!sourceText) {
            return {
                status: 404,
                jsonBody: {
                    message: "Source text is not stored for this document. (이 문서는 원문 저장 이전에 처리되었거나 추출 가능한 텍스트가 없을 수 있습니다.)"
                }
            };
        }
        return {
            status: 200,
            jsonBody: {
                documentId: record.documentId,
                tenantId: record.tenantId,
                fileName: record.blobName?.split("/").pop() ?? record.documentId,
                sourceType: record.sourceType ?? "unknown",
                sourceText,
                updatedAt: record.updatedAt
            },
            headers: {
                "content-type": "application/json"
            }
        };
    }
    catch (error) {
        context.error("Failed to read document source", error);
        return {
            status: 500,
            jsonBody: {
                message: "Failed to read document source."
            }
        };
    }
}
app.http("document-source", {
    route: "documents/{documentId}/source",
    methods: ["GET"],
    authLevel: "anonymous",
    handler: getDocumentSourceHandler
});
