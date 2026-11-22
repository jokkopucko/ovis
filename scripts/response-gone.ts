import type { Response } from "playwright-core";

/**
 * What Playwright says when the browser no longer has a response's body: a navigation or an eviction let it go, or the
 * page closed under the read. Seen in a run: `Protocol error (Network.getResponseBody): No resource with given
 * identifier found`, the body of an answer read after the page had navigated on.
 */
const GONE = /Protocol error \(Network\.getResponseBody\): (No resource with given identifier found|No data found for resource with given identifier)|Target page, context or browser has been closed/;

export async function unlessGone<T>(response: Response, read: (response: Response) => Promise<T>): Promise<T | undefined> {
  try {
    return await read(response);
  } catch (error) {
    if (!GONE.test((error as Error).message)) throw error;
    console.log("response body gone:", response.request().method(), response.url(), (error as Error).message.split("\n")[0]);
    return undefined;
  }
}
