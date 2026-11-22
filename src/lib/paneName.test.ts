import { expect, it } from "bun:test";
import { codexThreadTitle, folderName, isHomeTitle, shortPathTitle, tabTitle, taskTitle, stripPaneChrome, unsaidLine } from "./paneName.ts";

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
});

it("titles a pane by its own title, and by its workspace when an unlabelled title only names its folder", () => {
  expect(taskTitle({ paneTitle: "Idempotent payments", labelled: false, folder: "api", workspace: "checkout-api" })).toBe("Idempotent payments");
  expect(taskTitle({ paneTitle: "api", labelled: false, folder: "api", workspace: "checkout-api" })).toBe("checkout-api");
  expect(taskTitle({ paneTitle: "api", labelled: true, folder: "api", workspace: "checkout-api" })).toBe("api");
  // a shell at home titles itself "~", which names no project; a pane the user named "~" keeps it
  expect(taskTitle({ paneTitle: "~", labelled: false, folder: "haemin", workspace: "checkout-api" })).toBe("checkout-api");
  expect(taskTitle({ paneTitle: "~/", labelled: false, folder: "haemin", workspace: "checkout-api" })).toBe("checkout-api");
  expect(taskTitle({ paneTitle: "~", labelled: true, folder: "haemin", workspace: "checkout-api" })).toBe("~");
});

it("tells a home folder title from a path or a name that starts with a tilde", () => {
  expect(isHomeTitle("~")).toBe(true);
  expect(isHomeTitle(" ~ ")).toBe(true);
  expect(isHomeTitle("~/")).toBe(true);
  expect(isHomeTitle("~\\")).toBe(true);
  expect(isHomeTitle("~/dev/api")).toBe(false);
  expect(isHomeTitle("~tilde-name")).toBe(false);
  expect(isHomeTitle("vim ~")).toBe(false);
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
  expect(stripPaneChrome("me@host:~/work | notes", null)).toBe("~/work | notes");
});

it("drops an omp title's glyph and spinner for a row, and keeps them for the browser tab (#2568)", () => {
  expect(stripPaneChrome("π ⠋ Fix the build", "omp")).toBe("Fix the build");
  expect(tabTitle("π ⠋ Fix the build", "omp")).toBe("π ⠋ Fix the build");
  expect(tabTitle("π ⠋ /home/me/dev/api", "omp")).toBe("π ⠋ api");
  expect(tabTitle("me@host:~/work/api", null)).toBe("api");
  expect(tabTitle("π ⠋ ", "omp")).toBe("");
});

it("says each part of a row's second line once, and never the name its first line leads with", () => {
  expect(unsaidLine("Hotfix", ["Hotfix", "fix/payment", "fix-payment"])).toBe("fix/payment · fix-payment");
  expect(unsaidLine("api", ["Tab 2", "api"])).toBe("Tab 2");
  expect(unsaidLine("vim", ["api", null, "api", ""])).toBe("api");
});
