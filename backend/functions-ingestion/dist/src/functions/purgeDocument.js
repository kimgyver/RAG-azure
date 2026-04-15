import { app } from "@azure/functions";
import { cosmosEnabled, deleteDocumentMetadata } from "../shared/documentMetadataStore.js";
import { deleteSearchChunksForDocument, searchEnabled } from "../shared/searchIndexStore.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "../shared/tenantPolicy.js";
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { message }
    };
}
async function purgeDocumentHandler(request, context) {
    const documentId = request.params.documentId?.trim();
    const tenantId = request.query.get("tenantId")?.trim();
    if (!documentId) {
        return badRequest("documentId is required.");
    }
    if (!tenantId) {
        return badRequest("tenantId query parameter is required.");
    }
    if (!isTenantAllowed(tenantId)) {
        return {
            status: 403,
            jsonBody: { message: tenantNotAllowedMessage() }
        };
    }
    if (!cosmosEnabled() && !searchEnabled()) {
        return {
            status: 503,
            jsonBody: {
                message: "Cosmos DB and Azure AI Search are both disabled; nothing to delete."
            }
        };
    }
    try {
        let deletedChunks = 0;
        if (searchEnabled()) {
            deletedChunks = await deleteSearchChunksForDocument(documentId, tenantId);
        }
        let cosmosDeleted = false;
        if (cosmosEnabled()) {
            cosmosDeleted = await deleteDocumentMetadata(documentId, tenantId);
        }
        context.log("Document purged.", {
            tenantId,
            documentId,
            deletedChunks,
            cosmosDeleted
        });
        return {
            status: 200,
            jsonBody: {
                documentId,
                tenantId,
                deletedSearchChunks: deletedChunks,
                cosmosDeleted,
                note: "Blob 원본은 삭제하지 않았습니다. 스토리지에서 직접 지우려면 포털 또는 별도 작업을 사용하세요."
            },
            headers: { "content-type": "application/json" }
        };
    }
    catch (error) {
        context.error("Failed to purge document", error);
        return {
            status: 500,
            jsonBody: { message: "Failed to purge document." }
        };
    }
}
app.http("document-purge", {
    route: "documents/{documentId}/purge",
    methods: ["DELETE"],
    authLevel: "anonymous",
    handler: purgeDocumentHandler
});
