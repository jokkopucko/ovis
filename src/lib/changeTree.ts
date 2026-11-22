export interface ChangeTreeFolder {
  kind: "folder";
  path: string;
  name: string;
  depth: number;
  entries: ChangeTreeEntry[];
  files: number;
}

export interface ChangeTreeFile {
  kind: "file";
  path: string;
  name: string;
  depth: number;
  index: number;
}

export type ChangeTreeEntry = ChangeTreeFolder | ChangeTreeFile;

interface Node {
  path: string;
  name: string;
  entries: Array<Node | number>;
  folders: Map<string, Node>;
}

export function changeTree(paths: readonly string[]): ChangeTreeEntry[] {
  const root: Node = { path: "", name: "", entries: [], folders: new Map() };
  paths.forEach((path, index) => {
    const segments = path.split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let next = folder.folders.get(segment);
      if (next === undefined) {
        next = { path: folder.path === "" ? segment : `${folder.path}/${segment}`, name: segment, entries: [], folders: new Map() };
        folder.folders.set(segment, next);
        folder.entries.push(next);
      }
      folder = next;
    }
    folder.entries.push(index);
  });
  return finish(root.entries, 0, paths);
}

function finish(entries: readonly (Node | number)[], depth: number, paths: readonly string[]): ChangeTreeEntry[] {
  return entries.map((entry): ChangeTreeEntry => {
    if (typeof entry === "number") {
      const path = paths[entry]!;
      return { kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), depth, index: entry };
    }
    let folder = entry;
    let name = folder.name;
    while (folder.entries.length === 1 && typeof folder.entries[0] !== "number") {
      folder = folder.entries[0]!;
      name = `${name}/${folder.name}`;
    }
    const children = finish(folder.entries, depth + 1, paths);
    return { kind: "folder", path: folder.path, name, depth, entries: children, files: countFiles(children) };
  });
}

function countFiles(entries: readonly ChangeTreeEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.kind === "file" ? 1 : entry.files), 0);
}

export function changeTreeFolders(entries: readonly ChangeTreeEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === "folder" ? [entry.path, ...changeTreeFolders(entry.entries)] : []));
}
