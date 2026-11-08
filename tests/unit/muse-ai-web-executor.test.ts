import assert from "node:assert/strict";
import { test } from "node:test";

import { MuseAiWebExecutor } from "../../open-sse/executors/muse-ai-web.ts";
import {
  parseMuseAiReply,
  prepareMuseAiRequest,
} from "../../open-sse/executors/muse-ai-web/protocol.ts";
import { exchangeMuseAiReply } from "../../open-sse/executors/muse-ai-web/transport.ts";

const windowsPath = "C:/Users/example/project/counter.txt";
const nestedSchema = {
  type: "object",
  properties: { path: { type: "string" }, options: { $ref: "#/$defs/options" } },
  $defs: { options: { type: "object", properties: { limit: { type: "integer" } } } },
};
const tools = [
  { type: "function", function: { name: "read", parameters: nestedSchema } },
  { type: "function", function: { name: "shell", parameters: { type: "object" } } },
];
const read = { name: "client_read", arguments: { path: windowsPath } };
const shell = { name: "client_shell", arguments: { command: `Get-Content '${windowsPath}'` } };
const body = { messages: [{ role: "user", content: "Read the Windows file." }], tools };
const mockCookie = "fixture_only_not_a_session";

function fixtureExecutor(text: string, seen: string[] = []) {
  return new MuseAiWebExecutor(async ({ cookieHeader, prompt }) => {
    assert.equal(cookieHeader, `hatch_sess=${mockCookie}`);
    seen.push(prompt);
    return text;
  });
}

test("Muse tool prompts retain nested schemas, assistant calls and actual local results", () => {
  const prepared = prepareMuseAiRequest({
    ...body,
    messages: [
      ...body.messages,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_test", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_test", content: "fixture output: 171" },
    ],
  });
  assert.match(prepared.prompt, /client_read/);
  assert.match(prepared.prompt, /forward slashes/);
  assert.ok(prepared.prompt.includes(JSON.stringify(nestedSchema)));
  assert.match(prepared.prompt, /Client tool requests:.*call_test/);
  assert.match(prepared.prompt, /Tool result \(call_test\):\nfixture output: 171/);
});

test("Muse emits distinct tool calls once and drops only the adjacent json label", async () => {
  const block =
    "Checking the local file.\njson\n```json\n" + JSON.stringify([read, shell]) + "\n```";
  const executor = fixtureExecutor(block + "\n\n" + block);
  const result = await executor.execute({
    model: "muse-chat",
    body,
    stream: true,
    credentials: { apiKey: mockCookie },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
  assert.deepEqual(result.headers, {});
  const sse = await result.response.text();
  const packets = sse
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const choices = packets.flatMap((packet) => packet.choices);
  const content = choices.map((choice) => choice.delta.content ?? "").join("");
  const calls = choices.flatMap((choice) => choice.delta.tool_calls ?? []);
  assert.equal(content, "Checking the local file.");
  assert.deepEqual(
    calls.filter((call) => call.id).map((call) => [call.index, call.function.name]),
    [
      [0, "read"],
      [1, "shell"],
    ]
  );
  assert.deepEqual(
    calls.filter((call) => !call.id).map((call) => JSON.parse(call.function.arguments)),
    [read.arguments, shell.arguments]
  );
  assert.equal(choices.at(-1).finish_reason, "tool_calls");
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
});

test("Muse rejects malformed Windows paths and unknown tools without leaking raw JSON", async () => {
  const invalid = [
    String.raw`json
{"name":"client_read","arguments":{"path":"C:\Users\example\counter.txt"}}`,
    JSON.stringify({ name: "client_unknown", arguments: {} }),
    JSON.stringify({ name: "client_read", arguments: [] }),
  ];
  for (const text of invalid) {
    const result = await fixtureExecutor(text).execute({
      model: "muse-chat",
      body,
      stream: true,
      credentials: { apiKey: mockCookie },
    });
    assert.equal(result.response.status, 502);
    const error = await result.response.json();
    assert.match(error.error.message, /No tools were dispatched/);
    assert.doesNotMatch(error.error.message, /client_read|fixture_only/);
  }
});

test("Muse repairs invalid tool JSON in the same exchange before Orca receives a tool call", async () => {
  const invalid = '{"name":"client_read","arguments":{"path":"C:\\Users\\example\\counter.txt"}}';
  const prompts: string[] = [];
  const executor = new MuseAiWebExecutor(({ prompt, repairPrompt }) =>
    exchangeMuseAiReply(
      async (message) => {
        prompts.push(message);
        return prompts.length === 1 ? invalid : JSON.stringify(read);
      },
      prompt,
      repairPrompt
    )
  );

  const { response } = await executor.execute({
    model: "muse-chat",
    body,
    stream: false,
    credentials: { apiKey: mockCookie },
  });

  assert.equal(response.status, 200);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /valid JSON/i);
  assert.doesNotMatch(prompts[1], /fixture_only|counter\.txt/);
  const { choices } = await response.json();
  assert.equal(choices[0].finish_reason, "tool_calls");
  assert.equal(choices[0].message.tool_calls.length, 1);
  assert.equal(choices[0].message.tool_calls[0].function.name, "read");
  assert.deepEqual(JSON.parse(choices[0].message.tool_calls[0].function.arguments), read.arguments);
});

test("Muse tries tool JSON repair only once and dispatches nothing if it fails", async () => {
  const invalid = '{"name":"client_read","arguments":';
  for (const repaired of [invalid, "I cannot run the local tool."]) {
    let turns = 0;
    const executor = new MuseAiWebExecutor(({ prompt, repairPrompt }) =>
      exchangeMuseAiReply(async () => (++turns === 1 ? invalid : repaired), prompt, repairPrompt)
    );
    const { response } = await executor.execute({
      model: "muse-chat",
      body,
      stream: false,
      credentials: { apiKey: mockCookie },
    });
    assert.equal(turns, 2);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /No tools were dispatched/);
  }
});

test("Muse does not retry a tool name that Orca did not offer", async () => {
  let turns = 0;
  const executor = new MuseAiWebExecutor(({ prompt, repairPrompt }) =>
    exchangeMuseAiReply(
      async () => {
        turns++;
        return JSON.stringify({ name: "client_unknown", arguments: {} });
      },
      prompt,
      repairPrompt
    )
  );
  const { response } = await executor.execute({
    model: "muse-chat",
    body,
    stream: false,
    credentials: { apiKey: mockCookie },
  });
  assert.equal(turns, 1);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /tool that was not offered/);
});

test("Muse preserves ordinary JSON and an exact compaction summary", async () => {
  const prose = 'json\n```json\n{"count":171}\n```';
  assert.deepEqual(parseMuseAiReply(prose, new Set(["read"])), { content: prose, toolCalls: [] });
  const summary =
    "## Objective\n- Continue the local test.\n\n## Work State\n### Completed\n- Verified 171 lines.";
  const prompts: string[] = [];
  const executor = fixtureExecutor(summary, prompts);
  const result = await executor.execute({
    model: "muse-chat",
    body: { ...body, tool_choice: "none" },
    stream: false,
    credentials: { apiKey: mockCookie },
  });
  const response = await result.response.json();
  assert.equal(response.choices[0].message.content, summary);
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.doesNotMatch(prompts[0], /External client functions/);
});

test("Muse validates its own cookie before transport and supports stored web-session cookies", async () => {
  const seen: string[] = [];
  const executor = fixtureExecutor("Ready.", seen);
  const invalid = await executor.execute({
    model: "muse-chat",
    body,
    stream: false,
    credentials: { apiKey: "ecto_1_sess=not_muse" },
  });
  assert.equal(invalid.response.status, 401);
  assert.equal(seen.length, 0);
  const valid = await executor.execute({
    model: "muse-chat",
    body,
    stream: false,
    credentials: { providerSpecificData: { cookie: `hatch_sess=${mockCookie}` } },
  });
  assert.equal(valid.response.status, 200);
  assert.equal(seen.length, 1);
});
