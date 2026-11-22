import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePlanFile } from "./claude-plan.ts";

const SESSION = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";

describe("claudePlanFile", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function store(slugs: string[], plans: Record<string, string> = {}): { config: string; transcript: string } {
    const config = mkdtempSync(join(tmpdir(), "herdr-claude-plan-"));
    roots.push(config);
    mkdirSync(join(config, "projects", "-work"), { recursive: true });
    mkdirSync(join(config, "plans"), { recursive: true });
    const transcript = join(config, "projects", "-work", `${SESSION}.jsonl`);
    writeFileSync(transcript, slugs.map((slug) => JSON.stringify({ type: "user", sessionId: SESSION, slug })).join("\n") + "\n");
    for (const [name, text] of Object.entries(plans)) writeFileSync(join(config, name), text);
    return { config, transcript };
  }

  it("reads the plan file the session's slug names, in the transcript's own config dir", async () => {
    const { config, transcript } = store(["mellow-purring-pike"], { "plans/mellow-purring-pike.md": "# Plan\n\n1. Step one\n" });
    expect(await claudePlanFile(transcript)).toEqual({ path: join(config, "plans", "mellow-purring-pike.md"), text: "# Plan\n\n1. Step one\n" });
  });

  it("takes the last slug when the session's slug changed", async () => {
    const { transcript } = store(["old-slug", "new-slug"], { "plans/old-slug.md": "old", "plans/new-slug.md": "new" });
    expect((await claudePlanFile(transcript))?.text).toBe("new");
  });

  it("finds the slug behind the large lines that carry none", async () => {
    // recent Claude Code versions write request lines of 70 to 145 KB, without the slug
    const { transcript } = store(["mellow-purring-pike"], { "plans/mellow-purring-pike.md": "# Plan\n" });
    const request = JSON.stringify({ type: "api-request", sessionId: SESSION, body: "x".repeat(100 * 1024) });
    appendFileSync(transcript, `${request}\n${request}\n${request}\n`);
    expect((await claudePlanFile(transcript))?.text).toBe("# Plan\n");
  });

  it("is null without a slug, a plan file or any text in it", async () => {
    expect(await claudePlanFile(store([]).transcript)).toBeNull();
    expect(await claudePlanFile(store(["no-file"]).transcript)).toBeNull();
    expect(await claudePlanFile(store(["blank"], { "plans/blank.md": "  \n" }).transcript)).toBeNull();
    expect(await claudePlanFile(join(tmpdir(), "herdr-claude-plan-missing", `${SESSION}.jsonl`))).toBeNull();
  });

  it("never reads outside the plans folder", async () => {
    const { transcript } = store(["../secret"], { "secret.md": "not a plan" });
    expect(await claudePlanFile(transcript)).toBeNull();
  });
});
