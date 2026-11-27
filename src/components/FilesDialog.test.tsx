import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { DirectoryListing } from "../../shared/directories.ts";
import type { RepoDiffFileList, RepoDiffRefs } from "../../shared/repo-diff.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { FilesDialog } from "./FilesDialog.tsx";

let page: Page;

afterEach(async () => { await page.close(); });

test("keeps Branch selected when Files moves to another pane (#3028)", async () => {
  page = openPage();
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
  const savedHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
  const listing = (root: string) => ({
    repository: { root, branch: "feature", head: "a".repeat(40), detached: false, unborn: false },
    scope: "workspace", base: null, head: null, comparison: null, files: [], total: 0, truncated: false,
    limits: { max_files: 100, max_list_bytes: 1024 },
  } satisfies RepoDiffFileList);
  const branchReply = Promise.withResolvers<Response>();
  let branchRequested = false;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ovis.test");
    const root = url.searchParams.get("directory") ?? "/repo";
    if (url.pathname.endsWith("/diff/refs")) return Response.json({
      repository: listing(root).repository, refs: [], truncated: false, limits: { max_refs: 100, max_list_bytes: 1024 },
    } satisfies RepoDiffRefs);
    if (url.pathname.endsWith("/diff/files")) {
      if (url.searchParams.get("pane_id") === "p1" && url.searchParams.get("scope") === "branch") {
        branchRequested = true;
        return branchReply.promise;
      }
      return Response.json(listing(root));
    }
    return Response.json({ path: "/repo", parent: "/", home: "/home/test", files: [], directories: [], truncated: false } satisfies DirectoryListing);
  }, globalThis.fetch));
  const noop = () => undefined;
  const dialog = (paneId: string) => <SettingsProvider>
    <FilesDialog start="/repo" paneId={paneId} viewing={false} onOpenFile={noop} onOpenDiff={noop} onBrowseFolders={noop} onClose={noop} />
  </SettingsProvider>;
  const button = (name: string) => {
    const matches = [...page.container.querySelectorAll("button")].filter((node) => node.textContent === name);
    if (matches.length !== 1 || !matches[0]) throw new Error(`Expected one ${name} button`);
    return matches[0];
  };
  const field = () => page.one<HTMLInputElement>('[role="combobox"]');
  try {
    await page.render(dialog("p1"));
    await act(async () => button("Changes").click());
    expect(button("Working tree").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Branch").click());
    expect(button("Branch").getAttribute("aria-pressed")).toBe("true");
    await page.type(field(), "main");
    await act(async () => { page.one("form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
    expect(branchRequested).toBe(true);
    await page.render(dialog("p2"));
    await act(async () => {
      branchReply.resolve(Response.json({
        ...listing("/repo"), scope: "branch", total: 1,
        files: [{ path: "old-pane.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false }],
      } satisfies RepoDiffFileList));
    });
    expect(button("Branch").getAttribute("aria-pressed")).toBe("true");
    expect(field().value).toBe("");
    expect(page.container.textContent).not.toContain("old-pane.txt");
  } finally {
    fetch.mockRestore();
    if (savedHTMLElement) Object.defineProperty(globalThis, "HTMLElement", savedHTMLElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});
