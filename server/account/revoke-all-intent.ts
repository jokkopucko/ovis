import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StoredDevice } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

/** Once the intent is durable, detached ordinary rows still belong to it until the registry is saved. */
export class RevokeAllIntent {
  private readonly path: string;
  private targets: readonly StoredDevice[] | null;
  private problem: string | null = null;
  /** How many account-joined rows the Revoke all covered when it began; an intent that will not read covers some. */
  private listedRows = 0;
  private before: number | null = null;
  private listedOnly = false;

  get strict(): string | null { return this.problem; }

  constructor(dir: string, rows: readonly StoredDevice[]) {
    this.path = join(dir, "revoke-all.json");
    this.targets = existsSync(this.path) ? rows : null;
    if (this.targets !== null) {
      const saved = coverage(this.path);
      this.listedRows = saved.listed;
      this.before = saved.before;
      this.listedOnly = saved.listedOnly;
      if (this.listedOnly) this.targets = [];
    }
  }

  get listed(): number { return this.listedRows; }

  get remainingListedOnly(): boolean { return this.listedOnly; }
  covers(admitNo: number): boolean { return this.before === null || admitNo < this.before; }

  begin(rows: readonly StoredDevice[], at: string, listed: number, before: number | null): void {
    writePrivateState(this.path, { id: randomBytes(16).toString("hex"), by: "pc", at, rows, listed, before });
    this.targets = rows;
    this.listedRows = listed;
    this.before = before;
    this.listedOnly = false;
  }

  /** Ordinary denials and the binding clear are durable. Only the unavailable listed registry remains. */
  awaitListed(): void {
    writePrivateState(this.path, { ...JSON.parse(readFileSync(this.path, "utf8")), rows: [], listedOnly: true });
    this.targets = [];
    this.listedOnly = true;
    this.problem = "Revoke all is waiting for account-devices.json: only this PC itself gets in until it is restored.";
  }

  finish(write: (rows: readonly StoredDevice[]) => void): boolean {
    if (this.targets === null) return false;
    try {
      write(this.targets);
      rmSync(this.path);
      this.targets = null;
      this.problem = null;
      this.listedRows = 0;
      this.listedOnly = false;
      return true;
    } catch (error) {
      this.problem = `Revoke all could not be finished (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is.`;
      throw error;
    }
  }
}

/** An intent written before `listed` existed names none; one that will not read names some, so it stays. */
function coverage(path: string) {
  const unknown = { listed: 1, before: null, listedOnly: false };
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object" || !("by" in doc) || doc.by !== "pc" ||
      !("id" in doc) || typeof doc.id !== "string" || !("at" in doc) || typeof doc.at !== "string" ||
      !Number.isFinite(Date.parse(doc.at))) return unknown;
    if (!("listed" in doc) && ("before" in doc || "listedOnly" in doc)) return unknown;
    const listed = "listed" in doc ? doc.listed : 0;
    const before = "before" in doc ? doc.before : null;
    const listedOnly = "listedOnly" in doc ? doc.listedOnly : false;
    if (typeof listed !== "number" || !Number.isSafeInteger(listed) || listed < 0 ||
      (before !== null && (typeof before !== "number" || !Number.isSafeInteger(before) || before <= 0)) ||
      typeof listedOnly !== "boolean" || (listedOnly && listed === 0)) return unknown;
    return { listed, before, listedOnly };
  } catch { return unknown; }
}
