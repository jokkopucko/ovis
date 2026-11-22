import { AGENT_CHROME, codexThreadTitle, folderName, SHELL_PREFIX, shortPathTitle, stripPaneChrome } from "../../shared/pane-title.ts";

export { codexThreadTitle, folderName, shortPathTitle, stripPaneChrome };

export function tabTitle(title: string, agent: string | null | undefined): string {
  const rest = shortPathTitle(stripPaneChrome(title, agent));
  const mark = agent ? title.replace(SHELL_PREFIX, "").match(AGENT_CHROME)?.[0] ?? "" : "";
  return rest ? `${mark}${rest}` : "";
}

/**
 * A shell at its home folder titles its terminal "~" (bash's `user@host: ~`): the home folder written
 * out, which names no project. It says as little as a title that is the pane's folder does.
 */
export function isHomeTitle(title: string): boolean {
  return /^~[\\/]?$/.test(title.trim());
}

/** what a pane is on: its own title, or its workspace when a title nobody gave it only names the pane's folder or home */
export function taskTitle({ paneTitle, labelled, folder, workspace }: {
  paneTitle: string;
  labelled: boolean;
  folder: string;
  /** the workspace's name: its label, which herdr makes from the branch until its owner names it */
  workspace: string;
}): string {
  return !labelled && (paneTitle === folder || isHomeTitle(paneTitle)) ? workspace : paneTitle;
}

export function unsaidLine(title: string, parts: readonly (string | null | undefined)[]): string {
  const said = new Set([title]);
  const line: string[] = [];
  for (const part of parts) {
    if (!part || said.has(part)) continue;
    said.add(part);
    line.push(part);
  }
  return line.join(" · ");
}
