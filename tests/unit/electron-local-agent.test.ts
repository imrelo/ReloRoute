import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const require = createRequire(import.meta.url);
const { registerLocalAgent } = require("../../electron/lib/localAgent.js");

const origin = "http://localhost:20128";
const trustedUrl = origin + "/dashboard/playground";
const command = "echo RELO_TOOL_OK";

type Result = { ok: boolean; output: string };
type Execute = (command: string, cwd: string, signal: AbortSignal) => Promise<Result>;
type ApprovalOptions = {
  defaultId: number;
  cancelId: number;
  detail: string;
  signal: AbortSignal;
};

async function fixture(t: TestContext, execute?: Execute, platform = "win32") {
  const root = await mkdtemp(join(tmpdir(), "reloroute-local-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);

  const frame = { url: trustedUrl };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map<string, (ev: typeof event, input?: unknown) => unknown>();
  let instance: object | null = {};
  let approve = async (_options: ApprovalOptions) => ({ response: 0 });

  registerLocalAgent({
    ipcMain: {
      handle(name: string, handler: (ev: typeof event, input?: unknown) => unknown) {
        handlers.set(name, handler);
      },
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [workspace] }),
      showMessageBox: (_window: unknown, options: ApprovalOptions) => approve(options),
    },
    getMainWindow: () => window,
    getEmbeddedServer: () => (instance ? { origin, instance } : null),
    platform,
    execute,
  });

  return {
    contents,
    event,
    frame,
    workspace,
    outside,
    invoke: <T>(name: string, input?: unknown, sender = event) => {
      const handler = handlers.get("local-agent:" + name);
      assert.ok(handler, name);
      return Promise.resolve(handler(sender, input) as T);
    },
    setApproval: (next: typeof approve) => {
      approve = next;
    },
    setServer: (next: typeof instance) => {
      instance = next;
    },
  };
}

test("only the embedded Playground main frame can invoke Local Agent", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.invoke("available"), true);
  assert.equal(
    await f.invoke("available", undefined, { ...f.event, senderFrame: { url: trustedUrl } }),
    false
  );
  f.frame.url = "http://localhost:20129/dashboard/playground";
  assert.equal(await f.invoke("available"), false);
  f.frame.url = origin + "/dashboard/providers";
  assert.equal(await f.invoke("choose-workspace"), null);
  f.frame.url = trustedUrl;
  f.setServer(null);
  assert.equal(await f.invoke("available"), false);
  const linux = await fixture(t, undefined, "linux");
  assert.equal(await linux.invoke("available"), false);
});

test("workspace reads accept text files and reject paths or file types outside scope", async (t) => {
  const f = await fixture(t);
  const inside = join(f.workspace, "note.txt");
  await writeFile(inside, "inside workspace");
  await writeFile(
    join(f.workspace, "utf16.txt"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("chữ", "utf16le")])
  );
  await writeFile(join(f.workspace, "data.bin"), Buffer.from([0x00, 0xff]));
  await writeFile(join(f.workspace, "large.txt"), Buffer.alloc(64 * 1024 + 1, 0x61));
  await writeFile(join(f.outside, "private.txt"), "outside workspace");
  await symlink(f.outside, join(f.workspace, "escape"), "junction");

  assert.equal((await f.invoke<Result>("read-file", "note.txt")).ok, false);
  assert.equal(await f.invoke("choose-workspace"), await realpath(f.workspace));
  for (const file of ["note.txt", "./note.txt", inside]) {
    assert.deepEqual(await f.invoke("read-file", file), { ok: true, output: "inside workspace" });
  }
  assert.deepEqual(await f.invoke("read-file", "utf16.txt"), { ok: true, output: "chữ" });
  for (const file of [
    "../outside/private.txt",
    "escape/private.txt",
    join(f.outside, "private.txt"),
    "note.txt:secret",
    "CON.txt",
    "//host/share/private.txt",
    "data.bin",
    "large.txt",
  ]) {
    assert.equal((await f.invoke<Result>("read-file", file)).ok, false, file);
  }
});

test("Cancel is the default and a declined command never executes", async (t) => {
  let executions = 0;
  const f = await fixture(t, async () => {
    executions += 1;
    return { ok: true, output: "executed" };
  });
  const workspace = await f.invoke<string>("choose-workspace");
  f.setApproval(async (options) => {
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.ok(options.detail.includes(workspace));
    assert.ok(options.detail.includes(command));
    assert.match(options.detail, /Windows account permissions/);
    return { response: 0 };
  });
  assert.deepEqual(await f.invoke("run-command", command), {
    ok: false,
    output: "Command canceled.",
  });
  assert.equal(executions, 0);
});

test("leaving Playground, clearing workspace, or switching server revokes pending approval", async (t) => {
  for (const revoke of ["clear", "navigate", "restart"]) {
    await t.test(revoke, async (subtest) => {
      let executions = 0;
      const f = await fixture(subtest, async () => {
        executions += 1;
        return { ok: true, output: "executed" };
      });
      await f.invoke("choose-workspace");
      const shown = Promise.withResolvers<ApprovalOptions>();
      const answer = Promise.withResolvers<{ response: number }>();
      f.setApproval((options) => {
        shown.resolve(options);
        return answer.promise;
      });
      const pending = f.invoke<Result>("run-command", command);
      const options = await shown.promise;
      if (revoke === "clear") {
        await f.invoke("clear-workspace");
        assert.equal(options.signal.aborted, true);
      } else if (revoke === "navigate") {
        const destination = origin + "/dashboard/providers";
        f.contents.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: true,
          url: destination,
        });
        f.frame.url = destination;
        assert.equal(options.signal.aborted, true);
      } else {
        f.setServer({});
      }
      answer.resolve({ response: 1 });
      assert.equal((await pending).ok, false);
      assert.equal(executions, 0);
    });
  }
});

test(
  "approved command returns real Windows PowerShell output from the chosen workspace",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const f = await fixture(t);
    const workspace = await f.invoke<string>("choose-workspace");
    f.setApproval(async () => ({ response: 1 }));
    const echo = await f.invoke<Result>("run-command", command);
    assert.equal(echo.ok, true, echo.output);
    assert.equal(echo.output.trim(), "RELO_TOOL_OK");
    const cwd = await f.invoke<Result>("run-command", "(Get-Location).Path");
    assert.equal(cwd.ok, true, cwd.output);
    assert.equal(cwd.output.trim().toLowerCase(), workspace.toLowerCase());
  }
);
