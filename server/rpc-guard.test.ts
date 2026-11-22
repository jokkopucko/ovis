import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc } from "./herdr/client.ts";

let dir = "";
let listener: ReturnType<typeof Bun.listen> | null = null;
afterEach(() => {
  listener?.stop(true);
  listener = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function standIn(): { path: string; written: string[] } {
  dir = mkdtempSync(join(tmpdir(), "rpc-guard-"));
  const path = join(dir, "herdr.sock");
  const written: string[] = [];
  listener = Bun.listen({
    unix: path,
    socket: {
      data(sock, chunk) {
        const line = chunk.toString();
        written.push(line);
        sock.write(`${JSON.stringify({ id: JSON.parse(line).id, result: {} })}\n`);
      },
    },
  });
  return { path, written };
}

it("writes nothing when the sender's right lapses while the connection is made (#545)", async () => {
  const { path, written } = standIn();
  let allowed = true;
  const call = herdrRpc("pane.send_keys", { pane_id: "p", keys: ["Enter"] }, path, 2_000, () => allowed);
  // the connect is awaited: the sender detaches (or is revoked) meanwhile
  allowed = false;
  const error = await call.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(HerdrError);
  expect((error as HerdrError).code).toBe("cancelled");
  expect(written).toEqual([]);
});

it("writes the request when the guard still holds", async () => {
  const { path, written } = standIn();
  await herdrRpc("pane.send_keys", { pane_id: "p", keys: ["Enter"] }, path, 2_000, () => true);
  expect(written).toHaveLength(1);
  expect(JSON.parse(written[0]!)).toMatchObject({ method: "pane.send_keys", params: { pane_id: "p", keys: ["Enter"] } });
});
