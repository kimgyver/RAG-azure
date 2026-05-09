import { useCallback, useEffect, useMemo, useState } from "react";
import {
  initialChatMessages,
  type ChatMessage,
  type ChatResponse
} from "../types/app";
import {
  CHAT_RETRYABLE_STATUS,
  buildTenantChatSessionId,
  extractApiMessage,
  isRetryableChatFetchError,
  waitMs
} from "../utils/app";

/**
 * Manages chat messages, input state, and chat operations per tenant.
 */
export function useChat(
  effectiveTenantId: string,
  apiBaseUrl: string,
  apiKey: string
) {
  const [chatMessagesByTenant, setChatMessagesByTenant] = useState<
    Record<string, ChatMessage[]>
  >({
    [effectiveTenantId]: initialChatMessages
  });

  const [chatInput, setChatInput] = useState("");
  const [chatPending, setChatPending] = useState(false);
  const [chatSummaryMemoryByTenant, setChatSummaryMemoryByTenant] = useState<
    Record<string, string>
  >({});

  const chatSessionId = useMemo(
    () => buildTenantChatSessionId(effectiveTenantId),
    [effectiveTenantId]
  );

  const chatMessages =
    chatMessagesByTenant[effectiveTenantId] ?? initialChatMessages;
  const chatSummaryMemory = chatSummaryMemoryByTenant[effectiveTenantId] ?? "";

  // Ensure tenant has message array
  useEffect(() => {
    setChatMessagesByTenant(prev => {
      if (prev[effectiveTenantId]) {
        return prev;
      }
      return {
        ...prev,
        [effectiveTenantId]: initialChatMessages
      };
    });
  }, [effectiveTenantId]);

  const sendChat = useCallback(
    async (question: string): Promise<ChatMessage | null> => {
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion || chatPending) {
        return null;
      }

      const tenantScopedMessages =
        chatMessagesByTenant[effectiveTenantId] ?? initialChatMessages;

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmedQuestion
      };

      setChatMessagesByTenant(prev => ({
        ...prev,
        [effectiveTenantId]: [
          ...(prev[effectiveTenantId] ?? initialChatMessages),
          userMessage
        ]
      }));
      setChatInput("");
      setChatPending(true);

      try {
        const messagesForMemory = [...tenantScopedMessages, userMessage]
          .filter(
            message => message.role === "user" || message.role === "assistant"
          )
          .slice(-12)
          .map(message => ({
            role: message.role,
            content: message.content
          }));

        const requestBody = JSON.stringify({
          tenantId: effectiveTenantId,
          question: trimmedQuestion,
          sessionId: chatSessionId,
          summaryMemory: chatSummaryMemory,
          messages: messagesForMemory
        });

        const maxAttempts = 3;
        let response: Response | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            response = await fetch(`${apiBaseUrl}/chat`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "x-functions-key": apiKey } : {})
              },
              body: requestBody
            });

            if (response.ok) {
              break;
            }

            const responseText = await response.text();
            const detail = extractApiMessage(
              responseText,
              `HTTP ${response.status}`
            );
            const retryable = CHAT_RETRYABLE_STATUS.has(response.status);
            if (retryable && attempt < maxAttempts) {
              await waitMs(250 * attempt);
              continue;
            }

            throw new Error(
              `Chat request failed (${response.status}) ${detail}`
            );
          } catch (error) {
            if (isRetryableChatFetchError(error) && attempt < maxAttempts) {
              await waitMs(250 * attempt);
              continue;
            }
            throw error;
          }
        }

        if (!response?.ok) {
          throw new Error(
            "Chat request failed (503) Service temporarily unavailable."
          );
        }

        const payload = (await response.json()) as ChatResponse;

        if (payload.memory?.summary) {
          setChatSummaryMemoryByTenant(prev => ({
            ...prev,
            [effectiveTenantId]: payload.memory?.summary ?? ""
          }));
        }

        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: payload.answer,
          citations: payload.citations.map(
            citation =>
              `${citation.fileName} · chunk ${citation.chunkIndex + 1}`
          ),
          usage: payload.usage
        };

        setChatMessagesByTenant(prev => ({
          ...prev,
          [effectiveTenantId]: [
            ...(prev[effectiveTenantId] ?? initialChatMessages),
            assistantMessage
          ]
        }));

        return assistantMessage;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        const errorMessage_: ChatMessage = {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: `Could not process your question. ${errorMessage}`
        };

        setChatMessagesByTenant(prev => ({
          ...prev,
          [effectiveTenantId]: [
            ...(prev[effectiveTenantId] ?? initialChatMessages),
            errorMessage_
          ]
        }));

        return null;
      } finally {
        setChatPending(false);
      }
    },
    [
      chatPending,
      chatMessagesByTenant,
      effectiveTenantId,
      apiBaseUrl,
      apiKey,
      chatSessionId,
      chatSummaryMemory
    ]
  );

  return {
    chatMessages,
    chatInput,
    setChatInput,
    chatPending,
    sendChat,
    clearMessages: () => {
      setChatMessagesByTenant(prev => ({
        ...prev,
        [effectiveTenantId]: initialChatMessages
      }));
    }
  };
}
