import { app } from "@azure/functions";
import { listDocumentsByTenant, cosmosEnabled } from "../shared/documentMetadataStore.js";
import { listSearchDocumentGroups, searchEnabled } from "../shared/searchIndexStore.js";
import { isTenantAllowed, tenantNotAllowedMessage } from "../shared/tenantPolicy.js";
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { message }
    };
}
async function listDocumentCatalogHandler(request, context) {
    const tenantId = request.query.get("tenantId")?.trim();
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
                message: "Cosmos DB and Azure AI Search are both disabled; nothing to list."
            }
        };
    }
    try {
        const [cosmosDocs, searchGroups] = await Promise.all([
            listDocumentsByTenant(tenantId, 200),
            listSearchDocumentGroups(tenantId, 4000)
        ]);
        const byId = new Map();
        for (const c of cosmosDocs) {
            const fileName = c.blobName?.split("/").pop() ?? c.documentId;
            byId.set(c.documentId, {
                documentId: c.documentId,
                tenantId: c.tenantId,
                fileName,
                blobName: c.blobName,
                cosmos: {
                    status: c.status,
                    updatedAt: c.updatedAt,
                    chunkCount: c.chunkCount,
                    contentType: c.contentType
                },
                search: null
            });
        }
        for (const s of searchGroups) {
            const existing = byId.get(s.documentId);
            const searchPart = {
                chunkCount: s.chunkCount,
                fileName: s.fileName,
                blobName: s.blobName
            };
            if (existing) {
                existing.search = searchPart;
                if (!existing.fileName && s.fileName) {
                    existing.fileName = s.fileName;
                }
                if (!existing.blobName && s.blobName) {
                    existing.blobName = s.blobName;
                }
            }
            else {
                byId.set(s.documentId, {
                    documentId: s.documentId,
                    tenantId,
                    fileName: s.fileName || s.documentId,
                    blobName: s.blobName,
                    cosmos: null,
                    search: searchPart
                });
            }
        }
        const documents = [...byId.values()].sort((a, b) => {
            const ta = a.cosmos?.updatedAt ?? "";
            const tb = b.cosmos?.updatedAt ?? "";
            if (ta !== tb) {
                return tb.localeCompare(ta);
            }
            return a.documentId.localeCompare(b.documentId);
        });
        context.log("Document catalog listed.", {
            tenantId,
            count: documents.length,
            cosmosEnabled: cosmosEnabled(),
            searchEnabled: searchEnabled()
        });
        return {
            status: 200,
            jsonBody: {
                tenantId,
                documents,
                sources: {
                    cosmos: cosmosEnabled(),
                    search: searchEnabled()
                }
            },
            headers: { "content-type": "application/json" }
        };
    }
    catch (error) {
        context.error("Failed to list document catalog", error);
        return {
            status: 500,
            jsonBody: { message: "Failed to list document catalog." }
        };
    }
}
app.http("document-catalog", {
    route: "documents/catalog",
    methods: ["GET"],
    // Core Tools 4.x 에 `func keys list` 가 없어 로컬에서 키 구하기가 어렵다.
    // 테넌트 검증·Cosmos/Search 플래그로 제한; 프로덕션은 네트워크·APIM 등으로 보호할 것.
    authLevel: "anonymous",
    handler: listDocumentCatalogHandler
});
