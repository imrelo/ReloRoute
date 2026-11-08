import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part) => isObject(part) && ["text", "input_text", "output_text"].includes(String(part.type))
    )
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

const TOOL_PROTOCOL = `The functions below run on the external coding client. For local files and shell commands, use these client_ functions, not the Muse cloud filesystem. Request a tool, wait for its real result, then continue. Do not claim work completed without that result. The listed client functions are available through the coding client even when the Muse web page itself has no local tools.

For a tool request, return one valid JSON block like {"name":"client_tool_name","arguments":{}}. Use a JSON array for multiple requests. Use only the listed function names and their schemas. Output each batch once. Use forward slashes for Windows paths, for example C:/Users/example/file.txt. Escape every literal backslash in JSON strings, including in shell commands. If no more tools are needed, answer normally without printing tool call examples.

External client functions:`;

export function prepareMuseAiRequest(body: unknown): { prompt: string; toolNames: Set<string> } {
  const input = isObject(body) ? body : {};
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const history: string[] = [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    const role = typeof message.role === "string" ? message.role : "user";
    let content = messageText(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      content += "\nClient tool requests: " + JSON.stringify(message.tool_calls);
    }
    if (role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      history.push(`Tool result (${id}):\n${content}`);
    } else if (content.trim()) {
      history.push(`${role}:\n${content.trim()}`);
    }
  }
  const toolNames = new Set<string>();
  const tools = input.tool_choice !== "none" && Array.isArray(input.tools) ? input.tools : [];
  const definitions: string[] = [];
  for (const tool of tools) {
    if (!isObject(tool) || !isObject(tool.function)) continue;
    const fn = tool.function;
    if (typeof fn.name !== "string" || !fn.name || toolNames.has(fn.name)) continue;
    toolNames.add(fn.name);
    definitions.push(
      `client_${fn.name}: ${typeof fn.description === "string" ? fn.description : ""}\nJSON Schema: ${JSON.stringify(fn.parameters ?? {})}`
    );
  }
  if (history.length && definitions.length)
    history.push(TOOL_PROTOCOL + "\n" + definitions.join("\n\n"));
  return { prompt: history.join("\n\n"), toolNames };
}

export class MuseAiToolProtocolError extends Error {}

export class MuseAiToolJsonError extends MuseAiToolProtocolError {}

export type MuseAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const NAME_KEYS = ["name", "tool", "function"] as const;
const ARGUMENT_KEYS = ["arguments", "parameters", "args"] as const;

function toolHint(text: string): boolean {
  return (
    /"(?:name|tool|function)"\s*:\s*"client_[^"]+"/.test(text) ||
    (/"(?:name|tool|function)"\s*:/.test(text) && /"(?:arguments|parameters|args)"\s*:/.test(text))
  );
}

function isToolItem(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    NAME_KEYS.some((key) => key in value) &&
    (ARGUMENT_KEYS.some((key) => key in value) ||
      NAME_KEYS.some((key) => typeof value[key] === "string" && value[key].startsWith("client_")))
  );
}

// Tách container ngoài cùng, bỏ qua ngoặc trong string kể cả khi escape sai.
function containerEnd(text: string, start: number): number {
  const stack: string[] = [];
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[") || !stack.length) return index + 1;
    }
  }
  return text.length;
}

function collapseToolReply(text: string): string {
  if (!toolHint(text)) return text;
  for (const separator of ["", "\n\n", "\n", "\r\n\r\n", "\r\n", " "]) {
    for (const count of [4, 3, 2]) {
      const size = (text.length - separator.length * (count - 1)) / count;
      if (Number.isInteger(size) && size > 0) {
        const first = text.slice(0, size);
        if (Array<string>(count).fill(first).join(separator) === text) return first;
      }
    }
  }
  return text;
}

// Chỉ bỏ nhãn json sát khối tool đã nhận diện; giữ mọi text và code thông thường.
function displaySpan(text: string, start: number, end: number): [number, number] {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const opener =
    /(?:^|\r?\n)(?:[ \t]*json[ \t]*\r?\n)?[ \t]*(`{3,})(?:json)?[ \t]*\r?\n[ \t]*$/i.exec(before);
  const closer = /^[ \t]*\r?\n[ \t]*(`{3,})[ \t]*(?=\r?\n|$)/.exec(after);
  if (opener && closer && opener[1].length === closer[1].length) {
    return [opener.index, end + closer[0].length];
  }
  const label = /(?:^|\r?\n)[ \t]*json[ \t]*\r?\n[ \t]*$/i.exec(before);
  return [label?.index ?? start, end];
}

function parseBatch(items: unknown[], toolNames: Set<string>): MuseAiToolCall[] {
  return items.map((item) => {
    if (!isToolItem(item))
      throw new MuseAiToolProtocolError("Muse returned a malformed tool batch.");
    const rawName = NAME_KEYS.map((key) => item[key]).find(
      (name) => typeof name === "string" && name
    );
    if (typeof rawName !== "string")
      throw new MuseAiToolProtocolError("Muse returned an invalid tool name.");
    const name = rawName.startsWith("client_") ? rawName.slice(7) : rawName;
    if (!toolNames.has(name))
      throw new MuseAiToolProtocolError("Muse requested a tool that was not offered.");
    const argumentKey = ARGUMENT_KEYS.find((key) => key in item);
    let args = argumentKey ? item[argumentKey] : null;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        throw new MuseAiToolJsonError("Muse returned invalid JSON tool arguments.");
      }
    }
    if (!isObject(args))
      throw new MuseAiToolProtocolError("Muse tool arguments must be a JSON object.");
    return {
      id: "call_" + randomUUID().replaceAll("-", ""),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  });
}

export function parseMuseAiReply(
  raw: string,
  toolNames: Set<string>
): {
  content: string;
  toolCalls: MuseAiToolCall[];
} {
  if (!toolNames.size) return { content: raw, toolCalls: [] };
  const text = collapseToolReply(raw);
  const spans: Array<[number, number]> = [];
  const seen = new Set<string>();
  const toolCalls: MuseAiToolCall[] = [];
  const opening = /[\[{]/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    const start = match.index;
    const end = containerEnd(text, start);
    const candidate = text.slice(start, end);
    opening.lastIndex = end;
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      if (toolHint(candidate)) {
        throw new MuseAiToolJsonError(
          "Muse returned invalid tool JSON. Use valid JSON and forward-slash Windows paths."
        );
      }
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    if (!items.some(isToolItem)) continue;
    const batch = parseBatch(items, toolNames);
    const key = JSON.stringify(
      batch.map((call) => [call.function.name, JSON.parse(call.function.arguments)]),
      (_key, item: unknown) =>
        isObject(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((name) => [name, item[name]])
            )
          : item
    );
    if (!seen.has(key)) {
      seen.add(key);
      toolCalls.push(...batch);
    }
    spans.push(displaySpan(text, start, end));
  }
  if (!toolCalls.length) return { content: raw, toolCalls };
  let content = text;
  for (const [start, end] of spans.reverse())
    content = content.slice(0, start) + content.slice(end);
  return { content: content.trim(), toolCalls };
}
