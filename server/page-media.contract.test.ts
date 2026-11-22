import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

const ADDRESS = /src="(https?:\/\/[^"/]+)(\/api\/fs\/page-media\/[A-Za-z0-9_-]{32})"/;
// as the sandboxed page asks for it: another site (it has no origin), no cookie, no token
const fromPage = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "video" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-page-media-"));
  const server = createServer({ port: 0, stateDir: join(root, "state"), token: "test-page-media", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const bytes = 9 * 1024 * 1024;
  writeFileSync(join(root, "clip.mp4"), "");
  truncateSync(join(root, "clip.mp4"), bytes);
  writeFileSync(join(root, "report.html"), `<video src="clip.mp4" controls></video>`);
  const pageUrl = `${base}/api/fs/file?path=${encodeURIComponent(join(root, "report.html"))}&render=1`;
  const render = async (headers: Record<string, string> = { authorization: "Bearer test-page-media" }) => {
    const page = await fetch(pageUrl, { headers });
    expect(page.status).toBe(200);
    const found = ADDRESS.exec(await page.text());
    expect(found).not.toBeNull();
    return { policy: page.headers.get("content-security-policy")!, origin: found![1]!, address: found![2]! };
  };
  return { root, server, base, bytes, render, close: () => { server.stop(); rmSync(root, { recursive: true, force: true }); } };
}

it("a rendered page plays its large video by the address it was given, and nothing else without the token", async () => {
  const { root, base, bytes, render, close } = fixture();
  try {
    const { policy, origin, address } = await render();
    expect(origin).toBe(base);
    expect(policy).toContain(`media-src data: blob: ${base}/api/fs/page-media/`);
    const played = await fetch(`${base}${address}`, { headers: { ...fromPage, range: "bytes=0-9" } });
    expect(played.status).toBe(206);
    expect(played.headers.get("content-range")).toBe(`bytes 0-9/${bytes}`);
    expect(played.headers.get("content-type")).toBe("video/mp4");
    expect((await fetch(`${base}${address}`, { method: "HEAD", headers: fromPage })).status).toBe(200);
    // a guessed address, and the same file by its path, stay closed
    expect((await fetch(`${base}/api/fs/page-media/${"A".repeat(32)}`, { headers: fromPage })).status).toBe(404);
    expect((await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(root, "clip.mp4"))}`, { headers: fromPage })).status).toBe(401);
    // and the address reads, never writes: another site's POST stops at the origin check before it
    expect((await fetch(`${base}${address}`, { method: "POST", headers: fromPage })).status).toBe(403);
  } finally { close(); }
});

it("an address the page passes on plays for no other client, and ends when that browser signs out", async () => {
  const { base, render, close } = fixture();
  try {
    const { address } = await render();
    expect((await fetch(`${base}${address}`, { headers: { ...fromPage, "x-forwarded-for": "198.51.100.7" } })).status).toBe(404);
    expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(200);
    const signedOut = await fetch(`${base}/api/auth`, { method: "DELETE", headers: { authorization: "Bearer test-page-media", origin: base } });
    expect(signedOut.status).toBe(204);
    expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(404);
  } finally { close(); }
});

it("revoking a paired device ends the page media its renders were given", async () => {
  const { base, render, close } = fixture();
  const admin = { authorization: "Bearer test-page-media", "x-herdr-machine": "1", "content-type": "application/json" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ code, label: "phone" }) });
    expect(paired.status).toBe(204);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const { address } = await render({ cookie });
    expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(200);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] };
    const phone = devices.find((device) => device.label === "phone")!;
    expect((await fetch(`${base}/api/devices/${phone.id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(404);
  } finally { close(); }
});

it("revoking every device ends the page media each device's renders were given, and not the token's", async () => {
  const { base, render, close } = fixture();
  const admin = { authorization: "Bearer test-page-media", "x-herdr-machine": "1", "content-type": "application/json" };
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ code, label }) });
      expect(paired.status).toBe(204);
      return paired.headers.get("set-cookie")!.split(";")[0]!;
    };
    const phone = await render({ cookie: await pair("phone") });
    const tablet = await render({ cookie: await pair("tablet") });
    const owner = await render();
    for (const { address } of [phone, tablet, owner]) expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(200);
    const revoked = await fetch(`${base}/api/devices/revoke-all`, { method: "POST", headers: admin });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: 2 });
    expect((await fetch(`${base}${phone.address}`, { headers: fromPage })).status).toBe(404);
    expect((await fetch(`${base}${tablet.address}`, { headers: fromPage })).status).toBe(404);
    expect((await fetch(`${base}${owner.address}`, { headers: fromPage })).status).toBe(200);
  } finally { close(); }
});

it("signing out ends page media rendered by a browser holding both the token and a device cookie", async () => {
  const { base, render, close } = fixture();
  const admin = { authorization: "Bearer test-page-media", "x-herdr-machine": "1", "content-type": "application/json" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ code, label: "laptop" }) });
    expect(paired.status).toBe(204);
    const both = { authorization: "Bearer test-page-media", cookie: paired.headers.get("set-cookie")!.split(";")[0]! };
    const { address } = await render(both);
    expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(200);
    expect((await fetch(`${base}/api/auth`, { method: "DELETE", headers: { ...both, origin: base } })).status).toBe(204);
    expect((await fetch(`${base}${address}`, { headers: fromPage })).status).toBe(404);
  } finally { close(); }
});

it("behind a proxy that rewrites Host, the policy and the address name the host the browser used", async () => {
  const { base, render, close } = fixture();
  try {
    const proxied = { "x-forwarded-host": "pc.example.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.5" };
    const { policy, origin, address } = await render({ authorization: "Bearer test-page-media", ...proxied });
    expect(origin).toBe("https://pc.example.ts.net");
    expect(policy).toContain("media-src data: blob: https://pc.example.ts.net/api/fs/page-media/");
    expect(policy).not.toContain(base);
    expect((await fetch(`${base}${address}`, { headers: { ...fromPage, "x-forwarded-for": "100.64.0.5" } })).status).toBe(200);
  } finally { close(); }
});
