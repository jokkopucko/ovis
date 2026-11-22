import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

import {
  forgetOpenCodeService,
  listOpenCodeCatalog,
  listPendingQuestionForms,
  openCodeHasSession,
  openCodeService,
  opencodeAuthHeader,
  opencodeStateDir,
  parseOpenCodeEvent,
  readOpenCodeService,
  replyOpenCodeForm,
  subscribeOpenCodeEvents,
  verifyOpenCodeService,
  type OpenCodeEvent,
  type OpenCodeServiceConfig,
} from "./opencode-service.ts";

async function withService(handler: (request: Request) => Response | Promise<Response>, run: (config: OpenCodeServiceConfig) => Promise<void>): Promise<void> {
  const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  try {
    await run({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "test-pass" });
  } finally { service.stop(true); }
}

describe("opencode-service", () => {
  it.skipIf(process.platform !== "linux")("closes connections after a timeout before response headers", async () => {
    const sockets = new Set<Socket>();
    const connected = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    let requests = 0;
    let disconnects = 0;
    const socketCount = () => readdirSync("/proc/self/fd").filter((fd) => {
      try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:"); }
      catch { return false; }
    }).length;
    const service = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("data", () => { if (++requests === 5) connected.resolve(); });
      socket.once("end", () => { if (++disconnects === 5) ended.resolve(); });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const before = socketCount();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port, pid: process.pid, password: "fixture" };
      const result = Promise.all(Array.from({ length: 5 }, () => listPendingQuestionForms(config, "session")));
      await connected.promise;
      expect(socketCount() - before - sockets.size).toBe(5);
      expect(await result).toEqual([null, null, null, null, null]);
      await Promise.race([ended.promise, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Timed-out client did not disconnect")), 500);
      })]);
      expect(socketCount() - before - sockets.size).toBe(0);
    } finally {
      clearTimeout(deadline);
      for (const socket of sockets) socket.destroy();
      service.close();
    }
  }, 4_000);
  it("sends native credentials and answers directly despite proxy environment variables", async () => {
    const direct: string[] = [];
    const proxied: string[] = [];
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        direct.push(request.method);
        return request.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
      },
    });
    const proxy = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        proxied.push(new URL(request.url).pathname);
        return request.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
      },
    });
    try {
      const config = { baseUrl: service.url.origin, port: service.port, pid: process.pid, password: "fixture-secret" };
      const child = Bun.spawn([process.execPath, "-e", `
        import { listPendingQuestionForms, replyOpenCodeForm } from ${JSON.stringify(import.meta.dir + "/opencode-service.ts")};
        const config = ${JSON.stringify(config)};
        await fetch(config.baseUrl + "/control");
        console.log(JSON.stringify([await listPendingQuestionForms(config, "session"), await replyOpenCodeForm(config, "session", "form", {q0:"fixture-answer"})]));
      `], {
        env: { ...process.env, http_proxy: proxy.url.origin, HTTP_PROXY: proxy.url.origin, https_proxy: proxy.url.origin, HTTPS_PROXY: proxy.url.origin, ALL_PROXY: proxy.url.origin, all_proxy: proxy.url.origin, NO_PROXY: "", no_proxy: "" },
        stdout: "pipe", stderr: "pipe", timeout: 4_000,
      });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(error).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual([[], { ok: true, status: 204 }]);
      expect(proxied).toEqual(["/control"]);
      expect(direct).toEqual(["GET", "POST"]);
    } finally { service.stop(true); proxy.stop(true); }
  });
  it.each(["http://localhost:4000", "https://127.0.0.1:4000", "http://example.com:4000", "file:///tmp/service", "not a URL"])("rejects untrusted service URL %s even with a port", (url) => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url, port: 4000, pid: process.pid, password: "fixture" }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects oversized service files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: process.pid, password: "x".repeat(65_536) }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects dead process ids", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: child.pid, password: "fixture" }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for its writer", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const path = join(tmp, "service.json");
    const child = Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    const reader = Bun.spawn([process.execPath, "-e", `import { readOpenCodeService } from ${JSON.stringify(import.meta.dir + "/opencode-service.ts")}; console.log(JSON.stringify(readOpenCodeService(${JSON.stringify(tmp)})));`], { stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => reader.kill(), 1_000);
    try {
      expect(await reader.exited).toBe(0);
      expect(await new Response(reader.stdout).text()).toBe("null\n");
    } finally {
      clearTimeout(deadline);
      reader.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed question fields at the HTTP boundary", async () => {
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => Response.json([{ id: "form", sessionID: "session", title: "Form", metadata: { kind: "question" }, fields: [null] }]),
    });
    try {
      expect(await listPendingQuestionForms({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" }, "session")).toEqual([]);
    } finally { service.stop(true); }
  });

  it("does not follow redirects with a user's answers", async () => {
    let forwarded = 0;
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { forwarded++; return new Response(null, { status: 204 }); } });
    const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: target.url.href } }) });
    try {
      const config = { baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" };
      expect(await listPendingQuestionForms(config, "session")).toBeNull();
      expect(await replyOpenCodeForm(config, "session", "form", { q0: "private" })).toEqual({ ok: false, status: 307 });
      expect(forwarded).toBe(0);
    } finally { service.stop(true); target.stop(true); }
  });
  it("resolves state dir from XDG_STATE_HOME or home directory", () => {
    expect(opencodeStateDir({ XDG_STATE_HOME: "/custom/state" }, "/home/user")).toBe("/custom/state/opencode");
    expect(opencodeStateDir({}, "/home/user")).toBe("/home/user/.local/state/opencode");
  });

  it("reads service.json when valid and returns null on missing or invalid file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), "invalid json");
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: 1234 }));
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: process.pid, password: "test-password" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:4000", port: 4000, pid: process.pid, password: "test-password" });

      // With url (OpenCode 2.0.32 format)
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: process.pid, password: "secret" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:49374", port: 49374, pid: process.pid, password: "secret" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads the version service.json records", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: process.pid, password: "secret", version: "2.0.32" }));
      expect(readOpenCodeService(tmp)?.version).toBe("2.0.32");
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: process.pid, password: "secret", version: 2 }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verifies the process at the URL by the pid and version service.json names", async () => {
    let info: Record<string, unknown> = { version: "2.0.32", pid: process.pid, urls: [], paths: { tmp: "/tmp" } };
    await withService((request) => {
      expect(new URL(request.url).pathname).toBe("/api/info");
      expect(atob((request.headers.get("authorization") ?? "").slice(6))).toBe("opencode:test-pass");
      return Response.json(info);
    }, async (config) => {
      expect(await verifyOpenCodeService(config)).toBe("2.0.32");
      expect(await verifyOpenCodeService({ ...config, version: "2.0.32" })).toBe("2.0.32");
      expect(await verifyOpenCodeService({ ...config, version: "2.0.31" })).toBeNull();
      info = { ...info, pid: process.pid + 1 };
      expect(await verifyOpenCodeService(config)).toBeNull();
    });
  });

  it("ignores a service.json whose pid is not the process answering at its URL", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "2.0.32", pid: 1, urls: [], paths: { tmp: "/tmp" } }) });
    try {
      forgetOpenCodeService();
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: service.url.origin, pid: process.pid, password: "fixture", version: "2.0.32" }));
      expect(await openCodeService(tmp)).toBeNull();
    } finally {
      service.stop(true);
      forgetOpenCodeService();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("knows a session only when the service holds it", async () => {
    await withService((request) => {
      const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      return id === "ses_held" ? Response.json({ data: { id } }) : Response.json({ _tag: "SessionNotFoundError" }, { status: 404 });
    }, async (config) => {
      expect(await openCodeHasSession(config, "ses_held")).toBe(true);
      expect(await openCodeHasSession(config, "ses_other")).toBe(false);
    });
  });

  it("lists commands and skills for the pane's directory in the pinned shapes", async () => {
    const seen: string[] = [];
    let skills: unknown[] = [
      { id: "effect", name: "effect", description: "Apply Effect", path: "/home/u/.config/opencode/skills/effect/SKILL.md", content: "x" },
      { id: "bad id", name: "x", path: "/p", content: "" },
    ];
    await withService((request) => {
      const url = new URL(request.url);
      seen.push(`${url.pathname}?${url.searchParams.get("location[directory]")}`);
      const directory = url.searchParams.get("location[directory]");
      const data = url.pathname === "/api/command" ? [{ name: "review", description: "review changes" }, { name: "shipit" }, { description: "no name" }] : skills;
      return Response.json({ location: { directory }, data });
    }, async (config) => {
      expect(await listOpenCodeCatalog(config, "/work/proj")).toEqual({
        commands: [{ name: "review", description: "review changes" }, { name: "shipit" }],
        skills: [{ id: "effect", name: "effect", description: "Apply Effect", path: "/home/u/.config/opencode/skills/effect/SKILL.md" }],
      });
      expect(seen.sort()).toEqual(["/api/command?/work/proj", "/api/skill?/work/proj"]);
      skills = [];
      expect(await listOpenCodeCatalog(config, "/work/proj")).toBeNull();
    });
    await withService(() => Response.json({ location: { directory: "/elsewhere" }, data: [] }), async (config) => {
      expect(await listOpenCodeCatalog(config, "/work/proj")).toBeNull();
    });
  });

  it("parses event blocks and ignores heartbeats and torn data", () => {
    expect(parseOpenCodeEvent(": heartbeat")).toBeNull();
    expect(parseOpenCodeEvent("data: {\"type\":")).toBeNull();
    expect(parseOpenCodeEvent(`data: ${JSON.stringify({ id: "evt_1", created: 5, type: "skill.updated", location: { directory: "/p" }, data: {} })}`))
      .toEqual({ type: "skill.updated", created: 5, directory: "/p", data: {} });
    expect(parseOpenCodeEvent(`data: ${JSON.stringify({ type: "session.skill.activated", created: 7, data: { sessionID: "ses_1", id: "effect" } })}`))
      .toEqual({ type: "session.skill.activated", created: 7, data: { sessionID: "ses_1", id: "effect" } });
  });

  it("streams events, and reconnects after the stream ends so the caller re-reads", async () => {
    const opened = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const received = Promise.withResolvers<OpenCodeEvent>();
    const closed = Promise.withResolvers<void>();
    let connections = 0;
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => {
        const first = connections++ === 0;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n: heartbeat\n\n"));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "command.updated", created: 1, location: { directory: "/p" }, data: {} })}\n\n`));
            if (first) controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const events: string[] = [];
    let opens = 0;
    const subscription = subscribeOpenCodeEvents({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" }, {
      onOpen: () => opened[opens++]?.resolve(),
      onEvent: (event) => { events.push(event.type); if (event.type === "command.updated") received.resolve(event); },
      onClose: () => closed.resolve(),
    });
    try {
      await opened[0]!.promise;
      expect((await received.promise).directory).toBe("/p");
      await closed.promise;
      await opened[1]!.promise;
      expect(events.slice(0, 2)).toEqual(["server.connected", "command.updated"]);
    } finally {
      subscription.close();
      service.stop(true);
    }
  }, 5_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reads service.json again only when its stat changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-service-stat-"));
    const file = join(root, "service.json");
    await withService((request) => new URL(request.url).pathname === "/api/info" ? Response.json({ version: "2.0.32", pid: process.pid }) : new Response(null, { status: 404 }), async (config) => {
      writeFileSync(file, JSON.stringify({ url: config.baseUrl, pid: process.pid, password: "stat-pass" }));
      try {
        forgetOpenCodeService();
        expect((await openCodeService(root))?.version).toBe("2.0.32");
        // unreadable now, with the same size and mtime (chmod changes neither): a lookup that read it again would find no service
        const { mtime } = statSync(file);
        chmodSync(file, 0o000);
        forgetOpenCodeService();
        expect((await openCodeService(root))?.version).toBe("2.0.32");
        utimesSync(file, mtime, new Date(mtime.getTime() + 2_000));
        forgetOpenCodeService();
        expect(await openCodeService(root)).toBeNull();
      } finally {
        chmodSync(file, 0o600);
        forgetOpenCodeService();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("verifies service.json on Windows only for a caller that asks for it", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const root = mkdtempSync(join(tmpdir(), "opencode-windows-"));
    await withService((request) => new URL(request.url).pathname === "/api/info" ? Response.json({ version: "2.0.32", pid: process.pid }) : new Response(null, { status: 404 }), async (config) => {
      writeFileSync(join(root, "service.json"), JSON.stringify({ url: config.baseUrl, pid: process.pid, password: "windows-pass" }));
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        forgetOpenCodeService();
        expect(await openCodeService(root)).toBeNull();
        forgetOpenCodeService();
        expect((await openCodeService(root, undefined, { onWindows: true }))?.version).toBe("2.0.32");
      } finally {
        Object.defineProperty(process, "platform", platform);
        forgetOpenCodeService();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("reconnects after dropping a stream that outgrows its buffer", async () => {
    const opened = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const closed = Promise.withResolvers<void>();
    let connections = 0;
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1", idleTimeout: 0,
      fetch: () => {
        const first = connections++ === 0;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n"));
            if (first) controller.enqueue(encoder.encode(`data: ${"x".repeat(5 * 1024 * 1024)}`));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    let opens = 0;
    const subscription = subscribeOpenCodeEvents({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" }, {
      onOpen: () => opened[opens++]?.resolve(),
      onEvent: () => {},
      onClose: () => closed.resolve(),
    });
    try {
      await opened[0]!.promise;
      await closed.promise;
      await opened[1]!.promise;
      expect(connections).toBe(2);
    } finally {
      subscription.close();
      service.stop(true);
    }
  }, 5_000);

  it("formats Basic auth header correctly", () => {
    expect(atob(opencodeAuthHeader("secret-pass").slice(6))).toBe("opencode:secret-pass");
  });

  it.each(["array", "wrapper"])("lists and filters pending question forms in a %s", async (shape) => {
    let requestedUrl = "";
    let authHeader = "";
    await withService((request) => {
      requestedUrl = new URL(request.url).pathname;
      authHeader = request.headers.get("authorization") ?? "";
      const forms = [
          {
            id: "form-1",
            sessionID: "ses-123",
            title: "Question Form",
            metadata: { kind: "question" },
            fields: [{ key: "q0", type: "string", title: "Favorite color?" }],
          },
          {
            id: "form-2",
            sessionID: "ses-123",
            title: "Permission Form",
            metadata: { kind: "permission" },
            fields: [{ key: "allow", type: "boolean" }],
          },
          {
            id: "form-3",
            sessionID: "ses-123",
            title: "Unknown Form",
            fields: [],
          },
      ];
      return Response.json(shape === "array" ? forms : { data: forms });
    }, async (config) => {
      const forms = await listPendingQuestionForms(config, "ses-123");
      expect(requestedUrl).toBe("/api/session/ses-123/form");
      expect(atob(authHeader.slice(6))).toBe("opencode:test-pass");
      expect(forms?.length).toBe(1);
      expect(forms?.[0]?.id).toBe("form-1");
    });
  });

  it("handles non-200 responses when listing forms gracefully", async () => {
    await withService(() => new Response("Error", { status: 500 }), async (config) => {
      expect(await listPendingQuestionForms(config, "ses-123")).toBeNull();
    });
  });

  it("returns empty array for successful responses with no question forms", async () => {
    await withService(() => Response.json([]), async (config) => {
      expect(await listPendingQuestionForms(config, "ses-123")).toEqual([]);
    });
  });

  it("replies to forms with correct payload and headers", async () => {
    let postedBody = "";
    let authHeader = "";
    await withService(async (request) => {
      postedBody = await request.text();
      authHeader = request.headers.get("authorization") ?? "";
      expect(new URL(request.url).pathname).toBe("/api/session/ses-123/form/form-1/reply");
      return new Response(null, { status: 204 });
    }, async (config) => {
      const result = await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue", q1: ["A", "B"] });
      expect(result).toEqual({ ok: true, status: 204 });
      expect(atob(authHeader.slice(6))).toBe("opencode:test-pass");
      expect(JSON.parse(postedBody)).toEqual({ answer: { q0: "Blue", q1: ["A", "B"] } });
    });
  });

  it("handles reply errors such as 409 FormAlreadySettledError", async () => {
    await withService(() => Response.json({ error: "FormAlreadySettledError" }, { status: 409 }), async (config) => {
      expect(await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue" })).toEqual({ ok: false, status: 409 });
    });
  });

  it("rejects invalid JSON and oversized form responses", async () => {
    for (const body of ["not JSON", JSON.stringify({ data: [], padding: "x".repeat(2 * 1024 * 1024) })]) {
      await withService(() => new Response(body), async (config) => {
        expect(await listPendingQuestionForms(config, "ses-123")).toBeNull();
      });
    }
  });

  it("aborts the active native request when its caller cancels", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    await withService(() => { entered.resolve(); return release.promise; }, async (config) => {
      const controller = new AbortController();
      const listing = listPendingQuestionForms(config, "ses-123", controller.signal);
      await entered.promise;
      controller.abort();
      try { expect(await listing).toBeNull(); }
      finally { release.resolve(Response.json([])); }
    });
  });

  it("bounds a form response that sends headers but never finishes its body", async () => {
    let close: (() => void) | undefined;
    await withService(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("[")); close = () => controller.close(); },
      cancel() { close = undefined; },
    })), async (config) => {
      const start = performance.now();
      try {
        expect(await listPendingQuestionForms(config, "ses-123")).toBeNull();
        expect(performance.now() - start).toBeLessThan(2_500);
      } finally { close?.(); }
    });
  }, 3_000);

  it("accepts successful reply headers without waiting for an unused body", async () => {
    let close: (() => void) | undefined;
    await withService(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("accepted")); close = () => controller.close(); },
      cancel() { close = undefined; },
    })), async (config) => {
      try {
        expect(await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue" })).toEqual({ ok: true, status: 200 });
      } finally { close?.(); }
    });
  });

});
