import { z } from "zod";

const MAX_TOOLS_PER_BATCH = 4;
const MAX_COMMAND_LENGTH = 1024;
export const MAX_LOCAL_AGENT_TOOL_ROUNDS = 4;

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0);
const commandSchema = z
  .string()
  .min(1)
  .max(MAX_COMMAND_LENGTH)
  .refine((value) => value.trim().length > 0);
const toolCallSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(128),
    arguments: z.string().max(8192),
  }),
});

export type LocalToolCall = z.infer<typeof toolCallSchema>;
export type LocalAgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LocalToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

const replySchema = z.object({
  choices: z
    .tuple([
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(toolCallSchema).max(MAX_TOOLS_PER_BATCH).optional(),
        }),
      }),
    ])
    .rest(z.unknown()),
});

const actionSchemas = {
  read_file: z.object({ path: pathSchema }).strict(),
  shell: z.object({ command: commandSchema }).strict(),
};

export type LocalAgentAction = { kind: "read"; path: string } | { kind: "shell"; command: string };

export function parseLocalAgentAction(call: LocalToolCall): LocalAgentAction | null {
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return null;
  }

  if (call.function.name === "read_file") {
    const parsed = actionSchemas.read_file.safeParse(args);
    return parsed.success ? { kind: "read", path: parsed.data.path } : null;
  }
  if (call.function.name === "shell") {
    const parsed = actionSchemas.shell.safeParse(args);
    return parsed.success ? { kind: "shell", command: parsed.data.command } : null;
  }
  return null;
}

const localTools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the selected Windows workspace. Use a relative path with forward slashes.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", maxLength: 4096 } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Request one PowerShell command on Windows from the selected workspace. The user must approve the exact command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", maxLength: MAX_COMMAND_LENGTH } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

export function buildLocalAgentRequest(messages: LocalAgentMessage[], toolRounds: number) {
  return {
    model: "museai/muse-chat",
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "Use only the available Windows tools for local actions. Ask for a tool and wait for its actual result. If an action is declined, do not request the same action again unless the user asks. Prefer read_file over shell for reading files.",
      },
      ...messages,
    ],
    ...(toolRounds < MAX_LOCAL_AGENT_TOOL_ROUNDS ? { tools: localTools } : {}),
  };
}

export function parseLocalAgentReply(
  data: unknown,
  toolRounds: number
): Extract<LocalAgentMessage, { role: "assistant" }> {
  const parsed = replySchema.safeParse(data);
  if (!parsed.success) throw new Error("Muse returned an invalid response or too many tool calls.");

  const { content, tool_calls: calls = [] } = parsed.data.choices[0].message;
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new Error("Muse returned duplicate tool call IDs.");
  }
  if (calls.length > 0 && toolRounds >= MAX_LOCAL_AGENT_TOOL_ROUNDS) {
    throw new Error("Muse requested another action after the tool limit.");
  }
  if (calls.length === 0 && !content?.trim()) throw new Error("Muse returned an empty response.");

  return {
    role: "assistant",
    content: content ?? null,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

export function localAgentToolResult(
  call: LocalToolCall,
  result: { ok: boolean; output: string }
): Extract<LocalAgentMessage, { role: "tool" }> {
  return {
    role: "tool",
    tool_call_id: call.id,
    content: result.ok ? result.output : "Action failed: " + result.output,
  };
}
