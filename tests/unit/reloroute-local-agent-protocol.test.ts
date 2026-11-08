import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLocalAgentRequest,
  localAgentToolResult,
  MAX_LOCAL_AGENT_TOOL_ROUNDS,
  parseLocalAgentAction,
  parseLocalAgentReply,
  type LocalToolCall,
} from "../../src/app/(dashboard)/dashboard/playground/components/tabs/localAgentProtocol.ts";

const read: LocalToolCall = {
  id: "call_read",
  type: "function",
  function: { name: "read_file", arguments: '{"path":"notes/todo.txt"}' },
};
const shell: LocalToolCall = {
  id: "call_shell",
  type: "function",
  function: { name: "shell", arguments: '{"command":"echo RELO_TOOL_OK"}' },
};

test("Local Agent preserves both calls and matches each result in the Muse follow-up", () => {
  const assistant = parseLocalAgentReply(
    { choices: [{ message: { content: null, tool_calls: [read, shell] } }] },
    0
  );
  assert.deepEqual(parseLocalAgentAction(read), { kind: "read", path: "notes/todo.txt" });
  assert.deepEqual(parseLocalAgentAction(shell), { kind: "shell", command: "echo RELO_TOOL_OK" });

  const next = buildLocalAgentRequest(
    [
      { role: "user", content: "Read the file and run the check." },
      assistant,
      localAgentToolResult(read, { ok: true, output: "Read result" }),
      localAgentToolResult(shell, { ok: false, output: "The user declined this action." }),
    ],
    1
  );

  assert.equal(next.model, "museai/muse-chat");
  assert.equal(next.stream, false);
  assert.deepEqual(
    next.tools?.map((tool) => tool.function.name),
    ["read_file", "shell"]
  );
  assert.deepEqual(next.messages.slice(-3), [
    { role: "assistant", content: null, tool_calls: [read, shell] },
    { role: "tool", tool_call_id: "call_read", content: "Read result" },
    {
      role: "tool",
      tool_call_id: "call_shell",
      content: "Action failed: The user declined this action.",
    },
  ]);
});

test("Local Agent rejects unknown or malformed actions and bounds the tool loop", () => {
  const withArguments = (args: string): LocalToolCall => ({
    ...shell,
    function: { ...shell.function, arguments: args },
  });
  assert.equal(parseLocalAgentAction(withArguments('{"command":42}')), null);
  const exact = "  echo RELO_TOOL_OK ";
  assert.deepEqual(parseLocalAgentAction(withArguments(JSON.stringify({ command: exact }))), {
    kind: "shell",
    command: exact,
  });
  assert.equal(
    parseLocalAgentAction(withArguments(JSON.stringify({ command: "x".repeat(1025) }))),
    null
  );
  assert.equal(parseLocalAgentAction(withArguments('{"command":"  "}')), null);
  assert.equal(parseLocalAgentAction(withArguments('{"command":"echo ok","run":true}')), null);
  assert.equal(parseLocalAgentAction(withArguments('{"command":')), null);
  assert.equal(
    parseLocalAgentAction({ ...shell, function: { ...shell.function, name: "unknown" } }),
    null
  );

  const reply = (tool_calls: LocalToolCall[]) => ({ choices: [{ message: { tool_calls } }] });
  assert.throws(() => parseLocalAgentReply(reply([read, read]), 0), /duplicate tool call IDs/);
  const oversized = Array.from({ length: 5 }, (_, i) => ({ ...read, id: "call_" + i }));
  assert.throws(() => parseLocalAgentReply(reply(oversized), 0), /too many tool calls/);
  assert.throws(
    () => parseLocalAgentReply(reply([shell]), MAX_LOCAL_AGENT_TOOL_ROUNDS),
    /after the tool limit/
  );
  assert.equal(buildLocalAgentRequest([], MAX_LOCAL_AGENT_TOOL_ROUNDS).tools, undefined);
});
