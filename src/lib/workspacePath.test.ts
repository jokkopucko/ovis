import { describe, expect, it } from "bun:test";
import { resolveWorkspaceRoot, toolPathLabel, toolPathRoot, workspaceRelativePath } from "./workspacePath.ts";

describe("workspace-relative paths", () => {
  it("resolves the root from the typed start", () => {
    expect(resolveWorkspaceRoot("~", "/home/u")).toBe("/home/u");
    expect(resolveWorkspaceRoot("~/code/app/", "/home/u")).toBe("/home/u/code/app");
    expect(resolveWorkspaceRoot("/srv/app", "/home/u")).toBe("/srv/app");
    expect(resolveWorkspaceRoot("", "/home/u")).toBeNull();
    expect(resolveWorkspaceRoot("/", "/home/u")).toBeNull();
  });
  it("reads paths from the root, else falls back", () => {
    const root = "/home/u/code/app";
    expect(workspaceRelativePath(root, root, "~/code/app")).toBe("app");
    expect(workspaceRelativePath(`${root}/src/lib`, root, "x")).toBe("app/src/lib");
    expect(workspaceRelativePath("/home/u/code/app2", root, "~/code/app2")).toBe("~/code/app2");
    expect(workspaceRelativePath("/home/u", root, "~")).toBe("~");
    expect(workspaceRelativePath("/a", null, "/a")).toBe("/a");
  });
  const label = (path: string, cwd: string | null): string => toolPathLabel(path, toolPathRoot(cwd));
  it("keeps raw tool paths outside a trusted root", () => {
    expect(label("/work/app/src/a.ts", "/work/app")).toBe("app/src/a.ts");
    expect(label("/work/app/src/a.ts", "/work/app/")).toBe("app/src/a.ts");
    expect(label("/work/app/src/a.ts", "/work/app//")).toBe("app/src/a.ts");
    expect(label("/work/app", "/work/app")).toBe("app");
    expect(toolPathRoot(null)).toBeNull();
    expect(toolPathRoot(undefined)).toBeNull();
    expect(toolPathRoot("")).toBeNull();
    expect(toolPathRoot("/")).toBeNull();
    expect(toolPathRoot("~/work/app")).toBeNull();
    expect(toolPathRoot("work/app")).toBeNull();
    expect(toolPathRoot("C:\\work\\app")).toBeNull();
    expect(toolPathRoot("C:/work/app")).toBeNull();
    expect(toolPathRoot("\\\\server\\share\\app")).toBeNull();
    // a UNC folder written with forward slashes is not a POSIX folder
    expect(toolPathRoot("//server/share/app")).toBeNull();
    expect(toolPathRoot("//server/share/app/")).toBeNull();
    expect(label("//server/share/app/a.ts", "//server/share/app")).toBe("//server/share/app/a.ts");
    expect(label("/work/app/src/a.ts", null)).toBe("/work/app/src/a.ts");
    expect(label("/work/app/src/a.ts", "/")).toBe("/work/app/src/a.ts");
    expect(label("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe("C:\\work\\app\\src\\a.ts");
    expect(label("\\\\server\\share\\app\\a.ts", "\\\\server\\share\\app")).toBe("\\\\server\\share\\app\\a.ts");
    expect(label("/etc/hosts", "/work/app")).toBe("/etc/hosts");
    expect(label("/work", "/work/app")).toBe("/work");
    expect(label("src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(label("./src/a.ts", "/work/app")).toBe("./src/a.ts");
    expect(label("C:\\work\\app\\a.ts", "/work/app")).toBe("C:\\work\\app\\a.ts");
    // a `.` or `..` segment: the path may leave the folder however it starts
    expect(label("/work/app/../etc/passwd", "/work/app")).toBe("/work/app/../etc/passwd");
    expect(label("/work/app/src/../a.ts", "/work/app")).toBe("/work/app/src/../a.ts");
    expect(label("/work/app/./src/a.ts", "/work/app")).toBe("/work/app/./src/a.ts");
    expect(label("/work/app/src/..a.ts", "/work/app")).toBe("app/src/..a.ts");
  });
  it("does not mistake a sibling prefix for a descendant", () => {
    expect(label("/work/app-2/a.ts", "/work/app")).toBe("/work/app-2/a.ts");
    expect(label("/work/app2", "/work/app")).toBe("/work/app2");
    expect(label("/work/application/a.ts", "/work/app/")).toBe("/work/application/a.ts");
    expect(label("/work/app-2/a.ts", "/work/app-2")).toBe("app-2/a.ts");
  });
});
