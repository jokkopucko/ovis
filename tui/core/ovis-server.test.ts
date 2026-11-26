import { afterEach, describe, expect, it } from "bun:test";
import { ovisServer } from "./ovis-server.ts";

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => { for (const one of servers.splice(0)) one.stop(true); });

/** a loopback server that records what reached it and answers with `answer` */
function listening(answer: (request: Request) => Response) {
  const seen: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { seen.push(`${request.method} ${new URL(request.url).pathname}`); return answer(request); } });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, seen };
}

describe("the screen's door to the Ovis server", () => {
  it("does not follow a redirect: a 307 to another server's route is a refusal, and that server is never asked", async () => {
    const other = listening(() => Response.json({ ok: true, path: "/elsewhere", forced: false }));
    const first = listening(() => new Response(null, { status: 307, headers: { location: `${other.origin}/api/workspace/close` } }));
    expect(await ovisServer(first.origin).removeWorktree("w1")).toEqual({ ok: false, code: "server_redirected", message: "307" });
    expect(await ovisServer(first.origin).createWorktree("w1", "worktree/a")).toEqual({ ok: false, code: "server_redirected", message: "307" });
    expect(first.seen).toEqual(["POST /api/worktree/remove-checked", "POST /api/worktree/create-checked"]);
    expect(other.seen).toEqual([]);
  });

  it("goes straight to the server whatever proxy the environment names: the proxy never sees the request or answers for it", async () => {
    const target = listening(() => Response.json({ ok: true, path: "/target", forced: false }));
    const proxy = listening(() => Response.json({ ok: true, path: "/made-up-by-the-proxy", forced: false }));
    const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = name.toLowerCase().startsWith("no_") ? "" : proxy.origin;
      expect(await ovisServer(target.origin).removeWorktree("w1")).toEqual({ ok: true, value: { path: "/target" } });
    } finally {
      for (const name of names) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
    expect(proxy.seen).toEqual([]);
    expect(target.seen).toEqual(["POST /api/worktree/remove-checked"]);
  });

  it("asks only a loopback http origin with no path; any other address is refused before a request leaves", async () => {
    const asked: { url: string; redirect: RequestInit["redirect"] }[] = [];
    const send = async (url: string, init: RequestInit) => {
      asked.push({ url, redirect: init.redirect });
      return Response.json({ ok: true, path: "/p", forced: false });
    };
    for (const given of ["http://192.168.0.5:17317", "http://example.com", "http://localhost.evil.example:1", "https://127.0.0.1:1", "http://127.0.0.1:1/api", "http://u@127.0.0.1:1", "http://127.0.0.1:1?x=1", "http://0.0.0.0:1", "not a url"]) {
      expect([given, await ovisServer(given, send).removeWorktree("w1")]).toEqual([given, { ok: false, code: "server_not_loopback", message: given }]);
    }
    expect(asked).toEqual([]);
    for (const given of ["http://127.0.0.1:5", "http://127.4.5.6:5", "http://localhost:5", "http://[::1]:5", "http://127.0.0.1:5/"]) {
      expect((await ovisServer(given, send).removeWorktree("w1")).ok).toBe(true);
    }
    expect(asked.map((one) => [one.url, one.redirect])).toEqual([
      ["http://127.0.0.1:5/api/worktree/remove-checked", "manual"], ["http://127.4.5.6:5/api/worktree/remove-checked", "manual"],
      ["http://localhost:5/api/worktree/remove-checked", "manual"], ["http://[::1]:5/api/worktree/remove-checked", "manual"], ["http://127.0.0.1:5/api/worktree/remove-checked", "manual"],
    ]);
  });

  it("counts only an answer in the route's own shape as done", async () => {
    const answers = [
      Response.json({ ok: true }),
      Response.json({ ok: true, path: "/p" }),
      Response.json({ workspace_id: "w2", pane_id: "p2", path: "/p", branch: "another", already_open: false }),
      new Response("<html>a page</html>", { headers: { "content-type": "text/html" } }),
    ];
    const send = async () => answers.shift()!;
    const server = ovisServer("http://127.0.0.1:5", send);
    expect((await server.removeWorktree("w1")).ok).toBe(false);
    expect((await server.removeWorktree("w1")).ok).toBe(false);
    expect((await server.createWorktree("w1", "worktree/a")).ok).toBe(false);
    expect((await server.createWorktree("w1", "worktree/a")).ok).toBe(false);
    const done = ovisServer("http://127.0.0.1:5", async () => Response.json({ workspace_id: "w2", pane_id: "p2", path: "/p", branch: "worktree/a", already_open: false }));
    expect(await done.createWorktree("w1", "worktree/a")).toEqual({ ok: true, value: { workspace: "w2", pane: "p2", path: "/p" } });
  });
});
