import { useContext, useEffect, useState, type ReactNode } from "react";

import { splitFilePaths } from "../lib/filePaths.ts";
import { FileNameLookupContext } from "../lib/fileNameLookup.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Text past this many characters stays plain: a whole tool output can be megabytes, and every
 * path in it would be an element.
 */
export const FILE_LINK_LIMIT = 256 * 1024;
/** Nor does a text with more paths than this link any: a listing of thousands would be thousands of buttons. */
export const FILE_LINK_COUNT = 500;

/** Whether `text` links its paths at all: short enough, and not a listing of thousands. */
export function linksFilePaths(text: string): boolean {
  return text.length <= FILE_LINK_LIMIT && splitFilePaths(text).filter((part) => typeof part !== "string").length <= FILE_LINK_COUNT;
}

/** A file path the viewer opens: a button that reads as the text or code it replaced. */
export function FilePathLink({ path, code, open }: { path: string; code: boolean; open: (path: string) => void }) {
  const t = useT();
  const label = code ? <code>{path}</code> : path;
  return <button type="button" className={`markdown-file${code ? " is-code" : ""}`} title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button>;
}

/**
 * A bare name in a code span (`README.md`): a link while the pane's PC may have it, plain code
 * once it has nothing of that name (lib/fileNameLookup.ts). An answer asked again keeps the last
 * one shown until it comes.
 */
export function CodeFileName({ name, open }: { name: string; open: (path: string) => void }) {
  const lookup = useContext(FileNameLookupContext);
  const [missing, setMissing] = useState(() => lookup?.known(name) === false);
  useEffect(() => {
    if (lookup === null) return;
    let live = true;
    void lookup.ask(name).then((found) => { if (live) setMissing(!found); });
    return () => { live = false; };
  }, [lookup, name]);
  return missing && lookup !== null ? <code>{name}</code> : <FilePathLink path={name} code open={open} />;
}

/**
 * `text` with the file paths in it as links to the viewer (a tool's output, a log in a code
 * block): `/tmp/shot/t0.png (1600, 1000)` opens the picture. Plain where nothing can open one.
 * With `end`, only the text before it (a folded output's head), a path that end cuts left as text.
 */
export function linkFilePaths(text: string, open: ((path: string) => void) | null, end = text.length): ReactNode {
  if (open === null || text.length > FILE_LINK_LIMIT) return text.slice(0, end);
  const parts = splitFilePaths(text, end);
  if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
  if (parts.filter((part) => typeof part !== "string").length > FILE_LINK_COUNT) return text.slice(0, end);
  return parts.map((part, index) => typeof part === "string" ? part : <FilePathLink key={index} path={part.path} code={false} open={open} />);
}
