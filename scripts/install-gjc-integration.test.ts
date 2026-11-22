import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installGjcIntegration, { GJC_INTEGRATION_OWNERSHIP_BANNER } from "./install-gjc-integration.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-gjc-installer-"));
  roots.push(root);
  return root;
}

it("rejects the unsupported agent directory CLI flag", async () => {
  const root = agentDir();

  // When the installer CLI receives the removed flag.
  // HOME points at the temp root too, so a regression could never install into the real home.
  const command = Bun.spawn([process.execPath, join(import.meta.dir, "install-gjc-integration.ts"), "--agent-dir", root], {
    stdout: "ignore", stderr: "ignore", env: { ...process.env, HOME: root, USERPROFILE: root },
  });

  expect(await command.exited).toBe(1);
  expect(existsSync(join(root, "extensions"))).toBe(false);
  expect(existsSync(join(root, ".gjc"))).toBe(false);
});

it("atomically installs only the standalone extension with private permissions", async () => {
  const root = agentDir();
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  const target = join(extensions, "herdr-web-ui.js");
  const otherExtension = join(extensions, "other.js");
  const settings = join(root, "settings.json");
  writeFileSync(target, `${GJC_INTEGRATION_OWNERSHIP_BANNER}\nold extension\n`);
  writeFileSync(otherExtension, "other extension");
  writeFileSync(settings, "{\"preserved\":true}");
  let builds = 0;

  const result = await installGjcIntegration({ agentDir: root, build: async () => { builds++; return "export default function extension() {}"; } });

  expect(result).toEqual({ action: "installed", path: target });
  expect(builds).toBe(1);
  expect(readFileSync(target, "utf8")).toBe(`${GJC_INTEGRATION_OWNERSHIP_BANNER}\nexport default function extension() {}\n`);
  expect(readFileSync(otherExtension, "utf8")).toBe("other extension");
  expect(readFileSync(settings, "utf8")).toBe("{\"preserved\":true}");
  if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(readdirSync(extensions).sort()).toEqual(["herdr-web-ui.js", "other.js"]);
});

it("removes only the dedicated extension without building or pruning the directory", async () => {
  const root = agentDir();
  const extensions = join(root, "extensions");
  mkdirSync(extensions, { recursive: true });
  const target = join(extensions, "herdr-web-ui.js");
  const otherExtension = join(extensions, "other.js");
  writeFileSync(target, `${GJC_INTEGRATION_OWNERSHIP_BANNER}\ninstalled\n`);
  writeFileSync(otherExtension, "preserve");

  const result = await installGjcIntegration({
    agentDir: root,
    remove: true,
    build: async () => { throw new Error("remove must not build"); },
  });

  expect(result).toEqual({ action: "removed", path: target });
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(otherExtension, "utf8")).toBe("preserve");
  expect(existsSync(extensions)).toBe(true);
});

it("leaves the installed extension untouched when building fails", async () => {
  const root = agentDir();
  const extensions = join(root, "extensions");
  mkdirSync(extensions, { recursive: true });
  const target = join(extensions, "herdr-web-ui.js");
  writeFileSync(target, `${GJC_INTEGRATION_OWNERSHIP_BANNER}\nstill installed\n`);

  await expect(installGjcIntegration({ agentDir: root, build: async () => { throw new Error("build failed"); } })).rejects.toThrow("build failed");

  expect(readFileSync(target, "utf8")).toBe(`${GJC_INTEGRATION_OWNERSHIP_BANNER}\nstill installed\n`);
  expect(readdirSync(extensions)).toEqual(["herdr-web-ui.js"]);
});

it("bundles the extension's internal modules into the installed standalone JavaScript", async () => {
  const root = agentDir();
  const result = await installGjcIntegration({ agentDir: root });
  const output = readFileSync(result.path, "utf8");
  expect(result.action).toBe("installed");
  expect(output).toContain("session_start");
  expect(output).not.toMatch(/from ["']\.\.\/(?:server|shared)\//);
  expect(output.split("\n").slice(0, 2)).toEqual(["// @bun", GJC_INTEGRATION_OWNERSHIP_BANNER]);
});

it("preserves the Bun pragma when replacing an extension with a second-line ownership banner", async () => {
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  const target = join(root, "extensions", "herdr-web-ui.js");
  writeFileSync(target, `// @bun\r\n${GJC_INTEGRATION_OWNERSHIP_BANNER}\nold\n`);

  await installGjcIntegration({ agentDir: root, build: async () => "// @bun\nexport default 1;" });

  expect(readFileSync(target, "utf8")).toBe(`// @bun\n${GJC_INTEGRATION_OWNERSHIP_BANNER}\nexport default 1;\n`);
});

it("removes an extension with ownership directly after the Bun pragma", async () => {
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  const target = join(root, "extensions", "herdr-web-ui.js");
  writeFileSync(target, `// @bun\n${GJC_INTEGRATION_OWNERSHIP_BANNER}\ninstalled\n`);

  const result = await installGjcIntegration({ agentDir: root, remove: true });

  expect(result).toEqual({ action: "removed", path: target });
});

it("refuses to overwrite or remove a foreign extension", async () => {
  const root = agentDir();
  const extensions = join(root, "extensions");
  mkdirSync(extensions, { recursive: true });
  const target = join(extensions, "herdr-web-ui.js");
  writeFileSync(target, "foreign extension\n");
  let builds = 0;

  await expect(installGjcIntegration({ agentDir: root, build: async () => { builds++; return "replacement"; } })).rejects.toThrow("ownership banner");
  await expect(installGjcIntegration({ agentDir: root, remove: true })).rejects.toThrow("ownership banner");

  expect(builds).toBe(0);
  expect(readFileSync(target, "utf8")).toBe("foreign extension\n");
});

it("refuses to overwrite or remove a symlink at the dedicated extension path", async () => {
  if (process.platform === "win32") return;
  const root = agentDir();
  const extensions = join(root, "extensions");
  mkdirSync(extensions, { recursive: true });
  const target = join(extensions, "herdr-web-ui.js");
  const foreign = join(extensions, "foreign.js");
  writeFileSync(foreign, "foreign target\n");
  symlinkSync(foreign, target);

  await expect(installGjcIntegration({ agentDir: root, build: async () => "replacement" })).rejects.toThrow("regular installer-owned file");
  await expect(installGjcIntegration({ agentDir: root, remove: true })).rejects.toThrow("regular installer-owned file");

  expect(readFileSync(foreign, "utf8")).toBe("foreign target\n");
  expect(existsSync(target)).toBe(true);
});
