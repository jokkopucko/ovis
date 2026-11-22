import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompTranscriptImage, transcriptPage } from "./conversation.ts";
import { opensTurn } from "./transcript-turns.ts";

// a picture an omo tool showed (eval display(), read of an image): omo writes it inline in the tool result, as pi does (#3420)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const at = "2026-11-10T00:00:00.000Z";
const dir = mkdtempSync(join(tmpdir(), "omo-images-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const prompt = { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "show it" }] } };
const call = { type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", stopReason: "toolUse",
  content: [{ type: "toolCall", id: "call-eval", name: "eval", arguments: { code: "display(png)" } }] } };
const result = { type: "message", id: "r1", parentId: "a1", timestamp: at, message: { role: "toolResult", toolCallId: "call-eval", toolName: "eval",
  content: [{ type: "text", text: "shown" }, { type: "image", data: PNG, mimeType: "image/png" }] } };
const transcript = (name: string, records: unknown[]) => {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, [{ type: "session", id: name, cwd: dir, timestamp: at }, ...records].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
};
const tool = (path: string) => transcriptPage("omo-transcript", path).turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");

it("names the picture an omo tool result holds inline, and serves it from the file (#3420)", async () => {
  const path = transcript("shown", [prompt, call, result]);
  const named = tool(path);
  expect(named !== undefined && named.kind === "tool" && named.images).toEqual([{ media_type: "image/png", ref: "pi:call-eval:0" }]);
  const image = await ompTranscriptImage(path, "pi:call-eval:0", null, "omo-transcript");
  expect(image?.mediaType).toBe("image/png");
  expect(Buffer.from(image!.bytes).toString("base64")).toBe(PNG);
});

it("serves an omo picture as its page reads the file, past a record on another branch", async () => {
  const path = transcript("forked", [prompt, call, result, { type: "message", id: "u2", parentId: "u1", timestamp: at, message: { role: "user", content: [{ type: "text", text: "again" }] } }]);
  const named = tool(path);
  expect(named !== undefined && named.kind === "tool" && named.images?.[0]?.ref).toBe("pi:call-eval:0");
  expect((await ompTranscriptImage(path, "pi:call-eval:0", null, "omo-transcript"))?.mediaType).toBe("image/png");
});

it("reads an omo picture only from the file its resolver proved", async () => {
  const path = transcript("proved", [prompt, call, result]);
  const { dev, ino } = statSync(path, { bigint: true });
  expect((await ompTranscriptImage(path, "pi:call-eval:0", null, "omo-transcript", { dev, ino }))?.mediaType).toBe("image/png");
  expect(await ompTranscriptImage(path, "pi:call-eval:0", null, "omo-transcript", { dev, ino: ino + 1n })).toBeNull();
});

it("opens a turn at an omo prompt that is only a picture, as the parser draws it", () => {
  const pictured = { type: "message", id: "u3", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] } };
  expect(opensTurn("omo-transcript", JSON.stringify(pictured), null)).toBe(true);
});
