import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { clearFileCache, filesNamed, GIT_LIST_DEADLINE_MS, GIT_LIST_MAX_BYTES, MAX_MARKDOWN_DOCUMENTS, paneDocuments, paneFiles, readMarkdownDocuments, setGitListOptions } from "./files.ts";

const roots: string[] = [];
const SET_BY_TESTS = ["GIT_DIR", "GIT_COMMON_DIR", "PATH"] as const;
const inherited = SET_BY_TESTS.map((name) => [name, process.env[name]] as const);
afterEach(() => {
  clearFileCache();
  setGitListOptions();
  for (const [name, value] of inherited) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "files-search-"));
  roots.push(root);
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "hidden"), { recursive: true });
  writeFileSync(join(root, "src", "components", "PromptCard.tsx"), "export {};");
  writeFileSync(join(root, "src", "api.ts"), "export {};");
  writeFileSync(join(root, "README.md"), "read me");
  writeFileSync(join(root, "node_modules", "hidden", "prompt.ts"), "hidden");
  return root;
}

describe("paneFiles", () => {
  it("walks a non-git tree, skips heavy directories, and ranks matches", async () => {
    const root = fixture();
    expect(await paneFiles(root, "prompt", 20)).toEqual(["src/components/PromptCard.tsx"]);
    expect(await paneFiles(root, "sat", 20)).toContain("src/api.ts");
    expect(await paneFiles(root, "", 2)).toHaveLength(2);
  });

  it("uses tracked and untracked non-ignored files in a git repository", async () => {
    const root = fixture();
    const init = Bun.spawnSync(["git", "init", "-q", root]);
    expect(init.exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "README.md\n");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("src/api.ts");
    expect(files).not.toContain("README.md");
  });

  it("clamps the result limit to one through one hundred", async () => {
    const root = fixture();
    expect(await paneFiles(root, "", 0)).toHaveLength(3);
    expect(await paneFiles(root, "", 1)).toHaveLength(1);
  });

  it("preserves Unicode and newline filenames returned by git", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    for (const name of ["설계 문서.md", "line\nbreak.txt"]) writeFileSync(join(root, name), "fixture");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("설계 문서.md");
    expect(files).toContain("line\nbreak.txt");
  });

  it("matches a Unicode query across normalization forms", async () => {
    const root = fixture();
    const name = "문서.md".normalize("NFD");
    writeFileSync(join(root, name), "fixture");
    clearFileCache();
    expect(await paneFiles(root, "문서".normalize("NFC"))).toContain(name);
  });

  it("preserves existing ASCII matches and scores for decomposed names", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-unicode-search-"));
    roots.push(root);
    for (const name of [
      "abc/x.md",
      "café.txt".normalize("NFD"),
      "docs/readme.md",
      "ée/x.md",
      "éé/x.md".normalize("NFD"),
      "src/main.ts",
      "x.md",
      "메모.md",
      "문서.md".normalize("NFD"),
    ]) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "fixture");
    }
    clearFileCache();
    expect(await paneFiles(root, "cafe", 100)).toContain("café.txt".normalize("NFD"));
    expect(await paneFiles(root, "x", 100)).toEqual([
      "x.md",
      "ée/x.md",
      "abc/x.md",
      "éé/x.md".normalize("NFD"),
      "café.txt".normalize("NFD"),
    ]);
    expect(await paneFiles(root, "md", 100)).toEqual([
      "x.md",
      "메모.md",
      "ée/x.md",
      "abc/x.md",
      "문서.md".normalize("NFD"),
      "éé/x.md".normalize("NFD"),
      "docs/readme.md",
    ]);
  });

  it("honors git ignores from a nested working directory", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "src/secret.txt\n");
    writeFileSync(join(root, "src", "secret.txt"), "private");
    expect(await paneFiles(join(root, "src"), "", 100)).toEqual(["api.ts", "components/PromptCard.tsx"]);
  });

  it("keeps files listed after a folder of thousands in the git inventory", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-search-"));
    roots.push(root);
    mkdirSync(join(root, "a-data"));
    for (let index = 0; index < 5_100; index += 1) writeFileSync(join(root, "a-data", `page-${index}.txt`), "");
    mkdirSync(join(root, "docs", "design"), { recursive: true });
    writeFileSync(join(root, "docs", "design", "11_two-version-design.md"), "# design");
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    expect(await paneFiles(root, "two-version", 20)).toEqual(["docs/design/11_two-version-design.md"]);
  });
});

function gitRepository(root: string): void {
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  writeFileSync(join(root, ".gitignore"), "README.md\n");
}

function fakeGit(script: (folder: string) => string): { git: string; folder: string } {
  const folder = mkdtempSync(join(tmpdir(), "files-fake-git-"));
  roots.push(folder);
  const git = join(folder, "git");
  writeFileSync(git, `#!/bin/sh\n${script(folder)}\n`);
  chmodSync(git, 0o755);
  return { git, folder };
}

function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function heldGit() {
  const { git, folder } = fakeGit((dir) => `printf 'ghost-held\\0'\nsh -c 'exec 3>"$1"; echo $$ >&3; read _ < "$2"' holder "${dir}/life" "${dir}/hold" &\nexit 0`);
  for (const fifo of ["life", "hold"]) expect(Bun.spawnSync(["mkfifo", join(folder, fifo)]).exitCode).toBe(0);
  const watcher = Bun.spawn(["cat", join(folder, "life")], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const ready = Promise.withResolvers<number>();
  const exited = Promise.withResolvers<void>();
  let pid: number | undefined;
  let running = true;
  ready.promise.catch(() => undefined);
  void (async () => {
    const reader = watcher.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (pid === undefined && text.includes("\n")) {
        pid = Number(text.slice(0, text.indexOf("\n")));
        ready.resolve(pid);
      }
    }
    running = false;
    ready.reject(new Error("the holder ended before it was ready"));
    exited.resolve();
  })();
  return {
    git,
    ready: ready.promise,
    holding: () => running,
    async end(): Promise<void> {
      if (pid === undefined) watcher.kill("SIGKILL");
      else process.kill(pid, "SIGKILL");
      await within(exited.promise, 5_000, "the holder's exit");
      await within(watcher.exited, 5_000, "the FIFO watcher's exit");
    },
  };
}

const INERT_ARGV = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor="];

describe("paneDocuments", () => {
  const at = (root: string, path: string, iso: string): void => utimesSync(join(root, path), new Date(iso), new Date(iso));

  it("lists the folder's Markdown files newest first, with their sizes and times, and no skipped folder's", async () => {
    const root = fixture();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "plan.markdown"), "# Plan\n");
    writeFileSync(join(root, "NOTES.MD"), "n");
    writeFileSync(join(root, "node_modules", "hidden", "skipped.md"), "x");
    at(root, "README.md", "2026-11-01T00:00:00.000Z");
    at(root, "docs/plan.markdown", "2026-11-03T00:00:00.000Z");
    at(root, "NOTES.MD", "2026-11-02T00:00:00.000Z");
    expect(await paneDocuments(root)).toEqual({
      root,
      documents: [
        { path: "docs/plan.markdown", size: 7, modified: "2026-11-03T00:00:00.000Z" },
        { path: "NOTES.MD", size: 1, modified: "2026-11-02T00:00:00.000Z" },
        { path: "README.md", size: 7, modified: "2026-11-01T00:00:00.000Z" },
      ],
      truncated: false,
    });
  });

  it("leaves out what git ignores in a repository", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "report.md"), "built");
    writeFileSync(join(root, ".gitignore"), "out/\n");
    expect((await paneDocuments(root)).documents.map((document) => document.path)).toEqual(["README.md"]);
  });

  it("answers at most its cap of files, the newest, and says the list was cut", async () => {
    const root = fixture();
    rmSync(join(root, "README.md"));
    for (let index = 0; index <= MAX_MARKDOWN_DOCUMENTS; index += 1) {
      writeFileSync(join(root, `n${index}.md`), "");
      at(root, `n${index}.md`, new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString());
    }
    const listed = await paneDocuments(root);
    expect(listed.truncated).toBe(true);
    expect(listed.documents).toHaveLength(MAX_MARKDOWN_DOCUMENTS);
    expect(listed.documents[0]!.path).toBe(`n${MAX_MARKDOWN_DOCUMENTS}.md`);
    expect(listed.documents.some((document) => document.path === "n0.md")).toBe(false);
  });

  it("finds the newest file of a repository holding thousands, wherever its name sorts", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    mkdirSync(join(root, "notes"));
    for (let index = 0; index < 2_000; index += 1) {
      writeFileSync(join(root, "notes", `a${String(index).padStart(5, "0")}.md`), "");
      at(root, `notes/a${String(index).padStart(5, "0")}.md`, "2026-01-01T00:00:00.000Z");
    }
    writeFileSync(join(root, "zz-newest.md"), "new");
    at(root, "README.md", "2026-01-01T00:00:00.000Z");
    at(root, "zz-newest.md", "2026-11-05T00:00:00.000Z");
    const listed = await paneDocuments(root);
    expect(listed.documents[0]!.path).toBe("zz-newest.md");
    expect(listed.truncated).toBe(true);
  });

  it("outside a repository, finds a note in a folder crowded with other files", async () => {
    const root = fixture();
    rmSync(join(root, "README.md"));
    for (let index = 0; index < 1_000; index += 1) writeFileSync(join(root, `a${String(index).padStart(4, "0")}.txt`), "");
    writeFileSync(join(root, "z-note.md"), "note");
    expect(await paneDocuments(root)).toMatchObject({ documents: [{ path: "z-note.md" }], truncated: false });
  });

  it("stops reading at its time limit and says the list is cut", () => {
    const root = fixture();
    expect(readMarkdownDocuments(root, null, 0)).toEqual({ documents: [], cut: true });
    expect(readMarkdownDocuments(root, ["README.md"], 0)).toEqual({ documents: [], cut: true });
    expect(readMarkdownDocuments(root, ["README.md"])).toMatchObject({ documents: [{ path: "README.md" }], cut: false });
  });
});

describe("git inventories", () => {
  it("isolates both Git inventories from inherited repository variables", async () => {
    const root = fixture();
    gitRepository(root);
    const foreign = mkdtempSync(join(tmpdir(), "files-foreign-"));
    roots.push(foreign);
    expect(Bun.spawnSync(["git", "init", "-q", foreign]).exitCode).toBe(0);
    writeFileSync(join(foreign, "foreign-only.txt"), "elsewhere");
    expect(Bun.spawnSync(["git", "-C", foreign, "add", "foreign-only.txt"]).exitCode).toBe(0);

    // a server started with these set (from a hook, say) inherits them; Bun.spawn ignores later edits to process.env
    const script = `import { filesNamed, paneFiles } from ${JSON.stringify(join(import.meta.dir, "files.ts"))};
      const root = process.env.FILES_ROOT;
      console.log(JSON.stringify({ listed: await paneFiles(root, "", 100), foreign: await filesNamed(root, "foreign-only.txt"), api: await filesNamed(root, "api.ts") }));`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, FILES_ROOT: root, GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, ".git", "index") },
    });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    const { listed, foreign: foreignNamed, api } = JSON.parse(output) as { listed: string[]; foreign: string[]; api: string[] };
    expect(listed).toContain("src/api.ts");
    expect(listed).not.toContain("README.md");
    expect(listed).not.toContain("foreign-only.txt");
    expect(foreignNamed).toEqual([]);
    expect(api).toEqual(["src/api.ts"]);
  });

  it("keeps an inherited common directory's excludes and config out of both inventories", async () => {
    const root = fixture();
    gitRepository(root);
    const buried = "deep/1/2/3/4/5/6/buried.txt";
    mkdirSync(join(root, buried, ".."), { recursive: true });
    writeFileSync(join(root, buried), "deep");
    const foreign = mkdtempSync(join(tmpdir(), "files-foreign-"));
    roots.push(foreign);
    expect(Bun.spawnSync(["git", "init", "-q", foreign]).exitCode).toBe(0);
    mkdirSync(join(foreign, ".git", "info"), { recursive: true });
    writeFileSync(join(foreign, ".git", "info", "exclude"), "src/api.ts\n");
    writeFileSync(join(foreign, "excludes"), "buried.txt\n");
    expect(Bun.spawnSync(["git", "-C", foreign, "config", "core.excludesFile", join(foreign, "excludes")]).exitCode).toBe(0);

    process.env["GIT_COMMON_DIR"] = join(foreign, ".git");
    const listed = await paneFiles(root, "", 100);
    expect(listed).toContain("src/api.ts");
    expect(listed).toContain(buried);
    expect(listed).not.toContain("README.md");
    expect(await filesNamed(root, "buried.txt")).toEqual([buried]);
  });

  it("hands both inventories the inert argv and environment, never through a synchronous spawn", async () => {
    const root = fixture();
    gitRepository(root);
    process.env["GIT_DIR"] = join(root, "elsewhere");
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    try {
      await paneFiles(root, "", 100);
      await filesNamed(root, "api.ts");
      const argv = ["git", ...INERT_ARGV, "-C", root, "ls-files", "-z", "-co", "--exclude-standard"];
      const calls = spawn.mock.calls as unknown as [string[], { stdin?: string; env?: Record<string, string> }][];
      expect(calls).toHaveLength(2);
      for (const [command, options] of calls) {
        expect(command).toEqual(argv);
        expect(options.stdin).toBe("ignore");
        expect(options.env?.["GIT_DIR"]).toBeUndefined();
        expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
      }
      // a synchronous listing holds the whole server's event loop for up to its deadline (#1404)
      expect(spawnSync).not.toHaveBeenCalled();
      expect(GIT_LIST_MAX_BYTES).toBe(16 * 1024 * 1024);
      expect(GIT_LIST_DEADLINE_MS).toBe(3_000);
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
  });

  it("disables a local fsmonitor for both inventories", async () => {
    const root = fixture();
    gitRepository(root);
    expect(Bun.spawnSync(["git", "-C", root, "add", "src"]).exitCode).toBe(0);
    const hook = fakeGit((folder) => `touch "${folder}/ran"\nexit 1`);
    expect(Bun.spawnSync(["git", "-C", root, "config", "core.fsmonitor", hook.git]).exitCode).toBe(0);
    const config = readFileSync(join(root, ".git", "config"), "utf8");
    // git before 2.36 reads core.fsmonitor=false as a hook named `false`, found on PATH
    const onPath = mkdtempSync(join(tmpdir(), "files-path-"));
    roots.push(onPath);
    writeFileSync(join(onPath, "false"), `#!/bin/sh\ntouch "${onPath}/ran"\nexit 1\n`);
    chmodSync(join(onPath, "false"), 0o755);
    process.env["PATH"] = `${onPath}${delimiter}${process.env["PATH"] ?? ""}`;

    const files = await paneFiles(root, "", 100);
    expect(files).toContain("src/components/PromptCard.tsx");
    expect(files).not.toContain("README.md");
    expect(await filesNamed(root, "PromptCard.tsx")).toEqual(["src/components/PromptCard.tsx"]);
    expect(existsSync(join(hook.folder, "ran"))).toBe(false);
    expect(existsSync(join(onPath, "ran"))).toBe(false);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(config);
  });

  it("falls back instead of accepting an overflowing listing", async () => {
    const root = fixture();
    const cap = 64;
    const listing = join(mkdtempSync(join(tmpdir(), "files-listing-")), "listing");
    roots.push(join(listing, ".."));
    const { git } = fakeGit(() => `exec cat "${listing}"`);
    setGitListOptions({ git, maxBytes: cap });
    for (const bytes of [cap - 1, cap, cap + 1]) {
      const second = `ghost-${bytes}-`.padEnd(bytes - "ghost-first\0".length - 1, "x");
      writeFileSync(listing, `ghost-first\0${second}\0`);
      expect(readFileSync(listing).byteLength).toBe(bytes);
      clearFileCache();
      const listed = await paneFiles(root, "", 100);
      const named = await filesNamed(root, second);
      if (bytes <= cap) {
        expect(listed).toEqual([second, "ghost-first"].sort());
        expect(named).toEqual([second]);
      } else {
        expect(listed).toEqual(["README.md", "src/api.ts", "src/components/PromptCard.tsx"]);
        expect(named).toEqual([]);
        expect(await filesNamed(root, "ghost-first")).toEqual([]);
      }
    }
  });

  it("falls back instead of accepting an unterminated listing", async () => {
    const root = fixture();
    const listing = join(mkdtempSync(join(tmpdir(), "files-listing-")), "listing");
    roots.push(join(listing, ".."));
    const { git } = fakeGit(() => `cat "${listing}"\nexit 0`);
    setGitListOptions({ git });
    // git exits 0 yet its last name has no NUL: the listing was cut short, so none of it is used
    for (const output of ["ghost-partial", "ghost-whole\0ghost-partial"]) {
      writeFileSync(listing, output);
      clearFileCache();
      expect(await paneFiles(root, "", 100)).toEqual(["README.md", "src/api.ts", "src/components/PromptCard.tsx"]);
      expect(await filesNamed(root, "ghost-partial")).toEqual([]);
      expect(await filesNamed(root, "ghost-whole")).toEqual([]);
      expect(await filesNamed(root, "api.ts")).toEqual(["src/api.ts"]);
    }
  });

  it("ends an inventory whose descendant holds stdout", async () => {
    const root = fixture();
    const deadlineMs = 300;
    const walk = ["README.md", "src/api.ts", "src/components/PromptCard.tsx"];

    const asyncHolder = heldGit();
    setGitListOptions({ git: asyncHolder.git, deadlineMs });
    const gitExit = Promise.withResolvers<number>();
    const spawn = Bun.spawn;
    const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      const proc = spawn(...args);
      void proc.exited.then(gitExit.resolve);
      return proc;
    }) as unknown as typeof Bun.spawn);
    try {
      const started = performance.now();
      const listed = paneFiles(root, "", 100);
      expect(await within(gitExit.promise, deadlineMs + 1_000, "git's exit")).toBe(0);
      await within(asyncHolder.ready, deadlineMs + 1_000, "the holder's readiness");
      expect(await within(listed, deadlineMs + 1_000, "the async inventory")).toEqual(walk);
      expect(performance.now() - started).toBeLessThan(deadlineMs + 1_000);
      expect(asyncHolder.holding()).toBe(true);
    } finally {
      spy.mockRestore();
      await asyncHolder.end();
    }

    const namedHolder = heldGit();
    setGitListOptions({ git: namedHolder.git, deadlineMs });
    clearFileCache();
    try {
      const started = performance.now();
      expect(await within(filesNamed(root, "ghost-held"), deadlineMs + 1_000, "the name lookup")).toEqual([]);
      expect(performance.now() - started).toBeLessThan(deadlineMs + 1_000);
      await within(namedHolder.ready, 1_000, "the holder's readiness");
      expect(namedHolder.holding()).toBe(true);
    } finally {
      await namedHolder.end();
    }
  });

  it("runs other work while a name lookup waits for a slow git", async () => {
    const root = fixture();
    const { git, folder } = fakeGit((dir) => `read _ < "${dir}/go"\nprintf 'slow-name\\0'`);
    expect(Bun.spawnSync(["mkfifo", join(folder, "go")]).exitCode).toBe(0);
    setGitListOptions({ git });
    const spawn = spyOn(Bun, "spawn");
    try {
      let answered = false;
      const named = filesNamed(root, "slow-name").finally(() => { answered = true; });
      const again = filesNamed(root, "api.ts");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(answered).toBe(false);
      await within(writeFile(join(folder, "go"), "\n"), 5_000, "git's release");
      expect(await within(named, 5_000, "the name lookup")).toEqual(["slow-name"]);
      expect(await within(again, 5_000, "the second lookup")).toEqual(["src/api.ts"]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });

  it("keeps a listing begun before clearFileCache out of the cache it cleared", async () => {
    const root = fixture();
    const slow = fakeGit((dir) => `read _ < "${dir}/go"\nprintf 'old-name\\0'`);
    expect(Bun.spawnSync(["mkfifo", join(slow.folder, "go")]).exitCode).toBe(0);
    const fast = fakeGit(() => `printf 'new-name\\0'`);
    setGitListOptions({ git: slow.git });
    const old = filesNamed(root, "old-name");
    clearFileCache();
    setGitListOptions({ git: fast.git });
    expect(await within(filesNamed(root, "new-name"), 5_000, "the new lookup")).toEqual(["new-name"]);
    await within(writeFile(join(slow.folder, "go"), "\n"), 5_000, "the old git's release");
    expect(await within(old, 5_000, "the old lookup")).toEqual(["old-name"]);
    expect(await filesNamed(root, "old-name")).toEqual([]);
    expect(await filesNamed(root, "new-name")).toEqual(["new-name"]);
  });
});
