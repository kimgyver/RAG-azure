import type { ChangeEvent } from "react";
import {
  statusLabel,
  type DocumentItem,
  type TextIngestState,
  type UploadState
} from "../types/app";

type UploadPanelProps = {
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onStartUpload: () => void;
  uploadState: UploadState;
  uploadMessage: string;
  effectiveTenantId: string;
  uploadApiBaseUrl: string;
  documents: DocumentItem[];
  textTitle: string;
  textContent: string;
  textIngestState: TextIngestState;
  textIngestMessage: string;
  onTextTitleChange: (value: string) => void;
  onTextContentChange: (value: string) => void;
  onRegisterTextKnowledge: () => void;
};

export function UploadPanel({
  onFileChange,
  onStartUpload,
  uploadState,
  uploadMessage,
  effectiveTenantId,
  uploadApiBaseUrl,
  documents,
  textTitle,
  textContent,
  textIngestState,
  textIngestMessage,
  onTextTitleChange,
  onTextContentChange,
  onRegisterTextKnowledge
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

      <div className="text-kb-card">
        <div className="timeline-header">
          <h3>Register text knowledge</h3>
          <span>Direct input</span>
        </div>

        <label className="text-kb-label" htmlFor="text-kb-title">
          Title (optional)
        </label>
        <input
          id="text-kb-title"
          className="text-kb-title"
          value={textTitle}
          onChange={event => {
            onTextTitleChange(event.target.value);
          }}
          placeholder="example: onboarding-notes"
        />

        <label className="text-kb-label" htmlFor="text-kb-content">
          Text to index
        </label>
        <textarea
          id="text-kb-content"
          className="text-kb-input"
          value={textContent}
          onChange={event => {
            onTextContentChange(event.target.value);
          }}
          placeholder="Paste or type the text you want searchable in this tenant knowledge base."
        />

        <div className="upload-actions text-kb-actions">
          <button
            type="button"
            disabled={textIngestState === "submitting"}
            onClick={onRegisterTextKnowledge}
          >
            {textIngestState === "submitting"
              ? "Registering..."
              : "Register text"}
          </button>
          <p className={`upload-hint upload-${textIngestState}`}>
            {textIngestMessage}
          </p>
        </div>
      </div>
    </section>
  );
}
