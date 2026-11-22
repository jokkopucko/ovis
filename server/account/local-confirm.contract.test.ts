/**
 * The PC's server and its screen proof (device-row-states rows R8, Q20, N4, N6, and T47 for the proof): with the
 * release flag on, an act waiting for the PC's screen is answered only by the desktop-owner channel or the local
 * confirm listener; no request the server's routes take answers it. With the flag off neither exists.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bounded } from "../relay/test-helpers.ts";
import { LOCAL_CONFIRM_FILE, type LocalConfirms, type ScreenAction } from "./local-confirm.ts";
import { ask, memberRow, pairingPc, signIn, vouchFor, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

const BRIDGE_TOKEN = "b".repeat(64);

async function pc(accountOpensAll: boolean, desktop?: { input: ReadableStream<Uint8Array>; write(line: string): void }) {
  const member = await memberRow("acct_1");
  const made = Object.assign(await pairingPc({ rows: [member.row], server: { accountOpensAll, bridgeToken: BRIDGE_TOKEN, ...(desktop ? { desktopOwner: desktop } : {}) } }), { member });
  pcs.push(made);
  return made;
}

const confirmsOf = (made: Pc): LocalConfirms => made.app.context.services.localConfirms!;
const UNLOCK: ScreenAction = { kind: "unlock", lock: "lock-1" };

test("T47: a relay session, a bare loopback window, a forwarded window or the bridge credential cannot answer a screen confirmation", async () => {
  const made = await pc(true);
  made.account.opensAll = true;
  await vouchFor(made, "acct_1", made.member.key);
  expect(await made.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const confirms = confirmsOf(made);
  const { id } = confirms.request(UNLOCK, { title: "Unlock this PC", lines: [] });
  const path = `/api/account/local-confirm/${id}`;
  const body = { answer: "approve" };
  const tries = [
    await made.local(path, { method: "POST", headers: { "x-herdr-machine": "1" }, body }),
    await made.local(path, { method: "POST", headers: { "x-herdr-machine": "1", "x-forwarded-for": "100.64.0.9" }, body }),
    await made.local(path, { method: "POST", headers: { "x-herdr-machine": "1", authorization: `Bearer ${BRIDGE_TOKEN}` }, body }),
    await (async () => {
      const signed = await signIn(made, made.member.row.id, made.member.key);
      if ("error" in signed) throw new Error(`The sign-in was refused: ${signed.error}`);
      return ask(signed.link, path, { method: "POST", body });
    })(),
  ];
  for (const tried of tries) expect([tried.status, tried.body.error?.code]).toEqual([403, "local_required"]);
  expect(confirms.pending().map((open) => open.id)).toEqual([id]);
  expect(confirms.consume(id, UNLOCK)).toBe(false);
});

test("R8: the desktop-owner channel and the local confirm listener are the server's screen proof paths", async () => {
  let push!: (line: string) => void;
  const told: string[] = [];
  const input = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  const made = await pc(true, { input, write: (line) => { told.push(line); } });
  const confirms = confirmsOf(made);
  const first = confirms.request(UNLOCK, { title: "Unlock this PC", lines: [] });
  expect(told.length).toBeGreaterThan(0);
  push(`${JSON.stringify({ approve: first.id })}\n`);
  expect(await bounded(confirms.answer(first.id))).toBe("approved");
  expect(confirms.consume(first.id, UNLOCK)).toBe(true);
  if (process.platform !== "linux") return;
  const { port } = JSON.parse(readFileSync(join(made.stateDir, LOCAL_CONFIRM_FILE), "utf8")) as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const second = confirms.request({ kind: "lock" }, { title: "Lock this PC", lines: [] });
  const nonce = /name="nonce" value="([^"]+)"/.exec(await (await fetch(`${origin}/confirm/${second.id}`)).text())?.[1];
  const answered = await fetch(`${origin}/confirm/${second.id}`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce: nonce!, answer: "approve" }) });
  expect(answered.status).toBe(200);
  expect(await bounded(confirms.answer(second.id))).toBe("approved");
});

test("R8: the local confirm listener's port is in no answer of the server's routes", async () => {
  const made = await pc(true);
  if (process.platform !== "linux") return;
  const { port } = JSON.parse(readFileSync(join(made.stateDir, LOCAL_CONFIRM_FILE), "utf8")) as { port: number };
  for (const path of ["/api/account/status", "/api/devices", "/api/health", "/api/relay"]) {
    expect(JSON.stringify((await made.local(path)).body)).not.toContain(String(port));
  }
});

test("T47: with the release flag off there is no confirm listener, no channel and no confirm route", async () => {
  const made = await pc(false);
  expect(made.app.context.services.localConfirms).toBeUndefined();
  expect(existsSync(join(made.stateDir, LOCAL_CONFIRM_FILE))).toBe(false);
  const tried = await made.local("/api/account/local-confirm/x", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { answer: "approve" } });
  expect(tried.body.error?.code).not.toBe("local_required");
});
