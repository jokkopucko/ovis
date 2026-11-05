import { expect, it } from "bun:test";
import { ComposerDraftStore } from "./composerDraft.ts";

function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, store: new ComposerDraftStore(() => storage) };
}

// #511: Edit puts an agent-only message (comments as `> quote` lines) back in the box; its next send keeps the rule
it("keeps a draft Edit put back from an agent-only message agent-only until the box is emptied", () => {
  const { store } = fixture();
  const key = "ovis:composer-draft:p1";
  store.restorePending(key, "> quote\ncomment");
  expect(store.isAgentOnly(key)).toBe(false); // control: an ordinary queued message
  store.set(key, "");
  store.restorePending(key, "> quote\ncomment", true);
  expect(store.isAgentOnly(key)).toBe(true);
  store.set(key, "> quote\ncomment, edited");
  expect(store.isAgentOnly(key)).toBe(true);
  store.set(key, "");
  expect(store.isAgentOnly(key)).toBe(false);
});

it("keeps the draft agent-only in this page when storage refuses the mark", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (key.startsWith("ovis:composer-agent-only:")) throw new DOMException("full", "QuotaExceededError"); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const store = new ComposerDraftStore(() => storage);
  const key = "ovis:composer-draft:p1";
  data.set(key, "existing draft");
  store.restorePending(key, "> quote\ncomment", true);
  expect(store.read(key).text).toBe("existing draft\n\n> quote\ncomment");
  expect(store.isAgentOnly(key)).toBe(true);
  // its text is never stored without the mark, so another tab or a reload never reads it unmarked
  const other = new ComposerDraftStore(() => storage);
  expect(other.read(key).text).toBe("existing draft");
  expect(store.isUnsaved(key)).toBe(true);
  store.set(key, "> quote\ncomment, edited");
  expect(data.get(key)).toBe("existing draft");
  store.set(key, "");
  expect(store.isAgentOnly(key)).toBe(false);
});

it("keeps the mark of a marked draft another tab shows, if this one cleared it meanwhile", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const a = new ComposerDraftStore(() => storage), b = new ComposerDraftStore(() => storage);
  const key = "ovis:composer-draft:p1";
  a.restorePending(key, "> backup.txt\ncomment", true);
  expect(b.read(key).text).toBe("> backup.txt\ncomment");
  a.set(key, "");
  // b edits the draft it still shows before the clear reaches it: its text is stored with the mark
  b.set(key, "> backup.txt\ncomment, edited");
  expect(b.isAgentOnly(key)).toBe(true);
  expect(new ComposerDraftStore(() => storage).isAgentOnly(key)).toBe(true);
});

it("moves the agent-only mark with its draft when herdr gives the pane a new ID", () => {
  const { store } = fixture();
  store.restorePending("ovis:composer-draft:old", "> quote\ncomment", true);
  store.move("ovis:composer-draft:old", "ovis:composer-draft:new");
  expect(store.isAgentOnly("ovis:composer-draft:new")).toBe(true);
  expect(store.isAgentOnly("ovis:composer-draft:old")).toBe(false);
});
