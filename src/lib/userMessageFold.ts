/**
 * Adapted from t3code's `shouldCollapseUserMessage` (MessagesTimeline.logic.ts, MIT).
 */

export const USER_MESSAGE_FOLD_LINES = 12;
/** Characters a message folds past without line breaks: about twelve lines of the widest bubble. */
export const USER_MESSAGE_FOLD_CHARS = 900;

const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

export function visibleUserMessageText(text: string): string {
  return text.replace(MARKDOWN_LINK, "$1");
}

export function shouldFoldUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text).trim();
  if (visible.length === 0) return false;
  return visible.length > USER_MESSAGE_FOLD_CHARS || visible.split("\n").length > USER_MESSAGE_FOLD_LINES;
}
