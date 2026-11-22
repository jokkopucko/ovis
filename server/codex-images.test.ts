import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickedTurn, searchPattern, searchTurns } from "../shared/conversation-search.ts";
import type { ConversationPart } from "../shared/protocol.ts";
import { codexImageParts, codexOutputPicture, codexTranscriptImage, DataUrlPictureScan, imageType, inlineImageType, InlinePictureScan } from "./codex-images.ts";
import { forgetHistoryChains, parseCodexTranscript } from "./codex.ts";
import { codexPromptImage, codexToolImage, forgetTranscriptState, transcriptPage } from "./conversation.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
const event = (message: string, local_images: string[]) => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message, local_images } });
const response = (text: string, image: string) => ({ type: "response_item", timestamp: "2026-09-27T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: image }] } });
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

it("preserves image-only Codex turns and pairs event/response copies in either order", () => {
  for (const text of ["", "What is this?"]) {
    for (const records of [[event(text, ["/tmp/shot.png"]), response(text, data)], [response(text, data), event(text, ["/tmp/shot.png"])]]) {
      const turns = parseCodexTranscript(jsonl(...records));
      expect(turns).toHaveLength(1);
      expect(turns[0]!.parts.filter((part) => part.kind === "image")).toEqual(codexImageParts(event(text, ["/tmp/shot.png"])));
      expect(JSON.stringify(turns)).not.toContain(png.toString("base64"));
      expect(JSON.stringify(turns)).not.toContain("/tmp/shot.png");
    }
  }
  expect(parseCodexTranscript(jsonl(event("", ["one.png"]), event("", ["two.png"])))).toHaveLength(2);
  expect(parseCodexTranscript(jsonl(response("", data)))[0]?.parts).toEqual(codexImageParts(response("", data)));
});

it("opens a prompt a search found before Codex paired its picture with the file, not another of its words", () => {
  const [match] = searchTurns(parseCodexTranscript(jsonl(response("What color is this?", data))), searchPattern("color")!);
  const blue = { ...event("What color is this?", ["/tmp/blue.png"]), timestamp: "2026-09-27T00:00:05Z" };
  const turns = parseCodexTranscript(jsonl(response("What color is this?", data), event("What color is this?", ["/tmp/red.png"]), blue));
  expect(turns.map((turn) => turn.parts[0])).toEqual([codexImageParts(event("", ["/tmp/red.png"]))[0], codexImageParts(event("", ["/tmp/blue.png"]))[0]]);
  expect(pickedTurn(turns, match!)).toBe(0);
});

it("strips Codex's native image envelope but keeps user-typed lookalikes", () => {
  const withEnvelope = {
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [
      { type: "input_text", text: '<image name=[Image #1] path="/tmp/yellow-star.gif">' },
      { type: "input_image", image_url: data },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1]" },
    ] },
  };
  const regressionTurns = parseCodexTranscript(jsonl(withEnvelope));
  const regressionUser = regressionTurns[0]!;
  expect(regressionUser.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1]"]);
  expect(regressionUser.parts.filter((part) => part.kind === "image")).toHaveLength(1);
  expect(JSON.stringify(regressionUser)).not.toContain("/tmp/yellow-star.gif");

  // a pasted image's envelope has no path; two of them in one message
  const pasted = parseCodexTranscript(jsonl({
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<image name=[Image #1]>" },
      { type: "input_image", image_url: data },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "<image name=[Image #2]>" },
      { type: "input_image", image_url: data.replace("image/png", "image/gif") },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1] [Image #2] compare these" },
    ] },
  }))[0]!;
  expect(pasted.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1] [Image #2] compare these"]);
  expect(pasted.parts.filter((part) => part.kind === "image")).toHaveLength(2);

  const controlTurns = parseCodexTranscript(jsonl({
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: 'I typed <image name=x> and </image> literally.' }] },
  }));
  expect(controlTurns[0]?.parts.filter((part) => part.kind === "text").map((part) => part.text))
    .toEqual(['I typed <image name=x> and </image> literally.']);
});

it("names a raster by its signature and refuses short or truncated prefixes", () => {
  const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)));
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  expect(imageType(png)).toBe("image/png");
  expect(imageType(bytes(pngSignature))).toBe("image/png");
  expect(imageType(bytes(pngSignature.slice(0, 7)))).toBeNull();
  expect(imageType(bytes([255, 216, 255]))).toBe("image/jpeg");
  expect(imageType(bytes([255, 216]))).toBeNull();
  expect(imageType(bytes("GIF87a"))).toBe("image/gif");
  expect(imageType(bytes("GIF89a", [1, 0]))).toBe("image/gif");
  expect(imageType(bytes("GIF88a"))).toBeNull();
  expect(imageType(bytes("GIF89"))).toBeNull();
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WEBP"))).toBe("image/webp");
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WEB"))).toBeNull();
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WAVE"))).toBeNull();
  // each letter with its high bit set: an ASCII decode would read these as the signatures
  expect(imageType(bytes([0xc7, 0xc9, 0xc6, 0x38, 0x37, 0xe1]))).toBeNull();
  expect(imageType(bytes([0xc7, 0xc9, 0xc6, 0x38, 0x39, 0xe1]))).toBeNull();
  expect(imageType(bytes([0xd2, 0xc9, 0xc6, 0xc6, 4, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0]))).toBeNull();
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], [0xd7, 0xc5, 0xc2, 0xd0]))).toBeNull();
  expect(imageType(bytes("not an image"))).toBeNull();
  expect(imageType(Buffer.alloc(0))).toBeNull();
});

it("does not turn remote URLs, unsupported data, or assistant/tool content into images", () => {
  expect(codexImageParts(event("", ["https://host/shot.png", "file:///tmp/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "bad\0.png"]))).toEqual([]);
  expect(codexImageParts({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_image", image_url: data }] } })).toEqual([]);
  expect(codexImageParts(event("", ["a.png", "a.png"]))).toHaveLength(1);
});

it("fetches only referenced raster images within the retained history and bounds local reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-images-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "shot.png"), png);
    const path = join(root, "rollout.jsonl");
    const record = event("", ["assets/shot.png"]);
    const first = `${jsonl(record)}\n`;
    writeFileSync(path, first + jsonl(response("", data)));
    const ref = codexImageParts(record)[0]!.ref;
    const inlineRef = codexImageParts(response("", data))[0]!.ref;
    const segment = { path, end: Buffer.byteLength(first) };
    const found = await codexTranscriptImage([segment], ref, root);
    expect(found?.mediaType).toBe("image/png");
    expect(Buffer.from(found!.bytes)).toEqual(png);
    expect(await codexTranscriptImage([segment], inlineRef, root)).toBeNull();
    expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(first + jsonl(response("", data))) }], inlineRef, root)).toEqual(found);
    expect(await codexTranscriptImage([segment], "../../etc/passwd", root)).toBeNull();
    expect(await codexTranscriptImage([segment], `codex-${"0".repeat(64)}`, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), "<html>not an image</html>");
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    rmSync(join(root, "assets", "shot.png"));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("serves no picture from another rollout that a folder swap puts at a later rollout's path once the lookup has begun", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-images-swap-"));
  try {
    const foreign = Buffer.from(png);
    foreign[foreign.length - 1]! ^= 1;
    const own = jsonl(response("", data));
    const other = jsonl(response("", `data:image/png;base64,${foreign.toString("base64")}`));
    const ownRef = codexImageParts(response("", data))[0]!.ref;
    const otherRef = codexImageParts(response("", `data:image/png;base64,${foreign.toString("base64")}`))[0]!.ref;
    const parent = join(root, "parent.jsonl");
    writeFileSync(parent, jsonl(event("before", [])));
    const folder = join(root, "live");
    const elsewhere = join(root, "other");
    mkdirSync(folder);
    mkdirSync(elsewhere);
    const path = join(folder, "rollout.jsonl");
    writeFileSync(path, own);
    writeFileSync(join(elsewhere, "rollout.jsonl"), other);
    const segments = [{ path: parent, end: Buffer.byteLength(jsonl(event("before", []))) }, { path, end: Buffer.byteLength(own) }];
    expect((await codexTranscriptImage(segments, ownRef, root))?.mediaType).toBe("image/png");
    expect(await codexTranscriptImage(segments, otherRef, root)).toBeNull();
    const pending = codexTranscriptImage(segments, otherRef, root);
    renameSync(folder, join(root, "away"));
    renameSync(elsewhere, folder);
    let image: Awaited<ReturnType<typeof codexTranscriptImage>>;
    try { image = await pending; }
    finally {
      renameSync(folder, elsewhere);
      renameSync(join(root, "away"), folder);
    }
    expect(image !== null && Buffer.from(image.bytes).equals(foreign) ? "FOREIGN" : image).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A real codex-cli 0.163.0 rollout (`codex exec` in /tmp/codex-pictures, then `codex exec resume`):
// a prompt with `-i shot.png`, then `view_image` on it through the exec tool, whose output carries the
// picture as a data URL beside an `ImageView` event. Only the records the chat reads are kept.
const ROLLOUT = readFileSync(new URL("./fixtures/codex-pictures-0.163.0-rollout.jsonl", import.meta.url), "utf8");
const VIEWED = "call_c14dcc9fd54946c7bc093bac1ec706fd";
const SHOT = "216412999d849811ca002949953aa22a041cebcf0b31e7c812ee86328338b893";

describe("a Codex tool's pictures reach the chat", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-tool-images-"));
  const home = join(root, "codex-home");
  afterAll(() => { rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
  const header = ROLLOUT.split("\n")[0]!;
  let files = 0;
  const rollout = (text: string) => {
    files += 1;
    const path = join(root, `rollout-2026-10-26T18-01-48-01a17771-c993-7f01-9f21-${String(files).padStart(12, "0")}.jsonl`);
    writeFileSync(path, text);
    return path;
  };
  const pictures = (path: string) => transcriptPage("codex-transcript", path, {}, home).turns.flatMap((turn) => turn.parts)
    .flatMap((part: ConversationPart) => part.kind === "tool" ? (part.images ?? []).map((image) => `${image.media_type} ${image.ref}`) : []);
  const sha = async (path: string, ref: string) => {
    const image = await codexToolImage(path, ref, home);
    return image === null ? null : `${image.mediaType} ${createHash("sha256").update(image.bytes).digest("hex")}`;
  };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const url = (bytes: Buffer, type = "image/png") => `data:${type};base64,${bytes.toString("base64")}`;
  const picture = (bytes: Buffer, type = "image/png") => ({ type: "input_image", image_url: url(bytes, type), detail: "high" });
  const at = "2026-10-26T09:07:06.240Z";
  const call = (id: string, input = "await tools.view_image({path: 'shot.png'})") => ({ type: "response_item", timestamp: at, payload: { type: "custom_tool_call", call_id: id, name: "exec", input } });
  const output = (id: string, content: unknown[]) => ({ type: "response_item", timestamp: at, payload: { type: "custom_tool_call_output", call_id: id, output: content } });
  const records = (...entries: unknown[]) => [header, ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";
  const started = { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "t1" } };

  it("names the recorded view_image picture by its call, never its bytes, and serves those bytes", async () => {
    const path = rollout(ROLLOUT);
    // one picture: the ImageView event beside the output is no second copy
    expect(pictures(path)).toEqual([`image/png codex-tool:${VIEWED}:0`]);
    expect(JSON.stringify(transcriptPage("codex-transcript", path, {}, home))).not.toContain("iVBORw0KGgo");
    expect(await sha(path, `codex-tool:${VIEWED}:0`)).toBe(`image/png ${SHOT}`);
    for (const ref of [`codex-tool:${VIEWED}:1`, `codex-tool:${VIEWED}`, "codex-tool:call_other:0", `codex-tool:../${VIEWED}:0`, `pi:${VIEWED}:0`]) expect(await codexToolImage(path, ref, home)).toBeNull();
  });

  it("numbers only the pictures the chat shows, by declared type and bytes, up to 8 MiB", async () => {
    const exact = Buffer.alloc(8 * 1024 * 1024);
    png.copy(exact);
    const over = Buffer.alloc(8 * 1024 * 1024 + 1);
    png.copy(over);
    const path = rollout(records(started, call("call_a"), output("call_a", [
      { type: "input_text", text: "Script completed" },
      picture(Buffer.from("<svg/>"), "image/svg+xml"),
      picture(Buffer.from("not a picture")),
      { type: "input_image", image_url: "https://example.com/shot.png" },
      picture(gif, "image/gif"),
      picture(exact),
    ])));
    expect(pictures(path)).toEqual(["image/gif codex-tool:call_a:0", "image/png codex-tool:call_a:1"]);
    expect(await sha(path, "codex-tool:call_a:0")).toBe(`image/gif ${createHash("sha256").update(gif).digest("hex")}`);
    expect((await codexToolImage(path, "codex-tool:call_a:1", home))?.bytes.length).toBe(8 * 1024 * 1024);
    expect(await codexToolImage(path, "codex-tool:call_a:2", home)).toBeNull();
    const large = rollout(records(started, call("call_a"), output("call_a", [picture(over), picture(gif, "image/gif")])));
    expect(pictures(large)).toEqual(["image/gif codex-tool:call_a:0"]);
    expect((await codexToolImage(large, "codex-tool:call_a:0", home))?.mediaType).toBe("image/gif");
    expect(await codexToolImage(large, "codex-tool:call_a:1", home)).toBeNull();
  });

  it("serves a picture only from the output the page draws: the first one answering a call it shows", async () => {
    const orphan = rollout(records(started, output("call_a", [picture(png)])));
    expect(pictures(orphan)).toEqual([]);
    expect(await codexToolImage(orphan, "codex-tool:call_a:0", home)).toBeNull();
    const twice = rollout(records(started, call("call_a"), output("call_a", [{ type: "input_text", text: "none" }]), output("call_a", [picture(png)])));
    expect(pictures(twice)).toEqual([]);
    expect(await codexToolImage(twice, "codex-tool:call_a:0", home)).toBeNull();
    const again = rollout(records(started, call("call_a"), output("call_a", [{ type: "input_text", text: "none" }]), call("call_a"), output("call_a", [picture(gif, "image/gif")])));
    expect(pictures(again)).toEqual(["image/gif codex-tool:call_a:0"]);
    expect((await codexToolImage(again, "codex-tool:call_a:0", home))?.mediaType).toBe("image/gif");
    const fn = rollout(records(started, { type: "response_item", timestamp: at, payload: { type: "function_call", call_id: "call_f", name: "view_image", arguments: "{\"path\":\"shot.png\"}" } },
      { type: "response_item", timestamp: at, payload: { type: "function_call_output", call_id: "call_f", output: [picture(png)] } }));
    expect(pictures(fn)).toEqual(["image/png codex-tool:call_f:0"]);
    expect((await codexToolImage(fn, "codex-tool:call_f:0", home))?.mediaType).toBe("image/png");
  });

  it("counts a picture before the one it serves as the parser does, its text written with escapes", async () => {
    const large = Buffer.alloc(2 * 1024 * 1024, 7);
    png.copy(large);
    // a JSON writer may escape every `/`, and the first picture's text crosses the endpoint's windows
    const path = rollout(records(started, call("call_a"), output("call_a", [picture(large), picture(Buffer.from("<svg/>"), "image/svg+xml"), picture(gif, "image/gif")])).replaceAll("/", "\\/"));
    expect(pictures(path)).toEqual(["image/png codex-tool:call_a:0", "image/gif codex-tool:call_a:1"]);
    expect(Buffer.from((await codexToolImage(path, "codex-tool:call_a:0", home))!.bytes).equals(large)).toBe(true);
    expect(await sha(path, "codex-tool:call_a:1")).toBe(`image/gif ${createHash("sha256").update(gif).digest("hex")}`);
  });

  it("reads a call id however JSON writes it, as the parser does", async () => {
    const path = rollout(ROLLOUT.replaceAll(`"call_id":"${VIEWED}"`, `"call_id":"\\u0063all_${VIEWED.slice(5)}"`));
    expect(readFileSync(path, "utf8")).toContain("\\u0063all_");
    expect(pictures(path)).toEqual([`image/png codex-tool:${VIEWED}:0`]);
    expect(await sha(path, `codex-tool:${VIEWED}:0`)).toBe(`image/png ${SHOT}`);
  });

  it("lets the event loop run between windows while it looks through a large rollout", async () => {
    const pad = "x".repeat(20 * 1024 * 1024);
    const path = rollout(records(started, call("call_pad", pad), call("call_a"), output("call_a", [picture(png)])));
    let turns = 0;
    let looking = true;
    const turn = () => { if (looking) { turns += 1; setImmediate(turn); } };
    setImmediate(turn);
    expect((await codexToolImage(path, "codex-tool:call_a:0", home))?.mediaType).toBe("image/png");
    looking = false;
    expect(turns).toBeGreaterThanOrEqual(15);
  });

  it("never holds the event loop for more than a few windows, however many small records it judges", async () => {
    const words = "call_a again ".repeat(90);
    const many = Array.from({ length: 30_000 }, () => ({ type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: words }] } }));
    const path = rollout(records(started, ...many, call("call_a"), output("call_a", [picture(png)])));
    let since = 0, most = 0, total = 0;
    const real = Buffer.alloc.bind(Buffer);
    const counting = spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => { since += 1; total += 1; return real(...args); }) as typeof Buffer.alloc);
    let looking = true;
    const turn = () => { most = Math.max(most, since); since = 0; if (looking) setImmediate(turn); };
    try {
      setImmediate(turn);
      expect((await codexToolImage(path, "codex-tool:call_a:0", home))?.mediaType).toBe("image/png");
    } finally { looking = false; most = Math.max(most, since); counting.mockRestore(); }
    expect(total).toBeGreaterThan(30_000);
    expect(most).toBeLessThanOrEqual(400);
  });

  it("holds a window, a record's shape and the picture, never a record whole however large", async () => {
    const alloc = spyOn(Buffer, "alloc");
    try {
      const pad = "x".repeat(20 * 1024 * 1024);
      const path = rollout(records(started, call("call_a", pad), output("call_a", [{ type: "input_text", text: pad }, picture(png)])));
      expect((await codexToolImage(path, "codex-tool:call_a:0", home))?.mediaType).toBe("image/png");
      alloc.mockClear();
      expect(Buffer.from((await codexToolImage(path, "codex-tool:call_a:0", home))!.bytes).equals(png)).toBe(true);
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(1024 * 1024);
    } finally { alloc.mockRestore(); }
  });

  it("serves no picture from another rollout that a folder swap puts at the path around the scan's opens after its first", async () => {
    const foreign = Buffer.from(png);
    foreign[foreign.length - 1]! ^= 1;
    const folder = join(root, "swap-own");
    const elsewhere = join(root, "swap-other");
    const away = join(root, "swap-away");
    mkdirSync(folder);
    mkdirSync(elsewhere);
    const name = "rollout-2026-10-26T18-01-48-01a17771-c993-7f01-9f21-0000000000ff.jsonl";
    const path = join(folder, name);
    writeFileSync(path, records(started, call("call_a"), output("call_a", [picture(png)])));
    writeFileSync(join(elsewhere, name), records(started, call("call_a"), output("call_a", [picture(foreign)])));
    expect(Buffer.from((await codexToolImage(path, "codex-tool:call_a:0", home))!.bytes).equals(png)).toBe(true);
    forgetTranscriptState();
    // the path names the pane's own rollout when the lookup begins and at the scan's first open; every later
    // open, after the scan's awaits, meets the other folder
    const counts = { opens: 0, swaps: 0 };
    const real = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== path || counts.opens++ === 0) return real(...args);
      counts.swaps++;
      renameSync(folder, away);
      renameSync(elsewhere, folder);
      try { return real(...args); }
      finally {
        renameSync(folder, elsewhere);
        renameSync(away, folder);
      }
    }) as typeof fs.openSync);
    let image: Awaited<ReturnType<typeof codexToolImage>>;
    try { image = await codexToolImage(path, "codex-tool:call_a:0", home); } finally { spy.mockRestore(); }
    expect(counts.swaps).toBeGreaterThan(0);
    expect(image !== null && Buffer.from(image.bytes).equals(foreign) ? "FOREIGN" : image).toBeNull();
  });
});

it("checks a picture's text a piece at a time exactly as it checks the whole", () => {
  const head = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  const pngHead = head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const texts = [pngHead, pngHead + "AAAA", `${pngHead}A=`, `${pngHead}==`, `${pngHead}A==`, "PHN2Zz4=", "", "iVBO", `${pngHead}*bad`, `${pngHead}=A`, `${pngHead}===`];
  const urls = [...texts.map((text) => `data:image/png;base64,${text}`), `data:image/svg+xml;base64,${pngHead}`, `data:image/png;base64;${pngHead}`, `https://host/x.png`, `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7`, `xdata:image/png;base64,${pngHead}`];
  const splits = (text: string): string[][] => {
    const out: string[][] = [[text]];
    for (let a = 0; a <= text.length; a += 1) {
      out.push([text.slice(0, a), text.slice(a)]);
      for (let b = a; b <= text.length; b += 3) out.push([text.slice(0, a), text.slice(a, b), text.slice(b)]);
    }
    return out;
  };
  for (const declared of ["image/png", "image/gif", "image/svg+xml"]) {
    for (const text of texts) {
      for (const pieces of splits(text)) {
        const scan = new InlinePictureScan();
        for (const piece of pieces) scan.push(piece);
        expect([declared, text, scan.type(declared)]).toEqual([declared, text, inlineImageType(declared, text)]);
      }
    }
  }
  for (const url of urls) {
    for (const pieces of splits(url)) {
      const scan = new DataUrlPictureScan();
      for (const piece of pieces) scan.push(piece);
      expect([url, scan.type()]).toEqual([url, codexOutputPicture({ type: "input_image", image_url: url })?.mediaType ?? null]);
    }
  }
  // at the 8 MiB edge the padding decides: "==" takes exactly the most the endpoint serves, so a
  // text cut inside its padding must still be read as ending in both
  const edge = `${pngHead}${"A".repeat(11_184_814 - pngHead.length - 2)}==`;
  for (const text of [edge, `${edge.slice(0, -2)}A=`]) {
    for (const at of [text.length - 1, text.length - 2, text.length - 3]) {
      const scan = new InlinePictureScan();
      scan.push(text.slice(0, at));
      scan.push(text.slice(at));
      expect(scan.type("image/png")).toBe(inlineImageType("image/png", text));
      const url = new DataUrlPictureScan();
      url.push(`data:image/png;base64,${text.slice(0, at)}`);
      url.push(text.slice(at));
      expect(url.type()).toBe(codexOutputPicture({ type: "input_image", image_url: `data:image/png;base64,${text}` })?.mediaType ?? null);
    }
  }
  expect(inlineImageType("image/png", edge)).toBe("image/png");
  expect(inlineImageType("image/png", `${edge.slice(0, -2)}A=`)).toBeNull();
});

async function coldChainSwap<T>(parentRecords: readonly unknown[], lookup: (path: string, home: string) => Promise<T>): Promise<{ answered: T; swaps: number }> {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-chain-swap-"));
  try {
    const home = join(root, "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    const parentDay = join(home, "sessions", "2026", "09", "15");
    const folder = join(home, "sessions", "2026", "09", "23");
    const elsewhere = join(root, "23");
    mkdirSync(parentDay, { recursive: true });
    mkdirSync(folder, { recursive: true });
    mkdirSync(elsewhere);
    const kept = [meta(), ...parentRecords.map((record) => JSON.stringify(record))].join("\n") + "\n";
    writeFileSync(join(parentDay, `rollout-2026-09-15T12-58-12-${thread}.jsonl`), kept);
    const name = `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`;
    const path = join(folder, name);
    const turn = jsonl(response("the pane's own", data));
    writeFileSync(path, `${meta()}\n${turn}\n`);
    const base = { thread_id: thread, end_ordinal_exclusive: parentRecords.length + 1, end_byte_offset: Buffer.byteLength(kept) };
    writeFileSync(join(elsewhere, name), `${meta({ history_base: base })}\n${turn}\n`);
    forgetHistoryChains();
    forgetTranscriptState();
    const away = join(root, "away");
    let opens = 0;
    let swaps = 0;
    const real = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== path || opens++ > 0) return real(...args);
      swaps++;
      renameSync(folder, away);
      renameSync(elsewhere, folder);
      try { return real(...args); }
      finally {
        renameSync(folder, elsewhere);
        renameSync(away, folder);
      }
    }) as typeof fs.openSync);
    try { return { answered: await lookup(path, home), swaps }; }
    finally { spy.mockRestore(); forgetHistoryChains(); forgetTranscriptState(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const otherPng = (() => { const bytes = Buffer.from(png); bytes[bytes.length - 1]! ^= 1; return bytes; })();
const otherUrl = `data:image/png;base64,${otherPng.toString("base64")}`;

it("serves no prompt picture from a parent rollout another session's header names, swapped in around the chain's discovery", async () => {
  const ref = codexImageParts(response("", otherUrl))[0]!.ref;
  const { answered, swaps } = await coldChainSwap([response("", otherUrl)], (path, home) => codexPromptImage(path, ref, "/", home));
  expect(swaps).toBe(1);
  expect(answered !== null && Buffer.from(answered.bytes).equals(otherPng) ? "FOREIGN" : answered).toBeNull();
});

it("serves no tool picture from a parent rollout another session's header names, swapped in around the chain's discovery", async () => {
  const at = "2026-10-26T09:07:06.240Z";
  const records = [
    { type: "response_item", timestamp: at, payload: { type: "custom_tool_call", call_id: "call_p", name: "exec", input: "view" } },
    { type: "response_item", timestamp: at, payload: { type: "custom_tool_call_output", call_id: "call_p", output: [{ type: "input_image", image_url: otherUrl }] } },
  ];
  const { answered, swaps } = await coldChainSwap(records, (path, home) => codexToolImage(path, "codex-tool:call_p:0", home));
  expect(swaps).toBe(1);
  expect(answered !== null && Buffer.from(answered.bytes).equals(otherPng) ? "FOREIGN" : answered).toBeNull();
});

it("serves no local attachment from another folder swapped in around the attachment's own open", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-attachment-swap-"));
  try {
    const assets = join(root, "cwd", "assets");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(assets, { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(join(assets, "shot.png"), png);
    writeFileSync(join(elsewhere, "shot.png"), otherPng);
    const path = join(root, "rollout.jsonl");
    const record = event("", ["assets/shot.png"]);
    writeFileSync(path, `${jsonl(record)}\n`);
    const segments = [{ path, end: Buffer.byteLength(`${jsonl(record)}\n`) }];
    const ref = codexImageParts(record)[0]!.ref;
    const cwd = join(root, "cwd");
    expect(Buffer.from((await codexTranscriptImage(segments, ref, cwd))!.bytes).equals(png)).toBe(true);
    const attachment = join(assets, "shot.png");
    const away = join(root, "away");
    let swaps = 0;
    const swapIn = () => { swaps++; renameSync(assets, away); renameSync(elsewhere, assets); };
    const swapBack = () => { renameSync(assets, elsewhere); renameSync(away, assets); };
    const { openSync } = fs;
    const { open } = fsp;
    const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== attachment) return openSync(...args);
      swapIn();
      try { return openSync(...args); } finally { swapBack(); }
    }) as typeof fs.openSync);
    const asyncOpens = spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] !== attachment) return open(...args);
      swapIn();
      try { return await open(...args); } finally { swapBack(); }
    }) as typeof fsp.open);
    let image: Awaited<ReturnType<typeof codexTranscriptImage>>;
    try { image = await codexTranscriptImage(segments, ref, cwd); } finally { opens.mockRestore(); asyncOpens.mockRestore(); }
    expect(swaps).toBe(1);
    expect(image !== null && Buffer.from(image.bytes).equals(otherPng) ? "FOREIGN" : image).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("serves a local attachment only whole: short reads are read on, and an early end serves nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-attachment-short-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "shot.png"), png);
    const path = join(root, "rollout.jsonl");
    const record = event("", ["assets/shot.png"]);
    writeFileSync(path, `${jsonl(record)}\n`);
    const segments = [{ path, end: Buffer.byteLength(`${jsonl(record)}\n`) }];
    const ref = codexImageParts(record)[0]!.ref;
    const shortReads = (ending: boolean) => {
      let reads = 0;
      const real = fs.read;
      return spyOn(fs, "read").mockImplementation(((...args: unknown[]) => {
        const [fd, buffer, offset, length, position, done] = args as [number, Buffer, number, number, number, (error: Error | null, got: number) => void];
        if (!Buffer.isBuffer(buffer) || buffer.length !== png.length) return (real as (...rest: unknown[]) => void)(...args);
        if (ending && reads++ > 0) { done(null, 0); return; }
        real(fd, buffer, offset, Math.min(length, 16), position, done);
      }) as typeof fs.read);
    };
    const short = shortReads(false);
    let whole: Awaited<ReturnType<typeof codexTranscriptImage>>;
    try { whole = await codexTranscriptImage(segments, ref, root); } finally { short.mockRestore(); }
    expect(whole === null ? null : Buffer.from(whole.bytes).length).toBe(png.length);
    const ended = shortReads(true);
    let cut: Awaited<ReturnType<typeof codexTranscriptImage>>;
    try { cut = await codexTranscriptImage(segments, ref, root); } finally { ended.mockRestore(); }
    expect(cut === null ? null : Buffer.from(cut.bytes).length).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("serves no prompt picture from the parent a replaced rollout's remembered chain still names", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-chain-replaced-"));
  try {
    const home = join(root, "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    const parentDay = join(home, "sessions", "2026", "09", "15");
    const liveDay = join(home, "sessions", "2026", "09", "23");
    mkdirSync(parentDay, { recursive: true });
    mkdirSync(liveDay, { recursive: true });
    const kept = `${meta()}\n${jsonl(response("", otherUrl))}\n`;
    writeFileSync(join(parentDay, `rollout-2026-09-15T12-58-12-${thread}.jsonl`), kept);
    const path = join(liveDay, `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    const turn = jsonl(response("the live turn", data));
    writeFileSync(path, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(kept) } })}\n${turn}\n`);
    const ref = codexImageParts(response("", otherUrl))[0]!.ref;
    forgetHistoryChains();
    expect((await codexPromptImage(path, ref, "/", home))?.mediaType).toBe("image/png");
    writeFileSync(`${path}.new`, `${meta()}\n${turn}\n`);
    renameSync(`${path}.new`, path);
    let image: Awaited<ReturnType<typeof codexPromptImage>>;
    try { image = await codexPromptImage(path, ref, "/", home); } finally { forgetHistoryChains(); }
    expect(image !== null && Buffer.from(image.bytes).equals(otherPng) ? "FROM THE OLD PARENT" : image).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
