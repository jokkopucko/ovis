import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { omoStateDir, projectStateKey } from "./omo-state-dir.ts";

const root = mkdtempSync(join(tmpdir(), "omo-state-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const options = { env: {}, home: root };

test("project keys hash the real path and sanitize its basename in OmO format", () => {
  const cwd = join(root, "project with spaces");
  mkdirSync(cwd);
  const real = realpathSync.native(cwd);
  const expected = `${basename(real).replace(/ /g, "_")}-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
  expect(projectStateKey(cwd)).toBe(expected);
  expect(projectStateKey(cwd)).toMatch(/^project_with_spaces-[0-9a-f]{12}$/);
  const alias = join(root, "alias");
  symlinkSync(cwd, alias, "junction");
  expect(projectStateKey(alias)).toBe(expected);
  const absent = join(root, "missing");
  expect(projectStateKey(absent)).toBe(`missing-${createHash("sha256").update(resolve(absent)).digest("hex").slice(0, 12)}`);
});

test("agent environment precedence and home fallbacks are injectable without creating directories", () => {
  const cwd = join(root, "env-project");
  const suffix = join("projects", projectStateKey(cwd), "senpi-task");
  const env: NodeJS.ProcessEnv = { OMO_CODING_AGENT_DIR: ` ${join(root, "omo")} `, SENPI_CODING_AGENT_DIR: join(root, "senpi"), PI_CODING_AGENT_DIR: join(root, "pi"), HOME: join(root, "home"), USERPROFILE: join(root, "profile") };
  expect(omoStateDir(cwd, { env, home: root })).toBe(join(root, "omo", suffix));
  env.OMO_CODING_AGENT_DIR = " ";
  expect(omoStateDir(cwd, { env, home: root })).toBe(join(root, "senpi", suffix));
  delete env.SENPI_CODING_AGENT_DIR;
  expect(omoStateDir(cwd, { env, home: root })).toBe(join(root, "pi", suffix));
  delete env.PI_CODING_AGENT_DIR;
  // Windows agents keep their stores under USERPROFILE; elsewhere USERPROFILE means nothing
  const windows = process.platform === "win32";
  expect(omoStateDir(cwd, { env, home: root })).toBe(join(root, windows ? "profile" : "home", ".omo", "agent", suffix));
  delete env.HOME;
  expect(omoStateDir(cwd, { env, home: root })).toBe(windows ? join(root, "profile", ".omo", "agent", suffix) : join(root, ".omo", "agent", suffix));
  expect(omoStateDir(cwd, options)).toBe(join(root, ".omo", "agent", suffix));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { expect(omoStateDir(cwd, options)).toBe(join(root, ".omo", "agent", suffix)); } finally { Object.defineProperty(process, "platform", platform); }
  expect(existsSync(join(root, ".omo"))).toBe(false);
  expect(existsSync(cwd)).toBe(false);
});

test("legacy records or markers win, but empty nested scaffolding does not", () => {
  const cwd = join(root, "legacy");
  const legacy = join(cwd, ".omo", "senpi-task");
  const external = join(root, ".omo", "agent", "projects", projectStateKey(cwd), "senpi-task");
  mkdirSync(join(legacy, "dag", "runs"), { recursive: true });
  expect(omoStateDir(cwd, options)).toBe(external);
  writeFileSync(join(legacy, "dag", "runs", "dag_one.json"), "{}");
  expect(omoStateDir(cwd, options)).toBe(legacy);
  rmSync(join(legacy, "dag"), { recursive: true });
  writeFileSync(join(legacy, ".in-project"), "");
  expect(omoStateDir(cwd, options)).toBe(legacy);
  rmSync(legacy, { recursive: true });
  writeFileSync(legacy, "not a directory");
  expect(omoStateDir(cwd, options)).toBe(legacy);
});
