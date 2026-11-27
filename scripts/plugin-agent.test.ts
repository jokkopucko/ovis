import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each([
  { verb: "send", words: ["one task", "--key", "k"], args: { task: "one task", key: "k" }, kind: "accepted" },
  { verb: "answer", words: ["--question-id", "question.7.test.0", "--choices", "0,2"], args: { question_id: "question.7.test.0", choices: [0, 2] }, kind: "answered" },
])("ovis agent $verb uses the run's private door, not the install's HTTP credential", async ({ verb, words, args, kind }) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-"));
  const socket = join(dir, "broker.sock"), tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "test-only-token");
  const requests: unknown[] = [];
  const server = createServer(s => s.once("data", b => {
    requests.push(JSON.parse(b.toString()));
    s.end(`${JSON.stringify({ contract: "ovis-harness/0", kind })}\n`);
  }));
  try {
    await new Promise<void>(ready => server.listen(socket, ready));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "plugin.ts"), "agent", verb, "t42", ...words, "--json"], {
      env: { HOME: dir, PATH: process.env.PATH, OVIS_AGENT_SOCKET: socket, OVIS_AGENT_TOKEN_FILE: tokenFile }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ kind });
    expect(requests).toEqual([{ contract: "ovis-harness/0", id: 1, token: "test-only-token", verb, args: { session: "t42", ...args } }]);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
