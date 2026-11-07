import { randomUUID } from "node:crypto";

import { normalizeSessionCookieHeader } from "@/lib/providers/webCookieAuth";

import { buildErrorBody } from "../utils/error.ts";
import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import {
  MuseAiToolProtocolError,
  parseMuseAiReply,
  prepareMuseAiRequest,
} from "./muse-ai-web/protocol.ts";
import {
  MUSE_AI_CHAT_URL,
  MuseAiTransportError,
  completeMuseAi,
  type MuseAiTransport,
} from "./muse-ai-web/transport.ts";

const PROVIDER = "muse-ai-web";

function cookieHeader(credentials: ProviderCredentials): string {
  const details = credentials.providerSpecificData;
  const candidate = [details?.cookie, credentials.apiKey, details?.hatch_sess].find(
    (value) => typeof value === "string" && value.trim()
  );
  if (typeof candidate !== "string") return "";
  try {
    return normalizeSessionCookieHeader(candidate, "hatch_sess");
  } catch {
    return "";
  }
}

function result(response: Response) {
  // Không sao chép cookie hoặc prompt vào metadata chẩn đoán của executor.
  return { response, url: MUSE_AI_CHAT_URL, headers: {}, transformedBody: null };
}

function failure(status: number, message: string) {
  return result(Response.json(buildErrorBody(status, message), { status }));
}

function completion(
  model: string,
  reply: ReturnType<typeof parseMuseAiReply>,
  stream: boolean
): Response {
  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const calls = reply.toolCalls;
  const finish_reason = calls.length ? "tool_calls" : "stop";
  if (!stream) {
    return Response.json({
      id,
      created,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason,
          message: {
            role: "assistant",
            content: reply.content || null,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
        },
      ],
    });
  }
  const packets: string[] = [];
  function emit(delta: Record<string, unknown>, finish: string | null = null) {
    packets.push(
      "data: " +
        JSON.stringify({
          id,
          created,
          model,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        "\n\n"
    );
  }
  emit({ role: "assistant" });
  if (reply.content) emit({ content: reply.content });
  if (calls.length) {
    emit({
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: call.type,
        function: { name: call.function.name, arguments: "" },
      })),
    });
    emit({
      tool_calls: calls.map((call, index) => ({
        index,
        function: { arguments: call.function.arguments },
      })),
    });
  }
  emit({}, finish_reason);
  packets.push("data: [DONE]\n\n");
  return new Response(packets.join(""), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
  });
}

export class MuseAiWebExecutor extends BaseExecutor {
  constructor(private readonly transport: MuseAiTransport = completeMuseAi) {
    super(PROVIDER, { baseUrl: MUSE_AI_CHAT_URL, format: "openai" });
  }

  async execute(input: ExecuteInput) {
    const cookie = cookieHeader(input.credentials);
    if (!/(?:^|;\s*)hatch_sess=[^;\s]+/.test(cookie) || /[\r\n]/.test(cookie)) {
      return failure(401, "Muse requires a valid hatch_sess cookie from muse.ai.");
    }
    const { prompt, toolNames } = prepareMuseAiRequest(input.body);
    if (!prompt) return failure(400, "Muse requires a non-empty text message.");
    try {
      const text = await this.transport({ cookieHeader: cookie, prompt, signal: input.signal });
      if (!text.trim()) return failure(502, "Muse returned no response text.");
      return result(completion(input.model, parseMuseAiReply(text, toolNames), input.stream));
    } catch (error) {
      if (error instanceof MuseAiToolProtocolError) {
        return failure(502, error.message + " No tools were dispatched.");
      }
      if (error instanceof MuseAiTransportError) return failure(error.status, error.message);
      if (input.signal?.aborted) return failure(499, "Muse request was cancelled.");
      return failure(502, "Muse web request failed before a complete response was available.");
    }
  }
}
