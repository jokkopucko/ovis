// Copyright (c) The xterm.js authors. MIT License.
// Adapted for Ovis.

export interface InputPlatform {
  readonly isMac: boolean;
  readonly isWindows: boolean;
  readonly isLinux: boolean;
  readonly isChromeOS: boolean;
  readonly isFirefox: boolean;
  readonly isAppleWebKit: boolean;
}

export function detectInputPlatform(navigator: { readonly userAgent: string; readonly platform: string } | undefined): InputPlatform {
  const { userAgent = "", platform = "" } = navigator ?? {};
  const isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(platform);
  const isIOS = platform === "iPad" || platform === "iPhone";
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  return {
    isMac, isWindows: ["Windows", "Win16", "Win32", "WinCE"].includes(platform),
    isLinux: platform.includes("Linux"), isChromeOS: /\bCrOS\b/.test(userAgent),
    isFirefox: userAgent.includes("Firefox"),
    isAppleWebKit: (isMac || isIOS) && (isSafari || (/AppleWebKit\//.test(userAgent) && !/chrome|android/i.test(userAgent))),
  };
}
