/**
 * A `sleep` that still runs when copied or linked under an agent's name. Ubuntu 26.04's
 * `/bin/sleep` is rust-coreutils' multicall binary, which picks its program by name: a copy named
 * `hermes` exits with `coreutils: unknown program 'hermes'`, and a link refuses with `Security
 * violation: Requested utility ... does not match executable name`. GNU's own build ships beside
 * it as `gnusleep`: https://packages.ubuntu.com/resolute/amd64/gnu-coreutils/filelist
 */
import { existsSync } from "node:fs";

export const SLEEP = existsSync("/usr/bin/gnusleep") ? "/usr/bin/gnusleep" : "/bin/sleep";
