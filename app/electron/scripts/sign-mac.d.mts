import type { Run } from "./notarize-dmg.mjs";

export declare const HOST: string;
export declare function signHost(host: string, signing: { identity: string; keychain?: string; entitlements?: string }, exec?: Run): Promise<void>;
export default function sign(opts: { app: string; identity: string; keychain?: string; ignore: (file: string) => boolean; optionsForFile: (file: string) => { entitlements?: string } }): Promise<unknown>;
