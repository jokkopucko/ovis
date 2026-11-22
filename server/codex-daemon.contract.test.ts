import { afterAll, beforeAll, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";

// Real herdr panes running a stand-in `codex` with a CODEX_HOME of its own, and a fake Codex daemon on
// each home's control socket: the catalog asks the daemon of the pane's own home, never the server's.
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-codex-daemon-contract-")));
const homes = { pane: join(root, "pane-home"), server: join(root, "server-home") };
const daemons: { stop(force: boolean): void }[] = [];
const asked = { pane: 0, server: 0 };
const workspaces: string[] = [];
const previousHome = process.env["CODEX_HOME"];
let server: ReturnType<typeof createServer>;

function daemon(home: string, which: keyof typeof asked, skills: () => unknown[]): void {
  mkdirSync(join(home, "app-server-control"), { recursive: true });
  daemons.push(Bun.serve({
    unix: join(home, "app-server-control", "app-server-control.sock"),
    fetch(request, bun) { return bun.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as { id?: number; method: string; params?: { cwds?: string[] } };
        if (message.id === undefined) return;
        if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "codex_cli_rs/0.163.0 (Linux)" } }));
        else if (message.method === "skills/list") {
          asked[which]++;
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ cwd: message.params?.cwds?.[0], skills: skills(), errors: [] }] } }));
        }
      },
    },
  }));
}

const skill = (name: string, enabled = true) => ({ name, description: `About ${name}`, path: `/s/${name}/SKILL.md`, scope: "user", enabled });
let paneSkills: unknown = [skill("from-pane-home")];

const codexRunning = async (paneId: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
    const found = (info.process_info?.foreground_processes ?? []).some((foreground) => {
      let argv = foreground.argv ?? [];
      if (argv.length === 0 && process.platform === "linux") {
        try { argv = readFileSync(`/proc/${foreground.pid}/cmdline`, "utf8").split("\0"); } catch { return false; }
      }
      return argv.includes(join(root, "bin", "codex"));
    });
    if (found) return;
    await Bun.sleep(100);
  }
  throw new Error(`no codex process in ${paneId}`);
};

const commands = async (paneId: string) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return (await response.json() as { commands: { name: string; source: string; provenance?: { transport: string } }[] }).commands;
};

let paneId: string;
// the pane's Codex home is read from /proc: Linux only (elsewhere a pane without a configured home gets no native rows)
const linux = process.platform === "linux";
beforeAll(async () => {
  if (!linux) return;
  daemon(homes.pane, "pane", () => paneSkills as unknown[]);
  daemon(homes.server, "server", () => [skill("from-server-home")]);
  process.env["CODEX_HOME"] = homes.server;
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work", ".codex", "skills", "scanned-one"), { recursive: true });
  writeFileSync(join(root, "work", ".codex", "skills", "scanned-one", "SKILL.md"), "---\nname: scanned-one\ndescription: A project skill\n---\nUse it.\n");
  writeFileSync(join(root, "bin", "codex"), "#!/bin/sh\nsleep 600\n");
  chmodSync(join(root, "bin", "codex"), 0o755);
  const created = await workspaceCreate({ cwd: join(root, "work"), label: "ovis-test-codex-daemon-home" });
  workspaces.push(created.workspace.workspace_id);
  paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `CODEX_HOME=${homes.pane} ${join(root, "bin", "codex")}\n` });
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle" });
  await codexRunning(paneId);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
});

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  for (const fake of daemons) fake.stop(true);
  if (previousHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = previousHome;
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("lists the skills of the daemon under the pane's own CODEX_HOME, never the server's", async () => {
  const native = (await commands(paneId)).filter((row) => row.provenance?.transport === "native").map((row) => row.name);
  expect(native).toEqual(["from-pane-home"]);
  expect(asked.server).toBe(0);
});

it.skipIf(process.platform !== "linux")("drops the scanned skills when the pane's daemon answers that none is enabled, and keeps them without an answer", async () => {
  const skills = async () => (await commands(paneId)).filter((row) => row.source === "skill").map((row) => [row.name, row.provenance?.transport]);
  paneSkills = "not a list";
  server.stop();
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-2") });
  expect(await skills()).toContainEqual(["scanned-one", "scan"]);
  paneSkills = [skill("off", false)];
  server.stop();
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-3") });
  expect(await skills()).toEqual([]);
});
