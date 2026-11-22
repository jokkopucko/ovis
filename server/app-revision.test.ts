import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRevision } from "./app-revision.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function app(build?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-app-"));
  roots.push(root);
  if (build !== undefined) { mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist", "build.json"), typeof build === "string" ? build : JSON.stringify(build)); }
  return root;
}
const A = "a".repeat(40), B = "b".repeat(40);
const desktop = { OVIS_DESKTOP_APP: "1" };

it("names the desktop app's own build, from a clean tree, where no supervisor sets OVIS_REVISION", () => {
  expect(buildRevision(app({ revision: B, dirty: false }), desktop)).toBe(B);
});

it("takes the release the supervisor runs first, and names no build it cannot vouch for", () => {
  expect(buildRevision(app({ revision: B, dirty: false }), { ...desktop, OVIS_REVISION: A })).toBe(B);
  expect(buildRevision(app({ revision: B, dirty: false }), { OVIS_REVISION: A })).toBe(A);
  for (const build of [{ revision: B, dirty: true }, { revision: B }]) expect(buildRevision(app(build), desktop)).toBeUndefined();
  expect(buildRevision(app({ revision: B, dirty: false }), {})).toBeUndefined();
  for (const build of [undefined, "", "not json", {}, { revision: "abc", dirty: false }]) expect(buildRevision(app(build), desktop)).toBeUndefined();
  expect(buildRevision(app(), { OVIS_REVISION: "main" })).toBeUndefined();
});
