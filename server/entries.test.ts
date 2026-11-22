import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as listen } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assetsRoot, COMPILED, ENTRIES, entryCommand, ROOT, serverRoot, type EntryName } from "./entries.ts";
import { launcherAction } from "./windows-herdr-start.ts";

const root = join(import.meta.dir, "..");

async function main(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env["OVIS_HC_MACHINE"];
  delete env["OVIS_HC_MACHINE_STATE"];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("server entries", () => {
  it("starts each entry from its own file when run from source", () => {
    expect(COMPILED).toBe(false);
    expect(ROOT).toBe(root);
    for (const name of Object.keys(ENTRIES) as EntryName[]) {
      const [runtime, file] = entryCommand(name);
      expect(runtime).toBe(process.execPath);
      expect(file).toBe(join(root, ENTRIES[name]));
      expect(existsSync(file)).toBe(true);
    }
    expect(entryCommand("serve", "/elsewhere")[1]).toBe(join("/elsewhere", "server", "index.ts"));
  });

  it("refuses an unknown entry with exit 2, naming every entry", async () => {
    const { code, stderr } = await main(["nosuch"]);
    expect(code).toBe(2);
    for (const name of Object.keys(ENTRIES)) expect(stderr).toContain(name);
    expect((await main([])).code).toBe(2);
  });

  it("runs the named entry, which refuses a machine start nothing asked for", async () => {
    const { code, stderr } = await main(["machine"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("machine-entry.ts runs only as machine-bridge.ts starts it");
  });

  it("keeps the supervisor's own code to what it runs: no other entry's", () => {
    // an update copies and runs a release's supervisor by what it imports (the updater tests' copySupervisor); a table
    // that imported every entry would pull the whole server, package.json included, into the supervisor
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const reached = [join(import.meta.dir, "supervisor.ts")];
    for (const file of reached) {
      for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
        const imported = join(dirname(file), path);
        if (path.startsWith(".") && !reached.includes(imported)) reached.push(imported);
      }
    }
    const names = reached.map((file) => file.slice(root.length + 1));
    expect(names).toContain("server/entries.ts");
    expect(names.filter((file) => !/\.(ts|mjs|js)$/.test(file))).toEqual([]);
    for (const entry of ["server/index.ts", "server/managed.ts", "server/remote-entry.ts", "scripts/plugin.ts"]) expect(names).not.toContain(entry);
  });

  it("starts each entry by its name in the compiled binary, never by a file", () => {
    for (const name of Object.keys(ENTRIES) as EntryName[]) expect(entryCommand(name, "/elsewhere", true)).toEqual([process.execPath, name]);
  });

  it("serves every entry the installers, bundles and Windows task name", () => {
    expect(Object.keys(ENTRIES).sort()).toEqual(["askpass", "browser-mcp", "machine", "managed", "plugin", "remote", "serve", "supervisor", "windows-launch"]);
  });

  it("roots the server in its checkout from source and in the binary's folder when compiled", () => {
    expect(serverRoot(false)).toBe(root);
    expect(serverRoot(true)).toBe(dirname(process.execPath));
    expect(assetsRoot({}, "/server")).toBe("/server");
    expect(assetsRoot({ OVIS_ASSETS: "/assets" }, "/server")).toBe("/assets");
    expect(assetsRoot({ OVIS_ASSETS: "" }, "/server")).toBe("/server");
  });

  it("serves dist/ from OVIS_ASSETS when it is set", async () => {
    const assets = mkdtempSync(join(tmpdir(), "ovis-assets-"));
    try {
      mkdirSync(join(assets, "dist"));
      writeFileSync(join(assets, "dist", "index.html"), "<html>assets fixture</html>");
      const probe = `const { serveStatic } = await import(${JSON.stringify(join(import.meta.dir, "static.ts"))});
        const answer = await serveStatic("/");
        process.stdout.write(await answer.text());`;
      const child = Bun.spawn([process.execPath, "-e", probe], { env: { ...process.env, OVIS_ASSETS: assets }, stdout: "pipe", stderr: "inherit" });
      expect(await new Response(child.stdout).text()).toContain("assets fixture");
      expect(await child.exited).toBe(0);
    } finally { rmSync(assets, { recursive: true, force: true }); }
  });

  it("hands an entry the arguments after its name, where it reads them from source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-entry-argv-"));
    const socket = join(dir, "ask.sock");
    const asked = Promise.withResolvers<string>();
    const server = listen((connection) => {
      let text = "";
      connection.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        asked.resolve((JSON.parse(text) as { prompt: string }).prompt);
        connection.end(JSON.stringify({ answer: "fixture answer" }) + "\n");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      const { code, stdout } = await main(["askpass", "Password for fixture:"], { HERDR_ASKPASS_SOCKET: socket, HERDR_ASKPASS_TOKEN: "t" });
      expect(await asked.promise).toBe("Password for fixture:");
      expect(stdout).toBe("fixture answer\n");
      expect(code).toBe(0);
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs the Windows desktop launcher file the scheduled task names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-windows-launch-"));
    try {
      writeFileSync(join(dir, "launch.json"), JSON.stringify({ said: "launched" }));
      writeFileSync(join(dir, "start.ts"), `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
process.stdout.write(JSON.parse(readFileSync(fileURLToPath(new URL("./launch.json", import.meta.url)), "utf8")).said);`);
      const { code, stdout } = await main(["windows-launch", join(dir, "start.ts")]);
      expect([code, stdout]).toEqual([0, "launched"]);
      expect((await main(["windows-launch"])).code).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("names the Windows task's program as from source, and the launcher entry only when compiled", () => {
    expect(launcherAction(false)).toEqual({ bun: process.execPath });
    expect(launcherAction(true)).toEqual({ bun: process.execPath, prefix: "windows-launch " });
  });
});
