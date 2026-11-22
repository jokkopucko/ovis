import { afterAll, describe, expect, it } from "bun:test";

import { agentRowTokens } from "./herdr-sidebar.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const asked: (string | null)[] = [];
const promptAsked: (string | null)[] = [];
const PLAN_CARD = { id: "claude-plan:abc", agent: "claude", kind: "plan", title: "Plan", question: "Would you like to proceed?", options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null };
const historyAsked: (string | null)[] = [];
const commandsAsked: string[] = [];
const filesAsked: string[] = [];
const worktreesAsked: string[] = [];
const faviconAsked: { search: string; authorization: string | null; cookie: string | null }[] = [];
const textAsked: { method: string; body: string; authorization: string | null; contentType: string | null }[] = [];
const diffAsked: { path: string; search: string; authorization: string | null; cookie: string | null; forwarded: string | null }[] = [];
const catalogAsked: string[] = [];
const summaryAsked: { search: string; authorization: string | null }[] = [];
const remote = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/pane/conversation/image") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    if (path === "/api/pane/conversation/tool-output") return new Response("complete remote output", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".mixed")) {
      return new Response("<script>document.title = 'ran'</script>", { headers: { "content-type": "application/pdf, text/html" } });
    }
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".pdfparams")) {
      return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf;x=y, text/html" } });
    }
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".svg")) {
      return new Response("<svg xmlns='http://www.w3.org/2000/svg'><script>parent.document.title = 'ran'</script></svg>", { headers: { "content-type": "image/svg+xml", "content-security-policy": "script-src *" } });
    }
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".loose")) {
      return new Response("<script>fetch('https://example.invalid/')</script>", { headers: { "content-type": "text/html", "content-security-policy": "default-src *; script-src 'unsafe-inline' *" } });
    }
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".htmlparams")) {
      return new Response("<svg xmlns='http://www.w3.org/2000/svg'><script>parent.document.title = 'ran'</script></svg>", { headers: { "content-type": "text/html;x=y, image/svg+xml" } });
    }
    // a page that names no policy of its own
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".bare")) {
      return new Response("<script>fetch('https://example.invalid/')</script>", { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/api/fs/file" && new URL(request.url).searchParams.get("path")?.endsWith(".html")) {
      return new Response("<script>parent.document.title = 'ran'</script>", { headers: { "content-type": "text/html", "content-security-policy": "script-src *", "x-content-type-options": "sniff" } });
    }
    if (path === "/api/fs/file") return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    if (path === "/api/session") return Response.json({ snapshot: { workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "t1", agent: "claude", tokens: { quota: "off · private", eta: "soon" } }], agents: [] } });
    if (path === "/api/sessions/history") {
      historyAsked.push(request.headers.get("authorization"));
      return Response.json({ workspace_id: "w1", agent: "pi", cwd: "/work", sessions: [{ id: "s1", title: null, firstMessage: "a private prompt", startedAt: null, updatedAt: "2026-10-01T00:00:00.000Z", resume: null }] });
    }
    if (path === "/api/pane/commands" || path === "/api/agent/commands") {
      commandsAsked.push(path);
      if (new URL(request.url).searchParams.get("pane_id") === "busy") return Response.json({ error: { code: "file_busy", message: "the skill folders did not answer in time" } }, { status: 503, headers: { "retry-after": "1" } });
      return Response.json({ commands: [{ name: "deploy", description: "SECRET", source: "custom", id: "/work/.commandcode/commands/deploy.md" }] });
    }
    if (path === "/api/pane/files" || path === "/api/plugin/action" || path === "/api/pane/docs") {
      filesAsked.push(path);
      if (path === "/api/pane/docs") return Response.json({ root: "/work", documents: [{ path: "SECRET.md", size: 1, modified: "2026-11-01T00:00:00.000Z" }], truncated: false });
      return Response.json(path === "/api/pane/files" ? { files: [".env.SECRET"] } : { log_id: "plugin-log-1", status: "failed", exit_code: 1, output: "SECRET", opened_pane_id: null });
    }
    if (path === "/api/worktree/list") {
      worktreesAsked.push(path);
      return Response.json({ source: { repo_key: "repo" }, worktrees: [{ path: "/work-wt/SECRET", branch: "SECRET", open_workspace_id: null }] });
    }
    if (path === "/api/fs/text") {
      return request.text().then((body) => {
        textAsked.push({ method: request.method, body, authorization: request.headers.get("authorization"), contentType: request.headers.get("content-type") });
        return Response.json({ error: { code: "stale_revision", message: "changed", revision: "b".repeat(64) } }, { status: 409 });
      });
    }
    if (path === "/api/fs/favicon") {
      faviconAsked.push({ search: new URL(request.url).search, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
      return Response.json({ icon: null });
    }
    if (path === "/api/pane/summary") {
      summaryAsked.push({ search: new URL(request.url).search, authorization: request.headers.get("authorization") });
      return Response.json({ server_time: "2026-11-12T10:00:00.000Z", summaries: { "w1:p1": { role: "assistant", text: "Done.", at: "2026-11-12T09:59:00Z", asked_at: null } } }, { headers: { "cache-control": "no-store" } });
    }
    if (path === "/api/agent-catalog") {
      catalogAsked.push(new URL(request.url).search);
      return Response.json({ platform: "macos", agents: [] });
    }
    if (path === "/api/pane/prompt") {
      const search = new URL(request.url).searchParams;
      promptAsked.push(search.get("plan"));
      const screen = search.get("plan") === "0" && search.get("pane_id") !== "old";
      return Response.json({ prompt: screen
        ? { ...PLAN_CARD, body: "4. The last step that fits the pane." }
        : { ...PLAN_CARD, id: `${PLAN_CARD.id}.0123abcd`, body: "1. A secret step from the plan file.", plan_file: "/home/u/.claude/plans/p.md" }, suggestion: null, restored: null });
    }
    if (path.startsWith("/api/workspace/diff/") || path.startsWith("/api/workspace/git/")) {
      diffAsked.push({ path, search: new URL(request.url).search, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), forwarded: request.headers.get("x-forwarded-for") });
      return Response.json({ files: [], total: 0, truncated: false }, { headers: { "set-cookie": "remote=1" } });
    }
    const ifNoneMatch = request.headers.get("if-none-match");
    asked.push(ifNoneMatch);
    if (ifNoneMatch === "\"v1\"") return new Response(null, { status: 304, headers: { etag: "\"v1\"", "x-server-time": "2026-11-05T10:00:00.000Z" } });
    return Response.json({ source: "claude-transcript", turns: [] }, { headers: { etag: "\"v1\"" } });
  },
});
afterAll(() => remote.stop());

const manager = {
  endpoint: () => ({ url: `http://127.0.0.1:${remote.port}`, token: "remote-token" }),
  trackTerminal: () => () => undefined,
} as unknown as MachineManager;

describe("PC proxy", () => {
  it("carries a conversation's ETag both ways and passes an unchanged answer on as a bodyless 304", async () => {
    const url = "http://127.0.0.1/api/machines/pc1/pane/conversation?pane_id=w1%3Ap1";
    const first = await handleMachineRequest(new Request(url), manager);
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe("\"v1\"");
    await first.json();
    const unchanged = await handleMachineRequest(new Request(url, { headers: { "if-none-match": "\"v1\"" } }), manager);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe("\"v1\"");
    expect(unchanged.headers.get("x-server-time")).toBe("2026-11-05T10:00:00.000Z");
    expect(await unchanged.text()).toBe("");
    expect(asked).toEqual([null, "\"v1\""]);
  });
});

it("passes a pane summary request to the PC with its query, for a watching device too, and its answer back", async () => {
  const url = "http://127.0.0.1/api/machines/pc1/pane/summary?pane_id=w1%3Ap1&pane_id=w1%3Ap2";
  for (const readOnly of [false, true]) {
    const response = await handleMachineRequest(new Request(url), manager, undefined, undefined, readOnly);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ server_time: "2026-11-12T10:00:00.000Z", summaries: { "w1:p1": { role: "assistant", text: "Done.", at: "2026-11-12T09:59:00Z", asked_at: null } } });
  }
  expect(summaryAsked).toEqual([
    { search: "?pane_id=w1%3Ap1&pane_id=w1%3Ap2", authorization: "Bearer remote-token" },
    { search: "?pane_id=w1%3Ap1&pane_id=w1%3Ap2", authorization: "Bearer remote-token" },
  ]);
});

it("never has a PC run its shell profile again for a watching device's Check again: the PC sees this server's full token", async () => {
  const url = "http://127.0.0.1/api/machines/pc1/agent-catalog?recheck=1";
  expect((await handleMachineRequest(new Request(url), manager, undefined, undefined, true)).status).toBe(200);
  expect((await handleMachineRequest(new Request(url), manager, undefined, undefined, false)).status).toBe(200);
  expect(catalogAsked).toEqual(["", "?recheck=1"]);
});

it("never forwards a PC's session history to a watching device, nor a route spelled with a trailing, doubled or encoded slash", async () => {
  const base = "http://127.0.0.1/api/machines/pc1";
  const query = "?workspace_id=w1&agent=pi";
  const watched = await handleMachineRequest(new Request(`${base}/sessions/history${query}`), manager, undefined, undefined, true);
  expect(watched.status).toBe(403);
  expect(await watched.text()).not.toContain("a private prompt");
  for (const readOnly of [true, false]) {
    for (const path of ["sessions/history/", "sessions//history", "sessions%2Fhistory", "sessions%2fhistory", "pane/commands/", "workspace/directories/"]) {
      const response = await handleMachineRequest(new Request(`${base}/${path}${query}`), manager, undefined, undefined, readOnly);
      expect([readOnly, path, response.status]).toEqual([readOnly, path, 404]);
    }
  }
  expect(historyAsked).toEqual([]);
  // a driving device gets the PC's answer, asked with the PC's credential
  const driven = await handleMachineRequest(new Request(`${base}/sessions/history${query}`), manager);
  expect(driven.status).toBe(200);
  expect(JSON.stringify(await driven.json())).toContain("a private prompt");
  expect(historyAsked).toEqual(["Bearer remote-token"]);
});

it("never asks a PC for a pane's or a folder's command rows for a watching device (#2132)", async () => {
  const base = "http://127.0.0.1/api/machines/pc1";
  for (const path of ["pane/commands?pane_id=w1:p1", "agent/commands?agent=claude"]) {
    const watched = await handleMachineRequest(new Request(`${base}/${path}`), manager, undefined, undefined, true);
    expect([path, watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
  }
  expect(commandsAsked).toEqual([]);
  const driven = await handleMachineRequest(new Request(`${base}/pane/commands?pane_id=w1:p1`), manager);
  expect(driven.status).toBe(200);
  expect(JSON.stringify(await driven.json())).toContain("SECRET");
  expect(commandsAsked).toEqual(["/api/pane/commands"]);
});

it("carries a save to a PC's file with its body and the PC's credential, and its conflict back, but never for a watching device (#771)", async () => {
  const body = JSON.stringify({ pane_id: "w1:p1", path: "/work/notes.md", revision: "a".repeat(64), text: "new\n" });
  const put = (readOnly: boolean) => handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/text", {
    method: "PUT", body, headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json" },
  }), manager, undefined, undefined, readOnly);
  const watched = await put(true);
  expect([watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
  expect(textAsked).toEqual([]);
  const driven = await put(false);
  expect(driven.status).toBe(409);
  expect(await driven.json()).toMatchObject({ error: { code: "stale_revision", revision: "b".repeat(64) } });
  expect(textAsked).toEqual([{ method: "PUT", body, authorization: "Bearer remote-token", contentType: "application/json" }]);
});

it("passes on a PC's 503 with its Retry-After, so the menu knows to ask again (#2254)", async () => {
  const busy = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/pane/commands?pane_id=busy"), manager);
  expect(busy.status).toBe(503);
  expect(busy.headers.get("retry-after")).toBe("1");
  expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("file_busy");
});

it("never asks a PC for the paths under a pane's folder or a plugin run's output for a watching device (#2244)", async () => {
  const base = "http://127.0.0.1/api/machines/pc1";
  const routes = ["pane/files?pane_id=w1:p1&q=env", "plugin/action?plugin_id=deploy&log_id=plugin-log-1", "pane/docs?pane_id=w1:p1"];
  for (const path of routes) {
    const watched = await handleMachineRequest(new Request(`${base}/${path}`), manager, undefined, undefined, true);
    expect([path, watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
  }
  expect(filesAsked).toEqual([]);
  for (const path of routes) {
    const driven = await handleMachineRequest(new Request(`${base}/${path}`), manager);
    expect([path, driven.status, JSON.stringify(await driven.json()).includes("SECRET")]).toEqual([path, 200, true]);
  }
  expect(filesAsked).toEqual(["/api/pane/files", "/api/plugin/action", "/api/pane/docs"]);
});

it("never asks a PC for a repository's checkouts for a watching device (#2250)", async () => {
  const url = "http://127.0.0.1/api/machines/pc1/worktree/list?workspace_id=w1";
  const watched = await handleMachineRequest(new Request(url), manager, undefined, undefined, true);
  expect([watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
  expect(worktreesAsked).toEqual([]);
  const driven = await handleMachineRequest(new Request(url), manager);
  expect([driven.status, JSON.stringify(await driven.json()).includes("SECRET")]).toEqual([200, true]);
  expect(worktreesAsked).toEqual(["/api/worktree/list"]);
});

it("forwards conversation images and complete output, while rejecting arbitrary nested paths", async () => {
  const base = "http://127.0.0.1/api/machines/pc1/pane/conversation";
  const image = await handleMachineRequest(new Request(`${base}/image?pane_id=w1:p1&ref=asset`), manager);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  const output = await handleMachineRequest(new Request(`${base}/tool-output?pane_id=w1:p1&ref=call`), manager);
  expect(output.status).toBe(200);
  expect(await output.text()).toBe("complete remote output");
  expect((await handleMachineRequest(new Request(`${base}/unknown`), manager)).status).toBe(404);
});

it("opens a PC's file from a navigation another site started, and keeps every other route to this app", async () => {
  // Chrome on Android shows a PDF in the viewer's frame as an "Open" button; its navigation is cross-site
  const file = "http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.pdf";
  for (const site of ["cross-site", "same-site"]) {
    const response = await handleMachineRequest(new Request(file, { headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate" } }), manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.7");
  }
  const head = await handleMachineRequest(new Request(file, { method: "HEAD", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  // another page loading the file as a picture (a rendered HTML page probing which files exist) is not a navigation
  const probe = await handleMachineRequest(new Request(file, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } }), manager);
  expect(probe.status).toBe(403);
  expect((await probe.json()).error.code).toBe("cross_site");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("application/pdf");
  const crossSite = { "sec-fetch-site": "cross-site" };
  for (const request of [
    new Request("http://127.0.0.1/api/machines/pc1/fs/stat?path=%2Ftmp%2Freport.pdf", { headers: crossSite }),
    new Request("http://127.0.0.1/api/machines/pc1/pane/conversation?pane_id=w1%3Ap1", { headers: crossSite }),
    new Request(file, { method: "POST", headers: { ...crossSite, "x-herdr-machine": "1" } }),
    new Request(file, { headers: { origin: "https://evil.invalid", "sec-fetch-site": "same-origin" }, method: "PUT" }),
  ]) {
    const response = await handleMachineRequest(request, manager);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
  }
});

it("regression: a PC's answer never runs as this app's origin, whatever type and policy it names", async () => {
  const opened = "http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.html";
  for (const url of [opened, `${opened}&download=1`]) {
    const response = await handleMachineRequest(new Request(url, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  // a page drawn with its scripts keeps that PC's policy, with this server's page policy after it: no network, no other site's frame
  const ours = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  const page = await handleMachineRequest(new Request(`${opened}&render=1`), manager);
  expect(page.headers.get("content-security-policy")).toBe(`script-src *, ${ours}`);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  // whatever that PC's policy allows: this server's is added all the same
  const loose = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.loose&render=1"), manager);
  expect(loose.headers.get("content-security-policy")).toBe(`default-src *; script-src 'unsafe-inline' *, ${ours}`);
  // a page is passed on as HTML alone, whatever else its type names
  const typed = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.htmlparams&render=1"), manager);
  expect(typed.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(typed.headers.get("content-security-policy")).toBe(ours);
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  // a real PDF is still drawn by the browser's viewer, which refuses a sandbox
  const pdf = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.pdf"), manager);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(pdf.headers.get("content-security-policy")).toBeNull();
  expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
  // a PDF type with a parameter and another type after it is passed on as the PDF type alone
  for (const method of ["GET", "HEAD"]) {
    const named = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.pdfparams", { method }), manager);
    expect(named.status).toBe(200);
    expect(named.headers.get("content-type")).toBe("application/pdf");
    expect(named.headers.get("content-security-policy")).toBeNull();
    expect(named.headers.get("x-content-type-options")).toBe("nosniff");
  }
  // only an HTML answer is drawn as a page: a picture asked to render keeps the file policy
  const svg = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Fchart.svg&render=1"), manager);
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(svg.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  // a page that names no policy gets this server's own page policy, which reaches no network
  const bare = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.bare&render=1"), manager);
  expect(bare.headers.get("content-security-policy")).toBe(ours);
  for (const method of ["GET", "HEAD"]) {
    const mixed = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.mixed", { method }), manager);
    expect(mixed.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    expect(mixed.headers.get("x-content-type-options")).toBe("nosniff");
  }
  // nor does any other route of that PC's answer as a document of this origin
  const other = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/pane/conversation/tool-output?pane_id=w1:p1&ref=call"), manager);
  expect(other.status).toBe(200);
  expect(other.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(other.headers.get("x-content-type-options")).toBe("nosniff");
});

it("asks a PC for a folder's project icon once, with the bridge's own credential, and only from this app", async () => {
  const search = `?root=${encodeURIComponent("/home/u/my app")}`;
  const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/fs/favicon${search}`, { headers: { cookie: "ovis_token=browser-secret" } }), manager);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ icon: null });
  expect(faviconAsked).toEqual([{ search, authorization: "Bearer remote-token", cookie: null }]);
  // unlike a file itself, it is never opened by a navigation from another site
  const crossSite = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/fs/favicon${search}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({ error: { code: "invalid_origin" } });
  expect(faviconAsked).toHaveLength(1);
});

it("refuses a path with an empty segment instead of forwarding it as another route", async () => {
  const before = asked.length;
  for (const path of ["pc1//fs/file?path=%2Fetc%2Fhostname", "pc1/fs//file?path=%2Fetc%2Fhostname", "pc1//session"]) {
    expect((await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${path}`), manager)).status).toBe(404);
  }
  expect(asked.length).toBe(before);
});

it("forwards a repository diff or history read with its query and the bridge's own credential, and nothing of the browser's", async () => {
  const before = diffAsked.length;
  const search = "?pane_id=w1%3Ap1&scope=commit&base=HEAD~1&path=dir%20with%20space%2Fa.txt";
  const routes = ["diff/files", "diff/file", "diff/refs", "git/log", "git/branches", "git/show"];
  for (const route of routes) {
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/workspace/${route}${search}`, {
      headers: { cookie: "ovis_token=browser-secret; ovis_device=device-secret", authorization: "Bearer browser-secret", "x-forwarded-for": "203.0.113.9" },
    }), manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ files: [], total: 0, truncated: false });
  }
  expect(diffAsked.slice(before)).toEqual(routes.map((route) => ({ path: `/api/workspace/${route}`, search, authorization: "Bearer remote-token", cookie: null, forwarded: null })));
  // only the three reads are routes: nothing else under that name reaches the PC
  for (const path of ["workspace/diff", "workspace/diff/file/extra", "workspace/diff/apply", "workspace/diffs/file", "workspace/git", "workspace/git/log/extra", "workspace/git/checkout"]) {
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/${path}${search}`), manager);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  }
  const crossSite = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/workspace/diff/file${search}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({ error: { code: "invalid_origin" } });
  expect(diffAsked.length).toBe(before + routes.length);
});

it("gives a watching device a PC's plan card without Claude's plan file, even from a PC that ignores the ask", async () => {
  const before = promptAsked.length;
  const poll = async (pane: string, readOnly: boolean) => {
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/pane/prompt?pane_id=${pane}`), manager, undefined, undefined, readOnly);
    expect(response.status).toBe(200);
    return (await response.json()) as { prompt: Record<string, unknown> };
  };
  for (const pane of ["w1%3Ap1", "old"]) {
    const watched = await poll(pane, true);
    expect(watched.prompt).toMatchObject({ kind: "plan", question: "Would you like to proceed?", options: [{ label: "Yes", description: null }] });
    expect(watched.prompt).not.toHaveProperty("plan_file");
    expect(JSON.stringify(watched)).not.toContain("secret step");
  }
  expect((await poll("w1%3Ap1", false)).prompt).toMatchObject({ plan_file: "/home/u/.claude/plans/p.md", body: "1. A secret step from the plan file." });
  expect(promptAsked.slice(before)).toEqual(["0", "0", null]);
});

it("passes a PC's session on without the token values this server's sidebar rows hide (#2160)", async () => {
  const rows = agentRowTokens(Bun.TOML.parse(`[ui.sidebar.agents]\nrows = [[{ token = "$quota", rules = [{ starts_with = "off", hide = true }] }, "$eta"]]`));
  const sidebar = { get: () => rows, subscribe: () => () => undefined };
  for (const readOnly of [true, false]) {
    const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session"), manager, undefined, undefined, readOnly, sidebar);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("off · private");
    expect((JSON.parse(text) as { snapshot: { panes: { tokens: unknown }[] } }).snapshot.panes[0]!.tokens).toEqual({ eta: "soon" });
  }
  // any other method the PC answers with a body is filtered too (its session route takes them all)
  const asked = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session", { method: "OPTIONS", headers: { "x-herdr-machine": "1" } }), manager, undefined, undefined, true, sidebar);
  expect(await asked.text()).not.toContain("off · private");
  expect((await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session", { method: "HEAD" }), manager, undefined, undefined, true, sidebar)).status).toBe(200);
  const whole = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session"), manager, undefined, undefined, true, { get: () => null, subscribe: () => () => undefined });
  expect(await whole.text()).toContain("off · private");
});
