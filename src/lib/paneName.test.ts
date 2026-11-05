import { expect, it } from "bun:test";
import { codexThreadTitle, folderName, placeLine, shortPathTitle, tabTitle, taskRowLines, stripPaneChrome } from "./paneName.ts";

it("shows a path title as its last folder, and leaves any other title alone", () => {
  expect(shortPathTitle("/tmp/audit-oDjsU2/lms-backend")).toBe("lms-backend");
  expect(shortPathTitle("/home/haemin/dev/api/")).toBe("api");
  expect(shortPathTitle("~/dev/herdr web ui")).toBe("herdr web ui");
  expect(shortPathTitle("~")).toBe("~");
  expect(shortPathTitle("/")).toBe("/");
  expect(shortPathTitle("C:\\Users\\haemi\\work\\site")).toBe("site");
  expect(shortPathTitle("C:\\")).toBe("C:\\");
  expect(shortPathTitle("fix the login bug")).toBe("fix the login bug");
  expect(shortPathTitle("vim /etc/hosts")).toBe("vim /etc/hosts");
  expect(shortPathTitle("~tilde-name")).toBe("~tilde-name");
});

it("says a workspace and its folder once when they are the same", () => {
  expect(placeLine("lms-backend", "lms-backend")).toBe("lms-backend");
  expect(placeLine("api", "server")).toBe("api · server");
  expect(placeLine("api", "")).toBe("api");
});

it("finds the folder of a Windows path as of a POSIX one", () => {
  expect(folderName("C:\\work\\api")).toBe("api");
  expect(folderName("C:\\work\\api\\")).toBe("api");
  expect(folderName("C:/work/api")).toBe("api");
  expect(folderName("\\\\server\\share\\api")).toBe("api");
  expect(folderName("C:\\")).toBe("C:\\");
  expect(folderName("C:/")).toBe("C:/");
  expect(folderName("/home/haemin/dev/api/")).toBe("api");
  expect(folderName("/")).toBe("/");
  expect(folderName("/repo/branch ")).toBe("branch ");
  expect(placeLine("api", folderName("C:\\work\\api"))).toBe("api");
  expect(placeLine("api", folderName("C:\\work\\server"))).toBe("api · server");
});

it("draws a two-line row as the pane's title over its place, without repeating a name", () => {
  expect(taskRowLines({ paneTitle: "Idempotent payments", labelled: false, folder: "api", workspace: "checkout-api" }))
    .toEqual({ title: "Idempotent payments", place: "checkout-api · api" });
  // the folder is the workspace's name: it is said once
  expect(taskRowLines({ paneTitle: "Guard the export button", labelled: false, folder: "web-dashboard", workspace: "web-dashboard" }))
    .toEqual({ title: "Guard the export button", place: "web-dashboard" });
  // a shell titled by its folder leads with the workspace, and the folder follows when it is another name
  expect(taskRowLines({ paneTitle: "api", labelled: false, folder: "api", workspace: "checkout-api" }))
    .toEqual({ title: "checkout-api", place: "api" });
  expect(taskRowLines({ paneTitle: "release", labelled: false, folder: "release", workspace: "release" }))
    .toEqual({ title: "release", place: "" });
  // a pane the user named keeps its name, also when it is the folder's
  expect(taskRowLines({ paneTitle: "api", labelled: true, folder: "api", workspace: "checkout-api" }))
    .toEqual({ title: "api", place: "checkout-api" });
  // a linked worktree is placed by its workspace name, then its branch where the name does not say it
  expect(taskRowLines({ paneTitle: "session-list", labelled: false, folder: "fix-session-list", workspace: "Hotfix", alias: "fix/session-list" }))
    .toEqual({ title: "session-list", place: "Hotfix · fix/session-list · fix-session-list" });
  // a pane named as its worktree's workspace does not have that name said again under it
  expect(taskRowLines({ paneTitle: "Hotfix", labelled: true, folder: "fix-payment", workspace: "Hotfix", alias: "fix/payment" }))
    .toEqual({ title: "Hotfix", place: "fix/payment · fix-payment" });
});

it("keeps the thread of a Codex title and drops the project folder Codex adds after it", () => {
  expect(codexThreadTitle("Respond to greeting | worktree-rapid-valley...")).toBe("Respond to greeting");
  expect(codexThreadTitle("Compare a | b outputs | herdr-web-ui")).toBe("Compare a | b outputs");
  expect(codexThreadTitle("Respond to greeting")).toBe("Respond to greeting");
  expect(codexThreadTitle(" | herdr-web-ui")).toBe(" | herdr-web-ui");
});

it("strips a Codex title to its thread for a row, and keeps the folder for an alert and for other agents", () => {
  expect(stripPaneChrome("Respond to greeting | worktree-rapid-valley...", "codex")).toBe("Respond to greeting");
  expect(stripPaneChrome("Respond to greeting | worktree-rapid-valley...", "codex", true)).toBe("Respond to greeting | worktree-rapid-valley...");
  expect(stripPaneChrome("Fix the build | api", "claude")).toBe("Fix the build | api");
  // a shell's title is not an agent's: its user@host goes, a pipe in it stays
  expect(stripPaneChrome("me@host:~/work | notes", null)).toBe("~/work | notes");
});

it("drops an omp title's glyph and spinner for a row, and keeps them for the browser tab (#2568)", () => {
  expect(stripPaneChrome("π ⠋ Fix the build", "omp")).toBe("Fix the build");
  expect(tabTitle("π ⠋ Fix the build", "omp")).toBe("π ⠋ Fix the build");
  // a path after the mark is still shortened to its folder, as a row's is
  expect(tabTitle("π ⠋ /home/me/dev/api", "omp")).toBe("π ⠋ api");
  // a shell's title has no mark to keep; a title that is only the mark leaves nothing
  expect(tabTitle("me@host:~/work/api", null)).toBe("api");
  expect(tabTitle("π ⠋ ", "omp")).toBe("");
});
