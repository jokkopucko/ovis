import { afterEach, expect, it, mock } from "bun:test";
import type { AccountList, AccountListView } from "./accountList.ts";
import { setPageAccountList } from "./pageList.ts";

// the PCs that posted, as the account service answers them; `reading` runs while the posts are read
let reading: () => void = () => {};
const ListAdd = await import("./listAdd.ts");
const post = { list: "5c".repeat(32), endpoint: "e".repeat(64), server_id: "e".repeat(32), key: "pc-key", enc: "pc-enc", card: "card" };
await mock.module("./listAdd.ts", () => ({ ...ListAdd, postedPcs: async () => { reading(); return [post]; } }));
const { pageListAdds } = await import("./listPcs.ts");

afterEach(() => { setPageAccountList(null); reading = () => {}; });

const view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] };
const stateWith = (removed: number | null) => ({ level: 1, signers: {}, devices: {}, invites: {}, pcs: { [post.endpoint]: { how: "carried", key: null, enc: null, seq: 1, invite: null, removed } } });

it("classifies the posts on the list as it stands once they are read: a PC the list put out meanwhile is offered nothing", async () => {
  let state = stateWith(null);
  setPageAccountList({ view: () => view, writer: () => ({ account: "acct", list: view.status.at === "following" ? view.status.list : "", keys: { key: "member-key" }, state }) } as unknown as AccountList);
  // while the posts are read, another member's entry puts the PC out of the list
  reading = () => { state = stateWith(5); };
  expect((await pageListAdds("acct"))?.posts).toEqual([]);
  // with the PC still in, the same read offers its keys
  state = stateWith(null);
  reading = () => {};
  expect((await pageListAdds("acct"))?.posts.map((each) => each.for)).toEqual([{ kind: "keys" }]);
});
