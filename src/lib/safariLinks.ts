/**
 * The iPhone and iPad Home Screen web app opens a link to another site in a view of its own, where
 * the user is signed in nowhere. Safari's own scheme, `x-safari-https:`, hands the address to Safari
 * instead on iOS and iPadOS 17 and later; Apple does not document it.
 * https://christiantietze.de/posts/2023/05/safari-for-mac-url-scheme/
 */
import { inNativeApp, onIos } from "./nativeApp.ts";

export interface LinkEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean | undefined;
  origin: string;
}

function linkEnvironment(): LinkEnvironment {
  if (typeof navigator === "undefined" || typeof location === "undefined") return { userAgent: "", maxTouchPoints: 0, standalone: undefined, origin: "" };

  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: "standalone" in navigator ? navigator.standalone === true : undefined,
    origin: location.origin,
  };
}

function inSupportedIosHomeScreenApp(env: LinkEnvironment): boolean {
  if (!onIos(env) || env.standalone !== true || inNativeApp()) return false;

  const { userAgent } = env;
  const osMajor = /\bCPU (?:iPhone )?OS (\d+)(?:_\d+)*\b/.exec(userAgent)?.[1];
  // iPad's desktop-style UA reports a Mac OS version; Safari's Version token is the useful one.
  const major = osMajor ?? (/Macintosh/.test(userAgent) ? /\bVersion\/(\d+)\.\d+\b/.exec(userAgent)?.[1] : undefined);
  return major !== undefined && Number(major) >= 17;
}

/** The address a link opens: Safari's scheme for another site's https address in a supported iOS Home Screen app, else the address itself. */
export function safariAddress(uri: string, env: LinkEnvironment = linkEnvironment()): string {
  if (!inSupportedIosHomeScreenApp(env) || !/^https:\/\//i.test(uri)) return uri;

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri;
  }

  return url.origin === env.origin ? uri : `x-safari-${url.href}`;
}
