import { expect, it } from "bun:test";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { acknowledgeTerminalDraft, readTerminalDraft, setTerminalDraftSending, terminalDraftSending, terminalDraftVersion, writeTerminalDraft } from "./terminalDraft.ts";

it("preserves edits across remounts and confines acknowledgements to the submitting PC/pane", () => {
  const owner = "remote-a:w1:p1";
  const other = "remote-b:w1:p1";
  writeTerminalDraft(owner, "sent");
  writeTerminalDraft(other, "other");
  setTerminalDraftSending(owner, true);
  expect(terminalDraftSending(owner)).toBe(true);
  writeTerminalDraft(owner, "sent plus 한글");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe(" plus 한글");
  expect(readTerminalDraft(other)).toBe("other");
});

it("does not erase a replacement even when the user retypes the same text before acknowledgement", () => {
  const owner = "edited:w1:p1";
  writeTerminalDraft(owner, "same text");
  setTerminalDraftSending(owner, true);
  writeTerminalDraft(owner, "");
  writeTerminalDraft(owner, "same text");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe("same text");
});

it("late ack keeps replacement draft", () => {
  // an Insert on its way: the draft is replaced meanwhile, then the acknowledgement comes
  const owner = "insert:w1:p1";
  writeTerminalDraft(owner, "git status");
  setTerminalDraftSending(owner, true);
  expect(terminalDraftVersion(owner)).toBeGreaterThan(0);
  writeTerminalDraft(owner, "git log");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe("git log");
  // text typed after the sent prefix while it was on its way stays; the prefix goes
  writeTerminalDraft(owner, "git log");
  setTerminalDraftSending(owner, true);
  writeTerminalDraft(owner, "git log --oneline");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe(" --oneline");
});

it("counts every write of a draft, so a paste can tell an edit made while it waited", () => {
  const owner = "version:w1:p1";
  const before = terminalDraftVersion(owner);
  writeTerminalDraft(owner, "a");
  expect(terminalDraftVersion(owner)).toBe(before + 1);
  writeTerminalDraft(owner, "a");
  expect(terminalDraftVersion(owner)).toBe(before + 2);
  expect(terminalDraftVersion("version:w1:p2")).toBe(0);
});

/** a page's localStorage, recording every value written to it, while `run` goes */
function withStorage(run: (data: Map<string, string>, written: string[], refuse: (prefix: string | null) => void) => void): void {
  const data = new Map<string, string>();
  const written: string[] = [];
  let refused: string | null = null;
  const storage = {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (refused !== null && key.startsWith(refused)) throw new Error("quota"); written.push(value); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  try { run(data, written, (prefix) => { refused = prefix; }); } finally {
    if (window) Object.defineProperty(globalThis, "window", window);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
/** a PC whose herdr is proven keeps its pane state in storage (lib/paneLifetime.ts) */
const herdr = (machine: string, lifetime: string) => paneLifetimes.observe([{ id: machine, snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine]);
const SK = "sk-0f3c9a1b2d4e5f60718293a4b5c6d7e8";

it("keeps a line that holds an API key or token in this page alone, never in storage, even while it is typed (#2523)", () => withStorage((data, written) => {
  herdr("keys", "keys-herdr");
  const owner = paneStorageId("keys", "w1:p1");
  // an ordinary line is kept for a reload
  writeTerminalDraft(owner, "git status");
  expect(data.get("ovis:terminal-line:" + owner)).toBe("git status");
  for (const key of [SK, "sk-ant-api03-Zx9_yQ7wV5uT3sR1qP-oN8mL6kJ4", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
    "AKIAIOSFODNN7EXAMPLE", "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn", "Xq7Lm2Pz9Rt4Vb8Nc3Kd6Wf1Hs5Jg0Ya", "Xq7Lm2Pz9Rt4Vb8N_c3Kd6Wf1Hs5Jg0Ya"]) {
    writeTerminalDraft(owner, "git status");
    writeTerminalDraft(owner, key);
    expect(readTerminalDraft(owner)).toBe(key);
    expect([...data.values()].some((value) => value.includes(key))).toBe(false);
    expect(data.has("ovis:terminal-line:" + owner)).toBe(false);
  }
  // typed a character at a time, storage holds no more of a vendor's key than its first few characters
  written.length = 0;
  for (const key of [SK, "AKIAIOSFODNN7EXAMPLE"]) for (let end = 1; end <= key.length; end++) writeTerminalDraft(owner, key.slice(0, end));
  expect(written.some((value) => value.includes("sk-0f3c") || value.includes("AKIAIOSF"))).toBe(false);
  // words, paths, IDs and hashes are not keys: they are kept
  for (const line of ["git checkout fix/input-line-key-storage", "cat /home/devswha/projects/ovis/src/lib/terminalDraft.ts", "echo 123e4567-e89b-12d3-a456-426614174000",
    "skip-worktree", "git clone https://github.com/VeryLongOrganizationName123/SomeRepository", "git clone https://github.com/SomeOrg123/SomeRepoName", "cd ~/Src/MyApp2/Lib/UiKit/Views3", "python manage.py runserver --settings=MyApp_Settings2_Production", "git show 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "docker pull image@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"]) {
    writeTerminalDraft(owner, line);
    expect(data.get("ovis:terminal-line:" + owner)).toBe(line);
  }
  // nor does a herdr replacement leave a key to recovery
  writeTerminalDraft(owner, SK);
  herdr("keys", "keys-herdr-2");
  expect(readTerminalDraft(owner)).toBe("");
  expect([...data.values()].some((value) => value.includes(SK))).toBe(false);
  expect(paneLifetimes.unsent().some((item) => item.text.includes(SK))).toBe(false);
}));

it("takes a key an earlier release stored out of storage, and never leaves it to recovery (#2523)", () => withStorage((data) => {
  herdr("legacy", "legacy-herdr");
  const read = paneStorageId("legacy", "w1:p1");
  const unread = paneStorageId("legacy", "w1:p2");
  data.set("ovis:terminal-line:" + read, SK);
  data.set("ovis:terminal-line:" + unread, "export DEEPSEEK_API_KEY=" + SK);
  // read: it leaves storage and stays in this page
  expect(readTerminalDraft(read)).toBe(SK);
  expect(data.has("ovis:terminal-line:" + read)).toBe(false);
  expect(readTerminalDraft(read)).toBe(SK);
  // unread when its herdr is replaced: it goes, and not to recovery
  herdr("legacy", "legacy-herdr-2");
  expect([...data.values()].some((value) => value.includes(SK))).toBe(false);
  expect(paneLifetimes.unsent().some((item) => item.text.includes(SK))).toBe(false);
  // unread, or already kept for recovery, when the page starts: both go, and ordinary text stays
  herdr("legacy", "legacy-herdr-3");
  data.set("ovis:terminal-line:" + unread, SK);
  data.set("ovis:terminal-line:" + paneStorageId("legacy", "w1:p3"), "make release");
  data.set("ovis:unsent:old-key", JSON.stringify({ machine_id: "legacy", pane_id: "w1:p4", kind: "line", text: SK, at: 1 }));
  data.set("ovis:unsent:old-line", JSON.stringify({ machine_id: "legacy", pane_id: "w1:p5", kind: "line", text: "make test", at: 1 }));
  paneLifetimes.forgetLineKeys();
  expect([...data.values()].some((value) => value.includes(SK))).toBe(false);
  expect(data.get("ovis:terminal-line:" + paneStorageId("legacy", "w1:p3"))).toBe("make release");
  expect(data.has("ovis:unsent:old-line")).toBe(true);
}));

it("leaves a key storage refused out of recovery too, unlike an ordinary line (#2523)", () => withStorage((data, _written, refuse) => {
  herdr("private", "private-herdr");
  refuse("ovis:terminal-line:");
  writeTerminalDraft(paneStorageId("private", "w1:p1"), SK);
  writeTerminalDraft(paneStorageId("private", "w1:p2"), "make release");
  refuse(null);
  herdr("private", "private-herdr-2");
  expect([...data.values()].some((value) => value.includes(SK))).toBe(false);
  expect(paneLifetimes.unsent().some((item) => item.text.includes(SK))).toBe(false);
  expect(paneLifetimes.unsent().some((item) => item.machine_id === "private" && item.text === "make release")).toBe(true);
}));

it("keeps a key typed while storage refused the herdr's record once storage takes it for that same herdr (#2523)", () => withStorage((data, _written, refuse) => {
  refuse("ovis:pane-lifetime:");
  herdr("late", "late-herdr");
  const owner = paneStorageId("late", "w1:p1");
  writeTerminalDraft(owner, SK);
  refuse(null);
  herdr("late", "late-herdr");
  expect(data.get("ovis:pane-lifetime:late")).toBe("late-herdr");
  expect(readTerminalDraft(owner)).toBe(SK);
  expect([...data.values()].some((value) => value.includes(SK))).toBe(false);
}));

it("counts a line a herdr replacement took away, typed or not, so a paste that waited is not put into the new pane's line", () => {
  const roster = (lifetime: string) => [{ id: "local", snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine];
  paneLifetimes.observe(roster("retire-herdr-a"), (item) => item.pane_id);
  writeTerminalDraft("retire:w1:p1", "make release");
  const typed = terminalDraftVersion("retire:w1:p1");
  // a paste into an empty line asks for its count before the clipboard answers
  const empty = terminalDraftVersion("retire:w1:p2");
  paneLifetimes.observe(roster("retire-herdr-b"), (item) => item.pane_id);
  expect(readTerminalDraft("retire:w1:p1")).toBe("");
  expect(terminalDraftVersion("retire:w1:p1")).not.toBe(typed);
  expect(terminalDraftVersion("retire:w1:p2")).not.toBe(empty);
});
