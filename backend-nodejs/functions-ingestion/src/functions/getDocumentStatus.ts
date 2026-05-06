import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from "@azure/functions";
import {
  cosmosEnabled,
  getDocumentMetadata
} from "../shared/documentMetadataStore.js";
import {
  isTenantAllowed,
  tenantNotAllowedMessage
} from "../shared/tenantPolicy.js";

function badRequest(message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: { message }
  };
}

async function getDocumentStatusHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
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
        message: "Cosmos DB status store is disabled."
      }
    };
  }

  try {
    const record = await getDocumentMetadata(documentId, tenantId);

    if (!record) {
      return {
        status: 404,
        jsonBody: {
          message: "Document status not found."
        }
      };
    }

    return {
      status: 200,
      jsonBody: record,
      headers: {
        "content-type": "application/json"
      }
    };
  } catch (error) {
    context.error("Failed to read document status", error);
    return {
      status: 500,
      jsonBody: {
        message: "Failed to read document status."
      }
    };
  }
}

app.http("documents-status", {
  route: "documents/{documentId}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getDocumentStatusHandler
});
