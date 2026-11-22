import { expect, it } from "bun:test";
import { headerCrumb, showsChat } from "./headerCrumb.ts";

const base = { machine: "workstation", workspace: "checkout-api", title: "Idempotent payments", machineCount: 2 };

it("leaves the folder out when the workspace already says its name", () => {
  const crumb = headerCrumb({ ...base, cwd: "/tmp/herdr-demo/checkout-api" });
  expect(crumb.folder).toBeNull();
  expect(crumb.place).toBe("workstation › checkout-api");
  expect(crumb.path).toBe("/tmp/herdr-demo/checkout-api");
});

it("shows the folder as its last name when it tells something the rest does not", () => {
  expect(headerCrumb({ ...base, cwd: "/home/me/dev/checkout-api/.worktrees/retry-flag/" }).folder).toBe("retry-flag");
  expect(headerCrumb({ ...base, cwd: "~/dev/api" }).folder).toBe("api");
  expect(headerCrumb({ ...base, cwd: "C:\\work\\site" }).folder).toBe("site");
});

it("leaves the folder out when the title or the PC already says its name", () => {
  expect(headerCrumb({ ...base, title: "api", cwd: "/home/me/dev/api" }).folder).toBeNull();
  expect(headerCrumb({ ...base, machine: "api", cwd: "/home/me/dev/api" }).folder).toBeNull();
  expect(headerCrumb({ ...base, cwd: "/home/me/dev/Checkout-API" }).folder).toBe("Checkout-API");
});

it("does not repeat the workspace when the pane title is the workspace", () => {
  const crumb = headerCrumb({ ...base, title: "checkout-api", cwd: "/home/me/checkout-api" });
  expect(crumb.fullContext).toBe("workstation · checkout-api · /home/me/checkout-api");
  expect(crumb.tooltip).toBe(crumb.fullContext);
});

it("counts the PC name as said only while the line shows it", () => {
  const devbox = { ...base, machine: "devbox", cwd: "/home/me/src/devbox" };
  const one = headerCrumb({ ...devbox, machineCount: 1 });
  expect(one.showMachine).toBe(false);
  expect(one.folder).toBe("devbox");
  const two = headerCrumb({ ...devbox, machineCount: 2 });
  expect(two.showMachine).toBe(true);
  expect(two.folder).toBeNull();
  expect(headerCrumb({ ...devbox, cwd: "/home/me/src/other", machineCount: 1 }).folder).toBe("other");
  expect(headerCrumb({ ...devbox, cwd: "/home/me/src/other", machineCount: 2 }).folder).toBe("other");
  expect(one.place).toBe("devbox › checkout-api");
});

it("has no folder and no path for a pane herdr reports no folder for", () => {
  for (const cwd of [null, undefined, "", "  "]) {
    const crumb = headerCrumb({ ...base, cwd });
    expect(crumb.folder).toBeNull();
    expect(crumb.path).toBeNull();
    expect(crumb.tooltip).toBe("workstation · checkout-api · Idempotent payments");
  }
});

it("keeps the whole path for the tooltip and the menu, whatever the line shows", () => {
  const shown = headerCrumb({ ...base, cwd: "/srv/checkout/worktrees/retry-flag" });
  expect(shown.path).toBe("/srv/checkout/worktrees/retry-flag");
  expect(shown.tooltip).toBe("workstation · checkout-api · Idempotent payments · /srv/checkout/worktrees/retry-flag");
  const hidden = headerCrumb({ ...base, cwd: "/tmp/herdr-demo/checkout-api" });
  expect(hidden.tooltip).toBe("workstation · checkout-api · Idempotent payments · /tmp/herdr-demo/checkout-api");
  expect(headerCrumb({ ...base, cwd: "/" }).folder).toBe("/");
});

it("keeps a folder name that ends in a space as it is", () => {
  const crumb = headerCrumb({ ...base, cwd: "/repo/branch " });
  expect(crumb.folder).toBe("branch ");
  expect(crumb.path).toBe("/repo/branch ");
  expect(crumb.tooltip).toBe("workstation · checkout-api · Idempotent payments · /repo/branch ");
  expect(headerCrumb({ ...base, title: "branch", cwd: "/repo/branch " }).folder).toBe("branch ");
});

it("takes the chat's surface only when the chat is what the pane column draws", () => {
  expect(showsChat({}, "chat")).toBe(true);
  expect(showsChat({ restore_error: null }, "chat")).toBe(true);
  expect(showsChat({}, "terminal")).toBe(false);
  expect(showsChat(null, "chat")).toBe(false);
  expect(showsChat({ restore_error: "no such session" }, "chat")).toBe(false);
});
