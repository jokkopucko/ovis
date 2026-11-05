import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PASEO_FILES = [
  "e2ee.ts", "secure-channel.ts", "protected-records.ts", "encrypted-channel.ts",
  "crypto.ts", "base64.ts", "noise/index.ts", "noise/cipher-state.ts",
  "noise/symmetric-state.ts", "noise/fixtures/nk-25519-chachapoly-sha256.json",
  "LICENSE", "tsconfig.json",
] as const;

if (import.meta.main) {
  const commit = process.argv[2];
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Usage: bun scripts/vendor-paseo.ts <40-character commit>");
  const scratch = mkdtempSync(join(tmpdir(), "vendor-paseo-"));
  const source = process.env["PASEO_SOURCE_DIR"] ?? join(scratch, "paseo");
  const destination = resolve(import.meta.dir, "../shared/vendor/paseo-e2ee");
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      env: { ...process.env, GIT_MASTER: "1" }, stdout: "pipe", stderr: "inherit",
    });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return output.trim();
  };
  try {
    if (!process.env["PASEO_SOURCE_DIR"]) {
      const clone = Bun.spawn(["timeout", "120", "git", "clone", "https://github.com/getpaseo/paseo", source], {
        env: { ...process.env, GIT_MASTER: "1" }, stdout: "inherit", stderr: "inherit",
      });
      if (await clone.exited !== 0) throw new Error("Paseo clone failed");
      await git("-C", source, "checkout", "--detach", commit);
    }
    if (await git("-C", source, "rev-parse", "HEAD") !== commit) throw new Error("Paseo checkout does not match requested commit");
    if (await git("-C", source, "status", "--porcelain")) throw new Error("Paseo checkout must be clean");
    const rows: string[] = [];
    for (const file of PASEO_FILES) {
      const from = join(source, file === "LICENSE" ? file : file === "tsconfig.json" ? "packages/relay/tsconfig.json" : `packages/relay/src/${file}`);
      const to = join(destination, file);
      mkdirSync(dirname(to), { recursive: true });
      if (file === "tsconfig.json") {
        // Preserve upstream compiler policy; adapt the flattened layout and project boundary.
        const config = JSON.parse(readFileSync(from, "utf8"));
        config.compilerOptions.rootDir = ".";
        config.compilerOptions.composite = true;
        config.include = ["**/*.ts"];
        config.exclude = ["node_modules", "dist", "**/*.test.ts"];
        writeFileSync(to, JSON.stringify(config, null, 2) + "\n");
      } else {
        copyFileSync(from, to);
      }
      rows.push(`| \`${file}\` | \`${createHash("sha256").update(readFileSync(to)).digest("hex")}\` |`);
    }
    writeFileSync(join(destination, "README.md"), [
      "# Paseo endpoint encryption", "",
      "Source: https://github.com/getpaseo/paseo",
      `Commit: \`${commit}\``, "",
      "Do not edit; update by re-vendoring.", "",
      `Run \`bun scripts/vendor-paseo.ts ${commit}\` from the repository root.`,
      "An existing clean checkout can be supplied with PASEO_SOURCE_DIR.",
      "Sources and LICENSE are byte-identical. tsconfig.json retains upstream compiler policy,",
      "with rootDir/include/exclude adapted to the flattened layout and composite enabled",
      "so the root project consumes declarations instead of applying its stricter indexing policy.", "",
      "| File | SHA-256 |", "| --- | --- |", ...rows, "",
    ].join("\n"));
    console.log(`Vendored ${PASEO_FILES.length} files from ${commit}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
