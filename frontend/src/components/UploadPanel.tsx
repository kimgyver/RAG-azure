import type { ChangeEvent } from "react";
import { statusLabel, type DocumentItem, type UploadState } from "../types/app";

type UploadPanelProps = {
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onStartUpload: () => void;
  uploadState: UploadState;
  uploadMessage: string;
  effectiveTenantId: string;
  uploadApiBaseUrl: string;
  documents: DocumentItem[];
};

export function UploadPanel({
  onFileChange,
  onStartUpload,
  uploadState,
  uploadMessage,
  effectiveTenantId,
  uploadApiBaseUrl,
  documents
}: UploadPanelProps) {
  return (
    <section className="panel panel-upload">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">Upload</p>
          <h2>Document upload</h2>
        </div>
        <span className="panel-tag">SAS direct upload</span>
      </div>

      <label className="dropzone" htmlFor="file-upload">
        <input id="file-upload" type="file" onChange={onFileChange} />
        <span className="dropzone-icon">+</span>
        <strong>Choose PDF, PNG, or JPG</strong>
        <p>
          After you start upload, the app requests a SAS URL and the browser
          PUTs the file to Blob Storage. PNG and JPEG can be OCRd on the server
          for text.
        </p>
      </label>

      <div className="upload-actions">
        <button type="button" onClick={onStartUpload}>
          Start upload
        </button>
        <p className={`upload-hint upload-${uploadState}`}>{uploadMessage}</p>
      </div>

      <div className="upload-meta-grid">
        <div className="meta-card">
          <span>Blob path prefix</span>
          <strong>{effectiveTenantId}/YYYY/MM/</strong>
        </div>
        <div className="meta-card">
          <span>API base URL</span>
          <strong>{uploadApiBaseUrl}</strong>
        </div>
      </div>

      <div className="timeline-card">
        <div className="timeline-header">
          <h3>Processing status</h3>
          <span>Recent uploads</span>
        </div>

        <ul className="document-list">
          {documents.map(item => (
            <li key={item.id} className="document-row">
              <div>
                <strong>{item.fileName}</strong>
                <p>{item.updatedAt}</p>
              </div>
              <span className={`status-pill status-${item.status}`}>
                {statusLabel[item.status]}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
