// Adapted from t3code's formatWorkspaceRelativePath.

export function resolveWorkspaceRoot(start: string, home: string): string | null {
  let root: string;
  if (start === "~") root = home;
  else if (start.startsWith("~/")) root = `${home.replace(/\/+$/, "")}/${start.slice(2)}`;
  else if (start.startsWith("/")) root = start;
  else return null;
  root = root.replace(/\/+$/, "");
  return root === "" ? null : root;
}

/**
 * A Windows drive or UNC folder is not guessed at, a UNC one written with forward slashes
 * (`//server/share`) included.
 */
export function toolPathRoot(cwd: string | null | undefined): string | null {
  if (cwd == null || !cwd.startsWith("/") || cwd.startsWith("//")) return null;
  const root = cwd.replace(/\/+$/, "");
  return root === "" ? null : root;
}

/**
 * A path with a `.` or `..` segment stays as written: agent output can name
 * `/work/app/../etc/passwd`, which is not inside `/work/app` however it starts.
 */
export function toolPathLabel(path: string, root: string | null): string {
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return path;
  return workspaceRelativePath(path, root, path);
}

export function workspaceRelativePath(path: string, root: string | null, fallback: string): string {
  if (root === null) return fallback;
  const label = root.slice(root.lastIndexOf("/") + 1);
  if (path === root) return label;
  return path.startsWith(`${root}/`) ? `${label}/${path.slice(root.length + 1)}` : fallback;
}
