/**
 * The `ovis recover` command (device-row-states rows T70, R11, N6, E41, E46): it lists the rows that wait for a whole
 * read, releases the ones its user names one at a time at a terminal, and undoes releases.
 */
import { describe, expect, test } from "bun:test";
import type { RecoveryAction } from "../shared/account-devices-api.ts";
import { runLogout, runRecover, type RecoverIo } from "./plugin-recover.ts";

test.each([
  ["linux", false, "yes", "other", 1, 0, /terminal/i],
  ["win32", true, "yes", "desktop", 1, 0, /Windows/],
  ["linux", true, "no", "other", 0, 1, /Not queued/],
  ["linux", true, "yes", "plugin", 0, 2, /Stop Ovis.*Start Ovis/],
  ["darwin", true, "yes", "desktop", 0, 2, /Quit and reopen Ovis/],
  ["linux", true, "yes", "other", 0, 2, /Restart Ovis/],
] as const)("restamp 9: %s terminal=%p answer=%s install=%s", async (platform, terminal, answer, install, exit, requests, wording) => {
  const transcript: string[] = [];
  const sent: RecoveryAction[] = [];
  const old = "2026-10-17T12:00:00.000Z";
  const next = "2026-10-15T12:00:00.001Z";
  const status = await runRecover(["--restamp"], {
    platform, terminal,
    out: (text) => { transcript.push(text); },
    ask: async (prompt) => {
      expect(transcript.join("")).toContain(`${old} -> ${next}`);
      expect(prompt).toContain("[y/N]");
      return answer;
    },
    send: async (request) => {
      sent.push(request);
      if (sent.length === 1) return { confirm: "test-plan", moves: [{ old, new: next }] };
      expect(request).toEqual({ act: "restamp", confirm: "test-plan" });
      return { queued: true, install };
    },
  });
  expect(status).toBe(exit);
  expect(sent).toHaveLength(requests);
  expect(transcript.join("")).toMatch(wording);
});

test("restamp explicitly confirms retaining independently changed times with no timestamp moves", async () => {
  const sent: RecoveryAction[] = [];
  const status = await runRecover(["--restamp"], {
    terminal: true, platform: "linux", out: () => {},
    ask: async prompt => {
      expect(prompt).toMatch(/keep.*current.*times/i);
      return "yes";
    },
    send: async request => {
      sent.push(request);
      return sent.length === 1 ? { confirm: "reconcile", moves: [], reconcile: true } : { queued: true };
    },
  });
  expect(status).toBe(0);
  expect(sent).toEqual([{ act: "restamp" }, { act: "restamp", confirm: "reconcile" }]);
});

const rows = [
  { id: "a1", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up", last_seen_at: "2026-11-19T10:00:00Z", refusal: null },
  { id: "b2", label: "Old laptop", origin: { from: "legacy", how: "legacy" }, waiting: "catching_up", last_seen_at: null, refusal: "frozen" },
];

function io(options: { terminal?: boolean; answers?: string[]; platform?: NodeJS.Platform; unreachable?: boolean; undoWarning?: string; writeError?: string; liftedBeforeError?: readonly string[]; releaseRows?: typeof rows; admitError?: string; pendingLabel?: string; standing?: readonly { kind: "block" | "freeze"; id: string; target: string; account: string; signer: string }[] } = {}) {
  const sent: RecoveryAction[] = [];
  const prompts: string[] = [];
  const out: string[] = [];
  const answers = [...(options.answers ?? [])];
  const value: RecoverIo = {
    out: (text) => { out.push(text); },
    terminal: options.terminal ?? true,
    platform: options.platform ?? "linux",
    ask: async (question) => { prompts.push(question); out.push(question); return answers.shift() ?? ""; },
    send: async (request) => {
      if (options.unreachable) throw new Error("ENOENT");
      sent.push(request);
      switch (request.act) {
        case "list": return { rows: options.releaseRows ?? rows, standing: options.standing, pending: [{ id: "0123456789abcdef0123456789abcdef", label: options.pendingLabel ?? "New phone", fingerprint: "AB12-CD34" }] };
        case "release": return { released: request.rows };
        case "undo": return { releases: ["r1"], ...(options.undoWarning ? { warning: options.undoWarning } : {}) };
        case "admit": return options.admitError ? { error: options.admitError } : { admitted: "fedcba9876543210" };
        case "remove": return options.writeError ? { error: options.writeError } : { removed: ["a1"] };
        case "lift": return options.writeError ? { error: options.writeError, lifted: options.liftedBeforeError } : { lifted: request.blocks };
        case "revoke_all": return options.writeError ? { error: options.writeError } : { revoked: 2 };
      }
    },
  };
  return { value, sent, prompts, text: () => out.join("") };
}

test("T70: recover lists the rows that wait, how each came in, and whether it can be released", async () => {
  const run = io();
  expect(await runRecover([], run.value)).toBe(0);
  expect(run.sent).toEqual([{ act: "list" }]);
  expect(run.text()).toContain("Phone");
  expect(run.text()).toContain("a1");
  expect(run.text()).toContain("remote/list");
  expect(run.text()).toContain("Old laptop");
  expect(run.text()).toContain("frozen");
});

test("T70/E48: bare recover prints standing blocks and freezes with copyable lift commands", async () => {
  const block = "a".repeat(64);
  const freeze = `f:${"b".repeat(64)}`;
  const run = io({ terminal: false, releaseRows: [], standing: [
    { kind: "block", id: block, target: "MFkwEwYHKoZIsame--blocked-key1", account: "acct_1", signer: "older-key" },
    { kind: "freeze", id: freeze, target: "MFkwEwYHKoZIsame---frozen-key2", account: "acct_1", signer: "service" },
  ] });
  expect(await runRecover([], run.value)).toBe(0);
  expect(run.text()).toContain(`block ${block}  key blocked-key1  signed by older-key  (ovis recover --lift ${block})\n`);
  expect(run.text()).toContain(`freeze ${freeze}  key -frozen-key2  signed by service  (ovis recover --lift ${freeze})\n`);
  expect(run.sent).toEqual([{ act: "list" }]);
});

test("T70: release asks for each named row at a terminal and releases only the ones confirmed", async () => {
  const run = io({ answers: ["y"] });
  expect(await runRecover(["--release", "a1", "b2", "zz"], run.value)).toBe(1);
  expect(run.sent).toEqual([{ act: "list" }, { act: "release", rows: ["a1"] }]);
  expect(run.text()).toContain("b2");
  expect(run.text()).toContain("zz");
});

test("T70: an answer other than yes releases nothing", async () => {
  const run = io({ answers: ["n"] });
  expect(await runRecover(["--release", "a1"], run.value)).toBe(0);
  expect(run.sent).toEqual([{ act: "list" }]);
});

test("T70: input that is not a terminal answers nothing", async () => {
  const run = io({ terminal: false, answers: ["y"] });
  expect(await runRecover(["--release", "a1"], run.value)).toBe(1);
  expect(run.sent).toEqual([]);
  expect(run.text()).toContain("terminal");
});

test("T70: undo ends the named releases, or every release", async () => {
  const named = io();
  expect(await runRecover(["--undo", "a1"], named.value)).toBe(0);
  expect(named.sent).toEqual([{ act: "undo", rows: ["a1"] }]);
  const every = io();
  expect(await runRecover(["--undo"], every.value)).toBe(0);
  expect(every.sent).toEqual([{ act: "undo", rows: null }]);
});

test("R11: on Windows recover opens nothing and names the desktop app's screen", async () => {
  const run = io({ platform: "win32" });
  expect(await runRecover([], run.value)).toBe(1);
  expect(run.sent).toEqual([]);
  expect(run.text()).toContain("desktop app");
});

test("R11: a server that does not answer on its recovery socket is said to", async () => {
  const run = io({ unreachable: true });
  expect(await runRecover([], run.value)).toBe(1);
  expect(run.text()).toContain("recovery socket");
});

test("T70: an undo whose journal entry could not be written says so, and fails", async () => {
  const run = io({ undoWarning: "The undo was not journalled: disk full" });
  expect(await runRecover(["--undo"], run.value)).toBe(1);
  expect(run.text()).toContain("The undo was not journalled: disk full");
});

test("P22/T70: admit shows the waiting device's fingerprint and sends it only after the terminal confirms it", async () => {
  const run = io({ answers: ["y"] });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], run.value)).toBe(0);
  expect(run.text()).toContain("AB12-CD34");
  expect(run.text()).toContain("New phone");
  expect(run.sent.at(-1)).toEqual({ act: "admit", pending: "0123456789abcdef0123456789abcdef", fingerprint: "AB12-CD34" });
});

for (const { name, label, escaped } of [
  { name: "terminal controls", label: "\x1b[2K\rFAKE-FAKE", escaped: "\\x1b[2K\\x0dFAKE-FAKE" },
  { name: "a bidi override", label: "Phone\u202eFAKE-FAKE", escaped: "Phone\\u202eFAKE-FAKE" },
]) {
  test(`P22/T70: admit renders ${name} visibly before the real fingerprint line`, async () => {
    const run = io({ pendingLabel: label, answers: ["y"] });
    expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], run.value)).toBe(0);
    expect(run.text()).not.toMatch(/[\x1b\r\u202e]/);
    expect(run.prompts[0]).toMatch(/(?:^|\n)AB12-CD34\n[^\n]*\[y\/N\] $/);
    expect(run.prompts[0]?.split("\n").slice(0, -2).join("\n")).toContain(escaped);
    expect(run.text()).toContain(`Admitted ${escaped}.`);
  });
}

test("T70: release escapes the label and puts the actual row ID on its own confirmation line", async () => {
  const run = io({ releaseRows: rows.map((row) => row.id === "a1" ? { ...row, label: "Phone\nfake row" } : row) });
  expect(await runRecover(["--release", "a1"], run.value)).toBe(0);
  expect(run.prompts[0]).toMatch(/Phone\\x0afake row[^\n]*\n[^\n]*a1\n[^\n]*\[y\/N\] $/);
});

test("T70/E48: listing renders controls in device rows, pending labels, and standing blocks visibly", async () => {
  const run = io({ pendingLabel: "Phone\u061c\u200e\u200f\u2066\u2069", standing: [
    { kind: "block", id: "block\x7f", target: "key\x9b", account: "acct_1", signer: "signer\x00" },
  ], releaseRows: rows.map((row) => ({ ...row, label: `${row.label}\x1b` })) });
  expect(await runRecover([], run.value)).toBe(0);
  expect(run.text()).toContain("Phone\\u061c\\u200e\\u200f\\u2066\\u2069");
  expect(run.text()).toContain("block\\x7f  key key\\x9b  signed by signer\\x00");
  expect(run.text()).toContain("Old laptop\\x1b");
  expect(run.text()).not.toMatch(/[\x00\x1b\x7f\x9b\u061c\u200e\u200f\u2066\u2069]/);
});

test("P22: admit answered with anything but yes sends nothing, and needs a terminal", async () => {
  const declined = io({ answers: ["n"] });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], declined.value)).toBe(0);
  expect(declined.sent.some((request) => (request as { act: string }).act === "admit")).toBe(false);
  const piped = io({ terminal: false, answers: ["y"] });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], piped.value)).toBe(1);
  expect(piped.sent).toEqual([]);
});

test("P22: an admission refusal tells a revoked device to pair again at this PC's screen", async () => {
  const refusal = "This PC refused to admit the key (locked, frozen, or its log cannot be read)";
  const run = io({ answers: ["y"], admitError: refusal });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], run.value)).toBe(1);
  expect(run.text()).toContain(refusal);
  expect(run.text()).toMatch(/revoked here.*pair it again at this PC's screen/i);
});

test("P23/T70: a standing safety refusal prints the lift command and exits without claiming admission", async () => {
  const id = "a".repeat(64);
  const refusal = `New phone cannot be admitted while block ${id} stands: lift it first with ovis recover --lift ${id}`;
  const run = io({ answers: ["y"], admitError: refusal });
  expect(await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], run.value)).toBe(1);
  expect(run.text()).toContain(`${refusal}\n`);
  expect(run.text()).not.toContain("Admitted New phone.");
});

test("T69: recover reports the blocks lifted before a refusal, and still fails", async () => {
  const run = io({ answers: ["y", "y"], liftedBeforeError: ["block-a"], writeError: "block-b was not lifted" });
  expect(await runRecover(["--lift", "block-a", "block-b"], run.value)).toBe(1);
  expect(run.text()).toContain("Lifted: block-a\n");
  expect(run.text()).toContain("block-b was not lifted\n");
});

for (const { args, exit } of [{ args: [], exit: 0 }, { args: ["--admit"], exit: 2 }]) {
  test(`P22: recover${args.length ? " --admit without an id" : ""} lists pending devices even with no release rows`, async () => {
    const run = io({ terminal: false, releaseRows: [] });
    expect(await runRecover(args, run.value)).toBe(exit);
    expect(run.sent).toEqual([{ act: "list" }]);
    expect(run.text()).toMatch(/0123456789abcdef0123456789abcdef.*New phone.*AB12-CD34.*ovis recover --admit 0123456789abcdef0123456789abcdef/s);
    if (exit === 2) expect(run.text()).toContain("usage: ovis recover");
  });
}

for (const { row, args, confirmed, answers, result } of [
  { row: "T37", args: ["--remove", "key-a", "a1"], answers: ["", "y"], confirmed: { act: "remove", targets: ["a1"] }, result: /removed.*a1/i },
  { row: "T69", args: ["--lift", "block-a", "block-b"], answers: ["n", "yes"], confirmed: { act: "lift", blocks: ["block-b"] }, result: /lifted.*block-b/i },
  { row: "T70", args: ["--revoke-all"], answers: ["y"], confirmed: { act: "revoke_all" }, result: /revoked.*2/i },
] as const) {
  test(`${row}: ${args[0]} asks before sending only confirmed targets and shows the reply`, async () => {
    const run = io({ answers: [...answers] });
    expect(await runRecover(args, run.value)).toBe(0);
    expect(run.sent).toEqual([confirmed]);
    const prompts = run.prompts.filter((prompt) => prompt.includes("[y/N]"));
    expect(prompts).toHaveLength(answers.length);
    if (args[0] === "--revoke-all") expect(prompts[0]).toMatch(/every device.*this PC.*signed out/i);
    else for (const [index, target] of args.slice(1).entries()) expect(prompts[index]).toContain(target);
    expect(run.text()).toMatch(result);
  });

  test(`${row}: ${args[0]} does not write without a terminal or confirmation`, async () => {
    const piped = io({ terminal: false, answers: ["y", "y"] });
    expect(await runRecover(args, piped.value)).toBe(1);
    expect(piped.sent).toEqual([]);
    expect(piped.text()).toContain("not run in a terminal");
    expect(piped.text()).not.toContain("[y/N]");

    const declined = io();
    expect(await runRecover(args, declined.value)).toBe(0);
    expect(declined.sent).toEqual([]);
  });

  test(`${row}: ${args[0]} prints a server error and exits 1`, async () => {
    const run = io({ answers: [...answers], writeError: "log_unreadable" });
    expect(await runRecover(args, run.value)).toBe(1);
    expect(run.text()).toContain("log_unreadable");
    expect(run.text()).not.toMatch(result);
  });
}

test("P22/T70: line and paragraph separators, zero-width space and BOM in a label are shown escaped", async () => {
  const label = "Phone\u2028AB12-CD34\u2029\u200b\ufeff";
  const sent: unknown[] = [];
  const out: string[] = [];
  const io: RecoverIo = {
    out: (text) => { out.push(text); }, terminal: true, platform: "linux",
    ask: async (question) => { out.push(question); return "n"; },
    send: async (request) => { sent.push(request); return request.act === "list" ? { rows: [], pending: [{ id: "0123456789abcdef0123456789abcdef", label, fingerprint: "ZZ99-YY88" }] } : {}; },
  };
  await runRecover(["--admit", "0123456789abcdef0123456789abcdef"], io);
  const text = out.join("");
  for (const char of ["\u2028", "\u2029", "\u200b", "\ufeff"]) expect(text.includes(char)).toBe(false);
});

test("P22/T70: in the plain list, a waiting device's fingerprint stands on its own line after its label", async () => {
  const out: string[] = [];
  const io: RecoverIo = {
    out: (text) => { out.push(text); }, terminal: true, platform: "linux", ask: async () => "",
    send: async (request) => request.act === "list" ? { rows: [], pending: [{ id: "0123456789abcdef0123456789abcdef", label: "Phone AB12-CD34", fingerprint: "ZZ99-YY88" }] } : {},
  };
  await runRecover([], io);
  const lines = out.join("").split("\n");
  const at = lines.findIndex((line) => line.includes("Phone AB12-CD34"));
  expect(lines[at]!.includes("ZZ99-YY88")).toBe(false);
  expect(lines.slice(at + 1).some((line) => line.trim().startsWith("key ZZ99-YY88"))).toBe(true);
});

describe("ovis logout", () => {
  const inAccount = async () => ({ account: "acct_1", members: 2 });

  test("Revoke all, after a typed yes at a terminal, said as leaving the account", async () => {
    const at = io({ answers: ["yes"] });
    expect(await runLogout({ ...at.value, label: "desk", account: inAccount, leave: async () => false })).toBe(0);
    expect(at.sent).toEqual([{ act: "revoke_all" }]);
    expect(at.prompts).toEqual(["Leave the account? Type yes: "]);
    expect(at.text()).toContain("This PC (desk) is in Ovis account acct_1, with 2 devices of it.");
    expect(at.text()).toContain("Left. This PC is in no account; 2 devices were revoked.");
  });

  test("names the account in the short form ovis login uses, never its whole id", async () => {
    const at = io({ answers: ["no"] });
    await runLogout({ ...at.value, label: "desk", account: async () => ({ account: "acct_0123456789abcdef", members: 1 }), leave: async () => false });
    expect(at.text()).toContain("This PC (desk) is in Ovis account acct_0123456, with 1 device of it.");
    expect(at.text()).not.toContain("789abcdef");
  });

  test.each(["y", "", "YES please"])("%j is not yes: nothing is sent", async (answer) => {
    const at = io({ answers: [answer] });
    expect(await runLogout({ ...at.value, label: "desk", account: inAccount, leave: async () => false })).toBe(1);
    expect(at.sent).toEqual([]);
    expect(at.text()).toContain("Nothing was changed.");
  });

  test("without a terminal nothing is asked or sent", async () => {
    const at = io({ terminal: false });
    expect(await runLogout({ ...at.value, label: "desk", account: inAccount, leave: async () => false })).toBe(1);
    expect([at.sent, at.prompts]).toEqual([[], []]);
  });

  test("takes the PC off the account's list after the local leave, and says when that did not happen", async () => {
    const left: string[] = [];
    const at = io({ answers: ["yes"] });
    expect(await runLogout({ ...at.value, label: "desk", account: inAccount, leave: async (account) => { left.push(account); return at.sent.length === 1; } })).toBe(0);
    expect(left).toEqual(["acct_1"]);
    expect(at.text()).toContain("Taken off your account's list of PCs.");
    const kept = io({ answers: ["yes"] });
    expect(await runLogout({ ...kept.value, label: "desk", account: inAccount, leave: async () => false })).toBe(0);
    expect(kept.text()).toContain("Your account may still list this PC");
  });

  test("leaves the list only once the local leave went through", async () => {
    const left: string[] = [];
    for (const at of [io({ answers: ["no"] }), io({ answers: ["yes"], writeError: "log_unreadable" })]) {
      await runLogout({ ...at.value, label: "desk", account: inAccount, leave: async (account) => { left.push(account); return true; } });
    }
    expect(left).toEqual([]);
  });

  test("a PC in no account has nothing to leave", async () => {
    const at = io();
    expect(await runLogout({ ...at.value, label: "desk", account: async () => ({ account: null, members: 0 }), leave: async () => false })).toBe(0);
    expect(at.text()).toBe("This PC is in no Ovis account.\n");
    expect(at.sent).toEqual([]);
  });

  test("a refusal and an unanswered socket are failures", async () => {
    const refused = io({ answers: ["yes"], writeError: "log_unreadable" });
    expect(await runLogout({ ...refused.value, label: "desk", account: inAccount, leave: async () => false })).toBe(1);
    expect(refused.text()).toContain("Could not leave the account: log_unreadable");
    const away = io({ answers: ["yes"], unreachable: true });
    expect(await runLogout({ ...away.value, label: "desk", account: inAccount, leave: async () => false })).toBe(1);
    expect(away.text()).toContain("recovery socket");
  });

  test("Windows is sent to the app's Revoke all", async () => {
    const at = io({ platform: "win32" });
    expect(await runLogout({ ...at.value, label: "desk", account: inAccount, leave: async () => false })).toBe(1);
    expect(at.sent).toEqual([]);
  });
});
