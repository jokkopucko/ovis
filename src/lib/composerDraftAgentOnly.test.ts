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

it("moves the agent-only mark with its draft when herdr gives the pane a new ID", () => {
  const { store } = fixture();
  store.restorePending("ovis:composer-draft:old", "> quote\ncomment", true);
  store.move("ovis:composer-draft:old", "ovis:composer-draft:new");
  expect(store.isAgentOnly("ovis:composer-draft:new")).toBe(true);
  expect(store.isAgentOnly("ovis:composer-draft:old")).toBe(false);
});
