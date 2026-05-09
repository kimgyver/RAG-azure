import { useCallback, useState, type ChangeEvent } from "react";
import type {
  CreateUploadResponse,
  DocumentItem,
  DocumentStatus,
  UploadState
} from "../types/app";
import {
  type BackendTarget,
  BACKEND_RESOURCE_LABELS,
  extractApiMessage,
  isAwsBackend
} from "../utils/app";

type ProcessingState = {
  documents: DocumentItem[];
  uploadState: UploadState;
  uploadMessage: string;
};

/**
 * Manages file upload state, file selection, and upload operations.
 */
export function useUpload(
  tenantId: string,
  apiBaseUrl: string,
  apiKey: string,
  backendTarget: BackendTarget,
  onUploadComplete?: (documentId: string, tenantId: string) => void,
  _onCatalogRefresh?: () => Promise<void> // Reserved for future use
) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingState>({
    documents: [],
    uploadState: "idle",
    uploadMessage: "Choose a file and start upload."
  });

  const onFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setProcessingState(prev => ({
      ...prev,
      uploadState: "idle",
      uploadMessage: file ? `${file.name} selected.` : "Please choose a file."
    }));
  }, []);

  const startUpload = useCallback(async () => {
    const labels = BACKEND_RESOURCE_LABELS[backendTarget];

    if (!selectedFile) {
      setProcessingState(prev => ({
        ...prev,
        uploadState: "error",
        uploadMessage: "Please choose a file to upload first."
      }));
      return;
    }

    const tempId = `temp-${Date.now()}`;
    const tempItem: DocumentItem = {
      id: tempId,
      fileName: selectedFile.name,
      status: "uploading" as DocumentStatus,
      updatedAt: "just now",
      tenantId
    };

    setProcessingState(prev => ({
      ...prev,
      documents: [tempItem, ...prev.documents]
    }));

    try {
      setProcessingState(prev => ({
        ...prev,
        uploadState: "requesting-sas",
        uploadMessage: `Requesting ${labels.uploadUrlLabel}...`
      }));

      const sasResponse = await fetch(`${apiBaseUrl}/uploads/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-functions-key": apiKey } : {})
        },
        body: JSON.stringify({
          tenantId,
          fileName: selectedFile.name,
          contentType: selectedFile.type || "application/octet-stream"
        })
      });

      if (!sasResponse.ok) {
        const responseText = await sasResponse.text();
        const detail = extractApiMessage(
          responseText,
          `HTTP ${sasResponse.status}`
        );
        throw new Error(
          `Failed to get SAS URL (${sasResponse.status}) ${detail}`
        );
      }

      const sasPayload = (await sasResponse.json()) as CreateUploadResponse;

      setProcessingState(prev => ({
        ...prev,
        uploadState: "uploading",
        uploadMessage: `Uploading directly to ${labels.storageLabel}...`
      }));

      const effectiveUploadUrl =
        import.meta.env.DEV && sasPayload.uploadUrl.includes("127.0.0.1:10000")
          ? (() => {
              const u = new URL(sasPayload.uploadUrl);
              return u.pathname + u.search;
            })()
          : sasPayload.uploadUrl;

      const uploadHeaders: Record<string, string> = isAwsBackend(
        backendTarget as any
      )
        ? {
            "Content-Type": selectedFile.type || "application/octet-stream"
          }
        : {
            "x-ms-blob-type": "BlockBlob",
            "Content-Type": selectedFile.type || "application/octet-stream"
          };

      const uploadResponse = await fetch(effectiveUploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
        body: selectedFile
      });

      if (!uploadResponse.ok) {
        const responseText = await uploadResponse.text();
        throw new Error(
          `Blob direct upload failed (${uploadResponse.status}) ${responseText}`
        );
      }

      if (backendTarget === "aws" || backendTarget === "aws-python") {
        await fetch(`${apiBaseUrl}/uploads/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: sasPayload.tenantId,
            documentId: sasPayload.documentId,
            blobName: sasPayload.blobName
          })
        });
      }

      setProcessingState(prev => ({
        ...prev,
        documents: prev.documents.map(item =>
          item.id === tempId
            ? {
                ...item,
                id: sasPayload.documentId,
                tenantId: sasPayload.tenantId,
                status: "queued" as DocumentStatus,
                updatedAt: "just now"
              }
            : item
        ),
        uploadState: "done",
        uploadMessage: "Upload complete. Status will show as queued."
      }));

      onUploadComplete?.(sasPayload.documentId, sasPayload.tenantId);
    } catch (error) {
      setProcessingState(prev => ({
        ...prev,
        documents: prev.documents.map(item =>
          item.id === tempId
            ? { ...item, status: "failed" as DocumentStatus }
            : item
        ),
        uploadState: "error"
      }));

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      setProcessingState(prev => ({
        ...prev,
        uploadMessage: `Upload error: ${errorMessage} (API: ${apiBaseUrl}/uploads/create)`
      }));
    }
  }, [
    selectedFile,
    tenantId,
    apiBaseUrl,
    apiKey,
    backendTarget,
    onUploadComplete
  ]);

  return {
    selectedFile,
    onFileChange,
    uploadState: processingState.uploadState,
    uploadMessage: processingState.uploadMessage,
    documents: processingState.documents,
    startUpload
  };
}
