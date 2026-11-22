import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");

const copies: Array<[from: string, to: string]> = [
  ["site/index.html", "index.html"],
  ["site/zh/index.html", "zh/index.html"],
  ["site/googlec8861932279eca6b.html", "googlec8861932279eca6b.html"],
  ["install.sh", "install.sh"],
  ["install.ps1", "install.ps1"],
  ["public/favicon.ico", "favicon.ico"],
  ["public/favicon.png", "favicon.png"],
  ["public/apple-touch-icon.png", "apple-touch-icon.png"],
];

async function run(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) console.warn(`${cmd[0]} failed (${code}): ${await new Response(proc.stderr).text()}`.trim());
  return code === 0;
}

rmSync(out, { recursive: true, force: true });
for (const [from, to] of copies) {
  const target = join(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
}
writeFileSync(join(out, ".nojekyll"), "");

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

const demoApp = join(out, "demo", "app");
if (!(await run([process.execPath, "--bun", join(root, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", demoApp, "--emptyOutDir", "--logLevel", "warn"]))) throw new Error("vite build for the demo failed");

const bundle = await Bun.build({
  entrypoints: [join(root, "site/demo/transport.ts")],
  outdir: demoApp,
  naming: "demo-transport.js",
  target: "browser",
  minify: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
});
if (!bundle.success) throw new Error(`demo transport bundle failed:\n${bundle.logs.map(String).join("\n")}`);
const appPage = join(demoApp, "index.html");
let html = readFileSync(appPage, "utf8");
// Vite leaves the PWA links root-absolute; on Pages the root is another site. The manifest goes:
// the demo is not an app to install (its scope and start_url name a root that is not it).
html = html.replace(/\s*<link rel="manifest"[^>]*>/, "");
html = html.replace(/(href|src)="\/(?!\/)/g, '$1="./');
if (!html.includes("</head>")) throw new Error("the built demo app has no head for its noindex directive");
html = html.replace("</head>", '  <meta name="robots" content="noindex" />\n  </head>');
if (!/<script type="module"/.test(html)) throw new Error("the built app has no module script to load the demo transport before");
html = html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"');
writeFileSync(appPage, html);
// the brand mark is <img src="/icons/…"> in the client (src/App.tsx, AccessGate.tsx): root-absolute,
// which is right for the app at its own origin and wrong under demo/app/
for (const script of new Bun.Glob("assets/*.js").scanSync({ cwd: demoApp })) {
  const file = join(demoApp, script);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll('"/icons/', '"./icons/'));
}
copyFileSync(join(root, "site/demo/index.html"), join(out, "demo", "index.html"));

const files = new Bun.Glob("**/*").scanSync({ cwd: out, dot: true });
let bytes = 0;
for (const file of files) bytes += Bun.file(join(out, file)).size;
console.log(`_site: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
