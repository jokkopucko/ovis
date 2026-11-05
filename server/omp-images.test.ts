import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationPart } from "../shared/protocol.ts";
import { aroundBlobOpenForTests, blobPlatformForTests, ompBlobAnchor, ompBlobPicture } from "./codex-images.ts";
import { betweenAuthorizationForTests, forgetTranscriptState, ompAuthorizedTranscript, ompTranscriptImage, transcriptPage } from "./conversation.ts";
import { spawnSync } from "node:child_process";
import { heldOpenPlatform, openHeldDirectory } from "./held-open.ts";
import { authorizedTranscript } from "./transcript-store.ts";
import { ompBlobStore } from "./omp.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import { turnStarts } from "./transcript-turns.ts";

// A real omp 18.8.7 session (`omp -p --model openai-codex/gpt-6-luna:medium` in /tmp/omp-pictures):
// `@shot.png` with a question, a `read` of shot.png, and `@shot.png` alone. omp turned the PNG into a
// WebP, moved its bytes to the agent's blob store and wrote `blob:sha256:<digest>` in their place.
const FIXTURE = readFileSync(new URL("./fixtures/omp-pictures-18.8.7-session.jsonl", import.meta.url), "utf8");
const BLOB = readFileSync(new URL("./fixtures/omp-pictures-18.8.7-blob.webp", import.meta.url));
const DIGEST = createHash("sha256").update(BLOB).digest("hex");
const CALL = (JSON.parse(FIXTURE.split("\n").find((line) => line.includes('"toolCall"'))!) as { message: { content: { id: string }[] } }).message.content[0]!.id;

// the real path: a blob store is held to be the directory its path names, and macOS's temporary
// directory is under a link (/var). On Windows it keeps a short 8.3 name where the temporary directory
// has one (GitHub's runners: C:\Users\RUNNER~1), a spelling of the store's path it is served by too
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omp-images-")));
/** A link to the directory `target` at `path`: on Windows a junction, which anyone can make there. */
const linkDirectory = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
/** A Windows directory whose names differ by letter case (fsutil's per-directory flag), or null where this Windows makes none. */
const caseSensitive = ((): string | null => {
  if (process.platform !== "win32") return null;
  const dir = join(root, "case-sensitive");
  mkdirSync(dir);
  return spawnSync("fsutil", ["file", "setCaseSensitiveInfo", dir, "enable"]).status === 0 ? dir : null;
})();
afterAll(() => { rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });

/** An omp agent directory holding one session of `text` and the blobs given, as omp lays them out. */
function store(name: string, text: string, blobs: Record<string, Buffer> = { [DIGEST]: BLOB }): { path: string; blobs: string } {
  const agent = join(root, name, "agent");
  const sessions = join(agent, "sessions", "-tmp-omp-pictures-");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(agent, "blobs"), { recursive: true });
  for (const [digest, bytes] of Object.entries(blobs)) writeFileSync(join(agent, "blobs", digest), bytes);
  const path = join(sessions, "2026-10-26T08-51-22-788Z_01a17768-3e24-721a-81f2-7b29ec922a6d.jsonl");
  writeFileSync(path, text);
  return { path, blobs: join(agent, "blobs") };
}
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
type Pictured = Extract<ConversationPart, { kind: "image" }> | Extract<ConversationPart, { kind: "tool" }>;
/** Every turn's pictures, by ref: a prompt's own, then its tools'. */
const refs = (path: string): string[][] => transcriptPage("omp-transcript", path).turns.map((turn) => turn.parts.flatMap((part) => {
  const pictured = part as Pictured;
  return pictured.kind === "image" ? [`${pictured.media_type} ${pictured.ref}`] : pictured.kind === "tool" ? (pictured.images ?? []).map((image) => `${image.media_type} ${image.ref}`) : [];
}));
const served = async (path: string, ref: string) => {
  const image = await ompTranscriptImage(path, ref);
  return image === null ? null : { mediaType: image.mediaType, same: Buffer.from(image.bytes).equals(BLOB) };
};

// the records as omp 18.8.7 writes them, for cases the recording does not hold
const at = "2026-10-26T08:51:46.656Z";
const picture = (digest = DIGEST, mimeType = "image/webp") => ({ type: "image", data: `blob:sha256:${digest}`, mimeType });
const prompt = (id: string, content: unknown[]) => ({ type: "message", id, parentId: null, timestamp: at, message: { role: "user", content, attribution: "user", timestamp: 1 } });
const call = (entry: string, id: string) => ({ type: "message", id: entry, parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "shot.png" } }], stopReason: "toolUse", timestamp: 2 } });
const result = (entry: string, id: string, content: unknown[]) => ({ type: "message", id: entry, parentId: "a1", timestamp: at, message: { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 3 } });
const answer = (entry: string, text: string) => ({ type: "message", id: entry, parentId: "r1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 4 } });
const clear = { type: "custom", customType: "context_clear", id: "x1", parentId: "a2", timestamp: at };

// omp's blob pictures are read through a held store (openBlob, held-open.ts), which Linux, macOS and
// Windows offer; elsewhere they are refused by design, a branch run here with blobPlatformForTests
describe.skipIf(!heldOpenPlatform(process.platform))("omp's pictures reach the chat", () => {
  it("names the recorded session's prompt and tool pictures by ref only, and serves their exact bytes", async () => {
    const { path } = store("recorded", FIXTURE);
    expect(refs(path)).toEqual([
      ["image/webp pi-prompt:d4a9dbba:0"], [],
      [], [`image/webp pi:${CALL}:0`],
      ["image/webp pi-prompt:faaa5772:0"], [],
    ]);
    // only refs reach the page: no picture bytes, and no blob ref either
    const page = JSON.stringify(transcriptPage("omp-transcript", path));
    expect(page).not.toContain(BLOB.toString("base64").slice(0, 32));
    expect(page).not.toContain("blob:sha256");
    for (const ref of ["pi-prompt:d4a9dbba:0", `pi:${CALL}:0`, "pi-prompt:faaa5772:0"]) expect(await served(path, ref)).toEqual({ mediaType: "image/webp", same: true });
    // no picture at that place, an entry with none, a ref that is no ref
    for (const ref of ["pi-prompt:d4a9dbba:1", `pi:${CALL}:1`, "pi-prompt:5cd289cf:0", "pi-prompt:d4a9dbba", `pi:${CALL.split("|")[0]}:0`, "pi-prompt:../d4a9dbba:0"]) expect(await ompTranscriptImage(path, ref)).toBeNull();
  });

  it("finds the blob store beside omp's managed store, and none for a session directory of its own", () => {
    const at = (...parts: string[]) => {
      const file = join(root, "layouts", ...parts);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "");
      return file;
    };
    const agent = join(root, "layouts", "home", ".omp", "agent");
    mkdirSync(join(agent, "blobs"), { recursive: true });
    expect(ompBlobStore(at("home", ".omp", "agent", "sessions", "-home-u-p-", "s.jsonl"))).toBe(join(agent, "blobs"));
    // a subagent's file, a level below its parent session
    expect(ompBlobStore(at("home", ".omp", "agent", "sessions", "-home-u-p-", "s", "sub.jsonl"))).toBe(join(agent, "blobs"));
    // omp's XDG data directory keeps both side by side, with no `agent` level
    mkdirSync(join(root, "layouts", "data", "omp", "blobs"), { recursive: true });
    expect(ompBlobStore(at("data", "omp", "sessions", "-home-u-p-", "s.jsonl"))).toBe(join(root, "layouts", "data", "omp", "blobs"));
    // a store not made yet is named by the layout all the same (its blobs are asked for when read),
    // and a session directory of its own names none
    expect(ompBlobStore(at("bare", "sessions", "-home-u-p-", "s.jsonl"))).toBe(join(root, "layouts", "bare", "blobs"));
    expect(ompBlobStore(at("own-dir", "s.jsonl"))).toBeNull();
    expect(ompBlobStore(join(root, "layouts", "nowhere", "sessions", "-p-", "s.jsonl"))).toBeNull();
  });

  it("names and serves a blob only when its bytes are the picture the transcript recorded", async () => {
    const records = jsonl(prompt("u1", [{ type: "text", text: "look" }, picture()]), answer("a1", "a webp"));
    const ok = store("blob-ok", records);
    expect(refs(ok.path)).toEqual([["image/webp pi-prompt:u1:0"], []]);
    // no blob: the prompt's words stay, with no picture named
    const missing = store("blob-missing", records, {});
    expect(refs(missing.path)).toEqual([[], []]);
    expect(await ompTranscriptImage(missing.path, "pi-prompt:u1:0")).toBeNull();
    // bytes that do not hash to the name the transcript gave them
    const tampered = store("blob-tampered", records, { [DIGEST]: Buffer.concat([BLOB, Buffer.from("x")]) });
    expect(refs(tampered.path)).toEqual([[], []]);
    expect(await ompTranscriptImage(tampered.path, "pi-prompt:u1:0")).toBeNull();
    // a link in the store is not followed, even to the right bytes
    const linked = store("blob-linked", records, {});
    writeFileSync(join(root, "elsewhere.webp"), BLOB);
    symlinkSync(join(root, "elsewhere.webp"), join(linked.blobs, DIGEST));
    expect(ompBlobPicture(linked.blobs, "image/webp", `blob:sha256:${DIGEST}`)).toBeNull();
    expect(await ompTranscriptImage(linked.path, "pi-prompt:u1:0")).toBeNull();
  });

  it("names and serves nothing from a blob store that is a link, even to another omp's real store", async () => {
    const records = jsonl(prompt("u1", [{ type: "text", text: "look" }, picture()]), answer("a1", "a webp"));
    const other = store("blob-dir-real", records);
    // this session's agent directory keeps no store of its own: its `blobs` is a link to another's
    const linked = store("blob-dir-linked", records, {});
    rmSync(linked.blobs, { recursive: true });
    linkDirectory(other.blobs, linked.blobs);
    // named by the layout, and refused where a blob is read: no picture in the page, none served
    expect(ompBlobStore(linked.path)).toBe(linked.blobs);
    expect(refs(linked.path)).toEqual([[], []]);
    expect(await ompTranscriptImage(linked.path, "pi-prompt:u1:0")).toBeNull();
    // a store that becomes a link after it was found is refused where the blob is read
    expect(ompBlobPicture(linked.blobs, "image/webp", `blob:sha256:${DIGEST}`)).toBeNull();
    expect(ompBlobPicture(other.blobs, "image/webp", `blob:sha256:${DIGEST}`)?.mediaType).toBe("image/webp");
    expect(await served(other.path, "pi-prompt:u1:0")).toEqual({ mediaType: "image/webp", same: true });
  });

  it("names a picture once omp makes its store, live as in a cold read", async () => {
    const first = jsonl(prompt("u1", [{ type: "text", text: "read it" }]), call("a1", "c1"));
    const { path, blobs } = store("store-later", first, {});
    // a fresh omp: no store yet when the page is first read
    rmSync(blobs, { recursive: true });
    expect(refs(path).flat()).toEqual([]);
    mkdirSync(blobs);
    writeFileSync(join(blobs, DIGEST), BLOB);
    appendFileSync(path, jsonl(result("r1", "c1", [picture()]), answer("a2", "done")));
    const live = refs(path);
    forgetTranscriptState();
    expect(live).toEqual(refs(path));
    expect(live.flat()).toEqual(["image/webp pi:c1:0"]);
    expect(await served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
  });

  it("serves nothing when a link to another store is swapped in as the store or the blob is opened", async () => {
    const records = jsonl(prompt("u1", [{ type: "text", text: "look" }, picture()]), answer("a1", "a webp"));
    // the other omp's store holds the blob; this one's does not
    const other = store("swap-other", records);
    const own = store("swap-own", records, {});
    const agent = join(own.blobs, "..");
    // the store, or the agent directory above it, is put aside and a link to the other omp's takes its
    // place just for one open, then put back before the read is checked again
    const swaps = [
      { at: "blob", place: own.blobs, link: other.blobs },
      { at: "store", place: own.blobs, link: other.blobs },
      { at: "store", place: agent, link: join(other.blobs, "..") },
    ] as const;
    for (const swap of swaps) {
      let swapped = 0;
      aroundBlobOpenForTests((opening, open) => {
        if (opening !== swap.at) return open();
        renameSync(swap.place, `${swap.place}-aside`);
        linkDirectory(swap.link, swap.place);
        swapped += 1;
        try { return open(); } finally { unlinkSync(swap.place); renameSync(`${swap.place}-aside`, swap.place); }
      });
      try {
        expect([swap.at, swap.place === agent, ompBlobPicture(own.blobs, "image/webp", `blob:sha256:${DIGEST}`)]).toEqual([swap.at, swap.place === agent, null]);
        expect(swapped).toBe(1);
      } finally { aroundBlobOpenForTests(null); }
    }
    // the other store itself, a real directory, moved into this one's place as the store is opened,
    // and both put back before the blob is opened through it
    let moves = 0;
    aroundBlobOpenForTests((opening, open) => {
      if (opening === "store") {
        renameSync(own.blobs, `${own.blobs}-aside`);
        renameSync(other.blobs, own.blobs);
      } else {
        renameSync(own.blobs, other.blobs);
        renameSync(`${own.blobs}-aside`, own.blobs);
      }
      moves += 1;
      return open();
    });
    try {
      expect(ompBlobPicture(own.blobs, "image/webp", `blob:sha256:${DIGEST}`)).toBeNull();
    } finally {
      aroundBlobOpenForTests(null);
      // a refusal at the store's open leaves the move half done: put both stores back
      if (moves === 1) { renameSync(own.blobs, other.blobs); renameSync(`${own.blobs}-aside`, own.blobs); }
    }
    expect(moves).toBeGreaterThanOrEqual(1);
    // the agent directory above the store is a link to the other omp's for the whole read: the store
    // checks and opens alike go through it, so only where the opened store really is tells them apart
    renameSync(agent, `${agent}-aside`);
    linkDirectory(join(other.blobs, ".."), agent);
    try {
      expect(ompBlobPicture(own.blobs, "image/webp", `blob:sha256:${DIGEST}`)).toBeNull();
    } finally { unlinkSync(agent); renameSync(`${agent}-aside`, agent); }
    expect(await ompTranscriptImage(own.path, "pi-prompt:u1:0")).toBeNull();
    // the other store, untouched, still serves its own picture
    expect(await served(other.path, "pi-prompt:u1:0")).toEqual({ mediaType: "image/webp", same: true });
  });

  it("reads a blob only from the store authorized with the transcript, whatever the path above it names later", async () => {
    // two omps' sessions at the same place in their own agent directories; only the other one holds the blob
    const records = jsonl(prompt("u1", [{ type: "text", text: "look" }, picture()]), answer("a1", "a webp"));
    const other = store("anchor-other", records);
    const own = store("anchor-own", records, {});
    // the store's identity is taken from the objects authorized with the transcript
    const sessions = (blobs: string) => join(blobs, "..", "sessions");
    const authorized = ompAuthorizedTranscript(authorizedTranscript(own.path, sessions(own.blobs))!);
    expect(authorized).toEqual({ path: own.path, blobs: ompBlobAnchor(own.blobs)!.identity });
    expect(authorized.blobs).not.toBe(ompBlobAnchor(other.blobs)!.identity);
    // after the transcript was authorized, this omp's agent directory becomes a link to the other's
    const agent = join(own.blobs, "..");
    renameSync(agent, `${agent}-aside`);
    linkDirectory(join(other.blobs, ".."), agent);
    try {
      expect(await ompTranscriptImage(authorized.path, "pi-prompt:u1:0", authorized.blobs)).toBeNull();
      // the same read with no authorized store serves nothing either
      expect(await ompTranscriptImage(authorized.path, "pi-prompt:u1:0", null)).toBeNull();
    } finally { unlinkSync(agent); renameSync(`${agent}-aside`, agent); }
    expect(await served(other.path, "pi-prompt:u1:0")).toEqual({ mediaType: "image/webp", same: true });
    // a transcript whose store is missing is authorized with none
    const bare = store("anchor-bare", records, {});
    rmSync(bare.blobs, { recursive: true });
    expect(ompAuthorizedTranscript(authorizedTranscript(bare.path, sessions(bare.blobs))!)).toEqual({ path: bare.path, blobs: null });
    // once the data directory is held, this omp's agent directory becomes a link to the other's: the store
    // is still reached through the held directory, this omp's own
    const checked = authorizedTranscript(own.path, sessions(own.blobs))!;
    const ownIdentity = ompBlobAnchor(own.blobs)!.identity;
    const otherAgent = join(other.blobs, "..");
    betweenAuthorizationForTests((stage) => { if (stage !== "after") return; renameSync(agent, `${agent}-aside`); linkDirectory(join(other.blobs, ".."), agent); });
    try {
      expect(ompAuthorizedTranscript(checked)).toEqual({ path: own.path, blobs: ownIdentity });
    } finally { betweenAuthorizationForTests(null); unlinkSync(agent); renameSync(`${agent}-aside`, agent); }
    // before the data directory is opened, this omp's sessions moved into the other agent directory and
    // that directory moved to this one's path: the arrangement then is the one trusted, and the transcript
    // and the blob store both come from the one data directory now at that path
    let consistent: string | undefined;
    betweenAuthorizationForTests((stage) => {
      if (stage !== "before") return;
      renameSync(sessions(other.blobs), `${sessions(other.blobs)}-aside`);
      renameSync(sessions(own.blobs), sessions(other.blobs));
      renameSync(agent, `${agent}-aside`);
      renameSync(otherAgent, agent);
      consistent = ompBlobAnchor(own.blobs)!.identity;
    });
    try {
      expect(ompAuthorizedTranscript(checked)).toEqual({ path: own.path, blobs: consistent! });
      expect(consistent).not.toBe(ownIdentity);
    } finally {
      betweenAuthorizationForTests(null);
      renameSync(agent, otherAgent);
      renameSync(`${agent}-aside`, agent);
      renameSync(sessions(other.blobs), sessions(own.blobs));
      renameSync(`${sessions(other.blobs)}-aside`, sessions(other.blobs));
    }
    // this omp's sessions moved under the other's agent directory, and the two agent directories swapped
    // names: the held data directory has no sessions left, and nothing is anchored
    betweenAuthorizationForTests((stage) => { if (stage !== "after") return;
      renameSync(sessions(other.blobs), `${sessions(other.blobs)}-aside`);
      renameSync(sessions(own.blobs), sessions(other.blobs));
      renameSync(agent, `${agent}-aside`);
      renameSync(otherAgent, agent);
    });
    try {
      expect(ompAuthorizedTranscript(checked)).toEqual({ path: own.path, blobs: null });
    } finally {
      betweenAuthorizationForTests(null);
      renameSync(agent, otherAgent);
      renameSync(`${agent}-aside`, agent);
      renameSync(sessions(other.blobs), sessions(own.blobs));
      renameSync(`${sessions(other.blobs)}-aside`, sessions(other.blobs));
    }
    // and another real store moved into this one's place there is refused the same way
    const sessionsDir = sessions(own.blobs);
    betweenAuthorizationForTests((stage) => { if (stage !== "after") return; renameSync(sessionsDir, `${sessionsDir}-aside`); renameSync(sessions(other.blobs), sessionsDir); });
    try {
      expect(ompAuthorizedTranscript(checked)).toEqual({ path: own.path, blobs: null });
    } finally { betweenAuthorizationForTests(null); renameSync(sessionsDir, sessions(other.blobs)); renameSync(`${sessionsDir}-aside`, sessionsDir); }
    expect(ompAuthorizedTranscript(checked)).toEqual({ path: own.path, blobs: ompBlobAnchor(own.blobs)!.identity });
  });

  // a `:` names a file's stream only on Windows: elsewhere it is a name like any other
  it.skipIf(process.platform === "win32")("anchors the store of a session whose file name holds a colon", () => {
    const { path, blobs } = store("colon-name", jsonl(prompt("u1", [picture()]), answer("a1", "a webp")));
    const named = join(path, "..", "named:session.jsonl");
    renameSync(path, named);
    expect(ompAuthorizedTranscript(authorizedTranscript(named, join(blobs, "..", "sessions"))!)).toEqual({ path: named, blobs: ompBlobAnchor(blobs)!.identity });
  });

  it.skipIf(process.platform !== "win32")("serves a store named by another spelling of its path: a short 8.3 name, another letter case", async () => {
    const { blobs } = store("a-store-of-a-long-name", jsonl(prompt("u1", [picture()])));
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel = dlopen("kernel32.dll", { GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
    const answer = Buffer.alloc(2 * 32_768);
    const units = kernel.symbols.GetShortPathNameW(Buffer.from(`${blobs}\0`, "utf16le"), answer, 32_768);
    kernel.close();
    const short = answer.toString("utf16le", 0, units * 2);
    // a volume that makes no short names gives the path back as it is
    expect(short === blobs || short.includes("~")).toBe(true);
    // only this test's own ASCII name changes case: the temporary directory keeps its spelling
    const cased = (name: string) => blobs.replace("a-store-of-a-long-name", name);
    for (const spelling of [short, cased("A-STORE-OF-A-LONG-NAME"), cased("A-Store-Of-A-Long-Name")]) {
      expect([spelling, ompBlobPicture(spelling, "image/webp", `blob:sha256:${DIGEST}`)?.mediaType]).toEqual([spelling, "image/webp"]);
    }
  });

  it.skipIf(process.platform !== "win32")("holds a store to its path only when every name on it is walked: no `/`, no device path", () => {
    const real = join(root, "walk-real");
    mkdirSync(join(real, "agent", "blobs"), { recursive: true });
    linkDirectory(real, join(root, "walk-link"));
    const store = openHeldDirectory(join(real, "agent", "blobs"));
    try {
      // the link's names written with `/`, which Windows reads as `\`, or under the device namespace:
      // a root parsed from either would open the link unseen
      const hidden = [`${join(root, "walk-link")}/agent\\blobs`, `\\\\.\\${join(root, "walk-link", "agent", "blobs")}`, join(root, "walk-link", "agent", "blobs")];
      expect([store.isAt(join(real, "agent", "blobs")), ...hidden.map((path) => store.isAt(path))]).toEqual([true, false, false, false]);
    } finally { store.close(); }
  });

  it.skipIf(caseSensitive === null)("holds a store to its own name where letter case tells two directories apart", () => {
    const dir = caseSensitive!;
    mkdirSync(join(dir, "Box"));
    mkdirSync(join(dir, "box"));
    // a junction whose name differs from its target's only by case
    mkdirSync(join(dir, "AGENT", "blobs"), { recursive: true });
    linkDirectory(join(dir, "AGENT"), join(dir, "agent"));
    const isAt = (held: string, named: string) => { const store = openHeldDirectory(held); try { return store.isAt(named); } finally { store.close(); } };
    expect([isAt(join(dir, "box"), join(dir, "box")), isAt(join(dir, "box"), join(dir, "Box")), isAt(join(dir, "AGENT", "blobs"), join(dir, "agent", "blobs"))]).toEqual([true, false, false]);
  });

  it("reads no omp blob where no directory can be held and opened through, and shows the inline pictures still", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const { path } = store("no-descriptor-open", jsonl(prompt("u1", [{ type: "text", text: "two" }, { type: "image", mimeType: "image/png", data: png.toString("base64") }, picture()]), answer("a1", "both")));
    blobPlatformForTests("freebsd");
    try {
      forgetTranscriptState();
      // the blob keeps its place, empty: the inline picture before it is named and served as ever
      expect(refs(path)).toEqual([["image/png pi-prompt:u1:0"], []]);
      expect((await ompTranscriptImage(path, "pi-prompt:u1:0"))?.mediaType).toBe("image/png");
      expect(await ompTranscriptImage(path, "pi-prompt:u1:1")).toBeNull();
    } finally { blobPlatformForTests(null); forgetTranscriptState(); }
    expect(refs(path)).toEqual([["image/png pi-prompt:u1:0", "image/webp pi-prompt:u1:1"], []]);
  });

  it("never holds the event loop for more than a few windows, however many small records it judges", async () => {
    // 30,000 short answers that each name the call in their words, so the search hands every one to be
    // judged, over 40 MiB, so the cold scan for clears takes several windows too
    const words = "call c1 again ".repeat(90);
    const many = Array.from({ length: 30_000 }, (_, at) => answer(`n${at}`, words));
    const { path } = store("many-records", jsonl(prompt("u1", [{ type: "text", text: "read it" }]), ...many, call("a1", "c1"), result("r1", "c1", [picture()]), answer("a2", "done")));
    forgetTranscriptState();
    // work between two turns of the loop, counted in buffers taken rather than in time: a window read is
    // one, a record judged is one or two
    let since = 0, sinceLarge = 0, most = 0, mostLarge = 0, total = 0;
    const real = Buffer.alloc.bind(Buffer);
    const counting = spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => {
      since += 1;
      total += 1;
      if (Number(args[0]) >= 1024 * 1024) sinceLarge += 1;
      return real(...args);
    }) as typeof Buffer.alloc);
    let looking = true;
    const turn = () => {
      most = Math.max(most, since); mostLarge = Math.max(mostLarge, sinceLarge);
      since = 0; sinceLarge = 0;
      if (looking) setImmediate(turn);
    };
    try {
      setImmediate(turn);
      expect(await served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
    } finally {
      looking = false;
      most = Math.max(most, since); mostLarge = Math.max(mostLarge, sinceLarge);
      counting.mockRestore();
    }
    // a reader that judged every record, or scanned every window for clears, before the loop's next turn
    // would take thousands of buffers, or every window, in one stretch
    // the count is live: judging 30,000 records takes far more buffers than any one stretch may
    expect(total).toBeGreaterThan(30_000);
    expect(mostLarge).toBeLessThanOrEqual(2);
    expect(most).toBeLessThanOrEqual(400);
    // counts, not time, are asserted: a 40 MiB transcript of 30,000 records takes about 4 s on Windows
  }, 30_000);

  it("lets the event loop run between windows while it looks through a large transcript", async () => {
    const pad = "x".repeat(20 * 1024 * 1024);
    const { path } = store("event-loop", jsonl(prompt("u1", [{ type: "text", text: "read it" }]), answer("n1", pad), call("a1", "c1"), result("r1", "c1", [picture()]), answer("a2", "done")));
    // warm, as the page's own read has already scanned the transcript for clears
    expect(await served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
    let turns = 0;
    let looking = true;
    const turn = () => { if (looking) { turns += 1; setImmediate(turn); } };
    setImmediate(turn);
    expect(await served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
    looking = false;
    // a reader that held the loop for the whole search would let it turn once, at the end
    expect(turns).toBeGreaterThanOrEqual(20);
  });

  it("names only a raster the chat shows, by its declared type and its bytes, up to 8 MiB", async () => {
    const blob = (bytes: Buffer) => ({ digest: createHash("sha256").update(bytes).digest("hex"), bytes });
    const svg = blob(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    const png = (size: number) => { const bytes = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); return blob(bytes); };
    const exact = png(8 * 1024 * 1024);
    const over = png(8 * 1024 * 1024 + 1);
    const { path } = store("blob-types", jsonl(prompt("u1", [
      { type: "text", text: "these" },
      picture(svg.digest, "image/png"),
      picture(DIGEST, "image/svg+xml"),
      picture(over.digest, "image/png"),
      picture(exact.digest, "image/png"),
      // a ref that is no digest omp writes: never read
      { type: "image", data: "blob:sha256:../../etc/passwd", mimeType: "image/png" },
      { type: "image", data: `blob:sha256:${DIGEST.toUpperCase()}`, mimeType: "image/webp" },
      picture(),
    ]), answer("a1", "two")), { [DIGEST]: BLOB, [svg.digest]: svg.bytes, [exact.digest]: exact.bytes, [over.digest]: over.bytes });
    // a blob ref in omp's form keeps its place whatever its blob holds, shown as nothing when that is
    // no picture; a block naming no blob omp writes, or no raster, takes none
    expect(refs(path)).toEqual([["image/png pi-prompt:u1:2", "image/webp pi-prompt:u1:3"], []]);
    expect(await ompTranscriptImage(path, "pi-prompt:u1:0")).toBeNull();
    expect(await ompTranscriptImage(path, "pi-prompt:u1:1")).toBeNull();
    expect((await ompTranscriptImage(path, "pi-prompt:u1:2"))?.bytes.length).toBe(8 * 1024 * 1024);
    expect(await served(path, "pi-prompt:u1:3")).toEqual({ mediaType: "image/webp", same: true });
    expect(await ompTranscriptImage(path, "pi-prompt:u1:4")).toBeNull();
  });

  it("keeps a picture's place when its blob goes or changes, and serves nothing in its place", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const gifDigest = createHash("sha256").update(gif).digest("hex");
    const text = jsonl(prompt("u1", [{ type: "text", text: "two" }, picture(), picture(gifDigest, "image/gif")]), answer("a1", "both"));
    const { path, blobs } = store("blob-gone", text, { [DIGEST]: BLOB, [gifDigest]: gif });
    // parsed again as a poll does, through the answers the parser keeps for each blob
    const parsed = () => parseOmpTranscript(text, Infinity, { images: true, blobs }).map((turn) => turn.parts.flatMap((part) => part.kind === "image" ? [`${part.media_type} ${part.ref}`] : []));
    expect(refs(path)).toEqual([["image/webp pi-prompt:u1:0", "image/gif pi-prompt:u1:1"], []]);
    expect(parsed()).toEqual(refs(path));
    // the first blob goes while the bridge runs: its place stays, empty, and the gif keeps its own
    rmSync(join(blobs, DIGEST));
    expect(parsed()).toEqual([["image/gif pi-prompt:u1:1"], []]);
    expect(await ompTranscriptImage(path, "pi-prompt:u1:0")).toBeNull();
    expect((await ompTranscriptImage(path, "pi-prompt:u1:1"))?.mediaType).toBe("image/gif");
    // the gif's blob becomes a link to the same bytes: no longer a blob omp wrote, so neither names it
    writeFileSync(join(root, "gif-elsewhere"), gif);
    rmSync(join(blobs, gifDigest));
    symlinkSync(join(root, "gif-elsewhere"), join(blobs, gifDigest));
    expect(parsed()).toEqual([[], []]);
    expect(await ompTranscriptImage(path, "pi-prompt:u1:1")).toBeNull();
  });

  it("checks a blob it does not serve a window at a time, and holds only the served one whole", async () => {
    const big = (fill: number) => { const bytes = Buffer.alloc(3 * 1024 * 1024, fill); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); return bytes; };
    const [first, second] = [big(1), big(2)];
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const { path } = store("blob-large", jsonl(prompt("u1", [{ type: "text", text: "two large" }, picture(digest(first), "image/png"), picture(digest(second), "image/png")]), answer("a1", "both")),
      { [digest(first)]: first, [digest(second)]: second });
    const alloc = spyOn(Buffer, "alloc");
    try {
      forgetTranscriptState();
      expect(refs(path)).toEqual([["image/png pi-prompt:u1:0", "image/png pi-prompt:u1:1"], []]);
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(1024 * 1024);
      forgetTranscriptState();
      alloc.mockClear();
      expect(Buffer.from((await ompTranscriptImage(path, "pi-prompt:u1:1"))!.bytes).equals(second)).toBe(true);
      // the served picture is the one allocation past a window
      expect(alloc.mock.calls.map(([size]) => Number(size)).filter((size) => size > 1024 * 1024)).toEqual([second.length]);
    } finally { alloc.mockRestore(); }
  });

  it("counts an inline picture before the one it serves as the parser does, its text written with escapes", async () => {
    const png = (fill: number, size: number) => { const bytes = Buffer.alloc(size, fill); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); return bytes; };
    const first = png(1, 2 * 1024 * 1024);
    const second = png(2, 1000);
    const inline = (bytes: Buffer) => ({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
    // a JSON writer may escape every `/`, and the first picture's text crosses the endpoint's windows
    const text = jsonl(prompt("u1", [{ type: "text", text: "two inline" }, inline(first), { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }, inline(second)]), answer("a1", "both")).replaceAll("/", "\\/");
    const { path } = store("inline-escaped", text);
    expect(refs(path)).toEqual([["image/png pi-prompt:u1:0", "image/png pi-prompt:u1:1"], []]);
    expect(Buffer.from((await ompTranscriptImage(path, "pi-prompt:u1:0"))!.bytes).equals(first)).toBe(true);
    expect(Buffer.from((await ompTranscriptImage(path, "pi-prompt:u1:1"))!.bytes).equals(second)).toBe(true);
    expect(await ompTranscriptImage(path, "pi-prompt:u1:2")).toBeNull();
  });

  it("shows a prompt that is only a picture as its own turn, and opens a page there", async () => {
    const records = [prompt("u1", [{ type: "text", text: "first" }]), answer("a1", "one"), prompt("u2", [picture()]), answer("a2", "two")];
    const { path, blobs } = store("picture-only", jsonl(...records));
    expect(refs(path)).toEqual([[], [], ["image/webp pi-prompt:u2:0"], []]);
    expect(transcriptPage("omp-transcript", path).turns[2]!.parts.map((part) => part.kind)).toEqual(["image"]);
    expect(await served(path, "pi-prompt:u2:0")).toEqual({ mediaType: "image/webp", same: true });
    const rows = records.map((row) => JSON.stringify(row));
    const bytes = Buffer.from(rows.join("\n"));
    const second = rows[0]!.length + rows[1]!.length + 2;
    expect(turnStarts(bytes, "omp-transcript", undefined, blobs)).toEqual([0, second]);
    // with no blob to show, it is no turn the parser draws, and opens none
    expect(turnStarts(bytes, "omp-transcript", undefined, join(root, "no-blobs"))).toEqual([0]);
  });

  it("serves a tool's picture only from the result the page draws: the first one answering a call it shows", async () => {
    const shown = [prompt("u1", [{ type: "text", text: "read it" }]), call("a1", "c1")];
    // a second result for an answered call
    const twice = store("tool-twice", jsonl(...shown, result("r1", "c1", [{ type: "text", text: "nothing" }]), result("r2", "c1", [picture()]), answer("a2", "done")));
    expect(refs(twice.path).flat()).toEqual([]);
    expect(await ompTranscriptImage(twice.path, "pi:c1:0")).toBeNull();
    // a result answering no call the page draws
    const orphan = store("tool-orphan", jsonl(...shown, result("r1", "c2", [picture()]), answer("a2", "done")));
    expect(refs(orphan.path).flat()).toEqual([]);
    expect(await ompTranscriptImage(orphan.path, "pi:c2:0")).toBeNull();
    // a call made again after an answer with no picture: the second answer's picture is the one named
    const again = store("tool-again", jsonl(...shown, result("r1", "c1", [{ type: "text", text: "nothing" }]), call("a2", "c1"), result("r2", "c1", [picture()]), answer("a3", "done")));
    expect(refs(again.path).flat()).toEqual(["image/webp pi:c1:0"]);
    expect(await served(again.path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
  });

  it("puts a picture from before a clear out of reach, a clear however JSON writes it", async () => {
    const records = jsonl(prompt("u1", [{ type: "text", text: "read it" }, picture()]), call("a1", "c1"), result("r1", "c1", [picture()]), answer("a2", "done"), clear);
    const cleared = store("cleared", records);
    expect(transcriptPage("omp-transcript", cleared.path).turns).toEqual([]);
    expect(await ompTranscriptImage(cleared.path, "pi-prompt:u1:0")).toBeNull();
    expect(await ompTranscriptImage(cleared.path, "pi:c1:0")).toBeNull();
    const escaped = store("cleared-escaped", records.replace('"customType":"context_clear"', '"customType":"context\\u005fclear"'));
    expect(transcriptPage("omp-transcript", escaped.path).turns).toEqual([]);
    expect(await ompTranscriptImage(escaped.path, "pi-prompt:u1:0")).toBeNull();
    expect(await ompTranscriptImage(escaped.path, "pi:c1:0")).toBeNull();
  });

  it("reads a call id and an entry id however JSON writes them, as the parser does", async () => {
    // omp's own call ids hold a `|`; here it and a letter are written as escapes
    const text = FIXTURE.replaceAll(JSON.stringify(CALL), JSON.stringify(CALL).replace("|", "\\u007c").replace("call_", "\\u0063all_"))
      .replace('"id":"d4a9dbba"', '"id":"\\u00644a9dbba"');
    expect(text).toContain("\\u007c");
    const { path } = store("escaped-ids", text);
    expect(refs(path)[0]).toEqual(["image/webp pi-prompt:d4a9dbba:0"]);
    expect(refs(path)[3]).toEqual([`image/webp pi:${CALL}:0`]);
    expect(await served(path, "pi-prompt:d4a9dbba:0")).toEqual({ mediaType: "image/webp", same: true });
    expect(await served(path, `pi:${CALL}:0`)).toEqual({ mediaType: "image/webp", same: true });
  });

  it("names the same pictures as a session grows as a cold read does", () => {
    const lines = FIXTURE.split("\n");
    const cut = lines.findIndex((line) => line.includes('"toolResult"'));
    const { path } = store("growing", lines.slice(0, cut).join("\n") + "\n");
    expect(refs(path).flat()).toEqual(["image/webp pi-prompt:d4a9dbba:0"]);
    appendFileSync(path, lines.slice(cut).join("\n"));
    const warm = refs(path);
    forgetTranscriptState();
    expect(warm).toEqual(refs(path));
    expect(warm.flat()).toEqual(["image/webp pi-prompt:d4a9dbba:0", `image/webp pi:${CALL}:0`, "image/webp pi-prompt:faaa5772:0"]);
  });

  it("holds a window, a record's shape and the picture, never a record whole however large", async () => {
    const alloc = spyOn(Buffer, "alloc");
    try {
      const pad = "x".repeat(20 * 1024 * 1024);
      // a call and its result, each padded past the largest picture the chat shows
      const { path } = store("large", jsonl(prompt("u1", [{ type: "text", text: "read it" }]),
        { ...call("a1", "c1"), message: { ...call("a1", "c1").message, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "shot.png", pad } }] } },
        result("r1", "c1", [{ type: "text", text: pad }, picture()]), answer("a2", "done")));
      // the first read scans the history once; the endpoint's own reads are what is left
      expect(await served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
      alloc.mockClear();
      expect(await served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(1024 * 1024);
    } finally { alloc.mockRestore(); }
    // the allocation is asserted, not time: writing and twice reading 40 MiB takes about 4.5 s on Windows
  }, 30_000);
});
