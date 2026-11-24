/**
 * The words of the `ovis` command line (docs/guide.md, "Commands"): its help, which flags each command takes, and the
 * public names it is typed with, each rewritten to the one every release speaks before anything runs. A release from
 * before `login`, `approve` and `pair --relay` knows them as `link`, `pair --approve` and `link --code`, and a launcher
 * or checkout hands `link` on by that name (scripts/plugin-runtime.ts, install.sh's launcher), so those stay the
 * internal names. Nothing here reads a file or the network.
 */

import { HARNESS_SKILL } from "../shared/harness-skill.ts";

export type Command = "start" | "stop" | "status" | "pair" | "link" | "join" | "logout" | "recover" | "confirm" | "phone" | "phone-setup" | "tui" | "agent";

export type Parsed =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly command: Command; readonly args: readonly string[] }
  /** a word this checkout does not know: the release the app updated to may (handOn), else it is an error */
  | { readonly kind: "unknown"; readonly word: string }
  | { readonly kind: "bad"; readonly text: string };

export interface CliContext {
  /** OVIS_ACCOUNT_OPENS_ALL is not "0": logout, recover and confirm are commands */
  readonly account: boolean;
  /** the terminal screen runs here (Linux and macOS): tui is shown in the help */
  readonly tui: boolean;
}

interface Spec {
  readonly command: Command;
  readonly prefix?: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly flags?: readonly (readonly [string, string])[];
  readonly hidden?: readonly string[];
  /** its arguments go on as they are, to a parser of its own (recover) or to the program it runs (tui) */
  readonly passThrough?: true;
  readonly gated?: true;
  readonly more?: string;
}

const LOGIN: Spec = {
  command: "link",
  summary: "Add this PC to your Ovis account (also: add)",
  usage: "ovis login [--no-browser] [--account <id>] [--qr [--print]] [--approve] [--github | --google]",
  flags: [
    ["--no-browser", "Show the address and code to type instead of opening a browser (the default without a desktop)"],
    ["--account <id>", "Your account's id (ovis status on a PC in it, or Manage account): needed outside a terminal"],
    ["--qr", "After signing in, show a QR code for a device of your account to scan, instead of waiting for Add"],
    ["--print", "With --qr: write the QR code even where the output is not a terminal"],
    ["--approve", "After signing in, approve here the device that adds this PC, comparing six digits"],
    ["--confirm <six digits>", "Say yes to the number this PC shows while it is added to an account that keeps a signed list, where nobody can type at the add that shows it"],
    ["--github, --google", "Sign in at GitHub's or Google's own device page"],
  ],
  // `link --code` is `pair --relay`; `--device-auth` is codex's name for --no-browser
  hidden: ["--github", "--google", "--code", "--device-auth"],
  more: "Sign in with a code, confirm the account (type yes, or name it with --account), then press Add for this PC in Ovis\non your phone or another device signed in to that account: this PC joins it. The sign-in ends with the command;\nnothing of it is kept on this PC.",
};

const SPECS: Readonly<Record<string, Spec>> = {
  agent: { command: "agent", passThrough: true, summary: "Use this coding agent's local harness tools", usage: "ovis agent <machines|harnesses|ls|read|start|send|wait|result|ask|stop> [arguments] --json", more: HARNESS_SKILL },
  login: LOGIN,
  add: LOGIN,
  link: LOGIN,
  join: {
    command: "join", passThrough: true,
    summary: "Add this PC to an Ovis account with an invite from a device of it",
    usage: "ovis join --invite-file <path> | - | <invite> [--account <id>] [--json]",
    flags: [
      ["--invite-file <path>", "Read the invite from a file"],
      ["-", "Read the invite from standard input"],
      ["--account <id>", "The account the invite is for, or its first 12 characters or more: asks nothing, and stops if the invite is\nfor another (needed outside a terminal and with --json)"],
      ["--json", "Print one JSON object on stdout at the end, and everything else on stderr; asks nothing"],
    ],
    more: "A device signed in to your account makes the invite: one line that works once, for 15 minutes. Pass it in a\nfile or on standard input: an invite typed on the command line shows in the process list to other users of this PC\nand lands in your shell history (OVIS_INVITE also works). The command shows the account the invite is for and asks\nyou to type yes (or checks it against --account), then lists this PC in that account. A plain invite then waits for\nAdd on a device of the account while its card offers it (10 minutes); an auto invite adds the PC at once. A run that\ndoes not add the PC takes it off that account's list again, a listing an earlier ovis add left included.\n\nExit codes: 0 added (or already in that account), 1 not added or stopped (--json tells which), 2 usage, 3 invite\nnot valid (mistyped, used, expired, or for another account service), 4 not confirmed, 5 --account names another\naccount, 6 this PC is in another account, 7 rate limited, 8 the account's daily PC adds used up, 9 the account's PC\nlist full, 10 account service unreachable or unclear, 11 not available here, 12 relay or account service off,\n13 Ovis not running, 14 not added while its card offered Add (nobody pressed it, or a device declined), 15 an error\nof ovis join's own.",
  },
  logout: {
    command: "logout", gated: true,
    summary: "Take this PC out of its Ovis account",
    usage: "ovis logout",
    more: "Asks you to type yes, then revokes every device paired with this PC, as Revoke all does, which leaves its\naccount. Pair them again with ovis login or ovis pair.",
  },
  pair: {
    command: "pair",
    summary: "Pair one device with a one-time code and QR code (no account)",
    usage: "ovis pair [--relay]",
    flags: [["--relay", "A code and the relay QR code, renewed until Ctrl+C"]],
    hidden: ["--approve"],
  },
  approve: {
    command: "pair", prefix: ["--approve"],
    summary: "Approve or decline devices that wait to pair with this PC",
    usage: "ovis approve",
  },
  phone: {
    command: "phone",
    summary: "Show this PC's phone address; sets up Tailscale serve if needed",
    usage: "ovis phone",
  },
  status: {
    command: "status",
    summary: "Show whether Ovis runs, where, its account and its version",
    usage: "ovis status [--json]",
    flags: [["--json", "One JSON object: version, running, server id, relay, account, waiting for Add"]],
  },
  start: { command: "start", summary: "Start Ovis on this PC", usage: "ovis start" },
  stop: { command: "stop", summary: "Stop Ovis on this PC", usage: "ovis stop" },
  tui: {
    command: "tui", passThrough: true,
    summary: "Show herdr-core's terminals in this terminal",
    usage: "ovis tui [--session <name>]",
    flags: [["--session <name>", "Another herdr-core session"]],
    more: "Ovis's own screen, with herdr's keys from your herdr config. With no herdr-core running it asks before it\nstarts one.",
  },
  recover: {
    command: "recover", gated: true, passThrough: true,
    summary: "List the devices this PC holds back; release, admit or remove them",
    usage: "ovis recover [--release <row id>... | --undo [<row id>...] | --admit <waiting id> | --remove <row id or key>... | --lift <block or freeze id>... | --revoke-all]",
  },
  confirm: {
    command: "confirm", gated: true,
    summary: "Open this PC's confirm page, for changes that wait for a yes here",
    usage: "ovis confirm",
  },
  // herdr's Phone setup pane runs this; it is not typed
  "phone-setup": { command: "phone-setup", summary: "", usage: "ovis phone-setup" },
};

const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["Connect", ["login", "join", "logout", "pair", "approve", "phone"]],
  ["Run", ["status", "start", "stop", "tui", "agent"]],
  ["Recovery (at this PC only)", ["recover", "confirm"]],
];

export const GUIDE = "https://github.com/devswha/ovis/blob/main/docs/guide.md";

/** An Ovis account as every command names it (login, logout, status): its first characters, never the whole id. */
export const shortAccount = (account: string): string => account.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 12);

export function mainHelp(context: CliContext): string {
  const lines = [
    "Ovis - herdr in your browser and on your phone",
    "",
    "Usage: ovis <command> [flags]",
    context.tui ? "       ovis              Open the terminal screen when a core is running; otherwise show status" : "       ovis              Show status",
  ];
  for (const [title, names] of GROUPS) {
    const shown = names.filter((name) => offered(name, context) && (name !== "tui" || context.tui));
    if (shown.length === 0) continue;
    lines.push("", title, ...shown.map((name) => `  ${name.padEnd(9)}  ${SPECS[name]!.summary}`));
  }
  lines.push(
    "",
    "Flags",
    "  -h, --help       Help for ovis, or for a command: ovis <command> --help",
    "  -V, --version    Version of the Ovis that runs",
    "",
    `Guide: ${GUIDE}`,
    "",
  );
  return lines.join("\n");
}

function commandHelp(name: string, spec: Spec): string {
  const lines = [`Usage: ${spec.usage.replace(/^ovis \S+/, `ovis ${name}`)}`];
  if (spec.summary !== "") lines.push("", spec.summary);
  if (spec.more !== undefined) lines.push("", spec.more);
  if (spec.flags !== undefined && spec.flags.length > 0) {
    const width = Math.max(...spec.flags.map(([flag]) => flag.length));
    lines.push("", "Flags", ...spec.flags.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`));
  }
  return lines.join("\n") + "\n";
}

const offered = (name: string, context: CliContext): boolean => Object.hasOwn(SPECS, name) && (context.account || SPECS[name]!.gated !== true);

const HELP = new Set(["-h", "--help"]);

export function parseCommand(words: readonly string[], context: CliContext): Parsed {
  const [word = "", ...rest] = words;
  if (word === "-V" || word === "--version" || word === "version") return { kind: "version" };
  if (HELP.has(word) || word === "help") {
    const about = rest[0];
    return { kind: "help", text: about !== undefined && offered(about, context) ? commandHelp(about, SPECS[about]!) : mainHelp(context) };
  }
  if (!offered(word, context)) return { kind: "unknown", word };
  const spec = SPECS[word]!;
  if (rest.some((arg) => HELP.has(arg))) return { kind: "help", text: commandHelp(word, spec) };
  if (spec.passThrough) return { kind: "run", command: spec.command, args: rest };
  const known = new Set([...(spec.flags ?? []).flatMap(([flag]) => flag.split(", ").map((one) => one.split(" ")[0]!)), ...spec.hidden ?? []]);
  // a flag shown with `<value>` takes the word after it, or `=value`
  const valued = new Set((spec.flags ?? []).flatMap(([flag]) => flag.split(", ").filter((one) => one.includes(" <")).map((one) => one.split(" ")[0]!)));
  const plain: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (!valued.has(name)) { plain.push(arg); continue; }
    const value = equals > 0 ? arg.slice(equals + 1) : rest[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) return { kind: "bad", text: `ovis ${word}: ${name} needs a value\nRun ovis ${word} --help for what it takes.\n` };
    if (equals < 0) index++;
  }
  const stray = plain.find((arg) => !known.has(arg));
  if (stray !== undefined) {
    return { kind: "bad", text: `ovis ${word}: ${stray.startsWith("-") ? "unknown flag" : "unexpected argument"} ${stray}\nRun ovis ${word} --help for what it takes.\n` };
  }
  if (spec.command === "pair" && rest.includes("--relay")) {
    if (rest.includes("--approve")) return { kind: "bad", text: `ovis ${word}: --relay and --approve do not go together\n` };
    return { kind: "run", command: "link", args: ["--code"] };
  }
  return { kind: "run", command: spec.command, args: [...spec.prefix ?? [], ...rest] };
}

export function unknownCommand(word: string): string {
  return `ovis: unknown command ${word}\nRun ovis --help for the commands.\n`;
}
