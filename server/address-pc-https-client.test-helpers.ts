import { createServer } from "./index.ts";
import { PcAccountState } from "./account/pc-binding.ts";
import { loadAddressPcToken } from "./address-pc.ts";
import { join } from "node:path";

const [stateDir, target, code, mode] = process.argv.slice(2);
if (!stateDir || !target || !code || !mode) throw new Error("Missing HTTPS client fixture arguments");
if (mode === "bound") PcAccountState.open(stateDir).migrate("acct_1", true);
const a = createServer({ stateDir, port: 0, hostname: "127.0.0.1", platform: "linux", token: "",
  accountOpensAll: true, accountService: { url: "off" }, tailscaleOwner: null, sidecar: false, registerBridge: false });
try {
  const origin = `http://127.0.0.1:${a.port}`;
  const added = await fetch(`${origin}/api/machines/address`, { method: "POST", headers: {
    origin, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json",
  }, body: JSON.stringify({ address: target, code, name: "TLS peer" }) });
  const result = await added.json() as { machine?: { id: string; kind: string }; error?: { code: string } };
  const sessionStatus = result.machine ? (await fetch(`${target}/api/session`, {
    headers: { authorization: `Device ${loadAddressPcToken(join(stateDir, "address-pcs", `${result.machine.id}.json`))}` },
  })).status : null;
  console.log(JSON.stringify({ account: a.context.services.devices.account(), status: added.status,
    kind: result.machine?.kind, error: result.error?.code, sessionStatus }));
} finally { await a.stop(); }
