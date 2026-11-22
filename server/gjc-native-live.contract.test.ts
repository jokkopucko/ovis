import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { GJC_NATIVE_DIRECTORY, type GjcNativeBinding } from "../shared/gjc-native.ts";
import { ConversationUnavailable, forgetTranscriptState, gjcTranscriptPath, transcriptPage } from "./conversation.ts";
import { herdrRpc, herdrSocketPath, paneRead, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { processStartedAt } from "./process-start.ts";

const TEST_BIN = process.env["HERDR_GJC_NATIVE_TEST_BIN"];
const SUPPORTED_PLATFORM = process.platform === "linux";
const TEST_TIMEOUT_MS = 90_000;
const PROCESS_STOP_TIMEOUT_MS = 3_000;

type JsonRecord = Record<string, unknown>;
type PaneProcess = { pid?: unknown; argv?: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function until<T>(deadline: number, read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(100);
  }
  const detail = last instanceof Error ? `: ${last.message}`
    : isRecord(last) && typeof last.text === "string" ? `\nIsolated TUI: ${last.text}` : "";
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function foregroundGjcPid(paneId: string, socketPath: string): Promise<number | null> {
  const response = await herdrRpc<{ process_info?: { foreground_processes?: PaneProcess[] } }>(
    "pane.process_info", { pane_id: paneId }, socketPath, 2_000,
  );
  const matches = (response.process_info?.foreground_processes ?? []).filter((process) => {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    return typeof process.pid === "number" && isGjcProcess(argv);
  });
  return matches.length === 1 ? matches[0]!.pid as number : null;
}

function bindingPath(home: string, pid: number): string {
  return join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY, `${pid}.json`);
}

function readBinding(home: string, pid: number): GjcNativeBinding | null {
  try {
    const value: unknown = JSON.parse(readFileSync(bindingPath(home, pid), "utf8"));
    return isRecord(value) ? value as unknown as GjcNativeBinding : null;
  } catch {
    return null;
  }
}

function hasNativeHeader(path: string, sessionId: string, cwd: string): boolean {
  try {
    const header: unknown = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]!);
    return isRecord(header) && header.type === "session" && header.version === 3
      && header.id === sessionId && header.cwd === cwd && typeof header.timestamp === "string";
  } catch {
    return false;
  }
}

function transcriptRecords(sessionId: string, cwd: string, title: string, timestamp: string): string {
  const userId = randomUUID();
  const assistantId = randomUUID();
  return [
    { type: "session", version: 3, id: sessionId, timestamp, cwd, title },
    {
      type: "message", id: userId, parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "Answer with one short word: what is the result?" }] },
    },
    {
      type: "message", id: assistantId, parentId: userId, timestamp,
      message: {
        role: "assistant", content: [{ type: "text", text: "OK" }],
        stopReason: "stop", model: "openai/gpt-4.1", provider: "openai",
      },
    },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function launchLine(binary: string, path: string, home: string, configHome: string, stateHome: string, cacheHome: string, tmpHome: string, resume?: string): string {
  const args = [
    shellQuote(binary),
    "--no-lsp", "--no-mcp", "--no-title", "--no-pty",
    "--model", shellQuote("openai/gpt-4.1"),
    "--api-key", shellQuote("test-only-no-model-requests"),
    ...(resume === undefined ? [] : ["--resume", shellQuote(resume)]),
  ];
  return [
    "/usr/bin/env -i",
    `HOME=${shellQuote(home)}`,
    `PATH=${shellQuote(path)}`,
    `TERM=${shellQuote("xterm-256color")}`,
    `LANG=${shellQuote("C.UTF-8")}`,
    `TMPDIR=${shellQuote(tmpHome)}`,
    `XDG_CONFIG_HOME=${shellQuote(configHome)}`,
    `XDG_STATE_HOME=${shellQuote(stateHome)}`,
    `XDG_CACHE_HOME=${shellQuote(cacheHome)}`,
    ...args,
  ].join(" ") + "\n";
}

async function installBundledExtension(agentDir: string): Promise<string> {
  const extensionDir = join(agentDir, "extensions");
  mkdirSync(extensionDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "integrations", "gjc.ts")],
    target: "bun",
    format: "esm",
    splitting: false,
  });
  if (!result.success) throw new Error(`Could not bundle native GJC extension: ${result.logs.map((entry) => entry.message).join("\n")}`);
  const output = result.outputs[0];
  if (!output) throw new Error("Native GJC extension build produced no output");
  const path = join(extensionDir, "herdr-web-ui.js");
  writeFileSync(path, `${await output.text()}\n`, { mode: 0o600 });
  return path;
}

function ownedProcesses(home: string): number[] {
  const marker = `HOME=${home}`;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    throw new Error(`Cannot inspect Linux process environment for isolated GJC cleanup: ${String(error)}`);
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environment.split("\0").includes(marker)) pids.push(pid);
    } catch {
      // Exited processes and processes owned by another user are not candidates.
    }
  }
  return pids;
}

async function stopOwnedProcesses(home: string): Promise<void> {
  const signal = (pids: number[], value: NodeJS.Signals) => {
    for (const pid of pids) {
      try { process.kill(pid, value); } catch { }
    }
  };
  const waitGone = async (deadline: number): Promise<number[]> => {
    let live = ownedProcesses(home);
    while (live.length > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
      live = ownedProcesses(home);
    }
    return live;
  };

  signal(ownedProcesses(home), "SIGTERM");
  let live = await waitGone(Date.now() + PROCESS_STOP_TIMEOUT_MS);
  if (live.length > 0) {
    signal(live, "SIGKILL");
    live = await waitGone(Date.now() + PROCESS_STOP_TIMEOUT_MS);
  }
  if (live.length > 0) throw new Error(`Isolated GJC processes survived cleanup: ${live.join(",")}`);
}

it.skipIf(!TEST_BIN || !SUPPORTED_PLATFORM)(
  "resolves fresh, resumed, and /new GJC sessions through the native extension without model requests (opt-in: HERDR_GJC_NATIVE_TEST_BIN; Linux /proc)",
  async () => {
    if (!TEST_BIN) throw new Error("HERDR_GJC_NATIVE_TEST_BIN must be an absolute executable path");
    if (!SUPPORTED_PLATFORM) throw new Error("The live native GJC contract test currently requires Linux /proc cleanup");

    const socketPath = herdrSocketPath();
    const systemPath = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
    const envSnapshot: NodeJS.ProcessEnv = { ...process.env };
    const suppliedBin = TEST_BIN;
    let root: string | null = null;
    let home = "";
    let workspaceIds: string[] = [];
    let environmentWasReplaced = false;
    let isolatedChildrenGone = true;
    let failed = false;

    try {
      expect(isAbsolute(suppliedBin)).toBe(true);
      accessSync(suppliedBin, constants.X_OK);
      const binary = realpathSync(suppliedBin);
      expect(statSync(binary).isFile()).toBe(true);

      root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-test-gjc-native-live-")));
      home = join(root, "home");
      const cwd = join(root, "project");
      const configHome = join(home, ".config");
      const stateHome = join(home, ".local", "state");
      const cacheHome = join(home, ".cache");
      const agentDir = join(home, ".gjc", "agent");
      const tmpHome = join(root, "tmp");
      for (const directory of [home, cwd, configHome, stateHome, cacheHome, agentDir, tmpHome]) {
        mkdirSync(directory, { recursive: true });
      }
      await installBundledExtension(agentDir);
      const isolatedPath = systemPath;

      environmentWasReplaced = true;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        HOME: home,
        PATH: isolatedPath,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        TMPDIR: tmpHome,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_CACHE_HOME: cacheHome,
        HERDR_SOCKET: socketPath,
      });

      const startPane = async (label: string, resume?: string): Promise<{ workspaceId: string; paneId: string }> => {
        const created = await workspaceCreate({ cwd, label: `ovis-test-gjc-native-live-${label}` }, socketPath);
        workspaceIds.push(created.workspace.workspace_id);
        await herdrRpc("pane.send_text", {
          pane_id: created.root_pane.pane_id,
          text: launchLine(binary, isolatedPath, home, configHome, stateHome, cacheHome, tmpHome, resume),
        }, socketPath, 3_000);
        return { workspaceId: created.workspace.workspace_id, paneId: created.root_pane.pane_id };
      };

      const waitForBinding = async (paneId: string): Promise<{ pid: number; processStartedAt: number; binding: GjcNativeBinding }> => {
        const result = await until(
          Date.now() + 30_000,
          async () => {
            const pid = await foregroundGjcPid(paneId, socketPath);
            if (pid === null) return null;
            const startedAt = processStartedAt(pid);
            const binding = readBinding(home, pid);
            if (startedAt === null || !binding?.session) return null;
            return { pid, processStartedAt: startedAt, binding };
          },
          (value) => value !== null,
          "the native extension binding for the foreground GJC process",
        );
        if (result === null) throw new Error("The native extension binding disappeared after its bounded poll");
        return result;
      };

      const bootstrap = await startPane("bootstrap");
      const first = await waitForBinding(bootstrap.paneId);
      const firstSession = first.binding.session;
      if (!firstSession) throw new Error("Fresh GJC process did not publish a session");
      expect(first.binding).toMatchObject({ version: 1, pid: first.pid, processStartedAt: first.processStartedAt });
      expect(Object.keys(first.binding).sort()).toEqual(["instanceId", "pid", "processStartedAt", "sequence", "session", "updatedAt", "version"]);
      expect(Object.keys(firstSession).sort()).toEqual(["cwd", "id", "path"]);
      expect(firstSession.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(firstSession.cwd).toBe(cwd);
      expect(isAbsolute(firstSession.path)).toBe(true);
      const sessionsRoot = join(agentDir, "sessions");
      const relativeSessionPath = relative(sessionsRoot, firstSession.path);
      expect(relativeSessionPath).not.toBe("");
      expect(isAbsolute(relativeSessionPath)).toBe(false);
      expect(relativeSessionPath.split(sep)).toHaveLength(2);

      const firstHeader = hasNativeHeader(firstSession.path, firstSession.id, cwd);
      let firstResolved: string | null = null;
      try { firstResolved = await gjcTranscriptPath(bootstrap.paneId, cwd, home); }
      catch (error) { if (!(error instanceof ConversationUnavailable)) throw error; }
      if (!hasNativeHeader(firstSession.path, firstSession.id, cwd)) expect(firstResolved).toBeNull();
      if (firstHeader) expect(firstResolved).toBe(firstSession.path);

      await workspaceClose(bootstrap.workspaceId, socketPath);
      workspaceIds = workspaceIds.filter((id) => id !== bootstrap.workspaceId);
      await until(
        Date.now() + 5_000,
        async () => { try { process.kill(first.pid, 0); return true; } catch { return false; } },
        (alive) => !alive,
        "the fresh GJC process to exit after its isolated workspace closes",
      );

      const fixtureTimestamp = new Date().toISOString();
      const fixturePath = firstSession.path;
      mkdirSync(join(fixturePath, ".."), { recursive: true });
      writeFileSync(fixturePath, transcriptRecords(firstSession.id, cwd, "Native GJC identity fixture", fixtureTimestamp));
      expect(hasNativeHeader(fixturePath, firstSession.id, cwd)).toBe(true);

      const resumedPane = await startPane("resume", fixturePath);
      const resumed = await waitForBinding(resumedPane.paneId);
      expect(resumed.binding.session).toEqual({ id: firstSession.id, path: fixturePath, cwd });
      expect(resumed.binding.processStartedAt).toBe(resumed.processStartedAt);
      expect(await until(
        Date.now() + 10_000,
        async () => {
          try { return await gjcTranscriptPath(resumedPane.paneId, cwd, home); }
          catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
        },
        (path) => path === fixturePath,
        "the resumed GJC process to finish startup",
      )).toBe(fixturePath);
      const conversation = transcriptPage("gjc-transcript", fixturePath);
      expect(conversation.source).toBe("gjc-transcript");
      expect(conversation.turns.find((turn) => turn.role === "assistant")?.parts).toContainEqual({ kind: "text", text: "OK", phase: "final_answer" });

      // Onboarding can appear after the first editor frame. Only retry the fixture's
      // slash command when an observed menu intercepted it, never on a timer alone.
      let commandSent = false;
      let dismissedMenu: string | undefined;
      const next = await until(
        Date.now() + 20_000,
        async () => {
          const binding = readBinding(home, resumed.pid);
          if (binding?.session && binding.session.id !== firstSession.id) return binding;
          const screen = await paneRead({ paneId: resumedPane.paneId, source: "visible", lines: 100 }, socketPath);
          const menu = ["Choose your interface language", "Frictionless onboarding"].find((title) => screen.text.includes(title));
          if (menu) {
            commandSent = false;
            if (dismissedMenu !== menu) {
              await herdrRpc("pane.send_keys", { pane_id: resumedPane.paneId, keys: ["Escape"] }, socketPath);
              dismissedMenu = menu;
            }
          } else {
            dismissedMenu = undefined;
            if (!commandSent && screen.text.includes("Type your message")) {
              await herdrRpc("pane.send_keys", { pane_id: resumedPane.paneId, keys: ["ctrl+k", "ctrl+u"] }, socketPath);
              await herdrRpc("pane.send_text", { pane_id: resumedPane.paneId, text: "/new" }, socketPath);
              await herdrRpc("pane.send_keys", { pane_id: resumedPane.paneId, keys: ["Enter"] }, socketPath);
              commandSent = true;
            }
          }
          return null;
        },
        (binding) => binding !== null,
        "the real GJC /new command to publish a different native session",
      ).catch(async (error) => {
        const screen = await paneRead({ paneId: resumedPane.paneId, source: "visible", lines: 100 }, socketPath);
        throw new Error(`${String(error)}\nIsolated native binding: ${JSON.stringify(readBinding(home, resumed.pid))}\nIsolated TUI: ${screen.text}`);
      });
      if (next === null) throw new Error("The /new native session disappeared after its bounded poll");
      expect(next.pid).toBe(resumed.pid);
      expect(next.processStartedAt).toBe(resumed.processStartedAt);
      expect(next.instanceId).toBe(resumed.binding.instanceId);
      expect(next.sequence).toBeGreaterThan(resumed.binding.sequence);
      const nextSession = next.session;
      if (!nextSession) throw new Error("New GJC session disappeared from its native record");
      expect(nextSession.id).not.toBe(firstSession.id);
      expect(nextSession.path).not.toBe(fixturePath);
      expect(nextSession.cwd).toBe(cwd);

      let newPath: string | null = null;
      try { newPath = await gjcTranscriptPath(resumedPane.paneId, cwd, home); }
      catch (error) { if (!(error instanceof ConversationUnavailable)) throw error; }
      const newHeaderReady = hasNativeHeader(nextSession.path, nextSession.id, cwd);
      if (!newHeaderReady) expect(newPath).toBeNull();
      if (newPath === null && !newHeaderReady) {
        mkdirSync(join(nextSession.path, ".."), { recursive: true });
        writeFileSync(nextSession.path, transcriptRecords(nextSession.id, cwd, "Native GJC /new fixture", new Date().toISOString()));
      }
      expect(hasNativeHeader(nextSession.path, nextSession.id, cwd)).toBe(true);
      const resolvedNewPath = await until(
        Date.now() + 10_000,
        async () => {
          try { return await gjcTranscriptPath(resumedPane.paneId, cwd, home); }
          catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
        },
        (path) => path === nextSession.path,
        "the new session binding after the GJC transition settles",
      ).catch(async (error) => {
        const processInfo = await herdrRpc("pane.process_info", { pane_id: resumedPane.paneId }, socketPath);
        throw new Error(`${String(error)}\nIsolated native binding: ${JSON.stringify(readBinding(home, resumed.pid))}\nIsolated processes: ${JSON.stringify(processInfo)}`);
      });
      expect(resolvedNewPath).toBe(nextSession.path);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      for (const workspaceId of [...workspaceIds].reverse()) {
        try { await workspaceClose(workspaceId, socketPath); }
        catch (error) {
          isolatedChildrenGone = false;
          cleanupErrors.push(`workspace ${workspaceId}: ${String(error)}`);
        }
      }
      if (home !== "") {
        try { await stopOwnedProcesses(home); }
        catch (error) {
          isolatedChildrenGone = false;
          cleanupErrors.push(String(error));
        }
      }
      if (environmentWasReplaced) {
        for (const key of Object.keys(process.env)) delete process.env[key];
        for (const [key, value] of Object.entries(envSnapshot)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
      forgetTranscriptState();
      if (root !== null && isolatedChildrenGone) rmSync(root, { recursive: true, force: true });
      if (cleanupErrors.length > 0) {
        const message = `Native GJC live-test cleanup failed: ${cleanupErrors.join("; ")}`;
        if (failed) console.error(message);
        else throw new Error(message);
      }
    }
  },
  TEST_TIMEOUT_MS,
);
