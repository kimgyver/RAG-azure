import { useCallback, useState } from "react";
import type {
  CreateTextKnowledgeResponse,
  DocumentItem,
  TextIngestState
} from "../types/app";
import {
  type BackendTarget,
  BACKEND_RESOURCE_LABELS,
  extractApiMessage
} from "../utils/app";

type TextIngestProcessingState = {
  documents: DocumentItem[];
  textTitle: string;
  textContent: string;
  textIngestState: TextIngestState;
  textIngestMessage: string;
};

/**
 * Manages text knowledge registration state and operations.
 */
export function useTextIngest(
  tenantId: string,
  apiBaseUrl: string,
  apiKey: string,
  backendTarget: BackendTarget,
  onComplete?: () => Promise<void>
) {
  const [state, setState] = useState<TextIngestProcessingState>({
    documents: [],
    textTitle: "",
    textContent: "",
    textIngestState: "idle",
    textIngestMessage: "Type or paste text, then register it for retrieval."
  });

  const register = useCallback(async () => {
    const labels = BACKEND_RESOURCE_LABELS[backendTarget];
    const content = state.textContent.trim();

    if (!content) {
      setState(prev => ({
        ...prev,
        textIngestState: "error",
        textIngestMessage: "Please enter text content first."
      }));
      return;
    }

    const tempId = `text-temp-${Date.now()}`;
    const displayTitle = state.textTitle.trim() || "manual-note.txt";

    setState(prev => ({
      ...prev,
      documents: [
        {
          id: tempId,
          fileName: displayTitle,
          status: "processing",
          updatedAt: "just now",
          tenantId
        },
        ...prev.documents
      ],
      textIngestState: "submitting",
      textIngestMessage: `Registering text in ${labels.searchLabel}...`
    }));

    try {
      const response = await fetch(`${apiBaseUrl}/knowledge/text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-functions-key": apiKey } : {})
        },
        body: JSON.stringify({
          tenantId,
          title: state.textTitle.trim() || undefined,
          text: content
        })
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          extractApiMessage(responseText, `HTTP ${response.status}`)
        );
      }

      const payload = JSON.parse(responseText) as CreateTextKnowledgeResponse;

      setState(prev => ({
        ...prev,
        documents: prev.documents.map(item =>
          item.id === tempId
            ? {
                ...item,
                id: payload.documentId,
                fileName: payload.fileName,
                tenantId: payload.tenantId,
                status: payload.status,
                updatedAt: "just now"
              }
            : item
        ),
        textTitle: "",
        textContent: "",
        textIngestState: "done",
        textIngestMessage: payload.indexed
          ? `Registered ${payload.chunkCount} chunk(s) to ${labels.searchLabel}.`
          : `Text chunked (${payload.chunkCount}) but ${labels.searchLabel} indexing is disabled.`
      }));

      await onComplete?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Text registration failed.";

      setState(prev => ({
        ...prev,
        documents: prev.documents.map(item =>
          item.id === tempId ? { ...item, status: "failed" } : item
        ),
        textIngestState: "error",
        textIngestMessage: message
      }));
    }
  }, [
    state.textContent,
    state.textTitle,
    tenantId,
    apiBaseUrl,
    apiKey,
    backendTarget,
    onComplete
  ]);

  return {
    textTitle: state.textTitle,
    setTextTitle: (title: string) => {
      setState(prev => ({ ...prev, textTitle: title }));
    },
    textContent: state.textContent,
    setTextContent: (content: string) => {
      setState(prev => ({ ...prev, textContent: content }));
    },
    textIngestState: state.textIngestState,
    textIngestMessage: state.textIngestMessage,
    register,
    documents: state.documents
  };
}
