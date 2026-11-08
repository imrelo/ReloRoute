"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import Textarea from "@/shared/components/Textarea";
import MarkdownMessage from "../MarkdownMessage";
import {
  buildLocalAgentRequest,
  localAgentToolResult,
  parseLocalAgentAction,
  parseLocalAgentReply,
  type LocalAgentMessage,
  type LocalToolCall,
} from "./localAgentProtocol";

export type LocalAgentApi = NonNullable<Window["electronAPI"]["localAgent"]>;

export default function LocalAgentPanel({
  api,
  onExit,
}: {
  api: LocalAgentApi;
  onExit: () => void;
}) {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<LocalAgentMessage[]>([]);
  const [pending, setPending] = useState<LocalToolCall[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const mounted = useRef(false);
  const locked = useRef(false);
  const toolRounds = useRef(0);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      void api.clearWorkspace().catch(() => undefined);
    };
  }, [api]);

  async function exclusively(run: () => Promise<void>) {
    if (locked.current || !mounted.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch {
      if (mounted.current) setError("The Windows Local Agent could not complete this action.");
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function pickWorkspace() {
    await exclusively(async () => {
      const selected = await api.chooseWorkspace();
      if (!mounted.current || selected === null) return;
      setWorkspace(selected);
      setMessages([]);
      setPrompt("");
      setPending([]);
      setCanRetry(false);
      toolRounds.current = 0;
    });
  }

  async function requestReply(history: LocalAgentMessage[]) {
    const controller = new AbortController();
    request.current = controller;
    setCanRetry(false);
    try {
      const response = await fetch("/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        redirect: "error",
        body: JSON.stringify(buildLocalAgentRequest(history, toolRounds.current)),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error("Sign in to ReloRoute and check your Muse AI Web connection.");
      }
      if (!response.ok) {
        const detail: unknown = await response.json().catch(() => null);
        if (
          typeof detail === "object" &&
          detail !== null &&
          "error" in detail &&
          typeof detail.error === "object" &&
          detail.error !== null &&
          "message" in detail.error &&
          typeof detail.error.message === "string"
        ) {
          throw new Error(detail.error.message.slice(0, 250));
        }
        throw new Error("Muse could not reply (HTTP " + response.status + ").");
      }

      const reply = parseLocalAgentReply(await response.json(), toolRounds.current);
      if (!mounted.current || controller.signal.aborted) return;
      const calls = reply.tool_calls ?? [];
      if (calls.length > 0) toolRounds.current += 1;
      setMessages([...history, reply]);
      setPending(calls);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Muse could not reply.");
        setCanRetry(true);
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (!workspace || !text || pending.length > 0) return;
    await exclusively(async () => {
      toolRounds.current = 0;
      const history: LocalAgentMessage[] = [...messages, { role: "user", content: text }];
      setMessages(history);
      setPrompt("");
      await requestReply(history);
    });
  }

  async function resolveNextCall(approved: boolean) {
    const call = pending[0];
    if (!workspace || !call) return;
    await exclusively(async () => {
      const action = parseLocalAgentAction(call);
      let result: { ok: boolean; output: string };
      if (!action) {
        result = { ok: false, output: "Unsupported tool name or invalid arguments." };
      } else if (!approved) {
        result = { ok: false, output: "The user declined this action." };
      } else {
        try {
          result =
            action.kind === "read"
              ? await api.readFile(action.path)
              : await api.runCommand(action.command);
        } catch {
          result = { ok: false, output: "The Windows Local Agent could not complete this action." };
        }
      }
      if (!mounted.current) return;

      // Gửi cả batch một lần để mỗi tool call có đúng một kết quả trước lượt Muse tiếp theo.
      const history = [...messages, localAgentToolResult(call, result)];
      const remaining = pending.slice(1);
      setMessages(history);
      setPending(remaining);
      if (remaining.length === 0) await requestReply(history);
    });
  }

  const call = pending[0];
  const action = call ? parseLocalAgentAction(call) : null;
  const visibleMessages = messages.filter((message) => message.content);
  const workspaceLabel = workspace ?? "No workspace selected";

  return (
    <section
      aria-labelledby="local-agent-heading"
      className="space-y-4 rounded-xl border border-border bg-bg-base p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="local-agent-heading" className="text-lg font-semibold text-text-main">
            Local Agent
          </h2>
          <p className="mt-1 text-sm text-text-muted">Muse AI Web · Windows</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onExit}>
          Back to Build
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-alt px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs text-text-muted">Workspace</p>
          <p className="break-all text-sm text-text-main">{workspaceLabel}</p>
        </div>
        <Button
          size="sm"
          variant={workspace ? "outline" : "primary"}
          onClick={() => void pickWorkspace()}
          disabled={busy || pending.length > 0}
        >
          {workspace ? "Change folder" : "Choose folder"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Approved file contents and command output are sent to Muse AI Web. Windows asks before
        running each command.
      </p>

      {visibleMessages.length > 0 && (
        <ol aria-label="Conversation" className="max-h-[45vh] space-y-3 overflow-auto">
          {visibleMessages.map((message, index) => (
            <li
              key={message.role === "tool" ? message.tool_call_id + index : index}
              className="rounded-lg border border-border px-3 py-2"
            >
              <p className="mb-1 text-xs font-medium text-text-muted">
                {message.role === "user" ? "You" : message.role === "tool" ? "Tool output" : "Muse"}
              </p>
              {message.role === "assistant" ? (
                <MarkdownMessage content={message.content ?? ""} />
              ) : message.role === "tool" ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-text-main">
                  {message.content}
                </pre>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm text-text-main">
                  {message.content}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

      {call && (
        <div className="space-y-2 rounded-lg border border-border bg-bg-alt p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-text-main">
              {action?.kind === "read"
                ? "Read file"
                : action?.kind === "shell"
                  ? "Run PowerShell command"
                  : "Unsupported tool request"}
            </h3>
            <p className="text-xs text-text-muted">
              {pending.length === 1 ? "1 action pending" : pending.length + " actions pending"}
            </p>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-bg-base p-2 text-xs text-text-main">
            {action?.kind === "read"
              ? action.path
              : action?.kind === "shell"
                ? action.command
                : call.function.arguments}
          </pre>
          <div className="flex flex-wrap gap-2">
            {action && (
              <Button size="sm" disabled={busy} onClick={() => void resolveNextCall(true)}>
                {action.kind === "read" ? "Read and share" : "Review command"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void resolveNextCall(false)}
            >
              {action ? "Decline" : "Skip action"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
          {canRetry && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void exclusively(() => requestReply(messages))}
            >
              Retry reply
            </Button>
          )}
        </div>
      )}

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void sendPrompt();
        }}
      >
        <label htmlFor="local-agent-prompt" className="text-sm font-medium text-text-main">
          Ask Muse
        </label>
        <Textarea
          id="local-agent-prompt"
          placeholder="Read a file or request a PowerShell command"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          disabled={!workspace || busy || pending.length > 0}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={!workspace || !prompt.trim() || busy || !!call}>
            Send
          </Button>
          {busy && (
            <span role="status" className="text-xs text-text-muted">
              Working…
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
