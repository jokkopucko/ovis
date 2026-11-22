import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { PaneInfo } from "../shared/protocol.ts";
import * as client from "./herdr/client.ts";
import { MAX_IMAGE_BYTES, PasteImageError, pasteDirectory, preparePasteDirectory, savePaneImage } from "./paste.ts";

describe("pasteDirectory", () => {
  const previous = process.env["OVIS_PASTE_DIR"];
  afterEach(() => {
    if (previous === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = previous;
  });

  it("keeps attachments next to the pane, or in the temp dir without a cwd", () => {
    delete process.env["OVIS_PASTE_DIR"];
    expect(pasteDirectory("/work/repo")).toBe(join("/work/repo", ".ovis"));
    expect(pasteDirectory(null)).toBe(join(tmpdir(), "ovis", ".ovis"));
  });

  it("uses OVIS_PASTE_DIR for every pane when set, as an absolute path", () => {
    process.env["OVIS_PASTE_DIR"] = "/var/tmp/pastes";
    expect(pasteDirectory("/work/repo")).toBe(resolve("/var/tmp/pastes"));
    expect(pasteDirectory(undefined)).toBe(resolve("/var/tmp/pastes"));
    process.env["OVIS_PASTE_DIR"] = "pastes";
    expect(pasteDirectory("/work/repo")).toBe(resolve("pastes"));
  });

  it("expands a leading ~ to the home directory", () => {
    process.env["OVIS_PASTE_DIR"] = "~/pastes";
    expect(pasteDirectory("/work/repo")).toBe(join(homedir(), "pastes"));
    process.env["OVIS_PASTE_DIR"] = "~";
    expect(pasteDirectory("/work/repo")).toBe(homedir());
    process.env["OVIS_PASTE_DIR"] = "~/";
    expect(pasteDirectory("/work/repo")).toBe(homedir());
  });

  it("stays under the home directory with a doubled or a Windows separator after ~", () => {
    process.env["OVIS_PASTE_DIR"] = "~//pastes";
    expect(pasteDirectory("/work/repo")).toBe(join(homedir(), "pastes"));
    process.env["OVIS_PASTE_DIR"] = "~\\pastes";
    expect(pasteDirectory("/work/repo")).toBe(join(homedir(), "pastes"));
    process.env["OVIS_PASTE_DIR"] = "~pastes";
    expect(pasteDirectory("/work/repo")).toBe(resolve("~pastes"));
  });

  it("ignores spaces around the value, and a value of only spaces", () => {
    process.env["OVIS_PASTE_DIR"] = "  /var/tmp/pastes  ";
    expect(pasteDirectory("/work/repo")).toBe(resolve("/var/tmp/pastes"));
    process.env["OVIS_PASTE_DIR"] = "   ";
    expect(pasteDirectory("/work/repo")).toBe(join("/work/repo", ".ovis"));
  });

  it("treats an empty OVIS_PASTE_DIR as unset", () => {
    process.env["OVIS_PASTE_DIR"] = "";
    expect(pasteDirectory("/work/repo")).toBe(join("/work/repo", ".ovis"));
  });
});

describe("savePaneImage", () => {
  const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)));
  const RASTERS: Record<string, Buffer> = {
    png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
    jpg: bytes([255, 216, 255, 224, 0, 16], "JFIF"),
    gif: bytes("GIF87a", [1, 0, 1, 0]),
    webp: bytes("RIFF", [4, 0, 0, 0], "WEBP"),
  };
  const GIF89A = bytes("GIF89a", [1, 0, 1, 0]);
  const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const FAKES: Buffer[] = [
    bytes("SECRET-UPLOAD-TEXT not an image"),
    bytes([137, 80, 78, 71, 13, 10, 26]),
    bytes([255, 216]),
    bytes("GIF8"),
    bytes("GIF88a"),
    bytes("RIFF", [4, 0, 0, 0], "WEB"),
    bytes("RIFF", [4, 0, 0, 0], "WAVE"),
    // GIF87a, GIF89a and RIFF....WEBP with each letter's high bit set, which an ASCII decode drops
    bytes([0xc7, 0xc9, 0xc6, 0x38, 0x37, 0xe1]),
    bytes([0xc7, 0xc9, 0xc6, 0x38, 0x39, 0xe1]),
    bytes([0xd2, 0xc9, 0xc6, 0xc6, 4, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0]),
  ];
  const previous = process.env["OVIS_PASTE_DIR"];
  let cwd = "";
  let paneGet: ReturnType<typeof spyOn<typeof client, "paneGet">>;

  beforeEach(() => {
    delete process.env["OVIS_PASTE_DIR"];
    cwd = mkdtempSync(join(tmpdir(), "ovis-paste-"));
    paneGet = spyOn(client, "paneGet").mockResolvedValue({ pane_id: "w1:p1", cwd } as PaneInfo);
  });
  afterEach(() => {
    paneGet.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
    if (previous === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = previous;
  });

  const save = (contentType: string, data: Buffer | string, name?: string) =>
    savePaneImage({ paneId: "w1:p1", contentType, dataBase64: typeof data === "string" ? data : data.toString("base64"), name });
  const refusal = async (promise: Promise<string>): Promise<PasteImageError> => {
    const error = await promise.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(PasteImageError);
    return error as PasteImageError;
  };

  it("uses sniffed extension for every supported raster claim", async () => {
    for (const [extension, data] of [...Object.entries(RASTERS), ["gif", GIF89A] as const]) {
      for (const contentType of RASTER_TYPES) {
        const path = await save(contentType, data, "shot.png");
        expect(dirname(path)).toBe(join(cwd, ".ovis"));
        expect(basename(path)).toMatch(new RegExp(`^paste-\\d{8}-\\d{6}-[0-9a-f]{8}\\.${extension}$`));
        expect(readFileSync(path).equals(data)).toBe(true);
        if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("refuses a fake raster before pane lookup or filesystem writes", async () => {
    for (const data of FAKES) {
      for (const contentType of RASTER_TYPES) {
        const error = await refusal(save(contentType, data, "shot.png"));
        expect([error.code, error.status, error.message]).toEqual(["invalid_image", 400, "file does not contain a supported raster image"]);
      }
    }
    expect(paneGet).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, ".ovis"))).toBe(false);
    expect((await refusal(save("image/png", ""))).code).toBe("empty_image");
    expect((await refusal(save("image/png", "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8)))).code).toBe("image_too_large");
    expect(paneGet).not.toHaveBeenCalled();
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("does not echo upload bytes in errors", async () => {
    const text = bytes("SECRET-UPLOAD-TEXT ".repeat(64));
    const error = await refusal(save("image/jpeg", text, "secret-name.jpg"));
    for (const leaked of ["SECRET", "secret-name", text.toString("base64").slice(0, 16)]) expect(error.message).not.toContain(leaked);
    expect(error.message.length).toBeLessThan(80);
  });

  it("preserves generic named uploads", async () => {
    for (const [contentType, name, data, pattern] of [
      ["image/svg+xml", "../omo icon.SVG", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), /^omo_icon-\d{8}-\d{6}-[0-9a-f]{8}\.svg$/],
      ["application/json", "report.json", bytes('{"month":"2026-09"}'), /^report-.*\.json$/],
      ["application/zip", "bundle.zip", RASTERS.png!, /^bundle-.*\.zip$/],
      ["", undefined, RASTERS.gif!, /^file-.*\.bin$/],
      ["text/plain", "notes.txt", bytes("SECRET-UPLOAD-TEXT not an image"), /^notes-.*\.txt$/],
    ] as const) {
      const path = await save(contentType, data, name);
      expect(basename(path)).toMatch(pattern);
      expect(readFileSync(path).equals(data)).toBe(true);
    }
    expect(paneGet).toHaveBeenCalledTimes(5);
  });
});

describe("preparePasteDirectory", () => {
  const saved = { dir: process.env["OVIS_PASTE_DIR"], tmp: process.env["TMPDIR"] };
  const roots: string[] = [];
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-paste-dir-")); roots.push(root); return root; };
  afterEach(() => {
    if (saved.dir === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = saved.dir;
    if (saved.tmp === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = saved.tmp;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates a self-ignoring default paste directory", () => {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env["OVIS_PASTE_DIR"]; else process.env["OVIS_PASTE_DIR"] = value;
      const cwd = temp();
      const directory = preparePasteDirectory(cwd);
      expect(directory).toBe(join(cwd, ".ovis"));
      expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe("*\n");
      if (process.platform !== "win32") expect(statSync(join(directory, ".gitignore")).mode & 0o777).toBe(0o600);
      expect(preparePasteDirectory(cwd)).toBe(directory);
      expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe("*\n");
    }
  });

  it.skipIf(process.platform === "win32")("ignores the temp-dir fallback of a pane without a cwd too", () => {
    delete process.env["OVIS_PASTE_DIR"];
    const tmp = temp();
    process.env["TMPDIR"] = tmp;
    const directory = preparePasteDirectory(null);
    expect(directory).toBe(join(tmp, "ovis", ".ovis"));
    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps an ignore file that is already there, a link included, byte for byte", () => {
    delete process.env["OVIS_PASTE_DIR"];
    const custom = temp();
    mkdirSync(join(custom, ".ovis"));
    writeFileSync(join(custom, ".ovis", ".gitignore"), "# mine\n*.png\n!keep.txt");
    preparePasteDirectory(custom);
    expect(readFileSync(join(custom, ".ovis", ".gitignore"), "utf8")).toBe("# mine\n*.png\n!keep.txt");
    if (process.platform === "win32") return; // creating a symlink needs developer mode there
    const outside = temp();
    writeFileSync(join(outside, "rules"), "shared\n");
    for (const target of [join(outside, "rules"), join(outside, "missing")]) {
      const cwd = temp();
      mkdirSync(join(cwd, ".ovis"));
      symlinkSync(target, join(cwd, ".ovis", ".gitignore"));
      preparePasteDirectory(cwd);
      expect(lstatSync(join(cwd, ".ovis", ".gitignore")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(cwd, ".ovis", ".gitignore"))).toBe(target);
    }
    // neither the link's file nor a dangling link's target is written through it
    expect(readFileSync(join(outside, "rules"), "utf8")).toBe("shared\n");
    expect(existsSync(join(outside, "missing"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("writes no ignore file through a .ovis that is a link to another folder", () => {
    delete process.env["OVIS_PASTE_DIR"];
    const outside = temp();
    writeFileSync(join(outside, "user-file"), "theirs\n");
    const cwd = temp();
    symlinkSync(outside, join(cwd, ".ovis"));
    expect(preparePasteDirectory(cwd)).toBe(join(cwd, ".ovis"));
    expect(readdirSync(outside)).toEqual(["user-file"]);
  });

  it("never creates an ignore in a trimmed nonempty override", () => {
    const cwd = temp();
    const override = join(temp(), "pastes");
    process.env["OVIS_PASTE_DIR"] = `  ${override}  `;
    expect(preparePasteDirectory(cwd)).toBe(override);
    expect(statSync(override).isDirectory()).toBe(true);
    expect(existsSync(join(override, ".gitignore"))).toBe(false);
    process.env["OVIS_PASTE_DIR"] = join(cwd, ".ovis");
    expect(preparePasteDirectory(cwd)).toBe(join(cwd, ".ovis"));
    expect(existsSync(join(cwd, ".ovis", ".gitignore"))).toBe(false);
    const home = temp();
    const child = Bun.spawnSync([process.execPath, "-e", `const { preparePasteDirectory } = await import(${JSON.stringify(join(import.meta.dir, "paste.ts"))}); console.log(preparePasteDirectory(${JSON.stringify(cwd)}));`], {
      env: { ...process.env, HOME: home, USERPROFILE: home, OVIS_PASTE_DIR: " ~/pastes " },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString().trim()).toBe(join(home, "pastes"));
    expect(statSync(join(home, "pastes")).isDirectory()).toBe(true);
    expect(existsSync(join(home, "pastes", ".gitignore"))).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an ignore file it could not create", () => {
    delete process.env["OVIS_PASTE_DIR"];
    const cwd = temp();
    mkdirSync(join(cwd, ".ovis"));
    chmodSync(join(cwd, ".ovis"), 0o500);
    try {
      expect(() => preparePasteDirectory(cwd)).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(existsSync(join(cwd, ".ovis", ".gitignore"))).toBe(false);
    } finally {
      chmodSync(join(cwd, ".ovis"), 0o700);
    }
  });
});
