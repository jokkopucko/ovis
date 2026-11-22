import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

export async function buildDemoApp(app: string, shared: string | undefined = process.env["HERDR_DEMO_BUILD"]): Promise<void> {
  if (shared) {
    for (const file of ["index.html", "demo-transport.js"]) {
      if (!existsSync(join(shared, file))) throw new Error(`HERDR_DEMO_BUILD=${shared} holds no ${file}: build it with \`bun scripts/demo-build.ts ${shared}\`, or unset it`);
    }
    cpSync(shared, app, { recursive: true });
    return;
  }
  await build(app);
}

/**
 * The same client on React's development build, as `bun run dev` serves it: StrictMode (src/main.tsx)
 * runs every effect, its cleanup and the effect again as it mounts. Always built, never the lane's copy.
 */
export async function buildDevelopmentDemoApp(app: string): Promise<void> {
  await build(app, true);
}

async function build(app: string, development = false): Promise<void> {
  const client = Bun.spawnSync([process.execPath, "--bun", join(repo, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", app, "--emptyOutDir", "--logLevel", "warn", ...(development ? ["--mode", "development"] : [])], { cwd: repo, env: { ...process.env, HERDR_TEST_HOOKS: "1", ...(development ? { NODE_ENV: "development" } : {}) } });
  if (client.exitCode !== 0) throw new Error(`the demo's client did not build:\n${new TextDecoder().decode(client.stderr)}`);
  const transport = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app,
    naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
  });
  if (!transport.success) throw new Error(`the demo's transport did not build:\n${transport.logs.map(String).join("\n")}`);
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: bun scripts/demo-build.ts <directory>");
  await build(out);
}
