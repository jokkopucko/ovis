/**
 * Signing in to the account from the desktop app (docs/account.md, "Signing in"): the provider's
 * page opens in the system browser, and the account service sends it back to a server on this
 * machine's loopback address, `http://127.0.0.1:<port>/callback`, with the code and state in the
 * query (RFC 8252). The page itself finishes the sign-in, as in a browser; this only carries the
 * return. One sign-in at a time; a new one ends the one before. Only a return naming the state of
 * the sign-in the app opened, with a code or an error, ends the wait: anything else that finds the
 * port is turned away and the wait goes on.
 */
import { createServer } from "node:http";

/**
 * The account service this app signs in with: account.ovis.sh, or the https origin
 * OVIS_ACCOUNT_SERVICE_URL names; none when it is `off` or not https, and the app offers no sign-in.
 */
export function accountServiceOf(env: Record<string, string | undefined>): string | null {
  try {
    const url = new URL(env["OVIS_ACCOUNT_SERVICE_URL"] ?? "https://account.ovis.sh");
    return url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

export const SIGN_IN_MS = 10 * 60_000;

const CLOSED_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Ovis</title><p style=\"font:16px system-ui;margin:3em;text-align:center\">You're signed in. You can close this tab and go back to Ovis.</p>";

export interface LoopbackSignIn {
  readonly redirectUri: string;
  readonly returned: Promise<string>;
  /** the state of the sign-in the app opened: only a return naming it is taken */
  expect(state: string): void;
  close(): void;
}

let current: LoopbackSignIn | null = null;

export async function startLoopbackSignIn(timeoutMs = SIGN_IN_MS): Promise<LoopbackSignIn> {
  current?.close();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // the caller awaits `returned` only after opening the browser: a rejection meanwhile is not unhandled
  promise.catch(() => undefined);
  let expected: string | null = null;
  const ended = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const state = url.searchParams.get("state");
    const answered = url.searchParams.has("code") || url.searchParams.has("error");
    if (request.method !== "GET" || url.pathname !== "/callback" || expected === null || state !== expected || !answered) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(CLOSED_PAGE);
    resolve(url.search.slice(1));
    signIn.close();
  });
  const timer = setTimeout(() => { reject(new Error("The sign-in took too long")); signIn.close(); }, timeoutMs);
  const signIn: LoopbackSignIn & { redirectUri: string } = {
    redirectUri: "",
    returned: promise,
    expect: (state) => { expected = state; },
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      reject(new Error("The sign-in was replaced or cancelled"));
      ended.resolve();
      if (current === signIn) current = null;
    },
  };
  current = signIn;
  try {
    await Promise.race([ended.promise, new Promise<void>((listening, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", () => listening()); })]);
  } catch (error) { signIn.close(); throw error; }
  if (current !== signIn) { server.close(); throw new Error("The sign-in was replaced or cancelled"); }
  const address = server.address();
  if (address === null || typeof address === "string") { signIn.close(); throw new Error("The sign-in server has no port"); }
  signIn.redirectUri = `http://127.0.0.1:${address.port}/callback`;
  return signIn;
}
