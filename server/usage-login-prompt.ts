import { stripVTControlCharacters } from "node:util";

import type { UsageLoginPromptText } from "../shared/usage-login.ts";

/**
 * A private login's PTY output as the text it shows: OSC sequences go whole (a hyperlink's hidden target
 * would otherwise stay beside its visible text), then every other escape, and lines end in \n.
 */
export function screenText(raw: string): string {
  return stripVTControlCharacters(raw.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")).replace(/\r\n?/g, "\n");
}

/** The providers whose sign-in the browser can follow: the CLI prints a page to open, and a code or a code box. */
export type PromptProvider = "claude" | "codex";

/**
 * The hosts each CLI sends its sign-in to, as recorded (Claude Code 2.1.312, codex-cli 0.163.0). An
 * address on any other host is not offered as a link: the pane is the CLI's, but a link is the app's word.
 */
const SIGN_IN_HOSTS: Readonly<Record<PromptProvider, readonly string[]>> = {
  claude: ["claude.com", "claude.ai", "anthropic.com"],
  codex: ["auth.openai.com", "chatgpt.com"],
};

function trusted(provider: PromptProvider, address: string): boolean {
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  return SIGN_IN_HOSTS[provider].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/**
 * What a login asks of its user, from its screen's text (screenText of its private PTY, where a long address
 * stays one line): the page to open, the one-time code to enter there (Codex's device code), and whether the
 * CLI waits for a code pasted back (Claude Code). The latest of each counts, as the screen shows it.
 */
export function loginPrompt(provider: PromptProvider, text: string): UsageLoginPromptText {
  const addresses = [...text.matchAll(/https?:\/\/[^\s<>"'`\u0007\u001b]+/g)].map((match) => match[0].replace(/[.,;:)\]]+$/, ""));
  const last = addresses.at(-1);
  const url = last !== undefined && trusted(provider, last) ? last : null;
  let userCode: string | null = null;
  if (provider === "codex") {
    const after = text.slice(text.lastIndexOf("one-time code"));
    userCode = text.includes("one-time code") ? after.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1] ?? null : null;
  }
  // only while the prompt is the last thing on the screen: an answered one has more after it
  const wantsCode = provider === "claude" && url !== null && /Paste code here if prompted >\s*$/.test(text);
  return { url, user_code: userCode, wants_code: wantsCode };
}
