import { buildXtermSource } from "./scripts/build-xterm.ts";
import { compressedAssets } from "./scripts/compressed-assets.ts";
import { serviceWorkerBuild } from "./scripts/service-worker-build.ts";
import { themeBootstrapBuild } from "./scripts/theme-bootstrap-build.ts";
import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const xtermSource = normalizePath(buildXtermSource(fileURLToPath(new URL(".", import.meta.url))));

let revision: string | null = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* non-Git build */ }

// agentSvgMarks.ts carries LobeHub Icons paths (MIT): their notice ships with every built client
const thirdPartyNotices: Plugin = {
  name: "third-party-notices",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync("THIRD_PARTY_NOTICES.md", "utf8") });
  },
};

// the commit this client was built from, read by the managed bridge that serves it (server/update-api.ts):
// a checkout rebuilt under a running server serves this build before the server runs it
const buildRevision: Plugin = {
  name: "build-revision",
  generateBundle() {
    if (revision !== null) this.emitFile({ type: "asset", fileName: "build.json", source: `${JSON.stringify({ revision })}\n` });
  },
};

// `vite build --mode shell` builds the hosted shell (scripts/shell-build.ts) into its own directory;
// its plugin is loaded only then, so the server-served build stays as it is
export default defineConfig(async ({ mode }) => ({
  // the theme boot script is emitted before compressedAssets and serviceWorkerBuild read the bundle
  plugins: [react(), thirdPartyNotices, buildRevision, themeBootstrapBuild(), compressedAssets(), serviceWorkerBuild(mode === "shell"),
    ...(mode === "shell" ? [(await import("./scripts/shell-build.ts")).shellBuild()] : [])],
  define: {
    __APP_REVISION__: JSON.stringify(revision),
    __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version),
    // test hooks (src/lib/crashProbe.ts): on only in the browser lane's demo build (scripts/demo-build.ts)
    __HERDR_TEST_HOOKS__: JSON.stringify(process.env["HERDR_TEST_HOOKS"] === "1"),
  },
  server: {
    port: 5173,
    proxy: {
      // not the string shorthand: Vite gives that changeOrigin, and the server's same-origin check
      // compares the browser's Origin (:5173) with the Host it was sent, which must stay :5173
      "/api": { target: "http://localhost:7317", changeOrigin: false },
      "/ws": { target: "ws://localhost:7317", ws: true },
    },
  },
  // Keep Vite 6's syntax targets when changing the bundler, including installed mobile clients.
  build: { outDir: mode === "shell" ? "dist-shell" : "dist", target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"] },
  // The Bun patch targets xterm's readable source, not its minified distribution. Build that
  // source so dev, production and the website use the same reviewed IME backport.
  resolve: { alias: [
    { find: /^@xterm\/xterm$/, replacement: `${xtermSource}/browser/public/Terminal.js` },
    { find: /^browser\//, replacement: `${xtermSource}/browser/` },
    { find: /^common\//, replacement: `${xtermSource}/common/` },
    { find: /^vs\/nls$/, replacement: `${xtermSource}/vs/patches/nls.js` },
    { find: /^vs\//, replacement: `${xtermSource}/vs/` },
    { find: "@shared", replacement: new URL("./shared", import.meta.url).pathname },
  ] },
}));
