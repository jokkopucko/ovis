import { describe, expect, it } from "bun:test";

import { mainHelp, parseCommand, type CliContext } from "./plugin-cli.ts";

const ON: CliContext = { account: true, tui: true };
const OFF: CliContext = { account: false, tui: false };

describe("the public names", () => {
  it.each([
    [["login"], "link", []],
    [["add", "--approve"], "link", ["--approve"]],
    // the yes to the number an add by the account's list shows, where nobody can type at that add
    [["add", "--confirm", "482913"], "link", ["--confirm", "482913"]],
    [["login", "--confirm=482913"], "link", ["--confirm=482913"]],
    [["link", "--code"], "link", ["--code"]],
    [["login", "--no-browser", "--google"], "link", ["--no-browser", "--google"]],
    [["login", "--device-auth"], "link", ["--device-auth"]],
    [["pair", "--relay"], "link", ["--code"]],
    [["approve"], "pair", ["--approve"]],
    [["pair", "--approve"], "pair", ["--approve"]],
    [["pair"], "pair", []],
    [["logout"], "logout", []],
    [["phone-setup"], "phone-setup", []],
    [["recover", "--lift", "f:abc"], "recover", ["--lift", "f:abc"]],
    [["tui", "--session", "work"], "tui", ["--session", "work"]],
    [["status", "--json"], "status", ["--json"]],
    // join reads its own words: the invite may be one of them, or standard input (-)
    [["join", "--invite-file", "/x", "--json"], "join", ["--invite-file", "/x", "--json"]],
    [["join", "-", "--account=acct_1"], "join", ["-", "--account=acct_1"]],
    [["join", "ovis-join:1:eyJ2IjoxfQ"], "join", ["ovis-join:1:eyJ2IjoxfQ"]],
  ] as const)("%j runs %s %j, the names every release speaks", (words, command, args) => {
    expect(parseCommand(words, ON)).toEqual({ kind: "run", command, args });
  });

  it.each(["start", "stop", "status", "phone", "confirm"] as const)("%s keeps its name", (word) => {
    expect(parseCommand([word], ON)).toEqual({ kind: "run", command: word, args: [] });
  });
});

describe("help and version", () => {
  it.each(["--help", "-h", "help"])("%s is the help on stdout", (word) => {
    expect(parseCommand([word], ON)).toEqual({ kind: "help", text: mainHelp(ON) });
  });

  it.each(["--version", "-V", "version"])("%s is the version", (word) => {
    expect(parseCommand([word], ON)).toEqual({ kind: "version" });
  });

  it.each(["stop", "start", "pair", "phone", "login", "join", "logout", "recover", "tui"])("%s --help comes before it runs", (word) => {
    const parsed = parseCommand([word, "--help"], ON);
    expect(parsed.kind).toBe("help");
    expect(parseCommand([word, "-h"], ON)).toEqual(parsed);
    expect(parseCommand(["help", word], ON)).toEqual(parsed);
    expect(parsed.kind === "help" && parsed.text.startsWith(`Usage: ovis ${word}`)).toBe(true);
  });

  it("hides the old spellings, and tui where it cannot run", () => {
    const help = mainHelp(OFF);
    for (const hidden of ["  link ", "phone-setup", "--approve", "--code", "  tui ", "logout", "recover", "confirm"]) expect(help).not.toContain(hidden);
    expect(mainHelp(ON)).toContain("  tui ");
    expect(mainHelp(ON)).toContain("  login      Add this PC to your Ovis account (also: add)\n  join       Add this PC to an Ovis account with an invite from a device of it\n");
    expect(mainHelp(OFF)).toContain("  join ");
  });
});

describe("ovis join --help", () => {
  it("names the file and standard input forms first, why, and every exit code", () => {
    const parsed = parseCommand(["join", "--help"], ON);
    const text = parsed.kind === "help" ? parsed.text : "";
    expect(text.split("\n")[0]).toBe("Usage: ovis join --invite-file <path> | - | <invite> [--account <id>] [--json]");
    expect(text).toContain("shows in the process list");
    for (let code = 0; code <= 14; code++) expect(text).toMatch(new RegExp(`(^|[ ,(])${code} [a-zA-Z-]`, "m"));
  });
});

describe("what is refused", () => {
  it.each([
    [["login", "--aprove"], "ovis login: unknown flag --aprove"],
    [["stop", "--force"], "ovis stop: unknown flag --force"],
    [["status", "now"], "ovis status: unexpected argument now"],
    [["approve", "--approve"], "ovis approve: unknown flag --approve"],
    [["pair", "--relay", "--approve"], "ovis pair: --relay and --approve do not go together"],
  ])("%j exits 2 without running", (words, line) => {
    const parsed = parseCommand(words, ON);
    expect(parsed.kind).toBe("bad");
    expect(parsed.kind === "bad" && parsed.text.split("\n")[0]).toBe(line);
  });

  it("an unknown word is left to the release the app updated to", () => {
    expect(parseCommand(["a-later-command", "--x"], ON)).toEqual({ kind: "unknown", word: "a-later-command" });
  });

  it.each(["logout", "recover", "confirm"])("with the release flag off, %s is not a command", (word) => {
    expect(parseCommand([word], OFF)).toEqual({ kind: "unknown", word });
    expect(parseCommand(["help", word], OFF)).toEqual({ kind: "help", text: mainHelp(OFF) });
  });
});
