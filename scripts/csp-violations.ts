/**
 * Sees the Content-Security-Policy violations a browser reports.
 *
 * The app's policy rides on every static response (`CSP_DIRECTIVES` in server/static.ts), and
 * a violation is invisible to everything else here: the browser logs it to the console and
 * fires a `securitypolicyviolation` event on the document, never an uncaught exception and
 * never a failed request. A blocked font is neither a page error nor a failed script, so a
 * directive that breaks a real surface — a new CDN font, a new `blob:` image, an inline
 * script, a third-party frame — would ship green. This reads both halves.
 *
 * `watchCsp` collects them on one page and `assertCspClean` fails the run on any of them, and
 * also fails when no policy header ever reached that page: a page served without the header
 * has nothing to violate and would pass by proving nothing.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";

export interface CspViolation {
  violatedDirective: string;
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  /** which half reported it: the document's own event, or Chromium's console line */
  seen: "event" | "console";
}

export interface CspWatch {
  violations(): CspViolation[];
  /** whether a response carried a policy header; false means the page proves nothing */
  servedPolicy(): boolean;
}

/** Both modes ship the same string, and report-only is what a measurement run sends. */
const POLICY_HEADERS = ["content-security-policy", "content-security-policy-report-only"];
/** Chromium's own wording, in the enforcing console line and in the report-only one alike */
const CSP_TEXT = /content security policy/i;
/** Chromium gives an inline script, style or attribute an empty URI; say so rather than print "" */
const NO_URI = "(no URI: an inline script, style or attribute)";

/**
 * Runs before any page script, so a violation in the document's own <head> is caught too.
 * Nothing outside this function is reachable from here: an init script is serialized. The
 * array stays in the page, where devtools can read it; the binding mirrors each entry out,
 * because the page is usually closed before the run reaches its assertion.
 */
const listen = () => {
  const violations: CspViolation[] = [];
  const scope = window as unknown as { __herdrCspRecord?: (violation: CspViolation) => void };
  Object.assign(window, { __herdrCspViolations: violations });
  document.addEventListener("securitypolicyviolation", (event) => {
    const violation = event as unknown as SecurityPolicyViolationEvent;
    const record: CspViolation = {
      violatedDirective: violation.violatedDirective,
      effectiveDirective: violation.effectiveDirective,
      blockedURI: violation.blockedURI,
      sourceFile: violation.sourceFile,
      lineNumber: violation.lineNumber,
      seen: "event",
    };
    violations.push(record);
    scope.__herdrCspRecord?.(record);
  });
};

/**
 * Chromium's console line for an inline script names no URI, and reports `script-src-elem`
 * where the policy says `script-src`, so it is the family of the directive that has to match.
 */
function sameBlock(line: string, event: CspViolation): boolean {
  const family = (event.effectiveDirective || event.violatedDirective).split(" ")[0].replace(/-(elem|attr)$/, "");
  if (family && !line.includes(family)) return false;
  return !event.blockedURI || line.includes(event.blockedURI);
}

export async function watchCsp(page: Page): Promise<CspWatch> {
  const events: CspViolation[] = [];
  await page.exposeFunction("__herdrCspRecord", (violation: CspViolation) => { events.push(violation); });
  await page.addInitScript(listen);
  // Chromium's console lines describe the same blocks the events do, so a line an event
  // already covers is dropped when the two are read together
  const lines: string[] = [];
  const seen = new Set<string>();
  let policy = false;
  page.on("response", (response) => {
    const headers = response.headers();
    if (POLICY_HEADERS.some((name) => headers[name])) policy = true;
  });
  page.on("console", (message) => {
    const text = message.text();
    if (!CSP_TEXT.test(text) || seen.has(text)) return;
    seen.add(text);
    lines.push(text);
  });
  return {
    violations: () => [...events, ...lines
      .filter((line) => !events.some((event) => sameBlock(line, event)))
      .map((line) => ({ violatedDirective: "", effectiveDirective: "", blockedURI: line, sourceFile: "", lineNumber: 0, seen: "console" as const }))],
    servedPolicy: () => policy,
  };
}

function describe(violation: CspViolation): string {
  if (violation.seen === "console") return `console: ${violation.blockedURI}`;
  const directive = violation.effectiveDirective || violation.violatedDirective;
  const at = violation.sourceFile ? ` at ${violation.sourceFile}:${violation.lineNumber}` : "";
  return `${directive} blocked ${violation.blockedURI || NO_URI}${at}`;
}

export function assertCspClean(watches: CspWatch[], label: string): void {
  const silent = watches.filter((watch) => !watch.servedPolicy());
  assert.deepEqual(silent.length, 0,
    `${label}: no Content-Security-Policy header reached ${silent.length} of ${watches.length} watched pages, so they prove nothing`);
  assert.deepEqual(watches.flatMap((watch) => watch.violations()).map(describe), [], label);
}
