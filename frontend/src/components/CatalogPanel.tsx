import { useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogDocumentRow, RuntimeConfigSnapshot } from "../types/app";
import type { DocumentSourceResponse } from "../types/app";

type CatalogPanelProps = {
  loadCatalog: () => Promise<void>;
  catalogStatus: "idle" | "loading" | "error" | "ok";
  catalogMessage: string;
  runtimeConfigStatus: "loading" | "ok" | "error";
  runtimeConfig: RuntimeConfigSnapshot | null;
  catalogRows: CatalogDocumentRow[];
  purgeBusyId: string | null;
  onPurgeDocument: (documentId: string) => Promise<void>;
  onViewDocumentSource: (documentId: string) => Promise<DocumentSourceResponse>;
};

export function CatalogPanel({
  loadCatalog,
  catalogStatus,
  catalogMessage,
  runtimeConfigStatus,
  runtimeConfig,
  catalogRows,
  purgeBusyId,
  onPurgeDocument,
  onViewDocumentSource
}: CatalogPanelProps) {
  const [sourceLoadingId, setSourceLoadingId] = useState<string | null>(null);
  const [sourceView, setSourceView] = useState<DocumentSourceResponse | null>(
    null
  );

  const handleViewSource = async (documentId: string) => {
    setSourceLoadingId(documentId);
    try {
      const payload = await onViewDocumentSource(documentId);
      setSourceView(payload);
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Failed to load source text"
      );
    } finally {
      setSourceLoadingId(null);
    }
  };

  return (
    <section className="panel catalog-panel" aria-labelledby="catalog-heading">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">Admin</p>
          <h2 id="catalog-heading">Cosmos · Search document catalog</h2>
        </div>
        <div className="catalog-actions">
          <button type="button" onClick={() => void loadCatalog()}>
            Refresh list
          </button>
        </div>
      </div>
      <p
        className={`catalog-meta ${
          catalogStatus === "error" ? "catalog-error" : ""
        } ${catalogStatus === "ok" ? "catalog-ok" : ""}`}
      >
        {catalogStatus === "loading"
          ? "Loading catalog…"
          : catalogMessage || "Merged rows for the current tenant."}
      </p>
      {runtimeConfigStatus === "ok" && runtimeConfig ? (
        <p className="catalog-mode-note">
          {runtimeConfig.cosmosDbEnabled
            ? "Cosmos metadata is active. Upload status and catalog rows are persisted in Cosmos and merged with Search chunks below."
            : "Cosmos metadata is off. Catalog rows below come from Search only until Cosmos is enabled."}
        </p>
      ) : null}
      <div className="catalog-table-wrap">
        <table className="catalog-table">
          <thead>
            <tr>
              <th scope="col">documentId</th>
              <th scope="col">File</th>
              <th scope="col">Cosmos</th>
              <th scope="col">Search chunks</th>
              <th scope="col">Source</th>
              <th scope="col">Delete</th>
            </tr>
          </thead>
          <tbody>
            {catalogRows.length === 0 && catalogStatus === "ok" ? (
              <tr>
                <td colSpan={6} className="catalog-empty">
                  No documents for this tenant. Upload files or switch tenant.
                </td>
              </tr>
            ) : null}
            {catalogRows.map(row => (
              <tr key={row.documentId}>
                <td className="mono">{row.documentId}</td>
                <td>{row.fileName}</td>
                <td>
                  {row.cosmos ? (
                    <>
                      {row.cosmos.status}
                      <br />
                      <small className="catalog-sub">
                        {row.cosmos.chunkCount != null
                          ? `${row.cosmos.chunkCount} chunks · `
                          : ""}
                        {row.cosmos.updatedAt?.slice(0, 19) ?? ""}
                      </small>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {row.search ? (
                    <>{row.search.chunkCount} chunks</>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={
                      !row.cosmos?.hasSourceText || sourceLoadingId !== null
                    }
                    onClick={() => void handleViewSource(row.documentId)}
                  >
                    {sourceLoadingId === row.documentId
                      ? "Loading…"
                      : "View source"}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={
                      purgeBusyId !== null || (!row.cosmos && !row.search)
                    }
                    onClick={() => void onPurgeDocument(row.documentId)}
                  >
                    {purgeBusyId === row.documentId
                      ? "Deleting…"
                      : "Purge index data"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="catalog-footnote">
        Purge removes AI Search chunks and Cosmos metadata only. Blobs in
        storage are not deleted.
      </p>

      {sourceView
        ? createPortal(
            <div
              className="source-modal-backdrop"
              role="dialog"
              aria-modal="true"
              onClick={() => {
                setSourceView(null);
              }}
            >
              <div
                className="source-modal"
                onClick={event => {
                  event.stopPropagation();
                }}
              >
                <div className="source-modal-header">
                  <h3>View source</h3>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setSourceView(null);
                    }}
                  >
                    Close
                  </button>
                </div>
                <p className="catalog-meta">
                  {sourceView.fileName} · {sourceView.sourceType} · updated{" "}
                  {sourceView.updatedAt.slice(0, 19)}
                </p>
                <pre className="source-modal-content">
                  {sourceView.sourceText}
                </pre>
              </div>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}
