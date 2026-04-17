import type { FormEvent } from "react";
import type { ChatMessage, RuntimeConfigSnapshot } from "../types/app";

type ChatPanelProps = {
  runtimeConfigStatus: "loading" | "ok" | "error";
  runtimeConfig: RuntimeConfigSnapshot | null;
  searchOnlyMode: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  chatPending: boolean;
  onSendChat: () => Promise<void>;
  onChatInputChange: (value: string) => void;
};

export function ChatPanel({
  runtimeConfigStatus,
  runtimeConfig,
  searchOnlyMode,
  chatMessages,
  chatInput,
  chatPending,
  onSendChat,
  onChatInputChange
}: ChatPanelProps) {
  return (
    <section className="panel panel-chat">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">Chat</p>
          <h2>RAG chatbot</h2>
        </div>
        <span className="panel-tag">Tenant-scoped search</span>
      </div>

      {runtimeConfigStatus === "ok" && runtimeConfig ? (
        <div
          className={`mode-callout ${searchOnlyMode ? "mode-callout-warning" : "mode-callout-ok"}`}
        >
          <strong>
            {searchOnlyMode
              ? "Search-only fallback mode"
              : "Generative answer mode"}
          </strong>
          <p>
            {searchOnlyMode
              ? "This is not an error. The assistant is answering from Azure AI Search results because no OpenAI credential is configured yet."
              : "Search results are retrieved first and then condensed into a model-generated answer."}
          </p>
        </div>
      ) : null}

      <div className="chat-stream">
        {chatMessages.map(message => (
          <article
            key={message.id}
            className={`message message-${message.role}`}
          >
            <span className="message-role">
              {message.role === "user" ? "You" : "Assistant"}
            </span>
            <p>{message.content}</p>
            {message.citations?.length ? (
              <small>Sources: {message.citations.join(" / ")}</small>
            ) : null}
          </article>
        ))}
      </div>

      <form
        className="chat-composer"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void onSendChat();
        }}
      >
        <label className="composer-label" htmlFor="chat-input">
          Your question
        </label>
        <textarea
          id="chat-input"
          rows={4}
          placeholder="e.g. What does the contract say about termination?"
          value={chatInput}
          onChange={event => onChatInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSendChat();
            }
          }}
          disabled={chatPending}
        />
        <div className="composer-actions">
          <div className="composer-hint">
            Search always runs first. The runtime flag above decides whether the
            final answer is search-only or model-generated.
          </div>
          <button type="submit" disabled={chatPending || !chatInput.trim()}>
            {chatPending ? "Working…" : "Send question"}
          </button>
        </div>
      </form>
    </section>
  );
}
