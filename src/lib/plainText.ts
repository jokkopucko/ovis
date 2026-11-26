/**
 * A markdown answer's words as its TXT copy hands them over: code fences keep their code, links
 * keep their words, and emphasis marks, headings and quote marks drop out. The MD copy keeps the
 * answer as written; this is its plain form only.
 */
export function plainText(markdown: string): string {
  // If there is no newline or closing fence, later backticks cannot start a match either.
  const withoutFences = markdown.replace(/```(?:[^\n]*\n([\s\S]*?)```|[\s\S]*)/g, (match, body: string | undefined) => body ?? match);
  return stripLinkDestinations(withoutFences)
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

function stripLinkDestinations(markdown: string): string {
  const destinationPrefix = /\]\((?:https?:\/\/|mailto:)/iy;
  const parts: string[] = [];
  let keptFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const open = markdown.indexOf("[", searchFrom);
    if (open === -1) break;
    const close = markdown.indexOf("]", open + 1);
    if (close === -1) break;
    // Every opener before this closing bracket shares the same destination.
    // A failed match cannot be rescued by retrying from a later opener.
    searchFrom = close + 1;
    destinationPrefix.lastIndex = close;
    if (close === open + 1 || !destinationPrefix.test(markdown)) continue;
    const end = markdown.indexOf(")", destinationPrefix.lastIndex);
    if (end === -1) break;
    if (end === destinationPrefix.lastIndex) continue;
    parts.push(markdown.slice(keptFrom, open), markdown.slice(open + 1, close));
    keptFrom = searchFrom = end + 1;
  }
  return parts.length === 0 ? markdown : parts.join("") + markdown.slice(keptFrom);
}
