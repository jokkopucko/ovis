import { mkdirSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { createServer as createSocketServer, connect } from "node:net";
import { join } from "node:path";

const home = process.env["HOME"] ?? "/home/node";
const socket = join(home, ".config/herdr/herdr.sock");
process.env["HERDR_SOCKET"] = socket;
process.env["PATH"] = "/opt/ovis/bin:/usr/local/bin:/usr/bin:/bin";
mkdirSync(join(home, ".config/herdr"), { recursive: true });
const daemon = Bun.spawn(["/usr/local/bin/herdr", "server"], { cwd: "/workspace", stdin: "ignore", stdout: "inherit", stderr: "inherit" });
void daemon.exited.then(code => process.exit(code || 1));
for (let n = 0; n < 100 && !existsSync(socket); n++) await Bun.sleep(50);
if (!existsSync(socket)) throw Error("Isolated herdr did not start");
const run = async (args: string[]) => {
  const child = Bun.spawn(["/usr/local/bin/herdr", ...args], { cwd: "/workspace", stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw Error("Isolated workspace setup failed: " + await new Response(child.stderr).text());
  return JSON.parse(await new Response(child.stdout).text());
};
const listed = await run(["workspace", "list"]);
const workspaces = listed.result?.workspaces ?? [];
if (workspaces.length === 0) await run(["workspace", "create", "--cwd", "/workspace", "--label", "music-classifier", "--focus"]);
else if (workspaces.length === 1) await run(["workspace", "rename", workspaces[0].workspace_id, "music-classifier"]);
else throw Error("The shared instance contains unexpected workspaces");
const runtime = "/opt/ovis";
const { createServer } = await import(runtime + "/server/index.ts");
const ovis = createServer({ port: 7317, hostname: "127.0.0.1", token: process.env["OVIS_TOKEN"], stateDir: join(home, ".config/ovis") });
const endpoint = "/run/ovis-share/ovis.sock";
if (existsSync(endpoint)) unlinkSync(endpoint);
const relay = createSocketServer(client => {
  const backend = connect({ host: "127.0.0.1", port: ovis.port });
  client.pipe(backend).pipe(client);
  client.on("error", () => backend.destroy()); backend.on("error", () => client.destroy());
  client.on("close", () => backend.destroy()); backend.on("close", () => client.destroy());
});
relay.listen(endpoint, () => { chmodSync(endpoint, 0o600); console.log("Isolated music-classifier workspace ready"); });
process.on("SIGTERM", () => { relay.close(); ovis.stop(); daemon.kill(); setTimeout(() => process.exit(0), 1000); });
