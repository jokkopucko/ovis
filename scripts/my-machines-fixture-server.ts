/**
 * Builds the "My machines" fixture page (scripts/my-machines-fixture.tsx) and serves it, for
 * scripts/my-machines-screens-qa.ts and for a look by hand:
 *
 *   PORT=17431 bun scripts/my-machines-fixture-server.ts
 *
 * prints an address for every screen and serves until it is stopped (HOST picks the address it
 * binds to; loopback unless set). It serves the page, its bundle assets and the app's icons:
 * no /api and no /ws, so the screens cannot reach a session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>My machines</title><link rel="stylesheet" href="/my-machines-fixture.css"></head><body><div id="root"></div><script type="module" src="/my-machines-fixture.js"></script></body></html>';

/** The fixture page's query for each screen a person may want to open. */
export const FIXTURE_SCREENS: Readonly<Record<string, string>> = {
  "My machines": "account=mixed",
  "My machines, none yet": "account=empty",
  "My machines, twenty": "account=twenty",
  "My machines, on a device whose copy is behind": "account=behind",
  "My machines, joining": "account=joining",
  "My machines, needs an update": "account=needs-update",
  "My machines, today's source": "account=today",
};

export interface FixtureServer {
  readonly origin: string;
  stop(): Promise<void>;
}

export async function startFixtureServer(port = 0, hostname = "127.0.0.1"): Promise<FixtureServer> {
  const root = mkdtempSync(join(tmpdir(), "ovis-my-machines-"));
  // a build or a bind that fails leaves no bundle behind; once serving, stop() removes it
  let server: ReturnType<typeof Bun.serve>;
  try {
    const build = await Bun.build({ entrypoints: [join(repo, "scripts/my-machines-fixture.tsx")], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(`the fixture page did not build:\n${build.logs.map(String).join("\n")}`);
    const assets = new Map(build.outputs.map((output) => [output.path.slice(root.length), output]));
    server = serve(assets, port, hostname);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    origin: `http://${hostname}:${server.port}`,
    stop: async () => {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function serve(assets: ReadonlyMap<string, Blob>, port: number, hostname: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname, port, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/icons/icon-192.png") return new Response(Bun.file(join(repo, "public/icons/icon-192.png")));
    if (path === "/favicon.ico") return new Response(Bun.file(join(repo, "public/favicon.ico")));
    const asset = assets.get(path);
    if (asset !== undefined) return new Response(asset);
    return new Response("not found", { status: 404 });
  } });
}

if (import.meta.main) {
  const server = await startFixtureServer(Number(process.env["PORT"] ?? 17431), process.env["HOST"] ?? "127.0.0.1");
  for (const [screen, query] of Object.entries(FIXTURE_SCREENS)) console.log(`${screen}: ${server.origin}/?${query}`);
  console.log("Add &viewer=watcher for a viewing device. Ctrl+C stops the server.");
  const stop = (): void => { void server.stop().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
