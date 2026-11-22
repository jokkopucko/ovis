/**
 * `ovis recover` (docs/account.md, "Recovery at the PC"): run by this PC's user in a terminal on it or over SSH, it
 * talks to the server over its recovery socket only (server/account/recovery.ts). Confirmation takes place at a
 * terminal; input that is not a terminal answers nothing.
 */
import type { RecoveryAction, RecoveryStanding } from "../shared/account-devices-api.ts";

export interface RecoverIo {
  out(text: string): void;
  terminal: boolean;
  platform: NodeJS.Platform;
  ask(question: string): Promise<string>;
  send(request: RecoveryAction): Promise<unknown>;
}

interface WaitingRow {
  id: string;
  label: string;
  origin: { from: string; how: string } | null;
  waiting: string | null;
  last_seen_at: string | null;
  refusal: string | null;
}

const USAGE = "usage: ovis recover [--release <row id>... | --undo [<row id>...] | --admit <waiting id> | --remove <row id or key>... | --lift <block or freeze id>... | --revoke-all]\n";

function terminalText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export async function runRecover(args: readonly string[], io: RecoverIo): Promise<number> {
  if (io.platform === "win32") {
    io.out("Recovery on Windows is the Ovis desktop app's own screen on this PC: open it there. This command opens nothing here.\n");
    return 1;
  }
  const [flag, ...ids] = args;
  const targetAction = flag === "--remove" || flag === "--lift";
  const admitWithoutId = flag === "--admit" && ids.length === 0;
  if (flag !== undefined && flag !== "--release" && flag !== "--undo" && flag !== "--admit" && flag !== "--revoke-all" && !targetAction) { io.out(USAGE); return 2; }
  if (flag === "--admit" && ids.length > 1) { io.out(USAGE); return 2; }
  if (admitWithoutId) io.out(USAGE);
  if (((flag === "--release" || targetAction) && ids.length === 0) || (flag === "--revoke-all" && ids.length !== 0)) { io.out(USAGE); return 2; }
  if ((flag === "--release" || (flag === "--admit" && !admitWithoutId) || flag === "--revoke-all" || targetAction) && !io.terminal) {
    io.out("This is not run in a terminal, so nothing can be released here. Run it in a terminal on this PC (over ssh, run ssh -t).\n");
    return 1;
  }
  try {
    if (targetAction || flag === "--revoke-all") {
      const confirmed: string[] = [];
      if (flag === "--revoke-all") {
        const answer = (await io.ask("Every device of this PC will be signed out. Revoke all devices? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") return 0;
      } else {
        for (const id of ids) {
          const action = flag === "--remove" ? `Remove ${id} from this PC?` : `Lift ${id.startsWith("f:") ? "freeze" : "block"} ${id} on this PC?`;
          const answer = (await io.ask(`${terminalText(action)} [y/N] `)).trim().toLowerCase();
          if (answer === "y" || answer === "yes") confirmed.push(id);
        }
        if (confirmed.length === 0) return 0;
      }
      const reply = await io.send(flag === "--remove" ? { act: "remove", targets: confirmed }
        : flag === "--lift" ? { act: "lift", blocks: confirmed } : { act: "revoke_all" });
      if (typeof reply === "object" && reply !== null) {
        const lifted = "lifted" in reply && Array.isArray(reply.lifted) ? reply.lifted : undefined;
        const error = "error" in reply && typeof reply.error === "string" ? reply.error : undefined;
        if (lifted !== undefined && (lifted.length > 0 || error === undefined)) io.out(`Lifted: ${terminalText(lifted.join(", "))}\n`);
        if (error !== undefined) { io.out(`${terminalText(error)}\n`); return 1; }
        if ("removed" in reply && Array.isArray(reply.removed)) { io.out(`Removed: ${terminalText(reply.removed.join(", "))}\n`); return 0; }
        if (lifted !== undefined) return 0;
        if ("revoked" in reply && typeof reply.revoked === "number") { io.out(`Revoked ${reply.revoked} device(s).\n`); return 0; }
      }
      io.out("Ovis did not return a recovery result.\n");
      return 1;
    }
    if (flag === "--undo") {
      const answer = await io.send({ act: "undo", rows: ids.length > 0 ? ids : null }) as { releases?: string[]; error?: string; warning?: string };
      if (answer.error !== undefined) { io.out(`${terminalText(answer.error)}\n`); return 1; }
      io.out(`Ended ${answer.releases?.length ?? 0} release(s), each whole with every row it let in; their sessions were closed and the rows wait again.\n`);
      // the undo took effect; that it is missing from the device journal is the owner's to know
      if (answer.warning !== undefined) { io.out(`${terminalText(answer.warning)}\n`); return 1; }
      return 0;
    }
    const listed = await io.send({ act: "list" }) as { rows?: WaitingRow[]; pending?: { id: string; label: string; fingerprint: string }[]; standing?: readonly RecoveryStanding[]; error?: string };
    if (listed.error !== undefined) { io.out(`${terminalText(listed.error)}\n`); return 1; }
    const rows = listed.rows ?? [];
    if (flag === "--admit" && !admitWithoutId) {
      const waiting = (listed.pending ?? []).find((entry) => entry.id === ids[0]);
      if (waiting === undefined) { io.out(`${terminalText(ids[0] ?? "")}: no such device waits here.\n`); return 1; }
      const label = terminalText(waiting.label);
      const answer = (await io.ask(`${label} (the name it gives itself) is waiting. Compare this key fingerprint with the characters the device shows:\n${terminalText(waiting.fingerprint)}\nAdmit this key? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") { io.out("Not admitted.\n"); return 0; }
      const admitted = await io.send({ act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint }) as { admitted?: string; error?: string };
      if (admitted.error !== undefined) {
        io.out(`${terminalText(admitted.error)}\n`);
        if (admitted.error.startsWith("This PC refused to admit the key")) {
          io.out("If this key was revoked here, pair it again at this PC's screen.\n");
        }
        return 1;
      }
      io.out(`Admitted ${label}.\n`);
      return 0;
    }
    if (flag === undefined || admitWithoutId) {
      if (flag === undefined) {
        if (rows.length === 0) io.out("No device waits for this PC's account to be read.\n");
        else {
          for (const row of rows) io.out(`${terminalText(`${row.id}  ${describe(row)}`)}\n`);
          io.out("Release one with: ovis recover --release <row id>\n");
        }
        // The start of an encoded account key is shared by keys of the same type.
        for (const { kind, id, target, signer } of listed.standing ?? []) {
          io.out(`${terminalText(`${kind} ${id}  key ${target.slice(-12)}  signed by ${signer}  (ovis recover --lift ${id})`)}\n`);
        }
      }
      for (const entry of listed.pending ?? []) io.out(`${terminalText(`waiting: ${entry.id}  ${entry.label}`)}\n  key ${terminalText(entry.fingerprint)}  (ovis recover --admit ${terminalText(entry.id)})\n`);
      return admitWithoutId ? 2 : 0;
    }
    let failed = false;
    for (const id of ids) {
      const row = rows.find((candidate) => candidate.id === id);
      const displayId = terminalText(id);
      if (row === undefined) { io.out(`${displayId}: no such row waits here.\n`); failed = true; continue; }
      if (row.refusal !== null) { io.out(`${displayId}: cannot be released (${terminalText(row.refusal)}).\n`); failed = true; continue; }
      const answer = (await io.ask(`${terminalText(describe(row))}\nRow ID: ${displayId}\nRelease this row until this PC's account is read? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") { io.out("Not released.\n"); continue; }
      const released = await io.send({ act: "release", rows: [id] }) as { released?: string[]; error?: string };
      if (released.error !== undefined) { io.out(`${displayId}: ${terminalText(released.error)}\n`); failed = true; continue; }
      io.out(`Released ${terminalText(row.label)}. It signs in until this PC's account is read, or until ovis recover --undo.\n`);
    }
    return failed ? 1 : 0;
  } catch {
    io.out("Ovis did not answer on its recovery socket. Is it running on this PC, as this user, with recovery turned on?\n");
    return 1;
  }
}

function describe(row: WaitingRow): string {
  const origin = row.origin === null ? "unknown origin" : `${row.origin.from}/${row.origin.how}`;
  const seen = row.last_seen_at ?? "never";
  return `${row.label}  ${origin}  waits: ${row.waiting ?? "no"}  last seen: ${seen}  ${row.refusal === null ? "can be released" : `cannot be released: ${row.refusal}`}`;
}
