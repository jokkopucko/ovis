import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";

import type { Access } from "./access.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { copyFileAttributes } from "./file-attributes.ts";
import { MAX_TEXT_SAVE_BODY_BYTES, textEditAllowed, textSaveHooks } from "./file-edit.ts";
import { setFilePoolOptions } from "./file-pool.ts";
import { runFileTask } from "./file-tasks.ts";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { MAX_EDITABLE_TEXT_BYTES, type EditableText } from "../shared/files.ts";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Linux's own calls and outcomes (libc.so.6, /proc/self/fd): macOS saves by its own proof, Windows not at all
describe.skipIf(process.platform !== "linux")("editing a text file (#771)", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let folder: string;
  let outside: string;
  let paneCwd: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const q = (value: string) => encodeURIComponent(value);
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
  const open = (path: string) => fetch(url(`/api/fs/text?pane_id=w1:p1&path=${q(path)}`));
  const save = (path: string, revision: string, text: string, headers: Record<string, string> = {}) => fetch(url("/api/fs/text"), {
    method: "PUT", headers: { origin: url(""), "content-type": "application/json", ...headers },
    body: JSON.stringify({ pane_id: "w1:p1", path, revision, text }),
  });
  const file = (relative: string, content: string | Uint8Array, mode?: number): string => {
    const path = join(folder, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined) chmodSync(path, mode);
    return path;
  };
  let paneGet: ReturnType<typeof spyOn>;

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-file-edit-"));
    folder = join(stateDir, "project");
    outside = join(stateDir, "outside");
    mkdirSync(folder);
    mkdirSync(outside);
    paneCwd = folder;
    paneGet = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => ({ pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", cwd: paneCwd, agent_status: "idle" }) as unknown as Awaited<ReturnType<typeof herdr.paneGet>>);
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
    setFilePoolOptions({ inline: runFileTask });
  });
  afterEach(() => {
    delete textSaveHooks.beforeRename;
    delete textSaveHooks.platform;
    paneCwd = folder;
  });
  afterAll(() => {
    setFilePoolOptions();
    server.stop();
    paneGet.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("opens a file in the pane's folder and saves it in its place, with its mode and nothing left beside it", async () => {
    const notes = file("docs/notes.md", "# Notes\n", 0o640);
    const opened = await open("docs/notes.md");
    expect(opened.status).toBe(200);
    const body = await opened.json() as EditableText;
    expect(body).toMatchObject({ path: notes, text: "# Notes\n", revision: sha("# Notes\n"), line_endings: "lf", size: 8 });
    const saved = await save(body.path, body.revision, "# Notes\n\nDone.\n");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ path: notes, revision: sha("# Notes\n\nDone.\n"), size: 15 });
    expect(readFileSync(notes, "utf8")).toBe("# Notes\n\nDone.\n");
    expect(statSync(notes).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(folder, "docs"))).toEqual(["notes.md"]);
  });

  it("reads on a file thread, and a long name saves too", async () => {
    setFilePoolOptions();
    try {
      const long = file(`${"n".repeat(240)}.md`, "long\n");
      const body = await (await open(long)).json() as EditableText;
      expect((await save(long, body.revision, "longer\n")).status).toBe(200);
      expect(readFileSync(long, "utf8")).toBe("longer\n");
    } finally { setFilePoolOptions({ inline: runFileTask }); }
  });

  it("keeps a set-id bit, which a write clears", async () => {
    const tool = file("tool.sh", "#!/bin/sh\n", 0o2755);
    expect((await save(tool, sha("#!/bin/sh\n"), "#!/bin/sh\necho hi\n")).status).toBe(200);
    expect(statSync(tool).mode & 0o7777).toBe(0o2755);
  });

  it("carries the file's extended attributes and access list over to the saved file", async () => {
    const { symbols } = dlopen("libc.so.6", {
      setxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
      getxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    });
    const cstring = (value: string) => Buffer.from(`${value}\0`);
    const read = (path: string, name: string): string | null => {
      const buffer = Buffer.alloc(256);
      const got = Number(symbols.getxattr(cstring(path), cstring(name), buffer, buffer.length));
      return got < 0 ? null : buffer.subarray(0, got).toString("hex");
    };
    const tagged = file("tagged.md", "tagged\n");
    expect(symbols.setxattr(cstring(tagged), cstring("user.ovis"), Buffer.from("kept"), 4, 0)).toBe(0);
    expect((await save(tagged, sha("tagged\n"), "still tagged\n")).status).toBe(200);
    expect(read(tagged, "user.ovis")).toBe(Buffer.from("kept").toString("hex"));
    if (Bun.which("setfacl") === null) return;
    const listed = file("listed.md", "listed\n", 0o640);
    expect(Bun.spawnSync(["setfacl", "-m", "u:nobody:r--,g::---,o::---,m::r--", listed]).exitCode).toBe(0);
    const before = read(listed, "system.posix_acl_access");
    expect(before).not.toBeNull();
    expect((await save(listed, sha("listed\n"), "x\n")).status).toBe(200);
    expect(read(listed, "system.posix_acl_access")).toBe(before);
    // a folder that passes an access list on to new files: the saved file takes none the file did not have
    mkdirSync(join(folder, "shared"));
    expect(Bun.spawnSync(["setfacl", "-d", "-m", "u:nobody:r--", join(folder, "shared")]).exitCode).toBe(0);
    const plain = file("shared/plain.md", "plain\n");
    expect(Bun.spawnSync(["setfacl", "-b", plain]).exitCode).toBe(0);
    expect(read(plain, "system.posix_acl_access")).toBeNull();
    expect((await save(plain, sha("plain\n"), "y\n")).status).toBe(200);
    expect(read(plain, "system.posix_acl_access")).toBeNull();
  });

  it("does not take a failed attribute read for a file without any", () => {
    const target = file("target.md", "t\n");
    const fd = openSync(target, "r+");
    try { expect(copyFileAttributes(-1, fd)).toBe(false); } finally { closeSync(fd); }
  });

  it("answers a save to a file removed since it was opened with a conflict", async () => {
    const gone = file("removed.md", "removed\n");
    rmSync(gone);
    expect(await error(await save(gone, sha("removed\n"), "x\n"))).toEqual([409, "stale_revision"]);
  });

  it("gives a CRLF file back with LF and saves it with CRLF again, its BOM kept", async () => {
    const crlf = file("windows.txt", "\uFEFFone\r\ntwo\r\n");
    const body = await (await open(crlf)).json() as EditableText;
    expect(body).toMatchObject({ text: "\uFEFFone\ntwo\n", line_endings: "crlf" });
    expect((await save(crlf, body.revision, "\uFEFFone\ntwo\nthree\n")).status).toBe(200);
    expect(readFileSync(crlf, "utf8")).toBe("\uFEFFone\r\ntwo\r\nthree\r\n");
  });

  it("refuses a save to a file that changed since it was opened, and writes nothing", async () => {
    const config = file("config.json", "{\"a\": 1}\n");
    const body = await (await open(config)).json() as EditableText;
    writeFileSync(config, "{\"a\": 2}\n");
    const refused = await save(config, body.revision, "{\"a\": 3}\n");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "stale_revision", revision: sha("{\"a\": 2}\n") } });
    expect(readFileSync(config, "utf8")).toBe("{\"a\": 2}\n");
  });

  it("refuses a file another program changes between the checks, and leaves that program's text", async () => {
    const plan = file("plan.md", "v1\n");
    textSaveHooks.beforeRename = () => writeFileSync(plan, "agent's v2\n");
    expect(await error(await save(plan, sha("v1\n"), "mine\n"))).toEqual([409, "stale_revision"]);
    expect(readFileSync(plan, "utf8")).toBe("agent's v2\n");
    expect(readdirSync(folder).filter((name) => name.includes(".ovis-"))).toEqual([]);
  });

  it("refuses every file that is not under the pane's folder, however it is named", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret\n");
    mkdirSync(join(outside, "docs"), { recursive: true });
    writeFileSync(join(outside, "docs", "x.md"), "x\n");
    symlinkSync(secret, join(folder, "link.txt"));
    symlinkSync(join(outside, "docs"), join(folder, "linked-docs"));
    file(".git/config", "[core]\n");
    for (const path of ["../outside/secret.txt", secret, "link.txt", "linked-docs/x.md", ".git/config", join(folder, ".git", "config")]) {
      expect([path, ...await error(await open(path))]).toEqual([path, 403, "outside_pane"]);
      expect([path, ...await error(await save(path, sha("secret\n"), "pwned\n"))]).toEqual([path, 403, "outside_pane"]);
    }
    expect(readFileSync(secret, "utf8")).toBe("secret\n");
    expect(readFileSync(join(outside, "docs", "x.md"), "utf8")).toBe("x\n");
    // a pane at a filesystem's root opens nothing for editing
    paneCwd = "/";
    expect(await error(await open(secret.slice(1)))).toEqual([403, "outside_pane"]);
    paneCwd = folder;
    expect(await error(await open("missing.md"))).toEqual([404, "not_found"]);
  });

  it("sends the save nowhere else when a folder on the way is swapped for a link to another folder", async () => {
    const note = file("swap/note.md", "before\n");
    writeFileSync(join(outside, "note.md"), "outside\n");
    textSaveHooks.beforeRename = () => {
      renameSync(join(folder, "swap"), join(folder, "swap-moved"));
      symlinkSync(outside, join(folder, "swap"));
    };
    const saved = await save(note, sha("before\n"), "after\n");
    // the rename went through the folder that was opened, wherever it now is
    expect(saved.status).toBe(200);
    expect(readFileSync(join(folder, "swap-moved", "note.md"), "utf8")).toBe("after\n");
    expect(readFileSync(join(outside, "note.md"), "utf8")).toBe("outside\n");
    // and a folder moved out of the pane's folder meanwhile is not written in at all
    const kept = file("away/kept.md", "kept\n");
    textSaveHooks.beforeRename = () => renameSync(join(folder, "away"), join(outside, "away"));
    expect(await error(await save(kept, sha("kept\n"), "after\n"))).toEqual([409, "stale_revision"]);
    expect(readFileSync(join(outside, "away", "kept.md"), "utf8")).toBe("kept\n");
    expect(readdirSync(join(outside, "away"))).toEqual(["kept.md"]);
    file("gone/note.md", "gone\n");
    textSaveHooks.beforeRename = () => rmSync(join(folder, "gone"), { recursive: true, force: true });
    expect(await error(await save(join(folder, "gone", "note.md"), sha("gone\n"), "after\n"))).toEqual([409, "stale_revision"]);
  });

  it("refuses a binary, non-UTF-8, mixed-endings or oversized file, and a read-only or hard-linked one", async () => {
    const late = new Uint8Array(9000).fill(0x61);
    late[8999] = 0;
    expect(await error(await open(file("late-nul.log", late)))).toEqual([415, "not_text"]);
    expect(await error(await open(file("latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]))))).toEqual([415, "not_text"]);
    expect(await error(await open(file("mixed.txt", "a\r\nb\n")))).toEqual([415, "mixed_line_endings"]);
    expect(await error(await open(file("lone-cr.txt", "a\rb")))).toEqual([415, "mixed_line_endings"]);
    expect(await error(await open(file("big.txt", "a".repeat(MAX_EDITABLE_TEXT_BYTES + 1))))).toEqual([413, "too_large"]);
    const exact = file("exact.txt", "a".repeat(MAX_EDITABLE_TEXT_BYTES));
    expect(await error(await save(exact, sha("a".repeat(MAX_EDITABLE_TEXT_BYTES)), "b".repeat(MAX_EDITABLE_TEXT_BYTES + 1)))).toEqual([413, "too_large"]);
    const locked = file("locked.md", "locked\n", 0o444);
    expect(await error(await save(locked, sha("locked\n"), "x\n"))).toEqual([403, "not_writable"]);
    const linked = file("linked.md", "linked\n");
    linkSync(linked, join(folder, "other-name.md"));
    expect(await error(await save(linked, sha("linked\n"), "x\n"))).toEqual([403, "linked_file"]);
    expect(readFileSync(join(folder, "other-name.md"), "utf8")).toBe("linked\n");
  });

  it("takes only a JSON body from this app, within its limits", async () => {
    const plain = file("plain.md", "plain\n");
    expect(await error(await save(plain, sha("plain\n"), "x\n", { "content-type": "text/plain" }))).toEqual([415, "invalid_content_type"]);
    expect(await error(await save(plain, sha("plain\n"), "x\n", { origin: "https://evil.example" }))).toEqual([403, "invalid_origin"]);
    expect(await error(await save(plain, sha("plain\n"), "x\r\n"))).toEqual([400, "invalid_text"]);
    expect(await error(await save(plain, sha("plain\n"), "\ud800"))).toEqual([400, "invalid_text"]);
    expect(await error(await save(plain, "not-a-hash", "x\n"))).toEqual([400, "invalid_revision"]);
    const huge = await fetch(url("/api/fs/text"), { method: "PUT", headers: { origin: url(""), "content-type": "application/json" }, body: `"${"a".repeat(MAX_TEXT_SAVE_BODY_BYTES)}"` });
    expect(await error(huge)).toEqual([413, "too_large"]);
    expect(await error(await fetch(url(`/api/fs/text?path=${q(plain)}`)))).toEqual([400, "missing_pane"]);
    expect(await error(await fetch(url("/api/fs/text"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(readFileSync(plain, "utf8")).toBe("plain\n");
  });

  it("saves nothing on a platform that cannot prove where the file lies", async () => {
    const note = file("win.md", "win\n");
    textSaveHooks.platform = "win32";
    expect(await error(await save(note, sha("win\n"), "x\n"))).toEqual([501, "unsupported_platform"]);
    expect(readFileSync(note, "utf8")).toBe("win\n");
  });

  it("is for a driving device only, over the relay and on the LAN too", async () => {
    const note = file("relay.md", "relay\n");
    const request = (method: string) => new Request(`https://relay.ovis.invalid/api/fs/text?pane_id=w1:p1&path=${q(note)}`, { method, headers: { origin: "https://relay.ovis.invalid", "content-type": "application/json" }, ...(method === "PUT" ? { body: JSON.stringify({ pane_id: "w1:p1", path: note, revision: sha("relay\n"), text: "x\n" }) } : {}) });
    const through = (role: "watch" | "drive"): ServerContext => ({
      ...server.context, peer: { kind: "relay", device: { id: "0123456789abcdef", label: "Phone", role }, sessionId: "s", serverId: "0123456789abcdef0123456789abcdef", key: "" },
      requestIP: () => null, timeout: () => {}, upgrade: () => false,
    });
    for (const method of ["GET", "PUT"]) expect(await error((await handleRequest(request(method), through("watch")))!)).toEqual([403, "read_only"]);
    expect((await handleRequest(request("GET"), through("drive")))?.status).toBe(200);
    const lan: ServerContext = { ...server.context, requestIP: () => ({ address: "192.168.1.20" }), timeout: () => {}, upgrade: () => false };
    const fromLan = new Request(`http://192.168.1.10:${server.port}/api/fs/text?pane_id=w1:p1&path=${q(note)}`, { headers: { host: `192.168.1.10:${server.port}` } });
    expect(await error((await handleRequest(fromLan, lan))!)).toEqual([403, "drive_only"]);
    expect(readFileSync(note, "utf8")).toBe("relay\n");
  });
});

describe("who may edit a file", () => {
  const full = (via: string, role: "drive" | "watch") => ({ level: "full", via, role }) as Access;
  const none = { level: "none", reason: "token_required" } as Access;
  it.each([
    ["a paired driving device", full("device", "drive"), false, false, true],
    ["the access token", full("token", "drive"), false, false, true],
    ["this PC's own browser", full("local", "drive"), false, false, true],
    ["a driving phone over the relay", full("relay", "drive"), false, false, true],
    ["a driving device, for another PC", full("device", "drive"), false, true, true],
    ["a watching device", full("device", "watch"), false, false, false],
    ["a Portal visitor given drive", full("portal", "drive"), false, false, false],
    ["an open LAN window", full("open", "drive"), false, false, false],
    ["the connection server's bridge token", none, true, false, true],
    ["the bridge token, for a PC behind this one", none, true, true, false],
    ["nobody", none, false, false, false],
  ])("%s", (_who, access, bridge, proxied, allowed) => {
    expect(textEditAllowed(access, bridge, proxied)).toBe(allowed);
  });
});
