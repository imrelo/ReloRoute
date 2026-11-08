"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");

const MAX_FILE_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const PLAYGROUND_PATH = /^\/dashboard\/playground\/?$/;
const LOCAL_DRIVE = /^[a-z]:[\\/]/i;

const filePathSchema = z.string().min(1).max(4096);
const commandSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      value.split(/\r?\n/).length <= 8 &&
      !/\r(?!\n)/.test(value) &&
      !/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)
  );

const failure = (output) => ({ ok: false, output });

function isPlaygroundUrl(url, origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && PLAYGROUND_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function resolveRequestedPath(root, input) {
  const normalized = input.replaceAll("\\", "/");
  const drivePath = LOCAL_DRIVE.test(normalized);
  // Chặn UNC, đường dẫn thiết bị, ADS và tên dành riêng của Windows.
  if (
    normalized.startsWith("//") ||
    (process.platform === "win32" && normalized.startsWith("/")) ||
    (drivePath && process.platform !== "win32")
  ) {
    return null;
  }
  const withoutRoot = drivePath ? normalized.slice(3) : normalized.replace(/^\//, "");
  const invalidSegment = withoutRoot
    .split("/")
    .some(
      (segment) =>
        segment !== "." &&
        (!segment ||
          /[<>:"|?*\x00-\x1f]/.test(segment) ||
          /[ .]$/.test(segment) ||
          /^(?:con(?:in\$|out\$)?|prn|aux|nul|clock\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(segment))
    );
  if (invalidSegment) return null;
  const candidate = path.resolve(root, normalized);
  return isInside(root, candidate) ? candidate : null;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveWorkspace(selected) {
  if (!path.isAbsolute(selected) || (process.platform === "win32" && !LOCAL_DRIVE.test(selected))) {
    return null;
  }
  const canonical = await fs.realpath(selected);
  if (process.platform === "win32" && !LOCAL_DRIVE.test(canonical)) return null;
  const info = await fs.stat(canonical, { bigint: true });
  return info.isDirectory() ? { path: canonical, info } : null;
}

async function isSameWorkspace(workspace) {
  const current = await resolveWorkspace(workspace.path);
  return current?.path === workspace.path && sameFile(current.info, workspace.info);
}

function decodeText(bytes) {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Binary file");
  return text;
}

async function readWorkspaceFile(workspace, input) {
  const parsed = filePathSchema.safeParse(input);
  if (!parsed.success) return failure("Provide a valid text file path.");
  const candidate = resolveRequestedPath(workspace.path, parsed.data);
  if (!candidate) return failure("Select a text file inside the workspace.");

  try {
    const resolved = await fs.realpath(candidate);
    if (!isInside(workspace.path, resolved) || !(await isSameWorkspace(workspace))) {
      return failure("Select a text file inside the workspace.");
    }
    const before = await fs.lstat(resolved, { bigint: true });
    if (!before.isFile() || before.size > MAX_FILE_BYTES) {
      return failure("Choose a regular text file no larger than 64 KiB.");
    }

    const file = await fs.open(resolved, "r");
    try {
      // Đối chiếu file đã mở với file đã kiểm tra để phát hiện thay đường dẫn.
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(before, opened) || opened.size > MAX_FILE_BYTES) {
        return failure("The selected file changed while it was being opened.");
      }
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) return failure("Choose a text file no larger than 64 KiB.");
      const current = await fs.realpath(candidate);
      if (
        current !== resolved ||
        !sameFile(opened, await fs.lstat(resolved, { bigint: true })) ||
        !(await isSameWorkspace(workspace))
      ) {
        return failure("The selected file changed while it was being read.");
      }
      return { ok: true, output: decodeText(bytes.subarray(0, length)) };
    } finally {
      await file.close();
    }
  } catch {
    return failure("The selected file could not be read as text.");
  }
}

function runPowerShell(command, cwd, signal) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !LOCAL_DRIVE.test(systemRoot)) {
    return Promise.resolve(failure("Windows PowerShell is unavailable."));
  }
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  // Truyền nguyên văn lệnh đã duyệt bằng argv; không ghép với đường dẫn hay lệnh khác.
  return new Promise((resolve) => {
    execFile(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd,
        signal,
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_COMMAND_OUTPUT,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").slice(0, MAX_COMMAND_OUTPUT);
        if (!error) return resolve({ ok: true, output });
        if (signal.aborted) return resolve(failure("Command canceled."));
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve(failure("Command exceeded the 64 KiB output limit."));
        }
        if (error.killed) return resolve(failure("Command exceeded the 30 second time limit."));
        if (typeof error.code === "number") {
          return resolve(
            failure(["PowerShell exited with code " + error.code + ".", output].join("\n"))
          );
        }
        resolve(failure("Windows PowerShell could not start."));
      }
    );
  });
}

function registerLocalAgent({
  ipcMain,
  dialog,
  getMainWindow,
  getEmbeddedServer,
  platform = process.platform,
  execute = runPowerShell,
}) {
  const states = new WeakMap();

  function trustedWindow(event) {
    const window = getMainWindow();
    const server = getEmbeddedServer();
    if (
      platform !== "win32" ||
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame ||
      !server ||
      !isPlaygroundUrl(event.senderFrame.url, server.origin)
    ) {
      return null;
    }
    return { window, instance: server.instance };
  }

  function stillTrusted(event, trusted) {
    const current = trustedWindow(event);
    return current?.window === trusted.window && current.instance === trusted.instance;
  }

  function clear(state) {
    state.workspace = null;
    state.revision += 1;
    state.command?.abort();
  }

  function getState(contents, instance) {
    let state = states.get(contents);
    if (!state) {
      state = { instance, workspace: null, revision: 0, busy: false, command: null };
      states.set(contents, state);
      contents.on("did-start-navigation", (details) => {
        if (
          details.isMainFrame &&
          (!details.isSameDocument || !isPlaygroundUrl(details.url, getEmbeddedServer()?.origin))
        ) {
          clear(state);
        }
      });
      contents.on("render-process-gone", () => clear(state));
      contents.once("destroyed", () => clear(state));
    } else if (state.instance !== instance) {
      clear(state);
      state.instance = instance;
    }
    return state;
  }

  ipcMain.handle("local-agent:available", (event) => Boolean(trustedWindow(event)));

  ipcMain.handle("local-agent:choose-workspace", async (event) => {
    const trusted = trustedWindow(event);
    if (!trusted) return null;
    const state = getState(event.sender, trusted.instance);
    if (state.busy) return null;
    const revision = state.revision;
    state.busy = true;
    try {
      const selection = await dialog.showOpenDialog(trusted.window, {
        title: "Choose Local Agent workspace",
        properties: ["openDirectory", "dontAddToRecent"],
      });
      if (selection.canceled || selection.filePaths.length !== 1) return null;
      const workspace = await resolveWorkspace(selection.filePaths[0]);
      if (!workspace || state.revision !== revision || !stillTrusted(event, trusted)) return null;
      clear(state);
      state.workspace = workspace;
      return workspace.path;
    } catch {
      return null;
    } finally {
      state.busy = false;
    }
  });

  ipcMain.handle("local-agent:clear-workspace", (event) => {
    const trusted = trustedWindow(event);
    if (trusted) clear(getState(event.sender, trusted.instance));
  });

  ipcMain.handle("local-agent:read-file", async (event, filePath) => {
    const trusted = trustedWindow(event);
    if (!trusted) return failure("Local Agent is unavailable in this window.");
    const state = getState(event.sender, trusted.instance);
    const workspace = state.workspace;
    if (!workspace) return failure("Choose a workspace first.");
    const result = await readWorkspaceFile(workspace, filePath);
    if (state.workspace !== workspace || !stillTrusted(event, trusted)) {
      return failure("Workspace access ended.");
    }
    return result;
  });

  ipcMain.handle("local-agent:run-command", async (event, input) => {
    const trusted = trustedWindow(event);
    if (!trusted) return failure("Local Agent is unavailable in this window.");
    const state = getState(event.sender, trusted.instance);
    const workspace = state.workspace;
    if (!workspace) return failure("Choose a workspace first.");
    if (state.busy) return failure("Another Local Agent action is in progress.");

    const parsed = commandSchema.safeParse(input);
    if (!parsed.success)
      return failure("Provide a PowerShell command of at most 1,024 characters and eight lines.");
    const command = parsed.data;
    const controller = new AbortController();
    state.command = controller;
    state.busy = true;
    try {
      if (!(await isSameWorkspace(workspace)))
        return failure("The workspace is no longer available.");
      if (state.workspace !== workspace || !stillTrusted(event, trusted)) {
        return failure("Workspace access ended.");
      }
      const approval = await dialog.showMessageBox(trusted.window, {
        title: "ReloRoute Local Agent",
        type: "warning",
        message: "Run this PowerShell command?",
        detail:
          "Workspace:\n" +
          workspace.path +
          "\n\nCommand:\n" +
          command +
          "\n\nThis runs with your Windows account permissions. The result is sent to the selected model.",
        buttons: ["Cancel", "Run command"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal,
      });
      if (approval.response !== 1) return failure("Command canceled.");
      if (!(await isSameWorkspace(workspace)))
        return failure("The workspace is no longer available.");
      if (state.workspace !== workspace || !stillTrusted(event, trusted)) {
        return failure("Workspace access ended.");
      }
      const result = await execute(command, workspace.path, controller.signal);
      if (state.workspace !== workspace || !stillTrusted(event, trusted)) {
        return failure("Workspace access ended.");
      }
      return result;
    } catch {
      return failure("The PowerShell command could not run.");
    } finally {
      state.command = null;
      state.busy = false;
    }
  });
}

module.exports = { registerLocalAgent };
