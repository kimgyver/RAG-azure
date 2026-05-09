import { useCallback, useEffect, useState } from "react";
import {
  type CatalogDocumentRow,
  type CatalogResponse,
  type DocumentStatusResponse
} from "../types/app";
import {
  type BackendTarget,
  BACKEND_RESOURCE_LABELS,
  extractApiMessage,
  relativeTimeLabel,
  resolveFetchErrorMessage,
  waitMs
} from "../utils/app";

type CatalogState = {
  rows: CatalogDocumentRow[];
  status: "idle" | "loading" | "error" | "ok";
  message: string;
};

type DocumentItem = {
  documentId: string;
  tenantId: string;
};

/**
 * Manages document catalog loading, purging, and document status polling.
 */
export function useCatalog(
  tenantId: string,
  apiBaseUrl: string,
  apiKey: string,
  backendTarget: BackendTarget
) {
  const [catalogState, setCatalogState] = useState<CatalogState>({
    rows: [],
    status: "loading",
    message: ""
  });

  const [trackedDocument, setTrackedDocument] = useState<DocumentItem | null>(
    null
  );

  const [documentItems, setDocumentItems] = useState<
    Record<string, { status: string; updatedAt: string; chunkCount?: number }>
  >({});

  const [purgeBusyId, setPurgeBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      const labels = BACKEND_RESOURCE_LABELS[backendTarget];

      if (!options?.silent) {
        setCatalogState({
          rows: [],
          status: "loading",
          message: `Reading ${labels.metadataLabel} and ${labels.searchLabel}…`
        });
      }

      try {
        const response = await fetch(
          `${apiBaseUrl}/documents/catalog?tenantId=${encodeURIComponent(tenantId)}`,
          {
            headers: {
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            }
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(extractApiMessage(text, `HTTP ${response.status}`));
        }

        const payload = JSON.parse(text) as CatalogResponse;
        setCatalogState({
          rows: payload.documents,
          status: "ok",
          message: `${labels.metadataLabel} ${payload.sources.cosmos ? "ON" : "OFF"} · ${labels.searchLabel} ${payload.sources.search ? "ON" : "OFF"} · ${payload.documents.length} doc(s)`
        });
      } catch (error) {
        const message = resolveFetchErrorMessage(
          error,
          backendTarget as any,
          apiBaseUrl,
          "Could not load catalog."
        );
        setCatalogState({
          rows: [],
          status: "error",
          message
        });
      }
    },
    [tenantId, apiBaseUrl, apiKey, backendTarget]
  );

  const refreshWithRetries = useCallback(
    async (attempts = 4, intervalMs = 350, silent = true) => {
      for (let i = 0; i < attempts; i += 1) {
        await load({ silent });
        if (i < attempts - 1) {
          await waitMs(intervalMs);
        }
      }
    },
    [load]
  );

  // Load catalog on mount and when tenantId/apiBaseUrl changes
  useEffect(() => {
    void load();
  }, [load]);

  // Poll document status if one is being tracked
  useEffect(() => {
    if (!trackedDocument) {
      return;
    }

    let isCancelled = false;
    let consecutiveNotFoundCount = 0;
    const maxNotFoundRetries = 5;
    const terminalStatuses = new Set([
      "chunked",
      "skipped",
      "failed",
      "indexed"
    ]);

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/documents/${trackedDocument.documentId}?tenantId=${trackedDocument.tenantId}`,
          {
            headers: {
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            }
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            consecutiveNotFoundCount += 1;
            if (
              consecutiveNotFoundCount >= maxNotFoundRetries &&
              !isCancelled
            ) {
              setTrackedDocument(null);
              await refreshWithRetries(2, 400, true);
            }
          }
          return;
        }

        consecutiveNotFoundCount = 0;
        const payload = (await response.json()) as DocumentStatusResponse;

        if (isCancelled) {
          return;
        }

        setDocumentItems(prev => ({
          ...prev,
          [payload.documentId]: {
            status: payload.status,
            updatedAt: relativeTimeLabel(payload.updatedAt),
            chunkCount: payload.chunkCount
          }
        }));

        if (terminalStatuses.has(payload.status)) {
          setTrackedDocument(null);
          await refreshWithRetries(3, 500, true);
        }
      } catch {
        // Polling errors retry on the next interval
      }
    };

    void pollStatus();
    const intervalId = window.setInterval(() => {
      void pollStatus();
    }, 3000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [trackedDocument, apiBaseUrl, apiKey, refreshWithRetries]);

  const purge = useCallback(
    async (documentId: string): Promise<boolean> => {
      const labels = BACKEND_RESOURCE_LABELS[backendTarget];
      const confirmed = window.confirm(
        `Document ID "${documentId}"\n\nThis removes ${labels.searchLabel} chunks and ${labels.metadataLabel} metadata for this tenant. The object in ${labels.storageLabel} is left unchanged. Continue?`
      );

      if (!confirmed) {
        return false;
      }

      setPurgeBusyId(documentId);

      try {
        const response = await fetch(
          `${apiBaseUrl}/documents/${encodeURIComponent(documentId)}/purge?tenantId=${encodeURIComponent(tenantId)}`,
          {
            method: "DELETE",
            headers: {
              ...(apiKey ? { "x-functions-key": apiKey } : {})
            }
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(extractApiMessage(text, `HTTP ${response.status}`));
        }

        await refreshWithRetries(4, 350, true);
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Delete failed.";
        window.alert(message);
        return false;
      } finally {
        setPurgeBusyId(null);
      }
    },
    [tenantId, apiBaseUrl, apiKey, backendTarget, refreshWithRetries]
  );

  const getSource = useCallback(
    async (documentId: string) => {
      const response = await fetch(
        `${apiBaseUrl}/documents/${encodeURIComponent(documentId)}/source?tenantId=${encodeURIComponent(tenantId)}`,
        {
          headers: {
            ...(apiKey ? { "x-functions-key": apiKey } : {})
          }
        }
      );

      const text = await response.text();
      if (!response.ok) {
        throw new Error(extractApiMessage(text, `HTTP ${response.status}`));
      }

      return JSON.parse(text);
    },
    [tenantId, apiBaseUrl, apiKey]
  );

  return {
    catalogRows: catalogState.rows,
    catalogStatus: catalogState.status,
    catalogMessage: catalogState.message,
    load,
    refreshWithRetries,
    trackDocument: setTrackedDocument,
    purgeBusyId,
    purge,
    getSource,
    documentItems
  };
}
