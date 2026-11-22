/** Fictional accounts for the My machines fixture, all drawn from one fixed time. */
import type {
  DeviceRef, InviteChoice, InviteRef, Machine, MachineNotice, MachineOrigin, MachineRef, MachineState, MachinesView, NewInvite,
} from "./machinesView.ts";

/** The moment every fixture is seen from: 14 Nov 2026, 13:20 in Seoul. */
export const FIXTURE_NOW = Date.parse("2026-11-14T04:20:00Z");
const MIN = 60_000;
const ago = (minutes: number): string => new Date(FIXTURE_NOW - minutes * MIN).toISOString();
const ahead = (minutes: number): string => new Date(FIXTURE_NOW + minutes * MIN).toISOString();

/** `length` hex characters that depend only on `seed`: ids and hashes that look like them and never change. */
function hexOf(seed: string, length: number): string {
  let state = 2166136261;
  let out = "";
  while (out.length < length) {
    for (const char of `${seed}:${out.length}`) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}
const PHONE: DeviceRef = { id: "device-phone", name: "Hako's iPhone" };
const BROWSER: DeviceRef = { id: "device-browser", name: "Chrome on Linux" };
const MAC: DeviceRef = { id: "device-mac", name: "Ovis for Mac" };
const PIXEL: DeviceRef = { id: "device-pixel", name: "Pixel 9" };

const inviteRef = (seed: string, label: string, uses: number): InviteRef => ({ id: hexOf(seed, 64), label, uses });
const BUILD_POOL = inviteRef("invite-build", "ci-pool", 5);
const GPU_RACK = inviteRef("invite-gpu", "gpu-rack", 3);
const STAGING_LINE = inviteRef("invite-revoked", "staging", 4);
const PIXEL_LINE = inviteRef("invite-pixel", "quick", 2);

const byInvite = (invite: InviteRef, nth: number, madeBy: DeviceRef, madeMinutesAgo: number, joinedMinutesAgo: number): MachineOrigin =>
  ({ kind: "invite", invite, nth, madeBy, madeAt: ago(madeMinutesAgo), joinedAt: ago(joinedMinutesAgo) });

interface MachineSpec {
  readonly name: string; readonly state: MachineState; readonly engine?: Machine["engine"]; readonly kind?: Machine["kind"]; readonly cameIn?: MachineOrigin;
  readonly runsOwnOvis?: boolean; readonly setupIncomplete?: true; readonly list?: Machine["list"];
}

const machine = (spec: MachineSpec): Machine => ({
  id: hexOf(`machine-${spec.name}`, 32),
  name: spec.name,
  kind: spec.kind ?? "machine",
  engine: spec.engine ?? "herdr-core",
  state: spec.state,
  cameIn: spec.cameIn ?? byInvite(BUILD_POOL, 1, PHONE, 300, 290),
  runsOwnOvis: spec.runsOwnOvis ?? false,
  ...(spec.setupIncomplete ? { setupIncomplete: true } : {}),
  ...(spec.list ? { list: spec.list } : {}),
});
const refOf = (entry: Machine): MachineRef => ({ id: entry.id, name: entry.name });

const direct = (delayMs: number): MachineState => ({ kind: "ready", route: { via: "direct", delayMs } });
const relayed = (delayMs: number): MachineState => ({ kind: "ready", route: { via: "relay", delayMs } });

const BUILD_01 = machine({ name: "build-01", state: direct(4), list: { stuck: false, stopped: null, polledAt: ago(0) } });
const BUILD_02 = machine({ name: "build-02", state: relayed(62), cameIn: byInvite(BUILD_POOL, 2, PHONE, 300, 240), list: { stuck: true, stopped: 57, polledAt: ago(12) } });
const GPU = machine({ name: "gpu-a100", engine: "herdr", state: { kind: "offline", reason: "not-connected", lastSeenAt: ago(190) }, cameIn: byInvite(GPU_RACK, 1, BROWSER, 4320, 4310) });
const STAGING = machine({ name: "staging-db", state: { kind: "unreachable", reason: "no-answer", triedAt: ago(1) }, cameIn: byInvite(STAGING_LINE, 1, PHONE, 2900, 2890) });
const RUNNER = machine({ name: "ci-runner-07", engine: "not-seen", state: { kind: "joining" }, cameIn: byInvite(BUILD_POOL, 3, PHONE, 300, 1) });
const VAULT = machine({ name: "backup-vault", engine: "herdr", state: { kind: "needs-update", knowsThisDevice: true }, cameIn: byInvite(GPU_RACK, 2, BROWSER, 4320, 4000),
  list: { stuck: false, stopped: null, polledAt: ago(6) } });
const STUDIO = machine({ name: "studio-desktop", kind: "pc", engine: "herdr", state: direct(2), cameIn: { kind: "paired", addedBy: BROWSER, addedAt: ago(8640) }, runsOwnOvis: true });
const LAPTOP = machine({ name: "work-laptop", kind: "pc", engine: "herdr", state: { kind: "offline", reason: "not-connected", lastSeenAt: ago(2880) }, cameIn: { kind: "paired", addedBy: MAC, addedAt: ago(7200) }, runsOwnOvis: true });
const SANDBOX = machine({ name: "old-sandbox", engine: "herdr", state: { kind: "removed", removedBy: BROWSER, removedAt: ago(125) }, cameIn: byInvite(GPU_RACK, 3, BROWSER, 4320, 4200) });
/** The machine that joined with the invite the Pixel made a minute after it got in. */
const SCRATCH = machine({ name: "scratch-vm", state: direct(14), cameIn: byInvite(PIXEL_LINE, 1, PIXEL, 2, 1) });

const MIXED: readonly Machine[] = [BUILD_01, BUILD_02, GPU, STAGING, RUNNER, VAULT, STUDIO, LAPTOP, SANDBOX, SCRATCH];

/** Today's product (todayMachines.ts): PCs whose engine and adder are not known, with every state only today's source gives. */
const today = (spec: Omit<MachineSpec, "kind" | "engine" | "runsOwnOvis">): Machine => machine({ kind: "pc", engine: "not-known", runsOwnOvis: true, ...spec });
const TODAY: readonly Machine[] = [
  today({ name: "home-desk", state: relayed(41), cameIn: { kind: "not-known", listedAt: ago(4320) } }),
  today({ name: "m1-box", state: { kind: "needs-approval", canAsk: true }, cameIn: { kind: "not-known", listedAt: ago(30) } }),
  today({ name: "old-nas", state: { kind: "needs-approval", canAsk: false }, cameIn: { kind: "not-known", listedAt: ago(20160) } }),
  today({ name: "m2-box", state: { kind: "unchecked", checking: true, lastSeenAt: ago(3) }, cameIn: { kind: "not-known", listedAt: ago(600) } }),
  today({ name: "m3-box", state: { kind: "unchecked", checking: false, lastSeenAt: ago(4) }, cameIn: { kind: "not-known", listedAt: ago(700) }, setupIncomplete: true }),
  today({ name: "qr-laptop", state: direct(3), cameIn: { kind: "not-known", listedAt: null } }),
  today({ name: "m4-box", state: { kind: "offline", reason: "not-connected", lastSeenAt: ago(190) }, cameIn: { kind: "not-known", listedAt: ago(800) }, setupIncomplete: true }),
  today({ name: "pc-a", state: { kind: "unreachable", reason: "relay-unreachable", triedAt: ago(1) }, cameIn: { kind: "not-known", listedAt: ago(9000) } }),
  today({ name: "old-pc", state: { kind: "needs-update", knowsThisDevice: true }, cameIn: { kind: "not-known", listedAt: ago(12000) } }),
];

/** Twenty machines and two PCs: seventeen ready, one offline, one that could not be reached, one joining. */
function twenty(): Machine[] {
  const names = ["build-01", "build-02", "build-03", "build-04", "build-05", "build-06", "gpu-a100-01", "gpu-a100-02", "gpu-h100-01", "gpu-h100-02",
    "ci-runner-01", "ci-runner-02", "ci-runner-03", "ci-runner-04", "ci-runner-05", "ci-runner-06", "staging-web", "staging-db", "edge-tokyo", "render-node-eu-central-1-spot-b7f3"];
  const pool: InviteRef = { ...BUILD_POOL, uses: 20 };
  const machines = names.map((name, index): Machine => {
    const state: MachineState = index === 8 ? { kind: "offline", reason: "no-relay-place", lastSeenAt: ago(55) }
      : index === 17 ? { kind: "unreachable", reason: "relay-unreachable", triedAt: ago(0) }
      : index === 15 ? { kind: "joining" }
      : index % 3 === 0 ? relayed(40 + index * 7) : direct(2 + index);
    return machine({ name, engine: index === 15 ? "not-seen" : index % 4 === 0 ? "herdr" : "herdr-core", state, cameIn: byInvite(pool, index + 1, PHONE, 300, 280 - index * 9) });
  });
  return [...machines, STUDIO, LAPTOP];
}

const notices: readonly MachineNotice[] = [
  { id: "notice-scratch", machine: refOf(SCRATCH), how: SCRATCH.cameIn },
  { id: "notice-runner", machine: refOf(RUNNER), how: RUNNER.cameIn },
];

export type FixtureAccount = "mixed" | "empty" | "offline" | "unreachable" | "twenty" | "today" | "behind" | "joining" | "needs-update";

/** The account a fixture state draws. "behind": the mixed account on a device whose own copy needs a newer Ovis. */
export function fixtureView(account: FixtureAccount, viewer: "watcher" | "driver"): MachinesView {
  const machines = (() => {
    switch (account) {
      case "today": return TODAY;
      case "mixed": case "behind": return MIXED;
      case "empty": return [];
      case "offline": return [BUILD_01, GPU, BUILD_02];
      case "unreachable": return [BUILD_01, STAGING, BUILD_02];
      case "joining": return [BUILD_01, RUNNER, BUILD_02];
      case "needs-update": return [BUILD_01, VAULT, BUILD_02];
      case "twenty": return twenty();
    }
  })();
  return {
    machines,
    role: viewer === "watcher" ? "watch" : "drive",
    ...(account === "mixed" ? { notices } : {}),
    ...(account === "behind" ? { thisDeviceBehind: true } : {}),
  };
}

/** What Add a machine shows above the line. */
export const FIXTURE_COMMANDS = { withOvis: "ovis join", withoutOvis: "curl -fsSL https://ovis.sh/install.sh | sh -s -- --join" } as const;

/** The join line Add a machine shows once: `ovis-join:1:` and four members, readable JSON that says it is a fixture. */
export const FIXTURE_LINE = `ovis-join:1:${btoa(JSON.stringify({
  v: 1, service: "https://account.ovis.example", list: hexOf("list", 64), secret: `FIXTURE-NOT-A-KEY-${hexOf("secret", 96)}`,
})).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;

const NEW_INVITE = inviteRef("new-invite", "render-pool", 1);

/** The invite Add a machine holds after its line was made, before any machine joined. */
export function fixtureNewInvite(choice: InviteChoice): NewInvite {
  return {
    label: NEW_INVITE.label,
    commands: FIXTURE_COMMANDS,
    line: FIXTURE_LINE,
    use: choice.use.kind === "single-use" ? { kind: "single-use" } : { kind: "reusable", limit: choice.use.limit, used: 0 },
    endsAt: ahead(choice.hours * 60),
    joined: [],
  };
}

/** The machine that joins while Add a machine is open. */
export const FIXTURE_JOINER: Machine = machine({ name: "render-03", engine: "herdr-core", state: direct(9), cameIn: byInvite(NEW_INVITE, 1, PHONE, 2, 0) });
